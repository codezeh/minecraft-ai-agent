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
 * ★★ 2026-11-07 复审（第3B条）：把内部截断标记**从展示文本里剥掉**，同时保留结构化的"是否截断"。
 *
 * 缺陷原貌：`markTruncated()` 直接把 `[LLM_TRUNCATED]` 追加到正文末尾，但**没有任何消费端**
 *   调用 `isTruncatedReply()`（全仓 0 处调用）。于是它会一路进到 `promptConvo()` 的返回值 →
 *   聊天历史 → `routeResponse()` → **玩家真的看到 "[LLM_TRUNCATED]" 这几个字**。
 *
 * 修法：标记是**内部诊断信号**，不是对话内容。在对话边界剥离，并把 `truncated` 作为
 *   独立字段交给调用方（打日志/做降级决策），正文里不留痕迹。
 *
 * @param {string} text 可能带标记的文本
 * @returns {{text: string, truncated: boolean}} 剥离后的正文 + 是否曾被截断
 */
export function stripTruncatedMark(text) {
    const s = typeof text === 'string' ? text : String(text ?? '');
    if (!isTruncatedReply(s)) return { text: s, truncated: false };
    return { text: s.slice(0, -TRUNCATED_SUFFIX.length), truncated: true };
}

// ── 「这一轮没有可执行代码」信号（第四轮复审 H2：截断假成功）──────
// 缺陷原貌（已实测复现）：`promptCoding` 在「代码被输出额度截断」时返回
//   `'```//no response (truncated)```'`。这个兜底串**自带三反引号**，而 coder.js 的判据正是
//   `res.indexOf('```') !== -1` ⇒ 判成「有代码」；再 `substring(第一个```+3, 最后一个```)`
//   就抽出 `//no response (truncated)` 这**一行注释**当代码执行。
//   它跑得通、不抛错，于是 coder.js 返回 `Agent wrote this code: … Code finished.` ——
//   **一次截断 = 一次什么都没做却记账成功的动作**；而且注释行里没有 `;\n`，
//   `_stageCode` 的 `interrupt_code` 注入点一个都没命中 ⇒ 连取消都拦不住它。
//
// 修法（双保险，两处缺一不可）：
//   ① 生产端：`promptCoding` 的「没代码」信号改成**不含反引号**的 `noCodeReply(原因)`；
//   ② 消费端：`coder.js` 抽码前先 `isNoCodeReply()` 显式判掉 —— 判据**不再依赖反引号**这个
//      弱假设，将来谁把兜底串改回带反引号的形状也不会被当代码执行。
export const NO_CODE_PREFIX = '[NO_CODE]';

/** 造一条「这一轮没有可执行代码」的信号（保留原因，便于日志排查）。 */
export function noCodeReply(reason) {
    return `${NO_CODE_PREFIX} no response${reason ? ` (${String(reason)})` : ''}`;
}

/** 这条回复是不是「没有可执行代码」的信号。 */
export function isNoCodeReply(text) {
    return typeof text === 'string' && text.startsWith(NO_CODE_PREFIX);
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
    const n = normalizeUsage(usage);
    totals.calls++;
    if (!n) totals.missing++;
    else { totals.prompt += n.prompt ?? 0; totals.completion += n.completion ?? 0; }
    const line = `[llm] model=${model || '?'} prompt=${n?.prompt ?? '-'} completion=${n?.completion ?? '-'}${tag ? ` tag=${tag}` : ''}`;
    if (sink) sink(line);
    return line;
}

/**
 * 把各家的 usage 形状收敛成 `{prompt, completion, missing}`（结果类型的 `usage` 字段用它）。
 * 拿不到任何一项时返回 **null** —— 「不知道」和「零消耗」必须是两件事。
 * @param {object|null} usage
 * @returns {{prompt:number|null, completion:number|null, missing:boolean}|null}
 */
export function normalizeUsage(usage) {
    const p = num(usage?.prompt_tokens) ?? num(usage?.input_tokens) ?? num(usage?.prompt_eval_count)
        ?? num(usage?.promptTokenCount) ?? num(usage?.promptTokens);
    const c = num(usage?.completion_tokens) ?? num(usage?.output_tokens) ?? num(usage?.eval_count)
        ?? num(usage?.candidatesTokenCount) ?? num(usage?.completionTokens);
    if (p === null && c === null) return null;
    return { prompt: p, completion: c, missing: p === null || c === null };
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
 *   parse     可选。传了它，期限的作用域就**延伸到响应体读完**：
 *             `parse(res)` 在本函数内部 await，之后才清 timer / 摘 abort listener。
 *             典型用法：`parse: async (res) => { if (!res.ok) throw ...; return res.json(); }`
 * @returns {Promise<Response|any>} 没传 parse 时与 fetch 同形；传了则返回 parse 的返回值。
 *          超时抛 AbortError（带 code='LLM_TIMEOUT'）
 */
export const DEFAULT_LLM_TIMEOUT_MS = 120000;

// ── SDK 适配器的单次调用上限（第四轮复审 H3）────────────────────
// 缺陷原貌：`new OpenAIApi(config)` / `new Anthropic(config)` 只传了 baseURL/apiKey，
//   于是吃 SDK **默认值** `timeout=600000` + `maxRetries=2`，而且 `openai/core.js:325-330`
//   把**超时（AbortError）也算进重试范围** ⇒ 一次对话调用最坏 3×600s = **30 分钟**。
//   这段时间里 `!stop` / 面板停止 / action_manager 的 10 分钟动作超时**全都拦不住它**，
//   唯一兜底是杀进程重启（僵尸看门狗）。第四轮复审还发现 19 个适配器的期限是**四档并存**
//   （600s×11 / 60s×2 / 120s×2 / 无×3）—— 同样是"没人显式写过"的结果。
// 修法：每个 SDK 适配器**显式**写死这两个值，不依赖 SDK 默认值（默认值会随版本变）。
//   上限 120s 与裸 fetch 那条路（DEFAULT_LLM_TIMEOUT_MS）对齐，重试 ≤1（最坏 2×120s）。
export const LLM_MAX_CALL_MS = 120000;
export const LLM_MAX_RETRIES = 1;

/**
 * 给「只能传 signal、没有 timeout 选项」的 SDK（huggingface / replicate 的流式接口）
 * 造一个**单次调用总期限**。
 *
 * 为什么不直接用 `AbortSignal.timeout()`：那样拿不到「为什么被中断」的信息，
 * 清理动作也不可见。这里返回显式句柄，调用方在 `finally` 里 `cancel()`，
 * 定时器一定被清掉（timer 同时 unref，进程不会因为它挂着）。
 *
 * @param {number} [timeoutMs] 期限（毫秒），默认 LLM_MAX_CALL_MS
 * @param {Function} [onTimeout] 超时时的回调（打日志用）
 * @returns {{signal: AbortSignal, cancel: () => void}}
 */
/**
 * 把 prompter 下传的 `callOpts`（第 4 参）映射成 **SDK 的 per-call 请求选项**（t19）。
 *
 * 为什么要这层映射而不是每个适配器自己拼：各家字段名不同（OpenAI/Groq/Cerebras 用
 * `timeout`，Mistral 用 `timeoutMs`，Anthropic/OpenAI 的 `signal` 一致），但**语义只有一套**：
 * 「这一次调用」取消信号 + 期限。per-call 选项会覆盖构造期默认值（t1 设的 120s/1 次重试），
 * 所以调用方给的更短 deadline 以调用方为准。
 *
 * 同时给出 `timeout` 与 `timeoutMs` 两个键：OpenAI 系只认前者、Mistral 只认后者，
 * 各自会忽略不认识的键（属于 RequestOptions 的宽松形状）。
 *
 * @param {{signal?:AbortSignal|null, timeoutMs?:number|null}} [opts]
 * @returns {{signal?:AbortSignal, timeout?:number, timeoutMs?:number}}
 */
export function sdkCallOptions(opts) {
    const out = {};
    if (opts?.signal) out.signal = opts.signal;
    const ms = Number(opts?.timeoutMs);
    if (Number.isFinite(ms) && ms > 0) {
        out.timeout = ms;
        out.timeoutMs = ms;
    }
    return out;
}

/**
 * 合并多个取消信号（t19）：外部取消（面板停止 / 动作超时）+ 本适配器自己的期限。
 * 优先 `AbortSignal.any`（Node 20+ 原生），否则手工桥接（任一 abort 就 abort）。
 * @param {...(AbortSignal|null|undefined)} signals
 * @returns {AbortSignal|null}
 */
export function combineSignals(...signals) {
    const list = signals.filter((s) => s && typeof s.aborted === 'boolean');
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
    const ctrl = new AbortController();
    const kill = () => { try { ctrl.abort(); } catch { /* ignore */ } };
    for (const s of list) {
        if (s.aborted) { kill(); break; }
        try { s.addEventListener('abort', kill, { once: true }); } catch { /* ignore */ }
    }
    return ctrl.signal;
}

export function callDeadlineSignal(timeoutMs = LLM_MAX_CALL_MS, onTimeout) {
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Number(timeoutMs) : LLM_MAX_CALL_MS;
    const ctrl = new AbortController();
    let timer = setTimeout(() => {
        try { onTimeout?.(); } catch { /* ignore */ }
        try { ctrl.abort(); } catch { /* ignore */ }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return {
        signal: ctrl.signal,
        cancel: () => { if (timer) { clearTimeout(timer); timer = null; } },
    };
}

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
        const res = await fetch(input, { ...init, signal: ctrl.signal });
        // ★★ 2026-11-07 复审（第2条）：期限必须覆盖**响应体读取**。
        //   原来这里直接 `return res`：`fetch` 只等到响应头就 resolve，`finally` 立刻清掉 timer，
        //   调用方随后的 `res.json()` 完全不受期限约束 —— 服务端发完头却不发 body 时，
        //   应用级总期限形同虚设（复审实测：期限 35ms，body 150ms 才完成，仍一路等到 150ms）。
        //   传了 `parse` 就把读体也放进本作用域：timer 与 abort listener 要等 body 读完才清。
        if (typeof opts.parse === 'function') return await opts.parse(res);
        return res;
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

