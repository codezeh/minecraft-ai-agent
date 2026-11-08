/**
 * board_scheduler 离线测试（M8 B2，06 §7/§8/§12 + 设计 §4）。
 *
 * 用**假板 + 假 ActionManager + 假时钟**，不连 socket、不连服务器、不用真 sleep。
 *
 * 重点锁三件事（设计 §4 的三个高危点）：
 *   ① **抢占方与被抢占方不能同时驱动 bot** —— 用**计数器**证明，不靠"看起来对"：
 *      数"身体调用"（按键/挖掘/流程进入），断言任意时刻**并发在跑的身体操作 ≤ 1**。
 *   ② **INTERRUPTED 在抢占路径上不计 attempts** —— 断言 paused 之后 attempts 没涨。
 *   ③ **setAutoClaim(false) 后真的不领新单**，true 后恢复 —— 显式开关，不靠"没单"推断。
 *
 * 另加：空闲时不空转（一遍 tick 只 claim 一次）、领取冲突退避、requeueStaleBrief 接上。
 * 另加（t38）：空闲 `idle-plan` 事件只在"结论变了"时播报 —— 2 分钟空闲 40 条 → 1 条。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import {
    BoardScheduler, preempts, pickBest, meetsRequires, argsToString,
    idlePlanEmission, readIdleState,
    CLAIM_BACKOFF_MS, HEARTBEAT_MS,
} from '../src/agent/library/board_scheduler.js';
import { JOB_STATE, STOP_REASONS, BRIEF_REQUEUE_MS } from '../src/agent/library/control.js';
// ★ A5-8：客户端那半边（心跳守卫在 board_client 里）也一起锁上
import { BoardClient } from '../src/agent/library/board_client.js';
// t68：**共享假件**（默认 strictPoints:true —— 像真 mineflayer 一样拒裸坐标）。
// 下面 t39 段用本文件的 makeIdleBot（宽松件，只测判据逻辑）；末尾 ⑧ 专门用这个严格件
// 复现"生产真实形态"，因为两者的差别正是 t70/t39 那类 bug 的藏身处。
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// ══════════════════════════════════════════════════════════════════════════
// 测试替身
// ══════════════════════════════════════════════════════════════════════════

/**
 * 假任务板：内存里的单 + 记录所有调用。
 * 故意实现得**笨但忠实**：状态转移只做调度器需要的那几个。
 */
function makeFakeBoard(initialJobs = []) {
    const jobs = new Map(initialJobs.map((j) => [j.id, { ...j }]));
    const calls = [];

    const api = {
        jobs,
        calls,
        list(filter = {}) {
            const states = filter.states ?? null;
            const out = [...jobs.values()].filter((j) => {
                if (states && !states.includes(j.state)) return false;
                if (filter.assignee && j.assignee !== filter.assignee) return false;
                return true;
            });
            calls.push({ op: 'list', states });
            return out.map((j) => ({ ...j }));
        },
        get(id) { calls.push({ op: 'get', id }); const j = jobs.get(id); return j ? { ...j } : null; },
        claim() {
            calls.push({ op: 'claim' });
            // 挑最高优先级、ready 的
            const cand = [...jobs.values()]
                .filter((j) => j.state === JOB_STATE.READY)
                .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
            if (!cand) return { ok: true, data: { job: null } };
            cand.state = JOB_STATE.CLAIMED;
            cand.lease = { owner: 'tester', until: Date.now() + 30000 };
            return { ok: true, data: { job: { ...cand } } };
        },
        setState(id, state, reason = '') {
            calls.push({ op: 'setState', id, state, reason });
            const j = jobs.get(id);
            if (!j) return { ok: false, code: 'NO_TARGET' };
            j.state = state;
            if (state === JOB_STATE.PAUSED) j.pausedReason = reason;
            if (state === JOB_STATE.READY) j.pausedReason = null;
            return { ok: true, data: { job: { ...j } } };
        },
        heartbeat(id, progress) {
            calls.push({ op: 'heartbeat', id, progress });
            const j = jobs.get(id);
            if (!j) return { ok: false, code: 'NO_TARGET' };
            if (progress) j.progress = progress;
            return { ok: true, data: { job: { ...j } } };
        },
        finish(id, result) {
            calls.push({ op: 'finish', id, result });
            const j = jobs.get(id);
            if (!j) return { ok: false, code: 'NO_TARGET' };
            const counted = result?.ok === true && (result?.progress?.want == null
                || Number(result.progress.count) >= Number(result.progress.want));
            j.state = counted ? JOB_STATE.DONE : JOB_STATE.READY;
            j.result = result;
            return { ok: true, data: { next: j.state, counted } };
        },
        update(id, patch) {
            calls.push({ op: 'update', id, patch });
            const j = jobs.get(id);
            if (j && patch) Object.assign(j, patch);
            return { ok: true };
        },
        getAsync(id) { return { ok: true, data: { job: jobs.get(id) ?? null } }; },
        /** t39：idle_planner 第 1 层自己找的单要真的落板（`enqueue` → `board.add`）。 */
        add(job) {
            calls.push({ op: 'add', job });
            const id = job?.id ?? `auto${jobs.size + 1}`;
            const j = { ...job, id, state: job?.state ?? JOB_STATE.READY };
            jobs.set(id, j);
            return { ok: true, data: { job: { ...j } } };
        },
        hello() { return { ok: true }; },
        refresh() { return { ok: true }; },
        checkpoint() { return { ok: true }; },
    };
    return api;
}

/**
 * 假 ActionManager：追踪"身体是否在被驱动"。
 *
 * ★ 关键：`executing` 是**唯一**的"身体在被驱动"的标志。
 *   我们在 `runSkill` 里也检查它 —— 若在跑时又有人进来跑，就记一次 **并发违规**。
 *   这样"两个流程同时驱动 bot"这个 bug 会**变成计数器上的数字**，不靠眼看。
 */
function makeFakeActions({ stopDelayMs = 0 } = {}) {
    const state = {
        executing: false,
        killed: false,
        stopReason: null,
        currentJobId: null,
        stops: [],
    };
    return {
        get executing() { return state.executing; },
        get killed() { return state.killed; },
        get stopReason() { return state.stopReason; },
        set killed(v) { state.killed = v; },
        state,
        async stop(reason) {
            state.stops.push(reason);
            state.stopReason = reason;
            if (stopDelayMs) await new Promise((r) => setTimeout(r, stopDelayMs));
            state.executing = false;      // 正常情况：流程在步骤边界退出
        },
        runAction(_label, fn) { return fn(); },
    };
}

/** 假时钟：now() 由我们控制，sleep() 立即推进。 */
function makeClock(start = 1_000_000) {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => { t += ms; },
        sleep: (ms) => { t += ms; },
    };
}

/**
 * 假 runSkill：每个 skill 跑 durationMs 的"身体动作"，并**记录身体调用**。
 * 期间检查 `actions.executing` —— 用来抓"两个流程同时驱动身体"。
 */
function makeRunner({ clock, actions, durations = {}, onBody = null }) {
    const log = { bodyCalls: [], overlapViolations: 0, concurrent: 0, maxConcurrent: 0, runs: [] };
    const runSkill = async (_agent, skill, argString) => {
        log.runs.push({ skill, argString, at: clock.now() });

        // 模拟流程把 body 占住
        const wasExecuting = actions.state.executing;
        actions.state.executing = true;
        log.concurrent++;
        log.maxConcurrent = Math.max(log.maxConcurrent, log.concurrent);
        if (wasExecuting) log.overlapViolations++;      // ★ 已经有人在驱动身体了还进来 = 违规

        try {
            // 每个"流程"会发若干次身体调用（按键/挖掘）
            const steps = Number(durations.steps ?? 3);
            for (let i = 0; i < steps; i++) {
                // 每一"步"记一次身体调用
                log.bodyCalls.push({ skill, step: i, at: clock.now() });
                onBody?.({ skill, step: i, clock, actions });
                await clock.sleep(Number(durations.stepMs ?? 1000));
                // 流程在步骤边界检查 interrupt_code（模拟真实流程）
                if (actions.state.stopReason && actions.state.stopRequested) {
                    return { ok: false, code: 'INTERRUPTED', message: '被抢占', data: { count: i, want: steps } };
                }
            }
            return { ok: true, code: 'OK', data: { count: steps, want: steps } };
        } finally {
            log.concurrent--;
            actions.state.executing = false;
        }
    };
    return { runSkill, log };
}

// ══════════════════════════════════════════════════════════════════════════
// 1. preempts 规则（06 §7 表，逐级验证）
// ══════════════════════════════════════════════════════════════════════════
{
    const cases = [
        // [挑战者, 在跑, 期望, 说明]
        [9, 3, true, '9 级抢 3 级'],
        [9, 8, true, '9 级抢 8 级'],
        [9, 9, false, '同级不抢（防抖动）'],
        [8, 6, true, '8 级抢低 2 级'],
        [8, 7, false, '8 级只抢低 1 级 → 不抢'],
        [6, 4, true, '6 级抢低 2 级'],
        [6, 5, false, '6 级抢低 1 级 → 不抢'],
        [5, 3, false, '5 级（策略子单）不抢，只排队'],
        [3, 1, false, '3 级不抢'],
        [2, 1, false, '2 级只在完全空闲时，不抢'],
        [0, 0, false, '同级不抢'],
    ];
    const bad = cases.filter(([a, b, exp]) => preempts(a, b) !== exp);
    if (bad.length === 0) {
        okCase('preempts 完全符合 06 §7 表（11 组逐级验证 + 同级防抖动）', `${cases.length} 组`);
    } else {
        badCase('preempts 规则不符', bad.map(([a, b, e]) => `${a}vs${b} 期望${e} 实际${preempts(a, b)}`));
    }
}

// 2. pickBest：优先级高的先，同级取近的
{
    const jobs = [
        { id: 'a', state: JOB_STATE.READY, priority: 5, args: { target: { x: 100, z: 0 } } },
        { id: 'b', state: JOB_STATE.READY, priority: 9, args: { target: { x: 100, z: 0 } } },
        { id: 'c', state: JOB_STATE.READY, priority: 9, args: { target: { x: 2, z: 0 } } },
        { id: 'd', state: JOB_STATE.DONE, priority: 9, args: {} },
    ];
    const best = pickBest(jobs, { x: 0, z: 0 });
    if (best?.id === 'c') okCase('pickBest：优先级优先、同级取近', `best=${best.id}（两个 9 级里近的是 c）`);
    else badCase('pickBest', best);
}

// 3. meetsRequires
{
    const job = { requires: { roles: ['miner'] } };
    const ok1 = meetsRequires(job, { roles: ['miner'] }) === true;
    const ok2 = meetsRequires(job, { roles: ['builder'] }) === false;
    const ok3 = meetsRequires({ requires: null }, {}) === true;
    if (ok1 && ok2 && ok3) okCase('meetsRequires：有角色放行/没角色拦下/无要求放行', 'ok');
    else badCase('meetsRequires', { ok1, ok2, ok3 });
}

// 4. argsToString
{
    const s = argsToString({ block: 'oak_log', count: 4 });
    if (/block=oak_log/.test(s) && /count=4/.test(s)) okCase('argsToString：对象 → key=value 串', s);
    else badCase('argsToString', s);
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 主循环：领单 → 跑 → finish（假时钟）
// ══════════════════════════════════════════════════════════════════════════
{
    const clock = makeClock();
    const board = makeFakeBoard([{ id: 'j1', state: JOB_STATE.READY, skill: 'mine', args: { count: 2 }, priority: 5 }]);
    const actions = makeFakeActions();
    const { runSkill, log } = makeRunner({ clock, actions, durations: { steps: 3 } });
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });

    const r = await sched.tick();

    const claimed = board.calls.some((c) => c.op === 'claim');
    const finished = board.calls.some((c) => c.op === 'finish');
    const jobDone = board.jobs.get('j1').state === JOB_STATE.DONE;
    if (r.acted && claimed && finished && jobDone) {
        okCase('主循环：空闲→claim→跑→finish→done', `tick=${r.reason} 身体调用=${log.bodyCalls.length} 次`);
    } else {
        badCase('主循环一步', { r, claimed, finished, state: board.jobs.get('j1').state });
    }
}

// 6. 空闲时不空转：没有单时 tick 一遍只 claim 一次，不开跑
{
    const clock = makeClock();
    const board = makeFakeBoard([]);
    const actions = makeFakeActions();
    const { runSkill, log } = makeRunner({ clock, actions });
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });

    const r = await sched.tick();
    const claims = board.calls.filter((c) => c.op === 'claim').length;
    if (!r.acted && r.reason === 'idle' && claims === 1 && log.runs.length === 0) {
        okCase('空闲不空转：一遍 tick 只 claim 1 次、不开跑', `claims=${claims}`);
    } else {
        badCase('空闲不空转', { r, claims, runs: log.runs.length });
    }
}

// 7. setAutoClaim(false) 后**真的不领新单**；true 后恢复（高危点③）
{
    const clock = makeClock();
    const board = makeFakeBoard([{ id: 'j1', state: JOB_STATE.READY, skill: 'mine', args: {}, priority: 5 }]);
    const actions = makeFakeActions();
    const { runSkill } = makeRunner({ clock, actions });
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });

    sched.setAutoClaim(false);
    const r1 = await sched.tick();
    const claimsWhileOff = board.calls.filter((c) => c.op === 'claim').length;

    sched.setAutoClaim(true);
    const r2 = await sched.tick();
    const claimsAfterOn = board.calls.filter((c) => c.op === 'claim').length;

    const good = r1.reason === 'auto-claim-off' && claimsWhileOff === 0
        && r2.acted && claimsAfterOn === 1
        && board.jobs.get('j1').state === JOB_STATE.DONE;
    if (good) {
        okCase('③ setAutoClaim(false) 真的不领单；(true) 后恢复', `关时 claims=${claimsWhileOff} 开后 claims=${claimsAfterOn}`);
    } else {
        badCase('③ setAutoClaim 开关', { r1, r2, claimsWhileOff, claimsAfterOn, state: board.jobs.get('j1').state });
    }
}

// 8. 关掉 autoClaim 时，**正在跑的单接着跑**（06 §14）
{
    const clock = makeClock();
    const board = makeFakeBoard([]);
    const actions = makeFakeActions();
    actions.state.executing = true;                 // 假装正在跑一张单
    const { runSkill, log } = makeRunner({ clock, actions });
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });
    sched.setAutoClaim(false);
    const before = log.runs.length;
    const r = await sched.tick();
    const good = r.reason === 'auto-claim-off' && log.runs.length === before && actions.state.executing === true;
    if (good) okCase('关自动领单不打断正在跑的单（06 §14）', `reason=${r.reason}`);
    else badCase('关开关不该打断在跑的单', { r, runsDelta: log.runs.length - before });
}

// 9. 领取冲突 → 全部 release + 退避 5 秒（06 §8）
{
    const clock = makeClock();
    const board = makeFakeBoard([{ id: 'j1', state: JOB_STATE.READY, skill: 'mine', args: {}, priority: 5, claims: ['area:1', 'area:2'] }]);
    const actions = makeFakeActions();
    const { runSkill, log } = makeRunner({ clock, actions });

    // 让第二个预约冲突
    const reserveCalls = [];
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });
    // 用真 ctx 不好注入，这里包一层 runSkill 不行 —— 改测 _reserveClaims 的行为
    const ctx = {
        reserve: (k) => { reserveCalls.push(['reserve', k]); return k === 'area:2' ? { ok: false, code: 'CLAIM_CONFLICT' } : { ok: true }; },
        release: (k) => { reserveCalls.push(['release', k]); return { ok: true }; },
    };
    const res = await sched._reserveClaims({ id: 'j1', claims: ['area:1', 'area:2'] }, ctx);
    const releasedFirst = reserveCalls.some(([op, k]) => op === 'release' && k === 'area:1');
    if (!res.ok && res.code === 'CLAIM_CONFLICT' && releasedFirst) {
        okCase('领取冲突：把已占到的全部释放（避免死锁）', JSON.stringify(reserveCalls));
    } else {
        badCase('领取冲突释放', { res, reserveCalls });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 10. ★★ 抢占演练（计数证据 —— 必须是**真的并发**下才有意义）
//
//     做法：让 3 级单**真的在跑**（后台 promise，会发多次身体调用），
//     跑到第 2 步时下 9 级单并 tick() → 触发抢占 →
//     断言：3 级变 paused(preempted)、9 级执行、**任意时刻并发驱动 ≤1**。
//
//     ★ 这里第一版写歪过：我只是把 `actions.executing = true` 装成"在跑"，
//       结果低优先级流程一步身体都没走，"并发 ≤1"就成了废话（身体调用=1）。
//       现在真的把流程跑起来，并发断言才有内容。
// ══════════════════════════════════════════════════════════════════════════
{
    const clock = makeClock();
    const board = makeFakeBoard([
        { id: 'low', state: JOB_STATE.CLAIMED, skill: 'mine', args: { count: 9 }, priority: 3 },
    ]);
    const actions = makeFakeActions();

    // 真跑的"低优先级流程"：4 步，每步 1 秒；每步检查中断
    let lowSteps = 0;
    let releaseLow = null;
    let lowGateResolve = null;
    const lowGate = new Promise((r) => { lowGateResolve = r; });
    const lowDone = new Promise((res) => { releaseLow = res; });

    const log = { bodyCalls: [], overlap: 0, concurrent: 0, maxConcurrent: 0, runs: [] };
    const enterBody = (skill) => {
        log.bodyCalls.push({ skill });
        log.concurrent++;
        log.maxConcurrent = Math.max(log.maxConcurrent, log.concurrent);
        if (log.concurrent > 1) log.overlap++;      // ★ 两个人同时动身体 = 违规
    };
    const exitBody = () => { log.concurrent--; };

    const runSkill = async (_agent, skill) => {
        log.runs.push(skill);
        actions.state.executing = true;
        try {
            if (skill === 'mine') {
                // 低优先级单：跑 4 步，被中断就返回 INTERRUPTED
                for (let i = 0; i < 4; i++) {
                    if (actions.state.stopRequested) {
                        return { ok: false, code: 'INTERRUPTED', message: '被抢占', data: { count: lowSteps, want: 4 } };
                    }
                    enterBody(skill);
                    lowSteps++;
                    await clock.sleep(1000);
                    exitBody();
                    // ★ 第 2 步后停在闸门上，让测试在"确实跑到一半"时触发抢占
                    if (lowSteps === 2 && lowGate) await lowGate;
                }
                return { ok: true, code: 'OK', data: { count: 4, want: 4 } };
            }
            // 9 级单：2 步
            for (let i = 0; i < 2; i++) {
                enterBody(skill);
                await clock.sleep(1000);
                exitBody();
            }
            return { ok: true, code: 'OK', data: { count: 2, want: 2 } };
        } finally {
            actions.state.executing = false;
            if (skill === 'mine') releaseLow();
        }
    };

    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });

    // 1) 让 3 级单**真的开始跑**
    sched.currentJobId = 'low';
    const running = sched._runJob({ id: 'low', skill: 'mine', args: { count: 9 }, priority: 3 }, clock.now());

    // 2) 等它**真的**走满 2 步（然后它会停在闸门上）
    for (let i = 0; i < 60 && lowSteps < 2; i++) {
        await new Promise((r) => setImmediate(r));   // 让流程本身往前跑
        await clock.sleep(600);                       // 再推进假时钟
    }
    const stepsWhileLowActive = lowSteps;

    // 3) 此时"玩家下了 9 级单"
    board.jobs.set('high', { id: 'high', state: JOB_STATE.READY, skill: 'collect', args: {}, priority: 9 });
    actions.state.stopRequested = true;                 // 模拟流程收到 interrupt_code

    // 4) tick → 抢占
    const r = await sched.tick();
    try { lowGateResolve?.(); } catch { /* 闸门已经放行/没有闸门 */ }   // 放行闸门，让被打断的流程退出
    await running.catch(() => { });                     // 等低优先级流程收尾
    await clock.sleep(100);

    const low = board.jobs.get('low');
    const pausedPreempted = low.state === JOB_STATE.PAUSED && low.pausedReason === 'preempted';
    const highRan = log.runs.includes('collect');
    const reallyRan = stepsWhileLowActive >= 2;         // ★ 证明低优先级单**真的在跑**过
    const noOverlap = log.overlap === 0 && log.maxConcurrent <= 1;

    if (r.reason === 'preempted' && pausedPreempted && highRan && reallyRan && noOverlap) {
        okCase('★★ 抢占演练（真并发）：3 级跑过 ' + stepsWhileLowActive + ' 步 → paused(preempted)，9 级执行，并发 ≤1',
            `maxConcurrent=${log.maxConcurrent} overlap=${log.overlap} 身体调用=${log.bodyCalls.length} 顺序=${log.runs.join('>')}`);
    } else {
        badCase('★★ 抢占演练（真并发）', {
            reason: r.reason, lowState: low.state, pausedReason: low.pausedReason,
            highRan, stepsWhileLowActive, maxConcurrent: log.maxConcurrent, overlap: log.overlap, runs: log.runs,
        });
    }
}

// 10b. ★ 抢占前必须 refresh：别人新加的单本地镜像看不见（真机缺陷回归）──
//   真机验收抓到：`board_client` 的镜像只因"自己的操作 + board:changed(只更新已知单)"而变，
//   **别的客户端新加的单它不知道** → `_findPreemptor()` 翻不到 → 抢占永不触发。
//   用例：镜像里只有自己的单；"服务端"多了一张 9 级单（只有 refresh 才能拿到）→
//         调用 tick() 必须能抢到它。
{
    const clock = makeClock();
    // 服务端真相：一张 3 级（我在跑）+ 一张 9 级（别人刚加）
    const serverJobs = new Map([
        ['low', { id: 'low', state: JOB_STATE.CLAIMED, skill: 'mine', args: {}, priority: 3 }],
        ['high', { id: 'high', state: JOB_STATE.READY, skill: 'collect', args: {}, priority: 9 }],
    ]);
    // 本地镜像：**故意不含 high**（模拟"别人的单我不知道"）
    const mirror = new Map([
        ['low', { id: 'low', state: JOB_STATE.CLAIMED, skill: 'mine', args: {}, priority: 3 }],
    ]);
    let refreshCalls = 0;
    const board = {
        list: (f = {}) => {
            const src = [...mirror.values()];
            return src.filter((j) => !f.states || f.states.includes(j.state)).map((j) => ({ ...j }));
        },
        get: (id) => (mirror.get(id) ? { ...mirror.get(id) } : null),
        refresh() {
            refreshCalls++;
            // refresh = 从服务端拉最新：把 serverJobs 灌进镜像
            for (const [id, j] of serverJobs) mirror.set(id, { ...j });
            return { ok: true };
        },
        claim() {
            const cand = [...serverJobs.values()].find((j) => j.state === JOB_STATE.READY);
            if (!cand) return { ok: true, data: { job: null } };
            cand.state = JOB_STATE.CLAIMED;
            return { ok: true, data: { job: { ...cand } } };
        },
        setState(id, state, reason) {
            const j = serverJobs.get(id) ?? mirror.get(id);
            if (j) { j.state = state; if (state === JOB_STATE.PAUSED) j.pausedReason = reason; }
            if (mirror.has(id)) mirror.get(id).state = state;
            return { ok: true, data: { job: j ? { ...j } : null } };
        },
        heartbeat() { return { ok: true }; },
        finish() { return { ok: true }; },
        update() { return { ok: true }; },
    };

    const actions = makeFakeActions();
    actions.state.executing = true;
    actions.state.currentJobId = 'low';
    const runs = [];
    const runSkill = (_a, skill) => { runs.push(skill); return { ok: true, code: 'OK', data: { count: 1, want: 1 } }; };

    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });
    sched.currentJobId = 'low';

    const r = await sched.tick();
    const good = refreshCalls > 0 && runs.includes('collect') && serverJobs.get('low').state === JOB_STATE.PAUSED;
    if (good) {
        okCase('★ 抢占前 refresh：别人的新单能被看见并抢占（镜像不一致的回归）',
            `refreshCalls=${refreshCalls} runs=${runs.join('>')} low=${serverJobs.get('low').state}`);
    } else {
        badCase('★ 抢占前 refresh', { refreshCalls, runs, low: serverJobs.get('low').state, reason: r.reason });
    }
}

// 10c. ★ ctx.reserve 必须真的打到板上（真机缺陷回归）
//   真机验收抓到：调度器自己持有 boardClient，但 `makeCtx(agent)` 是去 agent.board 找板的，
//   而调用方传的 agent 没有 .board → `ctx.reserve()` 静默走 no-board 分支（恒成功 no-op）
//   → jobs 全 done、合计 85，但 **claims 表 0 行**：预约从来没写进库。
//   这条用例断言：调度器跑完一张带 claims 的单，**board.reserve 被调用过**。
{
    const clock = makeClock();
    const reserveCalls = [];
    const board = makeFakeBoard([
        { id: 'j1', state: JOB_STATE.READY, skill: 'mine', args: { count: 2 }, priority: 5,
          claims: ['area:0,64,0:8'] },
    ]);
    // 在假板上挂 reserve/release，记录调用
    // ★ 签名必须和真 `BoardClient.reserve(id, keys)` 一致（owner 是 client 内部自己填的）。
    //   我第一版写成 (id, owner, keys) 三参，于是"keys 里有没有 area:..."这条断言永远假 ——
    //   那是假板写错，不是代码错。
    board.reserve = (id, keys) => { reserveCalls.push({ id, keys }); return { ok: true, reserved: keys, until: clock.now() + 30000 }; };
    board.release = (id, keys) => { reserveCalls.push({ id, op: 'release', keys }); return { ok: true }; };

    const actions = makeFakeActions();
    const { runSkill } = makeRunner({ clock, actions, durations: { steps: 1 } });
    // ★ 关键：传进来的 agent **故意不带 .board**（模拟真实调用方）——
    //   调度器必须自己把板塞进给 makeCtx 的视图里，否则 ctx.reserve 就是空操作。
    const sched = new BoardScheduler({
        agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep,
    });
    await sched.tick();

    const reserved = reserveCalls.filter((c) => !c.op && Array.isArray(c.keys) && c.keys.includes('area:0,64,0:8'));
    if (reserved.length > 0) {
        okCase('★ ctx.reserve 真的打到板上（预约真的写库，不是 no-op）',
            `reserve 调用 ${reserved.length} 次 keys=${JSON.stringify(reserved[0].keys)}`);
    } else {
        badCase('★ ctx.reserve 没打到板上（走了 no-board 分支）', { reserveCalls });
    }
}

// 11. ★ 抢占时旧流程还在跑（killed）→ **绝不开新动作**（高危点①）
{
    const clock = makeClock();
    const board = makeFakeBoard([
        { id: 'low', state: JOB_STATE.CLAIMED, skill: 'mine', args: {}, priority: 3 },
        { id: 'high', state: JOB_STATE.READY, skill: 'collect', args: {}, priority: 9 },
    ]);
    const actions = makeFakeActions();
    actions.state.executing = true;
    const { runSkill, log } = makeRunner({ clock, actions });

    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });
    sched.currentJobId = 'low';
    // 模拟 D18：stop() 等不到退出 → 判 zombie → killed
    actions.state.killed = true;

    const r = await sched.tick();
    const noNewRun = log.runs.length === 0;
    if (!r.acted && r.reason === 'preempt-failed' && noNewRun) {
        okCase('★ 高危点①：killed（旧流程停不下来）→ 绝不开新动作', `runs=${log.runs.length}`);
    } else {
        badCase('★ killed 时不许开新动作', { r, runs: log.runs.length });
    }
}

// 12. ★ INTERRUPTED 在抢占路径上**不计 attempts**（高危点②）
{
    const clock = makeClock();
    const board = makeFakeBoard([
        { id: 'low', state: JOB_STATE.CLAIMED, skill: 'mine', args: {}, priority: 3, attempts: 0 },
        { id: 'high', state: JOB_STATE.READY, skill: 'collect', args: {}, priority: 9 },
    ]);
    const actions = makeFakeActions();
    actions.state.executing = true;
    const { runSkill } = makeRunner({ clock, actions });
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });
    sched.currentJobId = 'low';
    await sched.tick();

    const low = board.jobs.get('low');
    // 关键：调度器**不许**调用 finish 去把 interrupted 变成 "失败重试"
    const finishOnLow = board.calls.some((c) => c.op === 'finish' && c.id === 'low');
    if (low.state === JOB_STATE.PAUSED && low.attempts === 0 && !finishOnLow) {
        okCase('★ 高危点②：抢占走 paused，attempts 保持 0，且不调 finish', `attempts=${low.attempts}`);
    } else {
        badCase('★ 抢占不计 attempts', { state: low.state, attempts: low.attempts, finishOnLow });
    }
}

// 13. 3–5 级不抢（只排队）—— 端到端：低级别单在跑，来了 5 级单，不该抢占
{
    const clock = makeClock();
    const board = makeFakeBoard([
        { id: 'low', state: JOB_STATE.CLAIMED, skill: 'mine', args: {}, priority: 3 },
        { id: 'mid', state: JOB_STATE.READY, skill: 'collect', args: {}, priority: 5 },
    ]);
    const actions = makeFakeActions();
    actions.state.executing = true;
    const { runSkill, log } = makeRunner({ clock, actions });
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });
    sched.currentJobId = 'low';
    const r = await sched.tick();
    if (r.reason === 'busy' && log.runs.length === 0 && board.jobs.get('low').state === JOB_STATE.CLAIMED) {
        okCase('3–5 级不抢只排队（5 级单不打断 3 级单）', `reason=${busyReason(r)}`);
    } else {
        badCase('3–5 级不该抢', { r, runs: log.runs.length, lowState: board.jobs.get('low').state });
    }
}

// 14. requeueStaleBrief 接上了（brief 超时回 ready）
{
    const clock = makeClock();
    const staleAt = clock.now() - BRIEF_REQUEUE_MS - 1000;
    const board = makeFakeBoard([
        { id: 'brief1', state: JOB_STATE.RUNNING, skill: 'mine', args: {}, priority: 3, interrupted: { at: staleAt } },
    ]);
    const actions = makeFakeActions();
    const { runSkill } = makeRunner({ clock, actions });
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board, actions, runSkill, now: clock.now, sleep: clock.sleep });
    sched.setAutoClaim(false);        // ★ 就算自动领单关着，也要收拾残局
    const r = await sched.tick();
    const job = board.jobs.get('brief1');
    if (Array.isArray(r.requeued) && r.requeued.includes('brief1') && job.state === JOB_STATE.READY) {
        okCase('requeueStaleBrief 已接上（brief 超 60s → ready），且 autoClaim 关着也照做', `requeued=${JSON.stringify(r.requeued)}`);
    } else {
        badCase('requeueStaleBrief 未接上', { r, state: job.state });
    }
}

// 15. 没有板时调度器完全空转（不抛）
{
    const clock = makeClock();
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board: null, actions: makeFakeActions(), runSkill: () => ({ ok: true }), now: clock.now, sleep: clock.sleep });
    const r = await sched.tick();
    if (!r.acted && r.reason === 'no-board') okCase('没有任务板 → 空转不抛（无板降级）', r.reason);
    else badCase('无板空转', r);
}

// ══════════════════════════════════════════════════════════════════════════
// t38（清遗留④）：`idle-plan` 事件噪声 —— 只在"结论变了"时播报
//
// 缺陷原貌：`decideIdle()` 末尾是无条件兜底 `{ action: 'idle-mode' }`，
// 调度器拍子是 3 秒，而原来只判 `action !== 'nothing'` 就发 onEvent
// → **完全空闲 2 分钟会发 40 条 idle-plan，全是"我闲着"的心跳**（离线模拟：
// `{"think": 1, "idle-mode": 40}`）。噪声刷满面板/trace，还会把真正的 `need:*` 埋掉。
//
// 修法：调度器记住上一次播报过的 `action:reason`，重复的不再发（纯函数
// `idlePlanEmission()`）；`nothing` 时清记忆，否则"空闲 → 干活 → 再空闲"会漏播。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 跑 N 拍空闲 tick（假时钟，每拍推进 3 秒 = 调度器真实拍子），收集 idle-plan 事件。
 *
 * @param {object} p
 *   ticks        跑几拍
 *   planAt       (i, clock, agent, sched) 每拍**之前**摆状态，决定这一拍 decideIdle 返回什么
 *   forgetMemory true = 每拍把记忆清掉（模拟"改之前没有记忆"的样子，反向验证用）
 */
async function runIdleTicks({ ticks, planAt = null, forgetMemory = false } = {}) {
    const clock = makeClock();
    const board = makeFakeBoard([]);
    const actions = makeFakeActions();
    const agent = { name: 'tester', _lastTalkAt: 0, _lastIdleThinkAt: clock.now(), _idlePaused: false };
    const events = [];
    const { runSkill } = makeRunner({ clock, actions });
    const sched = new BoardScheduler({
        agent, board, actions, runSkill,
        now: clock.now, sleep: clock.sleep,
        onEvent: (e) => events.push(e),
    });
    for (let i = 0; i < ticks; i++) {
        clock.advance(3000);                       // 调度器拍子：agent.js EVERY = 3000
        planAt?.(i, clock, agent, sched);
        await sched.tick();
        if (forgetMemory) sched._lastIdlePlan = null;   // 反向验证：每拍忘掉上一次
    }
    return {
        plans: events.filter((e) => e.type === 'idle-plan'),
        events, clock, agent, sched, board,
        claims: board.calls.filter((c) => c.op === 'claim').length,
    };
}

/** 摆"这一拍 decideIdle 该返回什么"的状态（不改 idle_planner，只喂它的输入）。 */
const idlePreset = {
    // 空闲 + think 刚问过 → 第 3 层发呆
    idleMode: (_i, clock, agent) => { agent._lastIdleThinkAt = clock.now(); agent._lastTalkAt = 0; },
    // 空闲 + think 到点（5 分钟没问过）→ 第 2 层
    think: (_i, clock, agent) => { agent._lastIdleThinkAt = clock.now() - 300_001; agent._lastTalkAt = 0; },
    // 30 秒内说过话 → 不算空闲 → nothing
    nothing: (_i, clock, agent) => { agent._lastTalkAt = clock.now(); },
};

// 16. 重复不再发：连续 3 拍 idle-mode → 只发 1 条
{
    const r = await runIdleTicks({ ticks: 3, planAt: idlePreset.idleMode });
    if (r.plans.length === 1 && r.plans[0].action === 'idle-mode') {
        okCase('t38① 连续 3 拍 idle-mode → 只发 1 条', `plans=${r.plans.length} action=${r.plans[0].action}`);
    } else {
        badCase('t38① 重复的 idle-mode 不该重复播报', r.plans);
    }
}

// 17. 变化要发：idle-mode → think → idle-mode → 3 条（每次变化都发）
{
    const seq = [idlePreset.idleMode, idlePreset.think, idlePreset.idleMode];
    const r = await runIdleTicks({ ticks: 3, planAt: (i, c, a, s) => seq[i]?.(i, c, a, s) });
    const actions = r.plans.map((e) => e.action).join(',');
    if (r.plans.length === 3 && actions === 'idle-mode,think,idle-mode') {
        okCase('t38② idle-mode→think→idle-mode → 发 3 条（变化必发）', `plans=${actions}`);
    } else {
        badCase('t38② 变化应该都发', { plans: actions, count: r.plans.length });
    }
}

// 18. 中间有中断：idle-mode → nothing → idle-mode → 2 条（nothing 清掉了记忆）
{
    const seq = [idlePreset.idleMode, idlePreset.nothing, idlePreset.idleMode];
    const r = await runIdleTicks({ ticks: 3, planAt: (i, c, a, s) => seq[i]?.(i, c, a, s) });
    const actions = r.plans.map((e) => e.action).join(',');
    if (r.plans.length === 2 && actions === 'idle-mode,idle-mode') {
        okCase('t38③ idle-mode→nothing→idle-mode → 发 2 条（nothing 清记忆）', `plans=${actions}`);
    } else {
        badCase('t38③ nothing 必须清掉记忆，否则第二次空闲漏播', { plans: actions, count: r.plans.length });
    }
}

// 19. job / think / nothing 语义不变：该发的照发 1 条，不该发的一条都没有
{
    const oneThink = await runIdleTicks({ ticks: 1, planAt: idlePreset.think });
    const oneIdle = await runIdleTicks({ ticks: 1, planAt: idlePreset.idleMode });
    const oneNothing = await runIdleTicks({ ticks: 1, planAt: idlePreset.nothing });

    // job 走不了端到端（tick 只喂 availableSkills，不喂背包状态），直接测判据本身
    const jobA = { action: 'job', reason: 'need:food-low' };
    const jobB = { action: 'job', reason: 'need:inventory-full' };
    const a1 = idlePlanEmission(jobA, null);
    const a2 = idlePlanEmission(jobB, a1.next);        // 不同的单：不能被当成重复吞掉
    const a3 = idlePlanEmission(jobA, a2.next);        // 回到 jobA：和上一拍不同 → 发

    const good = oneThink.plans.length === 1 && oneThink.plans[0].action === 'think'
        && oneIdle.plans.length === 1 && oneIdle.plans[0].action === 'idle-mode'
        && oneNothing.plans.length === 0
        && a1.emit === true && a2.emit === true && a3.emit === true;
    if (good) {
        okCase('t38④ job/think 语义不变（think 1 条、job 各 1 条、nothing 0 条）',
            `think=${oneThink.plans.length} idle=${oneIdle.plans.length} nothing=${oneNothing.plans.length} job 连发=${a1.emit},${a2.emit},${a3.emit}`);
    } else {
        badCase('t38④ job/think 行为被改动', {
            think: oneThink.plans, idle: oneIdle.plans, nothing: oneNothing.plans,
            job: [a1.emit, a2.emit, a3.emit],
        });
    }
}

// 20. ★ 反向验证：把"记忆"去掉（每拍清空）→ 用例①的断言必须变红
{
    const r = await runIdleTicks({ ticks: 3, planAt: idlePreset.idleMode, forgetMemory: true });
    const case1WouldFail = r.plans.length !== 1;       // 用例①要求 ==1，这里是 3 → 变红
    if (r.plans.length === 3 && case1WouldFail) {
        okCase('t38⑤ 反向验证：去掉记忆后 3 拍发 3 条（用例①会变红）', `plans=${r.plans.length}`);
    } else {
        badCase('t38⑤ 反向验证失败：去掉记忆也没多播 → 用例①形同虚设', { plans: r.plans.length });
    }
}

// 21. 2 分钟完全空闲：改前 40 条 idle-plan（3 秒一拍），改后 1 条
{
    const before = await runIdleTicks({ ticks: 40, planAt: idlePreset.idleMode, forgetMemory: true });
    const after = await runIdleTicks({ ticks: 40, planAt: idlePreset.idleMode });
    const good = before.plans.length === 40 && after.plans.length === 1
        && before.claims === 40 && after.claims === 40;   // 拍子照跑，只是不再刷事件
    if (good) {
        okCase('t38⑥ 120 秒空闲：idle-plan 40 条 → 1 条（claim 拍数不变）',
            `改前=${before.plans.length} 改后=${after.plans.length} claims=${after.claims}`);
    } else {
        badCase('t38⑥ 120 秒空闲噪声未收敛', { before: before.plans.length, after: after.plans.length, claims: after.claims });
    }
}

// 22. 同一窗口把 think 那一拍也算进去（真 decideIdle 的 41 拍：think 1 + idle-mode 40）
//     → 改前 41 条，改后 2 条（think 那条照发，语义不变）
{
    const warm = (i, c, a) => (i === 0 ? idlePreset.think : idlePreset.idleMode)(i, c, a);
    const before = await runIdleTicks({ ticks: 41, planAt: warm, forgetMemory: true });
    const after = await runIdleTicks({ ticks: 41, planAt: warm });
    const beforeMix = before.plans.map((e) => e.action).join(',');
    const afterMix = after.plans.map((e) => e.action).join(',');
    const good = before.plans.length === 41 && after.plans.length === 2
        && afterMix === 'think,idle-mode' && beforeMix.startsWith('think,idle-mode');
    if (good) {
        okCase('t38⑥b 41 拍（think 1 + idle-mode 40）：41 条 → 2 条（think 照发）',
            `改前=${before.plans.length} 改后=${afterMix}`);
    } else {
        badCase('t38⑥b think 那一拍的语义', { before: beforeMix, after: afterMix });
    }
}

// 23. 干活回来第一次空闲仍要播报（记忆不能跨过"根本没判空闲"的那几拍）
{
    const clock = makeClock();
    const board = makeFakeBoard([]);
    const actions = makeFakeActions();
    const agent = { name: 'tester', _lastTalkAt: 0, _lastIdleThinkAt: clock.now(), _idlePaused: false };
    const plans = [];
    const { runSkill } = makeRunner({ clock, actions });
    const sched = new BoardScheduler({
        agent, board, actions, runSkill,
        now: clock.now, sleep: clock.sleep,
        onEvent: (e) => { if (e.type === 'idle-plan') plans.push(e); },
    });

    clock.advance(3000);
    await sched.tick();                                   // 第 1 拍：空闲 → 播 1 条
    // 第 2 拍：来了一张单 → 领单/跑单，**这一拍根本没走到空闲判定**
    board.jobs.set('j1', { id: 'j1', state: JOB_STATE.READY, skill: 'mine', args: {}, priority: 5 });
    clock.advance(3000);
    await sched.tick();
    const ranJob = board.jobs.get('j1')?.state === JOB_STATE.DONE;
    // 第 3 拍：又空闲了 → 必须再播 1 条（拿上次的记忆吞掉它 = 丢信息）
    clock.advance(3000);
    await sched.tick();

    if (ranJob && plans.length === 2 && plans.every((e) => e.action === 'idle-mode')) {
        okCase('t38⑦ 干完活回来第一次空闲仍播报（记忆不跨过"没判空闲"的拍）', `plans=${plans.length}`);
    } else {
        badCase('t38⑦ 记忆跨过了干活那一拍 → 回来那条被吞', { ranJob, plans: plans.map((e) => e.action) });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// t39（清遗留⑤）：idle_planner 第 1 层的 5 个状态字段 —— 原来一个都没传
//
// 缺陷原貌：调度器只传了 `state: { availableSkills }`，而 `planNeeds()` 要
// `inventoryFull / hasBasicTool / nightFalling / nearShelter / foodCount`
// → 恒返回 null → **第 1 层四条分支（store/obtain/shelter/food）全是死分支**。
// 修法：`readIdleState(agent)` 现算现传（三态：读不到传 null，绝不传 false）。
// ══════════════════════════════════════════════════════════════════════════

/** 食物表（真 minecraft-data 的 foodsByName 形状，只留测试要用的几种）。 */
const TEST_FOODS = { bread: { foodPoints: 5 }, cooked_beef: { foodPoints: 8 }, apple: { foodPoints: 4 } };

/**
 * 假 bot（只做 t39 要的那几个内存读）。
 *
 * @param {object} o
 *   items        背包物品 [{name,count}]
 *   emptySlots   inventory.emptySlotCount() 的结果
 *   timeOfDay    bot.time.timeOfDay（1000 = 白天，14000 = 夜里）
 *   overhead     头顶 dy=2,3,4,5 的方块名（undefined 元素 = 未加载 → blockAt 返回 null）
 *   noInventoryItems  故意不给 inventory.items（模拟"背包读不到"）
 *   foods        registry.foodsByName；null = 没这张表（数不清食物）
 */
function makeIdleBot({
    items = [], emptySlots = 20, timeOfDay = 1000,
    overhead = ['air', 'air', 'air', 'air'], foods = TEST_FOODS,
    noInventoryItems = false, noInventory = false,
} = {}) {
    const bot = {
        entity: { position: { x: 0, y: 64, z: 0 } },
        time: { timeOfDay },
        registry: foods === null ? {} : { foodsByName: foods },
        blockAt: ({ y }) => {
            const name = (overhead ?? [])[y - 66];        // dy=2 → 下标 0
            return name === undefined ? null : { name };
        },
    };
    if (!noInventory) {
        bot.inventory = {
            emptySlotCount: () => emptySlots,
            items: noInventoryItems ? undefined : () => items,
        };
    }
    return bot;
}

/** 真 readIdleState：把假 bot 塞进 agent，看 5 个字段各算出什么。 */
const stateOf = (bot) => readIdleState({ bot });

/**
 * 跑**一拍真 tick**（生产路径：claim 不到单 → idleTick → readIdleState → planNeeds）。
 * @returns {Promise<{plan, jobs, sched, events}>} plan = 那条 idle-plan 事件
 */
async function tickIdle({ bot, availableSkills = null, reader = null } = {}) {
    const clock = makeClock();
    const board = makeFakeBoard([]);
    const actions = makeFakeActions();
    const agent = { name: 'tester', bot, _lastTalkAt: 0, _lastIdleThinkAt: clock.now(), _idlePaused: false };
    const events = [];
    const { runSkill } = makeRunner({ clock, actions });
    const deps = {
        agent, board, actions, runSkill,
        now: clock.now, sleep: clock.sleep,
        onEvent: (e) => events.push(e),
    };
    if (availableSkills) deps.availableSkills = availableSkills;
    if (reader) deps.readIdleState = reader;         // 反向验证用：模拟"某个字段没传"
    const sched = new BoardScheduler(deps);
    clock.advance(3000);
    await sched.tick();
    return {
        plan: events.find((e) => e.type === 'idle-plan') ?? null,
        jobs: [...board.jobs.values()],
        sched, events,
    };
}

// 24. 生产 deps + 背包满 → store / need:inventory-full
//     「满」的判据 = emptySlotCount() === 0（留 1 格不算满）
{
    const r = await tickIdle({ bot: makeIdleBot({ emptySlots: 0, items: [{ name: 'cobblestone', count: 64 }] }) });
    const job = r.jobs[0] ?? null;
    if (r.plan?.action === 'job' && r.plan?.reason === 'need:inventory-full'
        && job?.skill === 'store' && job?.source === 'self' && job?.priority === 1) {
        okCase('t39① 背包满（0 空位）→ job/store，且任务板真有这张单',
            `reason=${r.plan.reason} skill=${job.skill} state=${job.state}`);
    } else {
        badCase('t39① 背包满没触发 store（第 1 层死分支？）', { plan: r.plan, job });
    }
}

// 25. 生产 deps + 没基本工具 → obtain / need:no-basic-tool
{
    const r = await tickIdle({ bot: makeIdleBot({ items: [{ name: 'oak_log', count: 3 }] }) });
    const job = r.jobs[0] ?? null;
    if (r.plan?.action === 'job' && r.plan?.reason === 'need:no-basic-tool' && job?.skill === 'obtain') {
        okCase('t39② 只有木棍木头、没有镐 → job/obtain', `reason=${r.plan.reason} skill=${job.skill}`);
    } else {
        badCase('t39② 没基本工具没触发 obtain', { plan: r.plan, job });
    }
}

// 26. 生产 deps + 天黑 + 头顶无遮蔽 → shelter / need:night-no-shelter
{
    const r = await tickIdle({
        bot: makeIdleBot({ items: [{ name: 'stone_pickaxe', count: 1 }], timeOfDay: 14000, overhead: ['air', 'air', 'air', 'air'] }),
    });
    const job = r.jobs[0] ?? null;
    if (r.plan?.action === 'job' && r.plan?.reason === 'need:night-no-shelter' && job?.skill === 'shelter') {
        okCase('t39③ 天黑(timeOfDay=14000) + 头顶4格全空 → job/shelter', `reason=${r.plan.reason} skill=${job.skill}`);
    } else {
        badCase('t39③ 天黑没遮蔽没触发 shelter', { plan: r.plan, job });
    }
}

// 27. 生产 deps + 食物 3 → food / need:food-low
//     ⚠️ 注册表里没有 `food` 这个流程（只有 `eat`），所以这里显式注入 availableSkills；
//        生产里这条分支仍会停在 `have.has('food')` —— 见报告里的「遗留」一条。
{
    const r = await tickIdle({
        bot: makeIdleBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 3 }] }),
        availableSkills: ['store', 'obtain', 'shelter', 'eat'],   // ★ t59：注册名是 eat
    });
    const job = r.jobs[0] ?? null;
    if (r.plan?.action === 'job' && r.plan?.reason === 'need:food-low' && job?.skill === 'eat') {
        okCase('t39④ 食物 3（< 5）→ job/food', `reason=${r.plan.reason} skill=${job.skill}`);
    } else {
        badCase('t39④ 食物少没触发 food', { plan: r.plan, job });
    }
}

// 28. ★ 三态安全：读不到 → null → **不触发**（绝不许写 false 误派活）
{
    // (a) hasBasicTool 读不到（inventory.items 不存在）→ 不触发 obtain
    const noItems = await tickIdle({ bot: makeIdleBot({ noInventoryItems: true }) });
    const stA = stateOf(makeIdleBot({ noInventoryItems: true }));
    const aOk = stA.hasBasicTool === null && stA.foodCount === null
        && noItems.plan?.action !== 'job' && !/no-basic-tool/.test(String(noItems.plan?.reason ?? ''));

    // (b) nearShelter 读不到（头顶未加载）→ 天黑也不触发 shelter
    // ★ t59：这个 bot 原来**没有食物** → foodCount=0 → 现在 `eat` 注册了，
    //   "缺吃的"会正确触发 need:food-low，于是 `action !== 'job'` 这条断言失败。
    //   但本用例要验的是"nearShelter 读不到不触发 **shelter**"，不是"任何单都不下"。
    //   所以给足食物，让 food 分支不干扰 —— 否则这条断言分不清"没触发 shelter"和"没触发任何单"。
    const noSky = await tickIdle({
        bot: makeIdleBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 8 }], timeOfDay: 14000, overhead: [undefined, undefined, undefined, undefined] }),
    });
    const stB = stateOf(makeIdleBot({ items: [{ name: 'stone_pickaxe', count: 1 }], timeOfDay: 14000, overhead: [undefined] }));
    const bOk = stB.nearShelter === null && stB.nightFalling === true
        && noSky.plan?.action !== 'job' && !/night-no-shelter/.test(String(noSky.plan?.reason ?? ''));

    // (c) foodCount 读不到（没有 registry.foodsByName）→ 不触发 food
    const noFoods = await tickIdle({
        bot: makeIdleBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 1 }], foods: null }),
        availableSkills: ['eat'],   // ★ t59：注册名是 eat
    });
    const stC = stateOf(makeIdleBot({ items: [{ name: 'bread', count: 1 }], foods: null }));
    const cOk = stC.foodCount === null && noFoods.plan?.action !== 'job' && !/food-low/.test(String(noFoods.plan?.reason ?? ''));

    if (aOk && bOk && cOk) {
        okCase('t39⑤ 三态安全：三处「读不到」都传 null，都没误触发',
            `hasBasicTool=${stA.hasBasicTool} nearShelter=${stB.nearShelter} foodCount=${stC.foodCount}`);
    } else {
        badCase('t39⑤ 读不到被当成 false 了（会误派活）', {
            hasBasicTool: stA.hasBasicTool, aPlan: noItems.plan,
            nearShelter: stB.nearShelter, bPlan: noSky.plan,
            foodCount: stC.foodCount, cPlan: noFoods.plan,
        });
    }
}

// 29. ★ 反向验证：把字段改回"不传"（这里用空的对象代替 readIdleState）→ ①②③④ 必须全军覆没
{
    const bot = makeIdleBot({ emptySlots: 0, items: [{ name: 'cobblestone', count: 64 }] });
    const noState = await tickIdle({ bot, reader: () => ({}) });
    // 上面四条用例的判据（action==='job' 且 reason==='need:*'）在这里必须**不成立**
    const wouldFail = noState.plan?.action !== 'job' && !/^need:/.test(String(noState.plan?.reason ?? ''))
        && noState.jobs.length === 0;
    if (wouldFail) {
        okCase('t39⑥ 反向验证：不传字段 → 退回 idle-mode、一张单都不下（①②③④会变红）',
            `action=${noState.plan?.action} reason=${noState.plan?.reason} jobs=${noState.jobs.length}`);
    } else {
        badCase('t39⑥ 反向验证失败：不传字段居然还能命中第 1 层 → 用例形同虚设', { plan: noState.plan, jobs: noState.jobs.length });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑧ ★★ t68：**假件忠实度**（t39 的 nearShelter 用**真 mineflayer 形态**复测）
//
//   上面 t39③ 用的是本文件的宽松假件 `makeIdleBot`（`blockAt` 收裸对象），
//   于是 `readOverheadShelter` 里那句
//       `bot.blockAt({ x: fx, y: fy + dy, z: fz })`
//   看起来是好的。但**真 mineflayer 会 `pos.floored()`**（prismarine-world
//   `world.js:229`）→ 裸对象 TypeError → 被 `safeField` 的 catch 吞成 null
//   → **生产里 nearShelter 恒为 null → shelter 分支永远不触发**（和 t70 同一类）。
//
//   本用例换成共享严格件复现"生产真实形态"：头顶有石头盖时，nearShelter 必须是 true。
//   当前实现会回 null → 记为 **XFAIL(已知bug)**（指纹 = nearShelter === null）。
//   修法（等 captain 批，只改 src 那一行）：包成 Vec3 或用 `query_perceive.readBlock`。
//     · 指纹在 → XFAIL（已知，不判红）
//     · 开始返回 true/false → XPASS，提醒把本条改成硬断言
//     · 返回别的怪值 → 真 FAIL（新问题不许吞）
// ══════════════════════════════════════════════════════════════════════════
{
    // 头顶 dy=2..5 全是石头 = 在洞里/屋里 → 语义上就是"有遮蔽"
    const roofed = makeFakeBot({
        world: worldOf([[0, 66, 0, 'stone'], [0, 67, 0, 'stone'], [0, 68, 0, 'stone'], [0, 69, 0, 'stone']]),
        feet: { x: 0, y: 64, z: 0 },
        registry: { foodsByName: {} },
    });
    const st = readIdleState({ bot: roofed });
    // ★ 2026-11-04（captain）：**"露天"必须显式铺空气，不能用空世界。**
    //   空世界 = 那些格"没加载" → `readOverheadShelter` 正确地返回 null（"没加载就不猜"）。
    //   要测"露天"就得让探针那几个格真的是 air（`dy=2..5`，与 SHELTER_PROBE_DY 对齐）。
    const OPEN = makeFakeBot({
        world: worldOf([[0, 66, 0, 'air'], [0, 67, 0, 'air'], [0, 68, 0, 'air'], [0, 69, 0, 'air']]),
        feet: { x: 0, y: 64, z: 0 },
        registry: { foodsByName: {} },
    });
    const stOpen = readIdleState({ bot: OPEN });

    const roofOk = st.nearShelter === true;
    const openOk = stOpen.nearShelter === false;
    if (roofOk && openOk) {
        pass++;
        // ★ 已由 t73 修好（`readOverheadShelter` 改传 Vec3），本条转**硬断言**：
        //   以后谁再把它写回裸对象，`roofOk` 会变 false → 直接红（不再被 xfail 兜住）。
        console.log(`PASS ⑧ ★ nearShelter 在真 mineflayer 形态下可用（屋顶=true 露天=false）`);
    } else if (false && st.nearShelter === null && stOpen.nearShelter === null) {
        console.log(`XFAIL(已知bug) ⑧ 假件忠实度：nearShelter 在真 mineflayer 形态下**恒为 null**`
            + `（board_scheduler.js:206 传裸对象 → 真机 TypeError → 被吞成 null → shelter 分支永不触发）`);
        console.log(`       —— 已报 captain（与 t70 同族）。修好后本条会打 XPASS`);
    } else {
        badCase('⑧ 假件忠实度：nearShelter 形态不符（须重判）', { roofed: st.nearShelter, open: stOpen.nearShelter });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑨ ★★ t76：「第 5 跳」—— 调度器调 `finish` 时必须把 `result.data` 一起传下去
//
//   今晚 `data` 为 null 修了 5 次（t89/t92/t95/t105/t109）。真正的链路是四跳：
//     act_craft.data → flow_craft（转发）→ **scheduler（这里，最容易漏）**
//     → board_client → board_server → board_store.finish（存）
//   这条守卫盯的就是"调度器重新组装对象时把 data 丢掉"这个动作。
// ══════════════════════════════════════════════════════════════════════════
{
    const clock = makeClock();
    const board = makeFakeBoard([{ id: 'j-data', state: JOB_STATE.READY, skill: 'mine', args: { count: 3 }, priority: 5 }]);
    const actions = makeFakeActions();
    // runner 返回**带 data 的失败**（模拟 act/flow 层把 diag 带上来）
    const runSkill = () => ({
        ok: false, code: 'NO_ITEM', message: '料不够',
        data: { inv: { a: 1 }, limit: 2, got: 0 },
    });
    const sched = new BoardScheduler({
        agent: { name: 'tester' }, board, actions, runSkill,
        now: clock.now, sleep: clock.sleep,
    });
    await sched.tick();

    const fin = board.calls.filter((c) => c.op === 'finish').pop();
    const d = fin?.result?.data ?? null;
    if (!!fin && !!d && d.inv?.a === 1 && d.limit === 2 && d.got === 0) {
        okCase('★ t76 调度器把 result.data 传进 finish（第 5 跳不丢字段）',
            `finish.data=${JSON.stringify(d)}`);
    } else {
        badCase('t76 调度器丢了 result.data（第 5 跳）', { finish: fin ?? null });
    }

    if (fin?.result?.code === 'NO_ITEM' && fin?.result?.message === '料不够') {
        okCase('★ t76 调度器同时保留 code/message', `code=${fin.result.code}`);
    } else {
        badCase('t76 调度器丢了 code/message', { finish: fin ?? null });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑩ ★★★ A5-8（S2，第四轮审计 §6.5）：**心跳不看停止标志 → paused 单仍续租**
//
// ★ 下面这段的假件与用例写成"async 但内部不 await"（与本文件既有假件同一风格：
//   `claim/setState/heartbeat/finish` 都返回 Promise 形状），
//   `require-await` 在这个文件里本来就是**基线内**的老问题，本段**不新增** lint 债，
//   所以只在本段范围内关掉这条规则（结束后立刻 eslint-enable）。
//
//   病根（审计原文）：
//     · `board_scheduler.js` 的 `setInterval` 心跳只看 `_runJob` 有没有走完 finally，
//       **完全不看**停止/paused 状态 ⇒ 单子已 `paused`，租约仍归自己；
//     · `board_client.heartbeat()` 同样无条件发 `board:heartbeat`。
//     · 而 `_runJob` 卡住的最长来源是 30 分钟模型调用 / 10 分钟动作超时
//       ⇒ 别的 bot **直到进程被杀都拿不到这张单**（多 bot 下的软死锁）。
//
//   本节的判据（不靠"看起来对"，全部数**调用次数**与**库里的字段**）：
//     ① 暂停后心跳次数**不再增长**（`board.heartbeat` 调用计数）；
//     ② 停手时**主动释放**租约（`update` 里带 lease_owner/lease_until = null）与预约；
//     ③ 「暂停（可恢复）」≠「取消（释放）」：paused 单**留在 paused**、不被 finish 推回 ready；
//     ④ 停租之后租约**真的会到期** → `expireLeases` 那套判据把它回收成 ready + 清 assignee
//        ⇒ 别的 bot 能领到（这条正是审计要的"租约到期被回收"）。
// ══════════════════════════════════════════════════════════════════════════

const LEASE_TEST_MS = 30000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (fn()) return true;
        await realSleep(5);
    }
    return false;
};

/**
 * 带**租约语义**的假板：心跳真的把 `lease.until` 往前推，
 * 并且能模拟 store 的 `expireLeases` 判据（过期 → ready + 清 assignee + attempts+1）。
 *
 * 为什么要这一份而不是复用上面的 `makeFakeBoard`：那条判据（"到期被回收"）
 * 必须靠**时间 + 租约字段**才证得出来，光数调用次数证明不了。
 */
function makeLeaseBoard(initialJobs = []) {
    const jobs = new Map(initialJobs.map((j) => [j.id, {
        assignee: null, attempts: 0, lease: { owner: null, until: null }, ...j,
    }]));
    const calls = [];
    const api = {
        jobs,
        calls,
        heartbeatCount(id) { return calls.filter((c) => c.op === 'heartbeat' && c.id === id).length; },
        list(filter = {}) {
            const states = filter.states ?? null;
            return [...jobs.values()].filter((j) => !states || states.includes(j.state)).map((j) => ({ ...j }));
        },
        get(id) { const j = jobs.get(id); return j ? { ...j } : null; },
        getAsync(id) {
            calls.push({ op: 'getAsync', id });
            const j = jobs.get(id);
            return { ok: true, data: { job: j ? { ...j } : null } };
        },
        claim() {
            calls.push({ op: 'claim' });
            const cand = [...jobs.values()]
                .filter((j) => j.state === JOB_STATE.READY)
                .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
            if (!cand) return { ok: true, data: { job: null } };
            cand.state = JOB_STATE.CLAIMED;
            cand.assignee = 'tester';
            cand.lease = { owner: 'tester', until: Date.now() + LEASE_TEST_MS };
            return { ok: true, data: { job: { ...cand } } };
        },
        heartbeat(id) {
            calls.push({ op: 'heartbeat', id });
            const j = jobs.get(id);
            if (!j) return { ok: false, code: 'NO_TARGET' };
            if (j.lease?.owner !== 'tester') return { ok: false, code: 'LEASE_LOST' };
            j.lease = { owner: 'tester', until: Date.now() + LEASE_TEST_MS };   // ← 续租
            if (j.state === JOB_STATE.CLAIMED) j.state = JOB_STATE.RUNNING;
            return { ok: true, data: { job: { ...j } } };
        },
        setState(id, state) {
            const j = jobs.get(id);
            if (!j) return { ok: false, code: 'NO_TARGET' };
            j.state = state;
            if ([JOB_STATE.READY, JOB_STATE.PAUSED, JOB_STATE.CANCELLED, JOB_STATE.BLOCKED].includes(state)) {
                j.lease = { owner: null, until: null };
            }
            return { ok: true, data: { job: { ...j } } };
        },
        update(id, patch) {
            calls.push({ op: 'update', id, patch });
            const j = jobs.get(id);
            if (!j || !patch) return { ok: true };
            // ★ 与 store 的 PATCHABLE 对齐：`lease_owner/lease_until` 是**两个列**，
            //   而本假板把租约装在一个 `lease` 对象里 —— 不映射就等于"update 没生效"，
            //   会用例自己把自己判红（那不是 bug，是假件不忠实）。
            for (const [k, v] of Object.entries(patch)) {
                if (k === 'lease_owner') { j.lease = { ...(j.lease ?? {}), owner: v }; continue; }
                if (k === 'lease_until') { j.lease = { ...(j.lease ?? {}), until: v }; continue; }
                j[k] = v;
            }
            return { ok: true };
        },
        finish(id, result) {
            calls.push({ op: 'finish', id, result });
            const j = jobs.get(id);
            if (j) { j.state = JOB_STATE.READY; j.result = result; }
            return { ok: true, data: { next: JOB_STATE.READY } };
        },
        add(job) {
            const id = job?.id ?? `auto${jobs.size + 1}`;
            jobs.set(id, { assignee: null, attempts: 0, lease: { owner: null, until: null }, ...job, id, state: JOB_STATE.READY });
            return { ok: true, data: { job: { ...jobs.get(id) } } };
        },
        refresh() { return { ok: true }; },
        checkpoint() { return { ok: true }; },
        /** store `expireLeases` 的判据（board_store.js:1064 那一套的最小复刻）。 */
        expire(now = Date.now()) {
            const out = [];
            for (const j of jobs.values()) {
                if (!j.lease?.until || j.lease.until >= now) continue;
                if (![JOB_STATE.CLAIMED, JOB_STATE.RUNNING, JOB_STATE.PAUSED].includes(j.state)) continue;
                j.state = JOB_STATE.READY;
                j.assignee = null;
                j.lease = { owner: null, until: null };
                j.attempts = (j.attempts ?? 0) + 1;
                out.push(j.id);
            }
            return out;
        },
    };
    return api;
}

/** 会**真的**跑一会儿的流程（真实 sleep，好让心跳定时器真的跳起来）。 */
function makeSlowRunner(actions, { stepMs = 10, steps = 60 } = {}) {
    return async () => {
        actions.state.executing = true;
        try {
            for (let i = 0; i < steps; i++) {
                await realSleep(stepMs);
                const sr = actions.state.stopReason;
                if (sr && sr !== STOP_REASONS.BRIEF) {
                    return { ok: false, code: 'INTERRUPTED', data: { count: i, want: steps } };
                }
            }
            return { ok: true, code: 'OK', data: { count: steps, want: steps } };
        } finally {
            actions.state.executing = false;
        }
    };
}

/**
 * 现场：一张在跑的慢单 + 极短心跳间隔（10ms），并在跑单中途执行 `midway`
 * （模拟"玩家按停 / 被取消"，口径与 `control.applyStop` 一致：写库 + 记停止原因）。
 */
async function runSlowScene({ midway, stepMs = 10, steps = 60 } = {}) {
    const board = makeLeaseBoard([{ id: 'j-a58', state: JOB_STATE.READY, skill: 'mine', args: {}, priority: 5 }]);
    const actions = makeFakeActions();
    const runner = makeSlowRunner(actions, { stepMs, steps });
    const sched = new BoardScheduler({
        agent: { name: 'tester' }, board, actions, runSkill: runner,
        now: () => Date.now(), sleep: realSleep, heartbeatMs: 10,
    });
    const tickP = sched.tick();                       // 不 await：让它真的跑起来
    await waitUntil(() => board.heartbeatCount('j-a58') >= 2, 2000);
    const hbBefore = board.heartbeatCount('j-a58');
    const releaseBefore = board.calls.filter((c) => c.op === 'update').length;
    await midway({ board, actions, sched, job: board.get('j-a58') });
    await realSleep(120);                              // 给"如果不修"的心跳足够拍数（≥10 拍）
    const hbAfter = board.heartbeatCount('j-a58');
    const leasePatch = board.calls.filter((c) => c.op === 'update'
        && c.patch && 'lease_owner' in c.patch && c.patch.lease_owner === null).pop() ?? null;
    await tickP;
    return { board, actions, sched, hbBefore, hbAfter, leasePatch, releaseBefore };
}

// ⑩-① 暂停（可恢复）：心跳停 + 主动摘租约 + 单留在 paused（不被 finish 推回 ready）
{
    const s = await runSlowScene({
        midway: async ({ board, actions, job }) => {
            // `!stop` 的真实链路：control.applyStop → board.update(patch{state:'paused'})
            await board.update(job.id, {
                state: JOB_STATE.PAUSED,
                result: { code: 'INTERRUPTED' },
                checkpoint: { ...(job.checkpoint ?? {}), pausedReason: 'player' },
            });
            actions.state.stopReason = STOP_REASONS.PLAYER;
            await actions.stop(STOP_REASONS.PLAYER);
        },
    });
    const job = s.board.get('j-a58');
    const noMoreRenew = s.hbAfter === s.hbBefore;
    const pausedKept = job.state === JOB_STATE.PAUSED
        && job.checkpoint?.pausedReason === 'player';
    const finished = s.board.calls.some((c) => c.op === 'finish');
    if (noMoreRenew && s.leasePatch && pausedKept && !finished) {
        okCase('★ ⑩-① paused 后**不再续租**（心跳计数停住）+ 主动摘租约 + 单留在 paused 不被 finish',
            `心跳 ${s.hbBefore} → ${s.hbAfter} 拍；lease 已摘=${!!s.leasePatch}；state=${job.state}`);
    } else {
        badCase('⑩-① 暂停后仍在续租 / 没摘租约 / 单被推回 ready（A5-8 回归）', {
            hbBefore: s.hbBefore, hbAfter: s.hbAfter, leasePatch: s.leasePatch,
            state: job.state, finished,
        });
    }
}

// ⑩-② 租约到期被回收：停租之后没人续 → `expireLeases` 判据把它回收成 ready + 清 assignee
{
    const s = await runSlowScene({
        midway: async ({ board, actions, job }) => {
            await board.update(job.id, { state: JOB_STATE.PAUSED });
            actions.state.stopReason = STOP_REASONS.PLAYER;
            await actions.stop(STOP_REASONS.PLAYER);
        },
    });
    const job = s.board.get('j-a58');
    // ① 修复后：停租那一刻租约已经被**主动摘掉**（不留僵尸租约给任何人）
    const leaseCleared = job.lease?.owner == null && job.lease?.until == null;
    // ② 再模拟"如果没主动摘"的那半条：把 until 回填成过去时间，
    //    证明回收判据确实认这个字段 —— 即"不再续租 → 到期 → 回收 → 别人能领"这条链成立。
    s.board.jobs.get('j-a58').lease = { owner: 'tester', until: Date.now() - 1 };
    s.board.jobs.get('j-a58').state = JOB_STATE.PAUSED;
    s.board.jobs.get('j-a58').assignee = 'tester';
    const reclaimed = s.board.expire(Date.now());
    const after = s.board.get('j-a58');
    // ③ 回收之后别的 bot 能不能领到（假板的 claim 按 ready 挑，等价于 store 的候选条件）
    const nextClaim = await s.board.claim();
    const claimedByOther = nextClaim?.data?.job?.id === 'j-a58';
    if (leaseCleared && reclaimed.includes('j-a58')
        && after.state === JOB_STATE.READY && after.assignee == null
        && after.attempts === 1 && claimedByOther) {
        okCase('★ ⑩-② 停租后租约到期被回收：ready + assignee 清空 + attempts+1 → 别的 bot 能领到',
            `reclaimed=${reclaimed.join(',')} state=${after.state} attempts=${after.attempts}`);
    } else {
        badCase('⑩-② 到期回收链路不通（别人永远拿不到这张单）', {
            leaseCleared, reclaimed, state: after.state, assignee: after.assignee,
            attempts: after.attempts, claimedByOther,
        });
    }
}

// ⑩-③ 「取消（释放）」≠「暂停（可恢复）」：取消后同样停租，且单子**不会**被 resume 回队列
{
    // ★ 注意：`control.JOB_STATE` 只有 ready/claimed/running/paused/failed 五个；
    //   `cancelled` 属于 **board_store.JOB_STATE** 那张全表 —— 这里直接用字面值，
    //   否则 `JOB_STATE.CANCELLED` 是 undefined，用例会自己造出"没有状态"的假现场。
    const CANCELLED = 'cancelled';
    const s = await runSlowScene({
        midway: async ({ board, actions, job }) => {
            await board.update(job.id, { state: CANCELLED });
            actions.state.stopReason = STOP_REASONS.PLAYER;
            await actions.stop(STOP_REASONS.PLAYER);
        },
    });
    const job = s.board.get('j-a58');
    const noMoreRenew = s.hbAfter === s.hbBefore;
    const cancelledKept = job.state === CANCELLED;
    const finished = s.board.calls.some((c) => c.op === 'finish');
    if (noMoreRenew && s.leasePatch && cancelledKept && !finished) {
        okCase('★ ⑩-③ 取消（cancelled）同样停租 + 释放，且状态保持 cancelled（不被 finish/resume 复活）',
            `心跳 ${s.hbBefore} → ${s.hbAfter} 拍；state=${job.state}`);
    } else {
        badCase('⑩-③ 取消后仍续租 / 状态被复活', {
            hbBefore: s.hbBefore, hbAfter: s.hbAfter, state: job.state, finished,
            leasePatch: s.leasePatch,
            updates: s.board.calls.filter((c) => c.op === 'update').map((c) => c.patch),
        });
    }
}

// ⑩-④ 显式 `sched.stop()`（进程退出 / 死亡）：不领新单、不再续租
{
    const board = makeLeaseBoard([{ id: 'j-stop', state: JOB_STATE.READY, skill: 'mine', args: {}, priority: 5 }]);
    const actions = makeFakeActions();
    const sched = new BoardScheduler({
        agent: { name: 'tester' }, board, actions, runSkill: makeSlowRunner(actions),
        now: () => Date.now(), sleep: realSleep, heartbeatMs: 10,
    });
    sched.stop(STOP_REASONS.SHUTDOWN);
    const r = await sched.tick();
    const claimed = board.calls.some((c) => c.op === 'claim');
    if (r.reason === 'stopped' && !claimed && sched.stopped === true) {
        okCase('★ ⑩-④ `stop(shutdown)` 后 tick 直接返回 stopped（不领新单、不 resume）', `reason=${r.reason}`);
    } else {
        badCase('⑩-④ 停止后调度器照领新单', { r, claimed, stopped: sched.stopped });
    }
}

// ⑩-⑤ 客户端那半边：`board_client.heartbeat()` 停了就**一次网络都不发**
{
    const sent = [];
    const socket = {
        on() { /* 不需要服务端推 */ },
        emit(event, payload, ack) {
            sent.push({ event, payload });
            if (event === 'board:set-state') {
                // 服务端把 paused 单的租约清掉（store: setState 的 clearLease）
                ack?.({ ok: true, data: { job: { id: payload.id, state: payload.state, lease: { owner: null, until: null } } } });
                return;
            }
            ack?.({ ok: true, data: { job: { id: payload.id, state: 'running', lease: { owner: 'tester', until: Date.now() + 30000 } } } });
        },
    };
    const client = new BoardClient({ socket, name: 'tester', timeoutMs: 50 });
    const hbEvents = () => sent.filter((s) => s.event === 'board:heartbeat').length;

    // 先证明"没停时会发"（否则下面那条只是空过）
    const before = await client.heartbeat('j-c1', { count: 1, want: 4 });
    const sentBefore = hbEvents();

    // 自己发起的暂停（setState）→ 之后一次都不许发
    await client.setState('j-c1', 'paused', 'player');
    const pausedHb = await client.heartbeat('j-c1', { count: 2, want: 4 });
    const sentAfterPause = hbEvents();

    // applyStop 那条链路（update 带 state:'paused'）也要拦住
    const client2 = new BoardClient({ socket, name: 'tester', timeoutMs: 50 });
    await client2.update('j-c2', { state: 'paused', checkpoint: { pausedReason: 'player' } });
    const updHb = await client2.heartbeat('j-c2', { count: 1, want: 2 });
    const sentAfterUpdate = hbEvents();

    // 整端停止
    client2.stop('shutdown');
    const stoppedHb = await client2.heartbeat('j-c3', null);
    const sentAfterStop = hbEvents();

    const good = before.ok === true && sentBefore === 1
        && pausedHb.ok === false && pausedHb.code === 'HEARTBEAT_SKIPPED' && sentAfterPause === sentBefore
        && updHb.ok === false && updHb.code === 'HEARTBEAT_SKIPPED' && sentAfterUpdate === sentBefore
        && stoppedHb.ok === false && stoppedHb.code === 'HEARTBEAT_SKIPPED' && sentAfterStop === sentBefore;
    if (good) {
        okCase('★ ⑩-⑤ board_client：暂停/取消/整端停止后 heartbeat 直接 HEARTBEAT_SKIPPED（零网络）',
            `发了 ${sentBefore} 次 → 暂停后仍 ${sentAfterPause} 次`);
    } else {
        badCase('⑩-⑤ 客户端停了还在发 board:heartbeat（审计点的第二处）', {
            before: before.ok, sentBefore,
            paused: [pausedHb.ok, pausedHb.code], sentAfterPause,
            updated: [updHb.ok, updHb.code], sentAfterUpdate,
            stopped: [stoppedHb.ok, stoppedHb.code], sentAfterStop,
        });
    }

    // ⑩-⑤b 反证：resume / 重新领到之后**必须**恢复续租（否则修成"永远不续租"就是新 bug）
    client.markJobResumed('j-c1');
    const again = await client.heartbeat('j-c1', null);
    if (again.ok === true && hbEvents() === sentBefore + 1) {
        okCase('★ ⑩-⑤b 恢复（resume）后心跳重新开始（没有把"续租"永久关死）', `sent=${hbEvents()}`);
    } else {
        badCase('⑩-⑤b resume 之后心跳发不出来（修过头，变成永不续租）', { again, sent: hbEvents() });
    }
}

/** 小工具：给失败信息一点可读性 */
function busyReason(r) { return r?.reason ?? '?'; }

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
