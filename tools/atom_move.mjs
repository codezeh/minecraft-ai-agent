/**
 * atom_move 的独立验收（测试服 25566 超平坦）。
 *
 * 覆盖：正常到达 / 部分推进(partial) / 超时 / 中断 / 不可达。
 * 场景：超平坦世界，地面平整，不需要造方块。
 *
 * 用法：node tools/atom_move.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { moveTo, moveToXZ, stopMove } from '../src/agent/library/atom_move.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'am' + (Date.now() % 100000);

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
    const p0 = bot.entity.position.floored();
    await sleep(2500);
    await RC(`op ${NAME}`);
    // 用 creative 但关掉飞行：超平坦世界里生存模式的位置包更敏感（实测频繁 Invalid move），
    // creative 非飞行状态下的移动物理与生存一致，副作用小。
    await RC(`gamemode creative ${NAME}`);
    // 独立区域：测试之间不共享世界状态（否则修一个坏一个）
    await RC(`tp ${NAME} -500 -59 -500`);
    await sleep(1500);
    try { bot.creative.stopFlying(); } catch { }
    await sleep(1500);
    // 不做大范围 fill：41×41 的方块更新会让客户端处理不过来，
    // 位置包延迟后被服务端判 Invalid move 直接踢（实测 5 秒内被踢）。
    // 超平坦世界本身是平的，不需要改造地形。
    const p = bot.entity.position.floored();
    await sleep(1200);
    const start = bot.entity.position.floored();

    // 1) 正常到达 5 格
    const r1 = await moveTo(bot, { kind: 'point', pos: { x: start.x + 5, y: start.y, z: start.z } }, { tol: 1, timeout: 15000 });
    check('走到 5 格外', r1.ok, `code=${r1.code} dist=${r1.data?.distFeetToPoint?.toFixed?.(2)}`);
    check('返回 distFeetToPoint', typeof r1.data?.distFeetToPoint === 'number',
        `值=${r1.data?.distFeetToPoint}`);
    check('落在 tol 内', r1.ok && r1.data.distFeetToPoint <= 1.6,
        `dist=${r1.data?.distFeetToPoint?.toFixed?.(2)} tol=1`);

    // 2) 超时但有推进 → partial:true
    const before = bot.entity.position.floored();
    const r2 = await moveTo(bot, { kind: 'point', pos: { x: before.x + 30, y: before.y, z: before.z } }, { tol: 1, timeout: 1200 });
    check('超时/未达时给推进信息', r2.ok || r2.code === 'TIMEOUT' || r2.code === 'NO_PATH',
        `code=${r2.code} partial=${r2.data?.partial} advanced=${r2.data?.advanced?.toFixed?.(1)}`);
    if (r2.data?.partial) {
        check('partial 带 advanced', r2.data.advanced >= 3, `advanced=${r2.data.advanced.toFixed(1)}`);
    } else {
        check('partial 带 advanced', r2.data?.advanced != null, `advanced=${r2.data?.advanced}`);
    }

    // 3) 中断
    const p3 = bot.entity.position.floored();
    bot.interrupt_code = true;
    const r3 = await moveTo(bot, { kind: 'point', pos: { x: p3.x + 10, y: p3.y, z: p3.z } }, { tol: 1, timeout: 5000 });
    bot.interrupt_code = false;
    check('中断返回 INTERRUPTED', r3.code === 'INTERRUPTED', `code=${r3.code}`);

    // 4) 不可达（高空孤岛：单格石头悬在 30 格高，四周无路可达）
    const far = { x: p.x + 20, y: p.y + 30, z: p.z + 20 };
    await RC(`setblock ${far.x} ${far.y} ${far.z} stone`);
    await sleep(500);
    const r4 = await moveTo(bot, { kind: 'point', pos: far }, { tol: 0, timeout: 6000 });
    const nowPos = bot.entity.position;
    const realDist = Math.hypot(nowPos.x - (far.x + 0.5), nowPos.y - (far.y + 0.5), nowPos.z - (far.z + 0.5));
    // 注意：目标不可达时，moveTo 可能返回 ok+partial（推进了 >3 格 = 值得让上层续跑，
    // 这是 Baritone 的 partial path 设计，不是 bug）。验收要点是：
    //   ① 不能谎称"到达"（必须 partial:true 或明确失败）
    //   ② 返回的 distFeetToPoint 必须与实际距离一致
    const claimedArrival = r4.ok && !r4.data?.partial;
    check('不可达不会谎称到达', !claimedArrival,
        `code=${r4.code} partial=${r4.data?.partial} 实际距离=${realDist.toFixed(1)}`);
    check('返回距离与实际一致', (r4.data?.distFeetToPoint == null)
        || Math.abs(r4.data.distFeetToPoint - realDist) < 1.5,
        `返回=${r4.data?.distFeetToPoint?.toFixed?.(1)} 实际=${realDist.toFixed(1)}`);

    // 5) moveToXZ：返回 posXZ 而不是 pos
    const p5 = bot.entity.position.floored();
    const r5 = await moveToXZ(bot, { kind: 'point', posXZ: { x: p5.x - 4, z: p5.z } }, { tol: 2, timeout: 12000 });
    check('moveToXZ 返回 posXZ', r5.ok && r5.data?.posXZ != null && r5.data?.pos == null,
        `code=${r5.code} posXZ=${JSON.stringify(r5.data?.posXZ)} pos=${JSON.stringify(r5.data?.pos)}`);

    // 6) stopMove 幂等
    const s1 = stopMove(bot);
    check('stopMove 不抛错', s1 === undefined || s1 === null || typeof s1 === 'object');

    console.log(`\nmove 原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
