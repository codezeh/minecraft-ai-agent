/**
 * 结构化事件总线（内存 ring buffer）—— 给前端诊断面板用。
 *
 * ★ 2026-10-30 新建。
 *
 * 为什么要它：`executor.js` / 各原子层**早就在发** `onEvent({type:'dig'|'plan-fail'|...})`，
 * 但调用方统统 `console.log` 掉了 —— 事件出了进程就没了，面板看不到。
 * 这个模块只做一件事：把这些事件留在内存里，前端按 seq 增量取。
 *
 * 设计约束（刻意的）：
 *  - **不落盘**：日志文件已经有一份了，再写一份只会两边都不准。
 *  - **固定上限 400 条**：环形覆盖，内存常驻 < 100KB，绝不因为跑一夜而涨。
 *  - **不阻塞**：push 是同步的，订阅者异常被吞掉，绝不让 UI 拖死主链路。
 */

const MAX = 400;

/** @type {Array<{seq:number, ts:number, type:string}>} */
const buffer = [];
let seq = 0;
const subscribers = new Set();

/**
 * 记录一条事件。
 * @param {string} type
 * @param {object} [data]
 */
export function push(type, data = {}) {
    const e = { seq: ++seq, ts: Date.now(), type: String(type || 'event'), ...data };
    buffer.push(e);
    if (buffer.length > MAX) buffer.shift();

    for (const fn of subscribers) {
        try { fn(e); } catch { /* 订阅者出错不影响主链路 */ }
    }
    return e;
}

/**
 * 接住原子层/执行器的 onEvent 对象事件（{type, ...}）。
 * 静默版：不打印，避免导航高频事件把 stdout 刷爆。
 */
export function collectSilent(e) {
    if (!e || typeof e !== 'object') return;
    const { type, ...rest } = e;
    push(type || 'event', rest);
}

/**
 * 谁写 trace_bus 的记号（09 §2「trace_bus 只在最外层写一次」，D10 的修法）。
 *
 * 为什么要记号而不是"约定调用方只包一层"：`walkTo` 会把自己包好的 `onEvent`
 * 传给 `execStep`，而 `execStep` 原来**自己也包了一层**，于是 execStep 发出的
 * 每个事件被记两次（09 §2，D10 的根因）。层数还会变，靠人记"谁包过了"必然再错一次。
 * 记号挂在函数对象上：包过的函数原样往下传，内层看到记号就不再包。
 */
const TRACED = Symbol('trace_bus.traced');

/**
 * 把 `fn` 包装成"事件进 trace_bus，同时也交给 fn"的版本。
 *
 * **幂等**：已经包过的函数原样返回 —— 这是"只写一次"的机械保证。
 * `meta` 里的字段平铺进事件（09 §2：`jobId` / `skill` 在任务单里跑时自动带上，M5 的 ctx 用）。
 *
 * @param {Function} [fn] 调用方自己的 onEvent
 * @param {{jobId?:string, skill?:string}} [meta]
 * @returns {Function} 带记号的 onEvent
 */
export function ensureTraced(fn, meta = null) {
    if (typeof fn === 'function' && fn[TRACED]) return fn;
    const inner = typeof fn === 'function' ? fn : () => {};
    const wrapped = (e) => {
        try {
            collectSilent(meta && e && typeof e === 'object' ? { ...e, ...meta } : e);
        } catch { /* 留档失败不影响主链路 */ }
        try { inner(e); } catch { /* 调用方回调异常不影响主链路 */ }
    };
    wrapped[TRACED] = true;
    return wrapped;
}

/** 这个函数是不是已经包过（测试与诊断用）。 */
export function isTraced(fn) {
    return !!(typeof fn === 'function' && fn[TRACED]);
}

/** 需要同时保留控制台日志的地方用它（行为与原来的 console.log 一致，另加留档）。 */
export function collect(e) {
    collectSilent(e);
    try {
        console.log('[ev]', JSON.stringify(e).slice(0, 200));
    } catch { /* ignore */ }
}

/** 取 seq > sinceSeq 的事件（前端增量拉取）。 */
export function since(sinceSeq = 0) {
    const from = Number(sinceSeq) || 0;
    return buffer.filter(e => e.seq > from);
}

export function lastSeq() {
    return seq;
}

export function stats() {
    return { seq, size: buffer.length, max: MAX };
}

export function clear() {
    buffer.length = 0;
}

/** 订阅新事件（socket 转发用）。返回取消订阅函数。 */
export function onPush(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}
