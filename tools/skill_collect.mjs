/**
 * skill_collect 的验收（测试服 25566 超平坦）。
 *
 * 重点验证「规划是只读的」：
 *   1) 连调两次 planCollect，步骤数一致
 *   2) 调用后世界没变（方块数、背包都没变）
 *   3) 产出的步骤能打印成人能读的样子
 *   4) runSteps 能报出「第几步/哪个原子/什么码」
 *
 * 用法：node tools/skill_collect.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { planCollect, makeHandlers } from '../src/agent/library/skill_collect.js';
import { runSteps } from '../src/agent/library/step_runner.js';
import { countItem, findBlocks } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const BASE = 2500;
const NAME = 'sc' + (Date.now() % 100000);

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

/** 造一片树林：间距 8 格，树干 3 格 + 树冠 */
async function plantForest(cx, cz, n = 8) {
    const spots = [];
    for (let i = 0; i < n; i++) {
        spots.push([(i % 4) * 8 - 12, Math.floor(i / 4) * 8 - 4]);
    }
    for (const [dx, dz] of spots) {
        await RC(`fill ${cx + dx - 1} ${-58} ${cz + dz - 1} ${cx + dx + 1} ${-57} ${cz + dz + 1} oak_leaves`);
        await RC(`fill ${cx + dx} ${-60} ${cz + dz} ${cx + dx} ${-58} ${cz + dz} oak_log`);
    }
    await sleep(1500);
    return spots;
}

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    for (let i = 0; i < 3; i++) {
        await RC(`tp ${NAME} ${BASE} -60 ${BASE}`);
        await sleep(1200);
        if (Math.abs(bot.entity.position.x - BASE) < 5) break;
    }
    try { bot.creative.stopFlying(); } catch { }
    await sleep(800);

    const p = bot.entity.position.floored();
    // 复位：前面的原子测试可能留下实体/岩浆/方块（顺序跑时踩过）
    await RC(`kill @e[type=!player]`);
    await sleep(500);
    await plantForest(p.x, p.z, 8);

    // ---- 1) 规划是只读的 ----
    const logsBefore = findBlocks(bot, 'oak_log', 48, 200).length;
    const invBefore = countItem(bot, 'oak_log');
    const posBefore = bot.entity.position.floored();

    const plan1 = planCollect(bot, { blockNames: ['oak_log'], want: 8 });
    check('规划成功', plan1.ok, `code=${plan1.code} ${plan1.message}`);
    if (!plan1.ok) { finish(); return; }

    const plan2 = planCollect(bot, { blockNames: ['oak_log'], want: 8 });
    check('★ 连调两次步骤数一致', plan1.data.steps.length === plan2.data.steps.length,
        `第一次=${plan1.data.steps.length} 第二次=${plan2.data.steps.length}`);

    const logsAfter = findBlocks(bot, 'oak_log', 48, 200).length;
    check('★ 规划后世界没变（原木数）', logsBefore === logsAfter, `${logsBefore} → ${logsAfter}`);
    check('★ 规划后背包没变', countItem(bot, 'oak_log') === invBefore);
    check('★ 规划后位置没变',
        bot.entity.position.floored().x === posBefore.x
        && bot.entity.position.floored().z === posBefore.z,
        `现在=${bot.entity.position.floored()}`);

    // ---- 2) 步骤结构合法 ----
    const steps = plan1.data.steps;
    // 2026-10-24 改动：从「每格走一次+捡一次」改成「一棵树走一次+挖多格+捡一次」。
    // 所以断言不再是"三步一组"，而是：
    //   第一个是 moveTo，之后若干 digBlock，最后一个 collectDrops
    //   且 collectDrops 的数量 = 树的棵数（远小于格子数）
    check('首步是 moveTo', steps[0]?.atom === 'moveTo', steps[0]?.atom);
    check('★ 每棵树只捡一次（不是每格捡）',
        steps.filter(s => s.atom === 'collectDrops').length < steps.filter(s => s.atom === 'digBlock').length,
        `捡 ${steps.filter(s => s.atom === 'collectDrops').length} 次 / 挖 ${steps.filter(s => s.atom === 'digBlock').length} 格`);
    const digCount = steps.filter(s => s.atom === 'digBlock').length;
    const moveCount = steps.filter(s => s.atom === 'moveTo').length;
    check('★ 走位次数少于挖掘次数（同树复用站位）', moveCount < digCount,
        `走 ${moveCount} 次 / 挖 ${digCount} 格`);
    check('每步都有 step 序号', steps.every((s, i) => s.step === i + 1));
    check('每步都有 onFail 表', steps.every(s => Array.isArray(s.onFail)));
    check('每步都有 phase', steps.every(s => typeof s.phase === 'string'));

    // ---- 3) 步骤能打印成人能读的 ----
    console.log('\n  规划结果（前 6 步）：');
    for (const s of steps.slice(0, 6)) {
        const tgt = s.args.target?.pos ?? s.args.origin;
        const t = tgt ? `(${tgt.x},${tgt.y},${tgt.z})` : '';
        console.log(`    ${s.step}. ${s.atom.padEnd(13)} ${s.phase.padEnd(7)} ${t}`);
    }
    console.log('');

    // ---- 4) 执行：真的砍到树 ----
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await sleep(1500);

    const before = countItem(bot, 'oak_log');
    const handlers = makeHandlers({
        countFn: () => countItem(bot, 'oak_log'),
        baseCount: before,
    });
    const stepLog = [];
    const run = await runSteps(bot, steps, {
        handlers,
        deadlineMs: 90000,
        onStep: (e) => { if (e.type === 'step') stepLog.push(`${e.step}:${e.atom}:${e.code}`); },
    });

    const gained = countItem(bot, 'oak_log') - before;
    check('★ 执行完成', run.ok, `code=${run.code} msg=${run.message}`);
    check('★ 真的拿到木头', gained > 0, `gained=${gained}`);
    check('返回 doneSteps', typeof run.data?.doneSteps === 'number', `doneSteps=${run.data?.doneSteps}`);
    check('返回 failed 明细', Array.isArray(run.data?.failed),
        `failed=${run.data?.failed?.length ?? 0} 条`);
    if (run.data?.failed?.length) {
        console.log('  失败明细（前 6 条）:');
        for (const f of run.data.failed.slice(0, 6)) {
            console.log(`    step${f.step} ${f.atom} ${f.code} ${String(f.message).slice(0, 40)}`);
        }
    }
    check('步骤日志可读', stepLog.length > 0, `前3条=${stepLog.slice(0, 3).join(' ')}`);

    // ---- 5) 失败能定位到步骤 ----
    // 造一个必失败的目标：挖一个空气位置
    const badSteps = [
        { step: 1, atom: 'digBlock', phase: 'dig', args: { target: { kind: 'block', pos: { x: p.x + 30, y: p.y + 30, z: p.z + 30 } } }, onFail: [{ code: '*', action: 'abort' }] },
    ];
    const badRun = await runSteps(bot, badSteps, { handlers });
    check('★ 失败报出 failedStep', badRun.data?.failedStep === 1, `failedStep=${badRun.data?.failedStep}`);
    check('★ 失败报出原子名', badRun.data?.atom === 'digBlock', `atom=${badRun.data?.atom}`);
    check('★ 失败报出错误码', typeof badRun.code === 'string', `code=${badRun.code}`);
    check('失败消息含步骤号', String(badRun.message).includes('第 1 步'), `msg=${badRun.message}`);

    // ---- 6) 中断 ----
    bot.interrupt_code = true;
    const intRun = await runSteps(bot, steps.slice(0, 3), { handlers });
    bot.interrupt_code = false;
    check('中断 → INTERRUPTED', intRun.code === 'INTERRUPTED', `code=${intRun.code}`);

    // ---- 7) 没有目标时的规划 ----
    const noTarget = planCollect(bot, { blockNames: ['diamond_block'], want: 1 });
    check('没目标 → NO_TARGET', noTarget.code === 'NO_TARGET', `code=${noTarget.code}`);

    finish();

    function finish() {
        console.log(`\nskill_collect：${pass} PASS / ${fail_} FAIL`);
        bot.quit();
        process.exit(fail_ === 0 ? 0 : 1);
    }
});
