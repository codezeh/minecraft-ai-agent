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
import { ok, fail } from './contract.js';
import { canStand } from './query_stand.js';
import { blockAt } from './query_perceive.js';

/** 默认阈值：低于这个加权位移就算"没动"。 */
export const DEFAULT_MIN_MOVE = 2;
/** 垂直位移权重：1 格垂直 = 1.5 格水平。 */
export const DEFAULT_VERTICAL_WEIGHT = 1.5;

/** 空气/可穿过的判定（找地表那一段用）。 */
const AIRY = new Set(['air', 'cave_air', 'void_air']);

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

// ---------------------------------------------------------------------------
// 被困检测（从 task_follow 的 110 行 BFS 提出来的）
// ---------------------------------------------------------------------------
//
// 原来这段整块埋在 `task_follow.goToPlayer` 里（约 :321-433），而它是**纯读世界**：
//   walkable() 判能不能站、泛洪算可达面积、往上扫找地表、探 8 向判有没有水平出口。
// 三个后果（REFACTOR_ANALYSIS §5 Phase4 点了名）：
//   1. 只读逻辑和"要不要挖、挖到哪"的决策混在一起，没法单独测；
//   2. `walkable` 与 `atom_stand.canStand` 是同一件事的两套实现；
//   3. 换一次判据就得改那个 600 行的文件（历史上为此改了 5 次：第十二~十七次修）。
//
// 现在：本函数只回答事实（面积多大、有没有封顶、有没有水平出口、地表在哪、该挖到多高），
// 决策（判 trapped、调 skill_escape）仍然在 task_follow 里。

/**
 * 她是不是被困住了 —— 只读世界，不动任何方块。
 *
 * 判据沿用的是实测演进出来的那一套，别随手改（每条都有踩坑记录）：
 *   - 只看"可达面积"会误判：站在 3×3 平台上（面积 9）上方开阔、四周能跳下去，不算被困
 *   - 只看"头顶遮挡"会误判：挖穿石层后头顶开阔了，人还在 1×1 竖井里（实测）
 *   - 所以：**面积小 且（四周封死 或 头顶有遮挡）**
 *
 * ⚠️ 站立判据统一用 `atom_stand.canStand`（原来这里自己写了个 `walkable`）。
 *    一处已知差异：脚位是水、下方是实心时，canStand 判"可站"、旧 walkable 判"不可站"。
 *    对泛洪的影响是"偶尔多算水格"，方向上是**更少**误判被困，可以接受。
 *
 * @param {object} bot
 * @param {object} opts
 *   maxCells     泛洪上限，默认 1500（实测几毫秒）
 *   maxSteps     扩张步数上限，默认 6000
 *   trappedArea  面积阈值，默认 300（小于它才可能算被困）
 *   scanUp       往上找地表的格数，默认 96
 *   probeRadius  水平探出口的半径，默认 8
 * @returns ActionResult
 *   ok → data: { area, reach, ceilingAt, surfaceY, walled, openDirs, capped, trapped, goalY }
 *        surfaceY 为 null 表示没找到地表（goalY 退化为 当前+12）
 */
export function detectTrapped(bot, opts = {}) {
    const {
        maxCells = 1500, maxSteps = 6000, trappedArea = 300,
        scanUp = 96, probeRadius = 8,
    } = opts;

    const pos = bot?.entity?.position;
    if (!finite(pos)) return fail('INTERNAL', '读不到她的位置');

    const px = Math.floor(pos.x);
    const py = Math.floor(pos.y);
    const pz = Math.floor(pos.z);

    /** 这一格能不能站（统一走 canStand，别再造一份 walkable）。 */
    const standable = (x, y, z) => {
        try {
            const r = canStand(bot, { x, y, z });
            return r.ok && r.data?.standable === true;
        } catch { return false; }
    };

    // ---- 1) 泛洪：可达面积 + 最远水平距离 ----
    let area = 0;
    let reach = 0;
    try {
        const seen = new Set([`${px},${py},${pz}`]);
        const queue = [{ x: px, y: py, z: pz }];
        let steps = 0;
        while (queue.length && seen.size < maxCells && steps < maxSteps) {
            const c = queue.shift();
            steps++;
            const d = Math.hypot(c.x - px, c.z - pz);
            if (d > reach) reach = d;
            for (const [dx, dz, dy] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const nx = c.x + dx, ny = c.y + dy, nz = c.z + dz;
                const k = `${nx},${ny},${nz}`;
                if (seen.has(k)) continue;
                if (!standable(nx, ny, nz)) continue;
                seen.add(k);
                queue.push({ x: nx, y: ny, z: nz });
            }
        }
        area = seen.size;
    } catch { /* 读不到就按 0 算 */ }

    // ---- 2) 往上扫：头顶第一格实心 + 第一段连续 3 格空气（= 真地表）----
    //
    // 为什么找"连续 3 格空气"而不是"头顶第一格实心"：
    //   实测她在 y=58，头顶 59 空、60~67 stone、68~70 土、71 草、72+ 天空。
    //   旧代码把 y=60 当天花板 → goalY=62 → 挖 2 层就"到目标高度"停下，
    //   永远只挖 4 格然后重新判困，死循环。
    let ceilingAt = null;
    let surfaceY = null;
    try {
        let airRun = 0;
        for (let dy = 1; dy <= scanUp; dy++) {
            const b = blockAt(bot, { x: px, y: py + dy, z: pz });
            if (!b) break;
            const isAir = AIRY.has(b.name);
            if (!isAir) {
                if (ceilingAt == null) ceilingAt = py + dy;
                airRun = 0;
            } else {
                airRun++;
                if (airRun >= 3 && surfaceY == null) {
                    surfaceY = py + dy - airRun + 1;   // 这段空气的起点
                    break;
                }
            }
        }
    } catch { /* 读不到就当没有地表 */ }

    // ---- 3) 水平探出口：8 向 × radius，同层或往下 1~2 格有没有能站的 ----
    let openDirs = 0;
    try {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1],
                                [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            for (let r = 1; r <= probeRadius; r++) {
                const nx = px + dx * r, nz = pz + dz * r;
                if (standable(nx, py, nz) || standable(nx, py - 1, nz) || standable(nx, py - 2, nz)) {
                    openDirs++;
                    break;
                }
            }
        }
    } catch { /* 读不到就当封闭 */ }

    // ⚠️ 已知弱点（继承自原实现，本次不改以免变行为）——两条：
    //   1. 探的是"probeRadius(8) 格内有没有能站的地方"，**不管走不走得到**。
    //      所以封闭小房间能探出 openDirs>0（房间内部自己的格子也算），
    //      竖井若 8 格内有开阔地也会被判"能走开"。
    //   2. 反过来，这条"看得到够不着"的能力又是必需的：
    //      站在 3×3 悬空平台上（可达 9 格），只有靠它才能发现"4 格外有地面、能跳下去"，
    //      否则会被误判成被困然后原地往上挖。
    //   两条互相拉扯，正确解法是"带坠落/跳跃的可达性"，那是重做判据 + 真机基线的事。
    //   本次只做"提取成原子"，判据原样保留。
    const walled = openDirs === 0;
    const capped = ceilingAt != null;
    const trapped = area < trappedArea && (walled || capped);
    const goalY = surfaceY != null ? surfaceY + 2 : py + 12;

    return ok({ area, reach, ceilingAt, surfaceY, walled, openDirs, capped, trapped, goalY });
}
