// 决定性验证：用官方 mineflayer-collectblock 的 findFromVein + collect 砍一整棵丛林树。
// 目的：证明「用现成方案」能不能一行行地解决问题，替换掉我自造的 678 行。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { rcon } from './rcon.mjs';
import { countItem } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const Vec3 = (await import('vec3')).Vec3;

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.loadPlugin(toolPlugin);
bot.loadPlugin(collectblock);
bot.on('error', (e) => { console.log('ERR', e.message); });
bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 60)));

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    await RC('gamemode spectator probe');
    await RC('tp probe -192.5 67 -262.5');
    await sleep(1500);
    await RC('gamemode survival probe');
    await sleep(2500);

    // 给把铁斧
    await RC('clear probe');
    await RC('give probe iron_axe 1');
    await sleep(1000);

    // 配置 movements：允许搭柱子（够高处用）、允许挖
    const moves = new pf.Movements(bot);
    moves.canDig = true;
    moves.allow1by1towers = true;     // ← 搭柱子上高处
    moves.allowParkour = true;
    moves.maxDropDown = 3;
    moves.dontMineUnderFallingBlock = false;
    bot.pathfinder.setMovements(moves);

    const p = bot.entity.position.floored();
    console.log(`位置 ${p}\n`);

    // 找最近的一棵丛林树
    const logId = bot.registry.blocksByName['jungle_log'].id;
    const logs = bot.findBlocks({ matching: logId, maxDistance: 32, count: 60 });
    if (!logs.length) { console.log('附近没有丛林树'); bot.quit(); process.exit(1); }

    // 挑 7 格那棵（之前确定最难砍的）
    const cols = new Map();
    for (const lp of logs) {
        const k = `${lp.x},${lp.z}`;
        if (!cols.has(k)) cols.set(k, []);
        cols.get(k).push(lp.y);
    }
    let tree = null;
    for (const [k, ys] of cols) { if (ys.length >= 5) { tree = { k, ys }; break; } }
    if (!tree) { const e = [...cols.entries()][0]; tree = { k: e[0], ys: e[1] }; }
    const [tx, tz] = tree.k.split(',').map(Number);
    const y0 = Math.min(...tree.ys);
    console.log(`目标树 (${tx},${tz}) y=${y0}..${Math.max(...tree.ys)}，${tree.ys.length} 格\n`);

    // ---- 关键：findFromVein 洪泛填充找出整棵树 ----
    const t0 = Date.now();
    const trunk = bot.blockAt(new Vec3(tx, y0, tz));
    if (!trunk) { console.log('树干读不到'); bot.quit(); process.exit(1); }

    const vein = bot.collectBlock.findFromVein(trunk, 200, 32, 1);
    const veinMs = Date.now() - t0;
    console.log(`findFromVein: 找到 ${vein.length} 格原木（含分枝），耗时 ${veinMs}ms`);
    console.log(`  坐标: ${vein.slice(0, 10).map(b => `(${b.position.x},${b.position.y},${b.position.z})`).join(' ')}`);

    // ---- 用官方 collect 一次性挖完整棵树 ----
    const before = countItem(bot, 'jungle_log');
    const t1 = Date.now();
    let err = '';
    try {
        await bot.collectBlock.collect(vein, { ignoreNoPath: true });
    } catch (e) {
        err = `[${e.name}] ${String(e.message).slice(0, 80)}`;
    }
    const ms = Date.now() - t1;
    const gained = countItem(bot, 'jungle_log') - before;

    // 检查还剩几格没挖
    let left = 0;
    for (const b of vein) {
        const cur = bot.blockAt(new Vec3(b.position.x, b.position.y, b.position.z));
        if (cur && cur.name === 'jungle_log') left++;
    }

    console.log(`\n结果: 挖到 ${gained} 个，还剩 ${left} 格，用时 ${(ms / 1000).toFixed(0)} 秒`);
    if (err) console.log(`  异常: ${err}`);

    const pass = left === 0 && gained > 0;
    console.log(`\n${pass ? 'PASS' : 'FAIL'}：官方插件${pass ? '成功' : '未能'}砍完整棵树`);

    bot.quit();
    process.exit(pass ? 0 : 1);
});
