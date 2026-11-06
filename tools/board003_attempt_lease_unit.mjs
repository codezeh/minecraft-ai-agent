/**
 * BOARD-003（2026-11-06 深度检查，P2）—— 租约只核对机器人名字，旧尝试能结束同名机器人的新尝试。
 *
 * 缺陷原貌（报告 01-完整检查报告.md "### BOARD-003"）：
 *   收尾（finish/heartbeat/checkpoint）的条件 UPDATE 只看 `lease_owner = 我`。
 *   于是「租约过期被回收 → **同名**机器人再领（新尝试）」之后，**旧尝试的迟到结果**
 *   仍然满足 `lease_owner = 我` → 被当成当前尝试的结果接受：清掉新租约、把任务置 done。
 *   报告实测：claim1 → expireLeases → 同名 claim2 → 提交旧 finish，staleAccepted=true、最终 done。
 *   （`attemptSeq` 在库里早就有，只是**从没用于收尾归属校验**。）
 *
 * 修复后应成立的判据（报告"回归验收"原文）：
 *   ① 同名重连：旧尝试的 finish/heartbeat/checkpoint **一律不生效**，且返回稳定的租约失效码；
 *   ② 异名接手：旧持有者的迟到写入同样不生效；
 *   ③ 重复 finish：同一次尝试重复收尾不会把新尝试的单改坏；
 *   ④ 旧尝试不得修改新尝试的任何字段（状态、租约、进度、断点）。
 *
 * 全部离线：临时目录里的真 sqlite 文件 + 假时钟（不 sleep）；协议层用假 socket 对。
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, addJob, getJob, claimFor, finish, heartbeat, expireLeases, updateJob,
    BOARD_RESULT_CODES, LEASE_MS, JOB_STATE,
} from '../src/agent/library/board_store.js';
import { attemptSeqOfJob } from '../src/agent/library/board_claims.js';
import { attachBoardServer } from '../src/agent/library/board_server.js';
import { BoardClient } from '../src/agent/library/board_client.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const DIR = mkdtempSync(join(os.tmpdir(), 'board003-'));
let dbSeq = 0;
const freshDb = () => openBoard(join(DIR, `db${++dbSeq}`)).db;

const T0 = 1_700_000_000_000;
const OK_RESULT = { ok: true, code: 'OK', progress: { count: 1, want: 1 } };

/** 报告原样复现的四步：领 → 租约过期 → 同名再领 → 旧尝试迟到收尾。 */
function claimExpireReclaim(db, bot = 'worker') {
    const job = addJob(db, { skill: 'mine', title: '会被同名重领的单', priority: 5 }, { now: T0 });
    const c1 = claimFor(db, bot, { now: T0, leaseMs: LEASE_MS });
    const seq1 = attemptSeqOfJob(c1);
    // 租约过期回收（假时钟，直接跳到租约之后）
    const expired = expireLeases(db, T0 + LEASE_MS + 1000);
    const c2 = claimFor(db, bot, { now: T0 + LEASE_MS + 2000, leaseMs: LEASE_MS });
    const seq2 = attemptSeqOfJob(c2);
    return { job, seq1, seq2, expiredCount: expired.length };
}

// ── ① 报告原样：同名重领后，旧尝试的 finish 必须被拒 ────────────────────
{
    const db = freshDb();
    const { job, seq1, seq2, expiredCount } = claimExpireReclaim(db);
    check('① 第一次领单拿到尝试序号 1', seq1 === 1, `seq1=${seq1}`);
    check('① 租约过期后回收成功', expiredCount === 1, `expired=${expiredCount}`);
    check('① 同名再领拿到**新的**尝试序号 2', seq2 === 2, `seq2=${seq2}`);

    const stale = finish(db, job.id, OK_RESULT, { now: T0 + LEASE_MS + 3000, bot: 'worker', attemptSeq: seq1 });
    const after = getJob(db, job.id);
    check('① 旧尝试的迟到 finish 被拒（修复前 staleAccepted=true）',
        stale.ok === false, `ok=${stale.ok} code=${stale.code ?? ''}`);
    check('① 拒绝码是稳定的 LEASE_STALE',
        stale.code === BOARD_RESULT_CODES.LEASE_STALE, `code=${stale.code ?? ''}`);
    check('① 新尝试的单**没有**被改成 done（缺陷原貌：最终 done）',
        after.state !== JOB_STATE.DONE, `state=${after.state}`);
    check('① 新尝试的租约没被清掉（lease_owner 仍是 worker）',
        after.lease?.owner === 'worker' && Number.isFinite(Number(after.lease?.until)),
        `lease=${JSON.stringify(after.lease)}`);
    check('① 当前尝试序号仍是 2（没被旧请求改回去）', attemptSeqOfJob(after) === 2,
        `seq=${attemptSeqOfJob(after)}`);

    // 当前尝试自己收尾 → 正常接受
    const fresh = finish(db, job.id, OK_RESULT, { now: T0 + LEASE_MS + 4000, bot: 'worker', attemptSeq: seq2 });
    check('① 当前尝试自己的 finish 正常生效', fresh.ok === true && fresh.next === JOB_STATE.DONE,
        `ok=${fresh.ok} next=${fresh.next ?? ''} code=${fresh.code ?? ''}`);
}

// ── ② 迟到 heartbeat 不得给新尝试续租 ──────────────────────────────────
{
    const db = freshDb();
    const { job, seq1, seq2 } = claimExpireReclaim(db);
    const before = getJob(db, job.id).lease.until;
    const hb = heartbeat(db, job.id, 'worker', { now: T0 + LEASE_MS + 2500, attemptSeq: seq1 });
    const after = getJob(db, job.id);
    check('② 旧尝试的心跳被拒（LEASE_LOST）', hb.ok === false && hb.code === 'LEASE_LOST',
        `ok=${hb.ok} code=${hb.code ?? ''}`);
    check('② 新尝试的租约到期时间没被旧心跳推走', after.lease.until === before,
        `before=${before} after=${after.lease.until}`);
    const hb2 = heartbeat(db, job.id, 'worker', { now: T0 + LEASE_MS + 2600, attemptSeq: seq2 });
    check('② 当前尝试自己的心跳正常', hb2.ok === true, `ok=${hb2.ok} code=${hb2.code ?? ''}`);
}

// ── ③ 迟到 checkpoint 不得写进新尝试 ───────────────────────────────────
{
    const db = freshDb();
    const { job, seq1 } = claimExpireReclaim(db);
    const cpBefore = getJob(db, job.id).checkpoint;
    const r = updateJob(db, job.id, { checkpoint: { step: 'OLD-ATTEMPT-LATE-WRITE' } },
        { now: T0 + LEASE_MS + 3000, attemptSeq: seq1 });
    const after = getJob(db, job.id).checkpoint;
    check('③ 旧尝试的 checkpoint 写入被拒', r.ok === false && r.code === BOARD_RESULT_CODES.LEASE_STALE,
        `ok=${r.ok} code=${r.code ?? ''}`);
    check('③ 断点内容没被旧尝试改掉', JSON.stringify(after) === JSON.stringify(cpBefore),
        `before=${JSON.stringify(cpBefore)} after=${JSON.stringify(after)}`);
}

// ── ④ 异名接手：旧持有者的迟到写入同样不生效 ───────────────────────────
{
    const db = freshDb();
    const job = addJob(db, { skill: 'mine', title: '换人接手', priority: 5 }, { now: T0 });
    const c1 = claimFor(db, 'alpha', { now: T0, leaseMs: LEASE_MS });
    const seqA = attemptSeqOfJob(c1);
    expireLeases(db, T0 + LEASE_MS + 1000);
    const c2 = claimFor(db, 'beta', { now: T0 + LEASE_MS + 2000, leaseMs: LEASE_MS });
    const seqB = attemptSeqOfJob(c2);

    const stale = finish(db, job.id, OK_RESULT, { now: T0 + LEASE_MS + 3000, bot: 'alpha', attemptSeq: seqA });
    check('④ 异名旧持有者的迟到 finish 被拒', stale.ok === false
        && stale.code === BOARD_RESULT_CODES.LEASE_STALE, `ok=${stale.ok} code=${stale.code ?? ''}`);
    check('④ 接手者的租约还在', getJob(db, job.id).lease?.owner === 'beta',
        `owner=${getJob(db, job.id).lease?.owner}`);
    const mine = finish(db, job.id, OK_RESULT, { now: T0 + LEASE_MS + 4000, bot: 'beta', attemptSeq: seqB });
    check('④ 接手者自己收尾正常', mine.ok === true, `ok=${mine.ok} code=${mine.code ?? ''}`);
}

// ── ⑤ 重复 finish（同一次尝试）：不会把状态改坏，也不会二次计数 ──────────
{
    const db = freshDb();
    const job = addJob(db, { skill: 'mine', title: '重复收尾', priority: 5 }, { now: T0 });
    const c = claimFor(db, 'worker', { now: T0, leaseMs: LEASE_MS });
    const seq = attemptSeqOfJob(c);
    const first = finish(db, job.id, OK_RESULT, { now: T0 + 10, bot: 'worker', attemptSeq: seq });
    const attempts1 = getJob(db, job.id).attempts;
    const second = finish(db, job.id, OK_RESULT, { now: T0 + 20, bot: 'worker', attemptSeq: seq });
    const after = getJob(db, job.id);
    check('⑤ 第一次收尾生效', first.ok === true && after.state === JOB_STATE.DONE,
        `ok=${first.ok} state=${after.state}`);
    check('⑤ 重复收尾不会把已完成的单改回 ready/二次计数',
        after.state === JOB_STATE.DONE && after.attempts === attempts1,
        `state=${after.state} attempts=${after.attempts} first=${attempts1}`);
    // ★ 不断言 `second.ok === false`：这张单已经 done、租约已清，"同一次尝试重复收尾"
    //   在 store 里是**幂等写**（结果被同一份内容覆盖），这不是 BOARD-003 要防的事
    //   （要防的是"旧尝试改掉**新尝试**"）。这里只锁"状态/计数没被改坏"。
    check('⑤ 重复收尾是幂等的（结果字段与状态都不变）',
        second.ok !== undefined && getJob(db, job.id).result?.code === 'OK',
        `secondOk=${second.ok} resultCode=${getJob(db, job.id).result?.code}`);
}

// ── ⑥ 向后兼容：老调用方不带尝试标识 → 行为完全不变（不 fail closed）──────
{
    const db = freshDb();
    const job = addJob(db, { skill: 'mine', title: '老客户端', priority: 5 }, { now: T0 });
    claimFor(db, 'worker', { now: T0, leaseMs: LEASE_MS });
    const r = finish(db, job.id, OK_RESULT, { now: T0 + 10, bot: 'worker' });   // 不带 attemptSeq
    check('⑥ 不带尝试标识的 finish 仍按老行为接受（老客户端不能崩）',
        r.ok === true && r.next === JOB_STATE.DONE, `ok=${r.ok} next=${r.next ?? ''}`);
}

// ── ⑦ 断点被"整份覆盖"之后，旧尝试的迟到 finish 仍必须被拒 ──────────────
//    （`board:checkpoint` 是整份替换 checkpoint 的；如果把尝试序号只存在
//      checkpoint 里，一次普通断点写入就会把它抹掉 → 守卫 fail-open，
//      旧尝试又能结束新尝试。这条用例锁的就是"归属不能存在会被覆盖的地方"。）
{
    const db = freshDb();
    const { job, seq1 } = claimExpireReclaim(db);
    // 当前尝试（2）正常写了断点：只带业务字段，不含 attemptSeq
    updateJob(db, job.id, { checkpoint: { step: 1 } }, { now: T0 + LEASE_MS + 2500 });
    const stale = finish(db, job.id, OK_RESULT, { now: T0 + LEASE_MS + 3000, bot: 'worker', attemptSeq: seq1 });
    check('⑦ 断点被整份覆盖后，旧尝试的迟到 finish 仍被拒',
        stale.ok === false, `ok=${stale.ok} code=${stale.code ?? ''}`);
    check('⑦ 单没有被旧尝试改成 done', getJob(db, job.id).state !== JOB_STATE.DONE,
        `state=${getJob(db, job.id).state}`);
}

// ── ⑧ 协议层端到端：两个**同名**客户端（进程崩了重连的真实形态）──────────
{
    const db = freshDb();
    const handlers = new Map();
    const serverSocket = { on(event, fn) { handlers.set(event, fn); } };
    const clientSocket = {
        on() { },
        emit(event, payload, ack) {
            const h = handlers.get(event);
            if (!h) { ack?.({ ok: false, reason: `no handler for ${event}` }); return; }
            h(payload, ack);
        },
    };
    const io = {
        on(event, fn) { if (event === 'connection') fn(serverSocket); },
        emit() { },
    };
    let clock = T0;
    const srv = attachBoardServer({ io, db, now: () => clock });

    const job = addJob(db, { skill: 'mine', title: '同名重连', priority: 5 }, { now: T0 });
    const c1 = new BoardClient({ socket: clientSocket, name: 'worker' });   // 旧进程
    const c2 = new BoardClient({ socket: clientSocket, name: 'worker' });   // 重启后的新进程（同名）

    const r1 = await c1.claim();
    check('⑧ 旧进程领到单', r1.ok === true && r1.data?.job?.id === job.id, `ok=${r1.ok}`);

    clock = T0 + LEASE_MS + 1000;
    expireLeases(db, clock);                        // 租约过期（等价于服务端 5 秒扫描）
    clock = T0 + LEASE_MS + 2000;
    const r2 = await c2.claim();
    check('⑧ 同名新进程重新领到同一张单', r2.ok === true && r2.data?.job?.id === job.id, `ok=${r2.ok}`);

    clock = T0 + LEASE_MS + 3000;
    const lateFinish = await c1.finish(job.id, OK_RESULT);   // 旧尝试迟到收尾（带它自己记住的序号）
    check('⑧ 旧进程的迟到 finish 在协议层被拒', lateFinish.ok === false,
        `ok=${lateFinish.ok} code=${lateFinish.code ?? ''}`);
    // ★ 稳定的码必须一路传到 agent 侧：任务板自己的码是 LEASE_STALE，
    //   contract 词汇表里对应的码是 LEASE_LOST（调度器判的就是它）。
    //   ★ 这里同时锁"不会挂死"：未注册码若直接喂 fail() 会抛异常 →
    //     promise 永不 settle（离线实测的 "unsettled top-level await"）。
    check('⑧ 拒绝码在 agent 侧是稳定的 LEASE_LOST（不是 INTERNAL、也不挂死）',
        lateFinish.code === 'LEASE_LOST', `code=${lateFinish.code ?? ''}`);
    check('⑧ 服务端原始码留在 data.boardCode 里（诊断不丢信息）',
        lateFinish.data?.boardCode === BOARD_RESULT_CODES.LEASE_STALE,
        `boardCode=${lateFinish.data?.boardCode ?? 'null'}`);
    check('⑧ 单没有被旧进程结束', getJob(db, job.id).state !== JOB_STATE.DONE,
        `state=${getJob(db, job.id).state}`);

    clock = T0 + LEASE_MS + 4000;
    const good = await c2.finish(job.id, OK_RESULT);
    check('⑧ 新进程自己收尾生效（正常完成）', good.ok === true && getJob(db, job.id).state === JOB_STATE.DONE,
        `ok=${good.ok} state=${getJob(db, job.id).state}`);
    srv.stop();
}

console.log(`\n${fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `HAS FAILURES: ${fail} failed, ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
