/**
 * OPS-002（2026-11-06 深度检查）—— 关服失败时的决策，抽成纯函数以便离线断言。
 *
 * 缺陷原貌（`web/scripts/stop-all.mjs`）：`server-stop` 的 ack 无论 ok 与否都继续往下走 ——
 * 打印一句"跳过：rcon_failed"，然后 `shutdown` 掉 mindserver，最后 exit 0 + "完成。"。
 * 于是 **Minecraft 还在后台跑**，用户被告知成功；接着去强关窗口 ⇒ 存档未刷盘。
 *
 * 现在的三态：
 *   proceed  可以接着关管理端（真的停了 / 本来就没跑）
 *   fail     关服没成功：**保留管理端**、非零退出
 *   （服务器自己没退出时同样归入 fail —— 由调用方用端口探测判断）
 */

/** 退出码口径（stop-panel.ps1 按它给提示，别再靠"看日志猜"）。 */
export const STOP_EXIT = Object.freeze({
    OK: 0,          // 已停 / 本来没跑
    NO_TOKEN: 2,    // 拿不到握手 token
    AUTH_REJECTED: 3, // 握手被拒（token 过期）
    STOP_FAILED: 4, // **关服没成功**：管理端保持运行
    UNKNOWN: 5,     // **无法确认**：连接既没成功也没失败 / 管理端没有确认退出
    MISSING_DEPS: 6, // 缺 web/node_modules（脚本连自己都起不来）
});

/**
 * `server-stop` 的 ack 结果 → 下一步。
 *
 * @param {{ok?:boolean, reason?:string, hint?:string}|null|undefined} res
 * @returns {{action:'proceed'|'fail', reason?:string, hint?:string}}
 */
export function decideAfterStop(res) {
    if (res && res.ok === true) {
        // 指令发出去了，但"服务器是否真的退出"要另行用端口探测确认，不在这里假定。
        return { action: 'proceed' };
    }
    const reason = res?.reason ?? 'unknown';
    if (reason === 'not_running') {
        // 本来就没跑：跳过 RCON 是正确行为，可以收尾（关管理端）。
        return { action: 'proceed', reason };
    }
    // rcon_disabled / rcon_failed / 超时 / 空响应 ……
    // 一律按"关服没成功"处理：绝不能再把管理端关掉，否则连重试的入口都没了。
    return { action: 'fail', reason, hint: res?.hint };
}

/**
 * 发出 RCON stop 之后，服务器**没有**在期限内退出 → 也是失败。
 *
 * 为什么单独一步：`rcon('stop')` 只要命令送达就返回 ok，但"送达"不等于"退出"。
 * 报告要求"成功后确认退出再 shutdown"，所以由调用方轮询端口，这里只做判定与文案。
 *
 * @param {boolean} exited 端口是否已关闭
 * @returns {{action:'proceed'|'fail', reason?:string, hint?:string}}
 */
export function decideAfterExitWait(exited) {
    if (exited) return { action: 'proceed' };
    return {
        action: 'fail',
        reason: 'rc stop 已发出，但服务器仍在监听（没退出）',
        hint: '可能只送达了一部分或卡在保存；等它退出或手动处理后重跑',
    };
}
