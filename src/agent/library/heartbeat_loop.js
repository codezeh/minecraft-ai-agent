/**
 * agent 的 300ms 心跳循环（报告第 32 条）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 缺陷原貌（`agent.js` 的 `setTimeout(async () => { while (true) { await this.update(..) } })`）：
 *   整段**没有 try/catch**。`update()` 里随便一处抛一次（modes.update 里一个
 *   ReferenceError 就够了），`while(true)` 就被**彻底打死**：
 *     · 没有任何人重启这个循环（它不在任何 supervisor 里）
 *     · 而聊天走的是 `handleMessage`，**不依赖**这个循环
 *   ⇒ bot 进入"只会聊天、不会做事"的半死状态 —— 最难查的一种：进程活着、连接正常、
 *     面板显示在线，但她再也不动。日志里只有一条未处理的 rejection。
 *
 * 为什么单独抽成一个文件：**这样"异常之后循环还在跑"能被离线证明**
 * （`tools/agent_heartbeat_unit.mjs` 直接驱动它，不用起 mineflayer）。
 * 抽出来之前这条只能靠"读一遍代码觉得没问题"。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 默认节拍（原实现就是 300ms）。 */
export const HEARTBEAT_INTERVAL_MS = 300;

/**
 * 跑心跳循环。
 *
 * @param {object} opts
 * @param {(deltaMs:number)=>Promise<void>} opts.update 每拍要做的事（原来就是 agent.update）
 * @param {number} [opts.intervalMs] 节拍，默认 300
 * @param {(ms:number)=>Promise<void>} [opts.sleep] 可注入（用例里换成不真睡的）
 * @param {(line:string)=>void} [opts.warn] 异常告警的出口（用例里换成收集器）
 * @param {number} [opts.maxIterations] 跑多少拍后返回（默认无限；用例用有限值）
 * @param {()=>number} [opts.now] 时钟（可注入）
 * @param {()=>boolean} [opts.shouldStop] 外部停止条件（用例用；生产不传 = 永不主动停）
 * @returns {Promise<number>} 实际跑了多少拍
 */
export async function runHeartbeatLoop({
    update,
    intervalMs = HEARTBEAT_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    warn = (line) => console.warn(line),
    maxIterations = Infinity,
    now = () => Date.now(),
    shouldStop = () => false,
} = {}) {
    if (typeof update !== 'function') throw new Error('runHeartbeatLoop 需要 update 函数');

    let last = now();
    let iterations = 0;

    while (iterations < maxIterations && !shouldStop()) {
        iterations += 1;
        const start = now();
        try {
            await update(start - last);
        } catch (e) {
            // ★★★ 第32条：**一次异常不许停掉心跳。**
            //   隔离这一轮、打一行告警、继续下一拍。注意这里**不 rethrow**：
            //   抛出去只会变成 unhandled rejection，而没有任何人会重启这个循环。
            try {
                warn(`[心跳] update() 抛异常，本轮已隔离、循环继续：${String(e?.message ?? e)}`);
            } catch { /* 告警本身失败也不许弄垮心跳 */ }
        }
        last = start;
        const remaining = intervalMs - (now() - start);
        if (remaining > 0) {
            try {
                await sleep(remaining);
            } catch { /* 睡失败也不许停循环 */ }
        }
    }

    return iterations;
}
