// 主世界真实地形的地图验收：验证地图能回答「我附近有什么」。
// 只读，不改任何方块。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { scanArea, getChunk, describeArea, coarseWaypoints, findChunkWith } from '../src/agent/library/chunk_map.js';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'fs';
import os from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ★ T17（并发加固）：**每进程一个独立 bots 根** —— 否则并发跑时
//   `rmSync(DIR)` 会删掉别人正在用的地图库（表现为「随机变红、单跑全绿」）。
process.env.MC_BOTS_ROOT ??= mkdtempSync(join(os.tmpdir(), 'probe-map-main-'));
const DIR = `${process.env.MC_BOTS_ROOT}/probe/map-main`;

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
    console.log(`  spawn ${p.floored()} 区块(${cx},${cz})`);

    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });

    const t0 = Date.now();
    const r = scanArea(bot, DIR, cx, cz, 4);
    const ms = Date.now() - t0;
    check('真实地形扫 8×8 区块', r.scanned >= 48, `成功 ${r.scanned}，未加载 ${r.skipped}，${ms}ms`);
    check('扫描够快（<1s，不卡心跳）', ms < 1000, `${ms}ms`);

    // 逐项确认比例值都在 0..1（之前因为按层累加出现过 水=17.58）
    let badRatio = 0, checked = 0;
    for (let dx = -4; dx < 4; dx++) for (let dz = -4; dz < 4; dz++) {
        const c = getChunk(DIR, cx + dx, cz + dz);
        if (!c) continue;
        checked++;
        for (const k of ['water', 'lava', 'built', 'leaves']) {
            if (c[k] < 0 || c[k] > 1) badRatio++;
        }
    }
    check('所有比例值都在 0..1', badRatio === 0, `检查 ${checked} 个区块，越界 ${badRatio} 处`);

    // 地表高度必须落在世界范围内（之前读到一堆 y=63 的假石头）
    let badY = 0;
    for (let dx = -4; dx < 4; dx++) for (let dz = -4; dz < 4; dz++) {
        const c = getChunk(DIR, cx + dx, cz + dz);
        if (!c) continue;
        if (!(c.y >= -64 && c.y <= 120)) badY++;
    }
    check('地表高度都在合理范围', badY === 0, `越界 ${badY} 处`);

    // 真实地形必须有起伏（全 0 说明扫描又错了）
    let varying = 0;
    for (let dx = -4; dx < 4; dx++) for (let dz = -4; dz < 4; dz++) {
        const c = getChunk(DIR, cx + dx, cz + dz);
        if (c && c.h > 5) varying++;
    }
    check('真实地形有高程差（h>5 的区块存在）', varying > 0, `${varying} 个区块 h>5`);

    // 能找到水（主世界附近确实有水面，刚才实测有水区块）
    const water = findChunkWith(DIR, cx, cz, 4, c => c.water > 0.5);
    check('能按条件找到水区块', water.length > 0,
        water.length ? `最近 (${water[0].cx},${water[0].cz}) 水=${water[0].info.water}` : '没找到');

    // 能找到平地（粗规划要落脚点）
    const flat = findChunkWith(DIR, cx, cz, 4, c => c.h <= 3 && c.water < 0.1 && c.built < 0.1);
    check('能按条件找到平坦区块', flat.length > 0,
        flat.length ? `最近 (${flat[0].cx},${flat[0].cz}) y=${flat[0].info.y} h=${flat[0].info.h}` : '没找到');

    // 摘要可读
    const desc = describeArea(DIR, cx, cz, 4);
    check('文字摘要能说明地形', /已探索/.test(desc) && /地表 y=/.test(desc), desc.slice(0, 90));

    // 粗规划：路标要标出未探索段
    const wps = coarseWaypoints(DIR, { x: p.x, z: p.z }, { x: p.x + 300, z: p.z + 200 });
    const unexplored = wps.filter(w => !w.explored).length;
    check('粗规划路标标出未探索段', wps.length > 0 && unexplored > 0,
        `${wps.length} 个路标，其中未探索 ${unexplored} 个`);

    // 落盘可读回（前端要能直接读）
    const reread = getChunk(DIR, cx, cz);
    check('落盘后可读回', !!reread && reread.explored === true, `y=${reread?.y}`);

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
