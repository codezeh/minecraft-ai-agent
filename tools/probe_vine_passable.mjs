/**
 * 探针：藤蔓在 pathfinder 眼里是"空气"还是"障碍"？
 *
 * 背景（probe_collect_run.mjs 实测）：
 *   step1 moveTo INTERNAL "Took to long to decide path to goal!"
 *   step2-6 digBlock OUT_OF_REACH "够不着，眼睛到方块 6.9 格"
 *   —— 走位失败 → 站在原地挖 → 够不着。
 *
 * 怀疑：我把 vine 从 climbables 移除后，
 *   pathfinder 把藤蔓当成了**不可通行的障碍**（而不是可穿过的空气），
 *   于是路径规划失败（Took to long）。
 *
 * 验证：同一个目标点，三种 Movements 配置对比：
 *   A 默认（vine 在 climbables 里）
 *   B vine 移出 climbables（当前代码的做法）
 *   C vine 移出 climbables + 加入 emptyBlocks（当空气）
 *
 * 用法：node tools/probe_vine_passable.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { installVinePhysics } from '../src/sim/vine_physics.js';
import { makeMovements } from '../src/agent/library/atom_move.js';
import { findBlocks } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'vp3' + (Date.now() % 100000);

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25565, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
installVinePhysics(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);
    const cx = Math.floor(-233 / 16), cz = Math.floor(-284 / 16);
    await RC(`forceload add ${cx - 6} ${cz - 6} ${cx + 6} ${cz + 6}`);
    await sleep(800);
    await RC(`tp ${NAME} -233 67 -284`);
    await sleep(3000);
    const start = { x: -233, y: 67, z: -284 };

    // 目标：最近的树干旁 1 格（就是 collect 会去的地方）
    const logs = findBlocks(bot, 'jungle_log', 20, 40);
    logs.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    const T = logs[0].position;
    console.log(`目标树干 (${T.x},${T.y},${T.z})，起点 (${start.x},${start.y},${start.z})`);

    const vineDef = bot.registry.blocksByName.vine;

    const runCase = async (label, mutate) => {
        await RC(`tp ${NAME} ${start.x + 0.5} ${start.y} ${start.z + 0.5}`);
        await sleep(1800);
        const m = makeMovements(bot);      // 先拿当前项目的配置
        mutate(m);
        bot.pathfinder.setMovements(m);
        const t0 = Date.now();
        let code = 'OK', msg = '';
        try {
            await Promise.race([
                bot.pathfinder.goto(new pf.goals.GoalNear(T.x - 1, T.y, T.z, 1)),
                sleep(20000).then(() => { throw new Error('20s-timeout'); }),
            ]);
        } catch (e) {
            code = /timeout/i.test(e.message) ? 'TIMEOUT' : 'ERR';
            msg = String(e.message).slice(0, 42);
        }
        const ms = Date.now() - t0;
        const end = bot.entity.position;
        const d = Math.hypot(end.x - (T.x - 1), end.z - T.z);
        console.log(`  ${label}: ${code} ${(ms / 1000).toFixed(1)}s 距目标 ${d.toFixed(1)}格 ${msg}`);
        try { bot.pathfinder.stop(); } catch { }
        await sleep(600);
        return { code, ms, d };
    };

    console.log('\n=== 三种配置对比（同一目标） ===');
    // 当前代码的配置（vine 已被 makeMovements 移出 climbables）
    const A = await runCase('当前代码（vine 不当梯子）', () => { });

    // 恢复默认：vine 放回 climbables
    const B = await runCase('vine 放回 climbables ', (m) => {
        if (vineDef) m.climbables.add(vineDef.id);
    });

    // 移除 + 当空气
    const C = await runCase('vine 移出+当空气    ', (m) => {
        if (vineDef) {
            m.climbables.delete(vineDef.id);
            m.emptyBlocks.add(vineDef.id);
        }
    });

    console.log('\n=== 判读 ===');
    console.log(`  当前: ${A.code} 距 ${A.d.toFixed(1)}格`);
    console.log(`  放回: ${B.code} 距 ${B.d.toFixed(1)}格`);
    console.log(`  当空气: ${C.code} 距 ${C.d.toFixed(1)}格`);
    if (A.code !== 'OK' && B.code === 'OK') {
        console.log('  ★ 证实：把 vine 移出 climbables 导致 pathfinder 找不到路（Took to long）');
    }
    if (C.code === 'OK' && C.d < A.d) {
        console.log('  ★ 修复方向：vine 要从 climbables 移除，但必须同时加入 emptyBlocks（当空气）');
    }

    await RC('forceload remove all');
    bot.quit();
    process.exit(0);
});
