// 战棋层验收：真实主世界，看标签、格图、代价 A* 路线。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { scanArea, getChunk } from '../src/agent/library/chunk_map.js';
import { classifyChunk, tileCost, tileAStar, renderTileGrid, describeTile } from '../src/agent/library/tile_map.js';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'fs';
import os from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ★ T17（并发加固）：**每进程一个独立 bots 根** —— 否则并发跑时
//   `rmSync(DIR)` 会删掉别人正在用的地图库（表现为「随机变红、单跑全绿」）。
process.env.MC_BOTS_ROOT ??= mkdtempSync(join(os.tmpdir(), 'probe-map-tile-'));
const DIR = `${process.env.MC_BOTS_ROOT}/probe/map-tile`;
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 100)); process.exit(2); });

bot.once('spawn', async () => {
    await sleep(3000);
    const p = bot.entity.position;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    console.log(`  spawn ${p.floored()} 格(${cx},${cz})`);

    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    const r = scanArea(bot, DIR, cx, cz, 4);
    console.log(`  扫描 ${r.scanned} 格，${r.ms}ms`);

    // 1) 标签分布
    const counts = {};
    for (let dx = -4; dx < 4; dx++) for (let dz = -4; dz < 4; dz++) {
        const t = classifyChunk(getChunk(DIR, cx + dx, cz + dz));
        counts[t.label] = (counts[t.label] || 0) + 1;
    }
    console.log('  地形分布:', JSON.stringify(counts));
    check('能分出多种地形', Object.keys(counts).length >= 2, Object.keys(counts).join('/'));

    // 2) 格图可读
    const grid = renderTileGrid(DIR, cx, cz, 4);
    console.log('\n--- 格图 ---');
    console.log(grid.north);
    grid.rows.forEach(row => console.log('  ' + row));
    console.log('  图例: ' + grid.legend);
    check('格图有 9 行（半径4）', grid.rows.length === 9, `${grid.rows.length} 行`);
    check('格图有「我」标记', grid.rows.join('').includes('@'));
    check('格图有图例', /@我/.test(grid.legend));

    // 3) 我在哪（一句话）
    const desc = describeTile(DIR, cx, cz);
    console.log('\n  当前位置: ' + desc);
    check('能说明我在哪一格、什么地形', /我在格 \(-?\d+,-?\d+\)/.test(desc) && /平地|树林|丘陵|水面|建筑|陡坡/.test(desc), '');

    // 4) 代价 A*：目标选远处的某格
    const goal = { x: (cx + 6) * 16, z: (cz + 6) * 16 };
    const t0 = Date.now();
    const route = tileAStar(DIR, { x: p.x, z: p.z }, goal);
    const ms = Date.now() - t0;
    console.log(`\n  去格(${cx + 6},${cz + 6})：${route.path.length} 格，代价 ${route.cost.toFixed(1)}，搜索 ${route.nodes} 节点，${ms}ms`);
    console.log('  路线: ' + route.path.map(s => `(${s.cx},${s.cz})${s.label}`).join(' → '));
    check('A* 能规划出路线', route.path.length > 0, `${route.path.length} 格`);
    check('A* 起点终点正确', route.path[0].cx === cx && route.path[0].cz === cz &&
        route.path[route.path.length - 1].cx === cx + 6, '');
    check('A* 够快（<50ms）', ms < 50, `${ms}ms`);

    // 5) 关键：路线不能穿过禁行格（岩浆）
    const bad = route.path.filter(s => s.sym === '!');
    check('路线不穿过岩浆格', bad.length === 0, `${bad.length} 个`);

    // 6) 对比：直线 vs A* 的代价（验证「直线不是最优」）
    const straightCost = (() => {
        let c = 0;
        const n = Math.max(Math.abs(6), Math.abs(6));
        for (let i = 0; i <= n; i++) {
            const x = cx + Math.round(6 * i / n), z = cz + Math.round(6 * i / n);
            const inf = getChunk(DIR, x, z);
            if (inf) c += tileCost(inf);
        }
        return c;
    })();
    console.log(`  直线路径代价 ${straightCost.toFixed(1)} vs A* 代价 ${route.cost.toFixed(1)}`);
    check('A* 代价 ≤ 直线代价（或相近）', route.cost <= straightCost * 1.3,
        `A*=${route.cost.toFixed(1)} 直线=${straightCost.toFixed(1)}`);

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
