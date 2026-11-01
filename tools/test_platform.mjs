// B5 验收：3×3 平台（S3 的核心复合）。
// 10 轮：每轮清场 → 置中站好 → placePlatform → 逐格核对 9 格全对。
// 另测幂等（原样再跑一次不消耗材料）与材料账。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { placePlatform, platformCells } from '../src/agent/library/flow_platform.js';
import { blockAt } from '../src/agent/library/query_perceive.js';
import { countItem } from '../src/agent/library/query_perceive.js';
import { isResult, CODES } from '../src/agent/library/contract.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}
const RC = (c) => rcon(c);

const ITEM = 'oak_planks';
const CENTER = { x: 0, y: -60, z: 0 };

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });

async function reset() {
    bot.interrupt_code = false;
    await RC('fill -5 -60 -5 5 -59 5 air');
    await RC('fill -5 -61 -5 5 -61 5 grass_block');
    await RC('tp probe 0.5 -60 0.5');
    await sleep(800);
}

function countPlaced() {
    return platformCells(CENTER).filter(p => blockAt(bot, p)?.name === ITEM).length;
}

bot.once('spawn', async () => {
    await sleep(1800);
    await RC('op probe');
    await RC('clear probe');
    await RC('gamemode survival probe');
    await RC('give probe oak_planks 256');
    await RC('effect give probe minecraft:haste 600 4 true');
    await sleep(400);

    // ---- 10 轮
    let okRounds = 0, shapeBad = 0;
    const details = [];
    for (let i = 0; i < 10; i++) {
        await reset();
        const t0 = Date.now();
        const r = await placePlatform(bot, ITEM, CENTER);
        if (!isResult(r) || !CODES.includes(r.code)) shapeBad++;
        const n = countPlaced();
        const dt = Date.now() - t0;
        if (r.ok && n === 9) okRounds++;
        else details.push(`第${i + 1}轮 code=${r.code} msg=${r.message} 实际=${n}/9 failed=${JSON.stringify(r.data?.failed ?? [])}`);
        console.log(`        轮 ${i + 1}: ${n}/9 code=${r.code} ${dt}ms`);
    }
    check(`10 轮平台全对 ${okRounds}/10`, okRounds >= 7, `（S3 及格线 7/10）`);
    if (details.length) console.log('        失败明细:\n          ' + details.slice(0, 5).join('\n          '));
    check('10 轮返回形状全部合法', shapeBad === 0, `异常 ${shapeBad}`);

    // ---- 幂等：在同一块平台上原样再跑
    const before = countItem(bot, ITEM);
    const again = await placePlatform(bot, ITEM, CENTER);
    const after = countItem(bot, ITEM);
    check('幂等：已有平台再跑一次不扣材料', again.ok && countPlaced() === 9 && after === before,
        `ok=${again.ok} 材料 ${before}→${after} 实有=${countPlaced()}/9`);

    // ---- 材料不足：清空背包只给 2 个
    await reset();
    await RC('clear probe');
    await RC('give probe oak_planks 2');
    await sleep(400);
    const short = await placePlatform(bot, ITEM, CENTER);
    check('材料不足 → 如实报 NO_ITEM', short.code === 'NO_ITEM' && short.data?.placed < 9,
        `code=${short.code} placed=${short.data?.placed}`);

    // ---- 中断：跑一半置 interrupt
    await reset();
    await RC('clear probe');
    await RC('give probe oak_planks 64');
    await sleep(300);
    const p = placePlatform(bot, ITEM, CENTER);
    await sleep(1000);
    bot.interrupt_code = true;
    const interrupted = await p;
    bot.interrupt_code = false;
    check('中断 → INTERRUPTED 且如实报已放数量', interrupted.code === 'INTERRUPTED',
        `code=${interrupted.code} placed=${interrupted.data?.placed}`);

    await RC('clear probe');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
