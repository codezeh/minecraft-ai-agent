/**
 * 端到端探针：在真实丛林位置完整跑一次 planCollect + runSteps，逐步打印。
 *
 * 已知：
 *   · 识别正常（inspect 报 vines=1~4）
 *   · 规划正常（cleared=20，phases={clear:20,dig:7}）
 *   · 单独挖藤蔓正常（digBlock → OK，vine→air）
 * 所以要查：编排执行时哪一步挂了。
 *
 * 用法：node tools/probe_collect_run.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { installVinePhysics } from '../src/sim/vine_physics.js';
import { planCollect, makeHandlers } from '../src/agent/library/flow_collect_plan.js';
import { runSteps } from '../src/agent/library/step_runner.js';
import { countItem } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'cr' + (Date.now() % 100000);

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
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await sleep(1200);
    const axe = (bot.inventory?.items?.() ?? []).find(i => i.name === 'iron_axe');
    if (axe) { try { await bot.equip(axe, 'hand'); } catch { } }
    console.log(`bot 在 ${bot.entity.position.floored()}，手持=${bot.heldItem?.name ?? '空'}`);

    const plan = planCollect(bot, { blockNames: ['jungle_log'], want: 3, maxTargets: 2 });
    if (!plan.ok) { console.log('规划失败:', plan.code, plan.message); bot.quit(); process.exit(0); }

    console.log(`\n规划: steps=${plan.data.steps.length} cleared=${plan.data.cleared}`);
    console.log('前 10 步:');
    for (const s of plan.data.steps.slice(0, 10)) {
        const t = s.args.target?.pos ?? s.args.origin;
        console.log(`  ${s.step}. ${s.atom.padEnd(14)} ${String(s.phase).padEnd(7)} ${t ? `(${t.x},${t.y},${t.z})` : ''} group=${s.group}`);
    }

    const before = countItem(bot, 'jungle_log');
    const t0 = Date.now();
    const timeline = [];
    let stepCount = 0;

    const handlers = makeHandlers({ countFn: () => countItem(bot, 'jungle_log') });
    const run = await runSteps(bot, plan.data.steps, {
        handlers,
        deadlineMs: 90000,
        onStep: (e) => {
            stepCount++;
            const tag = e.type === 'step' ? `${e.step}:${e.atom}:${e.code}` :
                e.type === 'step-failed' ? `FAIL ${e.step}:${e.atom}:${e.code}` :
                    `${e.type}:${JSON.stringify(e).slice(0, 60)}`;
            timeline.push(tag);
            // 实时打印，方便看到卡在哪
            if (stepCount <= 40 || e.type !== 'step') console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag}`);
        },
    });

    const gained = countItem(bot, 'jungle_log') - before;
    console.log(`\n=== 执行结果 ===`);
    console.log(`code=${run.code} ok=${run.ok} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s doneSteps=${run.data?.doneSteps}`);
    console.log(`拿到 jungle_log: ${gained}`);
    console.log(`失败明细 ${run.data?.failed?.length ?? 0} 条:`);
    for (const f of (run.data?.failed ?? []).slice(0, 10)) {
        console.log(`  step${f.step} ${f.atom} ${f.code} ${String(f.message).slice(0, 50)}`);
    }

    await RC('forceload remove all');
    bot.quit();
    process.exit(0);
});
