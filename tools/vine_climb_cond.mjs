/**
 * 探针：藤蔓攀爬的真实条件。
 *
 * 背景：用户指出「她之前为啥可以爬呢？」——她确实爬过（爬到树顶）。
 * 所以要搞清楚：**什么条件下能爬**，而不是断言"库不支持"。
 *
 * 依据（prismarine-physics/index.js:593）：
 *   if (isOnLadder(pos) && (entity.isCollidedHorizontally ||
 *       (climbUsingJump && entity.control.jump))) { vel.y = ladderClimbSpeed }
 *
 * 两组对照：
 *   A 纯悬空藤蔓柱（四周无支撑）
 *   B 藤蔓旁贴石头（模拟"藤蔓贴着树干/树叶" —— 丛林里的真实形态）
 *
 * 用法：node tools/vine_climb_cond.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { installVinePhysics } from '../src/sim/vine_physics.js';
import { blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'vcc' + (Date.now() % 100000);

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
const vp = installVinePhysics(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(1200);
    const p = bot.entity.position.floored();

    await RC(`fill ${p.x - 4} ${p.y} ${p.z - 6} ${p.x + 10} ${p.y + 12} ${p.z + 6} air`);
    await RC(`fill ${p.x - 4} ${p.y - 1} ${p.z - 6} ${p.x + 10} ${p.y - 1} ${p.z + 6} stone`);
    await sleep(1000);

    /** 造一根 7 格藤蔓柱（顶端挂石头当树冠），可选在旁边贴一列石头 */
    const build = async (vx, vz, withWall) => {
        await RC(`fill ${vx} ${p.y} ${vz} ${vx} ${p.y + 8} ${vz} air`);
        await RC(`fill ${vx + 1} ${p.y} ${vz} ${vx + 1} ${p.y + 8} ${vz} air`);
        await sleep(400);
        await RC(`setblock ${vx} ${p.y + 7} ${vz} stone`);
        for (let dy = 6; dy >= 0; dy--) {
            await RC(`setblock ${vx} ${p.y + dy} ${vz} vine[up=true]`);
        }
        if (withWall) await RC(`fill ${vx + 1} ${p.y} ${vz} ${vx + 1} ${p.y + 6} ${vz} stone`);
        await sleep(1800);
        const col = [];
        for (let dy = 7; dy >= 0; dy--) {
            const b = blockAt(bot, { x: vx, y: p.y + dy, z: vz });
            col.push(b?.name === 'vine' ? 'v' : b?.name === 'stone' ? 'S' : '.');
        }
        const side = blockAt(bot, { x: vx + 1, y: p.y + 3, z: vz })?.name;
        return { col: col.join(''), side };
    };

    /** 站到藤蔓格里，按住指定键，测升高 */
    const climbTest = async (label, vx, vz, { jump, forward, climbing }) => {
        await RC(`tp ${NAME} ${(vx + 0.5).toFixed(2)} ${p.y} ${(vz + 0.5).toFixed(2)}`);
        await sleep(1600);
        vp.setClimbing(climbing);
        await sleep(200);
        const y0 = bot.entity.position.y;
        if (forward) bot.setControlState('forward', true);
        if (jump) bot.setControlState('jump', true);
        let maxY = y0;
        const iv = setInterval(() => { const y = bot.entity.position.y; if (y > maxY) maxY = y; }, 60);
        await sleep(3000);
        clearInterval(iv);
        if (jump) bot.setControlState('jump', false);
        if (forward) bot.setControlState('forward', false);
        await sleep(300);
        const dy = maxY - y0;
        console.log(`    ${label}: 最高升 ${dy.toFixed(2)} 格 (climbing=${vp.isClimbing()})`);
        return dy;
    };

    await RC(`gamemode survival ${NAME}`);

    // ---- A 组：纯悬空 ----
    console.log('\n=== A 组：纯悬空藤蔓柱（四周无支撑）===');
    const vx1 = p.x + 2, vz1 = p.z - 3;
    const A = await build(vx1, vz1, false);
    console.log(`  藤蔓柱(上往下)=${A.col}  旁边=${A.side}`);
    const a1 = await climbTest('forward+jump', vx1, vz1, { jump: true, forward: true, climbing: true });
    const a2 = await climbTest('只 jump     ', vx1, vz1, { jump: true, forward: false, climbing: true });
    const a3 = await climbTest('只 forward  ', vx1, vz1, { jump: false, forward: true, climbing: true });
    const a4 = await climbTest('不爬(空气)  ', vx1, vz1, { jump: true, forward: true, climbing: false });

    // ---- B 组：旁边贴石头（丛林真实形态）----
    console.log('\n=== B 组：藤蔓旁贴石头（藤蔓贴着树干/树叶）===');
    const vx2 = p.x + 6, vz2 = p.z - 3;
    const B = await build(vx2, vz2, true);
    console.log(`  藤蔓柱(上往下)=${B.col}  旁边=${B.side}`);
    const b1 = await climbTest('forward+jump', vx2, vz2, { jump: true, forward: true, climbing: true });
    const b2 = await climbTest('只 forward  ', vx2, vz2, { jump: false, forward: true, climbing: true });
    const b3 = await climbTest('不爬(空气)  ', vx2, vz2, { jump: true, forward: true, climbing: false });

    console.log('\n=== 判读 ===');
    const maxA = Math.max(a1, a2, a3);
    const maxB = Math.max(b1, b2);
    console.log(`  A 悬空: 最高升 ${maxA.toFixed(2)} 格 ${maxA > 1.5 ? '→ 能爬' : '→ 爬不上去'}`);
    console.log(`  B 贴墙: 最高升 ${maxB.toFixed(2)} 格 ${maxB > 1.5 ? '→ 能爬' : '→ 爬不上去'}`);
    console.log(`  不爬模式: A=${a4.toFixed(2)} B=${b3.toFixed(2)}（应接近 0）`);
    if (maxB > 1.5 && maxA < 1.5) {
        console.log('  ★ 结论：贴墙藤蔓能爬、纯悬空爬不上去 —— 这就是她之前能爬到树顶的原因（丛林藤蔓都贴着东西）');
    } else if (maxA > 1.5 && maxB > 1.5) {
        console.log('  ★ 结论：两种都能爬 —— 攀爬能力正常，之前的问题只在"不该爬时爬了"');
    }

    bot.quit();
    process.exit(0);
});
