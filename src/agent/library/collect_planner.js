/**
 * 采集前的侦察与规划：摸清附近有什么原木、聚成几处、按什么顺序砍。
 *
 * 历史：这里原来按「树型（大/中/小）」决定「从上砍还是从下砍」，依据是
 * 「大树从下砍会坍」和「树冠挡视线」——**两条都不成立**：
 *   1. 原木/木头/石头都不受重力，砍伐顺序对完成度零影响
 *   2. 挖方块不需要视线（规则 R3-02：中间挡一层树叶照样能挖）
 * 所以 tree_strategy.js 整个删掉了（2026-10-24，用户确认）。
 *
 * 现在只保留三件真正有用的事：
 *   - 把原木按「树干列」聚成一处一处（避免同一棵树被拆成多个目标反复往返）
 *   - 计算带垂直惩罚的距离，用于排序
 *   - 侦察阶段就排除明显到不了的（高差 >8 且水平 >6）
 */
import { findBlocks, blockAt } from './atom_perceive.js';

/**
 * 侦察：把附近的原木聚成一处一处，并给出执行顺序。
 *
 * @param {object} bot
 * @param {string[]} names 目标方块名（「木头」= 所有原木）
 * @param {object} opts { radius, limit, maxTrees, anchor }
 * @returns {{trees:Array, totalLogs:number, planned:number, skipped:number}}
 */
export function surveyTrees(bot, names, opts = {}) {
    const { radius = 48, limit = 128, maxTrees = 24, anchor = null } = opts;

    // 性能关键：对每种木头各调一次 findBlocks 会造成 loop-lag（实测 2332ms 被踢下线）。
    // 改成一次调用传 id 数组（mineflayer 支持 matching 为数组），单次遍历。
    const ids = names.map(n => bot.registry?.blocksByName?.[n]?.id).filter(id => id != null);
    if (!ids.length) return { trees: [], totalLogs: 0, planned: 0, skipped: 0 };
    const positions = bot.findBlocks({ matching: ids, maxDistance: radius, count: limit });
    if (!positions.length) return { trees: [], totalLogs: 0, planned: 0, skipped: 0 };

    // 按「树干列」聚类：同一 x,z 的原木属于同一处
    const columns = new Map();
    for (const p of positions) {
        const k = `${Math.floor(p.x)},${Math.floor(p.z)}`;
        if (!columns.has(k)) columns.set(k, { x: Math.floor(p.x), z: Math.floor(p.z), ys: [] });
        columns.get(k).ys.push(Math.floor(p.y));
    }

    const myPos = bot.entity.position;
    const ref = anchor || myPos;
    const trees = [];
    let skipped = 0;

    for (const col of columns.values()) {
        col.ys.sort((a, b) => a - b);
        const bottom = { x: col.x, y: col.ys[0], z: col.z };

        // 防御：只保留确实是目标方块的列
        const b0 = blockAt(bot, bottom);
        if (!b0 || !names.includes(b0.name)) { skipped++; continue; }

        const dy = bottom.y - myPos.y;
        const hDist = Math.hypot(bottom.x - myPos.x, bottom.z - myPos.z);
        const refH = Math.hypot(bottom.x - ref.x, bottom.z - ref.z);
        const refDy = bottom.y - ref.y;

        // 垂直差按 2 倍计入：爬升比平地慢得多
        // （实测教训：原来只算水平距离，选中了「水平 6 格、垂直高差 13 格」的目标，9 次全超时）
        const myDist = Math.hypot(hDist, dy * 2);
        const dist = Math.hypot(refH, refDy * 2);

        // ★ 2026-10-29 改：**不再在这里排除"高差大"的目标**。
        //
        // 原来这条是 `if (|dy| > 8 && hDist > 6) skip`，
        // 而她面对的那棵丛林树是 dy=12、hDist=8 —— 正好被这条挡住，
        // 连规划都进不去，表现就是"附近有树却永远不去砍"。
        //
        // 现在有了两个新原子，高差不再是"到不了"的理由：
        //   atom_tunnel 可以挖台阶上去
        //   atom_tree   可以从底部往上砍（根本不用爬）
        // 所以只排除**真正离谱**的（比如在 40 格外且高 30 格，跑一趟不划算），
        // 剩下的交给下游的 planFelling / 掘进去解决。
        if (Math.abs(dy) > 24 && hDist > 32) { skipped++; continue; }

        // 执行顺序：只按高度降序排（自上而下顺手，且脚边那格常被自己挡住），
        // 不再按树型决定「从上还是从下」——那条规则没有物理依据。
        const order = col.ys
            .slice()
            .sort((a, b) => b - a)
            .map(y => ({ x: col.x, y, z: col.z }));

        trees.push({
            bottom,
            dist,
            myDist,
            hDist,
            dy,
            logs: order.length,
            order,
            desc: `${order.length} 根，${Math.round(dist)} 格外`,
        });
    }

    // 排序：距离绝对优先，产出只在距离相近时做次要参考。
    // 实测教训：玩家说「砍我旁边的树」时，为远处大树而搭桥过去是错的。
    trees.sort((a, b) => {
        if (Math.abs(a.dist - b.dist) > 5) return a.dist - b.dist;
        return b.logs - a.logs;
    });

    const totalLogs = trees.reduce((s, t) => s + t.logs, 0);
    return { trees: trees.slice(0, maxTrees), totalLogs, planned: Math.min(trees.length, maxTrees), skipped };
}

/** 规划摘要（给模型/日志读）。 */
export function describeSurvey(plan) {
    if (!plan.trees.length) return '附近没有能砍的天然树。';
    const head = `发现 ${plan.trees.length} 处原木，共约 ${plan.totalLogs} 根。`;
    const top = plan.trees.slice(0, 3)
        .map(t => `(${Math.round(t.dist)}格外 ${t.logs}根)`).join('、');
    return `${head} 先砍：${top}`;
}
