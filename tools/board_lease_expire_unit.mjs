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
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
    openBoard, addJob, getJob, claimFor, expireLeases, JOB_STATE, LEASE_MS, BOARD_RESULT_CODES,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = join('tmp', 'board-lease-test');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
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

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
