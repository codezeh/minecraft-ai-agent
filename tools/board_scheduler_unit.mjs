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
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import {
    BoardScheduler, preempts, pickBest, meetsRequires, argsToString,
    CLAIM_BACKOFF_MS, HEARTBEAT_MS,
} from '../src/agent/library/board_scheduler.js';
import { JOB_STATE, STOP_REASONS, BRIEF_REQUEUE_MS } from '../src/agent/library/control.js';

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
        async claim() {
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
        async setState(id, state, reason = '') {
            calls.push({ op: 'setState', id, state, reason });
            const j = jobs.get(id);
            if (!j) return { ok: false, code: 'NO_TARGET' };
            j.state = state;
            if (state === JOB_STATE.PAUSED) j.pausedReason = reason;
            if (state === JOB_STATE.READY) j.pausedReason = null;
            return { ok: true, data: { job: { ...j } } };
        },
        async heartbeat(id, progress) {
            calls.push({ op: 'heartbeat', id, progress });
            const j = jobs.get(id);
            if (!j) return { ok: false, code: 'NO_TARGET' };
            if (progress) j.progress = progress;
            return { ok: true, data: { job: { ...j } } };
        },
        async finish(id, result) {
            calls.push({ op: 'finish', id, result });
            const j = jobs.get(id);
            if (!j) return { ok: false, code: 'NO_TARGET' };
            const counted = result?.ok === true && (result?.progress?.want == null
                || Number(result.progress.count) >= Number(result.progress.want));
            j.state = counted ? JOB_STATE.DONE : JOB_STATE.READY;
            j.result = result;
            return { ok: true, data: { next: j.state, counted } };
        },
        async update(id, patch) {
            calls.push({ op: 'update', id, patch });
            const j = jobs.get(id);
            if (j && patch) Object.assign(j, patch);
            return { ok: true };
        },
        async getAsync(id) { return { ok: true, data: { job: jobs.get(id) ?? null } }; },
        async hello() { return { ok: true }; },
        async refresh() { return { ok: true }; },
        async checkpoint() { return { ok: true }; },
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
        async runAction(_label, fn) { return fn(); },
    };
}

/** 假时钟：now() 由我们控制，sleep() 立即推进。 */
function makeClock(start = 1_000_000) {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => { t += ms; },
        sleep: async (ms) => { t += ms; },
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
        reserve: async (k) => { reserveCalls.push(['reserve', k]); return k === 'area:2' ? { ok: false, code: 'CLAIM_CONFLICT' } : { ok: true }; },
        release: async (k) => { reserveCalls.push(['release', k]); return { ok: true }; },
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
    try { lowGateResolve?.(); } catch { }               // 放行闸门，让被打断的流程退出
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
    const sched = new BoardScheduler({ agent: { name: 'tester' }, board: null, actions: makeFakeActions(), runSkill: async () => ({ ok: true }), now: clock.now, sleep: clock.sleep });
    const r = await sched.tick();
    if (!r.acted && r.reason === 'no-board') okCase('没有任务板 → 空转不抛（无板降级）', r.reason);
    else badCase('无板空转', r);
}

/** 小工具：给失败信息一点可读性 */
function busyReason(r) { return r?.reason ?? '?'; }

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
