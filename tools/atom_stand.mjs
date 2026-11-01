/**
 * atom_stand 的独立验收（测试服 25566 超平坦）。
 *
 * 覆盖：能站 / 脚下是空气 / 脚位被占 / 头位被占 / 树叶支撑（要标 ephemeral）/
 *       findStandSpot 找得到 / 找不到时 NO_SUPPORT。
 *
 * 用法：node tools/atom_stand.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { canStand, findStandSpot } from '../src/agent/library/query_stand.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const BASE = 200;
const NAME = 'as' + (Date.now() % 100000);

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

/** 造一小块干净场地：地面 stone，上方 4 格 air */
async function clearArea(x, z, r = 3) {
    await RC(`fill ${x - r} ${-60} ${z - r} ${x + r} ${-56} ${z + r} air`);
    await RC(`fill ${x - r} ${-61} ${z - r} ${x + r} ${-61} ${z + r} stone`);
    await sleep(600);
}

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await RC(`tp ${NAME} ${BASE} -59 ${BASE}`);
    await sleep(1500);
    try { bot.creative.stopFlying(); } catch { }
    await sleep(800);

    const p = bot.entity.position.floored();
    await clearArea(p.x + 4, p.z + 4);
    await sleep(500);

    // 场地基准：地面在 -61，站人高度 -60
    const ground = -61;
    const standY = -60;

    // 1) 正常能站
    const r1 = canStand(bot, { x: p.x + 4, y: standY, z: p.z + 4 });
    check('能站（脚下 stone）', r1.ok && r1.data?.standable === true, `why=${r1.data?.why}`);
    check('标出支撑 = stone', r1.data?.support === 'stone', `support=${r1.data?.support}`);
    check('stone 不是临时支撑', r1.data?.supportEphemeral === false);

    // 2) 脚下是空气 → 不能站
    const r2 = canStand(bot, { x: p.x + 4, y: ground + 5, z: p.z + 4 });
    check('脚下空气 → 不可站', r2.ok && r2.data?.standable === false, `why=${r2.data?.why}`);

    // 3) 脚位被占（石头）
    await RC(`setblock ${p.x + 5} ${standY} ${p.z + 4} stone`);
    await sleep(600);
    const r3 = canStand(bot, { x: p.x + 5, y: standY, z: p.z + 4 });
    check('脚位被占 → 不可站', r3.ok && r3.data?.standable === false, `why=${r3.data?.why}`);

    // 4) 头位被占
    await RC(`setblock ${p.x + 6} ${standY + 1} ${p.z + 4} stone`);
    await sleep(600);
    const r4 = canStand(bot, { x: p.x + 6, y: standY, z: p.z + 4 });
    check('头位被占 → 不可站', r4.ok && r4.data?.standable === false, `why=${r4.data?.why}`);

    // 5) ★ 树叶支撑：可站，但必须标 ephemeral（R3-08 的教训）
    await RC(`setblock ${p.x + 7} ${ground} ${p.z + 4} oak_leaves`);
    await sleep(600);
    const r5 = canStand(bot, { x: p.x + 7, y: standY, z: p.z + 4 });
    check('★ 树叶上能站（树叶不是禁区）', r5.ok && r5.data?.standable === true, `why=${r5.data?.why}`);
    check('★ 标出支撑会消失', r5.data?.supportEphemeral === true,
        `support=${r5.data?.support} ephemeral=${r5.data?.supportEphemeral}`);

    // 6) 草丛可以站（PASSABLE 包含）
    await RC(`setblock ${p.x + 4} ${standY} ${p.z + 5} short_grass`);
    await sleep(600);
    const r6 = canStand(bot, { x: p.x + 4, y: standY, z: p.z + 5 });
    check('草丛里能站', r6.ok && r6.data?.standable === true, `why=${r6.data?.why}`);

    // 7) 坐标无效
    check('坐标 NaN → INTERNAL', canStand(bot, { x: NaN, y: 1, z: 1 }).code === 'INTERNAL');
    check('null → INTERNAL', canStand(bot, null).code === 'INTERNAL');

    // 8) findStandSpot：目标在脚边，应该在附近找到站位
    const target = { x: p.x + 4, y: standY + 2, z: p.z + 4 };
    const r8 = findStandSpot(bot, target);
    check('findStandSpot 找得到', r8.ok, `code=${r8.code} pos=${JSON.stringify(r8.data?.pos)}`);
    check('返回 distEyeToBlock', typeof r8.data?.distEyeToBlock === 'number',
        `dist=${r8.data?.distEyeToBlock?.toFixed?.(2)}`);
    check('距离在可达范围内', (r8.data?.distEyeToBlock ?? 99) <= 5.1,
        `dist=${r8.data?.distEyeToBlock?.toFixed?.(2)}`);

    // 9) findStandSpot：目标悬在空中、周围没有任何支撑 → NO_SUPPORT
    const skyTarget = { x: p.x + 4, y: ground + 40, z: p.z + 4 };
    const r9 = findStandSpot(bot, skyTarget);
    check('空中孤立目标 → NO_SUPPORT', r9.code === 'NO_SUPPORT', `code=${r9.code}`);

    // 10) allowEphemeral=false 时不该选树叶站位
    //     目标旁边只有树叶可站（其他都堵住）
    const tight = { x: p.x + 12, y: ground + 1, z: p.z + 12 };
    await clearArea(p.x + 12, p.z + 12, 2);
    // 目标方块
    await RC(`setblock ${tight.x} ${tight.y} ${tight.z} stone`);
    // 四周下方放树叶（可站但是临时支撑）
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        await RC(`setblock ${tight.x + dx} ${ground} ${tight.z + dz} oak_leaves`);
    }
    await sleep(900);
    const r10a = findStandSpot(bot, tight, { allowEphemeral: true });
    check('允许树叶时能找到站位', r10a.ok, `code=${r10a.code}`);
    const r10b = findStandSpot(bot, tight, { allowEphemeral: false });
    check('禁止树叶时不选临时支撑',
        !r10b.ok || r10b.data?.supportEphemeral !== true,
        `code=${r10b.code} ephemeral=${r10b.data?.supportEphemeral}`);

    console.log(`\nstand 原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
