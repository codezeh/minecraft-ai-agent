/**
 * 控制层离线回归（M2 / 07_control.md §4 §5 §7 §8 + 09 §2 的 D10）—— 不需要服务器。
 *
 * 被钉住的缺陷与规范：
 *   D17  `timedout` 置上后从不复位 → 之后每次中断都被当成超时、中断消息被吞
 *   D18  `stop()` 等满 10 秒就强制复位 `executing=false`，旧动作还在跑
 *   D19  `task_follow.follow()` 入口把 `interrupt_code` 清成 false（把"谁在打断"抹掉）
 *   D10  `walkTo` 和 `execStep` 各包一层 tracePush → execStep 的每个事件记两次（09 §2）
 *   07 §4  停的原因决定任务单去哪（brief / preempt / player / timeout / shutdown；死亡见 §7）
 *   07 §7  死亡 → 正在跑的单 paused（不算 attempts）+ 回去捡的 8 级单（岩浆 / 虚空不开）
 *   07 §8  任务单的 runAction 必须带 deadline 换算出的 timeout
 *   08 §2  有单在跑或排队时 self_prompter 不催；被打断的是任务单时不发 AUTO MESSAGE
 *   07 §3.2 `!stay` 不停 self_preservation
 *
 * 手段（按验收要求）：**假 action_manager 的行为等价物 + 假任务板 + T1 的公共假 bot**
 *   - 假任务板：tools 侧 20 行的内存板，实现 board.list/get/update/add/setAutoClaim
 *   - 真 ActionManager：跑在假 agent + 假 bot 上（D17 / D18 / stop(reason) 都走真代码路径）
 *   - 真 modes.execute / 真 SelfPrompter / 真 skills.stay / 真 task_follow.follow
 *
 * 输出：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActionManager } from '../src/agent/action_manager.js';
import {
    STOP_REASONS, DEFAULT_STOP_REASON, JOB_STATE, BRIEF_REQUEUE_MS, JOB_MIN_TIMEOUT_MINS,
    JOB_STATUS_DEDUPE_MS, DEATH_PICKUP_PRIORITY, planStop, applyStop, requeueStaleBrief,
    jobsBusy, noteJobInterrupted, jobDeadlineTimeoutMinutes, runJobAction, onDeath,
    deathCause, shouldRecoverItems, isJobLabel, normalizeStopReason,
} from '../src/agent/library/control.js';
import { ensureTraced, isTraced, since, lastSeq } from '../src/agent/library/trace_bus.js';
import { execStep } from '../src/agent/library/executor.js';
import { saveSurfaces, closeDb3d, T } from '../src/agent/library/terrain3d.js';
import { execute as executeMode } from '../src/agent/modes.js';
import { SelfPrompter } from '../src/agent/self_prompter.js';
import { stay } from '../src/agent/library/skills.js';
import { follow } from '../src/agent/library/task_follow.js';
import { makeFakeBot, worldOf, realRegistry } from './fixtures/fake_bot.mjs';

const REG = realRegistry();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };
const check = (name, cond, evidence, actual) => cond ? okCase(name, evidence) : badCase(name, actual ?? evidence);

// ───────────────────────────────────────────────────────────────────────────
// 假任务板：只实现控制层要求的那 5 个方法（06 §3 的 board_client 形状）
// ───────────────────────────────────────────────────────────────────────────
function makeFakeBoard(jobs = []) {
    const rows = new Map(jobs.map((j) => [j.id, { ...j }]));
    const calls = [];
    const board = {
        autoClaim: true,
        calls,
        list({ states = null } = {}) {
            calls.push({ op: 'list', states });
            const all = [...rows.values()];
            return (states ? all.filter((j) => states.includes(j.state)) : all).map((j) => ({ ...j }));
        },
        get(id) { calls.push({ op: 'get', id }); return rows.has(id) ? { ...rows.get(id) } : null; },
        update(id, patch) {
            calls.push({ op: 'update', id, patch });
            if (!rows.has(id)) return null;
            Object.assign(rows.get(id), patch);
            return { ...rows.get(id) };
        },
        add(job) { calls.push({ op: 'add', job }); rows.set(job.id, { ...job }); return { ...job }; },
        setAutoClaim(v) { calls.push({ op: 'setAutoClaim', v }); board.autoClaim = v; },
        row: (id) => rows.get(id) ?? null,
        updates: (id) => calls.filter((c) => c.op === 'update' && c.id === id).map((c) => c.patch),
    };
    return board;
}

// ───────────────────────────────────────────────────────────────────────────
// 假 agent：真 ActionManager + 假 bot（T1 公共夹具）+ 可选假任务板
// ───────────────────────────────────────────────────────────────────────────
function makeAgent({ board = null } = {}) {
    const bot = makeFakeBot({
        world: worldOf([[0, 63, 0, 'stone']]),
        feet: { x: 0, y: 64, z: 0 },
        unloaded: 'air',
        registry: REG,
        stubs: {
            output: '',
            pvp: { stop: () => { agent.__pvpStop++; } },
            collectBlock: { cancelTask: () => { agent.__collectCancel++; } },
        },
    });

    const agent = {
        bot,
        board,
        __idle: [],
        __pvpStop: 0,
        __collectCancel: 0,
        __kills: [],
        __prompts: 0,
        __chats: [],
        __trace: [],
        history: {
            lines: [],
            add(role, msg) { this.lines.push({ role, msg }); },
        },
        self_prompter: { isActive: () => false, stopLoop: () => { /* noop */ } },
        requestInterrupt() { bot.interrupt_code = true; },
        clearBotLogs() { bot.output = ''; bot.interrupt_code = false; },
        isIdle() { return !agent.actions.executing; },
        cleanKill(msg, code) { agent.__kills.push({ msg, code }); agent.actions.executing = false; },
        openChat(m) { agent.__chats.push(String(m)); },
        async handleMessage() { agent.__prompts++; return false; },
        __lastTraceSeq: 0,
    };
    bot.emit = (ev) => { agent.__idle.push(ev); };
    agent.actions = new ActionManager(agent);
    return agent;
}

const traceTypesSince = (seq) => since(seq).map((e) => e.type);

// ───────────────────────────────────────────────────────────────────────────
// 1. 07 §4：停的原因 → 任务单状态转移（每个原因一条，全部走真 ActionManager.stop）
// ───────────────────────────────────────────────────────────────────────────
/**
 * 让一个"任务单动作"跑起来，然后按 reason 停掉。
 * 动作函数自己会在 interrupt_code 变真之后退出（真实流程就是这么做的），
 * 所以这里 requestInterrupt 额外把 executing 置回 false —— 模拟"流程看到中断码后返回"。
 */
async function stopRunningJob(reason, { job = {}, board = null } = {}) {
    const b = board ?? makeFakeBoard([{ id: 'j1', skill: 'collect', state: 'claimed',
        attempts: 0, maxAttempts: 3, reservations: ['tree#12'], lease: 'lease-1', ...job }]);
    const agent = makeAgent({ board: b });
    const origRequestInterrupt = agent.requestInterrupt;
    agent.requestInterrupt = () => {
        origRequestInterrupt();
        agent.actions.executing = false;   // 流程在下一个边界读到中断码就退出了
    };
    agent.actions.last_action_time = 0;
    const seq = lastSeq();
    await agent.actions.runAction('job:collect', async () => {
        // 一直等到被打断（最多 2 秒，测试不会真卡住）
        const t0 = Date.now();
        while (!agent.bot.interrupt_code && Date.now() - t0 < 2000) await sleep(5);
    }, { timeout: 0, stopReason: reason });
    // 运行中被停：executing 由 requestInterrupt 置回 false，动作返回
    agent.actions.currentJobId = 'j1';
    agent.actions.executing = true;              // 再停一次，拿"真的打断了一张单"的转移
    await agent.actions.stop(reason);
    return { agent, board: b, trace: traceTypesSince(seq) };
}

// 1a. brief → 单留在本 bot（仍 claimed），不写结果码
{
    const { board, agent, trace } = await stopRunningJob(STOP_REASONS.BRIEF);
    const row = board.row('j1');
    const last = board.updates('j1').pop() ?? {};
    check('brief：单留在本 bot，不写结果码',
        row.state === JOB_STATE.CLAIMED && last.interrupted?.reason === 'brief' && !last.result,
        `state=${row.state} patch=${JSON.stringify(last)} stop_reason=${agent.actions.stop_reason}`);
    check('brief：记了 stop_reason 且留了 stop-reason 事件',
        agent.actions.stop_reason === 'brief' && trace.includes('stop-reason'),
        `stop_reason=${agent.actions.stop_reason} trace=${trace.join(',')}`);
}

// 1b. preempt → ready，放掉租约和预约，PREEMPTED
{
    const { board } = await stopRunningJob(STOP_REASONS.PREEMPT);
    const row = board.row('j1');
    check('preempt：回 ready + 放租约 + 清预约 + PREEMPTED',
        row.state === JOB_STATE.READY && row.lease === null
        && Array.isArray(row.reservations) && row.reservations.length === 0
        && row.result?.code === 'PREEMPTED',
        `state=${row.state} lease=${row.lease} res=${JSON.stringify(row.reservations)} code=${row.result?.code}`);
}

// 1c. player → paused + 暂停自动领单 + INTERRUPTED
{
    const { board } = await stopRunningJob(STOP_REASONS.PLAYER);
    const row = board.row('j1');
    check('player：paused + INTERRUPTED + 暂停自动领单',
        row.state === JOB_STATE.PAUSED && row.result?.code === 'INTERRUPTED' && board.autoClaim === false,
        `state=${row.state} code=${row.result?.code} autoClaim=${board.autoClaim}`);
}

// 1d. timeout → attempts+1 回 ready；attempts 用尽 → failed
{
    const { board } = await stopRunningJob(STOP_REASONS.TIMEOUT);
    const row = board.row('j1');
    check('timeout：attempts+1 且回 ready（还能重试）',
        row.state === JOB_STATE.READY && row.attempts === 1 && row.result?.code === 'TIMEOUT',
        `state=${row.state} attempts=${row.attempts} code=${row.result?.code}`);

    const { board: b2 } = await stopRunningJob(STOP_REASONS.TIMEOUT,
        { job: { attempts: 2, maxAttempts: 3 } });
    const r2 = b2.row('j1');
    check('timeout：attempts 到上限 → failed',
        r2.state === JOB_STATE.FAILED && r2.attempts === 3 && r2.result?.code === 'TIMEOUT',
        `state=${r2.state} attempts=${r2.attempts} code=${r2.result?.code}`);
}

// 1e. shutdown → 什么都不改（等租约过期）
{
    const { board } = await stopRunningJob(STOP_REASONS.SHUTDOWN);
    const row = board.row('j1');
    const touched = board.updates('j1').length;
    check('shutdown：任务单不动（靠租约过期回收）',
        row.state === JOB_STATE.CLAIMED && touched === 0,
        `state=${row.state} update次数=${touched}`);
}

// 1f. 死亡（07 §7）→ paused，结果码 DIED，不算 attempts
{
    const { board } = await stopRunningJob(STOP_REASONS.DEATH,
        { job: { state: JOB_STATE.RUNNING, attempts: 1 } });
    const row = board.row('j1');
    check('death：paused + DIED + 不改 attempts',
        row.state === JOB_STATE.PAUSED && row.result?.code === 'DIED'
        && row.attempts === 1 && board.updates('j1').pop()?.countAttempt === false,
        `state=${row.state} code=${row.result?.code} attempts=${row.attempts}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 1g. 回归守卫：**正常停（六种原因）一律不重启进程**
//
// 队长点名的风险：D18 用的是 `cleanKill(msg, 1)`，而退出码语义（src/process/
// agent_process.js:37-51）是 1 = 重启 agent 进程、>1 = 结束整个任务。
// 如果"正常停"也走到那条路，就是回归：玩家说一句 !stop 她就重启消失一次。
// 判据：正常停之后 `__kills` 必须为空 —— cleanKill 只该被"动作 10 秒不退出"触发。
// ───────────────────────────────────────────────────────────────────────────
{
    const reasons = [STOP_REASONS.BRIEF, STOP_REASONS.PREEMPT, STOP_REASONS.PLAYER,
        STOP_REASONS.TIMEOUT, STOP_REASONS.SHUTDOWN, STOP_REASONS.DEATH];
    const kills = [];
    for (const r of reasons) {
        const { agent } = await stopRunningJob(r);
        if (agent.__kills.length) kills.push(`${r}:${JSON.stringify(agent.__kills)}`);
    }
    check('正常停（六种原因）都不重启进程（不触发 cleanKill）',
        kills.length === 0,
        '六种原因逐一验证：__kills 全为空（cleanKill 只在"停不下来"时调）',
        `意外重启：${kills.join(' / ')}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 2. 07 §4：brief 超过 60 秒退回 ready（由调度器在空闲 tick 调）
// ───────────────────────────────────────────────────────────────────────────
{
    const now = 1_800_000_000_000;
    const b = makeFakeBoard([{ id: 'j1', skill: 'collect', state: JOB_STATE.CLAIMED,
        interrupted: { reason: 'brief', at: now - 1000 } }]);
    const early = requeueStaleBrief({ board: b, now, maxAgeMs: BRIEF_REQUEUE_MS });
    const late = requeueStaleBrief({ board: b, now: now + BRIEF_REQUEUE_MS + 1, maxAgeMs: BRIEF_REQUEUE_MS });
    check('brief：60 秒内不退单，超过 60 秒退回 ready',
        early.length === 0 && late.length === 1 && b.row('j1').state === JOB_STATE.READY,
        `early=${early.length} late=${late.length} state=${b.row('j1').state}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 3. 未知原因收敛到 brief（不许把单凭空判失败）
// ───────────────────────────────────────────────────────────────────────────
{
    const p = planStop({ reason: 'whatever', job: { id: 'j1', state: JOB_STATE.CLAIMED } });
    check('未知原因收敛到 brief',
        normalizeStopReason('whatever') === DEFAULT_STOP_REASON && p.to === JOB_STATE.CLAIMED && p.code === null,
        `reason=${p.reason} to=${p.to} code=${p.code}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 3b. 归因：被打断的是 mode（不是单）时，不许记到"已经换成了新单"的 currentJobId 上
// ───────────────────────────────────────────────────────────────────────────
{
    const board = makeFakeBoard([
        { id: 'old', skill: 'collect', state: JOB_STATE.RUNNING },
        { id: 'new', skill: 'mine', state: JOB_STATE.CLAIMED },
    ]);
    const agent = makeAgent({ board });
    // runJobAction 会先换 currentJobId 再 runAction，而开工第一步就 stop 旧动作
    agent.actions.currentJobId = 'new';
    const plan = applyStop({ agent, reason: STOP_REASONS.TIMEOUT, label: 'mode:self_defense' });
    check('归因：mode 打断不许算到新单头上（label 优先于 currentJobId）',
        plan.jobId === null && board.row('new').attempts === undefined && board.row('old').attempts === undefined,
        `jobId=${plan.jobId} new.attempts=${board.row('new').attempts} old.attempts=${board.row('old').attempts}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 4. 08 §2 / 07 §4 第 5 步：mode 打断任务单 → 不叫模型，只给一行状态（30 秒去重）
// ───────────────────────────────────────────────────────────────────────────
{
    const board = makeFakeBoard([{ id: 'j7', skill: 'collect', state: JOB_STATE.RUNNING }]);
    const agent = makeAgent({ board });
    agent.bot.modes = { behavior_log: '', flushBehaviorLog() { const s = this.behavior_log; this.behavior_log = ''; return s; } };
    // 只关心"叫没叫模型"：runAction 换成同步成功的桩
    agent.actions.runAction = async (_label, fn) => { await fn(); return { success: true, message: '', interrupted: false, timedout: false }; };

    agent.actions.currentActionLabel = 'job:collect';
    agent.actions.currentJobId = 'j7';
    await executeMode({ name: 'self_defense', active: false }, agent, async () => { /* 打怪 */ });
    const promptsAfterJob = agent.__prompts;
    const linesAfterJob = agent.history.lines.length;

    agent.actions.currentActionLabel = 'action:followPlayer';
    agent.actions.currentJobId = null;
    await executeMode({ name: 'self_defense', active: false }, agent, async () => { /* 打怪 */ });
    const promptsAfterAction = agent.__prompts;

    check('打断任务单：不发 AUTO MESSAGE，只写一行状态',
        promptsAfterJob === 0 && linesAfterJob === 1 && /打断/.test(agent.history.lines[0].msg),
        `prompts=${promptsAfterJob} lines=${linesAfterJob} 行=${agent.history.lines[0]?.msg}`);
    check('打断即时命令：照旧 AUTO MESSAGE（行为没变）',
        promptsAfterAction === 1,
        `prompts=${promptsAfterAction}`);

    // 30 秒内同一张单只写一行
    const second = noteJobInterrupted(agent, { label: 'job:collect', mode: 'cowardice' });
    const again = noteJobInterrupted(agent, { label: 'job:collect', mode: 'cowardice', now: Date.now() + JOB_STATUS_DEDUPE_MS + 1 });
    check('同一张单 30 秒内最多一行状态',
        second === null && typeof again === 'string' && agent.history.lines.length === 2,
        `second=${second} again=${typeof again} lines=${agent.history.lines.length}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 5. 08 §2：有单在跑或排队时 self_prompter 不催
// ───────────────────────────────────────────────────────────────────────────
{
    const board = makeFakeBoard([{ id: 'j1', skill: 'collect', state: JOB_STATE.READY }]);
    const agent = makeAgent({ board });
    const sp = new SelfPrompter(agent);
    agent.self_prompter = sp;
    sp.state = 1;          // ACTIVE
    sp.cooldown = 0;

    sp.update(1000);
    await sleep(30);
    const busyPrompts = agent.__prompts;

    board.update('j1', { state: 'done' });   // 单没了（done 不在"跑或排队"里）
    sp.update(1000);
    await sleep(100);
    const idlePrompts = agent.__prompts;

    check('有单排队/在跑：self_prompter 不催',
        jobsBusy(agent) === false && busyPrompts === 0,
        `busyPrompts=${busyPrompts}`);
    check('单没了：self_prompter 恢复催促',
        idlePrompts > 0,
        `idlePrompts=${idlePrompts}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 6. 07 §8：任务单的 runAction 带 deadline 换算出的 timeout
// ───────────────────────────────────────────────────────────────────────────
{
    const now = 1_800_000_000_000;
    const m10 = jobDeadlineTimeoutMinutes({ deadline: now + 10 * 60000 }, now);
    const m1 = jobDeadlineTimeoutMinutes({ manifest: { timeoutMs: 60000 } }, now);
    const mDef = jobDeadlineTimeoutMinutes({}, now);
    const mPast = jobDeadlineTimeoutMinutes({ deadline: now - 5000 }, now);
    check('deadline → 分钟（不吃默认 10 分钟、过期也不给 0）',
        m10 === 10 && m1 === 1 && mDef === 10 && mPast === JOB_MIN_TIMEOUT_MINS,
        `10min=${m10} manifest=${m1} default=${mDef} past=${mPast}`);

    let seen = null;
    let insideJobId = undefined;
    const agent = {
        actions: {
            currentJobId: null,
            async runAction(label, fn, opts) { seen = { label, opts }; await fn(); return { success: true }; },
        },
    };
    await runJobAction(agent, { id: 'j9', skill: 'collect', deadline: now + 2 * 60000 }, async () => {
        insideJobId = agent.actions.currentJobId;
    }, { now });
    check('runJobAction：label=job:<skill>、timeout 按 deadline、跑完清 currentJobId',
        seen?.label === 'job:collect' && Math.abs((seen?.opts?.timeout ?? -1) - 2) < 0.01
        && insideJobId === 'j9' && agent.actions.currentJobId === null,
        `label=${seen?.label} timeout=${seen?.opts?.timeout} inside=${insideJobId} after=${agent.actions.currentJobId}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 7. D17：`timedout` 每次开工前复位
// ───────────────────────────────────────────────────────────────────────────
{
    const agent = makeAgent();
    agent.actions.timedout = true;                      // 上一次超时留下的陈迹
    const r = await agent.actions.runAction('action:x', async () => { /* 什么都不做 */ }, { timeout: 0 });
    check('D17：新动作开头清掉 timedout（不再把之后的中断当超时）',
        agent.actions.timedout === false && r.timedout === false,
        `timedout=${agent.actions.timedout} r.timedout=${r.timedout}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 8. D18：等满没退出 → 让身体停住 + zombie-action 事件 + 重启进程 + 不许开新动作
// ───────────────────────────────────────────────────────────────────────────
{
    const board = makeFakeBoard([{ id: 'j1', skill: 'collect', state: JOB_STATE.RUNNING, attempts: 0, maxAttempts: 3 }]);
    const agent = makeAgent({ board });
    agent.actions.stopWaitMs = 60;
    agent.actions.currentJobId = 'j1';
    agent.actions.currentActionLabel = 'job:collect';
    agent.actions.executing = true;
    agent.bot.setControlState('forward', true);        // 她正按着前进键
    let pfStop = 0;
    let digStop = 0;
    agent.bot.pathfinder.stop = () => { pfStop++; };
    agent.bot.stopDigging = async () => { digStop++; };

    const seq = lastSeq();
    await agent.actions.stop('timeout');               // 这个"动作"永远不退出（requestInterrupt 无效）
    const zombie = since(seq).filter((e) => e.type === 'zombie-action');

    check('D18：停不下来 → 松键 + 停寻路 + 停挖',
        agent.bot.__controls.size === 0 && pfStop > 0 && digStop > 0,
        `controls=${agent.bot.__controls.size} pfStop=${pfStop} digStop=${digStop}`);
    check('D18：发 zombie-action 事件（带动作名和等了多久）',
        zombie.length === 1 && zombie[0].label === 'job:collect' && typeof zombie[0].waitedMs === 'number',
        `zombie=${JSON.stringify(zombie)}`);
    check('D18：重启 agent 进程（cleanKill 退出码 1 = 由 agent_process 重新拉起）',
        agent.__kills.length === 1 && agent.__kills[0].code === 1,
        `kills=${JSON.stringify(agent.__kills)}`);

    let ran = false;
    const r = await agent.actions.runAction('action:next', async () => { ran = true; }, { timeout: 0 });
    check('D18：判定重启后不许在本动作上开新动作（不会两个流程同时驱动身体）',
        ran === false && r.interrupted === true,
        `ran=${ran} interrupted=${r.interrupted}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 9. 07 §7：死亡 → 正在跑的单 paused（不算 attempts）+ 回去捡的 8 级单
// ───────────────────────────────────────────────────────────────────────────
{
    const pos = { x: 12, y: 64, z: -3 };
    const now = 1_800_000_000_000;

    const board = makeFakeBoard([
        { id: 'j1', skill: 'collect', state: JOB_STATE.RUNNING, attempts: 1 },
        { id: 'j2', skill: 'craft', state: JOB_STATE.READY, attempts: 0 },
    ]);
    const agent = makeAgent({ board });
    const res = onDeath(agent, { message: 'Zeh was slain by Zombie', pos, now });
    const added = board.calls.filter((c) => c.op === 'add').map((c) => c.job);

    check('死亡：跑着的单 paused（DIED、不算 attempts），排队的单不动',
        board.row('j1').state === JOB_STATE.PAUSED && board.row('j1').result?.code === 'DIED'
        && board.row('j1').attempts === 1 && board.row('j2').state === JOB_STATE.READY,
        `j1=${board.row('j1').state}/${board.row('j1').result?.code}/att=${board.row('j1').attempts} j2=${board.row('j2').state}`);
    check('死亡：开一张 8 级的"回去捡"单（deadline 4 分钟）',
        added.length === 1 && added[0].priority === DEATH_PICKUP_PRIORITY
        && added[0].args?.x === pos.x && added[0].deadline === now + 4 * 60000,
        `added=${JSON.stringify(added[0] ?? null)}`);

    // 岩浆 / 掉出世界：东西没了，不开单
    for (const [msg, wantCause] of [
        ['Zeh tried to swim in lava', 'lava'],
        ['Zeh fell out of the world', 'void'],
    ]) {
        const b2 = makeFakeBoard([{ id: 'j1', skill: 'collect', state: JOB_STATE.RUNNING }]);
        const a2 = makeAgent({ board: b2 });
        const r2 = onDeath(a2, { message: msg, pos, now });
        const adds = b2.calls.filter((c) => c.op === 'add').length;
        check(`死因 ${wantCause}：不开"回去捡"的单`, r2.cause === wantCause && adds === 0 && r2.pickup === null,
            `cause=${r2.cause} adds=${adds}`);
    }

    check('死因判据（普通死亡仍会去捡）',
        deathCause('Zeh was slain by Skeleton') === 'other' && shouldRecoverItems('other') === true,
        `cause=${deathCause('Zeh was slain by Skeleton')}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 10. D19：follow() 入口不再把 interrupt_code 清成 false
// ───────────────────────────────────────────────────────────────────────────
{
    const src = readFileSync(new URL('../src/agent/library/task_follow.js', import.meta.url), 'utf8');
    check('D19：源码里不再有 bot.interrupt_code = false',
        !/bot\.interrupt_code\s*=\s*false/.test(src),
        '已删除（清标志只在 action_manager 开工前做）',
        '仍存在 bot.interrupt_code = false');

    // 行为面：带着"已被打断"的标志进 follow，必须原样返回 INTERRUPTED，不许把标志抹掉
    const bot = makeFakeBot({
        world: worldOf([[0, 63, 0, 'stone']]),
        feet: { x: 0, y: 64, z: 0 },
        registry: REG,
        unloaded: 'air',
        stubs: { players: { Zeh: { username: 'Zeh', entity: null } }, interrupt_code: true },
    });
    const events = [];
    const r = await follow(bot, 'Zeh', { onEvent: (e) => events.push(e.type), timeoutMs: 1 });
    check('D19：带着 interrupt_code 进 follow → INTERRUPTED 且标志不被抹掉',
        r.code === 'INTERRUPTED' && bot.interrupt_code === true && events.includes('interrupted'),
        `code=${r.code} interrupt_code=${bot.interrupt_code} events=${events.join(',')}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 11. 07 §3.2：!stay 不停 self_preservation
// ───────────────────────────────────────────────────────────────────────────
{
    const paused = [];
    const bot = makeFakeBot({
        world: worldOf([[0, 63, 0, 'stone']]),
        unloaded: 'air',
        registry: REG,
        stubs: {
            output: '',
            interrupt_code: false,
            modes: { pause: (n) => paused.push(n), unpause: () => {}, isPaused: () => false },
        },
    });
    await stay(bot, 0);   // 0 秒 = 立刻退出，只验"暂停了谁"
    check('!stay：照停 cowardice / self_defense 等，但**不停** self_preservation',
        !paused.includes('self_preservation') && paused.includes('cowardice') && paused.includes('self_defense'),
        `paused=${paused.join(',') || '(无)'}`);
}

// ───────────────────────────────────────────────────────────────────────────
// 12. D10 / 09 §2：trace_bus 只写一次
// ───────────────────────────────────────────────────────────────────────────
{
    // 12a. 包裹是幂等的：内层再包一次不会多写一份
    const seen = [];
    const user = (e) => seen.push(e.type);
    const outer = ensureTraced(user);              // walkTo 包的那一层
    const inner = ensureTraced(outer);             // execStep 现在调的就是这个
    check('D10：ensureTraced 幂等（同一函数不重复包裹）',
        inner === outer && isTraced(outer),
        `inner===outer: ${inner === outer}`);

    const seq = lastSeq();
    inner({ type: 'dig', x: 1, y: 2, z: 3 });
    const traced = since(seq).map((e) => e.type);
    check('D10：走两层包裹也只记一条 trace、回调照旧一次',
        seen.length === 1 && traced.length === 1,
        `user=${seen.length} trace=${traced.length} (${traced.join(',')})`);

    // 12b. 真链路：execStep 拿到"已包过"的 onEvent（walkTo 就是那样传下来的）时，事件不重复
    const tmp = mkdtempSync(join(tmpdir(), 'control-trace-'));
    saveSurfaces(tmp, [{ x: 1, z: 0, y: 63, t: T.LAVA }]);   // 落点是岩浆 → 必发 unsafe-landing
    try {
        const bot = makeFakeBot({
            world: worldOf([['0,63,0', 'stone'], ['1,63,0', 'stone']]),
            feet: { x: 0, y: 64, z: 0 },
            registry: REG,
            unloaded: 'air',
            diggable: (n) => n !== 'bedrock',
        });
        const userEvents = [];
        const asWalkToWould = ensureTraced((e) => userEvents.push(e.type));   // walkTo 包好的那层
        const seq2 = lastSeq();
        await execStep(bot, { action: 'walk', x: 1, y: 63, z: 0 },
            { onEvent: asWalkToWould, mapDir: tmp });
        const unsafe = since(seq2).filter((e) => e.type === 'unsafe-landing');
        const userUnsafe = userEvents.filter((t) => t === 'unsafe-landing');
        check('D10：真链路 execStep 的 unsafe-landing 只记一次（修前记两次）',
            userUnsafe.length === 1 && unsafe.length === 1,
            `user=${userUnsafe.length} trace=${unsafe.length} userEvents=${userEvents.join(',')}`);
    } finally {
        closeDb3d(tmp);
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n控制层离线：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
