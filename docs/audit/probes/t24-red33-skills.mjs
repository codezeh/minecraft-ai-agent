// t24 第33条鉴别力实证用「红版」skills 模块（修复前的 goToGoal 行为）。
// 用法：SKILLS_MODULE=<本文件> node tools/goToGoal_interrupt_unit.mjs
// 原理：`export *` 全量转发真实 skills.js（其余导出与生产一致），
//       但本地显式导出的 goToGoal 会**遮蔽**转发来的同名导出（ESM 规范：显式导出优先）。
// 红版 = 只有 180s 硬上限、**不查 interrupt_code** —— 即第33条修复前的样子。
export * from 'file:///E:/我的世界ai/mindcraft/src/agent/library/skills.js';

export async function goToGoal(bot, goal) {
    // 修复前：Promise.race(goto, 180s) —— 没有第三支中断轮询
    let t;
    try {
        await Promise.race([
            bot.pathfinder.goto(goal),
            new Promise((_res, rej) => {
                t = setTimeout(() => rej(Object.assign(new Error('GOTO_TIMEOUT'), { code: 'TIMEOUT' })), 180000);
            }),
        ]);
        return true;
    } finally {
        clearTimeout(t);
    }
}
