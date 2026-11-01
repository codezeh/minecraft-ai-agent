// 验收：reach 4.5→5.1 后，用真实 collect 砍丛林木，成功率是否提升。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { rcon } from './rcon.mjs';
import { collect } from '../src/agent/library/flow_collect.js';
import { countItem } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'col' + (Date.now() % 10000);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.loadPlugin(toolPlugin);
bot.loadPlugin(collectblock);
bot.on('error', (e) => console.log('ERR', e.message));
bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 60)));

bot.once('spawn', async () => {
    await sleep(3000);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await RC(`give ${NAME} dirt 64`);
    await sleep(1200);

    // 这片区域之前实测有丛林树（-192,-285 那棵 7 格）
    const p = bot.entity.position.floored();
    console.log(`起点 ${p}\n`);

    const WOOD = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];

    const rounds = [];
    for (let i = 1; i <= 3; i++) {
        const before = WOOD.reduce((s, n) => s + countItem(bot, n), 0);
        const t0 = Date.now();
        const r = await collect(bot, WOOD, 3, { deadlineMs: 150000, label: '木头', radius: 48 });
        const ms = Date.now() - t0;
        const gained = WOOD.reduce((s, n) => s + countItem(bot, n), 0) - before;
        const pass = r.ok && gained >= 3;
        rounds.push(pass);
        console.log(`第${i}轮: code=${r.code} 报数=${r.data?.count} 实际=${gained} ${(ms / 1000).toFixed(0)}s ${pass ? 'PASS' : 'FAIL'}`);
        if (!r.ok) console.log(`  ${r.message}`);
        await sleep(1000);
    }

    const pc = rounds.filter(Boolean).length;
    console.log(`\n合计 ${pc}/${rounds.length} PASS`);
    bot.quit();
    process.exit(pc >= 2 ? 0 : 1);
});
