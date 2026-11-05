/**
 * 第15条（R1 终审 §9 第 1 项）：**合成单重试不重复扣料** —— 离线，真 sqlite。
 *
 * 病灶（报告第 15 条 + 复审 §3.2）：
 *   库里**没有任何"这张单已经产出过多少"的账**。`act_craft` 的 `produced` 只活在返回值里，
 *   `finish` 之后连痕迹都没有（`progress.count` 对 craft 是"背包里该物品总数"）。
 *   于是「做出东西 → 被打断/失败 → 单子回 ready → 重跑」每重跑一次就**真扣一次材料**，
 *   而账面看不出来 —— 玩家看到的是"材料莫名少了，单子还在跑"。
 *
 * 修法（本文件钉死的契约）：
 *   ① `finish()` 给 craft 单记 `checkpoint.producedTotal`（**按增量**累加，同一次尝试重复
 *      finish 不重复记账），并把这次的增量写进 `result.craftLedger`；
 *   ② craft 单的完成判据多一条：**账 ≥ want 就 done**（原来只有"流程报 ok"一条）；
 *   ③ `convergeIfSatisfied`（`claimFor` 领单前的清扫）按**产出账**收敛 craft 单
 *      —— 账够了的单**不再被派发**，于是第二次扣料根本不会发生；
 *      没有产出账的老 row（`producedTotal` 缺失）**仍然不收敛**（保持 t120 的行为）。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, addJob, getJob, finish, claimFor, JOB_STATE,
    craftProducedOf, settleCraftLedger,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// 每个进程一个独立目录（T15/T17 的并发隔离规矩：同机两路 unit_all 不得互删 fixture）
const DIR = mkdtempSync(join(os.tmpdir(), 'board-craft-ledger-'));
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); return openBoard(d); };

/** 造一张 craft 单（默认 oak_planks x3，**ready** —— `claimFor` 只领 ready 的单）。 */
function makeCraft(fields = {}) {
    const { db } = freshDb();
    const job = addJob(db, {
        title: 'planks', skill: 'craft', state: JOB_STATE.READY, maxAttempts: 3,
        args: { item: 'oak_planks', count: 3 },
        progress: { count: 0, want: 3 },
        ...fields,
    });
    return { db, job: getJob(db, job.id) };
}

/** A 领单（把 lease 挂到 A 身上，finish 才不会因归属校验被拒）。 */
function letAClaim(db, { now = 1_000_000 } = {}) {
    const j = claimFor(db, 'A', { now });
    if (!j) throw new Error('fixture 坏了：claimFor 没领到单');
    return j;
}

// ══════════════════════════════════════════════════════════════════════════
// ① 核心断言：**做出 3/3 后被打断 → done，不再回 ready**（第二次扣料不会发生）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = makeCraft();
    const t0 = 1_000_000;
    const claimed = letAClaim(db, { now: t0 });
    const id = claimed.id;
    // 真机形态：`bot.craft` 已经真扣了料、产出 3 块板，然后收到中断
    //   （flow_craft 返回 INTERRUPTED，scheduler 把 data 一起带上来）
    const r = finish(db, id, {
        ok: false, code: 'INTERRUPTED', message: '被取消了',
        progress: { count: 3, want: 3 },
        data: { item: 'oak_planks', produced: 3, producedTotal: 3 },
    }, { now: t0 + 1000, bot: 'A' });
    const after = getJob(db, id);
    const good = r.ok === true
        && r.next === JOB_STATE.DONE && after.state === JOB_STATE.DONE
        && after.checkpoint?.producedTotal === 3
        && after.result?.craftLedger?.producedTotal === 3;
    if (good) {
        okCase('① 产出 3/3 后被打断（INTERRUPTED）→ 直接 done（不再 ready 重跑 → 不扣第二次料）',
            `next=${r.next} state=${after.state} producedTotal=${after.checkpoint?.producedTotal} attempts=${after.attempts}`);
    } else {
        badCase('① 产出已达标却回 ready（第15条重复扣料的原路）', {
            next: r.next, state: after.state, cp: after.checkpoint, result: after.result, attempts: after.attempts,
        });
    }
}

// ①-b 正向对照（**证伪①不是"什么都 done"**）：同样的 INTERRUPTED 但**一件没做出来**
//       → 必须还是 ready（该重试就重试）
{
    const { db } = makeCraft();
    const t0 = 1_000_000;
    const claimed = letAClaim(db, { now: t0 });
    const r = finish(db, claimed.id, {
        ok: false, code: 'INTERRUPTED', message: '被取消了',
        progress: { count: 0, want: 3 },
        data: { item: 'oak_planks', produced: 0, producedTotal: 0 },
    }, { now: t0 + 1000, bot: 'A' });
    const after = getJob(db, claimed.id);
    const good = r.ok === true && r.next === JOB_STATE.READY
        && after.state === JOB_STATE.READY
        && (after.checkpoint?.producedTotal ?? 0) === 0
        && after.attempts === 0;                       // INTERRUPTED 不计 attempts
    if (good) okCase('①-b 同样中断但零产出 → 仍然 ready 重试（账不够不许 done）',
        `next=${r.next} state=${after.state} producedTotal=${after.checkpoint?.producedTotal} attempts=${after.attempts}`);
    else badCase('①-b 零产出却 done 或没回 ready', { next: r.next, state: after.state, cp: after.checkpoint, attempts: after.attempts });
}

// ①-c 部分产出（2/3）→ 不 done（账不够），但**账要记下来**（下一轮不许重复记这 2 件）
{
    const { db } = makeCraft();
    const t0 = 1_000_000;
    const claimed = letAClaim(db, { now: t0 });
    const r = finish(db, claimed.id, {
        ok: false, code: 'TIMEOUT', message: '超时',
        progress: { count: 2, want: 3 },
        data: { item: 'oak_planks', produced: 2, producedTotal: 2 },
    }, { now: t0 + 1000, bot: 'A' });
    const after = getJob(db, claimed.id);
    const good = r.ok === true && after.state === JOB_STATE.READY
        && after.checkpoint?.producedTotal === 2
        && after.attempts === 1;                       // TIMEOUT 计 attempts
    if (good) okCase('①-c 部分产出 2/3 → ready 重试 + 账记 2（不 done、不丢账）',
        `state=${after.state} producedTotal=${after.checkpoint?.producedTotal} attempts=${after.attempts}`);
    else badCase('①-c 部分产出的去处不对', { state: after.state, cp: after.checkpoint, attempts: after.attempts });
}

// ══════════════════════════════════════════════════════════════════════════
// ② 幂等：**同一次尝试被重复 finish（崩溃重放 / 收敛后再收尾）不许重复记账**
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = makeCraft({ maxAttempts: 5 });
    const t0 = 1_000_000;
    const claimed = letAClaim(db, { now: t0 });
    const res = {
        ok: false, code: 'TIMEOUT', message: '超时',
        progress: { count: 2, want: 3 },
        data: { item: 'oak_planks', produced: 2, producedTotal: 2 },
    };
    finish(db, claimed.id, res, { now: t0 + 1000, bot: 'A' });
    const mid = getJob(db, claimed.id);
    // 同一次尝试再 finish 一次（真实来源：SIGKILL 前重放的收尾 / 外层再收一次）
    const r2 = finish(db, claimed.id, res, { now: t0 + 2000 });
    const after = getJob(db, claimed.id);
    const good = mid.checkpoint?.producedTotal === 2
        && after.checkpoint?.producedTotal === 2                 // ★ 不是 4
        && r2.ok === true;
    if (good) okCase('② 同一次尝试重复 finish → producedTotal 仍 2（不翻倍）',
        `第一次=${mid.checkpoint?.producedTotal} 第二次=${after.checkpoint?.producedTotal} delta=${r2.job?.result?.craftLedger?.delta}`);
    else badCase('② 重复 finish 把产出账记翻了倍', { first: mid.checkpoint, second: after.checkpoint });
}

// ②-b 跨**两次尝试**则要累加（2 + 1 = 3）—— 增量口径，不是幂等口径
{
    const { db } = makeCraft({ maxAttempts: 5 });
    const t0 = 1_000_000;
    const c1 = letAClaim(db, { now: t0 });
    finish(db, c1.id, {
        ok: false, code: 'TIMEOUT', message: '超时',
        progress: { count: 2, want: 3 }, data: { produced: 2, producedTotal: 2 },
    }, { now: t0 + 1000, bot: 'A' });
    const mid = getJob(db, c1.id);
    const c2 = claimFor(db, 'A', { now: t0 + 2000 });
    const r = finish(db, c2.id, {
        ok: false, code: 'TIMEOUT', message: '超时',
        progress: { count: 1, want: 3 }, data: { produced: 1, producedTotal: 1 },
    }, { now: t0 + 3000, bot: 'A' });
    const after = getJob(db, c2.id);
    const good = mid.checkpoint?.producedTotal === 2
        && after.checkpoint?.producedTotal === 3
        && r.job?.result?.craftLedger?.delta === 1;
    if (good) okCase('②-b 跨两次尝试：2 + 1 → producedTotal=3（增量累加，attempts=2）',
        `first=${mid.checkpoint?.producedTotal} second=${after.checkpoint?.producedTotal} attempts=${after.attempts}`);
    else badCase('②-b 跨尝试累加不对', { mid: mid.checkpoint, after: after.checkpoint, attempts: after.attempts });
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 领单前的清扫：账够了的 craft 单**不再被派发**（这才是"第二次扣料不发生"的落点）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = makeCraft({
        state: JOB_STATE.READY,
        progress: { count: 3, want: 3 },
        checkpoint: { producedTotal: 3 },
        assignee: 'A',
    });
    const got = claimFor(db, 'A', { now: 1_000_000 });
    const jobs = db.prepare('SELECT id, state FROM jobs').all();
    const anyDone = jobs.some((x) => x.state === JOB_STATE.DONE);
    const good = got === null && anyDone;
    if (good) okCase('③ ready + 账 3/3 → claimFor 不派发，直接收敛 done（不再跑一遍流程）',
        `claim=${got} states=${JSON.stringify(jobs)}`);
    else badCase('③ 账已够却仍被派发（会再扣一次料）', { claim: got, states: jobs });
}

// ③-b 反向对照（t120 的规矩不许被这条改坏）：**没有产出账的老 row**（count 是背包总量）
//       → 仍然不收敛、仍然要真的跑一次
{
    const { db } = makeCraft({
        state: JOB_STATE.READY,
        progress: { count: 8, want: 3 },             // 背包里本来就有 8 块（老语义）
        checkpoint: null,                            // ★ 没有 producedTotal
        assignee: 'A',
    });
    const got = claimFor(db, 'A', { now: 1_000_000 });
    const good = got != null && got.state === JOB_STATE.CLAIMED;
    if (good) okCase('③-b 老 row 没有产出账（count=背包总量 8 ≥ want 3）→ 仍然派发（t120 行为不变）',
        `claim=${got?.id} state=${got?.state}`);
    else badCase('③-b 老 row 被"按库存收敛"误杀（t120 的 bug 回来了）', { claim: got });
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 非 craft 单**不受影响**（回归护栏：mine/collect 的语义没被这次改动碰到）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshDb();
    const job = addJob(db, {
        title: 'mine', skill: 'mine', state: JOB_STATE.RUNNING, maxAttempts: 3,
        progress: { count: 2, want: 8 },
    });
    const j2 = getJob(db, job.id);
    const r = finish(db, j2.id, {
        ok: false, code: 'TIMEOUT', message: '超时',
        progress: { count: 4, want: 8 }, data: { produced: 4 },
    }, { now: 1_000_000 });
    const after = getJob(db, j2.id);
    const good = after.state === JOB_STATE.READY
        && after.checkpoint?.producedTotal === undefined       // ★ 不给非 craft 单记产出账
        && after.progress?.count === 4                          // count 语义不变
        && after.result?.craftLedger === undefined;
    if (good) okCase('④ mine 单：不写 producedTotal、count 语义不变、不写 craftLedger',
        `state=${after.state} count=${after.progress?.count} cp=${JSON.stringify(after.checkpoint)}`);
    else badCase('④ 非 craft 单被产出账污染了', { state: after.state, cp: after.checkpoint, progress: after.progress });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 取值口径（`craftProducedOf`）：**宁可少记，绝不虚记**
// ══════════════════════════════════════════════════════════════════════════
{
    // ⑤-1 flow_craft 的失败分支把 `got`（**合成次数**）写进 `count` —— 不许被当成件数
    const times = craftProducedOf({ data: { item: 'oak_planks', count: 1 }, progress: null });
    // ⑤-2 act_craft 的真实差值优先
    const pieces = craftProducedOf({ data: { produced: 4 }, progress: { count: 1, want: 1 } });
    // ⑤-3 显式 producedTotal 最优先
    const explicit = craftProducedOf({ data: { producedTotal: 4, produced: 2 }, progress: { count: 9 } });
    // ⑤-4 什么都没有 → 0（不猜）
    const none = craftProducedOf({ data: {}, progress: null });
    // ⑤-5 流程报 ok 时，进度兜底可信（flow_craft 的 count 就是产出增量）
    const fromProgress = craftProducedOf({ ok: true, data: null, progress: { count: 5, want: 5 } });
    // ⑤-6 ★ **失败分支不许采信 progress.count**（那里可能是"合成次数"，虚记 → 提前 done）
    const failInflation = craftProducedOf({ ok: false, code: 'NO_ITEM', data: { count: 3 }, progress: { count: 3, want: 3 } });
    const good = times === 0 && pieces === 4 && explicit === 4 && none === 0
        && fromProgress === 5 && failInflation === 0;
    if (good) okCase('⑤ 口径：次数不当件数(0) / produced 优先(4) / producedTotal 最优先(4) / 无数据=0 / ok时进度兜底(5) / 失败分支次数不采信(0)',
        `times=${times} pieces=${pieces} explicit=${explicit} none=${none} progress=${fromProgress} failInflation=${failInflation}`);
    else badCase('⑤ 取值口径不对', { times, pieces, explicit, none, fromProgress, failInflation });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ `settleCraftLedger` 纯函数契约（不碰库，便于以后改 store 时回归）
// ══════════════════════════════════════════════════════════════════════════
{
    const job = { attempts: 1, checkpoint: { producedTotal: 5, producedAttempt: 5, countedSeq: 2, attemptSeq: 2 } };
    const s = settleCraftLedger(job, { data: { produced: 2 } });   // 同一次尝试，又报 2
    const good = s.prevProducedTotal === 5 && s.delta === 0 && s.producedTotal === 5;
    if (good) okCase('⑥ 同一次尝试重复报账 → delta=0（本次产 − 上次已计）', `delta=${s.delta} total=${s.producedTotal}`);
    else badCase('⑥ 增量口径不对', s);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
