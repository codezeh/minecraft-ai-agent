// 字段一致性验证：静态扫描 + 真服逐原子返回形状核对。
// 依赖：测试服 25566 / RCON 25576 已启动。
import fs from 'node:fs';
import path from 'node:path';
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { CODES, isResult } from '../src/agent/library/atom_contract.js';
import { blockAt, findBlocks, canReach, countItem, playerPos, reachDistanceTo } from '../src/agent/library/atom_perceive.js';
import { moveTo, lookAt } from '../src/agent/library/atom_move.js';
import { digBlock } from '../src/agent/library/atom_dig.js';
import { equipItem, dropItem } from '../src/agent/library/atom_items.js';
import { collect } from '../src/agent/library/task_collect.js';
import { follow, goToPlayer } from '../src/agent/library/task_follow.js';

const LIB = path.resolve('src/agent/library');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const rows = [];
function check(name, cond, detail = '') {
    rows.push({ name, ok: !!cond, detail });
    if (cond) passed++; else failed++;
}

// ---------- 1. 静态扫描 ----------
console.log('== 静态扫描 ==');
const atomFiles = fs.readdirSync(LIB).filter(f => /^(atom_|task_).*\.js$/.test(f));
const banned = [];
let actionFns = 0;

for (const f of atomFiles) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    const lines = src.split('\n');

    // 只审计「返回 ActionResult 的函数」= 函数体里出现 ok( 或 fail(。
    // 纯判断函数（isDiggable）、查询、内部辅助本来该返回布尔/原值，不在此列。
    const fnStarts = [];
    lines.forEach((line, i) => {
        if (/^(export\s+)?(async\s+)?function\s+\w+/.test(line)) fnStarts.push(i);
    });
    fnStarts.forEach((start, idx) => {
        const end = idx + 1 < fnStarts.length ? fnStarts[idx + 1] : lines.length;
        const body = lines.slice(start, end).join('\n');
        const isActionResultFn = /\b(ok|fail)\(/.test(body);
        if (!isActionResultFn) return;
        actionFns++;
        for (let i = start; i < end; i++) {
            const code = lines[i].replace(/\/\/.*$/, '');
            if (/return\s+(true|false)\s*;/.test(code)) {
                banned.push(`${f}:${i + 1} 裸布尔返回`);
            }
            if (f !== 'atom_contract.js' && /\{\s*ok\s*:/.test(code)) {
                banned.push(`${f}:${i + 1} 手写 {ok:...}`);
            }
        }
    });
}
check(`返回 ActionResult 的函数全部用 ok()/fail()（${actionFns} 个函数 / ${atomFiles.length} 个文件）`,
    banned.length === 0, banned.slice(0, 5).join(' | '));

// ---------- 2. 真服逐原子验证 ----------
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });

const RC = (c) => rcon(c);
const KEYS = ['code', 'data', 'message', 'ok'];

function expectResult(label, r, code) {
    if (!isResult(r)) { check(label, false, `不是 ActionResult: ${JSON.stringify(r)}`); return; }
    const keysOk = JSON.stringify(Object.keys(r).sort()) === JSON.stringify(KEYS);
    const codeOk = CODES.includes(r.code);
    const msgOk = r.ok || (typeof r.message === 'string' && r.message.length > 0);
    const jsonOk = JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r);
    const want = code ? r.code === code : true;
    check(label, keysOk && codeOk && msgOk && jsonOk && want,
        `code=${r.code}${code && r.code !== code ? `(期望 ${code})` : ''} keys=${keysOk} msg=${msgOk} json=${jsonOk}`);
}

async function reset() {
    bot.interrupt_code = false;
    await RC('fill -12 -60 -12 24 -58 12 air');
    await RC('tp probe 0.5 -60 0.5');
    await sleep(400);
}

bot.once('spawn', async () => {
    await sleep(1800);
    await RC('op probe');
    await RC('clear probe');
    await RC('gamemode survival probe');
    await sleep(300);

    console.log('\n== 失败路径 ==');
    await reset();

    // 够不着
    await RC('setblock 9 -60 0 minecraft:stone');
    await sleep(150);
    expectResult('digBlock 够不着 → OUT_OF_REACH', await digBlock(bot, { x: 9, y: -60, z: 0 }), 'OUT_OF_REACH');

    // 空气
    expectResult('digBlock 空气 → NO_TARGET', await digBlock(bot, { x: 2, y: -59, z: 2 }), 'NO_TARGET');

    // 基岩
    expectResult('digBlock 基岩 → NO_TARGET', await digBlock(bot, { x: 0, y: -64, z: 0 }), 'NO_TARGET');

    // 没这个物品
    expectResult('equipItem 没有 → NO_ITEM', await equipItem(bot, 'diamond_sword'), 'NO_ITEM');
    expectResult('dropItem 没有 → NO_ITEM', await dropItem(bot, 'diamond'), 'NO_ITEM');

    // 封闭盒
    await reset();
    await RC('fill -1 -60 -1 1 -60 1 stone');
    await RC('fill -1 -59 -1 1 -59 1 stone');
    await RC('setblock 0 -60 0 air'); await RC('setblock 0 -59 0 air');
    await RC('tp probe 0.5 -60 0.5');
    await sleep(400);
    expectResult('moveTo 封闭盒 → NO_PATH', await moveTo(bot, 8, -60, 0, { tol: 1, timeout: 6000 }), 'NO_PATH');

    // 找不到的目标
    expectResult('collect 不存在方块 → NO_TARGET', await collect(bot, 'not_a_block', 1), 'NO_TARGET');
    expectResult('follow 离线玩家 → NO_TARGET', await follow(bot, 'nobody_here'), 'NO_TARGET');
    expectResult('goToPlayer 离线玩家 → NO_TARGET', await goToPlayer(bot, 'nobody_here'), 'NO_TARGET');

    console.log('\n== 成功路径 ==');
    await reset();
    await RC('give probe iron_pickaxe 1');
    await sleep(400);
    await RC('setblock 2 -60 0 minecraft:stone');
    await sleep(150);
    expectResult('digBlock 成功', await digBlock(bot, { x: 2, y: -60, z: 0 }));

    expectResult('moveTo 成功', await moveTo(bot, 6, -60, 6, { tol: 1, timeout: 15000 }));
    expectResult('lookAt 成功', await lookAt(bot, { x: 6, y: -60, z: 6 }));

    await RC('give probe dirt 8');
    await sleep(500);
    expectResult('equipItem 成功', await equipItem(bot, 'dirt'));
    expectResult('dropItem 成功', await dropItem(bot, 'dirt', 2));

    // collect 成功：造一棵「像样的树」（树干 + 树冠），采 1 个
    // 注意：collect 现在会判「这是树还是房子」，裸原木会被跳过（那是对的）。
    await reset();
    for (let i = 0; i < 3; i++) await RC(`setblock ${3 + i} -60 2 minecraft:oak_log`);
    await RC('fill 1 -57 0 5 -56 4 minecraft:oak_leaves');   // 树冠在树干上方
    await sleep(300);
    const before = countItem(bot, 'oak_log');
    const r = await collect(bot, 'oak_log', 1, { deadlineMs: 60000 });
    expectResult('collect 成功', r);
    check('collect 背包确实 +1', countItem(bot, 'oak_log') === before + 1, `${before} → ${countItem(bot, 'oak_log')}`);

    console.log('\n== 查询返回类型 ==');
    const b = blockAt(bot, { x: 0, y: -61, z: 0 });
    check('blockAt → Block', !!b && typeof b.name === 'string', b?.name ?? 'null');
    const none = findBlocks(bot, 'not_a_block', 16, 4);
    check('findBlocks 未知方块 → []', Array.isArray(none) && none.length === 0, String(none.length));
    check('countItem → number', typeof countItem(bot, 'oak_log') === 'number');
    check('playerPos 离线 → null', playerPos(bot, 'nobody_here') === null);
    check('canReach 远处 → false', canReach(bot, { x: 30, y: -60, z: 30 }) === false,
        `dist=${reachDistanceTo(bot, { x: 30, y: -60, z: 30 }).toFixed(1)}`);

    await reset();
    await RC('clear probe');

    console.log('\n== 结果 ==');
    for (const row of rows) console.log(`  ${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? '  ' + row.detail : ''}`);
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
