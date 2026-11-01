/**
 * atom_query 的独立验收（测试服 25566 超平坦）。
 *
 * 核心用例：**玩家在跟踪范围外时，RCON 仍能给出精确位置**。
 *   这是这个原子存在的理由——客户端协议在 48 格外就收不到实体了，
 *   但服务端一直知道。用真的第二个 bot 走到远处验证，不用假数据。
 *
 * 用法：node tools/atom_query.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { query, queryPlayerExact, ensureTracking } from '../src/agent/library/query_target.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const RCON_OPTS = { port: 25576 };          // 测试服 RCON
const BASE = -400;                          // 独立区域
const NAME = 'aq' + (Date.now() % 100000);
const OTHER = 'ao' + (Date.now() % 100000);

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
    await RC(`tp ${NAME} ${BASE} -59 ${BASE}`);
    await sleep(1500);
    try { bot.creative.stopFlying(); } catch { }
    await sleep(800);

    const p = bot.entity.position.floored();
    const tracker = ensureTracking(bot);

    // ---- 1) self ----
    const r1 = query(bot, { kind: 'self' });
    check('查询自己', r1.ok && r1.data?.kind === 'self', `code=${r1.code}`);
    check('self 距离 0 + 可见', r1.data?.distFeetToTarget === 0 && r1.data?.visibility === 'visible');
    check('self 坐标整数', Number.isInteger(r1.data?.pos?.x));

    // ---- 2) 方块：按坐标 ----
    const t2 = { x: p.x + 2, y: p.y - 1, z: p.z };
    await RC(`setblock ${t2.x} ${t2.y} ${t2.z} chest`);
    await sleep(700);
    const r2 = query(bot, { kind: 'block', pos: t2 });
    check('查询指定方块', r2.ok && r2.data?.name === 'chest', `code=${r2.code} name=${r2.data?.name}`);
    check('方块带 distEyeToBlock', typeof r2.data?.distEyeToBlock === 'number',
        `值=${r2.data?.distEyeToBlock?.toFixed?.(2)}`);

    // ---- 3) 方块：空气 / 不存在 ----
    const r3 = query(bot, { kind: 'block', pos: { x: p.x + 5, y: p.y + 5, z: p.z + 5 } });
    check('空气 NO_TARGET', r3.code === 'NO_TARGET', `msg=${r3.message}`);

    await RC(`setblock ${p.x - 2} ${p.y - 1} ${p.z} chest`);
    await sleep(700);
    const r4 = query(bot, { kind: 'block', name: 'chest', radius: 32 });
    check('按名字找最近方块', r4.ok && r4.data?.name === 'chest', `pos=${JSON.stringify(r4.data?.pos)}`);

    const r5 = query(bot, { kind: 'block', name: 'diamond_block', radius: 16 });
    check('附近没有 → NO_TARGET', r5.code === 'NO_TARGET');

    // ---- 4) 玩家不在线 ----
    const r6 = await queryPlayerExact(bot, { kind: 'player', name: 'nobody_xyz' }, { tracker, rconOpts: RCON_OPTS });
    check('不在线 → offline', r6.code === 'NO_TARGET' && r6.data?.visibility === 'offline',
        `code=${r6.code} visibility=${r6.data?.visibility}`);

    // ---- 5) 玩家在线且很近：RCON 来源 ----
    const other = mineflayer.createBot({
        host: '127.0.0.1', port: 25566, username: OTHER, auth: 'offline', version: '1.21.8',
    });
    other.loadPlugin(pf.pathfinder);
    other.on('error', () => { });
    await new Promise((res) => other.once('spawn', res));
    await sleep(2000);
    await RC(`tp ${OTHER} ${p.x + 3} ${p.y} ${p.z}`);
    await sleep(2500);

    const r7 = await queryPlayerExact(bot, { kind: 'player', name: OTHER }, { tracker, rconOpts: RCON_OPTS });
    check('近处玩家可查', r7.ok, `code=${r7.code} source=${r7.data?.source}`);
    check('数据来源是 RCON（权威）', r7.data?.source === 'rcon', `source=${r7.data?.source}`);
    check('带距离', typeof r7.data?.distFeetToEntity === 'number',
        `dist=${r7.data?.distFeetToEntity?.toFixed?.(1)}`);

    // ---- 6) ★核心用例：玩家走到 300 格外 ----
    const farX = p.x + 300;
    await RC(`tp ${OTHER} ${farX} -59 ${p.z}`);
    await sleep(3000);

    // 6a) 客户端确实看不到它了（验证前提成立，不是假设）
    const entGone = bot.players?.[OTHER]?.entity == null;
    check('前提：客户端实体已消失（跟踪范围外）', entGone,
        `players[${OTHER}].entity=${bot.players?.[OTHER]?.entity === null ? 'null' : 'still there'}`);

    // 6b) 但 RCON 仍能拿到精确位置
    const r8 = await queryPlayerExact(bot, { kind: 'player', name: OTHER }, { tracker, rconOpts: RCON_OPTS });
    check('★ 300 格外仍能精确查询', r8.ok && r8.data?.source === 'rcon',
        `code=${r8.code} source=${r8.data?.source} pos=${JSON.stringify(r8.data?.pos)}`);
    const gotX = r8.data?.entityPos?.x;
    check('★ 坐标与真实位置一致', Math.abs(gotX - (farX + 0.5)) < 3,
        `RCON=${gotX?.toFixed?.(1)} 期望≈${farX + 0.5}`);
    check('★ 距离算对（≈300）', Math.abs((r8.data?.distFeetToEntity ?? 0) - 300) < 5,
        `dist=${r8.data?.distFeetToEntity?.toFixed?.(1)}`);

    // ---- 7) 关掉 RCON 时应退回客户端（且如实说"看不到"或"记忆"）----
    const r9 = await queryPlayerExact(bot, { kind: 'player', name: OTHER },
        { tracker, useRcon: false });
    check('无 RCON 时退回客户端', r9.ok || r9.code === 'NO_TARGET',
        `code=${r9.code} visibility=${r9.data?.visibility ?? '-'} source=${r9.data?.source ?? '-'}`);
    check('退回时来源不是 rcon', r9.data?.source !== 'rcon', `source=${r9.data?.source}`);

    // ---- 8) 玩家下线 ----
    other.quit();
    await sleep(2500);
    const r10 = await queryPlayerExact(bot, { kind: 'player', name: OTHER }, { tracker, rconOpts: RCON_OPTS });
    check('下线后 offline', r10.code === 'NO_TARGET' && r10.data?.visibility === 'offline',
        `visibility=${r10.data?.visibility}`);

    // ---- 9) 无效目标 / 自己 NaN ----
    check('无效目标', query(bot, { foo: 1 }).code === 'NO_TARGET');
    check('null 目标', query(bot, null).code === 'NO_TARGET');

    const saved = bot.entity.position.clone();
    bot.entity.position.x = NaN;
    const r11 = query(bot, { kind: 'self' });
    bot.entity.position.x = saved.x;
    check('自己 NaN → INTERNAL', r11.code === 'INTERNAL', `code=${r11.code}`);

    console.log(`\nquery 原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
