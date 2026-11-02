/**
 * atom_place 的独立验收（测试服 25566 超平坦）。
 *
 * 覆盖：正常放置 / 幂等(existed) / 位置被占 OCCUPIED / 无材料 NO_ITEM / 无支撑 NO_SUPPORT / 超距。
 * 用法：node tools/atom_place.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { placeBlockAt } from '../src/agent/library/act_place.js';
import { blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'ap' + (Date.now() % 100000);

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
    // 独立区域：测试之间不共享世界状态（顺序跑时互相踩会"修一个坏一个"）
    await RC(`tp ${NAME} -300 -59 -500`);
    await sleep(1200);
    try { bot.creative.stopFlying(); } catch { }
    await sleep(800);

    const p = bot.entity.position.floored();
    // 独立区域、单轴偏移：+4,+4 的对角线实际是 5.7 格，会超出 4.3 格臂展。
    // 用 z+2 打底（避开 atom_dig 活动的 (2,0,0)），dx 继续沿 x 轴展开。
    const pos = (dx, dy, dz) => ({ x: p.x + dx, y: p.y + dy, z: p.z + 2 + dz });

    await RC(`give ${NAME} dirt 64`);
    await RC(`give ${NAME} oak_log 8`);
    await sleep(1200);

    // 清出作业区：tp 落点取决于地形高度，目标格可能是 grass_block（实测踩过：
    // 顺序跑时"放 dirt"直接报 OCCUPIED 那里已经是 grass_block）。
    // 范围要小（16×16）：大范围 fill 会让客户端处理不过来 → 位置包延迟 → 被踢。
    await RC(`fill ${p.x - 2} ${p.y} ${p.z} ${p.x + 6} ${p.y + 3} ${p.z + 6} air`);
    await RC(`fill ${p.x - 2} ${p.y - 1} ${p.z} ${p.x + 6} ${p.y - 1} ${p.z + 6} stone`);
    await sleep(1200);

    // 1) 正常放 dirt（放在自己旁边一格，有地面支撑）
    const t1 = pos(2, 0, 0);
    const r1 = await placeBlockAt(bot, { kind: 'block', pos: t1 }, 'dirt');
    check('放 dirt 成功', r1.ok, `code=${r1.code} ${r1.message}`);
    check('后置校验：真是 dirt', blockAt(bot, t1)?.name === 'dirt', `实际=${blockAt(bot, t1)?.name}`);
    check('返回 support', typeof r1.data?.support === 'string', `support=${r1.data?.support}`);
    check('返回 pos', !!r1.data?.pos, `pos=${JSON.stringify(r1.data?.pos)}`);

    // 2) 幂等：同一位置再放同种方块 → existed:true
    const r2 = await placeBlockAt(bot, { kind: 'block', pos: t1 }, 'dirt');
    check('重复放置 existed', r2.ok && r2.data?.existed === true, `code=${r2.code} existed=${r2.data?.existed}`);

    // 3) 位置被占（已放 dirt 的位置放 oak_log）→ OCCUPIED
    const r3 = await placeBlockAt(bot, { kind: 'block', pos: t1 }, 'oak_log');
    check('位置被占 OCCUPIED', r3.code === 'OCCUPIED', `code=${r3.code} msg=${String(r3.message).slice(0, 25)}`);

    // 4) 没有材料 → NO_ITEM
    // 先清空该位置：顺序跑时它可能已被前面的用例占用（会先报 OCCUPIED，
    // 那样测的就不是"没材料"这条分支了）
    const t4 = pos(3, 0, 0);
    await RC(`setblock ${t4.x} ${t4.y} ${t4.z} air`);
    await sleep(500);
    const r4 = await placeBlockAt(bot, { kind: 'block', pos: t4 }, 'diamond_block');
    check('没材料 NO_ITEM', r4.code === 'NO_ITEM', `code=${r4.code}`);

    // 5) 无支撑（悬空 30 格高的单格）→ NO_SUPPORT
    const t5 = pos(0, 30, 0);
    const r5 = await placeBlockAt(bot, { kind: 'block', pos: t5 }, 'dirt');
    check('无支撑 NO_SUPPORT', r5.code === 'NO_SUPPORT' || r5.code === 'OUT_OF_REACH',
        `code=${r5.code} msg=${String(r5.message).slice(0, 25)}`);

    // 6) 超距 → OUT_OF_REACH
    const t6 = pos(40, 0, 0);
    const r6 = await placeBlockAt(bot, { kind: 'block', pos: t6 }, 'dirt');
    check('超距 OUT_OF_REACH', r6.code === 'OUT_OF_REACH' || r6.code === 'NO_SUPPORT',
        `code=${r6.code} dist=${r6.data?.distEyeToBlock?.toFixed?.(1)}`);

    // 7) 不往自己脚下放 → OCCUPIED
    const feet = bot.entity.position.floored();
    const r7 = await placeBlockAt(bot, { kind: 'block', pos: { x: feet.x, y: feet.y, z: feet.z } }, 'dirt');
    // ★ 2026-11-03：原来断言 OCCUPIED，但那是**用错码** ——
    //   "我自己站在那儿"挖不掉（OCCUPIED 会让上层去 digBlock），必须换站位。
    //   已改为 BLOCKED + data.reason='own-body-column'（用户定的）。
    //   NO_SUPPORT 也仍然接受（不同几何下可能先撞支撑）。
    check('不往脚下放 → BLOCKED(own-body-column) 或 NO_SUPPORT',
        (r7.code === 'BLOCKED' && r7.data?.reason === 'own-body-column') || r7.code === 'NO_SUPPORT',
        `code=${r7.code} reason=${r7.data?.reason ?? '-'}`);

    console.log(`\nplace 原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
