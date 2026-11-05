/**
 * 任务期间的 mode 互斥（方案 §9 并发矩阵）。
 *
 * 为什么要这个文件：这些 mode 会自己 setGoal 或 moveAway，和任务抢 pathfinder。
 * 实测日志：followPlayer 期间 unstuck 每 20 秒插进来 moveAway 5 格，
 * 机器人在玩家旁边原地打转，永远跟不住；torch_placing 还会顺路插一根火把。
 *
 * 规则（§9）：
 *   待机        → 只留 self_preservation
 *   跟随/采集/放置 → 暂停 item_collecting / torch_placing / idle_staring / hunting / unstuck
 *   自保与自卫（self_preservation / self_defense）任何任务期间都不暂停
 */
const GOAL_MODES = [
    'item_collecting',
    'torch_placing',
    'idle_staring',
    'hunting',
    'unstuck',        // 会 moveAway，是跟随失败的直接原因
    'elbow_room',     // modes.js 里直接写着 interrupts:['action:followPlayer']
];

export function pauseGoalModes(bot) {
    const prev = {};
    for (const name of GOAL_MODES) {
        try {
            if (!bot?.modes) continue;
            prev[name] = bot.modes.isPaused?.(name) ?? false;
            bot.modes.pause?.(name);
        } catch { /* 裸 bot（测试脚本）没有 modes */ }
    }
    return prev;
}

export function restoreGoalModes(bot, prev) {
    // ★ 第9条止血：pathfinder **还在动**就别急着把行为模式放回来。
    //
    //   现场症状：一段导航刚结束，`restoreGoalModes` 立刻 unpause 了
    //   follow/collect 那批"目标模式"，它们一醒就去 `bot.pathfinder.setGoal(...)`，
    //   把**还没走完**的那次导航的 goal 换掉 → `The goal was changed` →
    //   上层的 dig/move 全部 INTERNAL（真机实测每 150 行撞 2 次）。
    //
    //   所以这里分两步：先把模式恢复推迟到"路径真的停了"再放。
    //   用一个短轮询兜底（最多等 STILL_MOVING_MAX_MS），仍不动才放弃等待 ——
    //   不能让"延后恢复"变成"永不恢复"，那会把模式卡在暂停态。
    const stillMoving = () => {
        try { return bot?.pathfinder?.isMoving?.() === true; } catch { return false; }
    };

    const apply = () => {
        for (const [name, wasPaused] of Object.entries(prev ?? {})) {
            if (wasPaused) continue;   // 本来就暂停的，保持暂停
            try { bot.modes?.unpause?.(name); } catch { /* ignore */ }
        }
    };

    if (!stillMoving()) { apply(); return; }

    const STILL_MOVING_MAX_MS = 5000;
    const startedAt = Date.now();
    const timer = setInterval(() => {
        if (!stillMoving() || Date.now() - startedAt >= STILL_MOVING_MAX_MS) {
            clearInterval(timer);
            apply();
        }
    }, 200);
    // 计时器不该让进程挂着不退（测试/退出时最常见）
    try { timer.unref?.(); } catch { /* ignore */ }
}
