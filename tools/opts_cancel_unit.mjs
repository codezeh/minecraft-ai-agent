/**
 * t29 / T22-C —— 三处模型调用是否**接上了取消信号**（opts 贯穿）。
 *
 * 缺陷原貌（T22 实测）：`promptMemSavingResult` / `promptShouldRespondToBot` / `promptVisionResult`
 *   都没有 `opts` 形参 ⇒ 模型层收不到 `signal`/`deadline`/`operationId`，
 *   玩家 `!stop`、面板停止、动作超时**都拦不住**它们，只能等适配器自身 120s 上限。
 *   对照组 `promptCodingResult` 是通的（带 signal 时 abort 后 `status=cancelled`）。
 *
 * 用例（全部离线，用**真 Prompter** + 记录器模型层，不连任何模型 API）：
 *   ① 对照组仍绿：coding + 已 abort 的 signal ⇒ cancelled
 *   ② 三处接线：预取消（发请求前已 abort）⇒ cancelled；进行中取消（abort 于 50ms）⇒ **不是 ok**
 *      且耗时显著短于"跑满"（记录器 300ms）
 *   ③ 缺省兼容：不传 opts ⇒ 三条路径 status=ok（防回归的关键）
 *   ④ 形参确实到了模型层：memSaving/ShouldRespond 的第 4 参、Vision 的第 4 参都是带 signal 的对象
 *
 * 退出码：0 = 全过；1 = 有失败。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (name, ev = '') => { pass++; console.log(`PASS ${name}${ev ? '  ' + ev : ''}`); };
const bad = (name, ev = '') => { fail++; console.log(`FAIL ${name}${ev ? '  ' + ev : ''}`); };

// 模型层/账号库都是 cwd 相对：先在仓库根跑，缺 keys.json 时 GPT 构造会失败
process.chdir(ROOT);

const { default: settings } = await import(pathToFileURL(path.join(ROOT, 'src/agent/settings.js')).href);
settings.base_profile = settings.base_profile || 'survival';
settings.language = 'en';
const { Prompter } = await import(pathToFileURL(path.join(ROOT, 'src/models/prompter.js')).href);
const { STATUS } = await import(pathToFileURL(path.join(ROOT, 'src/models/result.js')).href);
const { failedReply } = await import(pathToFileURL(path.join(ROOT, 'src/models/_shared.js')).href);

const FULL_MS = 300;   // 记录器"跑满"一次的耗时

/** 支持取消的假模型层：看得到 signal 就在 abort 时立刻放弃，并记录收到的形参。 */
function makeRecorder() {
    const calls = [];
    const make = (label, extra) => ({
        ...extra,
        async sendRequest(messages, prompt, stop_seq, opts) {
            calls.push({ label, argc: arguments.length, stop_seq, opts });
            return await guarded(opts, `内容-${label}`);
        },
        async sendVisionRequest(messages, prompt, imageBuffer, opts) {
            calls.push({ label, argc: arguments.length, opts });
            return await guarded(opts, `图像描述-${label}`);
        },
    });
    return { calls, make };
}

/**
 * 等价于"真实适配器接到 signal 后会怎样"：abort 就**提前返回失败标记**。
 *
 * ⚠ 注意这里**不抛异常**：全仓适配器的契约是 `sendRequest` **永不抛**，
 *   失败一律返回 `failedReply(...)`（`_shared.js`）。探针若让记录器抛，
 *   测的就不是真实契约了（第一版就是这么写的，会让 prompter 直接把异常翻出去 —— 已修）。
 */
function guarded(opts, value) {
    const signal = opts?.signal ?? null;
    if (signal?.aborted) return Promise.resolve(failedReply('模型请求被取消'));
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(value), FULL_MS);
        signal?.addEventListener?.('abort', () => {
            clearTimeout(t);
            resolve(failedReply('模型请求被取消'));
        }, { once: true });
    });
}

/** 造一个真 Prompter，只把模型层换成记录器（profile 模板用真的）。 */
function makePrompter() {
    const p = new Prompter(
        { name: 'optsprobe', history: { getHistory: () => [], memory: '' }, bot: { interrupt_code: false } },
        { name: 'optsprobe', model: 'openai/gpt-4o-mini' },
    );
    const rec = makeRecorder();
    p.chat_model = rec.make('chat', {});
    p.code_model = rec.make('code', {});
    p.vision_model = rec.make('vision', {});
    // 与本条无关的副作用一律打桩：冷却 / 落盘 / 模板里的 $STATS（要真 bot）
    // 注意：桩**不加 async** —— 它们没有 await，加 async 会被 eslint require-await 判红；
    // 而 prompter 那边是 `await this.checkCooldown()`，await 一个非 Promise 值完全合法。
    p.checkCooldown = () => {};
    p._saveLog = () => {};
    p.logTotals = () => {};
    p.replaceStrings = (s) => String(s ?? '');
    return { p, rec };
}

const visionArgs = () => [[], Buffer.from('img')];

// ══════════════════════════════════════════════════════════════════════════
// ① 对照组：coding 带 signal，发送前已 abort ⇒ cancelled（改动不许把它弄坏）
// ══════════════════════════════════════════════════════════════════════════
{
    const { p } = makePrompter();
    const ac = new AbortController(); ac.abort();
    const r = await p.promptCodingResult([], { signal: ac.signal, deadline: Date.now() + 5000 });
    if (r.status === STATUS.CANCELLED) ok('① 对照组 promptCodingResult 预取消 ⇒ cancelled', `status=${r.status}`);
    else bad('① 对照组被弄坏了：coding 预取消没返回 cancelled', `status=${r.status}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ② 三处接线：预取消 + 进行中取消（各 1 条断言）
// ══════════════════════════════════════════════════════════════════════════
const paths = [
    ['memSaving', (p, opts) => p.promptMemSavingResult([{ role: 'user', content: 'x' }], opts)],
    ['shouldRespond', (p, opts) => p.promptShouldRespondToBotResult('你好', opts)],
    ['vision', (p, opts) => p.promptVisionResult(...visionArgs(), opts)],
];

for (const [name, run] of paths) {
    // 预取消：请求还没发出就该 cancelled
    const { p, rec } = makePrompter();
    const ac = new AbortController(); ac.abort();
    const t0 = Date.now();
    const r = await run(p, { signal: ac.signal, deadline: Date.now() + 5000 });
    const ms = Date.now() - t0;
    if (r.status === STATUS.CANCELLED) ok(`② ${name} 预取消 ⇒ cancelled`, `status=${r.status} ${ms}ms 调用次数=${rec.calls.length}`);
    else bad(`② ${name} 预取消没有返回 cancelled`, `status=${r.status} ${ms}ms`);

    // 进行中取消：50ms 后 abort，记录器 300ms 才"跑满"
    const { p: p2, rec: rec2 } = makePrompter();
    const ac2 = new AbortController();
    const t1 = Date.now();
    const pending = run(p2, { signal: ac2.signal });
    await new Promise((r2) => setTimeout(r2, 50));
    ac2.abort();
    let r2 = null, err2 = null;
    try { r2 = await pending; } catch (e) { err2 = e; }
    const ms2 = Date.now() - t1;
    if (err2) { bad(`② ${name} 进行中取消抛了异常（契约要求永不抛）`, err2.message); }
    const notOk = r2?.status !== STATUS.OK;
    const fast = ms2 < FULL_MS - 100;
    if (notOk && fast) {
        ok(`② ${name} 进行中取消 ⇒ 非 ok 且提前返回`, `status=${r2.status} ${ms2}ms（跑满=${FULL_MS}ms） 形参=${rec2.calls[0]?.opts ? 'object' : 'undefined'}`);
    } else {
        bad(`② ${name} 进行中取消未生效`, `status=${r2.status} ${ms2}ms notOk=${notOk} fast=${fast}`);
    }

    // ④ 形参确实到了模型层（第 4 个实参是带 signal 的对象）
    const c = rec2.calls[0];
    if (c && c.opts && typeof c.opts === 'object' && 'signal' in c.opts) {
        ok(`④ ${name} 的 opts 到达模型层`, `argc=${c.argc} keys=${Object.keys(c.opts).join(',')}`);
    } else {
        bad(`④ ${name} 的 opts 没到达模型层`, `call=${JSON.stringify(c)}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 缺省兼容：不传 opts 时必须与改前一致（status=ok，不报错）
// ══════════════════════════════════════════════════════════════════════════
for (const [name, run] of paths) {
    const { p, rec } = makePrompter();
    let r = null, err = null;
    try { r = await run(p, undefined); } catch (e) { err = e; }
    const okStatus = r?.status === STATUS.OK;
    // 缺省时 `_callOptions({})` 产出 {signal:null, timeoutMs:120000, operationId:null}
    // —— 与 promptCodingResult 完全同口径（那里也是 signal:null）。所以判"没有真 signal"，
    //   而不是判 `=== undefined`（第一版判错了，会把正确的实现判红）。
    const sig = rec.calls[0]?.opts?.signal ?? null;
    const noSignal = sig === null;
    if (!err && okStatus) ok(`③ ${name} 缺省（不传 opts）仍 ok`, `status=${r.status} argc=${rec.calls[0]?.argc} signal=${String(rec.calls[0]?.opts?.signal)}`);
    else bad(`③ ${name} 缺省行为变了`, `err=${err?.message ?? 'no'} status=${r?.status}`);
    if (!noSignal) bad(`③ ${name} 缺省时不该带真 signal`, JSON.stringify(rec.calls[0]?.opts));
}

// 旧契约包装器（string / boolean）也不能坏
{
    const { p } = makePrompter();
    const s1 = await p.promptMemSaving([{ role: 'user', content: 'x' }]);
    const b1 = await p.promptShouldRespondToBot('你好');
    const s2 = await p.promptVision(...visionArgs());
    if (typeof s1 === 'string' && s1.length > 0 && typeof b1 === 'boolean' && typeof s2 === 'string') {
        ok('③b 旧契约包装器（string/boolean）仍可用', `memSaving=${JSON.stringify(s1).slice(0, 12)} shouldRespond=${b1} vision=${JSON.stringify(s2).slice(0, 12)}`);
    } else {
        bad('③b 旧契约包装器返回类型变了', JSON.stringify({ s1, b1, s2 }));
    }
}

console.log('');
console.log(`${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
