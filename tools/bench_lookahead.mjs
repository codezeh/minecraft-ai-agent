// 验证 LOOK_AHEAD 是否通用（而不是单张地图的特调值）。
//
// 做法：在 7 种地形上，分别测量"目标距离 = 8/12/16/24/32/48"时的路径质量。
// 如果 24 在多数地形上都优于 16，才算通用；否则应改回按地形自适应的策略。

import { mkdirSync, rmSync } from 'node:fs';
import { plan3D } from '../src/agent/library/path_3d.js';
import { saveSurfaces, T } from '../src/agent/library/terrain3d.js';

const SIZE = 64, BASE_Y = 64, TRIALS = 15;

function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function makeWorld(kind) {
    const cells = [], N = SIZE;
    const push = (x, z, y, t = T.SOLID) => cells.push({ x, z, y, t });
    if (kind === 'flat') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) push(x, z, BASE_Y);
    } else if (kind === 'hills') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++)
            push(x, z, BASE_Y + Math.round(2 * Math.sin(x / 6) + 2 * Math.cos(z / 8)));
    } else if (kind === 'cliffs') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++)
            push(x, z, BASE_Y + Math.floor(x / 10) * 3);
    } else if (kind === 'maze') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            const wallX = x % 8 === 0, wallZ = z % 8 === 0;
            const doorX = (z % 8) === 4, doorZ = (x % 8) === 4;
            if ((wallX && !doorX) || (wallZ && !doorZ)) continue;
            push(x, z, BASE_Y);
        }
    } else if (kind === 'water') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            const d = Math.hypot(x - N / 2, z - N / 2);
            if (d < 16) { push(x, z, 59); push(x, z, 63, T.WATER); }
            else push(x, z, BASE_Y);
        }
    } else if (kind === 'cave') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            push(x, z, 44);
            const shaft = (x % 8 === 3) && (z % 8 === 3);
            push(x, z, shaft ? 70 : 58);
        }
    } else if (kind === 'mixed') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            if (x < N / 2) push(x, z, BASE_Y + Math.round(2 * Math.sin(x / 6) + 2 * Math.cos(z / 8)));
            else {
                if (x % 8 === 0 && (z % 8) !== 4) continue;
                push(x, z, BASE_Y + 1);
            }
        }
        for (let x = 30; x <= 33; x++) for (let z = 0; z < N; z++) {
            for (let i = cells.length - 1; i >= 0; i--) if (cells[i].x === x && cells[i].z === z) cells.splice(i, 1);
            push(x, z, BASE_Y - 3); push(x, z, BASE_Y, T.WATER);
        }
    }
    return cells;
}

function ratioOf(plan, from) {
    if (!plan.ok || plan.path.length < 2) return null;
    let len = 0;
    for (let i = 1; i < plan.path.length; i++)
        len += Math.hypot(plan.path[i].x - plan.path[i - 1].x, plan.path[i].z - plan.path[i - 1].z);
    const straight = Math.hypot(plan.path.at(-1).x - from.x, plan.path.at(-1).z - from.z);
    return straight > 1 ? len / straight : null;
}

const KINDS = ['flat', 'hills', 'cliffs', 'maze', 'water', 'cave', 'mixed'];
const DISTS = [8, 12, 16, 24, 32, 48];

console.log(`基准：${KINDS.length} 种地形 × ${DISTS.length} 个距离 × ${TRIALS} 组\n`);

// 每种地形每个距离的平均绕路比
const table = {};
for (const kind of KINDS) {
    const dir = `C:/Users/zeh/AppData/Local/Temp/look-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(dir, { recursive: true });
    const cells = makeWorld(kind);
    saveSurfaces(dir, cells);
    table[kind] = {};

    for (const dist of DISTS) {
        const r = rng(kind.length * 1000 + dist);
        const ratios = [];
        let ok = 0, fail = 0;
        for (let t = 0; t < TRIALS; t++) {
            // 起点
            let a = null;
            for (let k = 0; k < 200; k++) {
                const x = 3 + Math.floor(r() * (SIZE - 6));
                const z = 3 + Math.floor(r() * (SIZE - 6));
                const hit = cells.find(c => c.x === x && c.z === z);
                if (hit) { a = { x, y: hit.y + 1, z }; break; }
            }
            if (!a) continue;
            // 指定距离的目标
            const ang = r() * Math.PI * 2;
            const tx = Math.round(a.x + Math.cos(ang) * dist);
            const tz = Math.round(a.z + Math.sin(ang) * dist);
            if (tx < 2 || tx >= SIZE - 2 || tz < 2 || tz >= SIZE - 2) continue;
            const hit = cells.find(c => c.x === tx && c.z === tz);
            if (!hit) continue;

            const plan = plan3D(dir, a, { x: tx, y: hit.y + 1, z: tz }, { maxNodes: 120000, margin: 8 });
            if (!plan.ok) { fail++; continue; }
            const rt = ratioOf(plan, a);
            if (rt) { ratios.push(rt); ok++; } else fail++;
        }
        const avg = ratios.length ? ratios.reduce((x, y) => x + y, 0) / ratios.length : null;
        table[kind][dist] = { ratio: avg, ok, fail };
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
}

// 输出
console.log('地形    ' + DISTS.map(d => String(d).padStart(7)).join(''));
const perDist = {};
for (const d of DISTS) perDist[d] = [];
for (const kind of KINDS) {
    const row = DISTS.map(d => {
        const v = table[kind][d];
        if (v.ratio) perDist[d].push(v.ratio);
        return (v.ratio ? v.ratio.toFixed(2) : '  -  ').padStart(7);
    }).join('');
    console.log(`${kind.padEnd(8)}${row}`);
}
const avgRow = DISTS.map(d => {
    const a = perDist[d];
    const m = a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    return (m ? m.toFixed(2) : '-').padStart(7);
}).join('');
console.log(`${'平均'.padEnd(8)}${avgRow}`);

// 结论
console.log('\n=== 结论 ===');
const avg = (d) => { const a = perDist[d]; return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
for (const d of DISTS) console.log(`  视距 ${String(d).padStart(2)} → 平均绕路比 ${avg(d)?.toFixed(3) ?? '-'}`);

// 逐地形比较 16 vs 24
let better24 = 0, better16 = 0;
for (const kind of KINDS) {
    const a = table[kind][16]?.ratio, b = table[kind][24]?.ratio;
    if (a == null || b == null) continue;
    if (b < a - 0.005) better24++;
    else if (a < b - 0.005) better16++;
    console.log(`  ${kind.padEnd(8)} 16:${a.toFixed(2)} 24:${b.toFixed(2)} → ${b < a ? '24 更好' : a < b ? '16 更好' : '持平'}`);
}
console.log(`\n  24 更好的地形数: ${better24}/7，16 更好: ${better16}/7`);
console.log(`  → ${better24 >= 5 ? '24 有普遍优势，保留' : '24 没有普遍优势，应改回 16 或做自适应'}`);
