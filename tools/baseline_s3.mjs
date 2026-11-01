// S3 基线：测试服超平坦，铺 3×3 平台 × N 轮。
// 每轮重置一块平地，逐格核验 9 格。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { placePlatform, platformCells } from '../src/agent/library/flow_platform.js';
import { blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c);
const RUNS = Number(process.argv[2] || 10);
const ITEM = 'oak_planks';
const CENTER = { x: 0, y: -60, z: 0 };

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', JSON.stringify(r).slice(0, 120)); process.exit(2); });

function countPlaced() {
    return platformCells(CENTER).filter(p => blockAt(bot, p)?.name === ITEM).length;
}

bot.once('spawn', async () => {
    await sleep(2000);
    await RC('op probe');
    await RC('gamemode survival probe');

    let ok = 0, sumMs = 0;
    for (let i = 1; i <= RUNS; i++) {
        bot.interrupt_code = false;
        await RC('fill -6 -60 -6 6 -59 6 air');
        await RC('fill -6 -61 -6 6 -61 6 grass_block');
        await RC('tp probe 0.5 -60 0.5');
        await RC('clear probe');
        await RC('give probe oak_planks 64');
        await sleep(700);

        const t0 = Date.now();
        const r = await placePlatform(bot, ITEM, CENTER);
        const ms = Date.now() - t0;
        const n = countPlaced();
        const pass = r.ok && n === 9;
        if (pass) ok++;
        sumMs += ms;
        console.log(`        第${i}轮 ${pass ? 'PASS' : 'FAIL'} 实测=${n}/9 报数=${r.data?.placed} 用时=${(ms / 1000).toFixed(1)}s ${r.code}${r.message ? ' ' + r.message : ''}`);
    }

    const rate = ok / RUNS;
    console.log(`\nS3 基线 ${ok}/${RUNS} 通过（${(rate * 100).toFixed(0)}%），平均 ${(sumMs / RUNS / 1000).toFixed(1)}s/轮`);
    console.log(rate >= 0.8 ? '结论：达到方案 80% 及格线' : `结论：未达 80%（当前 ${(rate * 100).toFixed(0)}%）`);

    await RC('clear probe');
    bot.quit();
    process.exit(rate >= 0.8 ? 0 : 1);
});
