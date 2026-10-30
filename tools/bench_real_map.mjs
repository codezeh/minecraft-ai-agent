// 真实地图基准（离线，大量采样）—— 2026-10-28
//
// 目的：在**她自己的地图**上随机采样大量起止点，统计规划的
//   成功率 / 失败原因分布 / 路径质量，找出真实地形下的主要瓶颈。
//
// 与合成基准（bench_nav.mjs）的分工：
//   合成基准  → 验证算法是否通用（地形可控、可复现）
//   本文件    → 看她真实活动区域能规划出多少比例，以及卡在哪
//
// 用法：node tools/bench_real_map.mjs [采样数]
import { plan3D } from '../src/agent/library/path_3d.js';
import { boxSurfaces, stats3d, readFails, T } from '../src/agent/library/terrain3d.js';

const MAP = './bots/deepseek/map';
const TRIALS = Number(process.argv[2] ?? 200);

// ---------- 可复现随机 ----------
function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const st = stats3d(MAP);
console.log(`3D 库：${st.cells} 个可站立面 / ${st.chunks} 个区块`);

// ---------- 找出所有"她站得住"的位置（脚部 y = 面的 y + 1）----------
// 只取实心/建筑面，排除水和岩浆（那些地方"站着"意义不同）
const all = boxSurfaces(MAP, -4096, -4096, 4096, 4096, -64, 320);
const ground = all.filter(f => f.t === T.SOLID || f.t === T.BUILT);
console.log(`其中适合当起终点的陆地节点：${ground.length}`);

if (ground.length < 100) {
    console.log('节点太少，先让她多走/多扫一些区域');
    process.exit(2);
}

// 按距离分箱统计
const BUCKETS = [
    { name: '16-32', min: 16, max: 32 },
    { name: '32-64', min: 32, max: 64 },
    { name: '64-128', min: 64, max: 128 },
    { name: '128-256', min: 128, max: 256 },
    { name: '256+', min: 256, max: 99999 },
];

const r = rng(20261028);
const results = BUCKETS.map(b => ({
    ...b, trials: 0, ok: 0, fail: 0,
    codes: {}, ratios: [], nodes: [], ms: [], gone: [], reached: 0,
}));

let skipped = 0;
for (let t = 0; t < TRIALS; t++) {
    // 随机起点
    const a = ground[Math.floor(r() * ground.length)];
    // 随机目标，使其距离落在某个桶里
    const bucket = BUCKETS[Math.floor(r() * BUCKETS.length)];
    const res = results.find(x => x.name === bucket.name);

    // 先按目标距离随机挑一个方向，找最接近的落点
    let b = null;
    const dist = bucket.min + r() * Math.min(bucket.max - bucket.min, 200);
    const ang = r() * Math.PI * 2;
    const wantX = a.x + Math.cos(ang) * dist;
    const wantZ = a.z + Math.sin(ang) * dist;

    // 在 ground 里找离 (wantX,wantZ) 最近且距离在桶内的点
    let bestD = Infinity;
    for (const g of ground) {
        const d = Math.hypot(g.x - wantX, g.z - wantZ);
        if (d < bestD) {
            const real = Math.hypot(g.x - a.x, g.z - a.z);
            if (real >= bucket.min && real <= bucket.max) { bestD = d; b = g; }
        }
    }
    if (!b) { skipped++; continue; }

    res.trials++;
    const t0 = Date.now();
    const plan = plan3D(MAP, { x: a.x, y: a.y + 1, z: a.z }, { x: b.x, y: b.y + 1, z: b.z },
        { maxNodes: 150000, margin: 24 });
    const ms = Date.now() - t0;

    if (!plan.ok) {
        res.fail++;
        const code = plan.code ?? 'UNKNOWN';
        res.codes[code] = (res.codes[code] ?? 0) + 1;
        continue;
    }
    res.ok++;
    res.nodes.push(plan.nodes);
    res.ms.push(ms);
    // ★ 区分「真到达」和「退化到最远可达点」：plan3D 目标不可达时返回 ok=true 但终点不是目标
    if (Math.hypot(plan.goal.x - b.x, plan.goal.z - b.z) <= 3) res.reached++;
    // 绕路比
    let len = 0;
    for (let i = 1; i < plan.path.length; i++) {
        len += Math.hypot(plan.path[i].x - plan.path[i - 1].x, plan.path[i].z - plan.path[i - 1].z);
    }
    const straight = Math.hypot(plan.goal.x - a.x, plan.goal.z - a.z);
    if (straight > 1) res.ratios.push(len / straight);
    // 实际到达 vs 目标距离（说明是否被"最远可达点"截断）
    const goalErr = Math.hypot(plan.goal.x - b.x, plan.goal.z - b.z);
    res.gone.push(goalErr);
}

// ---------- 报告 ----------
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

console.log(`\n=== 真实地图规划基准（采样 ${TRIALS} 次，跳过 ${skipped} 次）===`);
console.log('距离区间   试验  有路  真到达  真到达率  绕路比  节点    耗时  终点偏差');
for (const res of results) {
    if (!res.trials) { console.log(`${res.name.padEnd(10)}  (无样本)`); continue; }
    const sr = res.reached / res.trials;   // ★ 用真到达率
    console.log(
        `${res.name.padEnd(10)} ${String(res.trials).padStart(4)} ${String(res.ok).padStart(4)} ` +
        `${String(res.reached).padStart(5)} ${(sr * 100).toFixed(0).padStart(7)}% ` +
        `${avg(res.ratios).toFixed(2).padStart(7)} ` +
        `${avg(res.nodes).toFixed(0).padStart(6)} ${avg(res.ms).toFixed(0).padStart(5)}ms ` +
        `${avg(res.gone).toFixed(1).padStart(8)}`);
}

const totT = results.reduce((s, x) => s + x.trials, 0);
const totOk = results.reduce((s, x) => s + x.ok, 0);
const totReach = results.reduce((s, x) => s + x.reached, 0);
console.log(`
总体：${totOk}/${totT} = ${(totOk / Math.max(1, totT) * 100).toFixed(0)}% 有路径，其中**真到达目标** ${totReach}/${totT} = ${(totReach / Math.max(1, totT) * 100).toFixed(0)}%`);
console.log(`（差值 ${totOk - totReach} 次是规划退化到最远可达点，目标本身没到）`);

console.log('\n=== 失败原因分布 ===');
const allCodes = {};
for (const res of results) {
    for (const [k, v] of Object.entries(res.codes)) allCodes[k] = (allCodes[k] ?? 0) + v;
}
const codeDesc = {
    NO_PATH: '搜索耗尽但没到（真的不连通）',
    NO_DATA: '搜索范围内没有地形数据',
    NO_START: '起点脚下没有可站立面记录',
    BUDGET: '节点预算用完',
};
const sorted = Object.entries(allCodes).sort((a, b) => b[1] - a[1]);
for (const [code, n] of sorted) {
    console.log(`  ${code.padEnd(10)} ${String(n).padStart(4)} 次  ${codeDesc[code] ?? ''}`);
}
if (!sorted.length) console.log('  （没有失败）');

// 失败记忆现状
const fails = readFails(MAP);
console.log(`\n=== 失败记忆 ===`);
console.log(`  当前有效条目：${fails.size} 条`);

// 距离与成功率的关系
console.log('\n=== 关键结论 ===');
const near = results.filter(x => x.name === '16-32' || x.name === '32-64');
const far = results.filter(x => x.name === '128-256' || x.name === '256+');
const rate = (arr) => {
    const t = arr.reduce((s, x) => s + x.trials, 0), o = arr.reduce((s, x) => s + x.ok, 0);
    return t ? o / t : null;
};
const rNear = rate(near), rFar = rate(far);
if (rNear != null && rFar != null) {
    console.log(`  近距离（16~64 格）成功率：${(rNear * 100).toFixed(0)}%`);
    console.log(`  远距离（128+ 格）成功率：${(rFar * 100).toFixed(0)}%`);
    console.log(`  → ${rFar < rNear - 0.15 ? '远距离明显更差，问题在"搜索范围/数据覆盖"' : '远近差距不大'}`);
}
