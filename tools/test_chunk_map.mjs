// 验收：区块地图（扫描 / 持久化 / 未探索 / 粗规划路标 / 性能）。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { scanArea, getChunk, describeArea, coarseWaypoints, findChunkWith } from '../src/agent/library/chunk_map.js';
import { mkdirSync, rmSync, existsSync } from 'fs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c);
const DIR = './bots/probe/map';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 100)); process.exit(2); });

bot.once('spawn', async () => {
    await sleep(2200);
    await RC('op probe');
    await RC('gamemode survival probe');

    // 造地形：按区块逐个铺（一次 fill 太大容易超时），覆盖 8×8 区块范围。
    // 注意：测试服原始地层基岩在 y=-49（不是 -61），远处区块不铺的话读到的是原始层。
    const pcx = Math.floor(bot.entity.position.x / 16);
    const pcz = Math.floor(bot.entity.position.z / 16);
    for (let dx = -4; dx < 4; dx++) {
        for (let dz = -4; dz < 4; dz++) {
            const x0 = (pcx + dx) * 16, z0 = (pcz + dz) * 16;
            await RC(`fill ${x0} -61 ${z0} ${x0 + 15} -61 ${z0 + 15} grass_block`);
            await RC(`fill ${x0} -60 ${z0} ${x0 + 15} -60 ${z0 + 15} air`);
        }
    }
    await RC('fill 20 -60 -4 28 -60 4 water');          // 水面（地上一层）
    await RC('fill -28 -64 -4 -20 -55 4 stone');        // 高地（从原地面立起来）

    // 关键：服务端 fill 之后，已加载的区块不会自动重下发，客户端看到的还是旧地形。
    // 必须走开再回来（或传送很远再回来）触发区块重新加载。
    await RC('tp probe 500.5 -60 500.5');
    await sleep(1200);
    await RC('tp probe 0.5 -60 0.5');
    await sleep(2500);

    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });

    const p = bot.entity.position;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);

    // 1) 扫描性能
    const t0 = Date.now();
    const r = scanArea(bot, DIR, cx, cz, 4);     // 8×8 区块 = 128×128 格
    const ms = Date.now() - t0;
    check('扫描 8×8 区块', r.scanned > 0, `已扫 ${r.scanned}，跳过 ${r.skipped}，用时 ${ms}ms`);
    check('扫描耗时 < 400ms（不阻塞心跳）', ms < 400, `${ms}ms`);

    // 2) 持久化 + 读回
    const c00 = getChunk(DIR, cx, cz);
    check('中心区块已入库', !!c00 && c00.explored === true, JSON.stringify(c00).slice(0, 120));
    check('记录了地表高度', typeof c00?.y === 'number' && Number.isFinite(c00.y), `y=${c00?.y}`);

    // 3) 未探索区域返回 null（前端据此画「未探索」）
    const far = getChunk(DIR, cx + 40, cz + 40);
    check('远方未探索区块返回 null', far === null, String(far));

    // 4) 能区分水/石地形（8×8 抽样，水面只占区块一部分，阈值取 0.15）
    let waterChunks = 0, stoneChunks = 0;
    for (let dx = -4; dx < 4; dx++) for (let dz = -4; dz < 4; dz++) {
        const c = getChunk(DIR, pcx + dx, pcz + dz);
        if (!c) continue;
        if (c.water > 0.15) waterChunks++;
        if (c.h >= 3) stoneChunks++;
    }
    check('扫到了水面区块', waterChunks > 0, `${waterChunks} 个`);
    check('扫到了高地区块', stoneChunks > 0, `${stoneChunks} 个`);

    // 5) 文字摘要（给模型读）
    const desc = describeArea(DIR, cx, cz, 4);
    check('摘要能说明探索比例', /已探索 \d+\/\d+/.test(desc), desc.slice(0, 100));

    // 6) 粗规划路标
    const wps = coarseWaypoints(DIR, { x: 0, z: 0 }, { x: 120, z: 60 });
    check('粗规划产出路标', wps.length >= 3, `${wps.length} 个路标，首个 (${wps[0]?.cx},${wps[0]?.cz})`);
    const wpsOk = wps.every(w => Number.isFinite(w.x) && Number.isFinite(w.z));
    check('路标坐标有效', wpsOk);
    const hasExploredFlag = wps.every(w => typeof w.explored === 'boolean');
    check('路标带 explored 标记', hasExploredFlag);

    // 7) 找最近的目标区块
    const hits = findChunkWith(DIR, cx, cz, 6, c => c.water > 0.5);
    check('能按条件找区块（找水）', hits.length > 0, `命中 ${hits.length} 个，最近 (${hits[0]?.cx},${hits[0]?.cz}) kind=${hits[0]?.kind}`);

    // 8) 重复扫描幂等（不会丢已有数据）
    const before = getChunk(DIR, cx, cz).seenAt;
    await sleep(50);
    scanArea(bot, DIR, cx, cz, 1);
    const after = getChunk(DIR, cx, cz).seenAt;
    check('重复扫描会刷新 seenAt 且不破坏结构', after >= before && getChunk(DIR, cx, cz).explored === true);

    await RC('fill 20 -61 -4 28 -61 4 air');
    await RC('fill -28 -60 -4 -20 -55 4 air');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
