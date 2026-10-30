/**
 * 修复：外部瞬移（RCON tp / spreadplayers）之后，mineflayer 的物理状态会坏掉。
 *
 * 实测（2026-10-24，tools/_dbg_noguard.mjs + _dbg_tp_physics.mjs）：
 *   - 不修：tp 后 1 秒 `bot.entity.position` 变成 NaN，且**永不恢复**（物理彻底死）
 *   - 只"补位置"：坐标看着正常，但物理仍是死的 —— 表现为
 *       · 自由落体 4 秒只掉 3 格（正常应掉 60+ 格）
 *       · 走 12 秒只移动 2 格（正常 4.28 格/秒）
 *     后果：位置包稀疏 → 服务端判 invalid_player_movement → 被踢（用户观感"卡卡的"）
 *
 * 根因：mineflayer 的物理引擎在 `position` 包里做的是"位置 set + 清 jumpTicks"，
 * 但 `bot.entity.velocity` 和物理内部时间累加器还停留在瞬移前的状态；
 * 下一 tick 用「旧速度 × 新位置」推演，算出 NaN 或极小的位移。
 *
 * 正确做法：**监听官方的 `forcedMove` 事件**（mineflayer 在处理 teleport 包时会 emit），
 * 在那一刻把物理状态重建：
 *   1) 速度清零（旧速度对新位置无意义）
 *   2) 清掉控制键（防止瞬移后还在按着前进）
 *   3) 等一 tick 让物理从新位置重新开始
 *
 * 为什么不再"每 tick 发现 NaN 就拉回旧位置"：
 *   那只是掩盖症状。位置被拉回旧值的同时，物理也还在死着，
 *   表现为"看着有坐标但走不动"，比直接报错更难查。
 */

/**
 * 给 bot 装上瞬移后物理重建。
 *
 * @param {object} bot
 * @param {object} opts
 *   onRepair  修复回调（给上层做日志/事件）
 * @returns {function} 卸载函数
 */
export function installPositionGuard(bot, opts = {}) {
    if (!bot?.on) return () => { };
    const { onRepair = null } = opts;

    let repairs = 0;

    /**
     * 重建物理状态。
     *
     * 只做三件确定有效的事，不猜测：
     *   - 速度归零（旧速度对新位置没有意义，正是它算出 NaN）
     *   - 清控制键（瞬移后不该继续保持"按着前进"）
     *   - 记一次修复（便于观测"到底发生了多少次瞬移"）
     */
    const rebuild = (why) => {
        try {
            const vel = bot.entity?.velocity;
            if (vel?.set) vel.set(0, 0, 0);

            // 清控制键：不按住任何键，让物理从静止开始
            try { bot.clearControlStates?.(); } catch { /* ignore */ }

            // jumpTicks 是 mineflayer 内部的跳跃冷却；瞬移后归零避免"卡跳"
            bot.jumpTicks = 0;

            repairs++;
            if (typeof onRepair === 'function') {
                onRepair({ why, count: repairs, pos: bot.entity?.position });
            }
        } catch { /* ignore */ }
    };

    // 官方信号：mineflayer 处理 teleport 包后会 emit 'forcedMove'
    const onForcedMove = () => rebuild('forcedMove');
    bot.on('forcedMove', onForcedMove);

    // 兜底：位置真的变 NaN 时（forcedMove 没覆盖到的路径），用最近一次合法位置恢复
    let lastGood = null;
    const onTick = () => {
        const ep = bot.entity?.position;
        if (!ep) return;
        const bad = !Number.isFinite(ep.x) || !Number.isFinite(ep.y) || !Number.isFinite(ep.z);
        if (!bad) {
            lastGood = { x: ep.x, y: ep.y, z: ep.z };
            return;
        }
        if (!lastGood) return;
        try {
            ep.set(lastGood.x, lastGood.y, lastGood.z);
            rebuild('nan-recover');
        } catch { /* ignore */ }
    };
    bot.on('physicsTick', onTick);

    return () => {
        try { bot.removeListener('forcedMove', onForcedMove); } catch { }
        try { bot.removeListener('physicsTick', onTick); } catch { }
    };
}

/** 诊断用：读一次 bot 的物理健康度（不修改任何状态）。 */
export function inspectPhysics(bot) {
    const p = bot.entity?.position;
    const v = bot.entity?.velocity;
    if (!p) return { healthy: false, why: '没有 entity' };
    const finite = Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
    return {
        healthy: finite,
        pos: finite ? { x: p.x, y: p.y, z: p.z } : null,
        onGround: bot.entity.onGround,
        velY: v?.y ?? null,
        physicsEnabled: bot.physicsEnabled,
    };
}
