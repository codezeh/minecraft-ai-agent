/**
 * 地形视图（ASCII）——从真 3D 库渲染「我现在周围长什么样」。
 *
 * ★ 2026-10-27 重写：数据源从 chunks.db（2.5D）换成 terrain3d.db（真 3D）。
 *
 * 只做展示，**不参与任何寻路决策**。决策一律走 executor / path_3d。
 *
 * 3D 带来的关键差别：
 *   同一 (x,z) 可能有多个面（洞穴地面 / 天花板 / 悬空平台）。
 *   渲染时取**离她当前高度最近**的那个面 —— 这才是她真正踩的那层。
 *   旧版只有单层地表，她在地下时画出来的是"头顶几十格外的地面"，没有意义。
 */
import { boxSurfaces, T } from './terrain3d.js';

/** 一个字符代表的格数（降采样）。默认 4：9×9 输出覆盖约 100 格。 */
export const VIEW_CELL = 4;

/** 高度归一化用稳健分位（p5~p95），避免海床/屋顶把区间拉爆。 */
function robustRange(values) {
    const v = values.filter(x => x != null && x > -30000).sort((a, b) => a - b);
    if (!v.length) return { min: null, max: null, p50: null, all: [null, null] };
    const pick = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
    return { min: pick(0.05), max: pick(0.95), p50: pick(0.5), all: [v[0], v[v.length - 1]] };
}

/**
 * 从 3D 库采样一块区域。
 *
 * @param {string} mapDir
 * @param {{x:number,y?:number,z:number}} center 中心（一般传她的位置）
 * @param {number} radius 半径（格）
 * @param {number} cell 每字符格数
 */
export function sampleTerrain(mapDir, center, radius = 64, cell = VIEW_CELL) {
    const t0 = Date.now();
    const w = Math.ceil((radius * 2) / cell);
    const h = w;
    const originX = Math.floor(center.x) - Math.floor(radius / cell) * cell;
    const originZ = Math.floor(center.z) - Math.floor(radius / cell) * cell;
    const herY = Number.isFinite(center.y) ? Math.floor(center.y) : 64;

    // 一次把整个盒子读进来，再按格归并（比逐格查库快得多）
    const rows = boxSurfaces(mapDir,
        originX, originZ, originX + w * cell, originZ + h * cell,
        herY - Math.max(32, radius), herY + Math.max(32, radius));

    // 按 (x,z) 归并：每个位置只留**离她高度最近**的那个面
    const byCol = new Map();
    for (const r of rows) {
        const k = r.x + ',' + r.z;
        const cur = byCol.get(k);
        if (!cur || Math.abs(r.y - herY) < Math.abs(cur.y - herY)) byCol.set(k, r);
    }

    const heights = new Int16Array(w * h).fill(-32768);
    const kinds = new Array(w * h).fill('unknown');

    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            const wx = originX + i * cell;
            const wz = originZ + j * cell;
            const idx = j * w + i;

            // 在 cell×cell 的小块里找离她最近的面
            let best = null, bestD = Infinity;
            for (let dz = 0; dz < cell; dz++) {
                for (let dx = 0; dx < cell; dx++) {
                    const f = byCol.get((wx + dx) + ',' + (wz + dz));
                    if (!f) continue;
                    const d = Math.abs(f.y - herY);
                    if (d < bestD) { bestD = d; best = f; }
                }
            }
            if (!best) continue;

            heights[idx] = best.y;
            kinds[idx] = best.t === T.WATER ? 'water'
                : best.t === T.LAVA ? 'lava'
                    : best.t === T.BUILT ? 'built'
                        : best.t === T.LEAVES ? 'tree'
                            : 'ground';
        }
    }

    return { w, h, cell, originX, originZ, heights, kinds, herY, ms: Date.now() - t0 };
}

/**
 * 渲染成 ASCII。字段与旧版对齐（text/legend/style/blockSize/covers/extent）。
 *
 * 符号：0-9 相对高度 / ~ 水 / ! 岩浆 / P 建筑 / T 树 / ? 无数据 / @ 我 / G 目标
 */
export function renderTerrain(view, marks = {}, opts = {}) {
    const style = opts.style ?? 'height';
    const maxWidth = opts.maxWidth ?? 9;

    const step = Math.max(1, Math.ceil(view.w / maxWidth));
    const outW = Math.ceil(view.w / step);
    const outH = Math.ceil(view.h / step);

    // 可走地面的高度做稳健归一化（排除水/建筑）
    const groundHeights = [];
    for (let idx = 0; idx < view.w * view.h; idx++) {
        const k = view.kinds[idx];
        if (k !== 'ground' && k !== 'tree') continue;
        if (view.heights[idx] <= -30000) continue;
        groundHeights.push(view.heights[idx]);
    }
    const range = robustRange(groundHeights);

    const charAt = (oi, oj) => {
        let worst = null;
        let sum = 0, cnt = 0;
        for (let dj = 0; dj < step; dj++) {
            for (let di = 0; di < step; di++) {
                const i = oi * step + di, j = oj * step + dj;
                if (i >= view.w || j >= view.h) continue;
                const idx = j * view.w + i;
                const k = view.kinds[idx];
                if (k === 'lava') worst = 'lava';
                else if (k === 'water' && worst !== 'lava') worst = 'water';
                else if (k === 'built' && !worst) worst = 'built';
                else if (k === 'unknown' && !worst) worst = 'unknown';
                else if (k === 'tree' && !worst) worst = 'tree';
                if (k === 'ground' || k === 'tree') {
                    const y = view.heights[idx];
                    if (y > -30000) { sum += y; cnt++; }
                }
            }
        }
        if (worst === 'lava') return '!';
        if (worst === 'water') return '~';
        if (worst === 'built') return 'P';
        if (worst === 'unknown') return '?';
        if (worst === 'tree') return 'T';
        if (!cnt) return '?';

        const y = sum / cnt;
        if (style === 'abs') return String(Math.round(y)).slice(-2).padStart(2, '0');
        if (range.min == null || range.max == null || range.max <= range.min) return '5';
        const rank = Math.round(((y - range.min) / (range.max - range.min)) * 9);
        return String(Math.max(0, Math.min(9, rank)));
    };

    const lines = [];
    const cellTotal = view.cell * step;
    const myI = marks.start ? Math.floor((marks.start.x - view.originX) / cellTotal) : -1;
    const myJ = marks.start ? Math.floor((marks.start.z - view.originZ) / cellTotal) : -1;
    const gi = marks.goal ? Math.floor((marks.goal.x - view.originX) / cellTotal) : -1;
    const gj = marks.goal ? Math.floor((marks.goal.z - view.originZ) / cellTotal) : -1;

    for (let oj = 0; oj < outH; oj++) {
        let line = '';
        for (let oi = 0; oi < outW; oi++) {
            if (oi === myI && oj === myJ) { line += '@'; continue; }
            if (oi === gi && oj === gj) { line += 'G'; continue; }
            line += charAt(oi, oj);
        }
        lines.push(line);
    }

    const legend = style === 'abs'
        ? '每格两位数字 = 绝对海拔 y（例如 64）  未记录= ?  岩浆=!  水=~  建筑=P  树=T  @ 我  G 目标'
        : '0-9 相对高度（9 最高，0 最低）  水=~  岩浆=!  建筑=P  树=T  未记录=?  @ 我  G 目标';

    const blockSize = cellTotal;
    const span = outW * blockSize;
    const x0 = view.originX + Math.floor(blockSize / 2);
    const z0 = view.originZ + Math.floor(blockSize / 2);

    return {
        text: lines.join('\n'),
        legend,
        style,
        width: outW, height: outH,
        blockSize,
        covers: `${span}x${span} 格`,
        extent: {
            xFrom: x0, xTo: x0 + (outW - 1) * blockSize,
            zFrom: z0, zTo: z0 + (outH - 1) * blockSize,
            step: blockSize,
        },
        heightRange: range.min == null ? null : { min: range.min, max: range.max, median: range.p50 },
        groundStats: {
            groundMin: range.all[0], groundMax: range.all[1], groundMedian: range.p50,
            groundCells: groundHeights.length,
            displayMin: range.min, displayMax: range.max,
        },
    };
}

/** 统计摘要（给 !survey 的文字部分）。 */
export function summarizeTerrain(view) {
    let water = 0, lava = 0, tree = 0, built = 0, unknown = 0, ground = 0;
    for (const k of view.kinds) {
        if (k === 'water') water++;
        else if (k === 'lava') lava++;
        else if (k === 'tree') tree++;
        else if (k === 'built') built++;
        else if (k === 'unknown') unknown++;
        else ground++;
    }
    return { water, lava, tree, built, unknown, ground, cells: view.kinds.length, ms: view.ms };
}

// ---------------------------------------------------------------------------
// 方位/高差摘要：纯函数，与地形无关（!plan 的返回契约要用）
// ---------------------------------------------------------------------------

/** 方位名（中文）。+Z = 南，与游戏坐标系一致。 */
export function compassOf(from, to) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const ax = Math.abs(dx), az = Math.abs(dz);
    if (ax < 1 && az < 1) return '原地';
    const ew = dx > 0 ? '东' : '西';
    const ns = dz > 0 ? '南' : '北';
    if (ax > az * 2) return ew;
    if (az > ax * 2) return ns;
    return ew + ns;
}

/** "目标在我哪个方向"——相对她当前朝向。 */
export function relativeDirection(from, to, facingName) {
    const RING = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    const idxOf = (name) => RING.indexOf(name);
    const target = compassOf(from, to);
    const fi = idxOf(facingName);
    const ti = idxOf(target);
    if (fi < 0 || ti < 0) return null;
    const delta = (ti - fi + 8) % 8;
    const NAMES = ['正前方', '右前方', '正右方', '右后方', '正后方', '左后方', '正左方', '左前方'];
    return { dir: NAMES[delta], delta, target, facing: facingName };
}

/** 途经点的高差摘要（爬升/下降）。 */
export function summarizeHeights(steps, opts = {}) {
    const limit = opts.maxDropDown ?? 4;
    let maxDrop = 0, maxClimb = 0, totalDrop = 0, totalClimb = 0;
    let startY = null, endY = null;
    for (const s of steps || []) {
        if (typeof s.drop === 'number') {
            if (s.drop > 0) { maxDrop = Math.max(maxDrop, s.drop); totalDrop += s.drop; }
            else if (s.drop < 0) { maxClimb = Math.max(maxClimb, -s.drop); totalClimb += -s.drop; }
        }
        if (startY === null && typeof s.y === 'number') startY = s.y;
        if (typeof s.y === 'number') endY = s.y;
    }
    return {
        maxDrop, maxClimb, totalDrop, totalClimb, startY, endY,
        tooSteep: maxDrop > limit,
        limit,
    };
}
