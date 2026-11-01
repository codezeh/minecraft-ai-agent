// 诊断：collect 的 162 秒花在哪？逐步计时。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { rcon } from './rcon.mjs';
import { collect } from '../src/agent/library/flow_collect.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'tim' + (Date.now() % 10000);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.loadPlugin(toolPlugin);
bot.loadPlugin(collectblock);
bot.on('error', () => { });
bot.on('kicked', () => console.log('KICKED'));

/** 统计每种事件的数量 */
const tally = {};
const timeline = [];
const t0 = Date.now();
const rec = (type, extra = '') => {
    tally[type] = (tally[type] || 0) + 1;
    const ms = Date.now() - t0;
    if (timeline.length < 200) timeline.push(`${String(ms).padStart(6)}ms ${type} ${extra}`);
};

bot.once('spawn', async () => {
    await sleep(3000);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await RC(`give ${NAME} dirt 64`);
    await sleep(1200);

    console.log(`起点 ${bot.entity.position.floored()}\n`);

    const WOOD = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];
    const r = await collect(bot, WOOD, 2, {
        deadlineMs: 100000,
        label: '木头',
        radius: 48,
        onEvent: (e) => rec(e.type, JSON.stringify(Object.fromEntries(
            Object.entries(e).filter(([k]) => k !== 'type').slice(0, 4)))),
    });

    console.log(`结果 ${r.code} 报数 ${r.data?.count}\n`);
    console.log('=== 事件统计 ===');
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(22)} ${v} 次`);
    }
    console.log('\n=== 时间线（前 40 条）===');
    timeline.slice(0, 40).forEach(t => console.log('  ' + t));

    bot.quit();
    process.exit(0);
});
