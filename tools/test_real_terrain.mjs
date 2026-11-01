// 主世界真实地形验收：S2（砍 8 个橡木）+ S3（3×3 平台）。
// 用独立 probe 账号，不干扰 deepseek；只测代码在真实地形的成功率。
// 选点：在几个锚点里找橡木最多的那个，避免落在你房子/仓库上。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { collect } from '../src/agent/library/flow_collect.js';
import { placePlatform } from '../src/agent/library/flow_platform.js';
import { countItem, blockAt, findBlocks } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
let STAGE = 'init';
bot.on('kicked', (r) => { console.log('KICKED during stage:', STAGE, JSON.stringify(r).slice(0, 160)); process.exit(2); });

const ANCHORS = [
    [-150, 70, -230],
    [-220, 70, -120],
    [80, 70, -260],
];

async function tp(x, y, z) {
    // 不用传送：tp 在真实地形下反复触发 invalid_player_movement（客户端位置包与服务端不一致）。
    // 改成「就走过去」：先把目标点告诉 pathfinder，让它自己走。
    // 近距离（<60 格）时这比 tp 稳，而且更接近真实游玩。
    const d = Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z);
    if (d < 6) { await sleep(500); return; }
    try {
        const goal = new pf.goals.GoalNear(x, y, z, 3);
        await withTimeout(bot.pathfinder.goto(goal), Math.min(120000, 2000 + d * 400));
    } catch (e) {
        console.log(`        [walk 警告] 走到 (${x},${z}) 失败: ${e.message}`);
    }
    await sleep(500);
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('walk timeout')), ms)),
    ]);
}

bot.once('spawn', async () => {
    await sleep(2500);
    await RC('op probe');
    await RC('gamemode survival probe');
    bot.interrupt_code = false;

    // ---- 选点：从出生点出发，不传送（tp 在真实地形下反复被踢）。
    // 出生点本来就在森林里，直接扫附近的树。
    STAGE = 'scan';
    console.log(`        出生点 ${bot.entity.position.floored()}，半径 64 内 oak_log: ${findBlocks(bot, 'oak_log', 64, 200).length}`);

    // ---- S2：砍 8 个橡木（8 分钟判据）
    STAGE='s2-setup';
    await RC('clear probe');
    await RC('give probe iron_axe 1');
    await sleep(800);
    const before = countItem(bot, 'oak_log');
    const t2 = Date.now();
    STAGE='s2-collect';
    const r2 = await collect(bot, 'oak_log', 8, { deadlineMs: 8 * 60 * 1000 });
    const dt2 = Date.now() - t2;
    const gained = countItem(bot, 'oak_log') - before;
    const honest2 = r2.ok && r2.data?.count === gained;
    check(`S2 主世界砍 8 橡木（真实地形）`, honest2 && gained >= 8,
        `报数=${r2.data?.count} 实际=${gained} 用时=${(dt2 / 1000).toFixed(1)}s code=${r2.code} ${r2.message ?? ''}`);

    // ---- S3：3×3 平台
    // 真实地形里通常没有现成的 3×3 空地，按方案「场景可以用 RCON 造」的纪律：
    // 附近挑一个地面最平的中心，清掉 9 格上方，再铺。这才是公平的放置测试。
    let spot = null;
    let bestScore = -1;
    const p0 = bot.entity.position.floored();
    for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
            const cx = p0.x + dx, cz = p0.z + dz;
            const ground = blockAt(bot, { x: cx, y: p0.y - 1, z: cz });
            const solidGround = ground && !['air', 'water', 'lava', 'oak_leaves'].includes(ground.name);
            if (!solidGround) continue;
            let score = 0;
            for (let ax = -1; ax <= 1; ax++) for (let az = -1; az <= 1; az++) {
                const g2 = blockAt(bot, { x: cx + ax, y: p0.y - 1, z: cz + az });
                const solid2 = g2 && !['air', 'water', 'lava', 'oak_leaves'].includes(g2.name);
                if (!solid2) continue;
                score++;   // 地面越连续越好
            }
            if (score > bestScore) { bestScore = score; spot = { x: cx, y: p0.y, z: cz }; }
        }
    }
    if (!spot) {
        check('S3 主世界 3×3 平台', false, '附近找不到像样的地面');
    } else {
        // 清出 3×3 × 2 格高的空间（树叶/草），并保证地面实心
        await RC(`fill ${spot.x - 1} ${spot.y} ${spot.z - 1} ${spot.x + 1} ${spot.y + 1} ${spot.z + 1} air`);
        await RC(`fill ${spot.x - 1} ${spot.y - 1} ${spot.z - 1} ${spot.x + 1} ${spot.y - 1} ${spot.z + 1} grass_block`);
        await sleep(600);
        let okCells = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            const b = blockAt(bot, { x: spot.x + dx, y: spot.y, z: spot.z + dz });
            if (b && ['air', 'cave_air', 'short_grass', 'tall_grass'].includes(b.name)) okCells++;
        }
        await RC('give probe oak_planks 64');
        await sleep(500);
        const t3 = Date.now();
        STAGE='s3-place';
        const r3 = await placePlatform(bot, 'oak_planks', spot);
        const dt3 = Date.now() - t3;
        let verified = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            if (blockAt(bot, { x: spot.x + dx, y: spot.y, z: spot.z + dz })?.name === 'oak_planks') verified++;
        }
        check('S3 主世界 3×3 平台（9 格核验）', r3.ok && verified === 9,
            `报数=${r3.data?.placed}/9 实测=${verified}/9 用时=${(dt3 / 1000).toFixed(1)}s 空地=${okCells}/9 code=${r3.code} ${r3.message ?? ''}`);
    }

    await RC('clear probe');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
