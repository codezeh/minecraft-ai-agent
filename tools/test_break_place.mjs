// 验收：两档移动（先走、后挖/搭）。
// 场景 A：一堵 3 格高石墙挡路（只能挖或垫过去）
// 场景 B：一条 4 格宽的沟（只能垫过去）
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { moveToXZ, moveToXZEx } from '../src/agent/library/atom_move.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 100)); process.exit(2); });

const clean = async (x, z) => {
    await RC(`fill ${x - 12} ${50} ${z - 12} ${x + 12} ${90} ${z + 12} air`);
    await RC(`fill ${x - 12} ${49} ${z - 12} ${x + 12} ${49} ${z + 12} grass_block`);
};

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    await RC('gamemode survival probe');

    const b = bot.entity.position.floored();
    console.log(`  起点 ${b}`);

    // ---- 场景 A：3 格高石墙（无路可绕，必须挖/搭）
    await clean(b.x, b.z);
    const w = b.x + 8;
    await RC(`fill ${w} ${b.y} ${b.z - 20} ${w} ${b.y + 2} ${b.z + 20} stone`);       // 墙
    await RC(`fill ${w - 20} 50 ${b.z - 20} ${w - 20} 52 ${b.z + 20} stone`); // 后面再一堵，断退路
    await sleep(1200);
    await RC(`tp probe ${b.x + 0.5} ${b.y} ${b.z + 0.5}`);
    await sleep(2500);
    // 给她一把镐和一些泥土
    await RC('give probe diamond_pickaxe 1');
    await RC('give probe dirt 64');
    await sleep(800);

    const target = { x: w + 6, z: b.z };
    console.log(`\n  A: 3 格高石墙在 x=${w}，目标 x=${target.x}`);

    // A1：不破坏档（应失败）
    const t1 = Date.now();
    const r1 = await moveToXZ(bot, target.x, target.z, { tol: 2, timeout: 12000, canDig: false, scaffold: false });
    const d1 = Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
    console.log(`    不破坏档: ${r1.code} 距 ${d1.toFixed(0)} 格 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    check('A1 不破坏时过不去（墙挡住了）', d1 > 6, `距 ${d1.toFixed(0)} 格`);

    // A2：两档（第二档允许挖）
    const t2 = Date.now();
    const r2 = await moveToXZEx(bot, target.x, target.z, { tol: 2, timeout: 15000 });
    const d2 = Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
    console.log(`    两档: ${r2.code} tier=${r2.data?.tier} 距 ${d2.toFixed(0)} 格 ${((Date.now() - t2) / 1000).toFixed(1)}s`);
    check('A2 允许挖后能穿过墙', d2 < 6, `距 ${d2.toFixed(0)} 格 tier=${r2.data?.tier}`);

    // ---- 场景 B：4 格宽沟
    await clean(b.x, b.z);
    const gx = b.x + 10;
    await RC(`fill ${gx} ${b.y - 5} ${b.z - 20} ${gx + 3} ${b.y - 1} ${b.z + 20} air`);   // 挖沟
    await sleep(1200);
    await RC(`tp probe ${b.x + 0.5} ${b.y} ${b.z + 0.5}`);
    await sleep(1500);
    await RC('give probe dirt 64');
    await sleep(600);

    const tgtB = { x: gx + 8, z: b.z };
    console.log(`\n  B: 4 格沟在 x=${gx}..${gx + 3}，目标 x=${tgtB.x}`);
    const t3 = Date.now();
    const r3 = await moveToXZEx(bot, tgtB.x, tgtB.z, { tol: 2, timeout: 15000 });
    const d3 = Math.hypot(bot.entity.position.x - tgtB.x, bot.entity.position.z - tgtB.z);
    console.log(`    两档: ${r3.code} tier=${r3.data?.tier} 距 ${d3.toFixed(0)} 格 ${((Date.now() - t3) / 1000).toFixed(1)}s`);
    check('B 能跨过 4 格沟（垫过去）', d3 < 6, `距 ${d3.toFixed(0)} 格 tier=${r3.data?.tier}`);

    // 清理
    await clean(b.x, b.z);
    await RC('clear probe');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
