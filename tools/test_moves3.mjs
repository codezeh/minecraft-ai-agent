// 验收：爬梯子 / 爬行 / 跨空隙（pathfinder 原生能力，确认在我们的配置下可用）。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { moveTo } from '../src/agent/library/nav_pathfinder.js';

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

async function flat(cx, cz, y) {
    await RC(`fill ${cx - 14} ${y} ${cz - 14} ${cx + 14} ${y + 12} ${cz + 14} air`);
    await RC(`fill ${cx - 14} ${y - 1} ${cz - 14} ${cx + 14} ${y - 1} ${cz + 14} stone`);
}

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    await RC('gamemode survival probe');
    const b = bot.entity.position.floored();
    console.log(`  起点 ${b}`);

    // ---- 1) 爬梯子：3 格高台 + 梯子
    await flat(b.x, b.z, b.y);
    const lx = b.x + 6;
    await RC(`fill ${lx} ${b.y} ${b.z} ${lx} ${b.y + 2} ${b.z} stone`);          // 台子
    await RC(`setblock ${lx - 1} ${b.y} ${b.z} ladder`);                          // 梯子
    await RC(`setblock ${lx - 1} ${b.y + 1} ${b.z} ladder`);
    await RC(`setblock ${lx - 1} ${b.y + 2} ${b.z} ladder`);
    await sleep(1000);
    await RC(`tp probe ${b.x + 0.5} ${b.y} ${b.z + 0.5}`);
    await sleep(1800);

    const t1 = await moveTo(bot, lx, b.y + 3, b.z, { tol: 1, timeout: 15000, canDig: false });
    const y1 = bot.entity.position.y;
    console.log(`  1) 爬梯子: ${t1.code} 现在 y=${y1.toFixed(1)}（目标 y=${b.y + 3}）`);
    check('能爬梯子上 3 格', y1 >= b.y + 2, `y=${y1.toFixed(1)}`);

    // ---- 2) 爬行：1 格高的通道
    await flat(b.x, b.z, b.y);
    const cx0 = b.x + 4;
    // 造一条 1 格高、8 格长的隧道（头顶封死）
    await RC(`fill ${cx0} ${b.y} ${b.z - 1} ${cx0 + 8} ${b.y} ${b.z + 1} air`);
    await RC(`fill ${cx0} ${b.y + 1} ${b.z - 1} ${cx0 + 8} ${b.y + 1} ${b.z + 1} stone`);
    await sleep(1200);
    await RC(`tp probe ${b.x + 0.5} ${b.y} ${b.z + 0.5}`);
    await sleep(1800);

    const t2 = await moveTo(bot, cx0 + 9, b.y, b.z, { tol: 1, timeout: 20000, canDig: false });
    const x2 = bot.entity.position.x;
    console.log(`  2) 爬行: ${t2.code} 现在 x=${x2.toFixed(1)}（隧道 ${cx0}..${cx0 + 8}，目标 ${cx0 + 9}）`);
    check('能穿过 1 格高通道', x2 > cx0 + 6, `x=${x2.toFixed(1)}`);

    // ---- 3) 跨空隙：3 格宽的坑
    await flat(b.x, b.z, b.y);
    const gx = b.x + 6;
    await RC(`fill ${gx} ${b.y - 6} ${b.z - 8} ${gx + 2} ${b.y - 1} ${b.z + 8} air`);   // 3 格坑
    await sleep(1200);
    await RC(`tp probe ${b.x + 0.5} ${b.y} ${b.z + 0.5}`);
    await sleep(1800);

    const t3 = await moveTo(bot, gx + 5, b.y, b.z, { tol: 1, timeout: 20000, canDig: false });
    const x3 = bot.entity.position.x;
    console.log(`  3) 跨空隙: ${t3.code} 现在 x=${x3.toFixed(1)}（坑 ${gx}..${gx + 2}，目标 ${gx + 5}）`);
    check('能跨过 3 格宽的坑', x3 > gx + 2, `x=${x3.toFixed(1)}`);

    await flat(b.x, b.z, b.y);
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
