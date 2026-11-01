/**
 * 探针：digBlock 挖藤蔓为什么失败。
 *
 * 已知（probe_vine_clear.mjs）：
 *   规划层正常 —— planCollect 产出 cleared=20、phases={clear:20, dig:7}
 *   所以问题在**执行层**：挖藤蔓这一步没成功。
 *
 * 本脚本在真实树干上找一个藤蔓，直接调 digBlock，打印完整结果。
 *
 * 用法：node tools/probe_dig_vine.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { installVinePhysics } from '../src/sim/vine_physics.js';
import { digBlock } from '../src/agent/library/act_dig.js';
import { canReach, reachDistanceTo, blockAt } from '../src/agent/library/query_perceive.js';
import { findBlocks } from '../src/agent/library/query_perceive.js';
import { requiresTool, canHarvestWith } from '../src/agent/rules/rules.runtime.js';
import Vec3 from 'vec3';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'dv' + (Date.now() % 100000);

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
    await RC(`give ${NAME} iron_axe 1`);
    await sleep(1000);
    console.log('bot 在', bot.entity.position.floored());

    // 找附近的藤蔓
    const vineDef = bot.registry.blocksByName.vine;
    const vines = bot.findBlocks({ matching: vineDef.id, maxDistance: 16, count: 40 });
    console.log(`16 格内藤蔓 ${vines.length} 处`);

    // 挑一个离树干最近的（验证"树干上的藤蔓"）
    const logs = findBlocks(bot, 'jungle_log', 16, 40);
    let target = null;
    for (const v of vines) {
        for (const l of logs) {
            const d = Math.hypot(v.x - l.position.x, v.z - l.position.z);
            if (d <= 1.5 && Math.abs(v.y - l.position.y) <= 3) {
                target = v; break;
            }
        }
        if (target) break;
    }
    if (!target) {
        console.log('没找到紧贴树干的藤蔓，改用最近的藤蔓');
        target = vines[0];
    }
    if (!target) { console.log('附近没藤蔓'); bot.quit(); process.exit(0); }

    const pos = { x: target.x, y: target.y, z: target.z };
    const b = blockAt(bot, pos);
    console.log(`\n目标藤蔓 (${pos.x},${pos.y},${pos.z}) name=${b?.name}`);
    console.log(`  方块属性: diggable=${b?.diggable} hardness=${b?.hardness} boundingBox=${b?.boundingBox}`);
    console.log(`  requiresTool=${requiresTool(b)} canHarvestWith=${canHarvestWith(b, bot.heldItem)}`);
    console.log(`  canReach=${canReach(bot, pos)} 眼到距离=${reachDistanceTo(bot, pos)?.toFixed(2)}`);
    console.log(`  手持: ${bot.heldItem?.name ?? '空'}`);

    const before = blockAt(bot, pos)?.name;
    const r = await digBlock(bot, { kind: 'block', pos });
    await sleep(800);
    const after = blockAt(bot, pos)?.name;
    console.log(`\n digBlock 结果: code=${r.code} ok=${r.ok}`);
    console.log(`   message: ${r.message ?? '(空)'}`);
    console.log(`   data: ${JSON.stringify(r.data ?? {}).slice(0, 200)}`);
    console.log(`   方块: ${before} → ${after}`);

    await RC('forceload remove all');
    bot.quit();
    process.exit(0);
});
