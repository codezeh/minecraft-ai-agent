// 测量：主世界地图里有没有「可用的平坦走廊」，用来判断分层路网（A）值不值得做。
// 只读已导入的地图数据，不连服务器。
import { openMapReader } from '../src/agent/library/chunk_map.js';
import { classifyChunk, tileCost } from '../src/agent/library/tile_map.js';
import { readdirSync, readFileSync } from 'fs';

const DIR = './bots/probe/map-split';

// 收集所有已探索区块
const files = readdirSync(DIR).filter(f => f.endsWith('.json'));
const grid = new Map();       // "cx,cz" -> info
for (const f of files) {
    try {
        const d = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
        for (const [k, v] of Object.entries(d)) grid.set(k, v);
    } catch { /* 坏文件跳过 */ }
}

console.log(`已探索区块 ${grid.size} 个`);

// 1) 地形分布
const dist = {};
for (const info of grid.values()) {
    const t = classifyChunk(info);
    dist[t.label] = (dist[t.label] || 0) + 1;
}
console.log('地形分布:', JSON.stringify(dist));

// 2) 可走 = 平地或丘陵（cost <= 5）
const walkable = new Set();
for (const [k, info] of grid) {
    const c = tileCost(info);
    if (c > 0 && c <= 5) walkable.add(k);
}
console.log(`可走区块（平地+丘陵）：${walkable.size} / ${grid.size}`);

// 3) 最大连通块（4 邻接 BFS）
const seen = new Set();
let best = { size: 0, sample: null };
for (const k of walkable) {
    if (seen.has(k)) continue;
    const queue = [k];
    const comp = [];
    seen.add(k);
    while (queue.length) {
        const cur = queue.pop();
        comp.push(cur);
        const [cx, cz] = cur.split(',').map(Number);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = `${cx + dx},${cz + dz}`;
            if (walkable.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(nk); }
        }
    }
    if (comp.length > best.size) best = { size: comp.length, sample: comp.slice(0, 5) };
}
console.log(`最大连通走廊：${best.size} 个区块（约 ${best.size * 16} 格规模）`);
if (best.sample) console.log(`  样例区块: ${best.sample.join(' ')}`);

// 4) 结论判据
const ratio = walkable.size / Math.max(1, grid.size);
console.log(`\n可走占比 ${(ratio * 100).toFixed(0)}%，最大连通块 ${best.size} 区块`);
if (ratio > 0.5 && best.size >= 40) {
    console.log('结论：存在成规模的走廊 → 分层路网（A）值得做');
} else if (ratio > 0.3) {
    console.log('结论：走廊零碎 → A 收益有限，建议只做 D（记忆化）+ E（地形跟随）');
} else {
    console.log('结论：地形太碎 → A 不值得做');
}
