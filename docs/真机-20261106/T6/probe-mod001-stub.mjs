#!/usr/bin/env node
/**
 * T6 / MOD-001 —— 「输出被截断被误当上下文超限 → 重复请求」的**确定性触发**探针。
 *
 * 为什么用"真实适配器 + 假传输层"（而不是全真请求）：
 *   · 这个缺陷的表现是"一次调用变成 N 次请求"，N 取决于 turns.length。
 *     真发的话单条用例就能烧掉 4~6 次付费请求，直接违反本任务 ≤3 次的预算。
 *   · 用假 transport 调用的是**产品源码里真实的 sendRequest**（递归、判断、标记全走真代码），
 *     只是把最外层 SDK client 换成计数桩 ⇒ 触发条件 100% 确定，且费用为 0。
 *   · 真实网络那一面由 T6/probe-live-a.mjs 负责（走 Claude 适配器真发 1 次）。
 *
 * 判定：对每个适配器，喂一个「输出额度用完」（finish_reason/stop_reason = length/max_tokens）
 *      的响应，统计它**实际发出几次请求**、返回内容有没有被打截断标记。
 *
 * 用法：node docs/真机-20261106/T6/probe-mod001-stub.mjs
 * 输出：T6/mod001-stub-result.json + stdout 摘要
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.MC_REPO || path.join(HERE, '..', '..', '..', 'mindcraft'));

/** Windows 上 import() 不认盘符绝对路径，必须转成 file:// URL。 */
const load = (p) => import(pathToFileURL(p).href);

const { isContextLengthError, isTruncatedReply, TRUNCATED_SUFFIX, setUsageSink }
    = await load(path.join(REPO, 'src/models/_shared.js'));

// 静音 usage sink（避免刷屏，但仍累计）
setUsageSink(null);

// ── 假 transport：计数 + 可配置返回 ────────────────────────────
function fakeOpenAI(makeReply) {
    const calls = [];
    return {
        calls,
        client: {
            chat: {
                completions: {
                    create: async (pack) => {
                        calls.push({ len: pack?.messages?.length, model: pack?.model, max_tokens: pack?.max_tokens });
                        return makeReply(pack, calls.length);
                    }
                }
            },
            responses: {
                create: async (pack) => {
                    calls.push({ len: pack?.input?.length, model: pack?.model, via: 'responses' });
                    return makeReply(pack, calls.length);
                }
            }
        }
    };
}
function fakeAnthropic(makeReply) {
    const calls = [];
    return {
        calls,
        client: {
            messages: {
                create: async (pack) => {
                    calls.push({ len: pack?.messages?.length, model: pack?.model, max_tokens: pack?.max_tokens });
                    return makeReply(pack, calls.length);
                }
            }
        }
    };
}

/** 造一个"只注入依赖、不走构造函数"的适配器实例（构造函数里会 new 真 SDK / 读 key，不需要）。 */
function mk(Cls, fields) {
    const o = Object.create(Cls.prototype);
    Object.assign(o, fields);
    return o;
}

const turnsOf = (n) => Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${i}`,
}));
const SYS = 'You are a test harness.';

// 一个长约 16 token 的"被截断的输出"样本（模拟 max_tokens 用完后拿到的半句话）
const HALF_SENTENCE = '好的，我来数：1,2,3,4,5,6,7,8,9';

const results = [];

async function runOpenAIAdapter({ name, file, finishReason = 'length', turnsLen = 4, content = HALF_SENTENCE }) {
    const { [name]: Cls } = await load(path.join(REPO, `src/models/${file}`));
    const t = fakeOpenAI(() => ({
        choices: [{ finish_reason: finishReason, message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 16 },
    }));
    // 关键：url 设为非空 —— gpt.js 只有在 url 存在时才走 chat.completions 分支
    const inst = mk(Cls, {
        model_name: 'test-model',
        params: { max_tokens: 16 },
        url: 'http://stub.invalid',
        // vllm.js 用的是 this.vllm、其余用 this.openai：两个都注入，谁用谁拿
        openai: t.client,
        vllm: t.client,
    });
    let out, err = null;
    try { out = await inst.sendRequest(turnsOf(turnsLen), SYS); }
    catch (e) { err = String(e?.message ?? e); }
    return {
        adapter: file,
        class: name,
        scenario: `finish_reason='${finishReason}'`,
        turnsIn: turnsLen,
        requestsIssued: t.calls.length,
        requestsDetail: t.calls,
        returned: typeof out === 'string' ? out : (out === undefined ? '<undefined>' : JSON.stringify(out)),
        markedTruncated: isTruncatedReply(out),
        threw: err,
        verdict: t.calls.length > 1 ? 'DUP-REQUEST（同一轮对话被放大成多次付费请求）'
            : (isTruncatedReply(out) ? 'OK（单次请求 + 已打截断标记）'
                : 'SILENT-TRUNCATION（单次请求，但截断未被标记）'),
    };
}

// ── 1. 仍是"旧写法"的 6 个适配器 ────────────────────────────────
for (const [name, file] of [
    ['Qwen', 'qwen.js'],
    ['VLLM', 'vllm.js'],
    ['Grok', 'grok.js'],
    ['Mercury', 'mercury.js'],
    ['Novita', 'novita.js'],
    ['LMStudio', 'lmstudio.js'],
    ['DeepSeek', 'deepseek.js'],
]) {
    try {
        results.push(await runOpenAIAdapter({ name, file }));
    } catch (e) {
        results.push({ adapter: file, class: name, error: String(e?.message ?? e), note: '注入形状不符，跳过' });
    }
}

// ── 2. 已修好的对照：gpt.js（url 非空 → chat.completions 分支）──
try {
    const { GPT } = await load(path.join(REPO, 'src/models/gpt.js'));
    const t = fakeOpenAI(() => ({
        choices: [{ finish_reason: 'length', message: { content: HALF_SENTENCE } }],
        usage: { prompt_tokens: 100, completion_tokens: 16 },
    }));
    const inst = mk(GPT, { model_name: 'test-model', params: { max_tokens: 16 }, url: 'http://stub.invalid', openai: t.client });
    const out = await inst.sendRequest(turnsOf(4), SYS, '***');
    results.push({
        adapter: 'gpt.js',
        class: 'GPT',
        scenario: "finish_reason='length'（已修对照）",
        turnsIn: 4,
        requestsIssued: t.calls.length,
        requestsDetail: t.calls,
        returned: out,
        markedTruncated: isTruncatedReply(out),
        threw: null,
        verdict: t.calls.length > 1 ? 'DUP-REQUEST' : (isTruncatedReply(out) ? 'OK（单次请求 + 已打截断标记）' : 'SILENT-TRUNCATION'),
    });
} catch (e) {
    results.push({ adapter: 'gpt.js', error: String(e?.message ?? e) });
}

// ── 3. 真正的上下文超限错误（修好后**仍应**裁历史重试，作为反向对照）──
try {
    const { GPT } = await load(path.join(REPO, 'src/models/gpt.js'));
    const t = fakeOpenAI((pack, n) => {
        if (n === 1) {
            // 第一次：抛真正的上下文超限
            const e = new Error('This model\'s maximum context length is 8192 tokens');
            e.code = 'context_length_exceeded';
            throw e;
        }
        return { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
    });
    const inst = mk(GPT, { model_name: 'test-model', params: { max_tokens: 16 }, url: 'http://stub.invalid', openai: t.client });
    const out = await inst.sendRequest(turnsOf(4), SYS, '***');
    results.push({
        adapter: 'gpt.js',
        class: 'GPT',
        scenario: '真正的 context_length_exceeded（反向对照：应当裁历史重试）',
        turnsIn: 4,
        requestsIssued: t.calls.length,
        requestsDetail: t.calls,
        returned: out,
        markedTruncated: isTruncatedReply(out),
        threw: null,
        verdict: t.calls.length === 2 ? 'OK（正确识别为上下文超限 → 裁历史重试 1 次）'
            : `UNEXPECTED（期望 2 次，实际 ${t.calls.length} 次）`,
    });
} catch (e) {
    results.push({ adapter: 'gpt.js', error: String(e?.message ?? e) });
}

// ── 4. Claude（本项目当前实际使用的通路）────────────────────────
try {
    const { Claude } = await load(path.join(REPO, 'src/models/claude.js'));
    const t = fakeAnthropic(() => ({
        content: [{ type: 'text', text: HALF_SENTENCE }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 16 },
    }));
    const inst = mk(Claude, { model_name: 'deepseek-v4.1-flash', params: { max_tokens: 16 }, anthropic: t.client });
    const out = await inst.sendRequest(turnsOf(4), SYS);
    results.push({
        adapter: 'claude.js',
        class: 'Claude',
        scenario: "stop_reason='max_tokens'（本项目在用的通路）",
        turnsIn: 4,
        requestsIssued: t.calls.length,
        requestsDetail: t.calls,
        returned: out,
        markedTruncated: isTruncatedReply(out),
        threw: null,
        verdict: t.calls.length > 1 ? 'DUP-REQUEST'
            : (isTruncatedReply(out) ? 'OK' : 'SILENT-TRUNCATION（单次请求，但截断未被标记 —— 上层无法区分"说完了"和"被切了"）'),
    });
} catch (e) {
    results.push({ adapter: 'claude.js', error: String(e?.message ?? e) });
}

// ── 5. isContextLengthError 判据本身的边界（含 MOD-001 的关键点）──
const errCases = [
    { label: "finish_reason='length' 被包装成 Error('Context length exceeded')", err: new Error('Context length exceeded') },
    { label: 'code=context_length_exceeded', err: Object.assign(new Error('x'), { code: 'context_length_exceeded' }) },
    { label: 'message 含 maximum context', err: new Error("This model's maximum context length is 8192 tokens") },
    { label: 'message 含 prompt is too long', err: new Error('prompt is too long: 21000 tokens') },
    { label: "message 含 'max_tokens'（输出截断的常见措辞）", err: new Error('output truncated because max_tokens was reached') },
    { label: '普通网络错误', err: new Error('ECONNRESET') },
];
const errVerdicts = errCases.map((c) => ({ ...c, isContextLengthError: isContextLengthError(c.err) }));

// ── 6. 归类：把"输出截断"用例与"真上下文超限"反向对照分开 ──────
//    （后者请求 2 次是**正确行为**，不能被算进"重复请求"缺陷统计）
for (const r of results) {
    if (!r.category) {
        r.category = String(r.scenario || '').includes('context_length_exceeded')
            ? 'real-context-error'
            : 'truncation';
    }
}

const out = {
    tool: 'T6/probe-mod001-stub.mjs',
    generatedAt: new Date().toISOString(),
    repo: REPO,
    method: '真实适配器 sendRequest + 假 SDK client（请求计数桩）；零付费请求',
    truncatedMarker: TRUNCATED_SUFFIX,
    adapterResults: results,
    isContextLengthErrorCases: errVerdicts,
    summary: {
        dupRequestAdapters: results.filter((r) => r.category === 'truncation' && (r.requestsIssued || 0) > 1).map((r) => r.adapter),
        maxRequestsMultiplier: Math.max(0, ...results.filter((r) => r.category === 'truncation').map((r) => r.requestsIssued || 0)),
        silentTruncationAdapters: results.filter((r) => r.category === 'truncation' && r.verdict?.startsWith('SILENT')).map((r) => r.adapter),
        okAdapters: results.filter((r) => r.category === 'truncation' && r.verdict?.startsWith('OK')).map((r) => r.adapter),
        reverseControl: results.filter((r) => r.category === 'real-context-error').map((r) => ({ adapter: r.adapter, requestsIssued: r.requestsIssued, verdict: r.verdict })),
    },
};

const outPath = path.join(HERE, 'mod001-stub-result.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

console.log('════ MOD-001 桩探针（真实适配器 + 假 transport，0 付费请求）════');
for (const r of results) {
    if (r.error) { console.log(`${String(r.adapter).padEnd(14)} ERROR ${r.error}`); continue; }
    console.log(`${r.adapter.padEnd(14)} turns=${r.turnsIn} requests=${r.requestsIssued}  ${r.verdict}`);
    if (r.requestsIssued > 1) {
        console.log(`               ↳ 各次请求的 messages 长度: ${r.requestsDetail.map((c) => c.len).join(' → ')}`);
    }
}
console.log('');
console.log('isContextLengthError 判据边界：');
for (const e of errVerdicts) {
    console.log(`  ${e.isContextLengthError ? 'HIT ' : 'miss'}  ${e.label}`);
}
console.log('');
console.log(`重复请求的适配器: ${out.summary.dupRequestAdapters.join(', ') || '(无)'}`);
console.log(`单轮最多放大倍数: ${out.summary.maxRequestsMultiplier}x`);
console.log(`静默截断（未打标记）: ${out.summary.silentTruncationAdapters.join(', ') || '(无)'}`);
console.log(`\n已写出: ${outPath}`);
