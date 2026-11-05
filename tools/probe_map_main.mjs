// 真实主世界试扫：只读，不改任何方块。
// 目的：看区块地图在真实地形下能不能读出「水 / 建筑 / 森林 / 落差」。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { scanArea, getChunk, describeArea, coarseWaypoints } from '../src/agent/library/chunk_map.js';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'fs';
import os from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });      // 主服
// ★ T17（并发加固）：**每进程一个独立 bots 根** —— 否则并发跑时
//   `rmSync(DIR)` 会删掉别人正在用的地图库（表现为「随机变红、单跑全绿」）。
process.env.MC_BOTS_ROOT ??= mkdtempSync(join(os.tmpdir(), 'probe-map-main2-'));
const DIR = `${process.env.MC_BOTS_ROOT}/probe/map-main`;

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 120)); process.exit(2); });

bot.once('spawn', async () => {
    await sleep(3000);
    const p = bot.entity.position;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    console.log(` spawn 在 ${p.floored()}，区块 (${cx},${cz})`);

    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });

    const t0 = Date.now();
    const r = scanArea(bot, DIR, cx, cz, 4);
    const ms = Date.now() - t0;
    console.log(`\n扫 8×8 区块：成功 ${r.scanned}，未加载 ${r.skipped}，用时 ${ms}ms`);

    // 逐区块打印，看真实地形的多样性
    console.log('\n区块明细（只列有特点的）：');
    let water = 0, built = 0, leafy = 0, steep = 0;
    for (let dx = -4; dx < 4; dx++) {
        for (let dz = -4; dz < 4; dz++) {
            const c = getChunk(DIR, cx + dx, cz + dz);
            if (!c) continue;
            if (c.water > 0.2) water++;
            if (c.built > 0.2) built++;
            if (c.leaves > 0.2) leafy++;
            if (c.h > 10) steep++;
            if (c.water > 0.2 || c.built > 0.2 || c.leaves > 0.2 || c.h > 10) {
                console.log(`  (${cx + dx},${cz + dz}) y=${c.y} 高差=${c.h} 水=${c.water} 建筑=${c.built} 叶=${c.leaves}`);
            }
        }
    }
    console.log(`\n统计：有水 ${water} 个、有建筑 ${built} 个、有树林 ${leafy} 个、落差>10 ${steep} 个`);

    console.log('\n文字摘要：', describeArea(DIR, cx, cz, 4));

    // 粗规划演练：从当前点到 100 格外
    const tx = Math.floor(p.x) + 100, tz = Math.floor(p.z) + 60;
    const wps = coarseWaypoints(DIR, { x: p.x, z: p.z }, { x: tx, z: tz });
    console.log(`\n粗规划到 (${tx},${tz})：${wps.length} 个路标`);
    console.log(wps.map(w => `(${w.cx},${w.cz})${w.explored ? '' : '未探索'}`).join(' → '));

    // 读一个未探索区块（验证前端能画空白）
    const far = getChunk(DIR, cx + 30, cz + 30);
    console.log(`\n30 区块外：${far === null ? 'null（未探索，前端画空白）' : JSON.stringify(far)}`);

    bot.quit();
    process.exit(0);
});
