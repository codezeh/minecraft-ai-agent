// 导航规划基准测试（多地形随机）—— 2026-10-28
//
// 为什么需要它：
//   之前的"优化"只在她的地图上验证过一次，属于单样本，不能说明通用性。
//   这个基准用 7 种**程序化生成**的地形，每种跑 N 组随机起终点，
//   让"是否真的更好"由数字决定，而不是由某一张地图的观感决定。
//
// 用法：node tools/bench_nav.mjs [每种地形的试验数]
//
// 输出：每种地形的 成功率 / 绕路比 / 转向 / 节点 / 耗时，以及总体平均。
// 支持通过环境变量或参数做 A/B（例如对角线开/关）。

import { mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { plan3D } from '../src/agent/library/path_3d.js';
import { saveSurfaces, T } from '../src/agent/library/terrain3d.js';

const TRIALS = Number(process.argv[2] ?? 25);
const SIZE = 64;               // 每种地形 64×64
const BASE_Y = 64;

// ---------- 可复现的伪随机 ----------
function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// ---------- 地形生成 ----------
/**
 * 每种地形返回 { cells, spawn }，cells 是 {x,z,y,t}。
 * 约定：y 是"实心方块所在高度"，玩家脚在 y+1（与 terrain3d 语义一致）。
 */
function makeWorld(kind) {
    const cells = [];
    const N = SIZE;

    const push = (x, z, y, t = T.SOLID) => cells.push({ x, z, y, t });

    if (kind === 'flat') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) push(x, z, BASE_Y);

    } else if (kind === 'hills') {
        // 平滑起伏：正弦叠加，台阶 1~2 格（可走但费劲）
        for (let x = 0; x < N; x++) {
            for (let z = 0; z < N; z++) {
                const h = BASE_Y + Math.round(2 * Math.sin(x / 6) + 2 * Math.cos(z / 8));
                push(x, z, h);
            }
        }

    } else if (kind === 'cliffs') {
        // 台地：每 10 格抬升 3 格，形成必须绕行或攀爬的陡坎
        for (let x = 0; x < N; x++) {
            for (let z = 0; z < N; z++) {
                const h = BASE_Y + Math.floor(x / 10) * 3;
                push(x, z, h);
            }
        }

    } else if (kind === 'maze') {
        // 迷宫：每 8 格一道墙，墙上开门
        const r = rng(12345);
        for (let x = 0; x < N; x++) {
            for (let z = 0; z < N; z++) {
                const wallX = x % 8 === 0;
                const wallZ = z % 8 === 0;
                // 每隔一段留门（用确定性位置，避免随机导致无解）
                const doorX = (z % 8) === 4;
                const doorZ = (x % 8) === 4;
                if ((wallX && !doorX) || (wallZ && !doorZ)) continue;   // 墙：该格没有面
                push(x, z, BASE_Y);
            }
        }

    } else if (kind === 'water') {
        // 平地 + 中央湖泊（水面 y=63，湖底 y=59）
        for (let x = 0; x < N; x++) {
            for (let z = 0; z < N; z++) {
                const d = Math.hypot(x - N / 2, z - N / 2);
                if (d < 16) {
                    push(x, z, 59);                 // 湖底
                    push(x, z, 63, T.WATER);        // 水面
                } else {
                    push(x, z, BASE_Y);
                }
            }
        }

    } else if (kind === 'cave') {
        // 双层：洞底 y=44，洞顶（可站）y=58，中间大面积是空的
        // 洞顶每 8 格开一个竖井通到地面 y=70
        for (let x = 0; x < N; x++) {
            for (let z = 0; z < N; z++) {
                push(x, z, 44);                                  // 洞底
                const shaft = (x % 8 === 3) && (z % 8 === 3);    // 竖井
                if (!shaft) push(x, z, 58);                       // 洞顶
                else push(x, z, 70);                              // 竖井顶 = 地表
            }
        }

    } else if (kind === 'mixed') {
        // 一半丘陵 + 一半迷宫墙 + 一条水沟
        for (let x = 0; x < N; x++) {
            for (let z = 0; z < N; z++) {
                if (x < N / 2) {
                    const h = BASE_Y + Math.round(2 * Math.sin(x / 6) + 2 * Math.cos(z / 8));
                    push(x, z, h);
                } else {
                    if (x % 8 === 0 && (z % 8) !== 4) continue;
                    push(x, z, BASE_Y + 1);
                }
            }
        }
        // 水沟：x=30..33
        for (let x = 30; x <= 33; x++) {
            for (let z = 0; z < N; z++) {
                // 覆盖原来的面：改成水下地面 + 水面
                for (let i = cells.length - 1; i >= 0; i--) {
                    if (cells[i].x === x && cells[i].z === z) cells.splice(i, 1);
                }
                push(x, z, BASE_Y - 3);
                push(x, z, BASE_Y, T.WATER);
            }
        }
    }

    return cells;
}

// ---------- 路径质量指标 ----------
function metrics(plan, from) {
    const p = plan.path;
    if (p.length < 2) return null;
    let len = 0, turns = 0, prevDir = null, diagSteps = 0;
    for (let i = 1; i < p.length; i++) {
        const dx = p[i].x - p[i - 1].x, dz = p[i].z - p[i - 1].z;
        len += Math.hypot(dx, dz);
        if (Math.abs(dx) === 1 && Math.abs(dz) === 1) diagSteps++;
        if (dx || dz) {
            const d = Math.atan2(dz, dx);
            if (prevDir != null) {
                let diff = Math.abs(d - prevDir);
                if (diff > Math.PI) diff = 2 * Math.PI - diff;
                if (diff > 0.1) turns++;
            }
            prevDir = d;
        }
    }
    const straight = Math.hypot(p.at(-1).x - from.x, p.at(-1).z - from.z);
    return { len, straight, ratio: straight > 1 ? len / straight : null, turns, diagSteps, steps: p.length };
}

// ---------- 跑一种地形 ----------
function benchWorld(kind, opts = {}) {
    const dir = `C:/Users/zeh/AppData/Local/Temp/bench-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    mkdirSync(dir, { recursive: true });
    const cells = makeWorld(kind);
    saveSurfaces(dir, cells);

    const r = rng(kind.length * 7919 + 17);
    let ok = 0, fail = 0, ratios = [], turnsList = [], nodesList = [], msList = [], diagList = [];

    for (let t = 0; t < TRIALS; t++) {
        // 随机取两个相距 20~45 格的点，且都必须有面
        const pick = () => {
            for (let k = 0; k < 200; k++) {
                const x = 3 + Math.floor(r() * (SIZE - 6));
                const z = 3 + Math.floor(r() * (SIZE - 6));
                const hit = cells.find(c => c.x === x && c.z === z);
                if (hit) return { x, y: hit.y + 1, z };
            }
            return null;
        };
        const a = pick();
        if (!a) continue;
        // 目标：距离 20~45
        let b = null;
        for (let k = 0; k < 300; k++) {
            const ang = r() * Math.PI * 2;
            const dist = 20 + r() * 25;
            const tx = Math.round(a.x + Math.cos(ang) * dist);
            const tz = Math.round(a.z + Math.sin(ang) * dist);
            if (tx < 2 || tx >= SIZE - 2 || tz < 2 || tz >= SIZE - 2) continue;
            const hit = cells.find(c => c.x === tx && c.z === tz);
            if (hit) { b = { x: tx, y: hit.y + 1, z: tz }; break; }
        }
        if (!b) continue;

        const t0 = Date.now();
        const plan = plan3D(dir, a, b, { maxNodes: 120000, margin: 8, diag: opts.diag !== false });
        const ms = Date.now() - t0;

        if (!plan.ok) { fail++; continue; }
        const mt = metrics(plan, a);
        if (!mt) { fail++; continue; }
        ok++;
        if (mt.ratio) ratios.push(mt.ratio);
        turnsList.push(mt.turns);
        nodesList.push(plan.nodes);
        msList.push(ms);
        diagList.push(mt.diagSteps);
    }

    const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const out = {
        kind,
        trials: ok + fail,
        ok, fail,
        successRate: ok + fail > 0 ? ok / (ok + fail) : 0,
        ratio: avg(ratios),
        turns: avg(turnsList),
        nodes: avg(nodesList),
        ms: avg(msList),
        diag: avg(diagList),
    };
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
    return out;
}

// ---------- 主流程 ----------
const KINDS = ['flat', 'hills', 'cliffs', 'maze', 'water', 'cave', 'mixed'];

function report(label, rows) {
    console.log(`\n=== ${label} ===`);
    console.log('地形     试验  成功  成功率  绕路比  转向  对角  节点    耗时');
    let tr = [], tt = [], tsucc = [];
    for (const r of rows) {
        console.log(
            `${r.kind.padEnd(8)} ${String(r.trials).padStart(4)} ${String(r.ok).padStart(4)} ` +
            `${(r.successRate * 100).toFixed(0).padStart(5)}% ${(r.ratio || 0).toFixed(2).padStart(7)} ` +
            `${r.turns.toFixed(1).padStart(5)} ${r.diag.toFixed(1).padStart(5)} ` +
            `${r.nodes.toFixed(0).padStart(6)} ${r.ms.toFixed(0).padStart(5)}ms`
        );
        if (r.ratio) tr.push(r.ratio);
        tt.push(r.turns);
        tsucc.push(r.successRate);
    }
    const A = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    console.log(`平均     ${''.padStart(4)} ${''.padStart(4)} ${(A(tsucc) * 100).toFixed(0).padStart(5)}% ` +
        `${A(tr).toFixed(2).padStart(7)} ${A(tt).toFixed(1).padStart(5)}`);
    return { ratio: A(tr), turns: A(tt), success: A(tsucc) };
}

console.log(`基准：${KINDS.length} 种地形 × ${TRIALS} 组随机起终点`);

// A/B：有对角线 vs 无对角线
const withDiag = KINDS.map(k => benchWorld(k, { diag: true }));
const noDiag = KINDS.map(k => benchWorld(k, { diag: false }));

const A = report('A) 8 方向（含对角线）', withDiag);
const B = report('B) 4 方向（仅正交）', noDiag);

console.log('\n=== A/B 对比 ===');
const dR = ((A.ratio - B.ratio) / B.ratio * 100);
const dT = ((A.turns - B.turns) / B.turns * 100);
console.log(`绕路比：8向 ${A.ratio.toFixed(2)} vs 4向 ${B.ratio.toFixed(2)}  → ${dR >= 0 ? '+' : ''}${dR.toFixed(1)}%`);
console.log(`转向数：8向 ${A.turns.toFixed(1)} vs 4向 ${B.turns.toFixed(1)}  → ${dT >= 0 ? '+' : ''}${dT.toFixed(1)}%`);
console.log(`成功率：8向 ${(A.success * 100).toFixed(0)}% vs 4向 ${(B.success * 100).toFixed(0)}%`);
console.log(`\n结论：${A.ratio < B.ratio && A.turns < B.turns
    ? '对角线在多数地形上同时降低绕路比和转向数 → 是真改进'
    : '对角线没有稳定优势 → 不应保留为默认'}`);
