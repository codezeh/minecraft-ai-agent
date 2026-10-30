/**
 * 探针：在真实丛林位置检查 planClearObstacles 到底识别出多少障碍。
 *
 * 用户反馈（2026-10-25）：「可以识别的树木却压根不会清障」。
 * 所以要查清：是"没识别到"还是"识别到了没执行"。
 *
 * 用法：node tools/probe_vine_clear.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { installVinePhysics } from '../src/sim/vine_physics.js';
import { planClearObstacles, inspectObstacles } from '../src/agent/library/skill_clear.js';
import { planCollect } from '../src/agent/library/skill_collect.js';
import { findBlocks } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'pc' + (Date.now() % 100000);

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
    const cx = Math.floor(-233 / 16), cz = Math.floor(-284 / 16);
    await RC(`forceload add ${cx - 6} ${cz - 6} ${cx + 6} ${cz + 6}`);
    await sleep(800);
    await RC(`tp ${NAME} -233 67 -284`);
    await sleep(3000);
    console.log('bot 在', bot.entity.position.floored());

    const logs = findBlocks(bot, 'jungle_log', 24, 40);
    console.log(`附近 jungle_log ${logs.length} 处`);
    logs.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

    for (const l of logs.slice(0, 3)) {
        const p = { x: l.position.x, y: l.position.y, z: l.position.z };
        const info = inspectObstacles(bot, p, { maxBlocks: 6 });
        const clr = planClearObstacles(bot, p, { maxClear: 3 });
        console.log(`\n树干 (${p.x},${p.y},${p.z})`);
        console.log(`  inspect: blocked=${info.blocked} vines=${info.vines} leaves=${info.leaves} why=${info.why}`);
        console.log(`  clearPlan: ok=${clr.ok} steps=${clr.steps.length}`);
    }

    const plan = planCollect(bot, { blockNames: ['jungle_log'], want: 3, maxTargets: 3 });
    console.log(`\n=== planCollect ===`);
    console.log(`ok=${plan.ok} code=${plan.code} steps=${plan.data?.steps?.length} cleared=${plan.data?.cleared} skipped=${plan.data?.skipped?.length}`);
    if (plan.data?.steps) {
        const phases = {};
        for (const s of plan.data.steps) phases[s.phase] = (phases[s.phase] ?? 0) + 1;
        console.log(`  各 phase:`, JSON.stringify(phases));
    }

    await RC('forceload remove all');
    bot.quit();
    process.exit(0);
});
