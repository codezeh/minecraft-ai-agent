// 丛林采集验收（放宽到 2 个、时限 240 秒，验证功能可用而非性能）。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { collect } from '../src/agent/library/flow_collect.js';
import { countItem } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 60)); process.exit(2); });

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    // 用 spectator 传送，避免 invalid_player_movement
    await RC('gamemode spectator probe');
    await RC('tp probe -192.5 67 -262.5');
    await sleep(1500);
    await RC('gamemode survival probe');
    await sleep(2000);

    const p = bot.entity.position.floored();
    console.log(`位置 ${p}（丛林）`);

    await RC('clear probe');
    await RC('give probe iron_axe 1');
    await sleep(800);

    const before = countItem(bot, 'oak_log') + countItem(bot, 'jungle_log');
    const t0 = Date.now();
    const r = await collect(bot, ['oak_log', 'jungle_log'], 2, { deadlineMs: 240000, label: '木头' });
    const dt = Date.now() - t0;
    const gained = countItem(bot, 'oak_log') + countItem(bot, 'jungle_log') - before;

    console.log(`结果: code=${r.code} 报数=${r.data?.count} 实际=${gained} 用时=${(dt / 1000).toFixed(0)}s`);
    if (r.message) console.log(`说明: ${r.message}`);

    const pass = gained >= 2;
    console.log(`\n${pass ? 'PASS' : 'FAIL'}：丛林采集 ${gained}/2`);

    await RC('clear probe');
    bot.quit();
    process.exit(pass ? 0 : 1);
});
