/**
 * atom_use 的独立验收（测试服 25566 超平坦）。
 *
 * 覆盖：门（开关）/ 活板门 / 工作站（走容器分支）/ 农作物（未熟 BLOCKED、成熟收获）/ 不认识的方块。
 * 场景自造：RCON 放方块。
 *
 * 用法：node tools/atom_use.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { useBlock, useKindOf } from '../src/agent/library/act_use.js';
import { closeContainer } from '../src/agent/library/act_container.js';
import { blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'au' + (Date.now() % 100000);

let pass = 0, fail_ = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
    else { fail_++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
// teleport 后坐标会变 NaN（mineflayer 物理引擎 bug），装上兜底
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 120)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    // 独立区域：测试之间不共享世界状态
    await RC(`tp ${NAME} 0 -59 -500`);
    await RC(`time set day`);
    await sleep(500);

    const p = bot.entity.position.floored();
    const y = p.y;
    const pos = (dx, dy, dz) => ({ x: p.x + dx, y: y + dy, z: p.z + dz });

    // 场景：门（下方方块 + 门）/ 工作台 / 成熟小麦 / 未熟小麦 / 石头
    await RC(`setblock ${p.x + 2} ${y - 1} ${p.z} stone`);
    await RC(`setblock ${p.x + 2} ${y} ${p.z} oak_door[half=lower,facing=north,hinge=left]`);
    await RC(`setblock ${p.x + 2} ${y + 1} ${p.z} oak_door[half=upper,facing=north,hinge=left]`);
    await RC(`setblock ${p.x - 2} ${y - 1} ${p.z} stone`);
    await RC(`setblock ${p.x - 2} ${y} ${p.z} crafting_table`);
    await RC(`setblock ${p.x} ${y - 1} ${p.z + 2} farmland[moisture=7]`);
    await RC(`setblock ${p.x} ${y} ${p.z + 2} wheat[age=7]`);
    await RC(`setblock ${p.x} ${y - 1} ${p.z - 2} farmland[moisture=7]`);
    await RC(`setblock ${p.x} ${y} ${p.z - 2} wheat[age=2]`);
    await RC(`setblock ${p.x + 4} ${y} ${p.z + 4} stone`);
    await sleep(1500);

    // 1) kind 识别
    check('kind oak_door = door', useKindOf(bot, 'oak_door') === 'door');
    check('kind oak_trapdoor = door', useKindOf(bot, 'oak_trapdoor') === 'door');
    check('kind red_bed = bed', useKindOf(bot, 'red_bed') === 'bed');
    check('kind wheat = crop', useKindOf(bot, 'wheat') === 'crop');
    check('kind crafting_table = workstation', useKindOf(bot, 'crafting_table') === 'workstation');
    check('kind stone = null', useKindOf(bot, 'stone') === null);

    // 2) 开门：open 属性应翻转
    const before = blockAt(bot, pos(2, 0, 0))?.getProperties?.().open;
    const r1 = await useBlock(bot, { kind: 'block', pos: pos(2, 0, 0) });
    const after = blockAt(bot, pos(2, 0, 0))?.getProperties?.().open;
    check('开门成功', r1.ok && before !== after,
        `code=${r1.code} before=${before} after=${after} state=${r1.data?.state}`);

    // 3) 再开一次 = 关上
    const r2 = await useBlock(bot, { kind: 'block', pos: pos(2, 0, 0) });
    const after2 = blockAt(bot, pos(2, 0, 0))?.getProperties?.().open;
    check('再交互变回关闭', r2.ok && after2 === before, `state=${r2.data?.state} after=${after2}`);

    // 4) 工作站（工作台）：走容器分支，开窗
    // 重新放置并确认：顺序跑时它可能被别的测试清掉
    const wt = pos(-2, 0, 0);
    await RC(`setblock ${wt.x} ${wt.y} ${wt.z} crafting_table`);
    await sleep(600);
    const r3 = await useBlock(bot, { kind: 'block', pos: wt });
    check('工作台打开窗口', r3.ok && r3.data?.containerKind === 'crafting_table',
        `code=${r3.code} containerKind=${r3.data?.containerKind} slots=${r3.data?.slots}`);
    closeContainer(bot);
    await sleep(300);

    // 5) 成熟小麦 → 收获成功
    const r4 = await useBlock(bot, { kind: 'block', pos: pos(0, 0, 2) });
    check('成熟小麦收获', r4.ok, `code=${r4.code} msg=${r4.message}`);

    // 6) 未熟小麦 → BLOCKED（不该白挖）
    const r5 = await useBlock(bot, { kind: 'block', pos: pos(0, 0, -2) });
    check('未熟作物 BLOCKED', r5.code === 'BLOCKED', `code=${r5.code} msg=${r5.message}`);

    // 7) 不认识的方块 → NO_TARGET（不猜）
    const r6 = await useBlock(bot, { kind: 'block', pos: pos(4, 0, 4) });
    check('石头 NO_TARGET', r6.code === 'NO_TARGET', `code=${r6.code} msg=${r6.message}`);

    // 8) 超距
    await RC(`setblock ${p.x + 40} ${y - 1} ${p.z} stone`);
    await RC(`setblock ${p.x + 40} ${y} ${p.z} oak_door[half=lower,facing=north,hinge=left]`);
    await sleep(800);
    const r7 = await useBlock(bot, { kind: 'block', pos: { x: p.x + 40, y, z: p.z } });
    check('超距 OUT_OF_REACH', r7.code === 'OUT_OF_REACH', `code=${r7.code}`);

    console.log(`\nuse 原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
