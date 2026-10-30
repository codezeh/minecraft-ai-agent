/**
 * atom_drops 的独立验收（测试服 25566 超平坦）。
 *
 * 用真场景验证：挖掉方块产生真掉落物，然后回收。
 * 不用 `summon item` 硬造——那样验不出"服务端拾取是否真的进背包"。
 *
 * 用法：node tools/atom_drops.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { collectDrops } from '../src/agent/library/atom_drops.js';
import { digBlock } from '../src/agent/library/atom_dig.js';
import { countItem, blockAt } from '../src/agent/library/atom_perceive.js';
import Vec3 from 'vec3';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const BASE = 1100;
const NAME = 'ad' + (Date.now() % 100000);

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
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 120)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    // tp 后必须校验真的到了：实测偶发"tp 没生效"（bot 还在出生点），
    // 此时后续所有坐标都错，表现为莫名的 NO_TARGET。宁可重试，不要带着错位置继续。
    for (let attempt = 0; attempt < 3; attempt++) {
        await RC(`tp ${NAME} ${BASE} -60 ${BASE}`);
        await sleep(1500);
        const pos = bot.entity.position;
        if (Number.isFinite(pos.x) && Math.abs(pos.x - BASE) < 5) break;
        console.log(`  [警告] tp 未生效（现在 ${pos.x},${pos.z}），重试`);
    }
    const landedPos = bot.entity.position;
    console.log(`  [定位] 到达 ${landedPos.x.toFixed(0)},${landedPos.z.toFixed(0)}`);
    try { bot.creative.stopFlying(); } catch { }
    await sleep(800);

    const p = bot.entity.position.floored();
    const HOME = { x: p.x, y: p.y, z: p.z };   // 记住初始位置，给后面复位用
    // 清出一小块场地（范围小，避免大 fill 卡客户端）
    // 前置清理：顺序跑时前面的原子测试会留下掉落物/怪物，
    // 而"没掉落物 → TIMEOUT"用例假设附近是干净的（实测被污染过）。
    await RC(`kill @e[type=item]`);
    await RC(`kill @e[type=!player]`);
    await sleep(600);
    await RC(`fill ${p.x - 2} ${p.y} ${p.z - 2} ${p.x + 4} ${p.y + 3} ${p.z + 4} air`);
    await RC(`fill ${p.x - 2} ${p.y - 1} ${p.z - 2} ${p.x + 4} ${p.y - 1} ${p.z + 4} stone`);
    await sleep(1200);

    // 复位：上一步（超时用例）内部会跑 moveTo，把 bot 带离原位并留下寻路状态。
    // 实测不清理会导致后面"挖成功但没有掉落物"的怪现象。
    try { bot.pathfinder.stop(); } catch { }
    try { bot.clearControlStates(); } catch { }
    for (let i = 0; i < 3; i++) {
        await RC(`tp ${NAME} ${BASE} -60 ${BASE}`);
        await sleep(1200);
        if (Math.abs(bot.entity.position.x - BASE) < 5) break;
    }
    await sleep(600);

    // 2) 真挖一个方块，然后回收
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await sleep(1500);

    // 挖点基于**复位后的实际位置**（不要用最早记录的 p：
    // 中间那个超时用例会把 bot 带走，复位后位置才是真的）。
    const now = bot.entity.position.floored();
    const digPos = { x: now.x + 2, y: now.y, z: now.z };
    // 放方块并确认客户端真的读到了（setblock 后台同步有延迟）
    for (let i = 0; i < 4; i++) {
        await RC(`setblock ${digPos.x} ${digPos.y} ${digPos.z} oak_log`);
        await sleep(450);
        if (blockAt(bot, digPos)?.name === 'oak_log') break;
    }
    // 确认方块真的落地：setblock 后客户端可能还没收到更新，
    // 此时 digBlock 读到的是 air，会报 NO_TARGET / 或对空气挖到超时
    for (let i = 0; i < 6; i++) {
        if (blockAt(bot, digPos)?.name === 'oak_log') break;
        await sleep(300);
    }
    const placed = blockAt(bot, digPos)?.name;
    check('前置：oak_log 已就位', placed === 'oak_log', `实际=${placed}`);

    // 先确保斧头到手：digBlock 内部会 bestHarvestTool，但工具没进背包就白搭
    const axe = (bot.inventory?.items?.() ?? []).find(i => i.name === 'iron_axe');
    if (axe) { try { await bot.equip(axe, 'hand'); } catch { } }
    console.log(`  [准备] 手持=${bot.heldItem?.name ?? '空'}`);

    // 先复位到干净地面：上一个用例（超时那个）里的 collectDrops 会移动 bot，
    // 甚至把人留在半空（"往下找站位"是真实移动）。
    // 不复位的话，这里的 digBlock 会报 BLOCKED 悬空 —— 那是测试污染，不是原子缺陷。
    // 复位 + 在脚下补一块石头（不靠 tp 落地：实测 tp 后物理会把 y 顶起来 2 格）
    for (let attempt = 0; attempt < 3; attempt++) {
        await RC(`tp ${NAME} ${HOME.x} ${HOME.y} ${HOME.z}`);
        await sleep(1200);
        const q = bot.entity.position;
        if (Number.isFinite(q.x)) {
            await RC(`setblock ${Math.floor(q.x)} ${Math.floor(q.y) - 1} ${Math.floor(q.z)} stone`);
        }
        await sleep(900);
        for (let i = 0; i < 10 && bot.entity.onGround !== true; i++) await sleep(150);
        if (bot.entity.onGround === true) break;
    }
    const foot = bot.entity.position.floored();
    const belowBlock = blockAt(bot, { x: foot.x, y: foot.y - 1, z: foot.z });
    console.log(`  [落地检查] 脚位=${foot} 脚下=${belowBlock?.name} onGround=${bot.entity.onGround} 速度=${bot.entity.velocity?.y?.toFixed?.(2)}`);

    const before = countItem(bot, 'oak_log');
    console.log(`  [状态] 位置=${bot.entity.position.floored()} onGround=${bot.entity.onGround} 距离=${bot.entity.position.distanceTo(new Vec3(digPos.x+0.5, digPos.y+0.5, digPos.z+0.5)).toFixed(2)} 目标方块=${blockAt(bot,digPos)?.name}`);
    const dug = await digBlock(bot, { kind: 'block', pos: digPos });
    check('挖掉 oak_log', dug.ok, `code=${dug.code} ${dug.message}`);
    if (!dug.ok) { finish(); return; }

    const r1 = await collectDrops(bot, digPos, {
        countFn: () => countItem(bot, 'oak_log'),
        baseCount: before,
        deadlineMs: 8000,
    });
    const gained = countItem(bot, 'oak_log') - before;
    check('★ 回收成功', r1.ok, `code=${r1.code} msg=${r1.message}`);
    check('★ 背包真的 +1', gained >= 1, `gained=${gained}`);
    check('返回 gained 与实际一致', r1.data?.gained === gained,
        `返回=${r1.data?.gained} 实际=${gained}`);
    check('返回 waitedMs', typeof r1.data?.waitedMs === 'number', `waitedMs=${r1.data?.waitedMs}`);
    check('steps 记录完整', Array.isArray(r1.data?.steps) && r1.data.steps.length > 0,
        `steps=${r1.data?.steps?.map(s => s.step).join(',')}`);

    // 3) 中断
    bot.interrupt_code = true;
    const r2 = await collectDrops(bot, digPos, {
        countFn: () => countItem(bot, 'oak_log'), baseCount: 0,
    });
    bot.interrupt_code = false;
    check('中断 → INTERRUPTED', r2.code === 'INTERRUPTED', `code=${r2.code}`);

    // 4) 坐标无效
    check('无坐标 → NO_TARGET', (await collectDrops(bot, null, {})).code === 'NO_TARGET');
    check('NaN 坐标 → NO_TARGET',
        (await collectDrops(bot, { x: NaN, y: 0, z: 0 }, {})).code === 'NO_TARGET');

    // 5) countFn 抛错时不该把整个采集搞崩（应降级为超时/失败）
    const r3 = await collectDrops(bot, digPos, {
        countFn: () => { throw new Error('countFn boom'); },
        baseCount: 0,
        deadlineMs: 1200,
    });
    check('countFn 抛错不崩', r3.ok === false, `code=${r3.code}`);


    // ===== 放到最后：这个用例会移动 bot（collectDrops 会找站位），
    // 放在前面会污染后续用例的站位（实测会报"现在悬空"）。=====

    // 1) 没有掉落物时应该超时（不是报错）
    const before0 = countItem(bot, 'oak_log');
    const r0 = await collectDrops(bot, { x: p.x + 3, y: p.y, z: p.z + 3 }, {
        countFn: () => countItem(bot, 'oak_log'),
        baseCount: before0,
        deadlineMs: 2500,
    });
    check('没掉落物 → TIMEOUT', r0.code === 'TIMEOUT', `code=${r0.code}`);
    check('失败也返回 steps（可定位）', Array.isArray(r0.data?.steps) && r0.data.steps.length > 0,
        `steps=${r0.data?.steps?.map(s => s.step).join(',')}`);

    finish();

    function finish() {
        console.log(`\ndrops 原子：${pass} PASS / ${fail_} FAIL`);
        bot.quit();
        process.exit(fail_ === 0 ? 0 : 1);
    }
});
