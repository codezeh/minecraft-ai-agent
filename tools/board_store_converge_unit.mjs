/**
 * `board_store` 的两块**零覆盖**分支（t65 盘点的 ①②）—— 离线，真 sqlite，不连 socket。
 *
 * ① `claimFor` 领单前的 `convergeIfSatisfied` 收敛（`board_store.js:401`，此前**零用例**）
 *    语义：候选单如果 `progress.count >= want`，说明"本来就已经跑够了"（典型：被 kill 在
 *    '已跑够但还没 finish' 那一刻），领单时**直接收敛成 done，不派发**。
 *    为什么要测：它是一次**静默的状态变更**——不测的话它写坏了也没人知道。
 *
 * ② `dependsSatisfied`（`board_store.js:872`）的"前置不存在 / blocked / failed"
 *    语义：只有前置 `=== done` 才放行。
 *    ★ 重点用例是"**静默阻塞**"：前置 blocked 时后继单永远领不到，
 *      而库里看不出"我在等谁"、也没有任何事件 —— 这是本次卡点的强嫌疑，
 *      这里把它**当前的**行为钉死（照实记录，不改产品）。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
    openBoard, addJob, getJob, claimFor, JOB_STATE, sweepDeadDepJobs,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = join('tmp', 'board-converge-test');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); return openBoard(d); };

const BOT = 'alpha';

// ══════════════════════════════════════════════════════════════════════════
// ① convergeIfSatisfied：领单前"已经跑够了"的单直接收敛成 done，不派发
// ══════════════════════════════════════════════════════════════════════════

// 1. 达标（4/4）→ claimFor 返回 null，单变 done，attempts 不动，result.reason=claim-sweep
{
    const { db } = freshDb();
    const job = addJob(db, {
        title: '已跑够', skill: 'mine', assignee: BOT, priority: 3,
        progress: { count: 4, want: 4 },
    });
    const got = claimFor(db, BOT);
    const after = getJob(db, job.id);
    const reason = after?.result?.reason ?? null;
    const good = got === null && after.state === JOB_STATE.DONE
        && after.attempts === 0 && reason === 'claim-sweep';
    if (good) okCase('①-1 达标(4/4) → 领单时收敛成 done、不派发', `claim=null state=${after.state} reason=${reason}`);
    else badCase('①-1 达标单应被收敛且不派发', { got: got?.id ?? got, state: after?.state, attempts: after?.attempts, reason });
}

// 2. 未达标（3/4）→ 照常派发（别把没干完的收敛掉）
{
    const { db } = freshDb();
    const job = addJob(db, {
        title: '还差点', skill: 'mine', assignee: BOT, priority: 3,
        progress: { count: 3, want: 4 },
    });
    const got = claimFor(db, BOT);
    const after = getJob(db, job.id);
    const good = got?.id === job.id && after.state === JOB_STATE.CLAIMED;
    if (good) okCase('①-2 未达标(3/4) → 照常派发（claim 成功）', `state=${after.state}`);
    else badCase('①-2 未达标不该被收敛', { got: got?.id ?? got, state: after?.state });
}

// 3. 边界：count === want（1/1）→ 收敛（`>=` 而不是 `>`）
{
    const { db } = freshDb();
    const job = addJob(db, {
        title: '刚好够', skill: 'mine', assignee: BOT,
        progress: { count: 1, want: 1 },
    });
    const got = claimFor(db, BOT);
    const after = getJob(db, job.id);
    const good = got === null && after.state === JOB_STATE.DONE;
    if (good) okCase('①-3 边界 count===want → 收敛（判据是 >= 不是 >）', `state=${after.state}`);
    else badCase('①-3 边界不该漏收敛', { got: got?.id ?? got, state: after?.state });
}

// 4. 没有 progress（want 未知）→ **不收敛**（want>0 才判），照常派发
{
    const { db } = freshDb();
    const job = addJob(db, { title: '没进度信息', skill: 'mine', assignee: BOT });
    const got = claimFor(db, BOT);
    const after = getJob(db, job.id);
    const good = got?.id === job.id && after.state === JOB_STATE.CLAIMED;
    if (good) okCase('①-4 want 未知(无 progress) → 不收敛、照常派发', `state=${after.state}`);
    else badCase('①-4 无 progress 不该被收敛', { got: got?.id ?? got, state: after?.state });
}

// ══════════════════════════════════════════════════════════════════════════
// ② dependsSatisfied：前置不存在 / blocked / failed 一律不放行
// ══════════════════════════════════════════════════════════════════════════

/** 造"前置单（指定状态）+ 后继单" */
function makeDepChain(depState, { depId = null } = {}) {
    const { db } = freshDb();
    const dep = addJob(db, {
        title: '前置', skill: 'mine', assignee: BOT, state: depState, id: depId ?? undefined,
    });
    const child = addJob(db, {
        title: '后继', skill: 'craft', assignee: BOT, why: 'needs-dep', dependsOn: [dep.id],
    });
    return { db, dep, child };
}

// 5. 前置不存在（dependsOn 指向一张库里没有的单）→ false → 领不到
{
    const { db } = freshDb();
    const child = addJob(db, {
        title: '孤儿后继', skill: 'craft', assignee: BOT, dependsOn: ['j_不存在_00000000'],
    });
    const got = claimFor(db, BOT);
    const after = getJob(db, child.id);
    const good = got === null && after.state === JOB_STATE.READY;
    if (good) okCase('②-1 前置**不存在** → 不放行（单仍 ready、领不到）', `state=${after.state}`);
    else badCase('②-1 前置不存在不该放行', { got: got?.id ?? got, state: after?.state });
}

// 6. 前置 blocked → false
{
    const { db, child } = makeDepChain(JOB_STATE.BLOCKED);
    const got = claimFor(db, BOT);
    const after = getJob(db, child.id);
    const good = got === null && after.state === JOB_STATE.READY;
    if (good) okCase('②-2 前置 blocked → 后继不放行（领不到）', `state=${after.state}`);
    else badCase('②-2 前置 blocked 不该放行', { got: got?.id ?? got, state: after?.state });
}

// 7. 前置 failed（终态，永远好不了）→ false
{
    const { db, child } = makeDepChain('failed');
    const got = claimFor(db, BOT);
    const after = getJob(db, child.id);
    const good = got === null && after.state === JOB_STATE.READY;
    if (good) okCase('②-3 前置 failed → 后继不放行（领不到）', `state=${after.state}`);
    else badCase('②-3 前置 failed 不该放行', { got: got?.id ?? got, state: after?.state });
}

// 8. 正向对照：前置 done → 放行（排除"永远不放行"的假绿，同 findStandNear ④-b 的思路）
{
    const { db, child } = makeDepChain(JOB_STATE.DONE);
    const got = claimFor(db, BOT);
    const after = getJob(db, child.id);
    const good = got?.id === child.id && after.state === JOB_STATE.CLAIMED;
    if (good) okCase('②-4 前置 done → 后继立刻可领（正向对照）', `state=${after.state}`);
    else badCase('②-4 前置 done 应该放行', { got: got?.id ?? got, state: after?.state });
}

// ══════════════════════════════════════════════════════════════════════════
// ★ 9. 「静默阻塞」实测（captain 点名要看的那条）
//
//    前置 blocked → 后继领不到；此刻库里**看不出它在等我**：
//      · 后继仍是 ready（不是 blocked，不会被 rollup 收走）
//      · dependsOn 仍指向那张 blocked 单
//      · result / interrupted 都是空 → **没有任何"我在等前置"的痕迹**
//    这就是"静默"：只能靠人肉去 join dependsOn 才知道，事件流里什么都没有。
//    ★ 本条只**记录当前行为**（照实钉死），不主张这是对的 —— 见报告里的"设计缺陷"。
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, dep, child } = makeDepChain(JOB_STATE.BLOCKED);
    const got = claimFor(db, BOT);
    const after = getJob(db, child.id);

    const stillReady = after.state === JOB_STATE.READY;
    const depStillBlocked = getJob(db, dep.id)?.state === JOB_STATE.BLOCKED;
    const pointsAtBlocked = Array.isArray(after.dependsOn) && after.dependsOn.includes(dep.id);
    const noTrace = after.result == null && after.interrupted == null;
    const neverClaimed = got === null;

    const good = stillReady && depStillBlocked && pointsAtBlocked && noTrace && neverClaimed;
    if (good) {
        okCase('★ ②-5 静默阻塞（实测）：前置 blocked → 后继 ready 卡住、dependsOn 仍指向它、无任何留痕',
            `child=${after.state} dep=${getJob(db, dep.id).state} dependsOn=${JSON.stringify(after.dependsOn)} result=${JSON.stringify(after.result)}`);
    } else {
        badCase('②-5 静默阻塞的预期形态不符（机制可能变了，须重判）', {
            claimed: got?.id ?? got, child: after.state, dep: getJob(db, dep.id)?.state,
            dependsOn: after.dependsOn, result: after.result, interrupted: after.interrupted,
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ ②-6 【T30 第5条 已修 → 硬断言】「静默阻塞」
//
//   修之前（XFAIL 记账）：前置 blocked 时后继永远 ready，库里**一丝痕迹都没有**，
//   只能人肉 join dependsOn 才知道它在等谁。现场后果：
//     后继单永久 ready（既不终态、又永远领不到）、父单永久 running —— 最长卡 166 分钟。
//
//   修之后：`depDead()` 判「任一依赖 ∈ failed/blocked/cancelled」，
//   由 `sweepDeadDepJobs()`（挂 scanTimer，周期性兜底）把后继落成
//   `blocked` + `result.code='DEP_DEAD'`，并把 `deps` 写进 result（直接能看出在等谁）。
//   ★ 本用例**不再是 XFAIL**：形态不对就判红。
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, dep, child } = makeDepChain(JOB_STATE.BLOCKED);
    const got = claimFor(db, BOT);              // 依赖没满足 → 仍然领不到（这条语义不变）
    const before = getJob(db, child.id);
    const swept = sweepDeadDepJobs(db, {});     // 兜底扫（scanTimer 每轮做的同一件事）
    const after = getJob(db, child.id);

    const good = got === null
        && before.state === JOB_STATE.READY
        && swept.length === 1 && swept[0].id === child.id
        && after.state === JOB_STATE.BLOCKED
        && after.result?.code === 'DEP_DEAD'
        && Array.isArray(after.result?.deps) && after.result.deps.includes(dep.id);
    if (good) {
        okCase('★ ②-6 依赖已死 → 兜底扫落 blocked + result.code=DEP_DEAD（留痕，不再静默）',
            `child=${after.state} code=${after.result?.code} deps=${JSON.stringify(after.result?.deps)}`);
    } else {
        badCase('②-6 依赖已死的后继没有被落地（第5条回归）', {
            claimed: got?.id ?? got, before: before.state, swept: swept.length,
            child: after.state, result: after.result,
        });
    }

    // ②-6-b 幂等：scanTimer 每 5 秒扫一次，已记账的不许重复写库
    const swept2 = sweepDeadDepJobs(db, {});
    const after2 = getJob(db, child.id);
    if (swept2.length === 0 && after2.state === JOB_STATE.BLOCKED && after2.result?.code === 'DEP_DEAD') {
        okCase('②-6-b 幂等：再扫一次不重复写（已记账的不再动）', 'swept2=0');
    } else {
        badCase('②-6-b 重复扫描不该重复写', { swept2: swept2.length, state: after2.state });
    }
}

// ②-6-c 正向对照：依赖**还活着**（running）→ 绝不能判死
//   （否则"工序还在做"会被提前废掉 —— 判据宽一格就是这个后果）
{
    const { db, child } = makeDepChain(JOB_STATE.RUNNING);
    const swept = sweepDeadDepJobs(db, {});
    const after = getJob(db, child.id);
    if (swept.length === 0 && after.state === JOB_STATE.READY && after.result == null) {
        okCase('②-6-c 正向对照：依赖 running（还活着）→ 不判死，后继仍 ready 且无痕',
            `state=${after.state}`);
    } else {
        badCase('②-6-c 依赖还活着却被判死', { swept: swept.length, state: after.state, result: after.result });
    }
}


console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过（②-6 已于 T30 第5条修好：XFAIL → 硬断言）`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
