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

export function startLoopLagWatch() {
    if (timer) return;
    lastTick = Date.now();
    timer = setInterval(() => {
        const now = Date.now();
        const lag = now - lastTick - INTERVAL_MS;
        lastTick = now;
        samples++;
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

/** 取出观测数据（用完不清零，方便断线时随时读） */
export function loopLagStats() {
    return { maxLagMs, maxLagAt, samples, since: lastTick ? new Date(lastTick).toISOString() : null };
}

/** 给日志用的一句话描述 */
export function describeLoopLag() {
    const s = loopLagStats();
    if (!s.samples) return '事件循环延迟: 未采样';
    return `事件循环延迟最大 ${s.maxLagMs}ms` +
        (s.maxLagMs >= WARN_THRESHOLD_MS ? '（该数值很大，说明主线程确实被占用）' : '（正常，不是阻塞导致）');
}
