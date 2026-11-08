/**
 * ★★★ 第四轮复审 架构收敛项(1) —— 模型调用返回值**类型化**（A5 §3）。
 *
 * 缺陷原貌：一次模型调用的返回值就是一根 `string`，三（四）种语义挤在同一条串上 ——
 *   · 正常内容            `"正文"`
 *   · 失败                `"[LLM_ERROR] <原因>"`（`startsWith` 判）
 *   · 输出被截断          `"正文[LLM_TRUNCATED]"`（`endsWith` 判）
 *   · 空成功 / 失败被吞 / 被新消息取代而丢弃   **都是 `""`，不可区分**
 *   ⇒ 失败率、截断率、丢弃率都不可度量；「剥标记」这种补救成了必需；玩家说一句
 *      `[LLM_ERROR]` 就能把整轮打成静默丢弃（in-band 判据的固有缺陷）。
 *
 * 本文件把边界划在**适配器返回值这一层**：调用方从此读 `status` / `errorCode` /
 * `usage` / `elapsedMs` / `attempts` 这些字段，而不是在字符串里找暗号。
 * `content` 的**不变量**：只放"能给人看、能进 history"的正文，**永不含内部标记**
 * （`assertModelResult()` 就是这条不变量的执行者）。
 *
 * 兼容策略（A5 §3.3 步 0/1）：`toString()`/`valueOf()` 让老调用点（`=== 'text'`、
 * `String(x)`、日志插值）在迁移期照旧可用，且**重现旧的标记语义**（失败/截断分别
 * 变回 `[LLM_ERROR] …` / `正文[LLM_TRUNCATED]`），所以新旧代码可以共存、可按文件逐步迁移。
 * 老调用点迁移完成后由步 3 删除这些兼容面。
 *
 * 单测：tools/result_type_unit.mjs
 */
import { FAILED_REPLY, TRUNCATED_SUFFIX, failedReply, isFailedReply, isTruncatedReply, stripTruncatedMark, isNoCodeReply, errMessage, usageTotals } from './_shared.js';

/** status 取值（冻结，避免各处拼写漂移） */
export const STATUS = Object.freeze({
    OK: 'ok',
    TRUNCATED: 'truncated',
    ERROR: 'error',
    CANCELLED: 'cancelled',
    TIMEOUT: 'timeout',
});

/** errorCode 取值（供应商/sdk 的差异在适配器层收敛到这里） */
export const ERROR_CODE = Object.freeze({
    RATE_LIMIT: 'RATE_LIMIT',
    TIMEOUT: 'TIMEOUT',
    CANCELLED: 'CANCELLED',
    CONTEXT_LENGTH: 'CONTEXT_LENGTH',
    BAD_RESPONSE: 'BAD_RESPONSE',
    NO_TEXT: 'NO_TEXT',
    AUTH: 'AUTH',
    NETWORK: 'NETWORK',
});

const STATUSES = Object.freeze(Object.values(STATUS));

/**
 * 一次模型调用的结构化结果。
 *
 * @param {object} [f] 字段（缺省全部安全默认）
 * @param {string}  [f.content='']        正文（**永不含标记**）
 * @param {string}  [f.status='ok']       STATUS 之一
 * @param {string|null} [f.finishReason]  供应商原值：'stop'|'length'|'MAX_TOKENS'|'max_tokens'|null
 * @param {{prompt:number|null, completion:number|null, missing:boolean}|null} [f.usage]
 * @param {string|null} [f.errorCode]     ERROR_CODE 之一
 * @param {string|null} [f.errorMessage]  已过 safeErrText 的一行（可写日志）
 * @param {number}  [f.elapsedMs=0]
 * @param {number}  [f.attempts=1]
 */
export class ModelResult {
    constructor(f = {}) {
        const src = f && typeof f === 'object' ? f : {};
        this.content = typeof src.content === 'string' ? src.content : '';
        this.status = STATUSES.includes(src.status) ? src.status : STATUS.OK;
        this.finishReason = src.finishReason ?? null;
        this.usage = src.usage ?? null;
        this.errorCode = src.errorCode ?? null;
        this.errorMessage = src.errorMessage ?? null;
        this.elapsedMs = Number.isFinite(src.elapsedMs) ? Number(src.elapsedMs) : 0;
        this.attempts = Number.isFinite(src.attempts) && src.attempts > 0 ? Number(src.attempts) : 1;
    }

    /** 真的拿到了可用内容（失败/取消/超时都不是 ok）。 */
    get ok() { return this.status === STATUS.OK; }

    /** 内容可用但可能不完整（上层自行决定：续写/缩短/照用）。 */
    get truncated() { return this.status === STATUS.TRUNCATED; }

    /** 这一轮没有产出可用内容（error/cancelled/timeout 统一判据）。 */
    get failed() { return this.status === STATUS.ERROR || this.status === STATUS.CANCELLED || this.status === STATUS.TIMEOUT; }

    /** 内容可用（ok 或 truncated）。 */
    get hasContent() { return this.ok || this.truncated; }

    /** 代码生成专用：这一轮明确「没有可执行代码」（见 _shared.noCodeReply）。 */
    get isNoCode() { return isNoCodeReply(this.content); }

    /**
     * 过渡兼容：老调用点把结果当字符串用。
     * **刻意重现旧的标记语义**，这样"字符串派"调用点在迁移期行为不变。
     */
    toString() {
        if (this.status === STATUS.ERROR) return failedReply(this.errorMessage ?? this.errorCode ?? 'error');
        if (this.status === STATUS.TRUNCATED) return this.content + TRUNCATED_SUFFIX;
        if (this.status === STATUS.CANCELLED) return failedReply(this.errorCode ?? ERROR_CODE.CANCELLED);
        if (this.status === STATUS.TIMEOUT) return failedReply(this.errorCode ?? ERROR_CODE.TIMEOUT);
        return this.content;
    }

    valueOf() { return this.toString(); }

    /** 只序列化业务字段（别把 getter/原型混进日志/落盘） */
    toJSON() {
        return {
            content: this.content,
            status: this.status,
            finishReason: this.finishReason,
            usage: this.usage,
            errorCode: this.errorCode,
            errorMessage: this.errorMessage,
            elapsedMs: this.elapsedMs,
            attempts: this.attempts,
        };
    }
}

/**
 * 从失败文案推断 errorCode（供应商文案千差万别，只有几类值得结构化）。
 * 判断顺序：显式 code/status 优先，其次常见文案。
 */
export function inferErrorCode(text, err) {
    const code = typeof err?.code === 'string' ? err.code : '';
    const status = err?.status ?? err?.statusCode;
    const msg = `${code} ${typeof text === 'string' ? text : ''} ${errMessage(err)}`.toLowerCase();
    // 本仓自己的中止文案是中文（`模型请求超过总期限 …ms` / `模型请求被取消`），
    // 所以这里必须同时认英文与自家文案，否则超时会被归成 BAD_RESPONSE（判据只看英文 = 聋）。
    if (code === 'LLM_TIMEOUT' || /timeout|timed out|etimedout|总期限|超时/.test(msg)) return ERROR_CODE.TIMEOUT;
    if (/取消|cancelled|canceled|aborted/.test(msg)) return ERROR_CODE.CANCELLED;
    if (status === 429 || /429|rate.?limit|too many requests/.test(msg)) return ERROR_CODE.RATE_LIMIT;
    if (status === 401 || status === 403 || /unauthorized|invalid.*api.?key|forbidden/.test(msg)) return ERROR_CODE.AUTH;
    if (/context[_ ]length|maximum context|too many tokens|prompt is too long/.test(msg)) return ERROR_CODE.CONTEXT_LENGTH;
    if (/econn|enotfound|eai_again|socket hang up|network|fetch failed/.test(msg)) return ERROR_CODE.NETWORK;
    return ERROR_CODE.BAD_RESPONSE;
}

/**
 * 供应商「输出额度用完」的取值集合（各家字段名/取值不同，收敛**只在这里**）。
 * 为什么要收敛：A5 §1.2 的矩阵里 6 个适配器（groq/cerebras/mistral/ollama/huggingface/replicate）
 * 根本没有截断检测，而截断信息其实就是它们手里已有的一个字段 —— 被扔了。
 * 从本文件起：适配器只负责把原值填进 `finishReason`，**是不是截断由这里判**，
 * 不再各自往字符串上拼 `[LLM_TRUNCATED]`。
 */
const OUTPUT_LIMIT_REASONS = new Set([
    'length',            // OpenAI / DeepSeek / Groq / Cerebras / OpenRouter / LM Studio
    'max_tokens',        // Anthropic（stop_reason）
    'model_length',      // Mistral
    'MAX_TOKENS',        // Gemini
]);

/** 这个 finishReason 是不是「输出额度用完」。 */
export function isOutputLimit(finishReason) {
    return typeof finishReason === 'string' && OUTPUT_LIMIT_REASONS.has(finishReason);
}

/**
 * 桥：把「适配器现在返回的老形状」升级成 `ModelResult`（A5 §3.3 步 0）。
 *
 * 接受的输入：`ModelResult`（原样返回，只补齐统计字段）/ `string`（老形状）/ `null`。
 * 分类语义与旧契约**逐条对应**，所以这一步只增加信息、不改变行为：
 *   `[LLM_ERROR] …`   → status=error    （errorCode 由 inferErrorCode 推断）
 *   `…[LLM_TRUNCATED]`→ status=truncated（content 已剥离标记）
 *   其它字符串         → status=ok
 *   `''`/null          → status=ok + content=''（与旧语义一致：空串不是失败）
 *
 * **老实说明**：这一步拿不到 `usage`/`finishReason`（适配器已经把它们扔进 console sink 了），
 * 所以默认 null；要填它们得等 A5 §3.3 步 2「适配器原生化」，这里不假装是完整版。
 *
 * @param {ModelResult|string|null|undefined} raw 适配器返回值
 * @param {object} [meta] 观测字段
 * @param {number} [meta.elapsedMs] 本次调用耗时（毫秒）
 * @param {number} [meta.attempts] 尝试次数
 * @param {{prompt:number|null, completion:number|null, missing:boolean}|null} [meta.usage]
 * @param {string|null} [meta.finishReason]
 * @returns {ModelResult}
 */
export function toModelResult(raw, meta = {}) {
    if (raw instanceof ModelResult) {
        const merged = new ModelResult({ ...raw.toJSON(), ...stripUndefined({
            elapsedMs: meta.elapsedMs, attempts: meta.attempts, usage: meta.usage, finishReason: meta.finishReason,
        }) });
        return merged;
    }

    const text = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
    const base = {
        elapsedMs: meta.elapsedMs ?? 0,
        attempts: meta.attempts ?? 1,
        usage: meta.usage ?? null,
        finishReason: meta.finishReason ?? null,
    };

    if (isFailedReply(text)) {
        const errorMessage = text.slice(FAILED_REPLY.length).trim() || 'unknown';
        return new ModelResult({
            ...base, content: '', status: STATUS.ERROR,
            errorCode: meta.errorCode ?? inferErrorCode(text, meta.err),
            errorMessage,
        });
    }
    if (isTruncatedReply(text)) {
        return new ModelResult({ ...base, content: stripTruncatedMark(text).text, status: STATUS.TRUNCATED });
    }
    // ★ 结构化提级：适配器把 finishReason 填进来时，截断由**字段**判定，
    //   不需要（也不允许）任何适配器再往正文上拼 [LLM_TRUNCATED]。
    if (isOutputLimit(base.finishReason)) {
        return new ModelResult({ ...base, content: text, status: STATUS.TRUNCATED });
    }
    return new ModelResult({ ...base, content: text, status: STATUS.OK });
}

/** 内部：只保留有值的键（避免 meta 的 undefined 覆盖真实字段） */
function stripUndefined(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
}

/**
 * 不变量断言：`ModelResult` 的结构合法、且 `content` **不含内部标记**。
 *
 * 为什么要一条运行时断言：类型化的全部价值在于"标记不再出现在数据面"。
 * 若哪天有适配器又把 `[LLM_ERROR]`/`[LLM_TRUNCATED]` 拼进正文，**这里当场炸**，
 * 而不是等它进了 history、被说给玩家、或被写进 memory.json 之后才发现。
 *
 * @param {ModelResult} result
 * @param {string} [where] 出错位置（便于定位）
 * @returns {ModelResult} 原对象（便于链式使用）
 * @throws {TypeError} 结构或内容不变量被破坏
 */
export function assertModelResult(result, where = 'model result') {
    const at = `[${where}]`;
    if (!(result instanceof ModelResult)) throw new TypeError(`${at} 不是 ModelResult：${typeof result}`);
    if (!STATUSES.includes(result.status)) throw new TypeError(`${at} status 非法：${result.status}`);
    if (typeof result.content !== 'string') throw new TypeError(`${at} content 不是字符串`);
    if (isFailedReply(result.content)) throw new TypeError(`${at} content 里混进了失败标记：${result.content.slice(0, 60)}`);
    if (result.content.includes(TRUNCATED_SUFFIX)) throw new TypeError(`${at} content 里混进了截断标记：${result.content.slice(-40)}`);
    if (result.status === STATUS.ERROR && !result.errorCode) throw new TypeError(`${at} status=error 但没有 errorCode`);
    if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) throw new TypeError(`${at} elapsedMs 非法：${result.elapsedMs}`);
    if (!Number.isInteger(result.attempts) || result.attempts < 1) throw new TypeError(`${at} attempts 非法：${result.attempts}`);
    return result;
}

/** 断言 + 兜底：不合法就降级成 error 结果（生产路径不该因为断言把 bot 打挂）。 */
export function coerceModelResult(result, where = 'model result') {
    try {
        return assertModelResult(result, where);
    } catch (err) {
        return new ModelResult({
            status: STATUS.ERROR, content: '', errorCode: ERROR_CODE.BAD_RESPONSE,
            errorMessage: `非法的模型结果：${errMessage(err)}`,
            elapsedMs: Number.isFinite(result?.elapsedMs) ? result.elapsedMs : 0,
            attempts: Number.isFinite(result?.attempts) ? result.attempts : 1,
        });
    }
}

// ── 可观测性：结果分布计数（这同时是「last_convo_truncated 死标志」的消费者）──
// 缺陷原貌（A5 §2.2 缺口 B）：`prompter.last_convo_truncated = true` 全仓**只写不读**
//   ⇒ 玩家看到的是一句被腰斩的半句话，没有任何提示，上层也拿不到"这句不完整"。
//   「字符串里塞状态、剥标记就等于丢状态」的直接证据。
// 处置（二选一里的「接真实消费者」）：状态进 ModelResult.status，并在本模块做**进程级计数**；
//   每当记忆落盘（低频、天然的对账点）把分布打进日志 ⇒ 截断率/失败率/丢弃率第一次可读。
//   为什么不直接删标志：review2_regression_unit 把它钉成"剥离标记后仍保留结构化诊断"，
//   删掉等于把那条可观测性约定一起删了；标志保留但其值现在**一定有人读**（下图计数）。
const resultTotals = { calls: 0, ok: 0, truncated: 0, error: 0, cancelled: 0, timeout: 0, elapsedMsTotal: 0, attemptsTotal: 0 };

/** 记一次模型结果（按 status 分布计数）。 */
export function noteModelResult(result, tag) {
    if (!(result instanceof ModelResult)) return modelResultTotals();
    resultTotals.calls++;
    const s = result.status;
    if (s === STATUS.OK) resultTotals.ok++;
    else if (s === STATUS.TRUNCATED) resultTotals.truncated++;
    else if (s === STATUS.CANCELLED) resultTotals.cancelled++;
    else if (s === STATUS.TIMEOUT) resultTotals.timeout++;
    else resultTotals.error++;
    resultTotals.elapsedMsTotal += Number.isFinite(result.elapsedMs) ? result.elapsedMs : 0;
    resultTotals.attemptsTotal += result.attempts;
    if (tag === 'convo') resultTotals.convo = (resultTotals.convo ?? 0) + 1;
    return modelResultTotals();
}

/** 结果分布快照（测试/面板/日志用）。 */
export function modelResultTotals() {
    return { ...resultTotals, avgElapsedMs: resultTotals.calls ? Math.round(resultTotals.elapsedMsTotal / resultTotals.calls) : 0 };
}

/** 重置计数（测试用；生产不需要）。 */
export function resetModelResultTotals() {
    for (const k of Object.keys(resultTotals)) resultTotals[k] = 0;
}

/**
 * **真实消费者**：把「结果分布 + 用量累计」打成一行可写日志的字符串。
 * 调用点：prompter 每次记忆落盘（低频）。原来 `usageTotals()` 全仓 0 个生产调用点
 * （只有单测用），成本结构上永远算不出来（A5 §6.2）—— 这一行把它接上了。
 * @returns {string}
 */
export function formatModelTotals() {
    const r = modelResultTotals();
    const u = usageTotals();
    return `[llm] totals calls=${r.calls} ok=${r.ok} truncated=${r.truncated} error=${r.error}`
        + ` cancelled=${r.cancelled} timeout=${r.timeout} avgMs=${r.avgElapsedMs}`
        + ` | usage calls=${u.calls} prompt=${u.prompt} completion=${u.completion} missing=${u.missing}`;
}
