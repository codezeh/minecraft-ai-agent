/**
 * BOT-002（2026-11-06 深度检查）—— ActionManager 启动竞争：两个动作不得同时占用机器人。
 *
 * 缺陷原貌：`_executeAction` 里 `this.executing = true` 写在 `await this.stop()` **之后**。
 * 两条并发动作都能在等待期间通过"没人在跑"的检查，于是：
 *   实测 maxConcurrent=2、顺序 start1/start2/end1/end2 —— 两个流程同时控制视角/容器/挖掘，
 *   而且**先完成者**还会清掉 executing 与中断状态，槽位状态失真。
 *
 * 修复口径：在第一个 await 之前登记"启动票"，后来者作废先来者（取代而非排队）；
 * 认领动作槽（清票 + executing=true）在 await 返回后同步完成 ⇒ 同一时刻只有一个赢家。
 *
 * 本测用**真实 ActionManager** + 假 agent/bot（不连服务器、不挖方块）：
 *   A. 并发两条：只能有一个开工，maxConcurrent 必须是 1；
 *   B. 正在跑时来新的：新的接管、旧的被停掉，仍然 maxConcurrent=1（不许并行）；
 *   C. 五条一起：只有最后一个开工；
 *   D. 不变量：killed（僵尸动作）语义、正常单条、resume 槽不受影响。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { ActionManager } from '../src/agent/action_manager.js';
import { runJobAction, STOP_REASONS } from '../src/agent/library/control.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 造一个**假任务板**：只实现 control.js 用到的 4 个方法。
 * list/get 都是**同步**读本地镜像（board_client 的约定，见 board_client.js:20）。
 */
function makeBoard(jobs = []) {
    const byId = new Map(jobs.map(j => [String(j.id), { ...j }]));
    const board = {
        autoClaim: true,
        updates: [],
        get: (id) => byId.get(String(id)) ?? null,
        list: (filter = {}) => {
            const states = filter?.states ?? null;
            const all = [...byId.values()];
            return states ? all.filter(j => states.includes(j.state)) : all;
        },
        update: (id, patch) => {
            const key = String(id);
            const cur = byId.get(key);
            if (!cur) return null;
            const next = { ...cur, ...patch };
            byId.set(key, next);
            board.updates.push({ id: key, patch });
            return next;
        },
        setAutoClaim: (v) => { board.autoClaim = !!v; },
    };
    return board;
}

/** 造一个假 agent：只实现 ActionManager 真正会碰到的那几个接口。 */
function makeAgent({ board = null } = {}) {
    const state = { maxConcurrent: 0, running: 0, events: [], killCalls: 0 };
    const bot = {
        interrupt_code: false,
        output: '',
        emit: () => {},
        clearControlStates: () => {},
        releaseAll: () => {},
        pathfinder: { stop: () => {} },
        stopDigging: () => {},
        pvp: { stop: () => {} },
    };
    const agent = {
        name: 'tester',
        bot,
        board,
        scheduler: { autoClaim: true, setAutoClaim(v) { this.autoClaim = !!v; } },
        history: { add: () => {} },
        clearBotLogs: () => { bot.interrupt_code = false; bot.output = ''; },
        requestInterrupt: () => { bot.interrupt_code = true; },
        cleanKill: () => { state.killCalls++; },
        isIdle: () => state.running === 0,
        self_prompter: { isActive: () => false },
    };
    /** 一段"动作"：收到中断就提前结束（真实动作也是这样响应的）。 */
    const makeAction = (id, { ms = 200 } = {}) => async () => {
        state.running++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.running);
        state.events.push('start' + id);
        const t0 = Date.now();
        while (!bot.interrupt_code && Date.now() - t0 < ms) await sleep(5);
        state.running--;
        state.events.push('end' + id);
    };
    return { agent, state, bot, makeAction };
}

// ════════════════════════════════════════════════════════════
// A. 并发两条：只能有一个开工
// ════════════════════════════════════════════════════════════
{
    const { agent, state, makeAction } = makeAgent();
    const am = new ActionManager(agent);
    const [r1, r2] = await Promise.all([
        am.runAction('a', makeAction('a')),
        am.runAction('b', makeAction('b')),
    ]);
    check('A 并发两条：maxConcurrent === 1', state.maxConcurrent === 1, `→ ${state.maxConcurrent}`);
    const starts = state.events.filter(e => e.startsWith('start'));
    check('A 并发两条：只有一个动作真的开工', starts.length === 1, `→ ${JSON.stringify(state.events)}`);
    check('A 并发两条：开工的是后来者（取代语义）', starts[0] === 'startb', `→ ${JSON.stringify(starts)}`);
    const losers = [r1, r2].filter(r => r && r.success === false && /Superseded/.test(String(r.message)));
    check('A 并发两条：输家拿到稳定的"未开工"结果', losers.length === 1, `→ ${JSON.stringify([r1, r2])}`);
    check('A 结束后槽位干净：executing=false 且无未兑现票',
        am.executing === false && am._pendingLaunch === null,
        `→ executing=${am.executing} pending=${String(am._pendingLaunch)}`);
}

// ════════════════════════════════════════════════════════════
// B. 正在跑时来新的：接管，但不许并行
// ════════════════════════════════════════════════════════════
{
    const { agent, state, makeAction } = makeAgent();
    const am = new ActionManager(agent);
    am.stopWaitMs = 500;   // 别让测试等 10 秒

    const p1 = am.runAction('first', makeAction('1', { ms: 3000 }));
    await sleep(20);                       // 让第一条真的开跑
    check('B 第一条已在执行', am.executing === true, `→ executing=${am.executing}`);
    const p2 = am.runAction('second', makeAction('2', { ms: 50 }));
    await Promise.all([p1, p2]);

    check('B 接管期间 maxConcurrent === 1（不许并行）', state.maxConcurrent === 1, `→ ${state.maxConcurrent}`);
    const order = state.events.join(',');
    check('B 顺序是先结束旧的再开新的', order === 'start1,end1,start2,end2', `→ ${order}`);
    check('B 没有误判僵尸（没重启进程）', state.killCalls === 0, `→ killCalls=${state.killCalls}`);
    check('B 结束后槽位干净', am.executing === false && am._pendingLaunch === null);
}

// ════════════════════════════════════════════════════════════
// C. 五条一起：只有最后一个开工
// ════════════════════════════════════════════════════════════
{
    const { agent, state, makeAction } = makeAgent();
    const am = new ActionManager(agent);
    const results = await Promise.all(['1', '2', '3', '4', '5'].map(
        id => am.runAction('act' + id, makeAction(id, { ms: 60 })),
    ));
    check('C 五条并发：maxConcurrent === 1', state.maxConcurrent === 1, `→ ${state.maxConcurrent}`);
    const starts = state.events.filter(e => e.startsWith('start'));
    check('C 五条并发：只有一个开工，且是最后一条', starts.length === 1 && starts[0] === 'start5',
        `→ ${JSON.stringify(state.events)}`);
    const superseded = results.filter(r => r && r.success === false).length;
    check('C 五条并发：其余四条都被判"未开工"', superseded === 4, `→ ${superseded}`);
}

// ════════════════════════════════════════════════════════════
// D. 不变量：正常单条 / killed 语义 / resume 槽
// ════════════════════════════════════════════════════════════
{
    const { agent, state, makeAction } = makeAgent();
    const am = new ActionManager(agent);
    const r = await am.runAction('solo', makeAction('s', { ms: 40 }));
    check('D 正常单条仍返回 success:true', r.success === true, `→ ${JSON.stringify(r)}`);
    check('D 正常单条跑了一次', state.events.join(',') === 'starts,ends', `→ ${state.events.join(',')}`);
}
{
    // D18 僵尸语义不许改：killed=true 时新动作不许开工
    const { agent, state, makeAction } = makeAgent();
    const am = new ActionManager(agent);
    am.killed = true;
    const r = await am.runAction('after-zombie', makeAction('z', { ms: 20 }));
    check('D killed 后拒绝开工（保留 D18 语义）',
        r.success === false && /restarting/.test(String(r.message)), `→ ${JSON.stringify(r)}`);
    check('D killed 后没有真的跑动作', state.events.length === 0, `→ ${JSON.stringify(state.events)}`);
    check('D killed 后清掉了启动票', am._pendingLaunch === null, `→ ${String(am._pendingLaunch)}`);
}
{
    // resume 槽走同一条 _executeAction ⇒ 同样只允许一个赢家
    const { agent, state, makeAction } = makeAgent();
    const am = new ActionManager(agent);
    const r = await am.runAction('resume-1', makeAction('r', { ms: 30 }), { resume: true });
    check('D resume 路径仍可用（且不并行）',
        state.maxConcurrent === 1 && (r.success === true || r.success === false),
        `→ max=${state.maxConcurrent} r=${JSON.stringify(r)}`);
}

// ════════════════════════════════════════════════════════════
// E. P1-2：玩家 !stop 必须作废「还没兑现的启动票」
// ════════════════════════════════════════════════════════════
// 审查复现的时序：旧任务在跑 → 新任务拿到票、排在旧动作后面等 → 玩家 !stop
// → 旧任务 paused，但票没作废 → 旧动作一退出，新任务清掉中断标志照常开工。
// 断言的核心就是那句 `secondRan === false`：把 _cancelPendingLaunch 改回去必红。
{
    const board = makeBoard([
        { id: 'j1', skill: 'collect', state: 'running', priority: 5 },
        { id: 'j2', skill: 'dig', state: 'claimed', priority: 5 },
    ]);
    const { agent, state, bot } = makeAgent({ board });
    const am = new ActionManager(agent);
    agent.actions = am;
    am.stopWaitMs = 2000;

    const ran = { first: false, second: false };
    // 旧动作用**闩**卡住：真实流程在两次检查中断之间可能正好"没看中断标志"，
    // 只有玩家 !stop 那一下才收手 —— 这样才能精确复现"票在等、旧动作还没退"的窗口。
    let releaseFirst = null;
    const firstGate = new Promise(r => { releaseFirst = r; });
    const p1 = runJobAction(agent, board.get('j1'), async () => {
        ran.first = true;
        state.running++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.running);
        await firstGate;
        state.running--;
    });
    await sleep(20);

    const p2 = runJobAction(agent, board.get('j2'), async () => {
        ran.second = true;
        state.running++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.running);
        await sleep(30);
        state.running--;
    });
    await sleep(20);

    const ticket = am._pendingLaunch;
    check('E 新单已拿到票并在等旧动作（还没开工）',
        !!ticket && ticket.jobId === 'j2' && ran.second === false && ran.first === true,
        `→ ticket=${JSON.stringify(ticket && { jobId: ticket.jobId, seq: ticket.seq })} first=${ran.first} second=${ran.second}`);

    const stopP = am.stop(STOP_REASONS.PLAYER);
    // 作废票是**同步**完成的（在第一个 await 之前）：按下去的那一刻它就必须失效。
    check('E !stop 同步作废了待启动票（superseded + 原因 player）',
        !!ticket && ticket.superseded === true && ticket.cancelledBy === 'player',
        `→ ${JSON.stringify(ticket && { superseded: ticket.superseded, cancelledBy: ticket.cancelledBy })}`);

    await sleep(20);
    releaseFirst();                       // 旧动作这才退出
    const [, r2] = await Promise.all([p1, p2, stopP]);
    check('E 等待中的任务没有再开工（secondRan=false）', ran.second === false, `→ secondRan=${ran.second}`);
    check('E 未开工的结果能说清"是玩家撤销的"',
        r2 && r2.success === false && /Cancelled before start/.test(String(r2.message)),
        `→ ${JSON.stringify(r2 && { success: r2.success, message: r2.message })}`);
    check('E 待启动票对应的单被暂停（不是留在 claimed 里空等）',
        board.get('j2').state === 'paused' && board.get('j2').result?.code === 'INTERRUPTED',
        `→ ${JSON.stringify({ state: board.get('j2').state, result: board.get('j2').result })}`);
    check('E 正在跑的旧单仍然 paused（原有语义不变）',
        board.get('j1').state === 'paused' && board.get('j1').result?.code === 'INTERRUPTED',
        `→ ${JSON.stringify({ state: board.get('j1').state, result: board.get('j1').result })}`);
    check('E 自动领单两处都关掉（面板镜像 + 调度器）',
        board.autoClaim === false && agent.scheduler.autoClaim === false,
        `→ board=${board.autoClaim} scheduler=${agent.scheduler.autoClaim}`);
    check('E 全程没有并行驱动身体（maxConcurrent === 1）', state.maxConcurrent === 1, `→ ${state.maxConcurrent}`);
}

// ════════════════════════════════════════════════════════════
// F. P1-2：票拿到之后、真正开工之前，再核一次任务状态
// ════════════════════════════════════════════════════════════
// 只靠"票被作废"不够：面板/别的 bot/服务端回传也能把单子停掉，而这时票还在排队。
// 建两种一进函数就已经停掉的单：paused / cancelled 都必须拒绝开工。
for (const blockedState of ['paused', 'cancelled']) {
    const board = makeBoard([{ id: 'j3', skill: 'place', state: blockedState }]);
    const { agent, state } = makeAgent({ board });
    const am = new ActionManager(agent);
    agent.actions = am;
    let ran = false;
    const r = await runJobAction(agent, board.get('j3'), () => { ran = true; });

    check(`F 单是 ${blockedState}：开工前复核拒绝开工`, ran === false, `→ ran=${ran} r=${JSON.stringify(r)}`);
    check(`F 单是 ${blockedState}：结果说清单子状态`,
        r && r.success === false && new RegExp(blockedState).test(String(r.message)),
        `→ ${JSON.stringify(r && r.message)}`);
    check(`F 单是 ${blockedState}：拒绝后槽位干净（没有 executing / 票）`,
        am.executing === false && am._pendingLaunch === null && state.events.length === 0,
        `→ executing=${am.executing} pending=${String(am._pendingLaunch)} events=${JSON.stringify(state.events)}`);
}

// ════════════════════════════════════════════════════════════
// G. 抢占语义不许被"作废待启动票"破坏（preempt）
// ════════════════════════════════════════════════════════════
// preempt 是「旧单让位给新单」：新单的票就是在 stop(preempt) 的窗口里排队的，
// 如果把它一并作废，抢占就永久坏掉 —— 这条用例专门盯它。
{
    const board = makeBoard([
        { id: 'k1', skill: 'collect', state: 'running', priority: 5 },
    ]);
    const { agent, state, bot } = makeAgent({ board });
    const am = new ActionManager(agent);
    agent.actions = am;
    am.stopWaitMs = 2000;

    const ran = { old: false, new: false };
    const p1 = am.runAction('job:collect', async () => {
        ran.old = true;
        state.running++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.running);
        const t0 = Date.now();
        while (!bot.interrupt_code && Date.now() - t0 < 4000) await sleep(5);
        state.running--;
    });
    await sleep(40);
    const p2 = am.runAction('job:mine', async () => {
        ran.new = true;
        state.running++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.running);
        await sleep(20);
        state.running--;
    }, { stopReason: STOP_REASONS.PREEMPT });
    await Promise.all([p1, p2]);

    check('G preempt 的新动作照常开工（票不许被误作废）', ran.new === true, `→ ${JSON.stringify(ran)}`);
    check('G preempt 后 maxConcurrent === 1', state.maxConcurrent === 1, `→ ${state.maxConcurrent}`);
    check('G preempt 把被抢占的单放回 ready（原有语义）', board.get('k1').state === 'ready',
        `→ ${JSON.stringify(board.get('k1'))}`);
}

// ════════════════════════════════════════════════════════════
// H. timeout 也不许被"作废待启动票"误伤
// ════════════════════════════════════════════════════════════
// 旧动作自己超时 ≠ 玩家喊停：等它退出的新单应当接着开工。
{
    const board = makeBoard([
        { id: 'm1', skill: 'collect', state: 'running', attempts: 0 },
        { id: 'm2', skill: 'dig', state: 'claimed' },
    ]);
    const { agent, state, bot } = makeAgent({ board });
    const am = new ActionManager(agent);
    agent.actions = am;
    am.stopWaitMs = 2000;

    const ran = { new: false };
    // 同样的闩：旧动作一直跑到"超时"那一下才收手（这才是超时该有的时序）。
    let releaseFirst = null;
    const firstGate = new Promise(r => { releaseFirst = r; });
    const p1 = runJobAction(agent, board.get('m1'), async () => {
        state.running++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.running);
        await firstGate;
        state.running--;
    });
    await sleep(20);
    const p2 = runJobAction(agent, board.get('m2'), async () => {
        ran.new = true;
        await sleep(20);
    });
    await sleep(20);
    const stopP = am.stop(STOP_REASONS.TIMEOUT);
    await sleep(20);
    releaseFirst();
    await Promise.all([p1, p2, stopP]);

    check('H 旧动作超时后，等待中的新单照常开工（票不许被误作废）', ran.new === true, `→ ${JSON.stringify(ran)}`);
    check('H 超时仍然计 attempts / 回 ready（原有语义）',
        board.get('m1').attempts === 1 && board.get('m1').state === 'ready',
        `→ ${JSON.stringify({ attempts: board.get('m1').attempts, state: board.get('m1').state })}`);
}

// ════════════════════════════════════════════════════════════
// I. 复核只认「任务单自己的票」—— 别把玩家随后的即时命令也拒掉
// ════════════════════════════════════════════════════════════
// !stop 之后、旧单流程还没退出之前，`currentJobId` 仍指着那张刚被 paused 的单。
// 这时玩家说 `!follow`（mode 动作），它的票会带上那个 jobId —— 如果照抄去核，
// 就会把"玩家刚喊停就又要她跟着走"的这个动作也拒掉，那是回归不是修复。
{
    const board = makeBoard([{ id: 'n1', skill: 'collect', state: 'paused' }]);
    const { agent, state, makeAction } = makeAgent({ board });
    const am = new ActionManager(agent);
    agent.actions = am;
    am.currentJobId = 'n1';                 // 旧单流程还没退出（runJobAction 的 finally 未到）
    const r = await am.runAction('mode:follow', makeAction('f', { ms: 20 }));
    check('I 单被暂停时，即时命令仍能开工（不许误拒）',
        r.success === true && state.events.join(',') === 'startf,endf',
        `→ ${JSON.stringify(r)} events=${JSON.stringify(state.events)}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
