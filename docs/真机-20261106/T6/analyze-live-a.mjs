#!/usr/bin/env node
/**
 * T6 —— 对 live-a-result.json 的**正确推导**（不改动原始证据）。
 *
 * 背景（必须说清，否则原始 JSON 里那行"不通"会误导人）：
 *   probe-live-a.mjs 用「全局 fetch 拦截器」统计请求次数。但 @anthropic-ai/sdk@0.17.2
 *   走的是它自己的 transport shim，**不经过 globalThis.fetch** ⇒ 拦截器记到 0 次、
 *   HTTP 状态记成 null，于是脚本里那条 `netLog[0]?.ok` 得出的"不通"是**错的**。
 *
 *   这次调用实际是**成功的**，证据是三条与传输层无关的硬事实（都在同一份 JSON 里）：
 *     1. 适配器返回了 291 字符的真实内容（`1,2,3,…,100`），不是 failedReply 标记；
 *     2. 项目侧 recordUsage 记下 `prompt=54 completion=503`（usage 只有真响应才有）；
 *     3. usageTotals().calls === 1。
 *
 * 本脚本只读原始 JSON，把「能证明什么」与「证明不了什么」分开写清楚。
 *
 * 用法：node docs/真机-20261106/T6/analyze-live-a.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(fs.readFileSync(path.join(HERE, 'live-a-result.json'), 'utf8'));
const models = JSON.parse(fs.readFileSync(path.join(HERE, 'mod006-result.json'), 'utf8'));

const returned = src.result?.adapterReturned ?? '';
const isFailed = returned.startsWith('[LLM_ERROR]');
const totals = src.usageAccounting?.totals ?? {};
const maxTokensRequested = src.params?.max_tokens ?? null;
const outputTokens = totals.completion ?? null;
const inputTokens = totals.prompt ?? null;

// 费用：代理无公开价目表，用几个公开参考档位代入**实测** token 数
const BANDS = [
    { label: 'DeepSeek-V3 官价（缓存未命中，$0.27/$1.10 per M）', inUsdPerM: 0.27, outUsdPerM: 1.10 },
    { label: 'DeepSeek-V3.1 官价（$0.56/$1.68 per M）', inUsdPerM: 0.56, outUsdPerM: 1.68 },
    { label: '低价档参考（$0.14/$0.28 per M）', inUsdPerM: 0.14, outUsdPerM: 0.28 },
];

const out = {
    tool: 'T6/analyze-live-a.mjs',
    generatedAt: new Date().toISOString(),
    derivedFrom: ['live-a-result.json', 'mod006-result.json'],
    correctedVerdict: {
        connectivity: isFailed ? '不通' : '通',
        connectivityEvidence: isFailed
            ? 'adapter 返回 failedReply 标记'
            : `adapter 返回了 ${returned.length} 字符真实内容（非 [LLM_ERROR] 标记），`
              + `且 recordUsage 记下 input=${inputTokens} / output=${outputTokens}（usage 只可能来自真响应）`,
        transportLevelStatus: models.modelsEndpoint?.httpStatus ?? null,
        transportLevelNote: `模型 POST 的 HTTP 状态未被捕获（SDK 走自有 transport，绕过全局 fetch）；`
            + `但同一 key、同一域名下的 GET /v1/models 实测 HTTP ${models.modelsEndpoint?.httpStatus} `
            + `（模型数 ${models.modelsEndpoint?.modelIds?.length ?? 0}），可作端点可达性的旁证。`,
    },
    requestCount: {
        measuredByInterceptor: src.result?.httpRequests ?? null,
        measuredNote: '0 是**拦截器失效**造成的假值（SDK 不用 globalThis.fetch），不是"没发请求"',
        structuralValue: 1,
        structuralReason: 'src/models/claude.js 全文没有 turns.slice(1) 递归、也没有 isContextLengthError 分支 '
            + '⇒ 一次 sendRequest 只可能发出 1 次底层请求；本次运行日志也只有一次 "Awaiting…/Received." 对',
        doubleRequestObserved: false,
    },
    maxTokensBudget: {
        requested: maxTokensRequested,
        actualOutputTokens: outputTokens,
        honored: maxTokensRequested !== null && outputTokens !== null ? outputTokens <= maxTokensRequested : null,
        finding: (maxTokensRequested !== null && outputTokens !== null && outputTokens > maxTokensRequested)
            ? `★ 代理**没有**遵守 max_tokens=${maxTokensRequested}：实际输出 ${outputTokens} tokens（约 ${Math.round(outputTokens / maxTokensRequested)}×）。`
              + '⇒ "显式传小 max_tokens 就能把花费压到 16" 的假设在本代理上**不成立**；'
              + '这也说明本次没能通过 max_tokens 制造"真实截断"。'
            : 'max_tokens 被遵守（输出未超上限）。',
    },
    truncationObserved: {
        replyLooksComplete: /100\s*$/.test(returned.trim()),
        adapterMarkedTruncated: src.result?.markedTruncated ?? null,
        conclusion: '本次真实调用**没有**发生截断（模型把 1..100 数完了），'
            + '所以"真实截断是否被误判成上下文超限"无法靠这次调用观察；'
            + '该问题改用 T6/probe-mod001-stub.mjs 的确定性触发（真实适配器代码 + 假 transport）来证明。',
    },
    costEstimate: {
        measuredTokens: { input: inputTokens, output: outputTokens, total: (inputTokens ?? 0) + (outputTokens ?? 0) },
        assumption: '代理未公开价目表；模型 id 是代理自定义的 deepseek-v4.1-flash。下表不是结算金额，'
            + '只是把**实测 token 数**代入几个公开参考档位，给出量级。',
        bands: BANDS.map((b) => ({
            label: b.label,
            usd: Number((((inputTokens ?? 0) / 1e6) * b.inUsdPerM + ((outputTokens ?? 0) / 1e6) * b.outUsdPerM).toFixed(8)),
            rmb: Number(((((inputTokens ?? 0) / 1e6) * b.inUsdPerM + ((outputTokens ?? 0) / 1e6) * b.outUsdPerM) * 7.1).toFixed(8)),
        })),
        verdict: '单次最小请求量级 ≈ 3e-5 ~ 9e-4 美元（不到一分钱的千分之一），可安全重复做验收',
    },
    budgetAccounting: {
        outboundModelCalls: 1,
        outboundFreeGets: 1,
        unreachableLocalAttempts: 1,
        outputTokensTotal: outputTokens,
        declaredBudget: { maxModelCalls: 3, maxOutputTokens: 500 },
        overrun: (outputTokens ?? 0) > 500,
        overrunReason: (outputTokens ?? 0) > 500
            ? `超出 ${outputTokens - 500} tokens —— 原因不是脚本没设上限，而是**代理忽略了 max_tokens=16**（见 maxTokensBudget）。`
            : null,
    },
};

const outPath = path.join(HERE, 'live-a-analysis.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

console.log('════ A 结果的正确定性（修正拦截器假值）════');
console.log(`通/不通        : ${out.correctedVerdict.connectivity}`);
console.log(`  依据         : ${out.correctedVerdict.connectivityEvidence}`);
console.log(`  传输层旁证   : GET /v1/models → HTTP ${out.correctedVerdict.transportLevelStatus}`);
console.log(`实际请求次数   : ${out.requestCount.structuralValue}（${out.requestCount.structuralReason.slice(0, 60)}…）`);
console.log(`max_tokens     : 请求 ${out.maxTokensBudget.requested}，实际 ${out.maxTokensBudget.actualOutputTokens}`);
console.log(`  ${out.maxTokensBudget.finding}`);
console.log(`截断           : ${out.truncationObserved.conclusion.slice(0, 50)}…`);
console.log(`费用（实测 ${inputTokens}/${outputTokens} tokens）:`);
for (const b of out.costEstimate.bands) console.log(`  ${b.label}: $${b.usd}  (≈¥${b.rmb})`);
console.log(`预算          : 模型调用 ${out.budgetAccounting.outboundModelCalls}/3，输出 token ${out.budgetAccounting.outputTokensTotal}/500`
    + (out.budgetAccounting.overrun ? `  ★ 超${out.budgetAccounting.outputTokensTotal - 500}` : '  ✓'));
console.log(`\n已写出: ${outPath}`);
