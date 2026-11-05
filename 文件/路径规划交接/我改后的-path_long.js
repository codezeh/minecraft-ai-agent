/**
 * 长规划：先在地图上算完整路线，再压缩成少数路点。
 *
 * 与短规划的分工（用户定的）：
 *   长规划 = 区块地图 + 真正的地图寻路，输出 2~4 个路点
 *   短规划 = 每个路点之间用 pathfinder 走真实地形，失败就对半切
 *
 * ★ 2026-10-26 重构（用户判断「如果路线错了再这么治也是错」）
 *
 * 改之前的结构是反的：
 *   拉一条直线 → 走到某段走不通 → 才去查地图 → 只拿一格方向 → 回去继续走
 * 于是每一步都是局部修正，没有一次性算出完整路线 → 表现为**徘徊**。
 *
 * 现在：
 *   1) 先用区块 A* 算出完整路线
 *   2) 把路线压缩成少数路点（拐点保留 + 长直线合并）
 *   3) A* 不可用时（地图没扫过/数据陈旧/超预算）降级回"直线 + 避让"
 *
 * 为什么必须压缩：
 *   原设计实测「pathfinder 单次调用 13~15 秒，与距离关系不大」，
 *   所以路点要少（≤4 个）。40 个格子每格一个路点 = 10 分钟，不可接受。
 *
 * 为什么保留降级路径：
 *   A* 依赖区块地图，而地图可能是空白的（没扫过）或陈旧的（玩家改了地形）。
 *   这时"直线 + 避让"至少能给出方向，比直接报"没路"好。
 */
import { tileCost, classifyChunk, tileAStar } from './tile_map.js';
import { openMapReader } from './chunk_map.js';

const MAX_WAYPOINTS = 4;        // 最多 4 个路点（每段约 32~64 格）
const MIN_SEGMENT = 24;         // 短于此距离不需要长规划，直接短规划
const AVOID_COST = 20;          // 代价 >= 这个值的格子，降级路径要绕
const ASTAR_NODES = 6000;       // A* 节点预算（区块级，6000 够走 100+ 格）

/**
 * 把格子路线压缩成 ≤maxWp 个路点。
 *
 * 规则：
 *   1) 保留拐点（方向变化的格子）—— 拐点丢了就会撞墙
 *   2) 拐点之间同方向的长直线，只取端点
 *   3) 如果还是太多，按等间隔抽样（保证首尾点一定保留）
 *   4) ★ 保证每个路点都在"从上一个路点朝目标"的前方（不往回走）
 *
 * @param {Array<{cx,cz}>} cells 从起点到终点的格子序列（含首尾）
 * @param {{x:number,z:number}} to 目标（真实坐标）
 * @param {number} maxWp
 * @returns {Array<{x:number,z:number,cx:number,cz:number}>}
 */
function compressRoute(cells, to, maxWp) {
    if (!cells.length) return [];
    if (cells.length === 1) {
        return [{ x: to.x, z: to.z, cx: cells[0].cx, cz: cells[0].cz }];
    }

    // ---- 1) 找拐点（方向变化的格子下标） ----
    // 注意：**不把起点格当路点**（2026-10-26 修）。
    // 起点格中心就是她站的位置，让它当第一个路点等于"先走到脚下再出发"，
    // 白占一个路点配额（只有 4 个），还可能因为格子中心落在身后而让她先退一步。
    const turnIdx = [];
    for (let i = 1; i < cells.length - 1; i++) {
        const d1 = { x: cells[i].cx - cells[i - 1].cx, z: cells[i].cz - cells[i - 1].cz };
        const d2 = { x: cells[i + 1].cx - cells[i].cx, z: cells[i + 1].cz - cells[i].cz };
        if (d1.x !== d2.x || d1.z !== d2.z) turnIdx.push(i);
    }
    turnIdx.push(cells.length - 1);

    // ---- 2) 拐点太多时等间隔抽样（首尾必留） ----
    let picked = turnIdx.length ? turnIdx : [cells.length - 1];
    if (picked.length > maxWp + 1) {
        const out = [picked[0]];
        const inner = picked.slice(1, -1);
        const keep = Math.max(0, maxWp - 1);
        for (let k = 1; k <= keep; k++) {
            const idx = Math.round((k * inner.length) / (keep + 1)) - 1;
            if (idx >= 0 && idx < inner.length) out.push(inner[idx]);
        }
        out.push(picked[picked.length - 1]);
        picked = [...new Set(out)].sort((a, b) => a - b);
    }

    // ---- 3) 转成世界坐标（格子中心），并保证不往回走 ----
    const pts = picked.map(i => ({
        x: cells[i].cx * 16 + 8,
        z: cells[i].cz * 16 + 8,
        cx: cells[i].cx,
        cz: cells[i].cz,
    }));

    // 最后一个路点直接落在目标上（避免"到了格子中心但不是目标"）
    pts[pts.length - 1] = { x: Math.round(to.x), z: Math.round(to.z), cx: cells[cells.length - 1].cx, cz: cells[cells.length - 1].cz };

    // 去掉"没往目标走"的路点：
    //   从上一点到该路点的位移，在"上一点 → 目标"方向上的投影必须为正。
    //   这是徘徊的直接来源之一：路点落在身后 → 先退再进。
    const cleaned = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const prev = cleaned[cleaned.length - 1];
        const cur = pts[i];
        const isLast = i === pts.length - 1;
        if (isLast) { cleaned.push(cur); break; }
        const toGoal = { x: to.x - prev.x, z: to.z - prev.z };
        const move = { x: cur.x - prev.x, z: cur.z - prev.z };
        const proj = move.x * toGoal.x + move.z * toGoal.z;
        if (proj > 0) cleaned.push(cur);
    }
    return cleaned;
}

/**
 * 长规划：从 from 到 to，最多 4 个路点。
 *
 * 优先用区块 A* 算完整路线；A* 不可用时降级为「直线 + 垂直避让」。
 *
 * @returns {{waypoints:Array<{x,z,label,cost}>, straightDist, avoided, ok, source}}
 *   source: 'astar' | 'straight'  —— 这次用的是哪条路（便于诊断）
 */
export function planLong(mapDir, from, to) {
    const reader = openMapReader(mapDir);

    const dx = to.x - from.x, dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);

    if (dist < MIN_SEGMENT) {
        return {
            waypoints: [{ x: Math.round(to.x), z: Math.round(to.z), label: '目标', cost: 0 }],
            straightDist: dist, avoided: 0, ok: true, source: 'straight',
        };
    }

    // ================= 1) 主路径：区块 A* =================
    const route = tileAStar(mapDir, from, to, { maxNodes: ASTAR_NODES });
    if (route.status === 'found' && route.path.length >= 2) {
        const pts = compressRoute(route.path, to, MAX_WAYPOINTS);
        if (pts.length >= 1) {
            const waypoints = pts.map((p, i) => {
                const inf = reader.chunk(p.cx, p.cz);
                const t = classifyChunk(inf);
                return {
                    x: p.x, z: p.z,
                    label: i === pts.length - 1 ? '目标' : t.label,
                    cost: inf ? tileCost(inf) : 6,
                };
            });
            return {
                waypoints,
                straightDist: dist,
                avoided: 0,
                ok: true,
                source: 'astar',
                nodes: route.nodes,
                routeStatus: route.status,
            };
        }
    }

    // ================= 2) 降级：直线 + 垂直避让 =================
    //    A* 不可用的三种情况都走这里：
    //      exhausted（真没路）/ budget（没算完）/ 地图空白
    const segments = Math.min(MAX_WAYPOINTS, Math.max(1, Math.ceil(dist / 64)));
    const ux = dx / dist, uz = dz / dist;
    const px = -uz, pz = ux;          // 垂直方向，用于左右避让

    const at = (x, z) => {
        const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
        const info = reader.chunk(cx, cz);
        return { info, cost: info ? tileCost(info) : 6, label: classifyChunk(info).label, cx, cz };
    };

    const waypoints = [];
    let avoided = 0;

    for (let i = 1; i <= segments; i++) {
        const t = i / segments;
        let x = from.x + dx * t;
        let z = from.z + dz * t;

        let pt = at(x, z);
        if (pt.cost >= AVOID_COST) {
            // ★ 避让时只允许"往前挪"：偏移后的点，沿"起点→目标"方向的投影
            //   必须比原来的点更远（或至少不更近），否则就是往回走。
            //   原实现左右对称试探，会选到身后的点，白走几十格。
            const baseProj = (x - from.x) * ux + (z - from.z) * uz;
            let fixed = false;
            for (const off of [8, -8, 16, -16, 24, -24, 32, -32]) {
                const nx = x + px * off, nz = z + pz * off;
                const proj = (nx - from.x) * ux + (nz - from.z) * uz;
                if (proj < baseProj - 1) continue;          // 挪到身后了：不要
                const cand = at(nx, nz);
                if (cand.cost > 0 && cand.cost < AVOID_COST) {
                    x = nx; z = nz; pt = cand; avoided++; fixed = true;
                    break;
                }
            }
            if (!fixed) avoided += 100;   // 整片都是高代价地形，交给短规划去试
        }
        waypoints.push({ x: Math.round(x), z: Math.round(z), label: pt.label, cost: pt.cost });
    }

    // 去掉挨太近的路点（<12 格），并保证最后一个点接近目标
    const merged = [];
    for (const w of waypoints) {
        const last = merged[merged.length - 1];
        if (last && Math.hypot(w.x - last.x, w.z - last.z) < 12) continue;
        merged.push(w);
    }
    const tail = merged[merged.length - 1];
    if (!tail || Math.hypot(tail.x - to.x, tail.z - to.z) > 4) {
        merged.push({ x: Math.round(to.x), z: Math.round(to.z), label: '目标', cost: 0 });
    }

    return {
        waypoints: merged,
        straightDist: dist,
        avoided,
        ok: true,
        source: 'straight',
        routeStatus: route.status,
    };
}

/** 一行文字：长规划结果（给模型读）。 */
export function describeLong(plan) {
    const segs = [];
    for (let i = 0; i < plan.waypoints.length; i++) {
        const w = plan.waypoints[i];
        segs.push(`(${w.x},${w.z})${w.label}`);
    }
    const avoid = plan.avoided ? `，避让 ${plan.avoided} 次` : '';
    const src = plan.source === 'astar' ? '地图寻路' : '直线降级';
    return `${src} ${plan.straightDist.toFixed(0)} 格 → ${plan.waypoints.length} 段：${segs.join(' → ')}${avoid}`;
}
