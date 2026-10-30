// 单点复现：为什么 (1,-60,1) 放置会 blockUpdate timeout
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { placeBlockAt } from '../src/agent/library/atom_place.js';
import { blockAt, reachDistanceTo } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', e => console.log('ERR', e.message));
const RC = (c) => rcon(c);

bot.once('spawn', async () => {
    await sleep(1800);
    await RC('op probe'); await RC('clear probe');
    await RC('gamemode survival probe');
    await RC('give probe dirt 64');
    await sleep(400);

    for (let run = 1; run <= 6; run++) {
        await RC('fill -4 -60 -4 6 -54 6 air');
        await RC('fill -4 -61 -4 6 -61 6 grass_block');
        await RC('tp probe 0.5 -60 0.5');
        await sleep(800);
        const below = blockAt(bot, { x: 1, y: -61, z: 1 })?.name;
        const dist = reachDistanceTo(bot, { x: 1, y: -60, z: 1 });
        const r = await placeBlockAt(bot, { x: 1, y: -60, z: 1 }, 'dirt');
        const now = blockAt(bot, { x: 1, y: -60, z: 1 })?.name;
        console.log(`run${run}: 下方=${below} 距离=${dist.toFixed(2)} → code=${r.code} msg=${r.message ?? ''} 实际=${now}`);
    }
    bot.quit(); process.exit(0);
});
