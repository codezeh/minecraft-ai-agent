/**
 * atom_container 的独立验收（测试服 25566 超平坦）。
 *
 * 覆盖：正常开箱 / 距离太远 / 不是容器 / 已有窗口开着 / 关窗幂等。
 * 场景自造：用 RCON 在 bot 旁边放箱子/木桶/熔炉。
 *
 * 用法：node tools/atom_container.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { openContainer, closeContainer, containerKindOf, windowItems } from '../src/agent/library/atom_container.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'ac' + (Date.now() % 100000);

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
bot.on('kicked', (r) => { console.log('KICKED', JSON.stringify(r).slice(0, 120)); });

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    // 独立区域：测试之间不共享世界状态
    await RC(`tp ${NAME} -100 -59 -500`);
    await sleep(500);

    const p = bot.entity.position.floored();
    const y = p.y;
    // 造场景：三个容器 + 一个非容器
    await RC(`setblock ${p.x + 2} ${y} ${p.z} chest`);
    await RC(`setblock ${p.x - 2} ${y} ${p.z} barrel`);
    await RC(`setblock ${p.x} ${y} ${p.z + 2} furnace`);
    await RC(`setblock ${p.x} ${y} ${p.z - 2} stone`);
    await sleep(1200);

    const pos = (dx, dy, dz) => ({ x: p.x + dx, y: y + dy, z: p.z + dz });

    // 1) 类型识别
    check('containerKindOf chest', containerKindOf(bot, 'chest') === 'chest');
    check('containerKindOf barrel', containerKindOf(bot, 'barrel') === 'barrel');
    check('containerKindOf furnace', containerKindOf(bot, 'furnace') === 'furnace');
    check('containerKindOf stone = null', containerKindOf(bot, 'stone') === null);

    // 2) 正常开箱
    const r1 = await openContainer(bot, { kind: 'block', pos: pos(2, 0, 0) });
    check('打开 chest', r1.ok && r1.data?.containerKind === 'chest',
        `code=${r1.code} kind=${r1.data?.containerKind} slots=${r1.data?.slots}`);
    // 槽位：window.slots 是「容器 + 背包36」，实测 chest=63。用一致性判据，不硬断言总数。
    check('容器槽位 = 27（一致）', r1.data?.slotConsistent === true,
        `总槽位=${r1.data?.slots} 容器部分=${r1.data?.containerSlots} 期望=${r1.data?.expectedSlots}`);
    check('windowItems 可读', Array.isArray(windowItems(bot)) || windowItems(bot) === null);

    // 3) 已有窗口开着 → BLOCKED
    const r2 = await openContainer(bot, { kind: 'block', pos: pos(-2, 0, 0) });
    check('已有窗口时 BLOCKED', r2.code === 'BLOCKED', `code=${r2.code}`);

    // 4) 关窗幂等
    const c1 = closeContainer(bot);
    check('关窗成功', c1.ok && c1.data?.closed === true);
    const c2 = closeContainer(bot);
    check('重复关窗幂等', c2.ok && c2.data?.closed === false);

    // 5) 不是容器 → NO_TARGET
    const r3 = await openContainer(bot, { kind: 'block', pos: pos(0, 0, -2) });
    check('非容器 NO_TARGET', r3.code === 'NO_TARGET', `code=${r3.code} msg=${r3.message}`);

    // 6) 距离太远 → OUT_OF_REACH
    const far = { x: p.x + 40, y, z: p.z };
    await RC(`setblock ${far.x} ${y} ${far.z} chest`);
    await sleep(600);
    const r4 = await openContainer(bot, { kind: 'block', pos: far });
    check('超距 OUT_OF_REACH', r4.code === 'OUT_OF_REACH', `code=${r4.code} dist=${r4.data?.dist?.toFixed?.(1)}`);

    // 7) 空位置 → NO_TARGET
    const r5 = await openContainer(bot, { kind: 'block', pos: { x: p.x + 5, y: y + 5, z: p.z + 5 } });
    check('空位置 NO_TARGET', r5.code === 'NO_TARGET', `code=${r5.code}`);

    console.log(`\n容器原子：${pass} PASS / ${fail_} FAIL`);
    try { closeContainer(bot); } catch { }
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
