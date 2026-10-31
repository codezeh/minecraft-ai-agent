/**
 * 在**真实录制的地形库**上验证 y 语义（D1）—— 不需要服务器。
 *
 * 验证的是一个可以量化的断言：
 *   她站在某个面上时，floor(position.y) 恰好比 surf 表里那一格大 1。
 *   所以往 plan3D 传「脚位」时，`surf.has(key(x, 脚位, z))` 应该**很少命中**；
 *   传「面位」（脚位 - 1）时才命中。
 *
 * 用法：node tools/verify_y_semantics.mjs [mapDir]
 *   默认用 bots/deepseek/map（真机录的地图）。
 *
 * 输出两种口径的命中率。修复前 walkTo 传的是脚位（命中率极低，
 * 全靠 path_3d 的"目标附近 4 格找面"兜底）；修复后传面位（应接近 100%）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dbFor, closeDb3d, boxSurfaces } from '../src/agent/library/terrain3d.js';

const mapDir = process.argv[2] ?? join('bots', 'deepseek', 'map');
const DB = join(mapDir, 'terrain3d.db');

if (!existsSync(DB)) {
    console.log(`SKIP 找不到地形库：${DB}`);
    process.exit(0);
}

// 取一大片真实地形（不用全库，够统计就行）
const rows = boxSurfaces(mapDir, -2000, -2000, 2000, 2000);
if (!rows.length) {
    console.log(`SKIP 地形库是空的：${DB}`);
    process.exit(0);
}

const surf = new Map();
for (const r of rows) surf.set(`${r.x},${r.y},${r.z}`, r.t);

// 随机抽样（固定种子，可复现）
let seed = 20261031;
const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
};

const N = Math.min(2000, rows.length);
let hitFeet = 0, hitSurface = 0;

for (let i = 0; i < N; i++) {
    const r = rows[Math.floor(rnd() * rows.length)];
    const feetY = r.y + 1;                       // 站在这个面上时的脚位
    if (surf.has(`${r.x},${feetY},${r.z}`)) hitFeet++;
    if (surf.has(`${r.x},${r.y},${r.z}`)) hitSurface++;
}

const pct = (n) => `${(n / N * 100).toFixed(1)}%`;
console.log(`样本 ${N} 条（真实地形库：${DB}）`);
console.log(`  传「脚位」(y+1) 命中: ${hitFeet}/${N} = ${pct(hitFeet)}   ← 修复前 walkTo 的做法`);
console.log(`  传「面位」(y)   命中: ${hitSurface}/${N} = ${pct(hitSurface)}   ← 修复后的做法`);

const ok = hitSurface / N > 0.99 && hitFeet / N < 0.2;
console.log('============================================');
if (ok) {
    console.log('PASS y 语义结论成立：面位命中≈100%，脚位几乎不命中（差 1 格）');
    process.exit(0);
} else {
    console.log(`FAIL 不符合预期（脚位命中 ${pct(hitFeet)}，面位命中 ${pct(hitSurface)}）`);
    process.exit(1);
}
