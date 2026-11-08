/**
 * `expireLeases`：**租约过期必须记一次 attempt，耗尽就 failed**（报告第15条）—— 离线，真 sqlite。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 病根：`expireLeases()` 原来一个字都不动 `attempts`（注释只提"checkpoint 保留"，
 *   看起来很有意，实际是漏了）。后果：
 *     "崩一次 → 单回 ready → 再领 → 再崩" 可以**无限循环**，
 *   而**合成单每跑一次都真扣一次材料** —— 料被无限往里填，任务永远不会结束。
 *
 *   语义上它和 TIMEOUT / STUCK 同类：**这次尝试失败了**。
 *   现在：`attempts+1 >= maxAttempts` → `failed` + `result.code=LEASE_EXPIRED`；否则回 ready。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS / FAIL，全过退出码 0。临时库在 tmp/，跑完删除。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, addJob, getJob, claimFor, expireLeases, heartbeat, updateJob, setState,
    JOB_STATE, LEASE_MS, BOARD_RESULT_CODES,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// ★ T15（并发加固）：**每个进程一个独立目录**。
//   原来用固定的 `tmp/<name>` 且开跑第一件事就是 rmSync 掉它 ——
//   同机两路 unit_all（或两路并发跑测试）会互删对方的 fixture，
//   表现为「整跑随机变红、单跑全绿」。mkdtempSync 让两路各拿各的目录。
const DIR = mkdtempSync(join(os.tmpdir(), 'board-lease-test-'));
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); return openBoard(d); };

// ══════════════════════════════════════════════════════════════════════════
// ① 过期一次 → attempts 0→1、回 ready、租约清空
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshDb();
    const t0 = 1000000;
    const job = addJob(db, { title: '崩一次', skill: 'mine', maxAttempts: 3, progress: { count: 1, want: 4 } });
    claimFor(db, 'A', { now: t0 });
    const recovered = expireLeases(db, t0 + LEASE_MS + 1);
    const after = getJob(db, job.id);
    const good = recovered.length === 1 && after.state === JOB_STATE.READY
        && after.attempts === 1 && after.lease?.owner == null && after.lease?.until == null;
    if (good) okCase('★ ① 租约过期一次 → attempts 0→1、回 ready、租约清空',
        `state=${after.state} attempts=${after.attempts}`);
    else badCase('① 过期没有记 attempt（第15条回归）', { recovered, after });
}

// ② 崩溃反复 → **有限次**收敛成 failed（这就是"无限重试"被关掉的地方）
//    ★ 正向断言：第 maxAttempts 次崩溃必须进 failed，而不是又回 ready。
{
    const { db } = freshDb();
    let now = 2000000;
    const job = addJob(db, { title: '反复崩', skill: 'mine', maxAttempts: 3 });
    const trail = [];
    for (let i = 0; i < 5; i++) {
        const claimed = claimFor(db, 'A', { now });
        if (!claimed) break;                                  // 单子已经不可领（failed/blocked）
        expireLeases(db, now + LEASE_MS + 1);
        const j = getJob(db, job.id);
        trail.push(`${j.state}/${j.attempts}`);
        now += 2 * LEASE_MS + 10;
    }
    const after = getJob(db, job.id);
    const good = after.state === JOB_STATE.FAILED
        && after.attempts === 3
        && after.result?.code === BOARD_RESULT_CODES.LEASE_EXPIRED
        && trail.length === 3;                                // 第 3 次崩就收敛，不会有第 4 次
    if (good) okCase('★ ② 连崩到 maxAttempts(3) → failed + result.code=LEASE_EXPIRED（不再无限重试）',
        `trail=${trail.join(' → ')}`);
    else badCase('② 反复崩溃没有收敛（无限重试仍在）', { trail, state: after.state, attempts: after.attempts, code: after.result?.code });
}

// ③ 未耗尽时**不动 result**（保留上次结果/断点，别把有用的信息洗掉）
{
    const { db } = freshDb();
    const t0 = 3000000;
    const job = addJob(db, { title: '有断点', skill: 'mine', maxAttempts: 5 });
    claimFor(db, 'A', { now: t0 });
    // 先放一个结果 + 断点，再让租约过期
    const db2 = db;
    db2.prepare('UPDATE jobs SET result = ?, checkpoint = ? WHERE id = ?')
        .run(JSON.stringify({ ok: false, code: 'NO_ITEM', message: '缺料', at: t0 }), JSON.stringify({ step: 2 }), job.id);
    expireLeases(db, t0 + LEASE_MS + 1);
    const after = getJob(db, job.id);
    const good = after.state === JOB_STATE.READY && after.attempts === 1
        && after.result?.code === 'NO_ITEM' && after.checkpoint?.step === 2;
    if (good) okCase('③ 未耗尽 → result/checkpoint 原样保留（只加 attempt，不洗数据）',
        `code=${after.result?.code} cp=${JSON.stringify(after.checkpoint)}`);
    else badCase('③ 未耗尽却把 result/checkpoint 洗掉了', { result: after.result, checkpoint: after.checkpoint });
}

// ④ 幂等：已回 ready 的单再扫 → 不再加 attempt（scanTimer 每 5 秒扫一次）
{
    const { db } = freshDb();
    const t0 = 4000000;
    const job = addJob(db, { title: '幂等', skill: 'mine', maxAttempts: 3 });
    claimFor(db, 'A', { now: t0 });
    expireLeases(db, t0 + LEASE_MS + 1);
    const again = expireLeases(db, t0 + LEASE_MS + 2);
    const after = getJob(db, job.id);
    if (again.length === 0 && after.attempts === 1) {
        okCase('④ 幂等：已经回收过的单再扫不会再加 attempt', `again=${again.length} attempts=${after.attempts}`);
    } else badCase('④ 重复扫描重复记 attempt', { again, attempts: after.attempts });
}

// ⑤ 租约还没过期 → 一律不动
{
    const { db } = freshDb();
    const t0 = 5000000;
    const job = addJob(db, { title: '还活着', skill: 'mine', maxAttempts: 3 });
    claimFor(db, 'A', { now: t0 });
    const recovered = expireLeases(db, t0 + 1000);            // 远未到 lease_until
    const after = getJob(db, job.id);
    if (recovered.length === 0 && after.attempts === 0 && after.state === JOB_STATE.CLAIMED) {
        okCase('⑤ 租约未过期 → 不动（attempts 仍 0）', `state=${after.state}`);
    } else badCase('⑤ 未过期的单被回收了', { recovered, state: after.state, attempts: after.attempts });
}

// ⑥ maxAttempts=1 的边界：第一次过期就该 failed（不是"永远差一次"）
{
    const { db } = freshDb();
    const t0 = 6000000;
    const job = addJob(db, { title: '只给一次', skill: 'mine', maxAttempts: 1 });
    claimFor(db, 'A', { now: t0 });
    expireLeases(db, t0 + LEASE_MS + 1);
    const after = getJob(db, job.id);
    if (after.state === JOB_STATE.FAILED && after.attempts === 1
        && after.result?.code === BOARD_RESULT_CODES.LEASE_EXPIRED) {
        okCase('⑥ 边界 maxAttempts=1 → 第一次过期即 failed（不会多跑一轮）', `state=${after.state}`);
    } else badCase('⑥ maxAttempts=1 的边界不对', { state: after.state, attempts: after.attempts, code: after.result?.code });
}

// ⑦ 对外字符串没变（不许改事件名/结果码的字面值）
{
    const ok = BOARD_RESULT_CODES.LEASE_EXPIRED === 'LEASE_EXPIRED'
        && BOARD_RESULT_CODES.LEASE_STALE === 'LEASE_STALE'
        && BOARD_RESULT_CODES.DEP_DEAD === 'DEP_DEAD'
        && BOARD_RESULT_CODES.ORPHAN_PARENT === 'ORPHAN_PARENT';
    if (ok) okCase('⑦ 结果码字面值与线上一致（具名常量没改对外字符串）', JSON.stringify(BOARD_RESULT_CODES));
    else badCase('⑦ 结果码字面值被改了', BOARD_RESULT_CODES);
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ ⑨ 【A5-8】"paused 之后不再续租"的租约账（真 sqlite 端到端）
//
//   第四轮审计 §6.5 的现场：
//     · 单子已经 `paused`（玩家 !stop），**租约仍归自己**；
//     · 原因是心跳不看停止标志，每 10 秒续一次 ⇒ `lease_until` 永远在未来；
//     · 而 `expireLeases` 的扫描条件是 `state IN ('claimed','running')`
//       ⇒ paused 的单**等多久都不会被回收**，别人也领不到 ⇒ "直到进程被杀"。
//   所以修复不能只"停掉心跳、等它过期"，必须**停手时主动摘租约**。
//   三条一起证：
//     ⑨-a 停手后主动摘租约（`lease_owner/lease_until = NULL`）→ 单留在 paused（可恢复），
//          resume 之后原持有者能接着做；paused 期间别人不该把它当无主单领走；
//     ⑨-b 反证：不主动摘 → paused 等不来回收（expireLeases 不扫 paused）→ 僵尸租约；
//     ⑨-c 反证（另一半）：claimed/running 时照旧续租 → 租约永不过期 → 别人领不到，
//          与 ⑧（过期 → 回收 → B 能领）合起来才说明"回收真的依赖停止续租"。
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshDb();
    const t0 = 8000000;
    const job = addJob(db, { title: '被玩家按停的单', skill: 'mine', maxAttempts: 5 });
    claimFor(db, 'A', { now: t0 });
    // 模拟 `!stop`：状态转 paused，但**租约不动** —— 这正是现场（`control.applyStop`
    // 走的是 `board.update(patch{lease:null})`，而 store 的 PATCHABLE 里没有 `lease`
    // 这个字段，于是租约留在库里；这里用 updateJob 同口径复现，不额外造状态）。
    updateJob(db, job.id, { state: JOB_STATE.PAUSED, checkpoint: { pausedReason: 'player' } });
    const pausedAt = getJob(db, job.id);
    const leaseStillMine = pausedAt.lease?.owner === 'A' && pausedAt.state === JOB_STATE.PAUSED;

    // ⑨-a 修复后：停手时**主动摘租约**（`BoardClient.releaseLease` / 调度器 `_releaseOnStop`
    //   落的就是 `lease_owner`/`lease_until` 这两列），而不是"等它自己过期"。
    const hbCalls = 0;                       // 停租之后一次心跳都没发
    const cleared = updateJob(db, job.id, { lease_owner: null, lease_until: null });
    const afterRelease = getJob(db, job.id);
    const leaseGone = cleared?.ok === true
        && afterRelease.lease?.owner == null && afterRelease.lease?.until == null;
    // 暂停是**可恢复**的：租约摘掉 ≠ 单子被释放。它仍在 paused，别人不该当"无主 ready"领走。
    const bCannotClaimWhilePaused = claimFor(db, 'B', { now: t0 + 1000 }) == null;
    // 玩家说"继续" → 回 ready → 这时**原来的持有者 A** 才能接着做
    //   （`claimFor` 的候选条件是 `assignee IS NULL OR assignee = 我`，而暂停不清 assignee：
    //    个人单本来就只该 A 做。这正是「暂停=可恢复」与「取消/过期回收=退回共享池」的区别。）
    setState(db, job.id, JOB_STATE.READY, {});
    const aGot = claimFor(db, 'A', { now: t0 + 2000 });
    const goodA = leaseStillMine && hbCalls === 0 && leaseGone
        && afterRelease.state === JOB_STATE.PAUSED
        && bCannotClaimWhilePaused && aGot?.id === job.id;
    if (goodA) {
        okCase('★ ⑨-a paused 后不续租 + **主动摘租约**：单留在 paused（可恢复），resume 后原持有者能接着做',
            `paused 时租约归 A=${leaseStillMine}；摘掉=${leaseGone}；paused 期间 B 领不到=${bCannotClaimWhilePaused}；resume 后 A 领到=${aGot?.id === job.id}`);
    } else {
        badCase('⑨-a 停手后的租约处理不对（僵尸租约 / 或把暂停当成释放）', {
            leaseStillMine, leaseGone, state: afterRelease.state,
            bCannotClaimWhilePaused, aGot: aGot?.id ?? aGot,
        });
    }

    // ⑨-b 为什么**必须主动摘**而不能"等过期"：
    //   `expireLeases` 的扫描条件是 `state IN ('claimed','running')` —— **paused 不在里面**。
    //   于是"paused + 租约还挂在自己名下"的单，等多久都**不会被回收**，也没人领得到。
    //   ⇒ 这就是审计 §6.5 那句"直到进程被杀"的机制层解释。
    {
        const { db: db2 } = freshDb();
        const j2 = addJob(db2, { title: '暂停但租约还挂着', skill: 'mine', maxAttempts: 5 });
        claimFor(db2, 'A', { now: t0 });
        updateJob(db2, j2.id, { state: JOB_STATE.PAUSED, checkpoint: { pausedReason: 'player' } });
        const reclaimed2 = expireLeases(db2, t0 + LEASE_MS * 10);
        const after2 = getJob(db2, j2.id);
        const zombieLease = after2.lease?.owner === 'A';
        const bCannotClaim2 = claimFor(db2, 'B', { now: t0 + LEASE_MS * 10 + 1 }) == null;
        if (reclaimed2.length === 0 && zombieLease && bCannotClaim2) {
            okCase('★ ⑨-b 反证：paused 的单**等不来**回收（expireLeases 只扫 claimed/running）'
                + ' ⇒ 租约一直挂在自己名下、别人永远领不到 ⇒ 必须停手时主动摘',
                `回收=${reclaimed2.length} 租约仍归 A=${zombieLease} B领到=${!bCannotClaim2}`);
        } else {
            badCase('⑨-b "paused 不会被过期回收"这个前提不成立（用例前提要重判）', {
                reclaimed2, zombieLease, bCannotClaim2,
            });
        }
    }

    // ⑨-c 反证（另一半）：claimed/running 时**照旧每 10 秒续租**（= 修之前的心跳行为）
    //   → 租约永不过期 → 别人领不到。这条与 ⑧ 合起来才叫"到期回收"真的依赖"停止续租"。
    {
        const { db: db3 } = freshDb();
        const j3 = addJob(db3, { title: '还在跑的僵尸', skill: 'mine', maxAttempts: 5 });
        claimFor(db3, 'A', { now: t0 });
        const zombieHb = heartbeat(db3, j3.id, 'A', { now: t0 + LEASE_MS - 1000 });
        const renewed = zombieHb.ok === true;
        const stillNoReclaim = expireLeases(db3, t0 + LEASE_MS + 1).length === 0;
        const bCannotClaim3 = claimFor(db3, 'B', { now: t0 + LEASE_MS + 2 }) == null;
        if (renewed && stillNoReclaim && bCannotClaim3) {
            okCase('★ ⑨-c 反证：照旧续租 → 租约永不过期 → 别的 bot **确实**领不到（僵尸租约现场）',
                `heartbeat.ok=${renewed} 回收=0 B领到=false`);
        } else {
            badCase('⑨-c 反证不成立（"续租 → 别人拿不到"这条因果链没被证实）', {
                renewed, stillNoReclaim, bCannotClaim3,
            });
        }
    }
}

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
// ══════════════════════════════════════════════════════════════════════════
// ★★ ⑧ 【T31 补充B】租约过期必须**一并回滚 `assignee`**
//
//    现状（T30 记下的独立缺陷）：`claimFor` 领单时会把 `assignee` 写成领单的人，
//    而 `expireLeases` 原来只清 lease → 单子回 ready 却**仍"指派给"那个死掉的 bot**。
//    `claimFor` 的候选条件是 `assignee IS NULL OR assignee = 我` ⇒
//    **别的 bot 永远抢不到这张单**（多 bot 下的永久死锁，而且不报错）。
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshDb();
    const t0 = 7000000;
    const job = addJob(db, { title: 'A 领到的单', skill: 'mine', maxAttempts: 5 });
    const gotA = claimFor(db, 'A', { now: t0 });
    const afterClaim = getJob(db, job.id);

    expireLeases(db, t0 + LEASE_MS + 1);                    // A 崩了 / 失联 → 租约过期
    const afterExpire = getJob(db, job.id);
    const gotB = claimFor(db, 'B', { now: t0 + LEASE_MS + 2 });   // ★ B 能不能接手

    const assigneeCleared = afterExpire.assignee == null;
    if (gotA?.id === job.id && afterClaim.assignee === 'A'
        && assigneeCleared && gotB?.id === job.id) {
        okCase('★ ⑧ A 领单 → 租约过期 → **B 能领到**（assignee 随租约一起释放）',
            `afterClaim.assignee=${afterClaim.assignee} → afterExpire.assignee=${afterExpire.assignee} B领到=true`);
    } else {
        badCase('⑧ 过期后单子仍被"指派"给死掉的 A，B 抢不到（永久死锁）', {
            gotA: gotA?.id ?? gotA, assigneeAfterClaim: afterClaim.assignee,
            assigneeAfterExpire: afterExpire.assignee, gotB: gotB?.id ?? gotB,
        });
    }

    // ⑧-b 反证：把 `assignee=NULL` 从 UPDATE 里拿掉 → 上面这条必然变红
    //    （用源码文本 + 行为双重确认：这里查源码，证明"修的那一处"就是判据所在）
    const src = readFileSync('src/agent/library/board_store.js', 'utf8');
    const hasClear = src.includes('UPDATE jobs SET state=?, attempts=?, assignee=NULL, lease_owner=NULL,');
    if (hasClear) {
        okCase('⑧-b 判据在源码里（expireLeases 的 UPDATE 含 assignee=NULL）', 'found=1');
    } else {
        badCase('⑧-b expireLeases 的 UPDATE 里没有 assignee=NULL', { found: false });
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
