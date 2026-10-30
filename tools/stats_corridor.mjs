// 统计：你的世界里「平坦走廊」到底有多少，决定分层路网（A）值不值得做。
// 只读地图数据，不连游戏。
import { openMapReader } from '../src/agent/library/chunk_map.js';
import { classifyChunk } from '../src/agent/library/tile_map.js';
import { readdirSync, existsSync, readFileSync } from 'fs';

const DIR = './bots/probe/map-mca';
if (!existsSync(DIR)) {
    console.log('没有地图数据，先跑 tools/test_mca_import.mjs');
    process.exit(1);
}

const reader = openMapReader(DIR);

// 收集所有已探索区块
const chunks = new Map();
for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const data = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
    for (const [k, v] of Object.entries(data)) chunks.set(k, v);
}
console.log(`已探索区块 ${chunks.size} 个（约 ${(chunks.size * 256 / 1e6).toFixed(2)} 百万平方米）\n`);

// 分类统计
const byKind = {};
for (const [k, c] of chunks) {
    const t = classifyChunk(c).label;
    byKind[t] = (byKind[t] || 0) + 1;
}
console.log('地形分布:');
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v} 个 (${(v / chunks.size * 100).toFixed(1)}%)`);
}

// 可通行 = 平地/丘陵/树林（不是水、岩浆、陡坡、建筑）
const passable = (c) => {
    if (!c) return false;
    const t = classifyChunk(c).label;
    return t === '平地' || t === '丘陵' || t === '树林';
};

// 找最大的连通可通行区域（4 邻接）
console.log('\n最大的连通可通行区域:');
const visited = new Set();
let best = { size: 0, cells: [] };
for (const [k, c] of chunks) {
    if (visited.has(k) || !passable(c)) continue;
    const stack = [k];
    const region = [];
    visited.add(k);
    while (stack.length) {
        const cur = stack.pop();
        region.push(cur);
        const [cx, cz] = cur.split(',').map(Number);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = `${cx + dx},${cz + dz}`;
            if (visited.has(nk) || !chunks.has(nk)) continue;
            if (!passable(chunks.get(nk))) continue;
            visited.add(nk);
            stack.push(nk);
        }
    }
    if (region.length > best.size) best = { size: region.length, cells: region };
}
console.log(`  最大连通区 ${best.size} 个区块（约 ${best.size * 256} 平方米 = ${(best.size * 256 / 1e4).toFixed(1)} 公顷）`);
if (best.cells.length) {
    const xs = best.cells.map(k => +k.split(',')[0]);
    const zs = best.cells.map(k => +k.split(',')[1]);
    console.log(`  范围 x ${Math.min(...xs)}..${Math.max(...xs)}，z ${Math.min(...zs)}..${Math.max(...zs)}`);
    console.log(`  跨 ${Math.max(...xs) - Math.min(...xs) + 1} × ${Math.max(...zs) - Math.min(...zs) + 1} 个区块`);
}

// 从家门口出发，四个方向的连续可通行距离
const HOME = { cx: -7, cz: -14 };
console.log(`\n从家门口 (${HOME.cx},${HOME.cz}) 出发，各方向连续可走多远（区块数）:`);
for (const [name, dx, dz] of [['东', 1, 0], ['西', -1, 0], ['南', 0, 1], ['北', 0, -1]]) {
    let n = 0;
    for (let i = 1; i <= 40; i++) {
        const c = reader.chunk(HOME.cx + dx * i, HOME.cz + dz * i);
        if (!passable(c)) break;
        n = i;
    }
    console.log(`  ${name}: ${n} 个区块（${n * 16} 格）`);
}

// 「平坦」连续段（比可通行更严：只要平地/丘陵，不要树林）
console.log('\n各方向「平坦」连续段（不含树林）:');
for (const [name, dx, dz] of [['东', 1, 0], ['西', -1, 0], ['南', 0, 1], ['北', 0, -1]]) {
    let n = 0;
    for (let i = 1; i <= 40; i++) {
        const c = reader.chunk(HOME.cx + dx * i, HOME.cz + dz * i);
        const t = c ? classifyChunk(c).label : null;
        if (t !== '平地' && t !== '丘陵') break;
        n = i;
    }
    console.log(`  ${name}: ${n} 个区块（${n * 16} 格）`);
}
