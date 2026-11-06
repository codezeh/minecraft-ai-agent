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

// ── 输出截断 vs 上下文超限（MOD-001）───────────────────────────
// 缺陷原貌（报告实测 6 次请求全失败）：适配器把 `finish_reason === 'length'`
//   **当成"上下文超限"抛出去**，于是 catch 里 `turns.slice(1)` 递归 ——
//   可"输出额度用完了"和"输入太长"是两件不同的事：
//     · 输出被截断 → 缩短历史**完全无效**（错误不在输入侧），还会白删有用上下文；
//     · 输入超限   → 才该裁历史。
//   而且每递归一次就多花一次请求的钱（报告实测 6 次）。
//
// 这里只提供**可判别的标记**（不引入重试框架）：被截断的回复仍然交回给上层
// （她写了一半的话还是有用的），但带上明确标记，让上层知道"这不是完整回答"。
export const TRUNCATED_SUFFIX = '[LLM_TRUNCATED]';

/** 这条回复是不是"被输出额度截断"的（内容仍可用，但可能不完整）。 */
export function isTruncatedReply(text) {
    return typeof text === 'string' && text.endsWith(TRUNCATED_SUFFIX);
}

/** 给被截断的内容打标记（幂等：已经带标记就不重复加）。 */
export function markTruncated(text) {
    const s = typeof text === 'string' ? text : String(text ?? '');
    return isTruncatedReply(s) ? s : s + TRUNCATED_SUFFIX;
}

/**
 * 这次失败是不是**真的**上下文超限（MOD-001）。
 *
 * 只认供应商/网关明确表达的那几种；**不要把 finish_reason='length' 算进来**
 * （那是输出额度，不是输入超限）。判断顺序刻意从"结构化字段"到"文案"，
 * 且全程走 `errMessage()`（F-AI-101：err 可能不是 Error）。
 */
export function isContextLengthError(err) {
    if (!err) return false;
    const code = (typeof err.code === 'string') ? err.code.toLowerCase() : '';
    if (code === 'context_length_exceeded' || code === 'context_length_exceeded_error') return true;
    if (typeof err.type === 'string' && /context.?length/i.test(err.type)) return true;
    const msg = errMessage(err).toLowerCase();
    return /context[_ ]length|maximum context|too many tokens|prompt is too long/.test(msg);
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

/**
 * ★★★ MOD-006（2026-11-06 深度检查）：给裸 fetch 加**应用级总期限 + 取消信号**。
 *
 * 缺陷原貌：`ollama.js` / `hyperbolic.js` 直接 `await fetch(...)`，既没有总期限、
 *   也没有外部取消入口。请求或**响应体**卡住时调用方只能一直 await：
 *   · action 侧的超时管不到模型请求（两套时钟）；
 *   · 新消息丢弃旧结果时**并不会取消旧请求**（报告实测：仍需手动 reject 才结束）；
 *   · 费用/连接继续占着，进程里还可能留下定时器。
 *
 * 这里只做最小的一件事：**一次调用 = 一个明确的总期限**，把 AbortSignal 传下去，
 * 并在退出时**一定**清掉定时器（不留残留 timer）。不做重试抽象（那是另一层的事）。
 *
 * @param {string|URL|Request} input fetch 的第一个参数
 * @param {object} [init] fetch 的第二个参数（可带外部 signal）
 * @param {object} [opts]
 *   timeoutMs 总期限（毫秒），默认 DEFAULT_LLM_TIMEOUT_MS；<=0 表示不限
 *   onAbort   超时/取消时的回调（便于日志）
 * @returns {Promise<Response>} 与 fetch 同形；超时抛 AbortError（带 code='LLM_TIMEOUT'）
 */
export const DEFAULT_LLM_TIMEOUT_MS = 120000;

export async function fetchWithDeadline(input, init = {}, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : DEFAULT_LLM_TIMEOUT_MS;
    const outer = init?.signal ?? null;
    // 外部已经取消了就直接返回失败，不要白发请求
    if (outer?.aborted) throw makeAbort('外部信号已取消');

    const ctrl = new AbortController();
    let timer = null;
    let timedOut = false;
    const onOuterAbort = () => { try { ctrl.abort(); } catch { /* ignore */ } };
    if (outer) {
        try { outer.addEventListener('abort', onOuterAbort, { once: true }); } catch { /* 老实现没有 addEventListener */ }
    }
    if (timeoutMs > 0) {
        timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs);
    }
    try {
        return await fetch(input, { ...init, signal: ctrl.signal });
    } catch (err) {
        // 把"为什么被中断"讲清楚：超时 ≠ 用户取消 ≠ 网络错误
        if (timedOut) {
            try { opts.onAbort?.('timeout'); } catch { /* ignore */ }
            throw makeAbort(`模型请求超过总期限 ${timeoutMs}ms`);
        }
        if (outer?.aborted) {
            try { opts.onAbort?.('cancelled'); } catch { /* ignore */ }
            throw makeAbort('模型请求被取消');
        }
        throw err;
    } finally {
        // ★ 关键：无论成功/失败/超时都要清掉定时器，否则进程里留着挂起的 timer
        if (timer) { clearTimeout(timer); timer = null; }
        if (outer) {
            try { outer.removeEventListener('abort', onOuterAbort); } catch { /* ignore */ }
        }
    }
}

/** 造一个"请求被期限/取消终止"的错误（`code=LLM_TIMEOUT` 便于上层判别）。 */
function makeAbort(message) {
    const err = new Error(message);
    err.name = 'AbortError';
    err.code = 'LLM_TIMEOUT';
    return err;
}

// ── 错误日志的安全形状（F-SEC-102）─────────────────────────────
// why：原来 19 处直接把**整个 error 对象**交给日志，而 SDK 抛出的 error 上常挂着
// request / response / config / headers（含 Authorization、中转站 key、完整 prompt）。
// 而 `logs/` 正是"出问题发给别人看"的东西
// （scripts/start-panel.ps1 把 mindcraft 的 stdout 重定向进 logs/mindcraft-console.log）。
// 今晚已因日志/文件落凭据出过三次事故，所以这里**只允许打标量字段**。
const MAX_ERR_MSG = 300;

/**
 * 把 error 收敛成**一行、只含标量、可安全写日志**的字符串。
 *
 * 绝不返回对象、绝不 JSON.stringify(error)：那两种都会把挂在 error 上的
 * request/response/headers 一起带出去。
 *
 * 形状：`[llm-error] status=429 code=rate_limit tag=xxx <message 截断 300 字>`
 * （没有对应字段就省略那一段；message 非字符串时安全转字符串）
 *
 * @param {unknown} err 抛出来的任何东西（Error / 字符串 / 对象 / null）
 * @param {string} [tag] 可选标签，区分来源（如 'vision'）
 * @returns {string}
 */
export function safeErrText(err, tag) {
    if (err === null || err === undefined) return `[llm-error]${tag ? ' tag=' + tag : ''} <null>`;
    // 只取标量：status / statusCode / code。**不要**碰 err.request / err.response / err.body / err.config。
    const status = err.status ?? err.statusCode;
    const code = (typeof err.code === 'string' || typeof err.code === 'number') ? err.code : null;
    // message 依次退化：err 本身是字符串 → err.message → err.error.message → String(err)
    // （对象 String() 得到 "[object Object]"，不泄漏字段内容）
    const rawMsg = typeof err === 'string' ? err
        : (typeof err.message === 'string' ? err.message
            : (typeof err.error?.message === 'string' ? err.error.message : String(err)));
    const msg = rawMsg.length > MAX_ERR_MSG ? rawMsg.slice(0, MAX_ERR_MSG) + '…' : rawMsg;
    const parts = ['[llm-error]'];
    if (status !== undefined && status !== null) parts.push(`status=${status}`);
    if (code !== null) parts.push(`code=${code}`);
    if (tag) parts.push(`tag=${tag}`);
    parts.push(msg);
    return parts.join(' ');
}

/**
 * 安全取 error 的 message **字符串**（F-AI-101）。
 *
 * 为什么需要：8 处写成 `err.message.includes(...)` / `err.message.toLowerCase().includes(...)`，
 * 而这段在**错误处理路径**上——`err` 是字符串 / 对象 / null 时（中转站、网关、裸 fetch 都可能）
 * 直接 TypeError，把真正的错误掩盖成 TypeError。
 *
 * @param {unknown} err
 * @returns {string} 永远是字符串（取不到就是 ''）
 */
export function errMessage(err) {
    if (err === null || err === undefined) return '';
    if (typeof err === 'string') return err;
    if (typeof err.message === 'string') return err.message;
    if (typeof err.error?.message === 'string') return err.error.message;
    return String(err);
}

