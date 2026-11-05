// T25 终审 R2：第 15 条「craft 重复扣料」实测 —— 扣料次数 + 幂等
//
// 运行：node docs/audit/probes/t25-craft-ledger.mjs
//
// 三个场景，全部只调 store（不需要 bot / 模型 / 服务端）：
//   场景A 部分产出后重试：attempt1 产 1 件（want=2）→ 应重试；attempt2 再产 1 件 → 累计 2 → done
//          ★ 关键判据：**不应出现第 3 次尝试**（那才是"多扣一份料"）
//   场景B 已达标但被中断：attempt1 产满 2 件但 code=INTERRUPTED → 必须直接 done
//          ★ 这是原病灶最狠的一种：活干完了、单子却回 ready、再跑一遍把料又扣一次
//   场景C 幂等：同一次尝试 finish 两次 → producedTotal 不许涨
//
// 判据说明：本探针用 `data.produced`（= 动作层 after-before 的真件数）模拟 act_craft，
// 不用 progress.count（那是背包总量，正是原来判据错的地方）。
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    openBoard, addJob, claimFor, finish, getJob, JOB_STATE,
} from '../../../mindcraft/src/agent/library/board_store.js';

const RUN = resolve('docs/audit/probes/run/t25-ledger');
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

const BOT = 'ledgerbot';
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —— ' + detail : ''}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? '  —— ' + detail : ''}`); }
};
const cp = (job) => job?.checkpoint ?? {};
const show = (tag, job) => console.log(
    `     [${tag}] state=${job?.state} attempts=${job?.attempts} `
    + `producedTotal=${cp(job).producedTotal ?? '-'} producedAttempt=${cp(job).producedAttempt ?? '-'} `
    + `countedSeq=${cp(job).countedSeq ?? '-'} attemptSeq=${cp(job).attemptSeq ?? '-'} `
    + `progress.count=${job?.progress?.count ?? '-'}`);

const mkCraft = (db, want) => addJob(db, {
    skill: 'craft',
    title: `craft oak_planks x${want}`,
    args: { item: 'oak_planks', count: want },
    progress: { count: 0, want },
    state: JOB_STATE.READY,
});

// 模拟 act_craft 的返回值：produced = 本次真实件数（after - before）
const craftResult = (produced, { ok: okFlag = true, code = 'OK' } = {}) => ({
    ok: okFlag, code,
    message: okFlag ? '' : `模拟失败 ${code}`,
    data: { item: 'oak_planks', produced, producedTotal: produced },
    progress: { count: produced, want: 2 },   // 注意：这里故意只给"本次产出"，不给背包总量
});

console.log('\n=== 场景 A：部分产出后重试（want=2，两次各产 1）===');
{
    const d = join(RUN, 'a');
    const { db } = openBoard(d);
    const job0 = mkCraft(db, 2);
    console.log(`  job=${job0.id}`);

    // —— attempt 1：只做出 1 件，然后 TIMEOUT ——
    const c1 = claimFor(db, BOT, { leaseMs: 30000 });
    ok(c1 && c1.id === job0.id, 'A1 第一次领到该单');
    show('claim1', c1);
    const f1 = finish(db, job0.id, craftResult(1, { ok: false, code: 'TIMEOUT' }), { bot: BOT });
    show('finish1', f1.job);
    ok(cp(f1.job).producedTotal === 1, 'A2 第一次后 producedTotal=1（记了增量）', `实际 ${cp(f1.job).producedTotal}`);
    ok(f1.job.state === JOB_STATE.READY, 'A3 未达标 → 回 ready 重试', `实际 ${f1.job.state}`);
    ok(f1.job.attempts === 1, 'A4 TIMEOUT 计了 1 次 attempts', `实际 ${f1.job.attempts}`);

    // —— attempt 2：再产 1 件，累计 2 = want → 应 done ——
    const c2 = claimFor(db, BOT, { leaseMs: 30000 });
    ok(c2 && c2.id === job0.id, 'A5 第二次领到同一单');
    show('claim2', c2);
    const seq2 = cp(c2).attemptSeq;
    ok(seq2 === 2, 'A6 第二次尝试 attemptSeq=2（新尝试）', `实际 ${seq2}`);

    const f2 = finish(db, job0.id, craftResult(1, { ok: true, code: 'OK' }), { bot: BOT });
    show('finish2', f2.job);
    ok(cp(f2.job).producedTotal === 2, 'A7 累计 producedTotal=2（不是背包总量、不是单次）', `实际 ${cp(f2.job).producedTotal}`);
    ok(f2.job.state === JOB_STATE.DONE, 'A8 账到 want → done', `实际 ${f2.job.state}`);

    // —— 关键：不该有第 3 次尝试 ——
    const c3 = claimFor(db, BOT, { leaseMs: 30000 });
    ok(c3 === null, 'A9 ★ 不会再有第 3 次尝试（= 不多扣第三份料）', c3 ? `却又领到 ${c3.id}` : 'claimFor 返回 null');
    db.close();
}

console.log('\n=== 场景 B：已产满但被中断（原病灶最狠的一种）===');
{
    const d = join(RUN, 'b');
    const { db } = openBoard(d);
    const job0 = mkCraft(db, 2);
    const c1 = claimFor(db, BOT, { leaseMs: 30000 });
    show('claim', c1);
    // 产满 2 件，但流程报 INTERRUPTED（被打断 / 后续步骤失败）
    const f1 = finish(db, job0.id, craftResult(2, { ok: false, code: 'INTERRUPTED' }), { bot: BOT });
    show('finish(INTERRUPTED, produced=2)', f1.job);
    ok(cp(f1.job).producedTotal === 2, 'B1 producedTotal=2', `实际 ${cp(f1.job).producedTotal}`);
    ok(f1.job.state === JOB_STATE.DONE,
        'B2 ★ 账已满即 done（不再回 ready 重做一遍 → 不会第二次扣料）', `实际 ${f1.job.state}`);
    const c2 = claimFor(db, BOT, { leaseMs: 30000 });
    ok(c2 === null, 'B3 ★ 不会被重新领走再产一遍', c2 ? `又领到 ${c2.id}` : 'claimFor 返回 null');
    db.close();
}

console.log('\n=== 场景 C：幂等（同一次尝试 finish 两次）===');
{
    const d = join(RUN, 'c');
    const { db } = openBoard(d);
    const job0 = mkCraft(db, 2);
    const c1 = claimFor(db, BOT, { leaseMs: 30000 });
    const f1 = finish(db, job0.id, craftResult(1, { ok: false, code: 'NO_PATH' }), { bot: BOT });
    const after1 = cp(f1.job).producedTotal;
    show('finish#1', f1.job);
    // 同一次尝试（未重新 claim，attemptSeq 不变）再 finish 一次
    const f2 = finish(db, job0.id, craftResult(1, { ok: false, code: 'NO_PATH' }), { bot: BOT });
    const after2 = cp(f2.job).producedTotal;
    show('finish#2', f2.job);
    ok(after1 === 1 && after2 === 1,
        'C1 ★ 重复 finish 不重复记账（countedSeq 兜住）', `第一次 ${after1} → 第二次 ${after2}`);
    ok(f2.job.progress?.count === 1, 'C2 progress.count 也是 1（与账一致，未翻倍）', `实际 ${f2.job.progress?.count}`);
    db.close();
}

console.log('\n=== 场景 D：账本只认「真件数」，不认背包总量 ===');
{
    const d = join(RUN, 'd');
    const { db } = openBoard(d);
    const job0 = mkCraft(db, 2);
    claimFor(db, BOT, { leaseMs: 30000 });
    // 失败分支：故意只给 progress.count=背包总量(9)，但 data.produced=1
    const r = {
        ok: false, code: 'TIMEOUT', message: '模拟',
        data: { item: 'oak_planks', produced: 1 },
        progress: { count: 9, want: 2 },        // ← 背包总量 9
    };
    const f = finish(db, job0.id, r, { bot: BOT });
    show('finish(失败, count=9 但 produced=1)', f.job);
    ok(cp(f.job).producedTotal === 1,
        'D1 ★ 失败分支只记 produced=1，没把背包总量 9 当产出（防虚记→提前 done）',
        `实际 ${cp(f.job).producedTotal}`);
    ok(f.job.state !== JOB_STATE.DONE, 'D2 没被虚记骗成 done', `实际 ${f.job.state}`);
    db.close();
}

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
