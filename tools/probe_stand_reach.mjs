/**
 * 探针：planCollect 给每棵树算的站位，到底够不够得着？
 *
 * 背景（probe_collect_run.mjs 实测）：
 *   step1 moveTo INTERNAL "Took to long to decide path"
 *   step2-6 digBlock OUT_OF_REACH "够不着，眼睛到方块 6.9 格"
 *
 * 已知（probe_vine_passable.mjs）：三种藤蔓配置下 moveTo 都失败，
 *   说明不是藤蔓的问题，而是**目标站位本身不可达/够不着**。
 *
 * 本脚本检查：每棵树算出的 standPos，眼到方块距离是否 ≤5.1（够得着）。
 *
 * 用法：node tools/probe_stand_reach.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { installVinePhysics } from '../src/sim/vine_physics.js';
import { surveyTrees } from '../src/agent/library/collect_planner.js';
import { findStandSpot } from '../src/agent/library/query_stand.js';
import { blockAt } from '../src/agent/library/query_perceive.js';
import { EYE_HEIGHT } from '../src/agent/rules/rules.runtime.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'sr' + (Date.now() % 100000);

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
    const eye = bot.entity.eyeHeight ?? EYE_HEIGHT;
    console.log(`bot 在 ${bot.entity.position.floored()} 眼高=${eye}`);

    const plan = surveyTrees(bot, ['jungle_log'], { radius: 32, maxTrees: 6 });
    console.log(`\n侦察到 ${plan.trees.length} 棵树`);

    for (const tree of plan.trees.slice(0, 4)) {
        console.log(`\n=== 树 (${tree.x},${tree.y},${tree.z}) 共 ${tree.order.length} 格 ===`);
        for (const cell of tree.order.slice(0, 5)) {
            const stand = findStandSpot(bot, cell);
            if (!stand.ok) {
                console.log(`  格(${cell.x},${cell.y},${cell.z}) → 找不到站位: ${stand.code}`);
                continue;
            }
            const sp = stand.data.pos;
            // 眼到方块中心的距离
            const d = Math.hypot(
                (sp.x + 0.5) - (cell.x + 0.5),
                (sp.y + eye) - (cell.y + 0.5),
                (sp.z + 0.5) - (cell.z + 0.5),
            );
            const flag = d <= 5.1 ? 'OK' : '✗ 够不着';
            console.log(`  格(${cell.x},${cell.y},${cell.z}) → 站(${sp.x},${sp.y},${sp.z}) 眼到 ${d.toFixed(2)} 格 ${flag}`);
        }
        // 树本身的高度跨度
        const ys = tree.order.map(c => c.y);
        console.log(`  高度范围 y=${Math.min(...ys)}..${Math.max(...ys)}，跨度 ${Math.max(...ys) - Math.min(...ys)} 格`);
    }

    await RC('forceload remove all');
    bot.quit();
    process.exit(0);
});
