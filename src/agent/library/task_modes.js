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
    for (const [name, wasPaused] of Object.entries(prev ?? {})) {
        if (wasPaused) continue;   // 本来就暂停的，保持暂停
        try { bot.modes?.unpause?.(name); } catch { /* ignore */ }
    }
}
