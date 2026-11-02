/**
 * 验证「藤蔓按意图对待」：走路当空气，要爬当梯子。
 *
 * 用户判断（2026-10-25）：
 *   「藤蔓也可以爬呀，要爬的时候当梯子，不爬的时候当空气不就行了？」
 *
 * 四条判据：
 *   1) 走路（climbing=false）穿过藤蔓柱 → 不被抬升、能穿过去
 *   2) 显式爬（climbing=true）→ 能顺着藤蔓上升
 *   3) 业务侧读方块不受影响（bot.blockAt 仍读到 vine）
 *   4) 切换后立即生效（同一个 bot 内来回切）
 *
 * 用法：node tools/vine_physics_test.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { installVinePhysics } from '../src/sim/vine_physics.js';
import { blockAt } from '../src/agent/library/query_perceive.js';
import Vec3 from 'vec3';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'vp2' + (Date.now() % 100000);

let pass = 0, fail_ = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
    else { fail_++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
const vine = installVinePhysics(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

bot.once('spawn', async () => {
    await sleep(2500);

    // ★★ 2026-11-02 修（vine 偶发的真正根因）：
    //
    // `installVinePhysics(bot)` 在 **spawn 之前**调用，那时 `bot.registry` 可能还没
    // 加载方块表 → `vineIds.size === 0` → 返回 `installed:false` 的空壳，
    // **而且之后再也不重试**。表现就是"整轮偶发挂、单跑从不挂"
    // （单跑时服务器刚起、注册表反而更快就绪）。
    //
    // 上一版只做到"断言失败并说清是脚手架问题"——那只是**让失败可读**，
    // 并没有修掉偶发。现在改成 **spawn 后等注册表就绪再重装**：
    // 轮询到 `registry.blocksByName` 里有藤蔓，然后重新 install 一次。
    //
    // 为什么要轮询而不是再 sleep 一次：`sleep` 是猜时间，注册表什么时候到齐不确定；
    // 轮询的是**我们真正等的那个条件**（blocksByName 里有没有 vine）。
    let vineApi = vine;
    const vineNames = ['vine', 'cave_vines', 'cave_vines_plant', 'weeping_vines', 'twisting_vines'];
    for (let i = 0; i < 40 && vineApi.installed !== true; i++) {
        const reg = bot.registry?.blocksByName ?? {};
        const ready = vineNames.some((n) => reg[n]);
        if (ready) {
            // 注册表到齐了 → 重新装一次（旧的空壳会被替换掉）
            vineApi = installVinePhysics(bot);
            if (vineApi.installed === true) break;
        }
        await sleep(250);
    }

    if (vineApi.installed !== true) {
        console.log(`FAIL 脚手架：等了 10 秒藤蔓物理补丁仍没装上（installed=${vineApi.installed}）——`
            + `注册表始终没有 vine 类方块。这不是"爬不上去"的行为失败，是服务器/版本问题。`);
        process.exit(1);
    }
    vineApi.setClimbing(true);
    if (vineApi.isClimbing() !== true) {
        console.log('FAIL 脚手架：setClimbing(true) 之后 isClimbing() 仍为 false —— 补丁没真正接管。');
        process.exit(1);
    }
    vineApi.setClimbing(false);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(1200);
    const p = bot.entity.position.floored();

    // 场地 + 一根贴墙的藤蔓柱（模拟丛林：藤蔓贴树叶/树干垂下）
    await RC(`fill ${p.x - 5} ${p.y} ${p.z - 5} ${p.x + 10} ${p.y + 12} ${p.z + 5} air`);
    await RC(`fill ${p.x - 5} ${p.y - 1} ${p.z - 5} ${p.x + 10} ${p.y - 1} ${p.z + 5} stone`);
    await sleep(1000);
    const W = p.x + 3;                  // 石墙
    await RC(`fill ${W} ${p.y} ${p.z - 2} ${W} ${p.y + 6} ${p.z + 2} stone`);
    await sleep(700);
    // 藤蔓贴在墙的 -x 面（她走路会进入的格子），连成柱
    for (let dy = 0; dy <= 6; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
            await RC(`setblock ${W - 1} ${p.y + dy} ${p.z + dz} vine[east=true]`);
        }
    }
    await sleep(2500);

    const vineSeen = blockAt(bot, { x: W - 1, y: p.y + 1, z: p.z });
    check('前置：藤蔓已就位', vineSeen?.name === 'vine', `实际=${vineSeen?.name}`);

    // ---- 3) 业务侧读方块不受影响 ----
    check('★ 业务侧仍读到 vine（没被伪装污染）', vineSeen?.name === 'vine', `blockAt=${vineSeen?.name}`);

    /** 站到墙前，按 forward 一段时间，返回 (y 升高, x 前进) */
    const pushInto = async (label, climbing, seconds = 3.5) => {
        vineApi.setClimbing(climbing);
        await RC(`tp ${NAME} ${(p.x + 0.5).toFixed(2)} ${p.y} ${(p.z + 0.5).toFixed(2)}`);
        await sleep(1600);
        await bot.lookAt(new Vec3(W + 0.5, bot.entity.position.y + 1.6, p.z + 0.5));
        await sleep(300);
        const s0 = bot.entity.position.clone();
        let maxY = s0.y;
        const iv = setInterval(() => { const y = bot.entity.position.y; if (y > maxY) maxY = y; }, 80);
        bot.setControlState('forward', true);
        await sleep(seconds * 1000);
        bot.setControlState('forward', false);
        clearInterval(iv);
        await sleep(400);
        const s1 = bot.entity.position;
        const dy = maxY - s0.y;
        const dx = s1.x - s0.x;
        console.log(`  ${label}: 升高 ${dy.toFixed(2)} 格，前进 ${dx.toFixed(2)} 格`);
        return { dy, dx };
    };

    console.log('\n=== 1) 走路模式（climbing=false，藤蔓当空气）===');
    const walk = await pushInto('走路      ', false);
    check('★ 走路时不被抬升（升高 < 1 格）', walk.dy < 1.0, `升高=${walk.dy.toFixed(2)}`);
    check('走路时能前进（不被藤蔓卡死）', walk.dx > 0.5, `前进=${walk.dx.toFixed(2)}`);

    console.log('\n=== 2) 爬模式（climbing=true，藤蔓当梯子）===');
    const climb = await pushInto('爬藤蔓    ', true);
    check('★ 要爬时能升高（> 1.5 格）', climb.dy > 1.5, `升高=${climb.dy.toFixed(2)}`);

    console.log('\n=== 3) 再切回走路模式（验证可来回切）===');
    const walk2 = await pushInto('再切走路  ', false);
    check('★ 切回后不再抬升', walk2.dy < 1.0, `升高=${walk2.dy.toFixed(2)}`);

    console.log('\n=== 4) 梯子不受影响（梯子永远当梯子）===');
    // 造一架真梯子，验证它仍然能爬
    const LX = p.x - 2;
    await RC(`fill ${LX} ${p.y} ${p.z} ${LX} ${p.y + 5} ${p.z} ladder[facing=east]`);
    await sleep(800);
    vineApi.setClimbing(false);
    await RC(`tp ${NAME} ${(LX + 0.5).toFixed(2)} ${p.y} ${(p.z + 0.5).toFixed(2)}`);
    await sleep(1500);
    const s0 = bot.entity.position.clone();
    let maxY = s0.y;
    const iv = setInterval(() => { const y = bot.entity.position.y; if (y > maxY) maxY = y; }, 80);
    await bot.lookAt(new Vec3(LX + 0.5, s0.y + 3, p.z + 0.5));
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await sleep(2500);
    bot.setControlState('jump', false);
    bot.setControlState('forward', false);
    clearInterval(iv);
    await sleep(300);
    const dyLadder = maxY - s0.y;
    check('★ 梯子仍可爬（不受藤蔓规则影响）', dyLadder > 1.0, `升高=${dyLadder.toFixed(2)} 格`);

    console.log(`\n藤蔓物理：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
