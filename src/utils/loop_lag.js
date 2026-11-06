/**
 * 事件循环延迟监控（loop lag）
 *
 * 为什么需要：之前实测出现过 `ping timeout` → 断连 → 重连超时 → 杀进程 → 重启。
 * 当时的猜测是"等模型 API 时主线程被阻塞，导致 socket.io 心跳发不出去"，
 * 但**翻遍请求路径没找到同步阻塞点**（prompter 的日志写盘是 fs.promises，异步）。
 *
 * 没有证据就不该硬改一个猜出来的"根因"。所以这里只做一件事：**把延迟量出来**。
 * 一旦再出现 ping timeout，日志里会带上当时的事件循环延迟——
 *   - 延迟很大  → 确实是主线程被占住（接下来该去找具体是哪段同步代码）
 *   - 延迟正常  → 不是阻塞问题，得往 socket/网络/上游 API 慢 方向查
 * 这样下次不用再猜。
 *
 * 开销：每 500ms 一次 setTimeout，比较预定时间与实际时间的差，可忽略。
 */

let timer = null;
let lastTick = 0;
let maxLagMs = 0;
let maxLagAt = null;
let samples = 0;
const INTERVAL_MS = 500;
const WARN_THRESHOLD_MS = 2000;   // 超过就记一条警告

// ★ F-EXEC-107（2026-11-06）：**滑动窗口**。
// 原来 `maxLagMs` 只增不减 ⇒ 一次 2 秒抖动之后，`describeLoopLag()` 永远输出
// "该数值很大，说明主线程确实被占用" —— 而那句话正是历史报告用来**反证**掉线原因的引用，
// 一旦被污染，"正常"和"很大"都可能说的是三天前那次。
// 现在：最近 WINDOW_MS 内的样本才算数；窗口外的旧峰值自动失效。
const WINDOW_MS = 60000;          // 只看最近 60 秒
const MAX_SAMPLES = 240;          // 兜底（500ms 一条 ⇒ 60 秒 120 条，留一倍余量）
let windowSamples = [];           // [{t, lag}]

function pruneWindow(now) {
    const cutoff = now - WINDOW_MS;
    while (windowSamples.length && windowSamples[0].t < cutoff) windowSamples.shift();
    while (windowSamples.length > MAX_SAMPLES) windowSamples.shift();
}

/** 窗口内峰值（没有样本 → null）。 */
function windowMax(now) {
    pruneWindow(now);
    if (!windowSamples.length) return null;
    let best = windowSamples[0];
    for (const s of windowSamples) if (s.lag > best.lag) best = s;
    return best;
}

export function startLoopLagWatch() {
    if (timer) return;
    lastTick = Date.now();
    timer = setInterval(() => {
        const now = Date.now();
        const lag = now - lastTick - INTERVAL_MS;
        lastTick = now;
        samples++;
        windowSamples.push({ t: now, lag });
        pruneWindow(now);

        // 历史峰值仍保留（"本进程曾经多糟"），但**判断与日志改用窗口值**
        if (lag > maxLagMs) {
            maxLagMs = lag;
            maxLagAt = new Date(now).toISOString();
        }
        if (lag >= WARN_THRESHOLD_MS) {
            console.warn(`[loop-lag] 事件循环被卡住 ${lag}ms（心跳可能因此超时）`);
        }
    }, INTERVAL_MS);
    // 别让这个定时器把进程留住
    if (timer.unref) timer.unref();
}

export function stopLoopLagWatch() {
    if (timer) { clearInterval(timer); timer = null; }
}

/**
 * 取观测数据。
 * - `windowMaxMs` / `windowMaxAt`：**最近 60 秒**峰值（判断"现在到底卡不卡"看这个）
 * - `maxLagMs` / `maxLagAt`：本进程历史峰值（只增不减，仅参考，**别当当前状态**）
 */
export function loopLagStats() {
    const now = Date.now();
    const w = windowMax(now);
    return {
        windowMaxMs: w ? w.lag : null,
        windowMaxAt: w ? new Date(w.t).toISOString() : null,
        windowSamples: windowSamples.length,
        windowMs: WINDOW_MS,
        maxLagMs, maxLagAt,
        samples, since: lastTick ? new Date(lastTick).toISOString() : null,
    };
}

/** 给日志用的一句话（**用窗口值**，并显式写出窗口长度，避免"最大值"没有时间概念） */
export function describeLoopLag() {
    const s = loopLagStats();
    if (!s.samples) return '事件循环延迟: 未采样';
    if (s.windowMaxMs === null) return `事件循环延迟: 最近 ${s.windowMs / 1000} 秒无样本`;
    return `事件循环延迟：最近 ${s.windowMs / 1000} 秒最大 ${s.windowMaxMs}ms` +
        (s.windowMaxMs >= WARN_THRESHOLD_MS ? '（该数值很大，说明主线程确实被占用）' : '（正常，不是阻塞导致）') +
        `；本进程历史峰值 ${s.maxLagMs}ms（仅供参考，不是当前状态）`;
}
