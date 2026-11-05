/**
 * 长规划：只决定「往哪走、在哪几个点停」，不关心怎么迈步。
 *
 * 与短规划的分工（用户定的）：
 *   长规划 = 区块地图 + 直线走廊，输出 2~4 个路点，避开岩浆/水面/陡坡
 *   短规划 = 每个路点之间用 pathfinder 走真实地形，失败就对半切
 *
 * 依据（实测）：
 *   - 区块扫描 8×8 = 27~41ms，可以每步重扫
 *   - pathfinder 单次调用约 13~15 秒，与距离关系不大
 *     → 所以路点要少（越少越省），失败时切半而不是整段重试
 */
import { tileCost, classifyChunk } from './tile_map.js';
import { openMapReader } from './chunk_map.js';

const MAX_WAYPOINTS = 4;        // 最多 4 个路点（每段约 32~64 格）
const MIN_SEGMENT = 24;         // 短于此距离不需要长规划，直接短规划
const AVOID_COST = 20;          // 代价 >= 这个值的格子，长规划要绕

/**
 * 长规划：从 from 到 to，最多 4 个路点。
 * 路点落在直线上；若该点地形不可走，沿垂直方向左右试探偏移。
 *
 * @returns {{waypoints:Array<{x,z,label,cost}>, straightDist, avoided, ok}}
 */
export function planLong(mapDir, from, to) {
    const reader = openMapReader(mapDir);
    const dx = to.x - from.x, dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);

    if (dist < MIN_SEGMENT) {
        return { waypoints: [{ x: Math.round(to.x), z: Math.round(to.z), label: '目标', cost: 0 }], straightDist: dist, avoided: 0, ok: true };
    }

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
        // 不可走（岩浆 0 / 水 40 / 陡坡 25 / 建筑 18）→ 左右找可走位
        if (pt.cost >= AVOID_COST) {
            let fixed = false;
            for (const off of [8, -8, 16, -16, 24, -24, 32, -32]) {
                const nx = x + px * off, nz = z + pz * off;
                const cand = at(nx, nz);
                if (cand.cost > 0 && cand.cost < AVOID_COST) {
                    x = nx; z = nz; pt = cand; avoided++; fixed = true;
                    break;
                }
            }
            if (!fixed) {
                // 这一带整片都是高代价地形：保留原点，让短规划去试（它会失败并切半）
                avoided += 100;
            }
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

    return { waypoints: merged, straightDist: dist, avoided, ok: true };
}

/** 一行文字：长规划结果（给模型读）。 */
export function describeLong(plan) {
    const segs = [];
    for (let i = 0; i < plan.waypoints.length; i++) {
        const w = plan.waypoints[i];
        segs.push(`(${w.x},${w.z})${w.label}`);
    }
    const avoid = plan.avoided ? `，避让 ${plan.avoided} 次` : '';
    return `直线 ${plan.straightDist.toFixed(0)} 格 → ${plan.waypoints.length} 段：${segs.join(' → ')}${avoid}`;
}
