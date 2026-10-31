/**
 * A33 卡住检测：这一步到底算不算"动了"。
 *
 * 为什么单独一个原子（REFACTOR_ANALYSIS §5 Phase 2.2 P0）：
 *   原来这段判断硬编码在 executor 的 walkTo 主循环里（`Math.hypot(dx,dz) + |dy|*1.5 < 2`），
 *   三个问题：
 *     1. 阈值 2 / 权重 1.5 是**魔数**，藏在循环里没人知道为什么是这个数；
 *     2. task_follow 里另有一套"被困 BFS"，判据完全不一样（那边用 110 行 BFS）；
 *     3. 纯查询，能单独跑、能单独测 —— 按判据就该是原子（不是策略）。
 *
 * 语义（沿用实测结论，不重新发明）：
 *   - 水平位移按 1:1
 *   - **垂直位移权重 1.5**：实测"挖上去 1 格"曾被判成没动，
 *     因为旧代码只算 hypot(dx,dz)，垂直完全不进判据 → 连续 3 次误判 NO_REACH，
 *     而她明明在往上爬（y 55→70 全靠这个）。
 *
 * 注意：本原子只回答"算不算动了"，**不做决定**（连续几次才放弃是策略层的事）。
 */
import { ok } from './atom_contract.js';

/** 默认阈值：低于这个加权位移就算"没动"。 */
export const DEFAULT_MIN_MOVE = 2;
/** 垂直位移权重：1 格垂直 = 1.5 格水平。 */
export const DEFAULT_VERTICAL_WEIGHT = 1.5;

/** 坐标是否可用（NaN 会污染一切比较，返回 false 而不是算出 NaN）。 */
function finite(p) {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/**
 * 从 from 到 to 的**加权位移**（水平 1:1 + 垂直 × weight）。
 *
 * @param {{x,y,z}} from
 * @param {{x,y,z}} to
 * @param {{verticalWeight?:number}} opts
 * @returns {number} 加权位移；坐标无效时返回 0（当作"没动"，让上层保守处理）
 */
export function weightedMove(from, to, opts = {}) {
    const { verticalWeight = DEFAULT_VERTICAL_WEIGHT } = opts;
    if (!finite(from) || !finite(to)) return 0;
    const horiz = Math.hypot(to.x - from.x, to.z - from.z);
    const vert = Math.abs(to.y - from.y);
    return horiz + vert * verticalWeight;
}

/**
 * 这一步"动了吗"。
 *
 * @param {{x,y,z}} from 上一步的位置
 * @param {{x,y,z}} to 现在的位置
 * @param {{minMove?:number, verticalWeight?:number}} opts
 * @returns ActionResult
 *   ok → data: { moved:boolean, gap:number, horiz:number, vert:number, minMove, verticalWeight }
 *        gap 是加权位移，方便调用方打日志/做诊断
 */
export function movedEnough(from, to, opts = {}) {
    const { minMove = DEFAULT_MIN_MOVE, verticalWeight = DEFAULT_VERTICAL_WEIGHT } = opts;
    if (!finite(from) || !finite(to)) {
        return ok({ moved: false, gap: 0, horiz: 0, vert: 0, minMove, verticalWeight, why: '坐标无效' });
    }
    const horiz = Math.hypot(to.x - from.x, to.z - from.z);
    const vert = Math.abs(to.y - from.y);
    const gap = horiz + vert * verticalWeight;
    return ok({ moved: gap >= minMove, gap, horiz, vert, minMove, verticalWeight });
}

/**
 * 真实位移（**不算权重**，只用来累计"走了多少格"）。
 *
 * 与 weightedMove 分开是有原因的：判"卡住"要给垂直加权（防止误判），
 * 而汇报"走了多少格"必须是真实距离（否则日志里的数字会虚高）。
 *
 * @param {{x,y,z}} from
 * @param {{x,y,z}} to
 * @returns {number}
 */
export function realMove(from, to) {
    if (!finite(from) || !finite(to)) return 0;
    return Math.hypot(to.x - from.x, to.z - from.z) + Math.abs(to.y - from.y);
}
