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
