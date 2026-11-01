// 验收：砍下来的原木必须真的进背包（报数 = 方块消失数）。
// 场景：一棵带树冠的树，砍 3 格，检查背包增量是否等于树干消失数。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { collect } from '../src/agent/library/flow_collect.js';
import { countItem, blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c);
const TREE = { x: 6, z: 0 };

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 100)); process.exit(2); });

async function buildTree() {
    bot.interrupt_code = false;
    await RC('fill -8 -60 -8 12 -58 12 air');
    await RC('fill -8 -61 -8 12 -61 12 grass_block');
    await RC('fill 4 -57 -2 8 -56 2 oak_leaves');   // 树冠在树干上方
    await RC(`fill ${TREE.x} -60 ${TREE.z} ${TREE.x} -58 ${TREE.z} oak_log`);
    await RC('tp probe 0.5 -60 0.5');
    await sleep(1200);
}

function trunkLeft() {
    let n = 0;
    for (let y = -60; y <= -58; y++) if (blockAt(bot, { x: TREE.x, y, z: TREE.z })?.name === 'oak_log') n++;
    return n;
}

bot.once('spawn', async () => {
    await sleep(1800);
    await RC('op probe');
    await RC('gamemode survival probe');

    let allGood = true;
    const rows = [];
    for (let round = 1; round <= 3; round++) {
        await buildTree();
        await RC('clear probe');
        await RC('give probe iron_axe 1');
        await sleep(600);

        const before = countItem(bot, 'oak_log');
        const r = await collect(bot, 'oak_log', 3, { deadlineMs: 90000 });
        const gained = countItem(bot, 'oak_log') - before;
        const removed = 3 - trunkLeft();          // 真正砍掉的格数
        const pass = gained === removed;          // 砍了几格就该捡到几个
        if (!pass) allGood = false;
        rows.push(`第${round}轮 砍掉=${removed} 捡到=${gained} 报数=${r.data?.count} code=${r.code}`);
        console.log(`        ${rows[rows.length - 1]}`);
    }

    check('三轮「砍掉几格就捡到几个」', allGood, rows.join(' | '));

    // 再验证幂等边界：树砍光后再要 1 个，应该如实说没有
    const r2 = await collect(bot, 'oak_log', 1, { deadlineMs: 30000 });
    check('树砍光后如实报没有', !r2.ok && r2.code === 'NO_TARGET', `code=${r2.code} msg=${r2.message}`);

    await RC('clear probe');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
