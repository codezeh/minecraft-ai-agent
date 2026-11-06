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

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 造一个假 agent：只实现 ActionManager 真正会碰到的那几个接口。 */
function makeAgent() {
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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
