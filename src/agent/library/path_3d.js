/**
 * 3D 体素规划器 —— 在真实 3D 空间里找路（terrain3d 数据）。
 *
 * ★ 2026-10-27 新建，取代 tile_map 的 16 格战棋格 A*。
 *
 * 为什么必须换（今晚的实测，反复出现）：
 *   2.5D 地图说她站的地方「72.7% 连通可走、代价 1」，
 *   真 3D 一扫：y=60 这一层**全图只有 1 个可站立面**（就是她脚下），
 *   上下各有一层开放空间（y=44 有 103 个面、y=70 有 102 个面）。
 *   也就是说：区块统计永远看不见"这一层是孤点"这件事。
 *   → 于是「规划=OK，执行=NO_PATH」反复循环，位移 0.2~1 格。
 *
 * 本模块怎么走：
 *   节点 = (x, y, z) 一个**可站立面**（terrain3d 里的一条记录）
 *   邻居 = 6 个水平方向 + 上 1 格（跳）+ 下 1~3 格（掉）
 *   代价 = 平地 1 / 上 1 格 2.5 / 上 2 格 8.5 / 上 3+ 递增 / 掉落 1+0.3Δ
 *   挖通 = 目标格没有面时，允许"挖上去"（代价 = 挖的格数 × DIG_COST）
 *   禁行 = 岩浆
 *
 * 存储解码：不把整个库读进内存（4095 区块 × 458 面 ≈ 187 万），
 * 只把**搜索范围**（起点到终点包围盒外扩几格）读进来，形成稀疏 Map。
 */
import { boxSurfaces, readFails, T } from './terrain3d.js';

/** 代价常量（与旧 tile_map 的连续代价同源，便于对照） */
export const C3 = {
    flat: 1,          // 平走
    up1: 2.5,         // 上 1 格（跳）
    up2: 8.5,         // 上 2 格（要垫一块）
    upBase: 8.5,      // 上 3+ 的起点
    upPerExtra: 12,   // 每多上 1 格
    downBase: 1,      // 下落基础代价
    // 每下落 1 格。
    //
    // ★ 2026-10-28：试过把它从 0.3 提高到 1.2（假设"A* 贪图下坡便宜，
    // 所以宁愿跳坑不绕路"），但 A/B 实测否定了这个假设：
    //   下坡 0 → 绕路比 1.590
    //   下坡 0.3 → 1.589
    //   下坡 1.2 → 1.588
    //   下坡 5.0 → 1.638（反而更差）
    // 影响在 0.002 以内，说明绕路比高**不是**下坡便宜造成的 ——
    // 那些样本（下坠 50 格、绕路比 4.15）是地形本身只有那一条路。
    // 所以维持 0.3（原值），不做无依据的改动。
    downPer: 0.3,     // 每下落 1 格
    digPer: 5,        // 挖穿 1 格的代价（与 digCost=5 一致）
    // ★ 2026-10-28 新增：每攀爬 1 格的代价。
    // 定 1.5 的理由：走路 1/格，攀爬比走慢但不用挖（挖 5/格）。
    // 1.5 让"有藤蔓就爬"成立，同时不会为了省几步平地绕远路去爬藤。
    climbPer: 1.5,
    placePer: 3,      // 垫 1 块的代价
    forbidden: Infinity,
};

/** 上 1 格的实际代价（含跳跃的体力/时间） */
function stepCost(dy) {
    if (dy === 0) return C3.flat;
    if (dy > 0) {
        if (dy === 1) return C3.up1;
        if (dy === 2) return C3.up2;
        return C3.upBase + C3.upPerExtra * (dy - 2);   // 3+ 格：必须挖/垫多次
    }
    const d = -dy;
    return C3.downBase + C3.downPer * d;
}

/** 极简二叉堆 */
class Heap {
    constructor() { this.a = []; }
    push(n) {
        const a = this.a; a.push(n);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].f <= a[i].f) break;
            [a[p], a[i]] = [a[i], a[p]]; i = p;
        }
    }
    pop() {
        const a = this.a;
        if (!a.length) return null;
        const top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l].f < a[m].f) m = l;
                if (r < a.length && a[r].f < a[m].f) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]]; i = m;
            }
        }
        return top;
    }
    get size() { return this.a.length; }
}

const key = (x, y, z) => `${x},${y},${z}`;

/**
 * 在 3D 数据里规划一条路。
 *
 * @param {string} baseDir terrain3d.db 所在目录
 * @param {{x:number,y:number,z:number}} from 起点（她的脚）
 * @param {{x:number,y:number,z:number}|null} to 终点；null = 只找"出口"（去最近的大片开阔区）
 * @param {{maxNodes?:number, maxDrop?:number, maxClimb?:number, margin?:number}} opts
 * @returns {{ok:boolean, code?:string, path:Array<{x,y,z,action}>, nodes:number, cost:number, surfaces:number}}
 */
export function plan3D(baseDir, from, to, opts = {}) {
    const {
        maxNodes = 120000,
        maxDrop = 4,          // 一次最多往下掉 4 格
        maxClimb = 3,         // 一次最多往上跳/垫 3 格
        margin = 24,          // 搜索包围盒外扩
        prefer = null,        // 找出口时的方向偏好 {x,z}：只往这个方向的半球找
        diag = true,          // 是否允许对角线移动（基准测试用这个做 A/B 对比）
    } = opts;

    const sx = Math.floor(from.x), sy = Math.floor(from.y), sz = Math.floor(from.z);
    const tx = to ? Math.floor(to.x) : null;
    const ty = to ? Math.floor(to.y) : null;
    const tz = to ? Math.floor(to.z) : null;

    // ---- 载入搜索范围的面（稀疏 Map: key -> type） ----
    const x0 = Math.min(sx, tx ?? sx) - margin;
    const x1 = Math.max(sx, tx ?? sx) + margin;
    const z0 = Math.min(sz, tz ?? sz) - margin;
    const z1 = Math.max(sz, tz ?? sz) + margin;
    const yLo = Math.min(sy, ty ?? sy) - 40;
    const yHi = Math.max(sy, ty ?? sy) + 40;

    const rows = boxSurfaces(baseDir, x0, z0, x1, z1, yLo, yHi);
    const surf = new Map();
    for (const r of rows) surf.set(key(r.x, r.y, r.z), r.t);

    // ★ 2026-10-28 新增：读失败记忆。
    //
    // 实测问题：执行层发现某格走不到就 forgetSurface 删掉它，
    // 但 scanSphere 下一轮把同一格写回来 → 规划每轮给同一个不可达点 → 无限循环。
    // 现在改用"加权"而不是"删除"：失败过的格子代价 ×(1 + hits)，仍可走但极不优先。
    // 这样既不会被扫描覆盖，也不会因为一次偶发失败把唯一通路彻底封死。
    let fails = new Map();
    try { fails = readFails(baseDir); } catch { /* 读不到就不加价 */ }
    if (!surf.size) {
        return { ok: false, code: 'NO_DATA', path: [], nodes: 0, cost: Infinity, surfaces: 0 };
    }

    // 起点必须在面上；不在就就近找最近的面。
    //
    // ★ 2026-10-29 修：**上下都要找，不能只往下**。
    //
    // 实测（302 格长规划，第 17~21 轮全卡同一点）：
    //   她浮在水面，精确 y = 61.99 → Math.floor = 61；
    //   而库里那一列的水面记的是 y=62（水面方块本身的 y）。
    //   旧逻辑只往 -3 方向找，往下找到 y=59（水下地面，正好在 2 格容差内），
    //   于是整条路径从水底 y=59 算起 —— 但她浮在 y=62 根本下不去，
    //   每轮报 `HEIGHT_MISS 该降到 y=59，实际停在 y=62`。
    //
    // 现在按"离她脚最近"排序（同层优先，其次上/下 1 格…），
    // 浮点误差不会再把她锁到下一层去。
    let start = null;
    {
        let bestD = Infinity;
        for (const d of [0, 1, -1, 2, -2, -3]) {
            const yy = sy + d;
            if (!surf.has(key(sx, yy, sz))) continue;
            if (Math.abs(d) < bestD) { bestD = Math.abs(d); start = { x: sx, y: yy, z: sz }; }
        }
    }
    if (!start) {
        // ★ 2026-10-27 第二十七次修：**不许乱找起点**。
        //
        // 实测灾难：她在 y=76，但那一格没有面（脚下是半格/未记录）。
        // 旧逻辑"找这一列最近的面"找到了 y=59（往下 17 格），
        // 于是规划出的整条路径都在 y=59 附近，她照做就往下掉 ——
        // 日志里「路径目标只 0.8 格外」就是因为她已经走到目标旁边的另一层。
        //
        // 正确做法：只在**她脚下方 1~2 格**找（允许半格误差），
        // 找不到就老实报 NO_START，让上层去重扫/处理。
        let best = null, bestD = Infinity;
        for (const k of surf.keys()) {
            const [kx, ky, kz] = k.split(',').map(Number);
            if (kx !== sx || kz !== sz) continue;
            const d = Math.abs(ky - sy);
            if (d <= 2 && d < bestD) { bestD = d; best = { x: kx, y: ky, z: kz }; }
        }
        start = best;
    }
    if (!start) {
        return { ok: false, code: 'NO_START', path: [], nodes: 0, cost: Infinity, surfaces: surf.size };
    }

    // ★ 2026-10-27 修：目标不在面上时，**在目标附近找最近的面**当实际终点。
    //
    // 之前的 bug：`goalKey = surf.has(...) ? ... : null`，
    // 目标 (x, 45, z) 不在面上（那列只有 y=70 和 y=18）→ goalKey=null，
    // 而 tx != null 又走不到"找出口"分支 → **既无终点判断也无出口判断**
    // → A* 耗尽队列返回 NO_PATH。实测就是这样：5779 个面、5825 个节点，然后 NO_PATH。
    //
    // 现在：目标进不了就退而求其次，找它周围 4 格内最近的面（同一目标列优先）。
    let goalKey = null;
    let goalPos = null;
    if (to) {
        if (surf.has(key(tx, ty, tz))) {
            goalKey = key(tx, ty, tz);
            goalPos = { x: tx, y: ty, z: tz };
        } else {
            let bestD = Infinity;
            for (const k of surf.keys()) {
                const [kx, ky, kz] = k.split(',').map(Number);
                const dh = Math.hypot(kx - tx, kz - tz);
                if (dh > 4) continue;                 // 只接受目标附近 4 格内
                const dv = Math.abs(ky - ty);
                const d = dh * 2 + dv;                // 水平距离优先，高度次之
                if (d < bestD) { bestD = d; goalKey = k; goalPos = { x: kx, y: ky, z: kz }; }
            }
        }
    }

    // ---- A* ----
    // ★ 2026-10-27 修：启发式**必须偏向朝目标前进**，否则 A* 会先绕远再折返。
    //
    // 实测：从 (-89.5,50,-231.6) 到 (-73.5,50,-231.5)（目标在东边 16 格），
    // A* 给出的前 3 步是 **向西** (-91,-92,-93) 再下到 y=44 的洞穴，
    // 累计走 10 格时净位移只有 2.6 格 —— 于是"路径目标只 2.6 格外"，
    // 调用方判定 TOO_CLOSE，原地死循环。
    //
    // 原因：高度差权重 0.8 太大，等于告诉 A*"绕 1 格高度差比多走 0.8 格划算"，
    // 而实际上向下钻 5 格换来的水平绕路，对她毫无意义。
    // 水平距离才是主要目标，高度差只做轻微修正（0.25）。
    // 另外给 h 乘 1.3 的权重（Baritone 的 hWeight 思路），让搜索更贪心、少绕路。
    const h = (x, y, z) => {
        if (tx != null) return (Math.hypot(x - tx, z - tz) + Math.abs(y - ty) * 0.25) * 1.3;
        // 没终点但给了方向偏好：越倾向那个方向，启发值越小（保证不会走反）
        if (prefer) {
            const dx = prefer.x - start.x, dz = prefer.z - start.z;
            const len = Math.hypot(dx, dz) || 1;
            const prog = ((x - start.x) * dx + (z - start.z) * dz) / len;   // 朝偏好的投影
            return Math.max(0, 60 - prog);                                    // 越往前越小
        }
        return 0;
    };

    const open = new Heap();
    const seen = new Map();      // key -> 最小 g
    const came = new Map();      // key -> {parent, action}
    const startK = key(start.x, start.y, start.z);
    seen.set(startK, 0);
    came.set(startK, { parent: null, action: 'start' });
    open.push({ x: start.x, y: start.y, z: start.z, g: 0, f: h(start.x, start.y, start.z) });

    let nodes = 0, found = null;

    while (open.size && nodes < maxNodes) {
        const cur = open.pop();
        if (!cur) break;
        nodes++;
        const ck = key(cur.x, cur.y, cur.z);
        if (cur.g > (seen.get(ck) ?? Infinity)) continue;      // 过期节点

        if (goalKey && ck === goalKey) { found = cur; break; }

        // 没指定终点时：站在"周围有 >=6 个同层邻居"的位置就当找到了出口
        if (!goalKey && tx == null) {
            let n6 = 0;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (surf.has(key(cur.x + dx, cur.y, cur.z + dz))) n6++;
                if (surf.has(key(cur.x + dx * 2, cur.y, cur.z + dz * 2))) n6++;
            }
            if (n6 >= 6) {
                // ★ 2026-10-27 第二十三次修：出口条件加两个约束，否则她会往下钻。
                //
                // 实测：她 y=44，全网"最开阔"的位置是 y=31（下方 13 格）的洞穴。
                // 只按"周围邻居多"找，就会往地下跑 —— 而目标（探针）在 y=64 地表。
                //
                // 约束 1：**方向**必须朝目标至少前进 3 格（不然可能走反）
                // 约束 2：**高度**不能比起点低超过 6 格（往下钻不是出路）
                if (prefer) {
                    const dx = prefer.x - start.x, dz = prefer.z - start.z;
                    const len = Math.hypot(dx, dz) || 1;
                    const prog = ((cur.x - start.x) * dx + (cur.z - start.z) * dz) / len;
                    if (prog < 3) continue;
                }
                if (cur.y < start.y - 6) continue;      // 别往深处钻
                found = cur; break;
            }
        }

        // ---- 邻居：8 方向（含对角线）+ 上跳 + 下降 ----
        //
        // ★ 2026-10-28 优化：加入对角线移动。
        // 实测（tools/probe_planner_quality.mjs）：只走 4 方向时
        //   平均绕路比 1.40（1.0 = 直线），平均转向 7.8 次/段，
        //   南向绕路比 2.06、转向 13 次 —— 路径呈阶梯状，执行层频繁启停。
        // 加入对角线后同样地形可走直线，转向大幅减少。
        //
        // 对角线规则（不能穿墙角）：
        //   目标格可走，且两个正交邻格也都可以走（否则会"切角"穿过墙缝）
        const DIRS = diag ? [
            [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],           // 4 正方向，代价 ×1
            [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],  // 4 对角，代价 ×1.414
        ] : [
            [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],           // 只走 4 正方向
        ];
        const cand = [];
        for (const [dx, dz, mult] of DIRS) {
            const isDiag = dx !== 0 && dz !== 0;
            // 对角必须先确认两个正交邻格可走（防止切角穿墙）
            if (isDiag) {
                const sideA = surf.has(key(cur.x + dx, cur.y, cur.z));
                const sideB = surf.has(key(cur.x, cur.y, cur.z + dz));
                if (!sideA || !sideB) continue;
            }
            // 水平：在同一 y 或相邻 y 找面（真实地形有台阶）
            for (let dy = -maxDrop; dy <= maxClimb; dy++) {
                const ny = cur.y + dy;
                const k = key(cur.x + dx, ny, cur.z + dz);
                if (surf.has(k)) {
                    const t = surf.get(k);
                    if (t === T.LAVA) continue;

                    // ★ 2026-10-28 修：**水下的地面不能当落脚点**。
                    //
                    // 实测（HEIGHT_MISS 诊断反复出现）：
                    //   目标y=58 实际y=62 | 脚下=water 身=air inWater=true
                    // 地形：y=62 水面、y=58 水底。规划选了 y=58（水底沙地，代价 1/格），
                    // 但执行层**没有潜水能力** —— moveToXZ 只处理 x/z，
                    // 她在水面浮着走，永远到不了 y=58。
                    //
                    // 判据：如果目标面的**正上方那格是水**，说明它沉在水里。
                    //      这种面只有"从水下走过去"才达得到，执行层做不到，直接不生成边。
                    //      例外：她当前就在水下（curT 也是水下方）→ 允许（已经在水里了）。
                    const above = surf.get(key(cur.x + dx, ny + 1, cur.z + dz));
                    const submerged = above === T.WATER;
                    const curAbove = surf.get(key(cur.x, cur.y + 1, cur.z));
                    const iAmSubmerged = curAbove === T.WATER;
                    if (submerged && !iAmSubmerged) continue;
                    // 对角线在高度差上更保守：上下超过 1 格就不走对角（容易卡）
                    // 2026-10-28 修：大幅下降时不能穿墙。
                    // 实测 bug（写攀爬测试时暴露的，与攀爬无关，是老问题）：
                    //   竖井 (5,59,5) -> down -> (6,55,5) -> down -> (5,51,5)
                    //   x=6 是井壁（y=51..58 全实心），路径却"水平 1 格 + 下降 4 格"穿过去。
                    // 原因：这里只检查目标格有没有面，不检查下降路径是否通畅。
                    // 修法：|dy| > 1 时要求目标列在 (lo, hi) 之间没有实心面。
                    if (Math.abs(dy) > 1) {
                        const lo = Math.min(ny, cur.y), hi = Math.max(ny, cur.y);
                        let blocked = false;
                        for (let yy = lo + 1; yy < hi; yy++) {
                            const tb = surf.get(key(cur.x + dx, yy, cur.z + dz));
                            if (tb !== undefined && tb !== T.LAVA && tb !== T.WATER && tb !== T.CLIMBABLE) {
                                blocked = true;
                                break;
                            }
                        }
                        if (blocked) continue;
                    }
                    if (isDiag && Math.abs(dy) > 1) continue;
                    let c = stepCost(dy) * mult;
                    // ★ 2026-10-29 修：**CLIMBABLE 不能当水平移动的落脚点**。
                    //
                    // 设计上早就写明"藤蔓/梯子只是通道，不是地面"，
                    // 但水平边这里没拦，于是生成 walk→(-123,61) 走进藤蔓格，
                    // 再 climb→(-123,63)。她站在藤蔓格里脚下没有支撑，
                    // 直接滑到 y=59 够不到，报 `爬了 8000ms 没上去`。
                    //
                    // 藤蔓格只能通过 climb 边进入（见下方攀爬段），不能走进去。
                    if (t === T.CLIMBABLE) continue;

                    // ★ 2026-10-29 修：**落脚点上方是岩浆的，不能走**。
                    //
                    // 实测现场（长规划第 8 轮反复 NO_PATH）：
                    //   (-49,-250) 真实地形：y=63 lava，y=62 stone —— 水下岩浆湖。
                    // 3D 库只记了 y=62 的石头面（水面/岩浆层记成 y=63 t=2），
                    // 规划器把 y=62 当安全落脚点，于是规划出"走过去"的路径；
                    // 而 pathfinder 面对真实世界正确拒绝 → 连续 NO_PATH。
                    //
                    // 判据：目标格的**正上方**是岩浆 → 这条边不生成。
                    // 岩浆只在头顶不碰身体时也可能致命（走过去就会被点燃/陷入），
                    // 所以宁可绕路。
                    if (surf.get(key(cur.x + dx, ny + 1, cur.z + dz)) === T.LAVA) continue;


                    // 水面代价 0.8（≈陆地）。
                    //
                    // 为什么必须这么低：只要水面明显贵于陆地，A* 就会选"潜到水底走"
                    // （水下地面 1/格，下潜+上浮各只算 1~2，合计约 9，比走 5 格水面便宜）。
                    // 而她**能浮着走过整个湖**、**做不到潜水**（执行层没有潜水能力），
                    // 所以"潜底"路线是必定失败的路线：
                    // 实测会连续报 `HEIGHT_MISS 该降到 y=58，实际停在 y=62`。
                    //
                    // 试过 6 / 18 / 4，都仍然潜底；0.8 才让水面优先于潜水。
                    // 水真正该付出代价的是"入水/出水"的垂直变化，见 stepCost。
                    if (t === T.WATER) c += 0.8;
                    if (t === T.BUILT) c += 4;
                    // ★ 2026-10-29 新增：**沉在水下的地面，代价极高**。
                    //
                    // 背景：她的执行层没有潜水能力（按 shift 在深水里无效），
                    // 所以"规划让她下到水底"必然失败：
                    //   实测 `down(-86,58,-230) 失败: HEIGHT_MISS 该降到 y=58，实际停在 y=62`
                    //   诊断：脚下=water 身=air inWater=true —— 她浮在水面，下不去。
                    //
                    // 为什么不直接禁止：真实数据里 47.7%（24735/51871）的实心面在水下，
                    // 全禁会让她在水边无路可走。所以用**高代价**表达"能不走就不走，
                    // 实在没别的路才走"。
                    //
                    // 40 ≈ 绕 40 格平地的代价：足以让她优先绕路或浮水，
                    // 但如果那是唯一通路，她仍然会走（而不是报 NO_PATH 卡死）。
                    if (t === T.SUBMERGED) c += 40;
                    // 失败记忆：走过走不通的格子加价（不封死，留一次机会）
                    const fh = fails.get(k);
                    if (fh) c *= (1 + Math.min(fh, 5));
                    cand.push({ x: cur.x + dx, y: ny, z: cur.z + dz, cost: c, action: dy > 1 ? 'jump' : dy < 0 ? 'down' : 'walk' });
                }
            }
        }

        // 挖通：她上/下方若有更高的面，说明中间是实心层，可以挖穿过去。
        //
        // ★ 2026-10-27 修：原来**只允许同一列**挖通，导致斜着挖不出去。
        // 实测：她 y=49，16 格外最低的面是 y=61（高 12 格），
        //      maxClimb=3 爬不上，同列挖通又救不了 → 14581 节点后 NO_PATH。
        // 真实情况是"必须斜着挖一条台阶上去"，所以相邻列也要能挖。
        //
        // 限制：邻列挖通只在水平 1 格内（相邻 4 向），跳 2 格以上不生成，
        //      否则搜索分支爆炸。
        for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const kx = cur.x + dx, kz = cur.z + dz;
            // 只看这一列上比 maxClimb 更高、但不超过 40 格的面（够挖到的）
            for (let dy = maxClimb + 1; dy <= 40; dy++) {
                const k = key(kx, cur.y + dy, kz);
                if (!surf.has(k)) continue;
                const t = surf.get(k);
                if (t === T.LAVA) continue;
                // ★ 2026-10-28 修：**水里不能规划大幅度垂直挖通**。
                //
                // 实测（HEIGHT_MISS 诊断）：目标 y=47、实际 y=62，
                // 脚下/脚/身全是 water、inWater=true、onGround=false ——
                // 规划要她潜到水下 15 格，执行层根本做不到（没有潜水能力）。
                //
                // 判据：如果当前格或目标格在水里/上方，且落差 > 6，
                //       这条挖通边不生成。水里的大幅垂直移动对她是不可能的。
                const curT = surf.get(key(cur.x, cur.y, cur.z));
                const inWaterish = curT === T.WATER || t === T.WATER;
                if (inWaterish && dy > 6) continue;
                // 挖掉中间 dy 格；斜着挖略贵（要多挖一格落脚）
                const digCells = dy + (dx || dz ? 1 : 0);
                cand.push({
                    x: kx, y: cur.y + dy, z: kz,
                    cost: digCells * C3.digPer,
                    action: 'dig',
                });
                break;      // 每列只取最近的那个可挖面，避免同一列生成一堆边
            }
        }

        // ---- 攀爬：同一列的梯子 / 藤蔓 ----
        //
        // 2026-10-28 新增（用户原话：「藤蔓这个也困扰我们很久了」）。
        //
        // 语义与其它边不同（参考 baritone 的 src/movement/climb.js）：
        //   1) CLIMBABLE 节点**不是落脚点**，只能当通道。
        //      所以这里只生成 climb 边，绝不给它生成 walk/down 边。
        //   2) **向上一次只爬 1 格**（现实中就是一格一格爬），
        //      但**向下可以一次到底**（降到不能再降）—— 减少搜索深度。
        //   3) 代价 climbPer=1.5/格：比走慢，但远比挖通(5/格)便宜。
        {
            if (surf.get(key(cur.x, cur.y, cur.z)) === T.CLIMBABLE) {
                // 已在攀爬柱上：向上到顶
                let upY = cur.y;
                for (let d = 1; d <= 40; d++) {
                    const t2 = surf.get(key(cur.x, cur.y + d, cur.z));
                    if (t2 !== T.CLIMBABLE) break;
                    upY = cur.y + d;
                }
                if (upY > cur.y) {
                    cand.push({ x: cur.x, y: upY, z: cur.z,
                        cost: (upY - cur.y) * C3.climbPer, action: 'climb' });
                }
                // 向下一次到底
                let downY = cur.y;
                for (let d = 1; d <= 40; d++) {
                    const tv = surf.get(key(cur.x, cur.y - d, cur.z));
                    if (tv !== T.CLIMBABLE) break;
                    downY = cur.y - d;
                }
                if (downY < cur.y) {
                    cand.push({ x: cur.x, y: downY, z: cur.z,
                        cost: (cur.y - downY) * C3.climbPer * 0.7, action: 'climb' });
                }
            } else {
                // 从平地进入相邻的攀爬柱。
                //
                // 前提：攀爬柱必须是"从地面长上去"的，她才能跳进去抓住。
                // 实测反例：一根悬空垂挂的藤蔓（y=61~63 是 vine，y=60/59 是空气），
                // 规划给出了 climb→(-123,63) 的边，但她站在 y=59 根本够不到，
                // 连续 3 轮 `climb 失败: TIMEOUT 爬了 8000ms 没上去`，最后 NO_REACH。
                // 自然界大部分藤蔓正是这种装饰性垂挂，不能当攀爬通路。
                //
                // 判据：攀爬柱最底格的下方必须是实心（接地），否则不生成边。
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const kx = cur.x + dx, kz = cur.z + dz;
                    // 允许"站在柱顶平台边"进入：目标列在 cur.y 或 cur.y-1 是可攀爬即可
                    // （平台面 y=56 时藤蔓从 y=55 开始，差一格）。
                    let grabY = null;
                    if (surf.get(key(kx, cur.y, kz)) === T.CLIMBABLE) grabY = cur.y;
                    else if (surf.get(key(kx, cur.y - 1, kz)) === T.CLIMBABLE) grabY = cur.y - 1;
                    if (grabY === null) continue;

                    // 找到这一柱的最低格
                    let botY = grabY;
                    for (let d = 1; d <= 40; d++) {
                        if (surf.get(key(kx, botY - 1, kz)) !== T.CLIMBABLE) break;
                        botY--;
                    }
                    // 柱子底部下方必须是实心地面，否则是悬空藤蔓 → 不可攀爬
                    const under = surf.get(key(kx, botY - 1, kz));
                    if (under !== T.SOLID && under !== T.BUILT) continue;
                    // 且她必须能够到柱底（柱底不高于她太多：最多 3 格）
                    if (botY > cur.y + 3) continue;

                    let upY = grabY;
                    for (let d = 1; d <= 40; d++) {
                        const t2 = surf.get(key(kx, grabY + d, kz));
                        if (t2 !== T.CLIMBABLE) break;
                        upY = grabY + d;
                    }
                    if (upY > grabY) {
                        cand.push({ x: kx, y: upY, z: kz,
                            cost: C3.flat + (upY - grabY) * C3.climbPer, action: 'climb' });
                    }
                    // 向下：从平台边直接降到柱底（一次到底）。
                    // 没有这条，"从平台沿藤蔓下到地面"就无解 —— 平台面比藤蔓顶高一格，
                    // 向下的 down 边又因为 CLIMBABLE 不是落脚点被禁掉了。
                    if (botY < cur.y) {
                        cand.push({ x: kx, y: botY, z: kz,
                            cost: C3.flat + (cur.y - botY) * C3.climbPer * 0.7, action: 'climb' });
                    }
                }
            }
        }


        for (const nb of cand) {
            const nk = key(nb.x, nb.y, nb.z);
            const ng = cur.g + nb.cost;
            if (ng >= (seen.get(nk) ?? Infinity)) continue;
            seen.set(nk, ng);
            came.set(nk, { parent: ck, action: nb.action });
            // ★ 2026-10-28：加一个**极小的确定性 tie-breaker**。
            //
            // 实测问题：两条代价完全相同的路会让 A* 在不同轮次给出不同选择，
            // 于是她在两点间来回振荡（剩 141 → 138 → 141 → 138…，走了 10 轮）。
            // 加入 g×1e-6 后，同代价时**偏向已经走得更稳的那条**（g 更大则 f 略大），
            // 让重复调用给出相同结果，消除振荡。
            open.push({ x: nb.x, y: nb.y, z: nb.z, g: ng, f: ng + h(nb.x, nb.y, nb.z) + ng * 1e-6 });
        }
    }

    // ★ 2026-10-27 修：**目标到不了时，退化成"朝目标方向走到能到的最远点"**。
    //
    // 实测：她 y=49，16 格外最近的面是 y=61（高 12 格），
    // 中间没有同层面，即使允许挖通也到不了 —— 精确目标根本不在她可达空间里。
    // 但"朝那个方向走 5~10 格"往往是有路的。
    //
    // 这不是兜底（不在这一层吞错误）：它**仍然返回一条真实可行的路径**，
    // 只是终点不是原目标。调用方拿到的是"走了多少"，下一轮会重新规划。
    if (!found && tx != null) {
        // 从已访问节点里挑：离目标最近的那个
        let best = null, bestD = Infinity;
        for (const [k, g] of seen) {
            const [kx, ky, kz] = k.split(',').map(Number);
            const d = Math.hypot(kx - tx, kz - tz);
            if (d < bestD) { bestD = d; best = { x: kx, y: ky, z: kz, g }; }
        }
        if (best && bestD < Math.hypot(sx - tx, sz - tz) - 2) {
            // 比起点更靠近目标，就用它当终点（tx/ty/tz 是 const，不改它们）
            found = { x: best.x, y: best.y, z: best.z, g: best.g };
        }
    }

    if (!found) {
        return {
            ok: false,
            code: nodes >= maxNodes ? 'BUDGET' : 'NO_PATH',
            path: [], nodes, cost: Infinity, surfaces: surf.size,
        };
    }

    // ---- 回溯路径 ----
    const path = [];
    let ck = key(found.x, found.y, found.z);
    while (ck) {
        const [x, y, z] = ck.split(',').map(Number);
        const info = came.get(ck);
        path.push({ x, y, z, action: info?.action ?? 'walk' });
        ck = info?.parent;
    }
    path.reverse();

    return {
        ok: true, path, nodes,
        cost: found.g,
        surfaces: surf.size,
        start, goal: { x: found.x, y: found.y, z: found.z },
    };
}

/** 一行摘要（给日志/模型读）。 */
export function describe3D(plan) {
    if (!plan.ok) return `3D 规划失败（${plan.code}，看了 ${plan.surfaces} 个面、${plan.nodes} 节点）`;
    const digs = plan.path.filter(p => p.action === 'dig').length;
    const ups = plan.path.filter(p => p.action === 'jump').length;
    const downs = plan.path.filter(p => p.action === 'down').length;
    const dy = plan.path[plan.path.length - 1].y - plan.path[0].y;
    return `${plan.path.length} 步，代价 ${plan.cost.toFixed(1)}，高差 ${dy >= 0 ? '+' : ''}${dy}` +
        (digs ? `，挖 ${digs} 处` : '') + (ups ? `，跳上 ${ups}` : '') + (downs ? `，下落 ${downs}` : '') +
        `（${plan.nodes} 节点 / ${plan.surfaces} 面）`;
}
