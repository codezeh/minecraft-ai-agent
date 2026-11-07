#!/usr/bin/env node
/**
 * T6 / C（MOD-006）+ 传输层取证 —— **零 token** 出网探测。
 *
 * 三件事：
 *  1. `GET /v1/models`（免费、不产生输出 token）：把"HTTP 200 + 模型清单"变成自己采的原文，
 *     而不是只依赖上游转述。
 *  2. MOD-006 对照实验（打**不可达端点**，不经过任何模型）：
 *       a) 裸 `await fetch(...)`            → 是否真无总超时（缺陷原貌基线）
 *       b) `fetchWithDeadline(..., 3s)`     → 是否按总期限中止并给出 code=LLM_TIMEOUT
 *       c) 真实 Ollama 适配器 `send()`       → 产品路径是否真的被打断（params.timeoutMs=3000）
 *  3. 确认 `DEFAULT_LLM_TIMEOUT_MS` 的默认值（未配 timeoutMs 时的兜底）。
 *
 * 不可达端点选 RFC 5737 TEST-NET-1（192.0.2.0/24，保证不被公网路由）。
 * 若本机对这个地址**快速**返回 EHOSTUNREACH（而非挂住），脚本会如实记录"快速失败"，
 * 并自动改用 10.255.255.1 再试一次 —— 绝不假装"挂住了"。
 *
 * 出网：1 次 HTTPS GET（免费）+ 若干次**本机不可达地址**的 TCP 尝试（0 token）。
 *
 * 用法：node docs/真机-20261106/T6/probe-mod006.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.MC_REPO || path.join(HERE, '..', '..', '..', 'mindcraft'));
const load = (p) => import(pathToFileURL(p).href);

const keysRaw = JSON.parse(fs.readFileSync(path.join(REPO, 'keys.json'), 'utf8'));
const RAW_KEY = keysRaw.ANTHROPIC_API_KEY || '';
const mask = (s) => (RAW_KEY && typeof s === 'string') ? s.split(RAW_KEY).join('<KEY-MASKED>') : s;

const out = {
    tool: 'T6/probe-mod006.mjs',
    generatedAt: new Date().toISOString(),
    note: '零 token 探测：GET /v1/models 免费；MOD-006 打的是不可达地址，不经过任何模型',
};

const { fetchWithDeadline, DEFAULT_LLM_TIMEOUT_MS } = await load(path.join(REPO, 'src/models/_shared.js'));
out.defaultLlmTimeoutMs = DEFAULT_LLM_TIMEOUT_MS;

// ── 1. GET /v1/models（免费）─────────────────────────────────
try {
    const t0 = Date.now();
    const res = await fetch('https://api.llmgo.net/v1/models', {
        method: 'GET',
        headers: { 'x-api-key': RAW_KEY },
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    let ids = [];
    try { ids = (JSON.parse(text).data || []).map((m) => m.id); } catch { /* 非 JSON */ }
    out.modelsEndpoint = {
        url: 'https://api.llmgo.net/v1/models',
        method: 'GET',
        httpStatus: res.status,
        ok: res.ok,
        ms,
        modelIds: ids,
        rawBodyMasked: mask(text.length > 2000 ? text.slice(0, 2000) + '…' : text),
        tokensBurned: 0,
    };
} catch (e) {
    out.modelsEndpoint = { error: mask(String(e?.message ?? e)), tokensBurned: 0 };
}

// ── 2. MOD-006 对照实验 ──────────────────────────────────────
const CANDIDATES = [
    'http://192.0.2.1:81/',          // TEST-NET-1
    'http://10.255.255.1:81/',       // 私网黑洞
];
const DEADLINE_MS = 3000;
const OBSERVE_MS = 8000;             // 裸 fetch 最多盯 8s，用来证明"8s 时仍未结束"

/** 判断是否"快速失败"（连接被直接拒绝/不可达），而不是挂住。 */
function isFastFail(err) {
    const s = String(err?.code || err?.message || err);
    return /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|400|404/i.test(s);
}

async function bareFetchProbe(url) {
    const ctrl = new AbortController();
    const t0 = Date.now();
    let outcome = null;
    const race = await Promise.race([
        (async () => {
            try { await fetch(url, { signal: ctrl.signal }); return { settled: 'resolved' }; }
            catch (e) { return { settled: 'rejected', code: e?.code, name: e?.name, message: String(e?.message ?? e) }; }
        })(),
        new Promise((r) => setTimeout(() => r({ settled: 'STILL-PENDING' }), OBSERVE_MS)),
    ]);
    const elapsed = Date.now() - t0;
    outcome = race;
    try { ctrl.abort(); } catch { /* 清理，别让请求挂着 */ }
    return { url, observeWindowMs: OBSERVE_MS, elapsedMs: elapsed, outcome };
}

async function deadlineProbe(url, timeoutMs) {
    const t0 = Date.now();
    try {
        await fetchWithDeadline(url, {}, { timeoutMs });
        return { url, timeoutMs, elapsedMs: Date.now() - t0, outcome: 'resolved（意外：应该超时）' };
    } catch (e) {
        return {
            url, timeoutMs, elapsedMs: Date.now() - t0,
            outcome: 'rejected',
            name: e?.name, code: e?.code, message: String(e?.message ?? e),
            isAbortError: e?.name === 'AbortError',
            codeIsLlmTimeout: e?.code === 'LLM_TIMEOUT',
        };
    }
}

const mod006 = { deadlineMs: DEADLINE_MS, observeWindowMs: OBSERVE_MS, candidates: [] };

for (const url of CANDIDATES) {
    const bare = await bareFetchProbe(url);
    const withDeadline = await deadlineProbe(url, DEADLINE_MS);
    mod006.candidates.push({ url, bareFetch: bare, fetchWithDeadline: withDeadline });

    // 只要有一个候选地址能"挂住"，就足够说明问题，不必再看第二个
    if (bare.outcome.settled === 'STILL-PENDING') break;
    if (bare.outcome.settled === 'rejected' && isFastFail(bare.outcome)) {
        // 快速失败 ⇒ 这个地址不适合演示"无总超时"，换下一个
        continue;
    }
    break;
}

// ── 3. 真实 Ollama 适配器路径（产品代码）───────────────────────
try {
    const { Ollama } = await load(path.join(REPO, 'src/models/ollama.js'));
    const probeUrl = mod006.candidates[mod006.candidates.length - 1].url.replace(/\/$/, '');
    const inst = new Ollama('test-model', probeUrl, { timeoutMs: DEADLINE_MS });
    const t0 = Date.now();
    let adapterOutcome;
    try {
        await inst.send('/api/chat', { model: 'test-model', messages: [{ role: 'user', content: 'x' }], stream: false });
        adapterOutcome = { settled: 'resolved（意外）', elapsedMs: Date.now() - t0 };
    } catch (e) {
        adapterOutcome = {
            settled: 'rejected',
            elapsedMs: Date.now() - t0,
            name: e?.name,
            code: e?.code,
            message: String(e?.message ?? e),
            codeIsLlmTimeout: e?.code === 'LLM_TIMEOUT',
        };
    }
    mod006.productPathOllamaAdapter = {
        url: probeUrl, timeoutMsConfigured: DEADLINE_MS, instanceTimeoutMs: inst.timeoutMs, ...adapterOutcome,
    };
} catch (e) {
    mod006.productPathOllamaAdapter = { error: mask(String(e?.message ?? e)) };
}

out.mod006 = mod006;

// ── 4. 判定 ─────────────────────────────────────────────────
const c0 = mod006.candidates[0];
const bareHangs = c0?.bareFetch?.outcome?.settled === 'STILL-PENDING';
const deadlineWorks = !!c0?.fetchWithDeadline?.codeIsLlmTimeout;
const productAborts = !!mod006.productPathOllamaAdapter?.codeIsLlmTimeout;

out.verdict = {
    modelsEndpointStatus: out.modelsEndpoint?.httpStatus ?? null,
    modelCount: out.modelsEndpoint?.modelIds?.length ?? 0,
    bareFetchHasNoBuiltinTimeout: bareHangs,
    bareFetchObservedPendingAtMs: bareHangs ? OBSERVE_MS : null,
    fetchWithDeadlineAborts: deadlineWorks,
    fetchWithDeadlineElapsedMs: c0?.fetchWithDeadline?.elapsedMs ?? null,
    productOllamaAdapterAborts: productAborts,
    productAdapterElapsedMs: mod006.productPathOllamaAdapter?.elapsedMs ?? null,
    defaultTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    summary: bareHangs && deadlineWorks && productAborts
        ? 'MOD-006 修复成立：裸 fetch 确实无内置总超时（8s 仍未结束），而 fetchWithDeadline 与真实 Ollama 适配器都在 ~3s 按 code=LLM_TIMEOUT 中止'
        : '需要人工复核（见 candidates 明细）',
};

const outPath = path.join(HERE, 'mod006-result.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

console.log('════ MOD-006 探测（0 token）════');
console.log(`GET /v1/models → HTTP ${out.verdict.modelsEndpointStatus}，模型数 ${out.verdict.modelCount}: ${(out.modelsEndpoint?.modelIds || []).join(', ')}`);
console.log('');
for (const c of mod006.candidates) {
    console.log(`端点 ${c.url}`);
    console.log(`  裸 fetch        : ${c.bareFetch.outcome.settled}${c.bareFetch.outcome.code ? ' (' + c.bareFetch.outcome.code + ')' : ''}  用时 ${c.bareFetch.elapsedMs}ms`);
    console.log(`  fetchWithDeadline: ${c.fetchWithDeadline.outcome} code=${c.fetchWithDeadline.code ?? '-'} 用时 ${c.fetchWithDeadline.elapsedMs}ms`);
}
console.log('');
console.log(`真实 Ollama 适配器 send(): ${mod006.productPathOllamaAdapter?.settled} code=${mod006.productPathOllamaAdapter?.code ?? '-'} 用时 ${mod006.productPathOllamaAdapter?.elapsedMs}ms`);
console.log(`DEFAULT_LLM_TIMEOUT_MS = ${DEFAULT_LLM_TIMEOUT_MS}`);
console.log('');
console.log(`判定: ${out.verdict.summary}`);
console.log(`\n已写出: ${outPath}`);
