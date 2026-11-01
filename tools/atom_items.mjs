/**
 * atom_items 的独立验收（测试服 25566 超平坦）。
 *
 * 覆盖：换手持 / 换护甲 / 背包没有 NO_ITEM / 丢掉指定数量 / 丢超过持有量。
 * 用法：node tools/atom_items.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { equipItem, dropItem, findItem } from '../src/agent/library/act_items.js';
import { countItem } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'ai' + (Date.now() % 100000);

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

const waitItems = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120); }
    return false;
};

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    // 独立区域：测试之间不共享世界状态（否则修一个坏一个）
    await RC(`tp ${NAME} -200 -59 -500`);
    await RC(`clear ${NAME}`);
    await sleep(1000);
    try { bot.creative.stopFlying(); } catch { }
    await sleep(500);

    // 1) 空背包 → NO_ITEM
    const r0 = await equipItem(bot, 'iron_sword');
    check('空背包 NO_ITEM', r0.code === 'NO_ITEM', `code=${r0.code} msg=${r0.message}`);

    // 2) findItem 找不到返回 null
    check('findItem 找不到 = null', findItem(bot, 'iron_sword') === null);

    // 3) 给物品 → 换手持
    await RC(`give ${NAME} iron_sword 1`);
    await RC(`give ${NAME} dirt 16`);
    await waitItems(() => findItem(bot, 'iron_sword') != null);
    const r1 = await equipItem(bot, 'iron_sword');
    check('换手持 iron_sword', r1.ok && bot.heldItem?.name === 'iron_sword',
        `code=${r1.code} held=${bot.heldItem?.name}`);
    check('返回 item/count', r1.data?.equippedItem === 'iron_sword' && r1.data?.count === 1,
        `equippedItem=${r1.data?.equippedItem} count=${r1.data?.count}`);

    // 4) 换另一种手持（覆盖式切换）
    const r2 = await equipItem(bot, 'dirt');
    check('切到 dirt', r2.ok && bot.heldItem?.name === 'dirt', `held=${bot.heldItem?.name}`);

    // 5) 换护甲槽
    await RC(`give ${NAME} iron_helmet 1`);
    await waitItems(() => findItem(bot, 'iron_helmet') != null);
    const r3 = await equipItem(bot, 'iron_helmet', 'head');
    check('换护甲到 head', r3.ok, `code=${r3.code} ${r3.message}`);

    // 6) 丢掉指定数量
    const before = countItem(bot, 'dirt');
    const r4 = await dropItem(bot, 'dirt', 4);
    await sleep(600);
    const after = countItem(bot, 'dirt');
    check('丢掉 4 个 dirt', r4.ok && r4.data?.dropped === Math.min(4, before),
        `code=${r4.code} dropped=${r4.data?.dropped} before=${before} after=${after}`);
    check('dropped 数量与实际递减一致', before - after === r4.data?.dropped,
        `${before} - ${after} vs ${r4.data?.dropped}`);

    // 7) 丢超过持有量（应只丢实际拥有的）
    const has = countItem(bot, 'dirt');
    const r5 = await dropItem(bot, 'dirt', 999);
    await sleep(600);
    check('超量丢弃只丢实际拥有', r5.ok && r5.data?.dropped === Math.min(999, has),
        `has=${has} dropped=${r5.data?.dropped} left=${r5.data?.left}`);

    // 8) 丢没有的物品 → NO_ITEM
    const r6 = await dropItem(bot, 'diamond', 1);
    check('丢没有的物品 NO_ITEM', r6.code === 'NO_ITEM', `code=${r6.code}`);

    console.log(`\nitems 原子：${pass} PASS / ${fail_} FAIL`);
    try { await RC(`clear ${NAME}`); } catch { }
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
