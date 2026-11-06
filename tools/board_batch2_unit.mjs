/**
 * BOARD-001 / BOARD-002 / BOARD-003（2026-11-06 深度检查）—— 任务板三连，离线真 sqlite。
 *
 * BOARD-001 领单先截断16张再检查依赖 → 可执行前置被饿死
 *   复现：16 张 priority=9 的单都依赖一张 priority=5 的前置单，连续两次 claim 都是 null，
 *         而那张前置单一直是 ready。修复后：第一次 claim 就应领到**前置单**。
 *
 * BOARD-002 领单不带背包 → 物品资格任务永远领不出来
 *   复现：单 requires.items=[stone_pickaxe]，客户端只发 bot 名 → null；
 *         带上真实 items → 能领到。这里同时断言**真实传输载荷**。
 *
 * BOARD-003 租约只核对名字 → 同名旧尝试能结束新尝试
 *   复现：claim(seq=1) → 租约过期 → 同名再领(seq=2) → 旧 seq=1 的 finish
 *         被接受并把单置 done。修复后：旧 finish 必须 LEASE_STALE，且新租约/状态不变。
 *
 * 输出：PASS/FAIL，全过退出码 0。临时库在系统临时目录，跑完删除。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, addJob, getJob, claimFor, expireLeases, finish, heartbeat, updateJob,
    JOB_STATE, LEASE_MS, BOARD_RESULT_CODES, setState,
} from '../src/agent/library/board_store.js';
import { BoardClient } from '../src/agent/library/board_client.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const DIR = mkdtempSync(join(os.tmpdir(), 'board-b2-'));
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}.sqlite`); return openBoard(d); };
/** 读一次终态快照（避免把"已经被后续写入改过"的值当成断言基准）。 */
const jNONE = (v) => v;

try {
    // ══════════════════════════════════════════════════════════════════
    // BOARD-001：前置单排在 17 位之外，仍必须能被领到
    // ══════════════════════════════════════════════════════════════════
    {
        const { db } = freshDb();
        const t0 = 1_000_000;
        // 前置：priority=5（低）
        const pre = addJob(db, { title: '前置', skill: 'mine', priority: 5 });
        // 16 张高优先级单，全部依赖前置
        const blockers = [];
        for (let i = 0; i < 16; i++) {
            blockers.push(addJob(db, {
                title: `阻塞${i}`, skill: 'mine', priority: 9, dependsOn: [pre.id],
            }));
        }
        const got = claimFor(db, 'A', { now: t0 });
        check('BOARD-001 16 张阻塞单之后仍能领到可执行的前置单',
            got != null && got.id === pre.id,
            `领到=${got ? `${got.title}/${got.id}` : 'null'}`);
        // 阻塞单本身仍必须领不出来（依赖没满足）
        const got2 = claimFor(db, 'A', { now: t0 + 1000 });
        check('BOARD-001 依赖未满足的阻塞单仍然领不出来',
            got2 == null, `领到=${got2 ? got2.title : 'null'}`);
        // 能力过滤不回退：把前置做完，再让一个没能力的 bot 试
        finish(db, pre.id, { ok: true, code: 'OK' }, { bot: 'A', now: t0 + 2000 });
        const preState = getJob(db, pre.id)?.state;
        check('BOARD-001 前置单完成后确实是 done', preState === JOB_STATE.DONE, `state=${preState}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // BOARD-001 补充：100 张阻塞单也不饿死
    // ══════════════════════════════════════════════════════════════════
    {
        const { db } = freshDb();
        const t0 = 2_000_000;
        const pre = addJob(db, { title: '前置2', skill: 'mine', priority: 1 });
        for (let i = 0; i < 100; i++) {
            addJob(db, { title: `阻塞${i}`, skill: 'mine', priority: 9, dependsOn: [pre.id] });
        }
        const got = claimFor(db, 'A', { now: t0 });
        check('BOARD-001 100 张阻塞单之后仍能领到前置（不饿死）',
            got != null && got.id === pre.id, `领到=${got ? got.title : 'null'}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // BOARD-002：物品资格 —— 服务端判定 + 真实传输载荷
    // ══════════════════════════════════════════════════════════════════
    {
        const { db } = freshDb();
        const t0 = 3_000_000;
        const job = addJob(db, {
            title: '要石镐', skill: 'mine', requires: { items: ['stone_pickaxe'] },
        });
        // 空背包 → 必须领不到
        const none = claimFor(db, 'A', { now: t0, items: [] });
        check('BOARD-002 空背包领不到需要物品的单', none == null, `领到=${none ? none.title : 'null'}`);
        // 带正确物品 → 领得到
        const withItem = claimFor(db, 'A', { now: t0, items: ['stone_pickaxe'] });
        check('BOARD-002 带齐物品能领到同一张单',
            withItem != null && withItem.id === job.id, `领到=${withItem ? withItem.title : 'null'}`);

        // ★ 客户端真的把 items 发出去了吗（断言载荷，而不只是结果）
        const sent = [];
        const client = new BoardClient({
            name: 'worker',
            socket: { on: () => { }, emit: () => { } },
        });
        client._call = async (event, payload) => {
            sent.push({ event, payload });
            return { ok: true, data: { job: null } };
        };
        await client.claim({ items: ['stone_pickaxe'] });
        const p = sent[0]?.payload ?? {};
        check('BOARD-002 领单请求真的带上了 items', Array.isArray(p.items) && p.items[0] === 'stone_pickaxe',
            `payload=${JSON.stringify(p)}`);
        check('BOARD-002 领单请求仍然带 bot 名', p.bot === 'worker', `bot=${p.bot}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // BOARD-003：同名重领后，旧尝试的迟到写入必须失效
    // ══════════════════════════════════════════════════════════════════
    {
        const { db } = freshDb();
        const t0 = 4_000_000;
        const job = addJob(db, { title: '同名重领', skill: 'mine', maxAttempts: 5 });

        const c1 = claimFor(db, 'A', { now: t0 });
        const seq1 = Number(c1?.checkpoint?.attemptSeq);
        check('BOARD-003 领单返回本次尝试序号', Number.isFinite(seq1), `attemptSeq=${seq1}`);

        // 租约过期 → 同名再领
        expireLeases(db, t0 + LEASE_MS + 1);
        const c2 = claimFor(db, 'A', { now: t0 + LEASE_MS + 1000 });
        const seq2 = Number(c2?.checkpoint?.attemptSeq);
        check('BOARD-003 同名重领拿到**新**的尝试序号', seq2 === seq1 + 1, `seq1=${seq1} seq2=${seq2}`);

        // 旧尝试（seq1）的迟到 finish → 必须被拒，且不许改状态/租约
        const stale = finish(db, job.id, { ok: true, code: 'OK' },
            { bot: 'A', now: t0 + LEASE_MS + 2000, attemptSeq: seq1 });
        check('BOARD-003 旧尝试的迟到 finish 被拒（LEASE_STALE）',
            stale.ok === false && stale.code === BOARD_RESULT_CODES.LEASE_STALE,
            `ok=${stale.ok} code=${stale.code}`);
        const afterStale = getJob(db, job.id);
        check('BOARD-003 迟到 finish 没有把新尝试置 done',
            afterStale.state !== JOB_STATE.DONE, `state=${afterStale.state}`);
        check('BOARD-003 迟到 finish 没有清掉新租约',
            afterStale.lease?.owner === 'A', `owner=${afterStale.lease?.owner}`);

        // 旧尝试的迟到心跳同理
        const staleHb = heartbeat(db, job.id, 'A', { now: t0 + LEASE_MS + 2100, attemptSeq: seq1 });
        check('BOARD-003 旧尝试的迟到心跳返回 LEASE_LOST', staleHb.ok === false && staleHb.code === 'LEASE_LOST',
            `ok=${staleHb.ok} code=${staleHb.code}`);

        // 旧尝试的迟到 checkpoint 不许写
        const staleCp = updateJob(db, job.id, { checkpoint: { fromStale: true } },
            { now: t0 + LEASE_MS + 2200, attemptSeq: seq1 });
        check('BOARD-003 旧尝试的迟到 checkpoint 被拒',
            staleCp.ok === false && staleCp.code === BOARD_RESULT_CODES.LEASE_STALE,
            `ok=${staleCp.ok} code=${staleCp.code}`);
        check('BOARD-003 迟到 checkpoint 没有污染新尝试',
            getJob(db, job.id)?.checkpoint?.fromStale !== true,
            `checkpoint=${JSON.stringify(getJob(db, job.id)?.checkpoint)}`);

        // ★ 补洞①：checkpoint 是**整份替换**，不能把 attemptSeq 抹掉（否则守卫读成 NULL → fail open）
        check('BOARD-003 整份替换 checkpoint 后 attemptSeq 仍保留',
            Number(getJob(db, job.id)?.checkpoint?.attemptSeq) === seq2,
            `checkpoint=${JSON.stringify(getJob(db, job.id)?.checkpoint)}`);

        // ★ 补洞②：旧尝试不许改状态（setState 的 ready/paused 会清掉新租约）
        const staleSet = setState(db, job.id, JOB_STATE.PAUSED,
            { now: t0 + LEASE_MS + 2300, attemptSeq: seq1 });
        check('BOARD-003 旧尝试改状态被拒（不放掉新租约）',
            staleSet.ok === false && staleSet.code === BOARD_RESULT_CODES.LEASE_STALE,
            `ok=${staleSet.ok} code=${staleSet.code}`);
        check('BOARD-003 旧尝试改状态后新租约仍在',
            getJob(db, job.id)?.lease?.owner === 'A' && getJob(db, job.id)?.state !== JOB_STATE.PAUSED,
            `state=${getJob(db, job.id)?.state} owner=${getJob(db, job.id)?.lease?.owner}`);

        // 当前尝试（seq2）照常能收尾
        const good = finish(db, job.id, { ok: true, code: 'OK' },
            { bot: 'A', now: t0 + LEASE_MS + 3000, attemptSeq: seq2 });
        check('BOARD-003 当前尝试的 finish 正常生效', good.ok === true, `ok=${good.ok} code=${good.code}`);

        // 重复 finish（同一次尝试）：不许**再计一次尝试**，也不许把已终态改回去。
        //   （同一次尝试重复 finish 是幂等写入，不是租约失效 —— 别把它当错误拒掉，
        //     那会让"进程重启后补写结果"这种正常路径失效。）
        const beforeDup = getJob(db, job.id);
        const dup = finish(db, job.id, { ok: true, code: 'OK' },
            { bot: 'A', now: t0 + LEASE_MS + 3100, attemptSeq: seq2 });
        const afterDup = getJob(db, job.id);
        check('BOARD-003 重复 finish 不重复计 attempts、不改终态',
            afterDup.attempts === beforeDup.attempts && afterDup.state === jNONE(beforeDup.state),
            `attempts ${beforeDup.attempts}→${afterDup.attempts} state=${afterDup.state} dupOk=${dup.ok}`);
    }
} finally {
    try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
