// S2 基线：测试服超平坦，砍 8 个橡木 × N 轮。
// 方案要求「每阶段先跑 10 次基线」，这里给真实成功率。
// 场景自己造：8 棵树（树干 + 树冠），每轮重置。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { collect } from '../src/agent/library/task_collect.js';
import { countItem } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c);          // 测试服 25576
const RUNS = Number(process.argv[2] || 10);
const WANT = 8;

// 8 棵树的位置（间隔够开，互不遮挡）
const TREES = [
    [-6, -6], [0, -6], [6, -6],
    [-6, 6], [0, 6], [6, 6],
    [-6, 0], [6, 0],
];

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', JSON.stringify(r).slice(0, 120)); process.exit(2); });

async function buildForest() {
    bot.interrupt_code = false;
    await RC('fill -12 -60 -12 12 -57 12 air');
    await RC('fill -12 -61 -12 12 -61 12 grass_block');
    for (const [x, z] of TREES) {
        // 先树冠（上方两层），后树干 —— 顺序反了会把树干覆盖掉
        await RC(`fill ${x - 1} -57 ${z - 1} ${x + 1} -56 ${z + 1} oak_leaves`);
        await RC(`fill ${x} -60 ${z} ${x} -58 ${z} oak_log`);
    }
    await RC('tp probe 0.5 -60 0.5');
    await sleep(1000);
}

bot.once('spawn', async () => {
    await sleep(2000);
    await RC('op probe');
    await RC('gamemode survival probe');

    const rows = [];
    let ok = 0, sumMs = 0, sumGot = 0;
    for (let i = 1; i <= RUNS; i++) {
        await buildForest();
        await RC('clear probe');
        await RC('give probe iron_axe 1');
        await sleep(600);

        const before = countItem(bot, 'oak_log');
        const t0 = Date.now();
        const r = await collect(bot, 'oak_log', WANT, { deadlineMs: 8 * 60 * 1000 });
        const ms = Date.now() - t0;
        const gained = countItem(bot, 'oak_log') - before;
        const pass = r.ok && gained >= WANT && r.data?.count === gained;
        if (pass) ok++;
        sumMs += ms; sumGot += gained;
        rows.push(`第${i}轮 ${pass ? 'PASS' : 'FAIL'} 拿到=${gained}/${WANT} 报数=${r.data?.count} 用时=${(ms / 1000).toFixed(0)}s`);
        console.log(`        ${rows[rows.length - 1]} ${r.code}${r.message ? ' ' + r.message : ''}`);
    }

    const rate = ok / RUNS;
    console.log(`\nS2 基线 ${ok}/${RUNS} 通过（${(rate * 100).toFixed(0)}%），平均 ${(sumMs / RUNS / 1000).toFixed(0)}s/轮，平均拿到 ${(sumGot / RUNS).toFixed(1)}/${WANT}`);
    console.log(rate >= 0.8 ? '结论：达到方案 80% 及格线' : `结论：未达 80%（当前 ${(rate * 100).toFixed(0)}%）`);

    await RC('clear probe');
    bot.quit();
    process.exit(rate >= 0.8 ? 0 : 1);
});
