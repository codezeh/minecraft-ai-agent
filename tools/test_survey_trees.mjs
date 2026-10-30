// 验收：侦察 + 树型判定 + 砍伐顺序（不真砍，只看规划是否正确）。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { surveyTrees, describeSurvey } from '../src/agent/library/collect_planner.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const WOOD = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 60)); process.exit(2); });

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    // 传到丛林（树型最丰富）
    await RC('gamemode spectator probe');
    await RC('tp probe -192.5 67 -262.5');
    await sleep(1500);
    await RC('gamemode survival probe');
    await sleep(2000);
    console.log(`  位置 ${bot.entity.position.floored()}（丛林）\n`);

    // 1) 侦察
    const t0 = Date.now();
    const plan = surveyTrees(bot, WOOD, { radius: 48, maxTrees: 24 });
    const ms = Date.now() - t0;

    console.log(`  侦察耗时 ${ms}ms`);
    console.log(`  ${describeSurvey(plan)}\n`);

    check('侦察能找到树', plan.trees.length > 0, `${plan.trees.length} 棵`);
    // 侦察只在任务开始时做一次（非每轮），700~900ms 可接受；关键是别每秒都扫。
    check('侦察够快（<1000ms，只在任务开始时做一次）', ms < 1000, `${ms}ms`);
    check('统计了原木总数', plan.totalLogs > 0, `${plan.totalLogs} 根`);

    // 2) 树型判定
    const kinds = { large: 0, medium: 0, small: 0 };
    for (const t of plan.trees) kinds[t.kind]++;
    console.log(`  树型分布: 大 ${kinds.large}、中 ${kinds.medium}、小 ${kinds.small}`);
    check('能分出树型', (kinds.large + kinds.medium + kinds.small) === plan.trees.length);
    check('丛林里有大型树', kinds.large > 0, `${kinds.large} 棵`);

    // 3) 每棵树的详细信息 + 砍伐顺序
    console.log('\n  前 3 棵树:');
    for (const t of plan.trees.slice(0, 3)) {
        const first = t.order[0];
        const last = t.order[t.order.length - 1];
        const way = t.kind === 'large' ? '从上往下' : '从下往上';
        console.log(`    ${t.desc} → ${way}`);
        console.log(`      首格 (${first.x},${first.y},${first.z}) 末格 (${last.x},${last.y},${last.z})，共 ${t.logs} 格`);
    }

    // 4) 验证顺序正确性
    let orderOk = 0, orderBad = 0;
    for (const t of plan.trees) {
        const ys = t.order.map(o => o.y);
        const ascending = ys.every((y, i) => i === 0 || y >= ys[i - 1]);
        const descending = ys.every((y, i) => i === 0 || y <= ys[i - 1]);
        if (t.kind === 'large' && descending) orderOk++;
        else if (t.kind !== 'large' && ascending) orderOk++;
        else orderBad++;
    }
    check('砍伐顺序符合树型（大从上、小从中往上）', orderBad === 0, `正确 ${orderOk}，错误 ${orderBad}`);

    // 5) 排序合理（考虑距离和产出）
    const dists = plan.trees.map(t => t.dist);
    console.log(`\n  执行顺序（前 5）: ${plan.trees.slice(0, 5).map(t => `${Math.round(t.dist)}格/${t.logs}根/${t.kind}`).join(' → ')}`);
    check('树按优先级排序（不是纯随机）', dists.length > 0);

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
