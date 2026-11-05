/**
 * T31 第6条：`!stop` 对任务板上的单**必须真的生效**（三处断链的接线守卫）—— 离线，真 sqlite。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 现场事故：玩家按 `!stop`，面板上的单纹丝不动（或者只 paused 一拍就自己回 ready），
 *   身体接着挖。三处断链：
 *   ① `board_scheduler._runJob` 直接 `await runner(...)` —— 没经过 `actions.runAction`
 *      ⇒ `actions.executing` 全程 **false** ⇒ `resolveJob` 认不出单、中断链路全断。
 *   ② `action_manager.stop()` 第一句 `if (!this.executing) return;`
 *      ⇒ 上面那个 false 一到，**一次 `requestInterrupt()` 都不发**。
 *   ③ `control.applyStop` 关的是 `board.setAutoClaim`（客户端镜像字段，调度器不看），
 *      真正管领单的 `scheduler._autoClaim` 没人关；而且 `pausedReason` **零处写** ⇒
 *      下一拍调度器就把这张单自己 resume 回 ready。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 本文件用**真**部件跑：真 `board_store`（SQLite）+ 真 `ActionManager` + 真 `BoardScheduler`
 * + 真 `control.planStop/applyStop`。只有"身体"是假的（不连 Minecraft）。
 *
 * 输出：PASS / FAIL，全过退出码 0。临时库在 tmp/，跑完删除。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
    openBoard, addJob, getJob, listJobs, claimFor, setState, updateJob,
    heartbeat, finish, JOB_STATE,
} from '../src/agent/library/board_store.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { BoardScheduler } from '../src/agent/library/board_scheduler.js';
import { applyStop } from '../src/agent/library/control.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// ★ T15（并发加固）：**每个进程一个独立目录**。
//   原来用固定的 `tmp/<name>` 且开跑第一件事就是 rmSync 掉它 ——
//   同机两路 unit_all（或两路并发跑测试）会互删对方的 fixture，
//   表现为「整跑随机变红、单跑全绿」。mkdtempSync 让两路各拿各的目录。
const DIR = mkdtempSync(join(os.tmpdir(), 'board-stop-test-'));
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); return openBoard(d).db; };
const BOT = 'tester';

/**
 * 把**真** board_store 包成调度器/客户端认的那层接口（`boardClient` 形状）。
 * ★ 故意不用内存假板：本条的验收是"库里的单真的变了"，那就得让库是真的。
 */
function makeStoreBoard(db) {
    const api = {
        db,
        isStoreBoard: true,
        list(filter = {}) { return listJobs(db, { states: filter.states ?? null, assignee: filter.assignee ?? null, openOnly: true }); },
        get(id) { return getJob(db, id); },
        // ★ 这些桩**不写 async**：真客户端返回 Promise，桩照样返回 Promise，
        //   调用点 `await` 语义不变；写成 async 而没有 await 会被 require-await 逐条点名。
        getAsync(id) { return Promise.resolve({ ok: true, data: { job: getJob(db, id) } }); },
        claim() { return Promise.resolve({ ok: true, data: { job: claimFor(db, BOT) } }); },
        setState(id, state, reason = '') {
            const r = setState(db, id, state, {});
            return Promise.resolve({ ok: r.ok, code: r.code, data: { job: getJob(db, id) }, reason });
        },
        update(id, patch) { return Promise.resolve({ ok: updateJob(db, id, patch ?? {}).ok }); },
        heartbeat(id, progress) {
            const r = heartbeat(db, id, BOT, { progress });
            return Promise.resolve({ ok: r.ok, code: r.code, data: { job: getJob(db, id) } });
        },
        finish(id, result) {
            const r = finish(db, id, result, { bot: BOT });
            return Promise.resolve({ ok: r.ok, code: r.code, data: { next: r.next, job: getJob(db, id) } });
        },
        add(job) { return Promise.resolve({ ok: true, data: { job: addJob(db, job) } }); },
        refresh() { return Promise.resolve({ ok: true }); },
        checkpoint(id, cp) { return Promise.resolve({ ok: updateJob(db, id, { checkpoint: cp }).ok }); },
        // ★ T31 第16条：调度器 ctx 用到的两个共享箱接口（本文件不测，给个安全实现）
        sharedMerge() { return Promise.resolve({ ok: true }); },
        sharedGet() { return Promise.resolve({ ok: true, item: null }); },
    };
    return api;
}

/** 假身体：只实现被 `requestInterrupt` / `clearBotLogs` / 流程会碰到的那些方法。 */
function makeBot() {
    return {
        interrupt_code: false,
        output: '',
        lastFailure: null,
        entity: { position: { x: 0, y: 64, z: 0 } },
        inventory: { items: () => [] },
        registry: { blocksByName: {} },
        emit() { /* 记录 idle 事件，不需要 */ },
        stopDigging() { /* noop */ },
        collectBlock: { cancelTask() { /* noop */ } },
        pathfinder: { stop() { /* noop */ } },
        pvp: { stop() { /* noop */ } },
        clearControlStates() { /* noop */ },
        releaseAll() { /* noop */ },
    };
}

/** 假 agent：真的 ActionManager 需要的那几个钩子。 */
function makeAgent(bot, board) {
    return {
        name: BOT,
        bot,
        board,
        boardClient: board,
        roles: [],
        scheduler: null,                 // 由用例注入
        requestInterrupt() { bot.interrupt_code = true; },
        clearBotLogs() { bot.output = ''; bot.interrupt_code = false; },
        history: { add() { /* noop */ } },
        cleanKill() { /* 不该被调到 */ },
        isIdle: () => false,
        self_prompter: { isActive: () => false, stop() { /* noop */ } },
    };
}

/** 会"干活"的流程：每步 20ms，步骤边界检查中断（真流程就是这么做的）。 */
function makeLongRunner({ steps = 60, stepMs = 20, bodyLog = [] } = {}) {
    return async (_agent, skill) => {
        for (let i = 0; i < steps; i++) {
            bodyLog.push({ skill, step: i, at: Date.now() });
            await new Promise((r) => setTimeout(r, stepMs));
            if (_agent?.bot?.interrupt_code) {
                return { ok: false, code: 'INTERRUPTED', data: { count: i, want: steps } };
            }
        }
        return { ok: true, code: 'OK', data: { count: steps, want: steps } };
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (fn()) return true;
        await sleep(10);
    }
    return false;
};

/** 造一套"正在跑长单"的现场：返回 {db, board, agent, actions, sched, bodyLog, events, job} */
function makeRunningScene({ schedulerClass = BoardScheduler, actionClass = ActionManager, runner } = {}) {
    const db = freshDb();
    const job = addJob(db, {
        title: '长单', skill: 'mine', args: { block: 'oak_log', count: 64 },
        assignee: null, state: JOB_STATE.READY, priority: 5,
    });
    const board = makeStoreBoard(db);
    const bot = makeBot();
    const agent = makeAgent(bot, board);
    const actions = new actionClass(agent);
    agent.actions = actions;
    const bodyLog = [];
    const events = [];
    const sched = new schedulerClass({
        agent,
        actions,
        board,
        runSkill: runner ?? makeLongRunner({ bodyLog }),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onEvent: (e) => events.push(e),
    });
    agent.scheduler = sched;                 // ★ 断链③ 要的就是这个引用
    return { db, board, agent, actions, sched, bodyLog, events, job };
}

// ══════════════════════════════════════════════════════════════════════════
// ① ★ 主用例（改之后）：长单执行中按 !stop → 单进 paused + pausedReason='player'
//    + 自动领单被关 + 身体真的停下 + finish 不再把它推回 ready
// ══════════════════════════════════════════════════════════════════════════
{
    const s = await makeRunningScene();
    const tickP = s.sched.tick();                                  // 不 await：让单真的跑起来
    const started = await waitFor(() => s.actions.executing === true, 3000);
    const bodyBeforeStop = s.bodyLog.length;
    const stateWhileRunning = getJob(s.db, s.job.id).state;

    // 玩家按 `!stop`（走**真的** ActionManager.stop → 真的 applyStop/planStop）
    await s.actions.stop('player');
    const bodyAtStopReturn = s.bodyLog.length;
    await tickP;
    await sleep(120);                                              // 留点时间给"如果它还想接着干"
    const bodyAfter = s.bodyLog.length;

    const after = getJob(s.db, s.job.id);
    const pausedReason = after.checkpoint?.pausedReason ?? after.pausedReason ?? null;
    const bodyStopped = bodyAfter - bodyAtStopReturn <= 2;          // 最多再走一两步

    const good = started && s.bodyLog.length > 0
        && [JOB_STATE.CLAIMED, JOB_STATE.RUNNING].includes(stateWhileRunning)
        && after.state === JOB_STATE.PAUSED
        && pausedReason === 'player'
        && after.result?.code === 'INTERRUPTED'
        && s.sched.autoClaim === false
        && bodyStopped;
    if (good) {
        okCase('★ ① 长单跑着按 !stop → 单 paused + pausedReason=player + 自动领单关 + 身体停下',
            `state=${after.state} pausedReason=${pausedReason} autoClaim=${s.sched.autoClaim} 步数 ${bodyBeforeStop}/${bodyAtStopReturn}/${bodyAfter}`);
    } else {
        badCase('① !stop 没有真正生效（第6条回归）', {
            started, executing: s.actions.executing, stateWhileRunning,
            state: after.state, pausedReason, result: after.result,
            autoClaim: s.sched.autoClaim, bodyBeforeStop, bodyAtStopReturn, bodyAfter,
            events: s.events.map((e) => e.type).slice(-6),
        });
    }

    // ② finish 没有被调用过（玩家的 paused 不许被它覆盖成 ready）
    const skipped = s.events.some((e) => e.type === 'skip-finish-paused');
    if (skipped && after.state === JOB_STATE.PAUSED) {
        okCase('② 收尾守卫：玩家按停的单跳过 finish（不然 INTERRUPTED 会把 paused 推回 ready）',
            `events=${s.events.map((e) => e.type).filter((t) => t.startsWith('skip')).join(',')}`);
    } else {
        badCase('② finish 把玩家按停的 paused 覆盖掉了', { skipped, state: after.state });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 断链③（后半）：**下一拍不许把玩家按停的单自动 resume**
//    —— 这是"按停只维持 3 秒"那个症状的直接回归
// ══════════════════════════════════════════════════════════════════════════
{
    const s = await makeRunningScene();
    const tickP = s.sched.tick();
    await waitFor(() => s.actions.executing === true, 3000);
    await s.actions.stop('player');
    await tickP;

    // 把自动领单**打开**（否则 tick 在 auto-claim-off 就返回了，测不到 resume 逻辑）
    s.sched.setAutoClaim(true);
    const r = await s.sched.tick();
    const after = getJob(s.db, s.job.id);
    if (after.state === JOB_STATE.PAUSED && after.checkpoint?.pausedReason === 'player') {
        okCase('★ ③ 自动领单打开后，玩家按停的单**仍不被自动 resume**（pausedReason 真的被读到了）',
            `tick=${r.reason} state=${after.state} pausedReason=${after.checkpoint?.pausedReason}`);
    } else {
        badCase('③ 玩家按停的单被自动 resume 了（pausedReason 写了却没人读）', { tick: r.reason, state: after.state, cp: after.checkpoint });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 断链③（前半）：`applyStop(PLAYER)` 必须关掉**真正管领单**的那个开关
// ══════════════════════════════════════════════════════════════════════════
{
    const s = await makeRunningScene();
    s.sched.setAutoClaim(true);
    const plan = applyStop({ agent: s.agent, reason: 'player', jobId: null });
    const afterTick = await s.sched.tick();
    const claims = s.board.list({ states: [JOB_STATE.CLAIMED, JOB_STATE.RUNNING] }).length;
    if (plan.pauseAutoClaim === true && s.sched.autoClaim === false
        && afterTick.reason === 'auto-claim-off' && claims === 0) {
        okCase('★ ④ applyStop(player) 关掉 scheduler._autoClaim（不只是客户端镜像）→ 下一拍真不领单',
            `reason=${afterTick.reason} autoClaim=${s.sched.autoClaim}`);
    } else {
        badCase('④ 玩家喊停后调度器照领新单（关了个没人读的开关）', {
            plan: plan.pauseAutoClaim, autoClaim: s.sched.autoClaim, tick: afterTick.reason, claims,
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★★ 失败反证（改之前会怎样）：把两处接线**变异回原样**，同场景必须变坏
//
//    变异 A：`_runJob` 直接 `await runner(...)`（不经过 runJobAction）
//    变异 B：`action_manager.stop()` 第一句 `if (!this.executing) return;`
//    ★ 两处必须**一起**变异 —— 它们是一条链上的两个环（① 让 executing 为假，
//      ② 才因此提前 return）。只变异一个，另一个会替它兜住，容易得出"没那么严重"的错觉。
// ══════════════════════════════════════════════════════════════════════════
{
    const libDir = pathToFileURL(join(process.cwd(), 'src', 'agent', 'library')).href;
    const agentDir = pathToFileURL(join(process.cwd(), 'src', 'agent')).href;
    const MUT = join(DIR, 'mut');
    const prep = (src, tag, fromDir) => {
        const d = join(MUT, tag);
        mkdirSync(d, { recursive: true });
        const f = join(d, 'm.mjs');
        // 把相对 import 全改成绝对 file:// URL（别数 ../ 层数，我数错过）
        const out = src.replace(/from '\.\/([^']+)'/g, (_m, p) => `from '${fromDir}/${p}'`);
        writeFileSync(f, out, 'utf8');
        return pathToFileURL(f).href;
    };

    const schedSrc = readFileSync('src/agent/library/board_scheduler.js', 'utf8');
    const amSrc = readFileSync('src/agent/action_manager.js', 'utf8');

    // 变异 A：把"经 runJobAction 驱动"整段换成老的一行直调（**字符串切片**，不用正则）
    const A_HEAD = 'let inner = null;';
    const A_TAIL = "result = inner ?? { ok: false, code: 'INTERNAL', message: '流程没有返回结果' };";
    const a0 = schedSrc.indexOf(A_HEAD);
    const a1 = schedSrc.indexOf(A_TAIL);
    const schedMut = (a0 > 0 && a1 > a0)
        ? schedSrc.slice(0, a0)
          + 'result = await runner(this.agent, job.skill, argsToString(job.args), job); /* MUTANT-A */'
          + schedSrc.slice(a1 + A_TAIL.length)
        : schedSrc;

    // 变异 B：把"有在飞单就补发中断"的整块换回一句直接 return
    const B_HEAD = 'if (!this.executing) {';
    const b0 = amSrc.indexOf(B_HEAD);
    const bEnd = amSrc.indexOf('\n        }', b0);
    const amMut = (b0 > 0 && bEnd > b0)
        ? amSrc.slice(0, b0)
          + 'if (!this.executing) return; /* MUTANT-B */\n        if (false) {'
          + amSrc.slice(bEnd)
        : amSrc;

    const appliedA = schedMut !== schedSrc;
    const appliedB = amMut !== amSrc;
    if (appliedA && appliedB) {
        okCase('⑤-0 两处变异都真的落到了源码上（A: 直调 runner / B: 提前 return）', `A=${appliedA} B=${appliedB}`);
    } else {
        badCase('⑤-0 变异没打上（正则与源码对不上，反证不算数）', { appliedA, appliedB });
    }

    try {
        const specSched = prep(schedMut, 'sched', libDir);
        const specAm = prep(amMut, 'am', agentDir);
        const MutSched = (await import(specSched)).BoardScheduler;
        const MutAM = (await import(specAm)).ActionManager;

        const s = await makeRunningScene({ schedulerClass: MutSched, actionClass: MutAM });
        const tickP = s.sched.tick();
        // 变异体里 executing 永远是 false（这正是断链①的现场）
        await waitFor(() => s.bodyLog.length >= 3, 2000);
        const executingDuringRun = s.actions.executing;
        await s.actions.stop('player');                 // 玩家按停
        const bodyAtStopReturn = s.bodyLog.length;
        await sleep(200);                               // 给它"接着干活"的时间
        const bodyAfter = s.bodyLog.length;
        const stillWorking = bodyAfter > bodyAtStopReturn + 3;
        await tickP;

        if (executingDuringRun === false && stillWorking) {
            okCase('★ ⑤ 失败反证：改之前 `executing` 全程 false、按停之后身体**还在干活**（步数继续涨）',
                `executing=${executingDuringRun} 步数 ${bodyAtStopReturn} → ${bodyAfter}`);
        } else {
            badCase('⑤ 变异体竟然表现正常（说明反证不成立，用例本身要看）', {
                executingDuringRun, bodyAtStopReturn, bodyAfter,
            });
        }
    } catch (e) {
        badCase('⑤ 能生成并加载变异体', { error: String(e?.message ?? e) });
    }
}

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
