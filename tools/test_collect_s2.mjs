// S2 验收：砍 8 个橡木。
// 场景：8 根 3 格高橡木柱（模拟树干），每根间隔 3 格，bot 从中心出发。
// 判据（陪玩改造方案 §1 S2）：8 分钟内完成，报数 = 背包实际增量。
// 这里跑 5 轮，统计成功率；测试服平地上应接近全对。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { collect } from '../src/agent/library/flow_collect.js';
import { countItem } from '../src/agent/library/query_perceive.js';
import { isResult } from '../src/agent/library/contract.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}
const RC = (c) => rcon(c);

const WANT = 8;
const RUNS = 5;
const TRUNK = 3;          // 每根 3 格高
const SPOTS = [           // 8 根，围一圈，间隔 3 格
    [-6, -6], [-6, 0], [-6, 6],
    [0, -6], [0, 6],
    [6, -6], [6, 0], [6, 6],
];

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });

async function buildForest() {
    bot.interrupt_code = false;
    await RC('fill -12 -60 -12 12 -58 12 air');
    await RC('fill -12 -61 -12 12 -61 12 grass_block');
    for (const [x, z] of SPOTS) {
        // 3 格高的橡木柱；y=-60 是脚下层，树从 -60 往上
        await RC(`fill ${x} -60 ${z} ${x} ${-60 + TRUNK - 1} ${z} oak_log`);
    }
    await RC('tp probe 0.5 -59 0.5');   // 站在中间，脚下是柱子顶？不行，落到平地
    await RC('tp probe 0.5 -60 0.5');
    await sleep(900);
}

bot.once('spawn', async () => {
    await sleep(1800);
    await RC('op probe');
    await RC('gamemode survival probe');
    await RC('give probe iron_axe 1');
    await RC('give probe iron_pickaxe 1');
    await sleep(400);

    let okRuns = 0;
    const rows = [];
    for (let i = 0; i < RUNS; i++) {
        await RC('clear probe');
        await RC('give probe iron_axe 1');
        await buildForest();
        await sleep(400);

        const before = countItem(bot, 'oak_log');
        const t0 = Date.now();
        const r = await collect(bot, 'oak_log', WANT, { deadlineMs: 8 * 60 * 1000 });
        const dt = Date.now() - t0;
        const after = countItem(bot, 'oak_log');
        const gained = after - before;

        // 判据：ok 且报数 == 背包实际增量（防假成功）
        const honest = r.ok && r.data?.count === gained;
        if (honest && gained >= WANT) okRuns++;
        rows.push(`第${i + 1}轮 ok=${r.ok} code=${r.code} 报数=${r.data?.count} 实际=${gained} ${dt}ms ${r.message ?? ''}`);
        console.log(`        ${rows[rows.length - 1]}`);
        if (!isResult(r)) console.log('        返回形状异常');
    }

    check(`S2 砍 8 个橡木 ${okRuns}/${RUNS}`, okRuns >= Math.ceil(RUNS * 0.8), `（及格线 80%）`);

    await RC('clear probe');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
