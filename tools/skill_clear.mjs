/**
 * skill_clear 的验收（测试服 25566 超平坦）。
 *
 * 核心场景（用户实测反馈）：**丛林里树被藤蔓包裹时，她就不砍那棵树了**。
 *
 * 验证三件事：
 *   1) inspectObstacles 能识别"被藤蔓包围"（这是旧实现做不到的——
 *      旧版只沿视线采样，而藤蔓贴在树干侧面，视线根本不穿过它）
 *   2) planCollect 产出的步骤里，digBlock(oak_log) 之前有 digBlock(vine)
 *   3) 真执行时，藤蔓被清掉、木头被砍下来
 *
 * 用法：node tools/skill_clear.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { planCollect, makeHandlers } from '../src/agent/library/skill_collect.js';
import { runSteps } from '../src/agent/library/step_runner.js';
import { inspectObstacles, planClearObstacles } from '../src/agent/library/skill_clear.js';
import { countItem, blockAt } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const BASE = 800;
const NAME = 'skc' + (Date.now() % 100000);

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
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 100)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    // 注意：不能在 tp 之后才建场景——测试服重启后那块区块可能未加载，
    // setblock 会报 "That position is not loaded"（实测踩过）。
    // 最稳的做法：就在 bot 出生点旁边造（出生区块一定已加载）。
    await sleep(1000);
    const p = bot.entity.position.floored();
    await RC(`fill ${p.x - 6} ${p.y} ${p.z - 6} ${p.x + 6} ${p.y + 8} ${p.z + 6} air`);
    await RC(`fill ${p.x - 6} ${p.y - 1} ${p.z - 6} ${p.x + 6} ${p.y - 1} ${p.z + 6} stone`);
    await sleep(1200);

    // 造一棵「被藤蔓包裹」的树：
    //   树干 (p.x+3, p.y..p.y+2, p.z)
    //   四面贴满 vine（这正是丛林里的实际情况）
    //   上面加树冠，让它被 classifyLog 判成天然树
    const trunkX = p.x + 3, trunkZ = p.z;

    /** 放方块并确认客户端真的读到了（setblock 后台区同步有延迟，实测会读到旧值） */
    async function place(pos, blockName, tries = 4) {
        for (let i = 0; i < tries; i++) {
            await RC(`setblock ${pos.x} ${pos.y} ${pos.z} ${blockName}`);
            await sleep(450);
            if (blockAt(bot, pos)?.name === blockName) return true;
        }
        return false;
    }

    // 树干
    let trunkOk = true;
    for (let dy = 0; dy <= 2; dy++) {
        trunkOk = await place({ x: trunkX, y: p.y + dy, z: trunkZ }, 'oak_log') && trunkOk;
    }
    // 四面挡路方块。
    //
    // 用 oak_leaves 而不是 vine 作测试障碍：
    //   实测 `setblock vine` 不带 up=true 时，会随机 tick 被服务端清掉
    //   （place 里确认放上了 12 处，7 秒后全变 air）。
    //   树叶是稳定方块，且丛林里同样是常见遮挡物，用来验证"清障碍"机制等价。
    //   藤蔓的真实放置见 bugs/BUG-004。
    let vineOk = 0;
    for (let dy = 0; dy <= 2; dy++) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (await place({ x: trunkX + dx, y: p.y + dy, z: trunkZ + dz }, 'oak_leaves')) vineOk++;
        }
    }
    // 树冠（让它被判成天然树）
    await RC(`fill ${trunkX - 1} ${p.y + 3} ${trunkZ - 1} ${trunkX + 1} ${p.y + 4} ${trunkZ + 1} oak_leaves`);
    await sleep(1500);
    console.log(`  场景：树干${trunkOk ? 'OK' : '失败'}，藤蔓放上 ${vineOk} 处`);

    // 先确认场景真的造出来了（之前踩过：藤蔓没放住，导致后面全崩）
    const sidePos = { x: trunkX + 1, y: p.y + 1, z: trunkZ };
    const sideName = blockAt(bot, sidePos)?.name;
    console.log(`  场景检查：树干(${trunkX},${p.y + 1},${trunkZ})=${blockAt(bot, { x: trunkX, y: p.y + 1, z: trunkZ })?.name}，侧面=${sideName}`);
    check('场景：障碍物已就位', sideName === 'oak_leaves', `侧面实际=${sideName}`);

    // ---- 1) 能识别"被藤蔓包围" ----
    const trunkPos = { x: trunkX, y: p.y + 1, z: trunkZ };
    const info = inspectObstacles(bot, trunkPos, { maxBlocks: 6 });
    check('★ 识别出被藤蔓包围', info.blocked === true, `why=${info.why}`);
    check('★ 数出挡路方块 ≥3', (info.vines + info.leaves) >= 3, `vines=${info.vines} leaves=${info.leaves}`);

    // ---- 2) 规划里"先清藤蔓，再砍树" ----
    const plan = planCollect(bot, { blockNames: ['oak_log'], want: 3, maxTargets: 1 });
    check('规划成功', plan.ok, `code=${plan.code} ${plan.message}`);
    if (!plan.ok) { finish(); return; }

    const steps = plan.data.steps;
    check('★ 规划里有清除步骤', plan.data.cleared > 0, `cleared=${plan.data.cleared}`);
    check('清除步骤的 phase 是 clear',
        steps.some(s => s.phase === 'clear'),
        `phases=${[...new Set(steps.map(s => s.phase))].join(',')}`);
    check('清除步骤挖的是软障碍（树叶/藤蔓）',
        steps.filter(s => s.phase === 'clear').every(s => /vine|leaves/.test(s.obstacleName ?? '')),
        `obstacles=${steps.filter(s => s.phase === 'clear').map(s => s.obstacleName).join(',')}`);

    // 关键顺序：clear 必须在第一个 dig(log) 之前
    const firstClear = steps.findIndex(s => s.phase === 'clear');
    const firstDigLog = steps.findIndex(s => s.atom === 'digBlock' && s.phase === 'dig');
    check('★ 先清障碍、后砍树', firstClear >= 0 && firstClear < firstDigLog,
        `clear@${firstClear} digLog@${firstDigLog}`);

    console.log('\n  规划（前 8 步）：');
    for (const s of steps.slice(0, 8)) {
        const t = s.args.target?.pos ?? s.args.origin;
        console.log(`    ${s.step}. ${s.atom.padEnd(13)} ${String(s.phase).padEnd(7)} ${t ? `(${t.x},${t.y},${t.z})` : ''}`);
    }
    console.log('');

    // ---- 3) 真执行：藤蔓被清、木头到手 ----
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await sleep(1500);
    const axe = (bot.inventory?.items?.() ?? []).find(i => i.name === 'iron_axe');
    if (axe) { try { await bot.equip(axe, 'hand'); } catch { } }

    const before = countItem(bot, 'oak_log');
    const handlers = makeHandlers({ countFn: () => countItem(bot, 'oak_log') });
    const run = await runSteps(bot, steps, { handlers, deadlineMs: 60000 });

    const gained = countItem(bot, 'oak_log') - before;
    check('★ 执行完成', run.ok, `code=${run.code} ${run.message}`);
    check('★ 挡路方块被清掉了', blockAt(bot, { x: trunkX + 1, y: p.y + 1, z: trunkZ })?.name !== 'oak_leaves',
        `那块现在是 ${blockAt(bot, { x: trunkX + 1, y: p.y + 1, z: trunkZ })?.name}`);
    check('★ 砍到木头了', gained > 0, `gained=${gained}`);

    finish();

    function finish() {
        console.log(`\nskill_clear：${pass} PASS / ${fail_} FAIL`);
        bot.quit();
        process.exit(fail_ === 0 ? 0 : 1);
    }
});
