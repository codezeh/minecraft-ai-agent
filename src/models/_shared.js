/**
 * 模型层共享契约：**失败标记** + **用量 sink**（第一轮审查 第 31 条）。
 *
 * 缺陷原貌（两件互为因果）：
 *  1. 17 处 `catch { res = '（一句模拟断线的假台词）' }` 后 `return res`。
 *     `sendRequest` 的契约是 `Promise<string>`、**没有 ok/code 通道**，于是 prompter 拿到的
 *     "回答"与一次真实模型输出**同形**：会写进 history、真的对玩家说出来、并消费一次 response 预算。
 *     ⇒ 模型层每一次故障都被记成"模型说了句话"。
 *  2. 19 个适配器只取 `choices[0].message.content`，没有一个读 `usage`
 *     ⇒ 花了多少 token、成本多少，结构上永远算不出来。
 *
 * 本文件只做两件最小的事，**不做重试抽象**（那是第三批）：
 *  - `FAILED_REPLY` / `failedReply(reason)` / `isFailedReply(text)`：把失败变成可判别的标记；
 *  - `recordUsage(usage, model, tag)`：一行 sink（`[llm] model=… prompt=… completion=…`）+ 进程内累计。
 *
 * **适配器契约（本任务起统一）**：`sendRequest()` **永不抛** —— 成功返回模型内容，
 * 失败返回 `failedReply(原因)`。为什么必须统一：`prompter` 的 `promptCoding` /
 * `promptMemSaving` / `promptShouldRespondToBot` 都**没有** try/catch，
 * 适配器一抛就是 coder / history / conversation 三个调用方真崩（gemini 原来就是裸的，本次补上）。
 *
 * 单测：tools/llm_usage_unit.mjs（用 setUsageSink 换成收集器，不靠抓 console）。
 */

/** 失败标记前缀。约定：`sendRequest` 返回以它开头的串 = **这次调用失败了**，不是模型说的话。 */
export const FAILED_REPLY = '[LLM_ERROR]';

/** 造一条失败回复（保留原因，便于日志/排查）。 */
export function failedReply(reason) {
    return `${FAILED_REPLY} ${String(reason ?? 'unknown')}`;
}

/** 这条回复是不是失败标记。 */
export function isFailedReply(text) {
    return typeof text === 'string' && text.startsWith(FAILED_REPLY);
}

// ── usage sink ─────────────────────────────────────────────
// 只有「取到 usage」才算得出成本；某些供应商/本地模型不回 usage，那就记 `-`，别假装是 0。
const totals = { calls: 0, prompt: 0, completion: 0, missing: 0 };

let sink = (line) => console.log(line);

/** 测试/上层可换掉 sink（传 null 则只累计、不打印）。 */
export function setUsageSink(fn) {
    sink = typeof fn === 'function' ? fn : null;
}

/** 累计量快照（成本核算/单测用）。 */
export function usageTotals() {
    return { ...totals };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 记一次模型调用的用量。
 * 兼容各家形状：OpenAI(`prompt_tokens`/`completion_tokens`)、Anthropic(`input_tokens`/`output_tokens`)、
 * Ollama(`prompt_eval_count`/`eval_count`)、Gemini(`promptTokenCount`/`candidatesTokenCount`)、
 * Mistral(`promptTokens`/`completionTokens`)。
 * @param {object|null} usage 供应商返回的 usage 对象（拿不到就传 null/undefined）
 * @param {string} model 模型名
 * @param {string} [tag] 可选标签（如 'vision'/'stream'），便于按用途分账
 * @returns {string} 写到日志里的那一行
 */
export function recordUsage(usage, model, tag) {
    const p = num(usage?.prompt_tokens) ?? num(usage?.input_tokens) ?? num(usage?.prompt_eval_count)
        ?? num(usage?.promptTokenCount) ?? num(usage?.promptTokens);
    const c = num(usage?.completion_tokens) ?? num(usage?.output_tokens) ?? num(usage?.eval_count)
        ?? num(usage?.candidatesTokenCount) ?? num(usage?.completionTokens);
    totals.calls++;
    if (p === null && c === null) totals.missing++;
    else { totals.prompt += p ?? 0; totals.completion += c ?? 0; }
    const line = `[llm] model=${model || '?'} prompt=${p ?? '-'} completion=${c ?? '-'}${tag ? ` tag=${tag}` : ''}`;
    if (sink) sink(line);
    return line;
}

// ── 429 判据（三个走裸 fetch / 简单封装的适配器共用）────────────
// 为什么需要：openai / anthropic SDK 那层自带 429 重试，而 hyperbolic / ollama / replicate
// 是自己发请求的，撞到 429 就直接把失败当回答返回了（第31条 第3点）。
// 别在这里写重试框架 —— 第三批才做统一的 withRetry。
const RATE_LIMIT_RE = /429|rate.?limit|too many requests/i;

/** 这次失败是不是「被限流」（看 HTTP 状态或错误消息）。 */
export function isRateLimit(errOrResponse) {
    if (!errOrResponse) return false;
    if (errOrResponse.status === 429 || errOrResponse.statusCode === 429) return true;
    return RATE_LIMIT_RE.test(String(errOrResponse.message ?? errOrResponse));
}

/** 指数退避的等待毫秒数（attempt 从 1 开始），上限 30s；带抖动避免多路同时重试。 */
export function rateLimitDelayMs(attempt) {
    const base = Math.min(30000, 1000 * Math.pow(2, Math.max(0, (attempt || 1) - 1)));
    return base + Math.floor(Math.random() * 250);
}

