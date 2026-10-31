/**
 * A15 分类判断：这是天然树还是房子 / 这是受保护地点吗。
 *
 * 为什么单独一个原子（见 复合层改造规划 §6 的判据）：
 *   这两个都是**纯查询判断**——只读世界、无副作用、能单独跑、能单独测。
 *   之前埋在 task_collect.js 里（60-128 行），只有采集能用。
 *   而"这是天然结构还是人造结构"的判断以后做矿脉采集也会用到。
 *
 * 判断口诀（规划 §6）：单独跑有没有意义？能单独跑、能单独测 → 原子。
 */
import { ok, fail } from './atom_contract.js';
import { blockAt } from './atom_perceive.js';

// ---------------------------------------------------------------------------
// 「这是天然树还是房子」
// ---------------------------------------------------------------------------
//
// 原木是最难判的方块：树的树干是原木，房子的柱子也是原木。
// 单看材料名判不出来（world_model 里明确写了「不要把原木放进玩家材料」）。
// 所以用两个信号：
//   1) 附近有树叶 → 大概率是天然树（树冠）
//   2) 周围人工材料很少 → 不是房子的一部分

const LEAF_SUFFIX = /_leaves$/;
const ARTIFICIAL = /(_planks$|_bricks$|_glass|_wool$|_concrete|_terracotta$|_carpet$|_stairs$|_slab$|_door$|_trapdoor$|_fence|_bed$|_sign$|chest$|barrel$|furnace$|crafting_table$|bookshelf|lantern$|torch$|_button$|_lever$|_pressure_plate$)/;

/**
 * 这块原木像不像「天然树」。
 *
 * 阈值来自真实存档统计（7594 根原木）：
 *   水平 ±2、垂直 -2..+5  → 通过 86%，误拒 1037 根
 *   水平 ±5、垂直 -2..+10 → 通过 97.3%，误拒 177 根
 * 大树的树冠半径常有 3~5 格、垂直延伸到树干上方 8~10 格，
 * 窗口太小会把「有树冠的树」判成「没有树冠」，于是站在树前不肯砍。
 *
 * 性能：11×11×13 = 1573 次方块查询，比原来（5×5×8=200）多 8 倍，
 * 所以先扫近处（±2），确认有树冠就提前返回；没有才扩大范围。
 *
 * @returns ActionResult
 *   ok → data: { isTree, why, leaves, artificial }
 */
export function classifyLog(bot, pos, opts = {}) {
    const { nearRadius = 2, farRadius = 5, minLeaves = 3, maxArtificial = 6 } = opts;

    const p = floor(pos);
    if (!p) return fail('INTERNAL', '坐标无效');

    const b0 = blockAt(bot, p);
    if (!b0) return fail('NO_TARGET', '那个位置没有方块');
    if (!/_log$|_stem$/.test(b0.name)) {
        return fail('NO_TARGET', `${b0.name} 不是原木/菌柄`, { classifiedBlock: b0.name });
    }

    let leaves = 0;
    let artificial = 0;

    const scan = (rx, ry0, ry1) => {
        for (let dx = -rx; dx <= rx; dx++) {
            for (let dz = -rx; dz <= rx; dz++) {
                for (let dy = ry0; dy <= ry1; dy++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const b = blockAt(bot, { x: p.x + dx, y: p.y + dy, z: p.z + dz });
                    if (!b) continue;
                    if (LEAF_SUFFIX.test(b.name)) leaves++;
                    else if (ARTIFICIAL.test(b.name)) artificial++;
                }
            }
        }
    };

    scan(nearRadius, -2, 5);
    if (leaves < minLeaves) scan(farRadius, -2, 10);   // 不够才扩大

    // 真实数据：人工材料 0 个的占 99.8%，>2 的只有 13 根（占 0.2%）。
    // 扩大窗口后会扫到更多人工方块（火把/木板），所以阈值放到 6，
    // 同时保留「明显是房子」的判据（>10 才算整根埋在人造结构里）。
    const isTree = leaves >= minLeaves && artificial <= maxArtificial;
    const why = isTree ? `有树冠(${leaves})`
        : leaves < minLeaves ? `没树冠(${leaves} 片叶，人工材料 ${artificial})`
            : `像是房子(人工材料 ${artificial})`;

    return ok({ isTree, why, leaves, artificial, classifiedBlock: b0.name, pos: p });
}

// ---------------------------------------------------------------------------
// 「这是受保护地点吗」
// ---------------------------------------------------------------------------
//
// 记住的地点（家、仓库、箱子）周围一律不挖——用户的东西不能被"砍树"砍掉。

const withinBox = (a, b, r) => Math.abs(a.x - b.x) <= r && Math.abs(a.y - b.y) <= r && Math.abs(a.z - b.z) <= r;

/**
 * 这个坐标是否在受保护的地标附近。
 *
 * ★ 原子层规范化（2026-10-31）：**本函数不再读盘、不再持有缓存**。
 *
 * 原来它自己 `loadLandmarks(bot)` 并用模块级变量 `landmarkCache` 缓存 60 秒。
 * 两个毛病（ARCHITECTURE_REDESIGN §6.1 明令禁止）：
 *   1. 原子读写全局状态 —— 模块级缓存就是全局状态，测试之间会互相污染；
 *   2. 缓存不区分 bot —— 多 Bot 时后连的那个会读到前一个的地标。
 * 现在"加载 + 缓存"归数据层 `landmarks.protectedPlaces(bot)`，
 * 本函数只接收算好的地标列表，是纯判断。
 *
 * @param {{x:number,y:number,z:number}} pos
 * @param {{spots?:Array<{x,y,z}>, radius?:number}} opts
 * @returns ActionResult
 *   ok → data: { protectedBy, radius, spot }（不在受保护范围时 protectedBy 为 null）
 */
export function isProtected(pos, opts = {}) {
    const { spots = [], radius = 6 } = opts;
    const p = floor(pos);
    if (!p) return fail('INTERNAL', '坐标无效');

    for (const s of spots) {
        if (s && withinBox(s, p, radius)) {
            return ok({ protectedBy: 'landmark', radius, spot: { x: s.x, y: s.y, z: s.z }, pos: p });
        }
    }
    return ok({ protectedBy: null, radius, spot: null, pos: p });
}

// ---------------------------------------------------------------------------

function floor(p) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}
