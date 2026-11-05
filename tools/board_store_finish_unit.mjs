/**
 * `board_store.finish` 的分支回归（t65 盘点的 ③ + 顺带项）—— 离线，真 sqlite。
 *
 * 重点：t60 加的"**派了子单的策略单不按自己的 count 重试**"那一支
 * （`board_store.js:519` 的 `else if (kids.length && kidsAlive) → RUNNING`）。
 * 现有 `board_store_unit` 只有 2 条（一条正例用 ready 子单、一条"没有子单"的反证），
 * 这里补齐：claimed / running / paused 三种活子单、"子单全终结"、以及
 * "有活子单但父单自己 count 已达标"的分支顺序。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 本文件同时记录一个**真 bug**（未修改产品代码，等 captain 批）：
 *
 *    父单状态是 `running` + 有活子单时，`finish()` 算出的 next 也是 `running`，
 *    而状态转移表 `TRANSITIONS.running` **不含 'running'** → `!canTransition` →
 *    直接 `return {ok:false, code:'INTERNAL', message:'非法转移 running → running'}`，
 *    **数据库那一行一个字节都没动**。
 *
 *    为什么以前的用例是**假绿**：t60 那条断言"state===running && attempts===0"，
 *    而 bail-out 恰好也满足这两点（行没被改），所以它分不清
 *      · "我们决定挂着等"（正确）
 *      · "我们报错退出了"（现状）
 *    而 `strat_first_night` / `strat_obtain` 下父单时用的正是 `state:'running'`
 *    → **t60 的修复对它本来要修的那个场景根本走不到**。
 *
 *    处理：① 先按**应有契约**写断言（ok:true / next:'running'），当时实现会红
 *          → 用带 bug 指纹的 XFAIL 记录，避免"绿得可疑"。
 *          ② captain 用 `faed233` 修好（`next === job.state` 不再走转移校验）后，
 *          那 3 条自动变 XPASS → **已按指令摘掉 xfail，改成普通断言**（下面 ③-2 三组）。
 *          ③ 若同样的 bail-out 以后再回来，这 3 条会直接变红（不是 XFAIL）。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
    openBoard, addJob, getJob, finish, JOB_STATE,
    listJobs, setState, reopenBlockedWithSatisfiedDeps,
    claimFor, expireLeases, updateJob, LEASE_MS,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = join('tmp', 'board-finish-test');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); return openBoard(d); };

/** 造"父单（指定状态，running 时模拟策略单）+ 一张子单（指定状态）" */
function makeParentWithKid(parentState, kidState, { parentProgress = { count: 2, want: 8 }, maxAttempts = 3 } = {}) {
    const { db } = freshDb();
    const parent = addJob(db, {
        title: 'parent', skill: 'obtain', state: parentState, maxAttempts,
        progress: parentProgress,
    });
    const kid = addJob(db, { title: 'kid', skill: 'mine', parentId: parent.id, state: kidState });
    const r = finish(db, parent.id, { ok: true, code: 'OK', progress: parentProgress });
    return { db, parent: getJob(db, parent.id), kid: getJob(db, kid.id), r };
}

// ══════════════════════════════════════════════════════════════════════════
// ③-1~3 活子单（claimed / running / paused）→ 挂 running、不消耗 attempts
//    ★ 按应有契约断言；当前受 running→running 非法转移影响 → XFAIL
// ══════════════════════════════════════════════════════════════════════════
for (const kidState of [JOB_STATE.CLAIMED, JOB_STATE.RUNNING, JOB_STATE.PAUSED]) {
    // 父单用 'claimed'（claimed→running 合法）：这一路是 t60 那支**真的能走到**的路径，
    // 先用它证明"机制本身是对的"，再把父单换成 running 露出 bug（下一条）。
    const { parent, kid, r } = makeParentWithKid(JOB_STATE.CLAIMED, kidState);
    const good = r?.ok === true && r.next === JOB_STATE.RUNNING
        && parent.state === JOB_STATE.RUNNING && parent.attempts === 0;
    if (good) {
        okCase(`③-1 父 claimed + 子 ${kidState} → 父挂 running、attempts 不涨`,
            `next=${r.next} state=${parent.state} attempts=${parent.attempts} kid=${kid.state}`);
    } else {
        badCase(`③-1 父 claimed + 子 ${kidState} 应挂 running`, { r, state: parent.state, attempts: parent.attempts });
    }
}

for (const kidState of [JOB_STATE.CLAIMED, JOB_STATE.RUNNING, JOB_STATE.PAUSED]) {
    // ★ 生产实际形态：策略单下父单时用的就是 state:'running'。
    //   这一组是第 15 层 bug 的回归（captain 已用 faed233 修好，故为**硬断言**）：
    //   修之前 finish 会 bail-out 成 INTERNAL「非法转移 running → running」，行一字未动。
    const { parent, kid, r } = makeParentWithKid(JOB_STATE.RUNNING, kidState);
    const good = r?.ok === true && r.next === JOB_STATE.RUNNING
        && parent.state === JOB_STATE.RUNNING && parent.attempts === 0;
    if (good) {
        okCase(`③-2 父 running + 子 ${kidState} → 挂 running、attempts 不涨（生产真实形态）`,
            `next=${r.next} state=${parent.state} attempts=${parent.attempts} kid=${kid.state}`);
    } else {
        badCase(`③-2 父 running + 子 ${kidState} 应挂 running（第 15 层 bug 回来了？）`,
            { finish: { ok: r?.ok, code: r?.code, next: r?.next, message: r?.message }, state: parent.state, attempts: parent.attempts, kid: kid.state });
    }
}

// ③-4 子单**全终结**（done）→ 不满足 kidsAlive → 落到叶子分支（ok 但 count<want → READY + attempts+1）
//      ★ 这条与"**没有**子单"语义相同；真正要区分的是"有子单但都结束了"这条路径存在。
{
    const { parent, kid, r } = makeParentWithKid(JOB_STATE.CLAIMED, JOB_STATE.DONE);
    const good = r?.ok === true && r.next === JOB_STATE.READY
        && parent.state === JOB_STATE.READY && parent.attempts === 1 && kid.state === JOB_STATE.DONE;
    if (good) okCase('③-4 子单全终结(done) → 不进"等子单"分支，按叶子语义 READY + attempts+1',
        `next=${r.next} state=${parent.state} attempts=${parent.attempts}`);
    else badCase('③-4 子单全终结应落回叶子分支', { r, state: parent.state, attempts: parent.attempts, kid: kid.state });
}

// ③-5 ★ 有活子单 + 父单自己 count>=want → 分支顺序：completed 先命中 → **DONE**
//       captain 要我照实钉死"子单还活着父单却 done"到底是不是有意的。
//       （结论：是当前实现的既有顺序；本条只记录事实，不主张对错。）
{
    const { parent, kid, r } = makeParentWithKid(JOB_STATE.CLAIMED, JOB_STATE.RUNNING, {
        parentProgress: { count: 8, want: 8 },
    });
    const good = r?.ok === true && r.next === JOB_STATE.DONE
        && parent.state === JOB_STATE.DONE && kid.state === JOB_STATE.RUNNING;
    if (good) okCase('③-5 有活子单 + 父单自己已达标 → completed 先命中 → 父单 DONE（子单仍 running，照实记录）',
        `next=${r.next} parent=${parent.state} kid=${kid.state}`);
    else badCase('③-5 分支顺序与记录不符（须重判：completed 与 kidsAlive 谁先）',
        { r, parent: parent.state, kid: kid.state });
}

// ══════════════════════════════════════════════════════════════════════════
// 顺带项
// ══════════════════════════════════════════════════════════════════════════

/** 一次只干一件事的小工具：加单 → （可选）改状态 → finish */
function runFinish({ state = JOB_STATE.RUNNING, maxAttempts = 3, attempts = 0, result = {} , progress = null }) {
    const { db } = freshDb();
    const job = addJob(db, { title: 'x', skill: 'mine', state, maxAttempts, progress });
    if (attempts) db.prepare('UPDATE jobs SET attempts=? WHERE id=?').run(attempts, job.id);
    const r = finish(db, job.id, result);
    return { r, after: getJob(db, job.id) };
}

// ④ COUNT_CODES（TIMEOUT/STUCK/NO_PATH）耗尽 attempts → **FAILED**（全仓此前无一处断言 FAILED）
{
    const { r, after } = runFinish({
        maxAttempts: 1, attempts: 0, result: { ok: false, code: 'TIMEOUT', message: '超时' },
    });
    const good = r?.ok === true && r.counted === true && r.next === JOB_STATE.FAILED
        && after.state === JOB_STATE.FAILED && after.attempts === 1;
    if (good) okCase('④-1 TIMEOUT 且 attempts+1>=max → FAILED（counted=true）', `next=${r.next} attempts=${after.attempts}`);
    else badCase('④-1 COUNT_CODES 耗尽应 FAILED', { r, state: after.state, attempts: after.attempts });
}

// ⑤ ok 但 count<want 且**耗尽** → BLOCKED（不是 FAILED，也不是一直 READY）
{
    const { r, after } = runFinish({
        maxAttempts: 1, attempts: 0,
        result: { ok: true, code: 'OK', message: '', progress: { count: 2, want: 8 } },
    });
    const good = r?.ok === true && r.counted === true && r.next === JOB_STATE.BLOCKED
        && after.state === JOB_STATE.BLOCKED;
    if (good) okCase('④-2 ok 但不够 + attempts 耗尽 → BLOCKED（不是 FAILED）', `next=${r.next}`);
    else badCase('④-2 ok 但不够且耗尽应 BLOCKED', { r, state: after.state });
}

// ⑥ finish 的 progress 单调：先报 5/10，再报 3/10 → 库里仍是 5（报小不压小，留痕 reported）
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'mono', skill: 'mine', state: JOB_STATE.RUNNING, maxAttempts: 9 });
    finish(db, job.id, { ok: true, code: 'OK', progress: { count: 5, want: 10 } });
    finish(db, job.id, { ok: true, code: 'OK', progress: { count: 3, want: 10 } });
    const after = getJob(db, job.id);
    const good = Number(after.progress?.count) === 5;
    if (good) okCase('④-3 finish 的 progress 单调：后报 3 不覆盖先报 5', `count=${after.progress?.count} reported=${after.progress?.reported}`);
    else badCase('④-3 finish progress 被压小了', after.progress);
}

// ⑦ 单不存在 → NO_TARGET（不崩）
{
    const { db } = freshDb();
    const r = finish(db, 'j_不存在_00000000', { ok: true, code: 'OK' });
    const good = r?.ok === false && r.code === 'NO_TARGET';
    if (good) okCase('④-4 finish 找不到单 → NO_TARGET（不崩）', `code=${r.code}`);
    else badCase('④-4 finish 不存在单应 NO_TARGET', r);
}

// ⑧ 未知 code（既不在三个码表里）→ 计一次 attempts、回 READY
{
    const { r, after } = runFinish({
        maxAttempts: 9, attempts: 0, result: { ok: false, code: 'SOME_WEIRD_CODE', message: '??' },
    });
    const good = r?.ok === true && r.counted === true && r.next === JOB_STATE.READY && after.attempts === 1;
    if (good) okCase('④-5 未知 code → 计 attempts、回 READY（不吞、不 blocked）', `next=${r.next} attempts=${after.attempts}`);
    else badCase('④-5 未知 code 处理不符', { r, state: after.state, attempts: after.attempts });
}

// ── ⑤ t83：blocked 单的依赖后来满足了 → 必须能重开一次 ────────────────
//
// 真机（第 28 跑）：craft crafting_table 依赖的 craft oak_planks 已 done 4/4，
//   但它自己在材料到之前跑过一次 → NO_ITEM → blocked（终态）→ 永不重跑。
{
    const { db } = freshDb();
    addJob(db, { kind: 'personal', title: 'parent', skill: 'obtain',
        args: { item: 'crafting_table', count: 1 }, priority: 5, source: 'self',
        assignee: null, requires: [], claims: [], state: 'running', attempts: 0, maxAttempts: 3 });
    const parent = listJobs(db, {})[0];
    // 材料单：done
    addJob(db, { kind: 'personal', parentId: parent.id, title: 'planks', skill: 'craft',
        args: { item: 'oak_planks', count: 4 }, priority: 5, source: 'self',
        assignee: null, requires: [], claims: [], state: 'ready', attempts: 0, maxAttempts: 3 });
    const mat = listJobs(db, {}).find((j) => j.id !== parent.id);
    setState(db, mat.id, 'claimed'); setState(db, mat.id, 'running'); setState(db, mat.id, 'done');
    // 成品单：blocked，依赖已 done
    addJob(db, { kind: 'personal', parentId: parent.id, title: 'table', skill: 'craft',
        args: { item: 'crafting_table', count: 1 }, priority: 5, source: 'self',
        assignee: null, requires: [], claims: [], state: 'ready', attempts: 0, maxAttempts: 3,
        dependsOn: [mat.id] });
    const prod = listJobs(db, {}).find((j) => j.args?.item === 'crafting_table' && j.parentId === parent.id);
    setState(db, prod.id, 'claimed'); setState(db, prod.id, 'blocked');

    const reopened = reopenBlockedWithSatisfiedDeps(db, parent.id);
    const after = getJob(db, prod.id);
    const again = reopenBlockedWithSatisfiedDeps(db, parent.id);   // 第二次不许再开（只给一次）
    const after2 = getJob(db, prod.id);
    const good = reopened.length === 1 && after.state === 'ready'
        && after.checkpoint?.reopenedOnce === true
        && again.length === 0 && after2.state === 'ready';
    if (good) okCase('★ t83 依赖满足后 blocked 单重开一次（且只重开一次）',
        `reopened=${reopened.length} state=${after.state} 二次=${again.length}`);
    else badCase('t83 重开', { n: reopened.length, state: after.state, again: again.length });
}

// ⑤-b 反向验证：依赖**没**满足 → 不许重开
{
    const { db } = freshDb();
    addJob(db, { kind: 'personal', title: 'p2', skill: 'obtain', args: {}, priority: 5,
        source: 'self', assignee: null, requires: [], claims: [], state: 'running', attempts: 0 });
    const parent = listJobs(db, {})[0];
    addJob(db, { kind: 'personal', parentId: parent.id, title: 'm', skill: 'craft',
        args: { item: 'oak_planks', count: 4 }, priority: 5, source: 'self',
        assignee: null, requires: [], claims: [], state: 'ready', attempts: 0 });
    const mat = listJobs(db, {}).find((j) => j.id !== parent.id);
    addJob(db, { kind: 'personal', parentId: parent.id, title: 't', skill: 'craft',
        args: { item: 'crafting_table', count: 1 }, priority: 5, source: 'self',
        assignee: null, requires: [], claims: [], state: 'ready', attempts: 0, dependsOn: [mat.id] });
    const prod = listJobs(db, {}).find((j) => j.args?.item === 'crafting_table');
    setState(db, prod.id, 'claimed'); setState(db, prod.id, 'blocked');
    const reopened = reopenBlockedWithSatisfiedDeps(db, parent.id);
    const after = getJob(db, prod.id);
    if (reopened.length === 0 && after.state === 'blocked') {
        okCase('★ t83 反证：依赖未满足 → 不重开（仍是 blocked）', `n=${reopened.length}`);
    } else badCase('t83 依赖未满足却重开了', { n: reopened.length, state: after.state });
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ ④ 【T30 第4条】"这张单现在是别人的" —— 旧持有者调用 finish **必须失败**
//    （LEASE_STALE）且**一个字段都不写**。
//
//    改之前的病根：UPDATE 只有 `WHERE id=?`，**只认单号不认人**。于是
//      「A 的租约过期/被抢占 → 单子已经交给 B → A 的 finally 里那个 finish 晚到一步」
//    会把 **B 正在跑的单**写回 ready/done（B 的进度、租约被一并清空）。
//    改之后：`WHERE id=? AND (lease_owner IS NULL OR lease_owner=?)`，
//    `changes===0` → LEASE_STALE，一行不合。
//
//    ★ 注：`claimFor()` 同时会写 `assignee`，所以"另一个 bot 再领一次"这条路
//      在这里走不通（那是 assignee 与过期回收的另一条独立问题，不属本条）。
//      这里直接把租约转给 B（= 被抢占/人工改派后的库内形态），只测 finish 的归属判据。
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshDb();
    const t0 = 1000000;
    const job = addJob(db, { title: '被接手', skill: 'mine', priority: 5, progress: { count: 1, want: 4 } });

    const a = claimFor(db, 'A', { now: t0 });                                  // A 领到
    updateJob(db, job.id, { lease: { owner: 'B', until: t0 + 60000 } }, { now: t0 + 5 });  // 转手给 B
    const before = getJob(db, job.id);

    // A 迟到的 finish（自称做完 4/4）
    const r = finish(db, job.id, { ok: true, code: 'OK', progress: { count: 4, want: 4 } },
        { now: t0 + 10, bot: 'A' });
    const after = getJob(db, job.id);

    const untouched = after.state === before.state
        && after.attempts === before.attempts
        && after.lease?.owner === before.lease?.owner
        && after.lease?.until === before.lease?.until
        && String(after.progress?.count) === String(before.progress?.count)
        && JSON.stringify(after.result) === JSON.stringify(before.result);

    if (a?.id === job.id && before.lease?.owner === 'B'
        && r.ok === false && r.code === 'LEASE_STALE' && untouched) {
        okCase('★ ④ 单子已转给 B 后，A 的 finish 必须失败且一个字都不改',
            `code=${r.code} state=${after.state} attempts=${after.attempts} lease_owner=${after.lease?.owner}`);
    } else {
        badCase('④ 旧持有者的 finish 竟然写进去了（第4条回归）', {
            ok: r.ok, code: r.code,
            before: { st: before.state, at: before.attempts, owner: before.lease?.owner, count: before.progress?.count },
            after: { st: after.state, at: after.attempts, owner: after.lease?.owner, count: after.progress?.count },
        });
    }

    // ④-b 正向对照：租约属于 B → B 的 finish 正常生效（守卫没把正常路径一起关掉）
    const rb = finish(db, job.id, { ok: true, code: 'OK', progress: { count: 4, want: 4 } },
        { now: t0 + 11, bot: 'B' });
    const afterB = getJob(db, job.id);
    if (rb.ok === true && afterB.state === JOB_STATE.DONE) {
        okCase('④-b 正向对照：租约持有者本人的 finish 照常生效', `state=${afterB.state} next=${rb.next}`);
    } else {
        badCase('④-b 持有者自己的 finish 被误拒', { ok: rb.ok, code: rb.code, state: afterB.state });
    }
}

// ④-c 【T31 补充A 后**由放行翻转为拒绝**】老调用方（不传 bot）遇到**活租约**照样被拒
//
//    ★ 这条原来断言的是"不传 bot 就不做归属校验 → 照常写入"。
//      那是 T30 的 fail-open 行为，captain 已裁决**必须封掉**（那条 Must 级防护
//      对"漏传 bot 的调用方"等于不存在）。现在反过来钉：
//      不传 bot + 该行租约仍属于别人 → `LEASE_STALE`。
//      "无租约/已过期时照常放行"由 ⑤-b / ⑤-c 覆盖（老签名与离线工具走的就是那两种形态）。
{
    const { db } = freshDb();
    const t0 = 2000000;
    const job = addJob(db, { title: '老调用方', skill: 'mine', priority: 5, progress: { count: 0, want: 2 } });
    claimFor(db, 'A', { now: t0 });                       // A 持有活租约
    const r = finish(db, job.id, { ok: true, code: 'OK', progress: { count: 2, want: 2 } }, { now: t0 + 10 });
    const after = getJob(db, job.id);
    if (r.ok === false && r.code === 'LEASE_STALE' && after.state !== JOB_STATE.DONE) {
        okCase('④-c 不传 bot（老调用方）+ 活租约 → 拒绝（原 fail-open 已封，见 ⑤）',
            `code=${r.code} state=${after.state}`);
    } else {
        badCase('④-c 不传 bot 时又 fail open 了', { ok: r.ok, code: r.code, state: after.state });
    }
}

// ④-d 语义边界：**无租约**（过期后没人接手）→ 允许补写收尾。
//   这是有意的：判据是「没人持有 ⇒ 谁都可能是合法的收尾者」；与 heartbeat 的
//   LEASE_LOST（必须持有）不同 —— finish 是**收尾**，不该因为"刚过期"就丢掉结果。
{
    const { db } = freshDb();
    const t0 = 3000000;
    const job = addJob(db, { title: '过期无人接手', skill: 'mine', priority: 5, progress: { count: 0, want: 2 } });
    claimFor(db, 'A', { now: t0 });
    expireLeases(db, t0 + LEASE_MS + 1);                    // 过期回收 → lease_owner=NULL
    const r = finish(db, job.id, { ok: true, code: 'OK', progress: { count: 2, want: 2 } },
        { now: t0 + LEASE_MS + 2, bot: 'A' });
    const after = getJob(db, job.id);
    if (r.ok === true && after.state === JOB_STATE.DONE && after.attempts === 1) {
        okCase('④-d 无租约（过期后无人接手）→ 允许收尾（LEASE_STALE 只管"别人持有"）',
            `state=${after.state} attempts=${after.attempts}`);
    } else {
        badCase('④-d 无租约时不该被拒', { ok: r.ok, code: r.code, state: after.state, attempts: after.attempts });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ ⑤ 【T31 补充A】`finish` 未传 `bot` 时的 **fail-closed** 窗口
//
//    T30 加上了租约归属校验，但留了个洞：调用方**漏传** `bot` 时判据是空串 →
//    归属校验**静默消失**（fail open）。那条 Must 级防护等于对漏传者不存在。
//
//    现在只收紧危险窗口：`bot` 未传 **且** 该行 `lease_owner` 非空 **且** 租约
//    **还没过期** → `LEASE_STALE` + 一行 warn（"我说不清我是谁、但这单确实有人在跑"）。
//    其余情形（无租约 / 租约已过期 / 正常传了 bot）**行为完全不变**。
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshDb();
    const t0 = 4000000;
    const job = addJob(db, { title: '别人在跑', skill: 'mine', priority: 5, progress: { count: 1, want: 4 } });
    claimFor(db, 'A', { now: t0 });                      // A 持有**活**租约
    const before = getJob(db, job.id);
    const r = finish(db, job.id, { ok: true, code: 'OK', progress: { count: 4, want: 4 } },
        { now: t0 + 100 });                              // ← 故意不传 bot
    const after = getJob(db, job.id);
    const untouched = after.state === before.state && after.attempts === before.attempts
        && after.lease?.owner === before.lease?.owner
        && JSON.stringify(after.result) === JSON.stringify(before.result);
    if (r.ok === false && r.code === 'LEASE_STALE' && untouched) {
        okCase('★ ⑤ 不传 bot + 别人的**活**租约 → LEASE_STALE 且一字不写（fail closed）',
            `code=${r.code} owner=${after.lease?.owner} state=${after.state}`);
    } else {
        badCase('⑤ 漏传 bot 时 fail open 了（T30 留下的洞还在）', {
            ok: r.ok, code: r.code, before: before.state, after: after.state,
            owner: after.lease?.owner, result: after.result,
        });
    }

    // ⑤-b 反证边界①：**租约已过期** → 必须放行（这是"刚过期 1 秒、还没人接手"的合法收尾）
    {
        const { db: db2 } = freshDb();
        const j2 = addJob(db2, { title: '过期了', skill: 'mine', priority: 5, progress: { count: 0, want: 2 } });
        claimFor(db2, 'A', { now: t0 });
        expireLeases(db2, t0 + LEASE_MS + 1);            // 过期回收 → lease_owner=NULL
        const r2 = finish(db2, j2.id, { ok: true, code: 'OK', progress: { count: 2, want: 2 } },
            { now: t0 + LEASE_MS + 2 });
        const a2 = getJob(db2, j2.id);
        if (r2.ok === true && a2.state === JOB_STATE.DONE) {
            okCase('⑤-b 边界：租约**已过期** + 不传 bot → 照常放行（不误杀残局收尾）', `state=${a2.state}`);
        } else {
            badCase('⑤-b 过期后漏传 bot 被误拒', { ok: r2.ok, code: r2.code, state: a2.state });
        }
    }

    // ⑤-c 反证边界②：**本来就没有租约**的单（离线工具/老签名的典型形态）→ 必须放行
    {
        const { db: db3 } = freshDb();
        const j3 = addJob(db3, { title: '无租约', skill: 'mine', priority: 5, progress: { count: 0, want: 1 } });
        const r3 = finish(db3, j3.id, { ok: true, code: 'OK', progress: { count: 1, want: 1 } }, { now: t0 });
        const a3 = getJob(db3, j3.id);
        if (r3.ok === true && a3.state === JOB_STATE.DONE) {
            okCase('⑤-c 边界：**无租约**的单 + 不传 bot → 照常放行（老签名/离线工具不受影响）', `state=${a3.state}`);
        } else {
            badCase('⑤-c 无租约单被误拒', { ok: r3.ok, code: r3.code, state: a3.state });
        }
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过  （第 15 层 bug 已由 faed233 修好，原 3 条 XFAIL 已转硬断言）`);

console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
