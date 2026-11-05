// 验收 .mca 导入：导完要能答「没去过的地方长什么样」，且与实扫结果一致。
import { importRegionDir } from '../src/agent/library/mca_import.js';
import { getChunk, openMapReader } from '../src/agent/library/chunk_map.js';
import { classifyChunk, renderTileGrid } from '../src/agent/library/tile_map.js';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'fs';
import os from 'node:os';
import { join } from 'node:path';

// ★ T17（并发加固）：**每进程一个独立 bots 根** —— 否则并发跑时
//   `rmSync(DIR)` 会删掉别人正在用的地图库（表现为「随机变红、单跑全绿」）。
process.env.MC_BOTS_ROOT ??= mkdtempSync(join(os.tmpdir(), 'probe-map-mca-'));
const DIR = `${process.env.MC_BOTS_ROOT}/probe/map-mca`;
const REGION = './';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

// 1) 导入全部区域
const r = importRegionDir(REGION, DIR);
console.log(`  导入 ${r.files} 个区域文件，${r.chunks} 个区块，${r.ms}ms`);
check('能导入 .mca 区块', r.chunks > 500, `${r.chunks} 个`);
check('导入速度够快（<10s）', r.ms < 10000, `${r.ms}ms`);

// 2) 抽查：她家门口 (-7,-14) 附近应该已经知道地形
const reader = openMapReader(DIR);
const home = reader.chunk(-7, -14);
check('她家门口区块已有地形数据（没走过也知道）', !!home && home.explored === true,
    home ? `y=${home.y} h=${home.h} 水=${home.water} 建筑=${home.built}` : 'null');
check('数据来源标记为 mca', home?.source === 'mca', String(home?.source));

// 3) 地形标签要合理
if (home) {
    const t = classifyChunk(home);
    check('能归类地形', /平地|丘陵|树林|陡坡|建筑区|水面/.test(t.label), `${t.label}（sym=${t.sym}）`);
}

// 4) 覆盖范围要够大
let total = 0, xs = [], zs = [];
for (let cx = -40; cx <= 10; cx += 4) {
    for (let cz = -50; cz <= 10; cz += 4) {
        const c = reader.chunk(cx, cz);
        if (c) { total++; xs.push(cx); zs.push(cz); }
    }
}
console.log(`  抽样 4 格步长扫描：命中 ${total} 个区块，x 范围 ${Math.min(...xs)}..${Math.max(...xs)}，z 范围 ${Math.min(...zs)}..${Math.max(...zs)}`);
check('导入覆盖范围够大（x/z 跨度 >8 区块）',
    (Math.max(...xs) - Math.min(...xs)) > 8 && (Math.max(...zs) - Math.min(...zs)) > 8,
    `x ${Math.min(...xs)}..${Math.max(...xs)}, z ${Math.min(...zs)}..${Math.max(...zs)}`);

// 5) 渲染她家附近的格图（证明「没去过也能给图」）
const grid = renderTileGrid(DIR, -7, -14, 4);
console.log('\n--- 她家附近格图（来自存档，不需要走过去）---');
grid.rows.forEach(row => console.log('  ' + row));
console.log('  ' + grid.legend);
check('能给出她当前位置的格图', grid.rows.length === 9 && grid.rows.join('').includes('@'));

// 6) 与真实情况对照：主世界这一带的 y 应该在 44~95 之间
const ys = [];
for (let cx = -12; cx <= -2; cx++) for (let cz = -20; cz <= -10; cz++) {
    const c = reader.chunk(cx, cz);
    if (c && c.y) ys.push(c.y);
}
const avgY = ys.reduce((a, b) => a + b, 0) / ys.length;
check('地表高度合理（40~110）', avgY > 40 && avgY < 110, `平均 y=${avgY.toFixed(1)}，样本 ${ys.length}`);
check('高度有变化（不是全同一个值）', new Set(ys).size > 5, `${new Set(ys).size} 种不同高度`);

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
