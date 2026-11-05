/**
 * 第33条（R1 终审 §9 第 4 项）的回归测试 —— 「`goToGoal` 到底能不能被 !stop 停下来」。
 *
 * 为什么必须有这条：修是修好了（`skills.js:_goToGoalBody` 的第三支 `setInterval` 每 200ms
 * 查一次 `bot.interrupt_code`），但**零测试** —— 终审原话「这条一旦回退没人看得见」。
 * 而且这类缺陷的伪装性极强：180s 硬超时**看起来**像兜底，实际是"按了 !stop 还要走 3 分钟"，
 * 所以只断言"最终返回了"没用，必须断言**多快返回**、以及**是谁叫停的**。
 *
 * 判据设计（每条都能对"改前代码"变红）：
 *   ① 中断：置 `interrupt_code` → `goToGoal` 抛 code=INTERRUPTED，且 <1s 内返回；
 *   ② 不是靠超时兜底：耗时 << 180s，且错误信息里没有 "hard limit" 字样；
 *   ③ 叫停的是中断分支不是收尾清理：`pathfinder.stop()` 发生在 **goto 还没 settle** 时
 *      （`withNav` 收尾也会 stop，但那时 goto 已经结束了 —— 靠这个区分，不靠次数）；
 *   ④ 正常路径不被守卫遮挡：没中断时 goto 正常完成 ⇒ 返回 true；
 *   ⑤ 同族两处 `while (… && !bot.interrupt_code)`：`useDoor`（isMoving）与
 *      `goToBed`（isSleeping）—— 没有这个守卫时它们是**死循环**，所以用例带看门狗，
 *      回退表现为"看门狗超时"而不是"断言值不对"（诚实：卡死就是卡死）。
 *
 * 不需要 Minecraft 服务器（桩 bot）。用法：
 *   node tools/goToGoal_interrupt_unit.mjs
 *   SKILLS_MODULE=../tmp/red33/src/agent/library/skills.js node tools/goToGoal_interrupt_unit.mjs   # 反向验证
 *
 * 输出：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import Vec3 from 'vec3';
import mcDataLoader from 'minecraft-data';
import pf from 'mineflayer-pathfinder';

const SKILLS = process.env.SKILLS_MODULE ?? '../src/agent/library/skills.js';
const skills = await import(SKILLS);

/** mineflayer-pathfinder 的 `new Movements(bot)` 会读 bot.registry —— 给它一份真的。 */
const REGISTRY = mcDataLoader('1.21.8');

/** 硬超时（`GOTO_HARD_LIMIT_MS`）——用例只把它当"参照物"：中断必须远远早于它。 */
const HARD_LIMIT_MS = 180000;

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, actual) => { fail++; console.log(`FAIL ${n} ${actual}`); };

console.log(`被测模块：skills=${SKILLS}`);

/**
 * 看门狗：卡死与"断言不对"必须分开报。
 * 回退守卫时这两个循环**永远不会退出**，没有看门狗的话整个门禁会挂 180s 甚至跑不完。
 */
function withWatchdog(promise, ms) {
    let timer = null;
    const guard = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
    });
    const raced = Promise.race([
        promise.then((value) => ({ timedOut: false, ok: true, value }))
            .catch((err) => ({ timedOut: false, ok: false, err })),
        guard,
    ]);
    return raced.finally(() => clearTimeout(timer));
}

/** 最小假 bot + 一份 pathfinder 调用记录（谁调了 stop、调的时候 goto 结束没）。 */
function makeBot(over = {}) {
    const rec = { gotos: 0, stops: [], setGoals: 0, getPathTo: 0 };
    let gotoSettled = false;
    const t0 = Date.now();
    const bot = {
        username: 'unit_gotogoal_interrupt',
        entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
        registry: REGISTRY,
        entities: {},
        players: {},
        game: { dimension: 'overworld', gameMode: 'survival' },
        inventory: { slots: [], items: () => [], emptySlotCount: () => 20, findInventoryItem: () => null },
        modes: { isOn: () => false, pause: () => { }, unpause: () => { }, isPaused: () => false },
        // 世界全空：这个测试只关心"停没停下来"，不关心地形
        blockAt: () => null,
        findBlocks: () => [],
        chat: () => { },
        lookAt: () => Promise.resolve(),
        output: '',
        heldItem: null,
        pathfinder: {
            getPathTo: () => { rec.getPathTo++; return Promise.resolve({ status: 'noPath', path: [] }); },
            setMovements: () => { },
            setGoal: () => { rec.setGoals++; },
            stop: () => { rec.stops.push({ at: Date.now() - t0, gotoPending: !gotoSettled }); },
            isMoving: () => true,
            // 桩：goto **永远不返回** —— 模拟"目标不可达但 pathfinder 还在傻走"
            goto: () => { rec.gotos++; return new Promise(() => { }); },
        },
        ...over,
    };
    return { bot, rec, markGotoSettled: () => { gotoSettled = true; } };
}

const GOAL = new pf.goals.GoalNear(10, 64, 10, 1);

// ── ④ 正常完成路径不受影响（守卫不许把正常走路也掐了）────────────────────────
{
    const { bot, rec, markGotoSettled } = makeBot({
        // 正常场景：goto 自己会返回
        pathfinder: null,
    });
    let settled = false;
    bot.pathfinder = {
        getPathTo: () => { rec.getPathTo++; return Promise.resolve({ status: 'success', path: [] }); },
        setMovements: () => { },
        setGoal: () => { rec.setGoals++; },
        stop: () => { rec.stops.push({ at: Date.now(), gotoPending: !settled }); },
        isMoving: () => true,
        goto: () => { rec.gotos++; settled = true; markGotoSettled(); return Promise.resolve(); },
    };
    // 注意：不置 interrupt_code
    const t0 = Date.now();
    const r = await withWatchdog(skills.goToGoal(bot, GOAL), 5000);
    const ms = Date.now() - t0;
    const stopWhileRunning = rec.stops.filter((s) => s.gotoPending);

    if (!r.timedOut && r.ok === true && r.value === true && rec.gotos === 1 && stopWhileRunning.length === 0) {
        okCase('没中断时 goToGoal 正常返回 true（守卫没遮挡正常路径）',
            `返回值=${r.value} 耗时=${ms}ms goto=${rec.gotos} 次 中断式 stop=${stopWhileRunning.length} 次`);
    } else {
        badCase('正常路径应返回 true',
            `timedOut=${r.timedOut} 返回=${JSON.stringify(r.value)} 异常=${r.err?.message} 中断式 stop=${stopWhileRunning.length}`);
    }
}

// ── ① 中断：置 interrupt_code ⇒ INTERRUPTED，且 1 秒内返回 ────────────────────
{
    const { bot, rec } = makeBot();
    // 模拟"走了一半玩家按 !stop"：30ms 后置标志（不是调用前置，那个太容易假过）
    setTimeout(() => { bot.interrupt_code = 'player_stop'; }, 30);
    const t0 = Date.now();
    const r = await withWatchdog(skills.goToGoal(bot, GOAL), 5000);
    const ms = Date.now() - t0;

    if (r.timedOut) {
        badCase('中断后应尽快返回', `看门狗 5s 到了还没返回（goto 从未 settle ⇒ 没有中断支）`);
    } else if (r.ok === false && r.err?.code === 'INTERRUPTED' && ms < 1000 && rec.gotos === 1) {
        okCase('goToGoal 置 interrupt_code ⇒ INTERRUPTED', `code=${r.err.code} 耗时=${ms}ms goto 调用=${rec.gotos} 次`);
    } else {
        badCase('goToGoal 应抛 code=INTERRUPTED',
            `ok=${r.ok} code=${r.err?.code} msg=${r.err?.message} 耗时=${ms}ms goto=${rec.gotos}`);
    }

    // ② 不是靠 180s 硬超时兜底：耗时远小于上限，且错误不是 hard limit 那条
    const msg = String(r.err?.message ?? '');
    if (!r.timedOut && ms * 20 < HARD_LIMIT_MS && !/hard limit/i.test(msg)) {
        okCase('用时远小于 180s 硬超时（不是靠超时兜底）', `${ms}ms << ${HARD_LIMIT_MS}ms，msg=${JSON.stringify(msg)}`);
    } else {
        badCase('中断必须是"真的停下来"而不是等超时', `耗时=${ms}ms msg=${JSON.stringify(msg)}`);
    }

    // ③ 叫停的是**中断分支**：stop() 发生在 goto 还挂着的时候
    //    （withNav 收尾也会 stop，但那时 goto 已经结束 —— 用 gotoPending 区分，不靠调用次数）
    const stopWhileRunning = rec.stops.filter((s) => s.gotoPending);
    if (!r.timedOut && stopWhileRunning.length >= 1 && stopWhileRunning[0].at < 1000) {
        okCase('中断分支调了 pathfinder.stop()（goto 仍在进行中时就叫停）',
            `stop 调用 ${rec.stops.length} 次，其中 goto 未结束时 ${stopWhileRunning.length} 次，最早 ${stopWhileRunning[0].at}ms`);
    } else {
        badCase('中断分支应调用 pathfinder.stop()',
            `stop=${JSON.stringify(rec.stops)} 中断时仍在跑的=${stopWhileRunning.length}`);
    }
}

// ── ⑤ 同族（一）useDoor：`while (pathfinder.isMoving() && !interrupt_code)` ────
//    isMoving 永远 true ⇒ 没有 `&& !bot.interrupt_code` 就是死循环。
{
    const { bot } = makeBot();
    setTimeout(() => { bot.interrupt_code = 'player_stop'; }, 150);
    const t0 = Date.now();
    // useDoor 先固定 sleep 1000ms，再每 100ms 查一次循环条件
    const r = await withWatchdog(skills.useDoor(bot, { x: 10, y: 64, z: 10 }), 6000);
    const ms = Date.now() - t0;

    if (r.timedOut) {
        badCase('useDoor 的 isMoving 循环应响应中断', '看门狗 6s 到了还没返回（isMoving 恒 true ⇒ 循环没有中断出口）');
    } else if (ms < 3000) {
        okCase('useDoor：isMoving 恒 true 时被 interrupt_code 打断',
            `耗时=${ms}ms（=1000ms 固定等待 + 一次 100ms 轮询），返回=${JSON.stringify(r.value)}`);
    } else {
        badCase('useDoor 应在一个轮询周期内退出循环', `耗时=${ms}ms 返回=${JSON.stringify(r.value)}`);
    }
}

// ── ⑥ 同族（二）goToBed：`while (bot.isSleeping && !interrupt_code)` ──────────
//    isSleeping 永远 true ⇒ 没有 `&& !bot.interrupt_code` 就是死循环。
{
    const bedPos = new Vec3(10, 64, 10);
    const { bot } = makeBot({
        // 作弊模式：goToPosition 走 /tp 快路径，用例不关心导航（导航有 ①②④ 覆盖）
        modes: { isOn: (n) => n === 'cheat', pause: () => { }, unpause: () => { }, isPaused: () => false },
        findBlocks: () => [bedPos],
        blockAt: () => ({ name: 'red_bed', position: bedPos, _properties: { occupied: false } }),
        isSleeping: false,
    });
    // 躺下之后 isSleeping 一直为 true —— 正是"没有中断出口就睡到天亮"的那个局面
    bot.sleep = () => { bot.isSleeping = true; return Promise.resolve(); };
    setTimeout(() => { bot.interrupt_code = 'player_stop'; }, 150);
    const t0 = Date.now();
    const r = await withWatchdog(skills.goToBed(bot), 6000);
    const ms = Date.now() - t0;

    if (r.timedOut) {
        badCase('goToBed 的 isSleeping 循环应响应中断', '看门狗 6s 到了还没返回（isSleeping 恒 true ⇒ 循环没有中断出口）');
    } else if (r.value === true && ms < 3000) {
        okCase('goToBed：isSleeping 恒 true 时被 interrupt_code 打断',
            `耗时=${ms}ms（一个 500ms 轮询周期内），返回=${r.value}`);
    } else {
        badCase('goToBed 应在一个轮询周期内醒来', `耗时=${ms}ms 返回=${JSON.stringify(r.value)}`);
    }
}

// ── ⑦ 结构断言：三处守卫都还在（防"改回来了但用例恰好还能过"）────────────────
{
    const src = readFileSync(new URL(SKILLS, import.meta.url), 'utf8');
    const guards = [
        ['goToGoal 中断支（200ms 轮询 interrupt_code）', /interruptTimer = setInterval\(\(\) => \{[\s\S]{0,200}?bot\.interrupt_code[\s\S]{0,300}?code = 'INTERRUPTED'/],
        ['useDoor 循环守卫', /while \(bot\.pathfinder\.isMoving\(\) && !bot\.interrupt_code\)/],
        ['goToBed 循环守卫', /while \(bot\.isSleeping && !bot\.interrupt_code\)/],
        ['180s 硬超时仍在（参照物没被删）', /GOTO_HARD_LIMIT_MS = 180000/],
    ];
    const missing = guards.filter(([, re]) => !re.test(src)).map(([name]) => name);
    if (missing.length === 0) okCase('三处中断守卫 + 180s 硬超时都在源码里', guards.map(([n]) => n).join(' / '));
    else badCase('源码里缺少中断守卫', missing.join(' / '));
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
