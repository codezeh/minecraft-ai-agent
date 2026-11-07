#!/usr/bin/env node
/**
 * T9 / 模型层 7 条 —— 「输出被 max_tokens 截断」vs「上下文真的超限」的判别探针。
 *
 * 方法沿用 T6/probe-mod001-stub.mjs：**真实适配器源码 + 假 SDK client（计数桩）**，零付费请求。
 * 探针只做两件事：
 *   场景 A（截断）：返回 finish_reason='length'（Anthropic 是 stop_reason='max_tokens'）
 *       期望：**1 次请求** + 返回内容带 [LLM_TRUNCATED]（不再抛错→裁历史重发）
 *   场景 B（真超限）：第 1 次调用抛真正的上下文超限，第 2 次返回正常 'stop'
 *       期望：仍按原逻辑裁历史重试 1 次 ⇒ turns=4 时 **2 次请求**（不许被"修过头"做掉）
 *      B 跑两种形态：code='context_length_exceeded' 与纯文案 'Context length exceeded'
 *
 * 用法：node docs/真机-20261106/T9/probe-t9-adapters.mjs [--out=前/后的文件名后缀]
 * 输出：docs/真机-20261106/T9/evidence-adapters-<suffix>.json + stdout 表
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.MC_REPO || path.join(HERE, '..', '..', '..', 'mindcraft'));
const SUFFIX = (process.argv.find((a) => a.startsWith('--out=')) || '--out=after').split('=')[1];
const load = (p) => import(pathToFileURL(p).href);

const { isTruncatedReply, isContextLengthError, TRUNCATED_SUFFIX, setUsageSink }
    = await load(path.join(REPO, 'src/models/_shared.js'));
setUsageSink(null); // 静音 usage 日志（仍累计）

const SYS = 'You are a test harness.';
const HALF = '好的，我来数：1,2,3,4,5,6,7,8,9';   // 模拟 max_tokens 用完拿到的半句话
const turnsOf = (n) => Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${i}`,
}));

/** 假 OpenAI 形状 client：记录每次请求的 messages 长度（能看出"白删历史"的指纹）。 */
function fakeOpenAI(handler) {
    const calls = [];
    const create = async (pack) => {
        calls.push({ len: pack?.messages?.length, model: pack?.model, max_tokens: pack?.max_tokens });
        return handler(pack, calls.length);
    };
    return {
        calls,
        client: {
            chat: { completions: { create } },
            responses: { create: async (pack) => { calls.push({ len: pack?.input?.length, via: 'responses' }); return handler(pack, calls.length); } },
        },
    };
}
/** 假 Anthropic 形状 client。 */
function fakeAnthropic(handler) {
    const calls = [];
    return {
        calls,
        client: {
            messages: {
                create: async (pack) => {
                    calls.push({ len: pack?.messages?.length, model: pack?.model, max_tokens: pack?.max_tokens });
                    return handler(pack, calls.length);
                },
            },
        },
    };
}

/** 只注入依赖、不走构造函数（构造函数会 new 真 SDK / 读 key）。 */
const mk = (Cls, fields) => Object.assign(Object.create(Cls.prototype), fields);

const openaiReply = (finish) => ({
    choices: [{ finish_reason: finish, message: { content: HALF } }],
    usage: { prompt_tokens: 100, completion_tokens: 16 },
});
const anthropicReply = (stopReason) => ({
    content: [{ type: 'text', text: HALF }],
    stop_reason: stopReason,
    usage: { input_tokens: 100, output_tokens: 16 },
});
const ctxErr = (variant) => {
    if (variant === 'code') return Object.assign(new Error('request rejected'), { code: 'context_length_exceeded' });
    return new Error('Context length exceeded'); // 纯文案形态
};

/** 适配器清单：sdk 决定用哪个假 client；field 是该文件把 client 存哪儿。 */
const ADAPTERS = [
    { file: 'claude.js', cls: 'Claude', sdk: 'anthropic', field: 'anthropic', params: { max_tokens: 16 } },
    { file: 'qwen.js', cls: 'Qwen', sdk: 'openai', field: 'openai' },
    { file: 'vllm.js', cls: 'VLLM', sdk: 'openai', field: 'vllm' },
    { file: 'grok.js', cls: 'Grok', sdk: 'openai', field: 'openai' },
    { file: 'mercury.js', cls: 'Mercury', sdk: 'openai', field: 'openai' },
    { file: 'novita.js', cls: 'Novita', sdk: 'openai', field: 'openai' },
    { file: 'lmstudio.js', cls: 'LMStudio', sdk: 'openai', field: 'openai' },
    // 回归对照（已修好，必须保持 1 次 + 标记）
    { file: 'deepseek.js', cls: 'DeepSeek', sdk: 'openai', field: 'openai' },
    { file: 'gpt.js', cls: 'GPT', sdk: 'openai', field: 'openai', url: 'http://stub.invalid' },
];
const TARGETS = new Set(['claude.js', 'qwen.js', 'vllm.js', 'grok.js', 'mercury.js', 'novita.js', 'lmstudio.js']);

const results = [];

async function runScenarioA(a) {
    const { [a.cls]: Cls } = await load(path.join(REPO, `src/models/${a.file}`));
    const t = a.sdk === 'anthropic'
        ? fakeAnthropic(() => anthropicReply('max_tokens'))
        : fakeOpenAI(() => openaiReply('length'));
    const inst = mk(Cls, {
        model_name: 'test-model',
        params: a.params || { max_tokens: 16 },
        url: a.url || 'http://stub.invalid',
        [a.field]: t.client,
        // vllm 用 this.vllm、其余用 this.openai：两个都塞上，谁用谁拿
        openai: t.client, vllm: t.client, anthropic: t.client,
    });
    let out = null, threw = null;
    try { out = await inst.sendRequest(turnsOf(4), SYS, '***'); }
    catch (e) { threw = String(e?.message ?? e); }
    return {
        adapter: a.file,
        isTarget: TARGETS.has(a.file),
        scenario: 'A: 输出被 max_tokens 截断（finish_reason=length / stop_reason=max_tokens）',
        turnsIn: 4,
        requestsIssued: t.calls.length,
        messagesLenTrace: t.calls.map((c) => c.len),
        returned: typeof out === 'string' ? out : String(out),
        markedTruncated: isTruncatedReply(out),
        threw,
        ok: t.calls.length === 1 && isTruncatedReply(out) && !threw,
        verdict: threw ? `THREW(${threw})`
            : t.calls.length > 1 ? `DUP-REQUEST（${t.calls.length} 次，历史被白删重发：${t.calls.map((c) => c.len).join('→')}）`
                : isTruncatedReply(out) ? 'OK（1 次请求 + 已打截断标记）'
                    : 'SILENT-TRUNCATION（1 次请求，但截断没被标记）',
    };
}

async function runScenarioB(a, variant) {
    const { [a.cls]: Cls } = await load(path.join(REPO, `src/models/${a.file}`));
    const mkHandler = () => (pack, n) => {
        if (n === 1) throw ctxErr(variant);
        return a.sdk === 'anthropic' ? anthropicReply('end_turn') : openaiReply('stop');
    };
    const t = a.sdk === 'anthropic' ? fakeAnthropic(mkHandler()) : fakeOpenAI(mkHandler());
    const inst = mk(Cls, {
        model_name: 'test-model',
        params: a.params || { max_tokens: 16 },
        url: a.url || 'http://stub.invalid',
        [a.field]: t.client,
        openai: t.client, vllm: t.client, anthropic: t.client,
    });
    let out = null, threw = null;
    try { out = await inst.sendRequest(turnsOf(4), SYS, '***'); }
    catch (e) { threw = String(e?.message ?? e); }
    const retried = t.calls.length === 2;
    return {
        adapter: a.file,
        isTarget: TARGETS.has(a.file),
        scenario: `B: 真上下文超限（variant=${variant}）→ 期望裁历史重试 1 次`,
        turnsIn: 4,
        requestsIssued: t.calls.length,
        messagesLenTrace: t.calls.map((c) => c.len),
        returned: typeof out === 'string' ? out : String(out),
        threw,
        retried,
        // claude 原本就没有"裁历史重试"这条逻辑，它的既有行为是失败回复；不算回归
        ok: a.file === 'claude.js'
            ? (t.calls.length === 1 && /\[LLM_ERROR\]/.test(String(out)))
            : (retried && /ok|好的|turn-/.test(String(out)) === true ? true : retried),
        note: a.file === 'claude.js' ? 'claude.js 原本就没有裁历史重试分支（既有行为=失败回复），本任务不新增' : null,
        verdict: a.file === 'claude.js'
            ? (t.calls.length === 1 ? 'AS-BEFORE（1 次请求 + 失败回复，claude 从无裁历史逻辑）' : `UNEXPECTED(${t.calls.length} 次)`)
            : t.calls.length === 2 ? `OK（真超限 → 裁历史重试 1 次；messages ${t.calls.map((c) => c.len).join('→')}）`
                : `BROKEN（期望 2 次，实际 ${t.calls.length} 次）`,
    };
}

for (const a of ADAPTERS) {
    try { results.push(await runScenarioA(a)); }
    catch (e) { results.push({ adapter: a.file, scenario: 'A', error: String(e?.message ?? e) }); }
}
for (const variant of ['code', 'msg']) {
    for (const a of ADAPTERS) {
        try { results.push(await runScenarioB(a, variant)); }
        catch (e) { results.push({ adapter: a.file, scenario: `B-${variant}`, error: String(e?.message ?? e) }); }
    }
}

// 判据边界（isContextLengthError 本身）
const errCases = [
    { label: "Error('Context length exceeded')", err: new Error('Context length exceeded') },
    { label: "code=context_length_exceeded", err: Object.assign(new Error('x'), { code: 'context_length_exceeded' }) },
    { label: "message 含 maximum context", err: new Error("This model's maximum context length is 8192 tokens") },
    { label: 'message 含 max_tokens（输出截断措辞，不该算上下文超限）', err: new Error('output truncated because max_tokens was reached') },
    { label: '普通网络错误', err: new Error('ECONNRESET') },
];

const A = results.filter((r) => r.scenario?.startsWith('A'));
const B = results.filter((r) => r.scenario?.startsWith('B'));

const summary = {
    truncationTargetsOk: A.filter((r) => r.isTarget && r.ok).map((r) => r.adapter),
    truncationTargetsBad: A.filter((r) => r.isTarget && !r.ok).map((r) => ({ adapter: r.adapter, verdict: r.verdict, requests: r.requestsIssued })),
    regressionOk: A.filter((r) => !r.isTarget && r.ok).map((r) => r.adapter),
    regressionBad: A.filter((r) => !r.isTarget && !r.ok).map((r) => ({ adapter: r.adapter, verdict: r.verdict })),
    reverseControlOk: B.filter((r) => r.adapter !== 'claude.js' && r.requestsIssued === 2).map((r) => `${r.adapter}:${r.scenario.split('variant=')[1]?.split('）')[0]}`),
    reverseControlBad: B.filter((r) => r.adapter !== 'claude.js' && r.requestsIssued !== 2).map((r) => ({ adapter: r.adapter, v: r.scenario, requests: r.requestsIssued })),
    claudeReverse: B.filter((r) => r.adapter === 'claude.js').map((r) => ({ v: r.scenario, requests: r.requestsIssued, verdict: r.verdict })),
};

const outDoc = {
    tool: 'T9/probe-t9-adapters.mjs',
    generatedAt: new Date().toISOString(),
    suffix: SUFFIX,
    repo: REPO,
    method: '真实适配器 sendRequest + 假 SDK client（计数桩）；零付费请求',
    truncatedMarker: TRUNCATED_SUFFIX,
    scenarioA: A,
    scenarioB: B,
    isContextLengthErrorCases: errCases.map((c) => ({ ...c, isContextLengthError: isContextLengthError(c.err) })),
    summary,
};
const outFile = path.join(HERE, `evidence-adapters-${SUFFIX}.json`);
fs.writeFileSync(outFile, JSON.stringify(outDoc, null, 2));

// stdout 表
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n=== 场景 A：输出被 max_tokens 截断（期望 1 次请求 + ${TRUNCATED_SUFFIX}）===`);
console.log(pad('adapter', 14) + pad('请求数', 8) + pad('messages 长度轨迹', 20) + pad('已标记', 8) + '判定');
for (const r of A) {
    console.log(pad(r.adapter, 14) + pad(r.requestsIssued ?? '-', 8) + pad(JSON.stringify(r.messagesLenTrace || []), 20)
        + pad(r.markedTruncated, 8) + (r.verdict ?? r.error));
}
console.log(`\n=== 场景 B：真上下文超限（期望 6 个原逻辑仍重试 → 2 次请求）===`);
for (const v of ['code', 'msg']) {
    console.log(`-- variant=${v} --`);
    for (const r of B.filter((x) => x.scenario.includes(`variant=${v}`))) {
        console.log(pad(r.adapter, 14) + pad(r.requestsIssued ?? '-', 8) + pad(JSON.stringify(r.messagesLenTrace || []), 20) + (r.verdict ?? r.error));
    }
}
console.log('\n=== 判据边界 ===');
for (const c of outDoc.isContextLengthErrorCases) console.log(pad(c.isContextLengthError, 8) + c.label);
console.log('\n=== 汇总 ===');
console.log(JSON.stringify(summary, null, 2));
console.log(`\n写入：${outFile}`);
process.exit(summary.truncationTargetsBad.length === 0 && summary.regressionBad.length === 0
    && summary.reverseControlBad.length === 0 ? 0 : 2);