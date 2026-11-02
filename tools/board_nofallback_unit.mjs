/**
 * 无板降级回归（M8 B1，设计 §3.4 / §8 第一条风险）—— 这是 B1 最容易被忽略的验收项。
 *
 * 要证明的一件事：**`agent.board = null` 时，控制层的行为与"加任务板之前"逐条一致。**
 * 为什么重要：控制层（M2 的 control.js）早就按"可能有板"写好了降级；如果 B1 接板时
 * 让降级路径变了哪怕一点（比如 `board.list()` 变成返回 Promise、或 `null` 被换成空对象
 * 但有 `list` 方法），就会出现"控制层走降级、调度器走真板"两套行为。
 *
 * 做法：把 control.js 的纯逻辑直接喂 `board = null`，断言它不抛、且给出的结论
 * 与"没有板"的语义一致（planStop 不产生 patch、jobsBusy 恒 false、resolveJob 恒 null）。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import {
    planStop, applyStop, resolveJob, jobsBusy, STOP_REASONS, JOB_STATE,
} from '../src/agent/library/control.js';
import { makeNullBoard } from '../src/agent/library/board_client.js';
import { isResult } from '../src/agent/library/contract.js';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

/** 造一个"没有任务板"的 agent（与 agent.js 未接板时同形）。 */
const agentNoBoard = () => ({ board: null, actions: { currentJobId: null }, history: null });

// ── 1. board = null 时 resolveJob 恒返回 null（不抛）────────────────
{
    let threw = false;
    let r1, r2;
    try {
        r1 = resolveJob({ board: null, label: 'action:collect' });
        r2 = resolveJob({ board: null, jobId: 'j_1' });
    } catch { threw = true; }
    if (!threw && r1 === null && r2 === null) {
        okCase('board=null：resolveJob 恒 null 且不抛', 'r1=null r2=null');
    } else {
        badCase('board=null resolveJob', { threw, r1, r2 });
    }
}

// ── 2. board = null 时 jobsBusy 恒 false ──────────────────────────
{
    const busy = jobsBusy(agentNoBoard());
    if (busy === false) okCase('board=null：jobsBusy 恒 false（=加板之前）', `${busy}`);
    else badCase('board=null jobsBusy', { busy });
}

// ── 3. board = null 时 planStop 不给 patch、也不暂停自动领单 ────────
{
    const plan = planStop({ reason: STOP_REASONS.PLAYER, job: null, now: 1000 });
    // 没有单 → 不应该有"要写到板上的补丁"
    const noPatch = !plan.patch;
    if (noPatch) okCase('board=null：planStop(job=null) 不产生 patch', JSON.stringify(plan).slice(0, 80));
    else badCase('board=null planStop 不该有 patch', plan);
}

// ── 4. ★ 关键：applyStop 在 board=null 时**完全不碰板、也不抛** ─────
//    这条是"加板之前的行为"的正面断言：所有 reason 都走一遍，全部不抛。
{
    const reasons = Object.values(STOP_REASONS);
    const bad = [];
    for (const reason of reasons) {
        const agent = agentNoBoard();
        try {
            applyStop({ agent, reason, label: 'action:collect', jobId: null });
        } catch (e) {
            bad.push({ reason, err: String(e?.message ?? e) });
        }
        // board 必须还是 null（没有被悄悄换成空对象）
        if (agent.board !== null) bad.push({ reason, why: 'board 被改成了非 null' });
    }
    if (bad.length === 0) okCase('★ board=null：applyStop 所有 reason 都不抛、不碰板', `${reasons.length} 种 reason`);
    else badCase('board=null applyStop', bad);
}

// ── 5. makeNullBoard 与 board=null 行为一致（同样结论）─────────────
//    这是设计 §3.4 的另一种实现方式：如果以后要"有板对象但没连上"，也必须一样。
{
    const agentNull = { board: makeNullBoard(), actions: { currentJobId: null }, history: null };
    const busyNull = jobsBusy(agentNull);
    const resolved = resolveJob({ board: agentNull.board, label: 'action:collect' });
    const plan = planStop({ reason: STOP_REASONS.PLAYER, job: null, now: 1 });
    let threw = false;
    try { applyStop({ agent: agentNull, reason: STOP_REASONS.PLAYER, label: 'action:collect' }); } catch { threw = true; }
    const same = busyNull === false && resolved === null && !plan.patch && !threw;
    if (same) okCase('makeNullBoard 与 board=null 结论一致（busy=false / resolved=null / 不抛）', 'ok');
    else badCase('makeNullBoard 一致性', { busyNull, resolved, plan, threw });
}

// ── 6. makeNullBoard 的写操作返回"可重试 + noBoard"标记 ────────────
{
    const nb = makeNullBoard();
    const r = await nb.update('j1', { state: JOB_STATE.READY });
    if (isResult(r) && !r.ok && r.data?.noBoard === true) {
        okCase('makeNullBoard 写操作：ok=false + data.noBoard（调用方可据此判断"没板"）', r.code);
    } else {
        badCase('makeNullBoard 写操作返回', r);
    }
}

// ── 7. 有真板时 applyStop **会**写板（反证：证明降级不是"永远不写"）──
//    用假板记录调用，确认 control.js 在有板时会调 update —— 这样"无板不写"才有意义。
{
    const calls = [];
    const fakeBoard = {
        list: () => [{ id: 'j1', skill: 'collect', state: JOB_STATE.RUNNING }],
        get: () => ({ id: 'j1', skill: 'collect', state: JOB_STATE.RUNNING }),
        update: (id, patch) => { calls.push({ id, patch }); },
        add: () => { },
        setAutoClaim: (v) => { calls.push({ autoClaim: v }); },
    };
    const agent = { board: fakeBoard, actions: { currentJobId: null }, history: null };
    applyStop({ agent, reason: STOP_REASONS.PLAYER, label: 'action:collect' });
    const wroteBoard = calls.length > 0;
    if (wroteBoard) okCase('反证：有板时 applyStop 会写板（说明无板"不写"是降级而非失效）', `${calls.length} 次调用`);
    else badCase('反证失败：有板时也没写', calls);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
