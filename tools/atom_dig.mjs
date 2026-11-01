/**
 * atom_dig 的独立验收（测试服 25566 超平坦）。
 *
 * 覆盖：正常挖 / 挖空气 / 挖基岩 / 超距 / 需要工具但没有 / 中断 / 后置校验。
 * 用法：node tools/atom_dig.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { digBlock, isDiggable } from '../src/agent/library/act_dig.js';
import { blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'ad' + (Date.now() % 100000);

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

/**
 * 放方块并确认真的生效。
 *
 * 顺序跑多个原子测试时踩过：setblock 命令返回成功，但客户端还没收到方块更新，
 * 于是 atom_dig 读到 air → 报 NO_TARGET，看起来像原子坏了，其实是测试没准备好。
 */
async function setAndConfirm(pos, blockName, tries = 5) {
    for (let i = 0; i < tries; i++) {
        await RC(`setblock ${pos.x} ${pos.y} ${pos.z} ${blockName}`);
        await sleep(400);
        if (blockAt(bot, pos)?.name === blockName) return true;
    }
    return false;
}

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    // 用 creative 非飞行（生存模式在超平坦上位置包敏感，会 Invalid move）
    await RC(`gamemode creative ${NAME}`);
    // 独立区域：测试之间不共享世界状态（否则修一个坏一个）
    await RC(`tp ${NAME} -400 -59 -500`);
    await sleep(1200);
    try { bot.creative.stopFlying(); } catch { }
    await sleep(800);

    const p = bot.entity.position.floored();
    const pos = (dx, dy, dz) => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });

    // 1) isDiggable 判据
    check('isDiggable(stone)', isDiggable({ name: 'stone', diggable: true }) === true);
    check('isDiggable(bedrock)', isDiggable({ name: 'bedrock', diggable: false }) === false);
    check('isDiggable(water)', isDiggable({ name: 'water', diggable: false }) === false);
    check('isDiggable(air)', isDiggable({ name: 'air', diggable: false }) === false);

    // 2) 正常挖石头（给一把镐：stone 的 harvestTools 只认 6 种镐，空手 canHarvest=false）
    await RC(`give ${NAME} iron_pickaxe 1`);
    await sleep(1000);
    const t1 = pos(2, 0, 0);
    await setAndConfirm(t1, 'stone');
    const r1 = await digBlock(bot, { kind: 'block', pos: t1 });
    const after1 = blockAt(bot, t1);
    check('挖 stone 成功', r1.ok, `code=${r1.code} ${r1.message}`);
    check('后置校验：变空气', after1?.name === 'air', `实际=${after1?.name}`);
    check('返回 dugBlock 字段', r1.data?.dugBlock === 'stone', `dugBlock=${r1.data?.dugBlock}`);
    check('返回 costMs', typeof r1.data?.costMs === 'number', `costMs=${r1.data?.costMs}`);

    // 3) 挖空气 → NO_TARGET
    const r2 = await digBlock(bot, { kind: 'block', pos: pos(5, 5, 5) });
    check('挖空气 NO_TARGET', r2.code === 'NO_TARGET', `code=${r2.code}`);

    // 4) 挖基岩 → NO_TARGET
    const t4 = pos(3, 0, 0);
    await setAndConfirm(t4, 'bedrock');
    const r4 = await digBlock(bot, { kind: 'block', pos: t4 });
    check('挖基岩 NO_TARGET', r4.code === 'NO_TARGET', `code=${r4.code} msg=${r4.message}`);

    // 5) 超距 → OUT_OF_REACH
    const far = pos(40, 0, 0);
    await setAndConfirm(far, 'stone');
    const r5 = await digBlock(bot, { kind: 'block', pos: far });
    check('超距 OUT_OF_REACH', r5.code === 'OUT_OF_REACH', `code=${r5.code} dist=${r5.data?.distEyeToBlock?.toFixed?.(1)}`);
    check('超距返回 distEyeToBlock', typeof r5.data?.distEyeToBlock === 'number',
        `值=${r5.data?.distEyeToBlock}`);

    // 6) 中断
    bot.interrupt_code = true;
    const r6 = await digBlock(bot, { kind: 'block', pos: pos(2, 0, 2) });
    bot.interrupt_code = false;
    check('中断 INTERRUPTED', r6.code === 'INTERRUPTED', `code=${r6.code}`);

    // 7) 需要工具（生存模式、空手挖石头）→ NO_TOOL
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await sleep(1000);
    const t7 = pos(2, 0, 3);
    // setblock 后必须确认落地：顺序跑时曾读到 air，导致用例变成 NO_TARGET 假失败
    await setAndConfirm(t7, 'stone');
    const r7 = await digBlock(bot, { kind: 'block', pos: t7 });
    check('空手挖石头 NO_TOOL', r7.code === 'NO_TOOL', `code=${r7.code} msg=${String(r7.message).slice(0, 30)}`);

    console.log(`\ndig 原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
