/**
 * 位置包节流 + 合法性兜底。
 *
 * 背景（两段历史）：
 *   1) 最初加节流是因为 Paper 的包速率限制导致 ECONNRESET（客户端发得比 20Hz 密）。
 *   2) 旧实现有个副作用：它把**捕获时的 data 引用**放进 setTimeout，
 *      延迟 50ms 后照发那个旧对象 —— 服务端收到的永远是滞后的、跳变的位置。
 *      用户的实际观感是"她有点卡卡的"，而跳变本身也会撞上移动校验。
 *
 * 现在只做两件事：
 *   a) **合法性兜底**：位置是 NaN/Infinity 就根本不发（发出去必被踢）
 *   b) **到点合并**：不到 50ms 时只保留最新一份状态，到点发最新的。
 *      不是排队、不是丢弃后照发旧值，而是"总是发最新的"。
 *
 * 为什么是 50ms：服务器 tick 是 20/秒，一个 tick 一次位置包正好对齐。
 */
const DEFAULT_INTERVAL_MS = 50;

/**
 * 给 bot 装上位置包节流。
 *
 * @param {object} bot
 * @param {object} opts { intervalMs = 50, dropInvalid = true }
 * @returns {function} 卸载函数（恢复原始 write）
 */
export function installPositionThrottle(bot, opts = {}) {
    const { intervalMs = DEFAULT_INTERVAL_MS, dropInvalid = true } = opts;
    if (!bot?._client?.write) return () => { };

    const originalWrite = bot._client.write.bind(bot._client);
    let lastSentAt = 0;
    let pending = null;        // { name, data }

    const flush = () => {
        if (!pending) return;
        const { name, data } = pending;
        pending = null;
        lastSentAt = Date.now();
        originalWrite(name, data);
    };

    const isPositionPacket = (name) =>
        name === 'position' || name === 'position_look' || name === 'look';

    bot._client.write = function (name, data) {
        if (!isPositionPacket(name)) return originalWrite(name, data);

        if (dropInvalid && data) {
            const ok = Number.isFinite(data.x) && Number.isFinite(data.y) && Number.isFinite(data.z);
            if (!ok) return;   // 发 NaN 出去服务端会直接断开
        }

        const wait = intervalMs - (Date.now() - lastSentAt);
        if (wait <= 0) {
            lastSentAt = Date.now();
            pending = null;             // 清掉待发的旧帧
            return originalWrite(name, data);
        }

        pending = { name, data };       // 覆盖式：只保留最新
        if (!bot._throttleTimer) {
            bot._throttleTimer = setTimeout(() => {
                bot._throttleTimer = null;
                flush();
            }, wait);
        }
        return;
    };

    return () => {
        if (bot._throttleTimer) {
            clearTimeout(bot._throttleTimer);
            bot._throttleTimer = null;
        }
        pending = null;
        bot._client.write = originalWrite;
    };
}
