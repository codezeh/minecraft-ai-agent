// 验证：官方插件 + 「从上往下」排序，能否稳定砍完整棵树。
// 上一轮失败原因已查明：Targets.getClosest() 纯按距离，先砍底部 → 上面悬空站不到。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { rcon } from './rcon.mjs';
import { countItem } from '../src/agent/library/atom_perceive.js';

const Vec3 = (await import('vec3')).Vec3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.loadPlugin(toolPlugin);
bot.loadPlugin(collectblock);
bot.on('error', (e) => { });
bot.on('kicked', () => console.log('KICKED'));

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    await RC('gamemode spectator probe');
    await RC('tp probe -192.5 67 -262.5');
    await sleep(1500);
    await RC('gamemode survival probe');
    await sleep(2500);
    await RC('clear probe');
    await RC('give probe iron_axe 1');
    await sleep(1000);

    const moves = new pf.Movements(bot);
    moves.canDig = true;
    moves.allow1by1towers = true;
    moves.allowParkour = true;
    moves.maxDropDown = 3;
    moves.dontMineUnderFallingBlock = false;
    bot.pathfinder.setMovements(moves);

    console.log(`位置 ${bot.entity.position.floored()}\n`);

    const results = [];
    // 测 3 棵树
    for (let round = 1; round <= 3; round++) {
        const logId = bot.registry.blocksByName['jungle_log'].id;
        const logs = bot.findBlocks({ matching: logId, maxDistance: 40, count: 80 });
        const cols = new Map();
        for (const lp of logs) {
            const k = `${lp.x},${lp.z}`;
            if (!cols.has(k)) cols.set(k, []);
            cols.get(k).push(lp.y);
        }
        // 挑一棵没砍过的
        let tree = null;
        for (const [k, ys] of cols) { if (ys.length >= 3) { tree = { k, ys }; break; } }
        if (!tree) { console.log(`第${round}轮: 附近没树了`); break; }

        const [tx, tz] = tree.k.split(',').map(Number);
        const y0 = Math.min(...tree.ys);
        const trunk = bot.blockAt(new Vec3(tx, y0, tz));
        if (!trunk) continue;

        const vein = bot.collectBlock.findFromVein(trunk, 40, 12, 1);

        // ★ 关键：按 y 从高到低排序 —— 先砍顶部，避免砍掉底部后上面悬空站不到
        const sorted = vein.slice().sort((a, b) => b.position.y - a.position.y);

        const before = countItem(bot, 'jungle_log');
        const t = Date.now();
        let err = '';
        try {
            await bot.collectBlock.collect(sorted, { ignoreNoPath: true });
        } catch (e) {
            err = e.name;
        }
        const ms = Date.now() - t;
        const gained = countItem(bot, 'jungle_log') - before;

        let left = 0;
        for (const b of vein) {
            const cur = bot.blockAt(new Vec3(b.position.x, b.position.y, b.position.z));
            if (cur && cur.name === 'jungle_log') left++;
        }

        const pass = left <= 1;   // 允许漏 1 格（可能是够不到的边角）
        results.push(pass);
        console.log(`第${round}轮 树(${tx},${tz}) ${vein.length}格: 挖到${gained} 剩${left} ${(ms / 1000).toFixed(0)}s ${pass ? 'PASS' : 'FAIL' + (err ? ' ' + err : '')}`);

        await sleep(1000);
    }

    const passCount = results.filter(Boolean).length;
    console.log(`\n合计 ${passCount}/${results.length} PASS（从上往下排序后）`);
    bot.quit();
    process.exit(passCount >= 2 ? 0 : 1);
});
