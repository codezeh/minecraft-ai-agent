/**
 * 探针：为什么走不到算好的站位？
 *
 * 已验证（probe_stand_reach.mjs）：站位算得对，眼到方块 1.5~2.8 格，够得着。
 * 但 probe_collect_run.mjs 显示 step1 moveTo 报 "Took to long to decide path"。
 *
 * 本脚本：拿一个真实站位的坐标，直接调 moveTo，并打印详细过程：
 *   · 起点、目标、直线距离
 *   · pathfinder 的 movements 配置
 *   · 失败时的具体错误和已走距离
 *   · 换 GoalNearXZ（只给 x/z，让它自己找高度）对比
 *
 * 用法：node tools/probe_move_to_stand.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { installVinePhysics } from '../src/sim/vine_physics.js';
import { moveTo, moveToXZ, makeMovements } from '../src/agent/library/nav_pathfinder.js';
import { surveyTrees } from '../src/agent/library/collect_planner.js';
import { findStandSpot } from '../src/agent/library/query_stand.js';
import { blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'mt' + (Date.now() % 100000);

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25565, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
installVinePhysics(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);
    const cx = Math.floor(-233 / 16), cz = Math.floor(-284 / 16);
    await RC(`forceload add ${cx - 6} ${cz - 6} ${cx + 6} ${cz + 6}`);
    await sleep(800);
    await RC(`tp ${NAME} -233 67 -284`);
    await sleep(3000);
    console.log(`bot 在 ${bot.entity.position.floored()}`);

    // 取第一棵树的第一格，算出站位
    const plan = surveyTrees(bot, ['jungle_log'], { radius: 32, maxTrees: 3 });
    const tree = plan.trees[0];
    const cell = tree.order[0];
    const stand = findStandSpot(bot, cell);
    if (!stand.ok) { console.log('找不到站位:', stand.code); bot.quit(); process.exit(0); }
    const sp = stand.data.pos;
    console.log(`\n目标格 (${cell.x},${cell.y},${cell.z})`);
    console.log(`站位 (${sp.x},${sp.y},${sp.z})`);
    console.log(`站位脚下=${blockAt(bot, { x: sp.x, y: sp.y - 1, z: sp.z })?.name}，该格=${blockAt(bot, sp)?.name}`);

    const d0 = Math.hypot(bot.entity.position.x - (sp.x + 0.5), bot.entity.position.z - (sp.z + 0.5));
    console.log(`直线距离 ${d0.toFixed(1)} 格，高差 ${(sp.y - bot.entity.position.y).toFixed(0)} 格`);

    // 检查 pathfinder 对几个关键方块的判定
    const m = makeMovements(bot);
    console.log(`\nMovements: canDig=${m.canDig} maxDropDown=${m.maxDropDown} allowParkour=${m.allowParkour} allow1by1towers=${m.allow1by1towers}`);
    console.log(`  climbables 含 vine? ${m.climbables.has(bot.registry.blocksByName.vine.id)}`);
    console.log(`  emptyBlocks 含 vine? ${m.emptyBlocks.has(bot.registry.blocksByName.vine.id)}`);
    console.log(`  emptyBlocks 含 air? ${m.emptyBlocks.has(bot.registry.blocksByName.air.id)}`);
    console.log(`  vine 的 shapes 长度=${bot.registry.blocksByName.vine.shapes?.length}`);

    // A) 用 moveTo（带 y）
    console.log('\n=== A) moveTo（给 xyz）===');
    const r1 = await moveTo(bot, { kind: 'point', pos: sp }, { tol: 1, timeout: 20000 });
    console.log(`  code=${r1.code} msg=${String(r1.message ?? '').slice(0, 50)}`);
    console.log(`  data=${JSON.stringify(r1.data ?? {}).slice(0, 150)}`);

    // B) 用 moveToXZ（只给 xz）
    console.log('\n=== B) moveToXZ（只给 x/z）===');
    await RC(`tp ${NAME} -233 67 -284`);
    await sleep(2000);
    const r2 = await moveToXZ(bot, { kind: 'point', pos: { x: sp.x, y: sp.y, z: sp.z } }, { tol: 1, timeout: 20000 });
    console.log(`  code=${r2.code} msg=${String(r2.message ?? '').slice(0, 50)}`);
    console.log(`  现在位置 ${bot.entity.position.floored()}`);

    await RC('forceload remove all');
    bot.quit();
    process.exit(0);
});
