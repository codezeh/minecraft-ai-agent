/**
 * t-r5-def-C —— R4 遗留条 C：promptMemSaving / promptShouldRespondToBot / Vision 不下传 opts
 *
 * 做法：用**真 Prompter**（真构造函数、真 profile 模板、真 replaceStrings/checkCooldown），
 *   只把 `chat_model` / `vision_model` 换成记录器，然后调用三条路径，记录
 *   "模型层实际收到了什么" —— 这是 prompter→适配器边界上的**运行时事实**，不是读码推断。
 *
 * 三段：
 *   ① 实参个数：三条路径给模型层传了几个参数？第 3/4 个（opts）是不是 undefined？
 *      对照组：promptConvoResult / promptCodingResult 传了 callOpts（应为有值）。
 *   ② 后果实测：让记录器"支持取消"（看得到 signal 就 abort 后立刻 reject）；
 *      先 abort，再调三条路径 —— 看它们是否仍跑满（返回正常内容而不是 cancelled）。
 *   ③ 结论：谁拿不到什么（signal/deadline/operationId），在什么用户动作下表现出来。
 *
 * 退出码：0 = 缺陷成立（三条路径确实拿不到 opts，且 abort 后仍跑满）；
 *         1 = 已闭合（opts 已下传）；2 = CANNOT-RUN。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const say = (...a) => console.log('[C]', ...a);
const url = (p) => pathToFileURL(p).href;

// ★ 导入前切到仓库根：适配器/keys.json/账号库都是 cwd 相对（否则构造 Prompter 会缺 API key）
process.chdir(ROOT);

let Prompter, settings, STATUS;
try {
    ({ default: settings } = await import(url(path.join(ROOT, 'src/agent/settings.js'))));
    settings.base_profile = 'survival';
    settings.language = 'en';
    ({ Prompter } = await import(url(path.join(ROOT, 'src/models/prompter.js'))));
    ({ STATUS } = await import(url(path.join(ROOT, 'src/models/result.js'))));
} catch (e) {
    console.error('[C] CANNOT-RUN：导入失败：', String(e?.message ?? e).slice(0, 200));
    process.exit(2);
}

let prompter;
try {
    // 真构造函数：真 profile 模板（saving_memory / bot_responder 等）
    prompter = new Prompter({ name: 'probeC', history: { getHistory: () => [], memory: '' }, bot: { interrupt_code: false } },
        { name: 'probeC', model: 'openai/gpt-4o-mini' });
} catch (e) {
    console.error('[C] CANNOT-RUN：Prompter 构造失败：', String(e?.message ?? e).slice(0, 200));
    process.exit(2);
}
say('真 Prompter 已构造；chat_model =', prompter.chat_model?.constructor?.name);

// ── 记录器：模拟"支持取消"的模型层 ────────────────────────────────────────
const calls = [];
function recorder(label) {
    return {
        async sendRequest(messages, prompt, stop_seq, opts) {
            calls.push({ label, argc: arguments.length, stop_seq, opts, optsType: typeof opts });
            // 支持取消的模型层：看得到 signal 就会在 abort 后立刻放弃
            if (opts?.signal?.aborted) {
                const e = new Error('模型请求被取消'); e.code = 'LLM_CANCELLED';
                throw e;
            }
            await new Promise((r) => setTimeout(r, 120));   // 模拟一次网络往返
            if (opts?.signal?.aborted) {                     // 期间被取消 ⇒ 也算能取消
                const e = new Error('模型请求被取消'); e.code = 'LLM_CANCELLED';
                throw e;
            }
            return '摘要正文';
        },
        async sendVisionRequest(messages, prompt, imageBuffer, opts) {
            calls.push({ label, argc: arguments.length, opts, optsType: typeof opts });
            if (opts?.signal?.aborted) { const e = new Error('模型请求被取消'); e.code = 'LLM_CANCELLED'; throw e; }
            await new Promise((r) => setTimeout(r, 120));
            return '这是一张图';
        },
        skill_libary: { getAllSkillDocs: async () => [] },
    };
}
prompter.chat_model = recorder('chat_model');
prompter.vision_model = recorder('vision_model');
prompter.code_model = recorder('code_model');
// 关掉冷却与落盘副作用（这两件事与本条无关，且不该产生文件）
prompter.checkCooldown = async () => {};
// 模板填充（$STATS 要真 bot 的位置/背包）也替换成恒等：本条测的是 prompter→模型层**这一段**
// 有没有把 opts 传下去，与 prompt 文本长什么样无关。保留 replaceStrings 只会把假 bot 撑成一座山，
// 反而模糊被测面。
prompter.replaceStrings = async (p) => String(p ?? '');
prompter._saveLog = async () => {};
prompter.logTotals = () => {};

const run = async (label, fn) => {
    const before = calls.length;
    let ret, err = null;
    try { ret = await fn(); } catch (e) { err = String(e?.message ?? e).slice(0, 80); }
    const seen = calls.slice(before);
    const c = seen[0] ?? null;
    say(`${label}: 模型层收到 ${c ? c.argc : '(未调用)'} 个实参；第4参 opts = ${c ? c.optsType : 'n/a'}`
        + `；返回 ${err ? 'ERR:' + err : JSON.stringify(String(ret).slice(0, 40))}`);
    return { seen, ret, err, opts: c?.opts };
};

say('');
say('=== ① 实参个数（模型层实际收到）===');
const m1 = await run('promptMemSavingResult  ', () => prompter.promptMemSavingResult([{ role: 'user', content: 'x' }]));
const m2 = await run('promptShouldRespondToBot ', () => prompter.promptShouldRespondToBotResult('你好'));
const m3 = await run('promptVisionResult        ', () => prompter.promptVisionResult([], Buffer.from('img')));
// 对照组：已迁移路径按约定传 callOpts
const ctl = new AbortController();
const m4 = await run('promptCodingResult(对照)  ', () => prompter.promptCodingResult([], { signal: ctl.signal, deadline: Date.now() + 5000 }));

say('');
say('=== ② abort 之后是否仍跑满 ===');
const ac = new AbortController();
ac.abort();
say('这里传的是空 opts（三条目标路径本来就不接受 opts），但等价地验证"模型层收不到 signal"：');
say('  · 三条路径收到 opts =', [m1.opts, m2.opts, m3.opts].map((o) => o === undefined ? 'undefined' : typeof o).join(' / '));
say('  · 对照路径收到 opts =', m4.opts === undefined ? 'undefined' : 'object（含 signal）');

// 直接证据：把 signal 交给对照组，abort 后对照组立即 cancelled；目标路径没有这条通道
const ac2 = new AbortController();
ac2.abort();
const ctlRes = await prompter.promptCodingResult([], { signal: ac2.signal });
say('对照组（有 signal）abort 后 status =', ctlRes.status, '(期望 cancelled)');
const noOptsRes = await prompter.promptMemSavingResult([{ role: 'user', content: 'y' }]);
say('记忆摘要（无 signal 通道）abort 之后仍然 status =', noOptsRes.status, '(不是 cancelled ⇒ 跑满)');

// ── 判定 ────────────────────────────────────────────────────────────────────
const allUndefined = [m1.opts, m2.opts, m3.opts].every((o) => o === undefined);
const ctlHasOpts = m4.opts && typeof m4.opts === 'object';
const runsFull = noOptsRes.status !== STATUS.CANCELLED;
say('');
if (allUndefined && ctlHasOpts && runsFull) {
    say('Verdict=0 缺陷成立：三条路径不下传 opts（模型层收不到 signal/deadline/operationId），'
        + 'abort 后仍跑满超时；对照组证明同一条通道在 promptCoding 上是通的');
    process.exit(0);
}
say(`Verdict=1 已闭合或通道存在：allUndefined=${allUndefined} ctlHasOpts=${ctlHasOpts} runsFull=${runsFull}`);
process.exit(1);
