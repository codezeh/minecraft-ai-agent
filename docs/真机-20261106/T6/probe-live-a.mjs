#!/usr/bin/env node
/**
 * T6 / A + B（真实网络面）—— 走**项目自己的模型层**真发最小请求。
 *
 * 通路：src/models/_model_map.js:createModel(profile) → Claude 适配器 → @anthropic-ai/sdk
 *       → https://api.llmgo.net（Anthropic 兼容代理）
 *
 * 关键设计：
 *  · 用**全局 fetch 拦截器**统计"到底发了几次 HTTP 请求"、每次的 HTTP 状态与耗时，
 *    并把响应体 clone 出来留档 —— 这就是"请求/响应原文"的证据来源。
 *  · 请求头（含 key）**绝不记录**；响应体里如果出现 key 会被替换成掩码。
 *  · max_tokens=16：故意让输出撞上限，一次请求同时回答 A（通路通不通/usage/记账）
 *    与 B 的"真实截断长什么样"（是否重发第二次）。
 *
 * 预算：本脚本**只发 1 次** API 请求，输出 ≤16 tokens。
 *
 * 用法（必须 cwd=mindcraft，因为 utils/keys.js 读的是 './keys.json'）：
 *   cd mindcraft && node ../docs/真机-20261106/T6/probe-live-a.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.MC_REPO || path.join(HERE, '..', '..', '..', 'mindcraft'));
const load = (p) => import(pathToFileURL(p).href);

// ── 0. 读 key（只为打码展示；绝不写进任何输出文件）────────────
const keysRaw = JSON.parse(fs.readFileSync(path.join(REPO, 'keys.json'), 'utf8'));
const RAW_KEY = keysRaw.ANTHROPIC_API_KEY || '';
const mask = (s) => {
    if (!RAW_KEY || typeof s !== 'string') return s;
    return s.split(RAW_KEY).join(`<KEY-MASKED:${RAW_KEY.slice(0, 4)}…${RAW_KEY.slice(-2)}>`);
};
const keyMasked = RAW_KEY
    ? `${RAW_KEY.slice(0, 4)}${'*'.repeat(Math.max(0, RAW_KEY.length - 6))}${RAW_KEY.slice(-2)} (len=${RAW_KEY.length})`
    : '<EMPTY>';

// ── 1. 全局 fetch 拦截器：计数 + 状态 + 耗时 + 响应体留存 ────────
const netLog = [];
const bodyCaptures = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = init?.method ?? (typeof input === 'object' ? input?.method : 'GET') ?? 'GET';
    const t0 = Date.now();
    const entry = { seq: netLog.length + 1, method, url, startedAt: new Date().toISOString() };
    netLog.push(entry);
    try {
        const res = await origFetch(input, init);
        entry.status = res.status;
        entry.ok = res.ok;
        entry.ms = Date.now() - t0;
        // 只在不是流式的情况下克隆响应体留档（clone 不影响 SDK 消费）
        try {
            const clone = res.clone();
            bodyCaptures.push((async () => {
                try { return await clone.text(); } catch { return '<unreadable>'; }
            })());
        } catch { /* ignore */ }
        return res;
    } catch (err) {
        entry.error = String(err?.name || err?.message || err);
        entry.ms = Date.now() - t0;
        throw err;
    }
};

// ── 2. 用项目自己的 createModel 建实例（最接近生产通路）────────
const { createModel } = await load(path.join(REPO, 'src/models/_model_map.js'));
const shared = await load(path.join(REPO, 'src/models/_shared.js'));

const usageLines = [];
shared.setUsageSink((line) => usageLines.push(line));

const profile = {
    api: 'anthropic',
    model: 'deepseek-v4.1-flash',
    url: 'https://api.llmgo.net',
    params: { max_tokens: 16 },   // ★ 必须显式给小值，否则 claude.js:27-34 会强制 4096
};

const out = {
    tool: 'T6/probe-live-a.mjs',
    generatedAt: new Date().toISOString(),
    provider: profile.url,
    model: profile.model,
    api: profile.api,
    params: profile.params,
    keyMasked,
    budget: { maxRequests: 1, maxOutputTokens: 16 },
};

let instanceInfo = { constructor: null, model_name: null, params: null };
try {
    const inst = createModel(profile);
    instanceInfo = {
        constructor: inst?.constructor?.name,
        model_name: inst?.model_name,
        params: inst?.params,
        hasAnthropicClient: !!inst?.anthropic,
        baseURL: inst?.anthropic?.baseURL ?? null,
        // 只记"有没有 key"，不记 key 本身
        apiKeyPresent: !!(inst?.anthropic?.apiKey),
        apiKeyMasked: inst?.anthropic?.apiKey
            ? `${String(inst.anthropic.apiKey).slice(0, 4)}…${String(inst.anthropic.apiKey).slice(-2)}`
            : null,
    };
    out.instance = instanceInfo;

    // ── 3. 真发一次（单轮、max_tokens=16，故意撞上限以观察截断）──
    const turns = [{ role: 'user', content: '请从1数到100，用逗号分隔，不要任何解释。' }];
    const systemMessage = 'You are a test harness reply bot.';
    out.request = { turns: turns.map((t) => ({ role: t.role, contentLength: t.content.length })), systemMessageLength: systemMessage.length };

    const t0 = Date.now();
    const reply = await inst.sendRequest(turns, systemMessage);
    const wallMs = Date.now() - t0;

    // 等响应体 clone 落定
    const bodies = await Promise.all(bodyCaptures.map((p) => p.catch(() => '<err>')));
    const rawBody = bodies[0] ?? '<no body>';

    // ── 4. 解析响应原文（打码后留档）────────────────────────────
    let parsed = null;
    try { parsed = JSON.parse(rawBody); } catch { /* 非 JSON */ }

    out.result = {
        wallClockMs: wallMs,
        httpRequests: netLog.length,
        netLog: netLog.map((e) => ({ seq: e.seq, method: e.method, url: e.url, status: e.status, ok: e.ok, ms: e.ms, error: e.error })),
        httpStatus: netLog[0]?.status ?? null,
        // 响应原文（打码）：保留结构与 usage，内容原样
        rawResponseMasked: mask(rawBody.length > 4000 ? rawBody.slice(0, 4000) + '…<truncated for log>' : rawBody),
        parsed: parsed ? {
            id: parsed.id,
            type: parsed.type,
            role: parsed.role,
            model: parsed.model,
            stop_reason: parsed.stop_reason,
            stop_sequence: parsed.stop_sequence,
            usage: parsed.usage,
            contentTypes: (parsed.content || []).map((c) => c.type),
            textContent: (parsed.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''),
        } : null,
        // 项目侧返回值（适配器契约：Promise<string>）
        adapterReturned: mask(typeof reply === 'string' ? reply : JSON.stringify(reply)),
        adapterReturnedLength: typeof reply === 'string' ? reply.length : null,
        markedTruncated: shared.isTruncatedReply(reply),
        isFailedReply: shared.isFailedReply(reply),
    };

    // ── 5. 项目侧记账（recordUsage）是否真的生效 ─────────────────
    out.usageAccounting = {
        sinkLines: usageLines.map(mask),
        totals: shared.usageTotals(),
        note: 'totals.calls 应等于 HTTP 请求次数；若 usage 缺失则 totals.missing 会加 1',
    };

    // ── 6. 费用估算 ─────────────────────────────────────────────
    // 该代理没有公开价目表，模型 id 是代理自定义的 'deepseek-v4.1-flash'。
    // 所以这里**只报实测 token 数**，并按几个常见 DeepSeek 档位给出区间，明确标注是假设。
    const u = out.result.parsed?.usage || {};
    const inTok = u.input_tokens ?? null;
    const outTok = u.output_tokens ?? null;
    const PRICE_BANDS = [
        { label: 'DeepSeek-V3 官价（缓存未命中）', inUsdPerM: 0.27, outUsdPerM: 1.10 },
        { label: 'DeepSeek-V3.1 官价（缓存未命中）', inUsdPerM: 0.56, outUsdPerM: 1.68 },
        { label: '低价档参考（$0.14 / $0.28）', inUsdPerM: 0.14, outUsdPerM: 0.28 },
    ];
    out.costEstimate = {
        assumption: '代理未公开价目表，模型 id 是代理自定义的 deepseek-v4.1-flash。'
            + '下面不是结算金额，只把**实测 token 数**代入几个公开参考档位，给出量级。',
        measuredTokens: { input: inTok, output: outTok, total: (inTok ?? 0) + (outTok ?? 0) },
        bands: (inTok === null && outTok === null) ? [] : PRICE_BANDS.map((b) => ({
            label: b.label,
            usd: Number((((inTok ?? 0) / 1e6) * b.inUsdPerM + ((outTok ?? 0) / 1e6) * b.outUsdPerM).toFixed(8)),
        })),
        verdict: '一次最小请求的费用量级是 1e-5 ~ 1e-4 美元（即"不足一分钱的百分之一"）',
    };

    out.verdict = {
        // ⚠️ 不要用 netLog 判"通/不通"：@anthropic-ai/sdk@0.17.2 走自己的 transport shim，
        //    **不经过 globalThis.fetch** ⇒ netLog 可能为 0（那不是"没发请求"，是拦截器失效）。
        //    真正可靠的判据是"适配器是否返回了非失败标记的内容 + usage 是否记到账"。
        //    （T6/live-a-result.json 就是修补前那一版脚本跑出来的，里面的 httpRequests=0 属此假值，
        //      正确推导见 T6/analyze-live-a.mjs → live-a-analysis.json。）
        connectivity: out.result.isFailedReply
            ? '不通（适配器返回失败标记）'
            : `通（适配器返回 ${out.result.adapterReturnedLength} 字符真实内容；usage 记账见 usageAccounting）`,
        requestsIssuedMeasuredByInterceptor: netLog.length,
        interceptorReliable: netLog.length > 0,
        requestCountStructural: 1, // claude.js 无 turns.slice(1) 递归
        doubleRequestObserved: netLog.length > 1,
        truncationHandling: out.result.markedTruncated ? '已打截断标记'
            : (out.result.parsed?.stop_reason ? `未打标记（stop_reason=${out.result.parsed.stop_reason}）` : '无法判断（响应体未捕获）'),
    };
} catch (err) {
    out.error = { message: mask(String(err?.message ?? err)), name: err?.name, code: err?.code, status: err?.status };
    out.netLogSoFar = netLog;
    out.verdict = { connectivity: '失败（见 error）', requestsIssued: netLog.length };
}

const outPath = path.join(HERE, 'live-a-result.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

console.log('════ A：走项目模型层的真实最小请求 ════');
console.log(`供应商   : ${profile.url}`);
console.log(`模型     : ${profile.model}  (api=${profile.api})`);
console.log(`key      : ${keyMasked}`);
console.log(`实例     : ${JSON.stringify(out.instance)}`);
console.log('');
if (out.error) {
    console.log(`✗ 失败: ${out.error.name} ${out.error.code ?? ''} status=${out.error.status ?? '-'}`);
    console.log(`  ${out.error.message}`);
} else {
    const r = out.result;
    console.log(`HTTP 状态: ${r.httpStatus}   实际请求次数: ${r.httpRequests}   wall-clock: ${r.wallClockMs} ms`);
    console.log(`usage    : input=${r.parsed?.usage?.input_tokens} output=${r.parsed?.usage?.output_tokens} stop_reason=${r.parsed?.stop_reason}`);
    console.log(`适配器返回: (len=${r.adapterReturnedLength}) ${r.adapterReturned}`);
    console.log(`记账      : ${out.usageAccounting.sinkLines.join(' | ')}`);
    console.log(`费用量级  : ${out.costEstimate.verdict}`);
    console.log(`判定      : ${out.verdict.connectivity} / 请求 ${out.verdict.requestsIssued} 次 / 截断处理: ${out.verdict.truncationHandling}`);
}
console.log(`\n已写出: ${outPath}`);
