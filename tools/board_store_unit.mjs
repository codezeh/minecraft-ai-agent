/**
 * board_store 离线测试（M8 B1，06 §6/§12）—— 真 sqlite，但不连 socket。
 *
 * 重点锁三件事（06 §6 的三条规则，每条都有对应用例）：
 *   ① 领单**原子**：两个客户端抢同一张单 → 只有一个成功（这是最要紧的一条）
 *   ② attempts 分三类：INTERRUPTED/PREEMPTED 不计；TIMEOUT/STUCK/NO_PATH 计；NO_ITEM/NO_TOOL/NO_RECIPE 直接 blocked
 *   ③ 完成判据 = ok **且** count>=want（只报 ok 不算完成）
 * 另加：状态机全部合法转移、非法转移拒绝、租约过期（**假时钟，不 sleep**）、重启后恢复。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    openBoard, addJob, getJob, listJobs, claimFor, heartbeat, finish, expireLeases,
    setState, updateJob, countJobs, canTransition, isTerminal, JOB_STATE, ALL_STATES,
    LEASE_MS, rowToJob,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = join('tmp', 'board-test');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

let dbSeq = 0;
const freshDb = () => {
    const dir = join(DIR, `db${++dbSeq}`);
    rmSync(dir, { recursive: true, force: true });
    return openBoard(dir);
};

// ── 1. 建库 + 加单 + 读回 ────────────────────────────────────────────
{
    const { db } = freshDb();
    const job = addJob(db, {
        title: '采 32 个橡木', skill: 'collect', args: { block: 'oak_log', count: 32 },
        kind: 'personal', assignee: 'alpha', priority: 6, source: 'player:Zeh',
    });
    const back = getJob(db, job.id);
    const good = back && back.skill === 'collect'
        && back.args?.count === 32
        && back.state === JOB_STATE.READY
        && back.priority === 6
        && back.lease?.owner === null;
    if (good) okCase('建库/加单/读回（args JSON 往返、初始 ready）', `${job.id} args=${JSON.stringify(back.args)}`);
    else badCase('建库/加单/读回', back);
}

// ── 2. ① 领单原子性：两个客户端抢同一张单，只有一个成功 ──────────────
//    ★ 这是最关键的一条。为了证明它真的靠 `changes` 而不是碰巧，这里做两件事：
//      (a) 顺序抢：A 领到后 B 领同一张 → B 必须拿不到（拿到别的或 null）
//      (b) **并发抢**：同一张单，两个"客户端"各跑一次 claimFor（模拟两个 agent 同时到）
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'only one', skill: 'collect', assignee: null, priority: 5 });

    // (a) 顺序：A 领到
    const a = claimFor(db, 'alpha');
    const aGotIt = a?.id === job.id;
    // 再让 B 领：这张单已经是 claimed，B 不该拿到它
    const b = claimFor(db, 'beta');
    const bDidNotGetIt = b?.id !== job.id;

    if (aGotIt && bDidNotGetIt) {
        okCase('① 顺序抢：A 领到后 B 拿不到同一张', `A=${a?.id} B=${b?.id ?? 'null'}`);
    } else {
        badCase('① 顺序抢', { a: a?.id, b: b?.id });
    }
}

// ── 3. ① 并发抢：同一 tick 内两次 claimFor，只有一次 changes===1 ─────
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'race', skill: 'collect', assignee: null, priority: 5 });

    // 真并发：两个 Promise 同时发起（node:sqlite 是同步的，所以这里模拟"两个调用方都看到 ready"）
    const results = [];
    const doClaim = (bot) => { try { results.push({ bot, job: claimFor(db, bot) }); } catch (e) { results.push({ bot, err: String(e?.message ?? e) }); } };
    doClaim('alpha');
    doClaim('beta');

    const winners = results.filter((r) => r.job?.id === job.id);
    const back = getJob(db, job.id);
    // 只有一个赢家，且库里的 owner 是那个赢家
    if (winners.length === 1 && back.lease.owner === winners[0].bot && back.state === JOB_STATE.CLAIMED) {
        okCase('① 并发抢：两个调用方只有一个 changes===1', `winner=${winners[0].bot} owner=${back.lease.owner}`);
    } else {
        badCase('① 并发抢：只有一个赢家', { winners: winners.map((w) => w.bot), owner: back.lease.owner, results });
    }
}

// ── 4. ① 直接验证"靠 changes 而不是先 SELECT 再 UPDATE" ─────────────
//    把单子手动改成 claimed 后，claimFor 必须**不去动它**（changes=0 的那条路径）
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'x', skill: 'collect', assignee: null });
    // 模拟"另一个 bot 刚把它领走"
    db.prepare(`UPDATE jobs SET state='claimed', lease_owner='other', lease_until=? WHERE id=?`)
        .run(Date.now() + LEASE_MS, job.id);
    const got = claimFor(db, 'alpha');
    const untouched = getJob(db, job.id).lease.owner === 'other';
    if (got?.id !== job.id && untouched) {
        okCase('① 已被别人领走的单，claimFor 不会动它（changes=0）', 'owner 仍是 other');
    } else {
        badCase('① 已被别人领走的单不该被抢', { got: got?.id, owner: getJob(db, job.id).lease.owner });
    }
}

// ── 5. ② INTERRUPTED / PREEMPTED **不计** attempts ──────────────────
{
    // 真实流程是"领一次 → finish 一次"。第二次要先重新领单
    // （不重新 claim 就去 finish，状态是 ready→ready，那是非法转移，会被正确拒绝）。
    const results = [];
    for (const code of ['INTERRUPTED', 'PREEMPTED']) {
        const { db } = freshDb();
        const job = addJob(db, { title: code, skill: 'collect', assignee: 'alpha' });
        claimFor(db, 'alpha');
        const r = finish(db, job.id, { ok: false, code, progress: { count: 3, want: 10 } });
        const back = getJob(db, job.id);
        results.push({ code, counted: r.counted, attempts: back.attempts, state: back.state });
    }
    const good = results.every((r) => r.counted === false && r.attempts === 0 && r.state === JOB_STATE.READY);
    if (good) {
        okCase('② INTERRUPTED/PREEMPTED 不计 attempts（回到 ready）', JSON.stringify(results.map((r) => `${r.code}:${r.attempts}`)));
    } else {
        badCase('② INTERRUPTED/PREEMPTED 不计 attempts', results);
    }
}

// ── 6. ② TIMEOUT / STUCK / NO_PATH **计** attempts ─────────────────
{
    const results = [];
    for (const code of ['TIMEOUT', 'STUCK', 'NO_PATH']) {
        const { db } = freshDb();
        const job = addJob(db, { title: code, skill: 'collect', assignee: 'alpha', maxAttempts: 5 });
        claimFor(db, 'alpha');
        const r = finish(db, job.id, { ok: false, code, progress: { count: 0, want: 5 } });
        results.push({ code, counted: r.counted, attempts: getJob(db, job.id).attempts, state: getJob(db, job.id).state });
    }
    const good = results.every((r) => r.counted === true && r.attempts === 1 && r.state === JOB_STATE.READY);
    if (good) okCase('② TIMEOUT/STUCK/NO_PATH 计 attempts', JSON.stringify(results.map((r) => `${r.code}:${r.attempts}`)));
    else badCase('② TIMEOUT/STUCK/NO_PATH 计 attempts', results);
}

// ── 7. ② NO_ITEM / NO_TOOL / NO_RECIPE → **直接 blocked** ──────────
{
    const results = [];
    for (const code of ['NO_ITEM', 'NO_TOOL', 'NO_RECIPE']) {
        const { db } = freshDb();
        const job = addJob(db, { title: code, skill: 'collect', assignee: 'alpha', maxAttempts: 5 });
        claimFor(db, 'alpha');
        const r = finish(db, job.id, { ok: false, code, progress: { count: 0, want: 5 } });
        results.push({ code, state: r.next, counted: r.counted, attempts: getJob(db, job.id).attempts });
    }
    const good = results.every((r) => r.state === JOB_STATE.BLOCKED && r.attempts === 0);
    if (good) okCase('② NO_ITEM/NO_TOOL/NO_RECIPE → 直接 blocked 且不消耗 attempts', JSON.stringify(results.map((r) => `${r.code}→${r.state}`)));
    else badCase('② NO_ITEM/NO_TOOL/NO_RECIPE → blocked', results);
}

// ── 8. ③ 完成判据：ok 且 count>=want 才算完成 ──────────────────────
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'c', skill: 'collect', assignee: 'alpha', maxAttempts: 5 });
    claimFor(db, 'alpha');
    // ok=true 但只做了 3/10 → **不算完成**
    const partial = finish(db, job.id, { ok: true, code: 'OK', progress: { count: 3, want: 10 } });
    const afterPartial = getJob(db, job.id);
    const notDone = partial.next !== JOB_STATE.DONE && afterPartial.state !== JOB_STATE.DONE;

    // 再来一次做够 10/10 → done
    claimFor(db, 'alpha');
    const full = finish(db, job.id, { ok: true, code: 'OK', progress: { count: 10, want: 10 } });
    const afterFull = getJob(db, job.id);

    if (notDone && full.next === JOB_STATE.DONE && afterFull.state === JOB_STATE.DONE) {
        okCase('③ ok 但 count<want 不算完成；做够了才 done', `partial→${partial.next} full→${full.next}`);
    } else {
        badCase('③ 完成判据', { partial: partial.next, full: full.next, state: afterFull.state });
    }
}

// ── 9. 租约过期（**假时钟**，不 sleep）→ 回 ready 且 checkpoint 保留 ──
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'lease', skill: 'collect', assignee: 'alpha' });
    const t0 = 1_000_000;
    claimFor(db, 'alpha', { now: t0 });
    // 存个 checkpoint（模拟做到一半）。注意：heartbeat 会把租约续到 `这次时间 + LEASE_MS`，
    // 所以"到期时刻"要按**续租后**的基准算（我第一次就写错了，测试自己踩了个坑）。
    const hbAt = t0 + 1000;
    heartbeat(db, job.id, 'alpha', { now: hbAt, progress: { count: 4, want: 10 } });
    updateJob(db, job.id, { checkpoint: { step: 4 } }, { now: hbAt });
    const leaseEnds = hbAt + LEASE_MS;

    // 租约还没到期：不该回收
    const noneYet = expireLeases(db, leaseEnds - 1);
    // 到期了：回收
    const expired = expireLeases(db, leaseEnds + 1);
    const back = getJob(db, job.id);

    const good = noneYet.length === 0 && expired.includes(job.id)
        && back.state === JOB_STATE.READY
        && back.checkpoint?.step === 4                 // ★ checkpoint 必须保留
        && back.progress?.count === 4                  // 进度也不倒退
        && back.lease.owner === null;
    if (good) okCase('租约过期（假时钟）→ 回 ready、checkpoint 与 progress 都保留',
        `noneYet=${noneYet.length} expired=${expired.length} ckpt=${JSON.stringify(back.checkpoint)}`);
    else badCase('租约过期', { noneYet, expired, back: { state: back.state, ckpt: back.checkpoint, prog: back.progress } });
}

// ── 10. heartbeat：owner 不符 / 已过期 → LEASE_LOST ────────────────
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'hb', skill: 'collect', assignee: 'alpha' });
    const t0 = 2_000_000;
    claimFor(db, 'alpha', { now: t0 });

    const wrongOwner = heartbeat(db, job.id, 'beta', { now: t0 + 100 });
    // 这次成功续租会把 until 推到 (t0+100)+LEASE_MS —— 后面判过期要按这个基准
    const okHb = heartbeat(db, job.id, 'alpha', { now: t0 + 100 });
    const afterExpiry = heartbeat(db, job.id, 'alpha', { now: t0 + 100 + LEASE_MS + 10 });

    if (wrongOwner.code === 'LEASE_LOST' && okHb.ok && afterExpiry.code === 'LEASE_LOST') {
        okCase('heartbeat：错 owner / 已过期 → LEASE_LOST；正常续租 ok', 'ok');
    } else {
        badCase('heartbeat 语义', { wrongOwner, okHb: okHb.ok, afterExpiry });
    }
}

// ── 11. 第一次心跳把 claimed 推进到 running ─────────────────────────
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'r', skill: 'collect', assignee: 'alpha' });
    claimFor(db, 'alpha');
    const claimedState = getJob(db, job.id).state;
    const r = heartbeat(db, job.id, 'alpha', { progress: { count: 1, want: 5 } });
    const runningState = getJob(db, job.id).state;
    if (claimedState === JOB_STATE.CLAIMED && runningState === JOB_STATE.RUNNING && r.job.state === JOB_STATE.RUNNING) {
        okCase('第一次心跳 claimed → running', `${claimedState}→${runningState}`);
    } else {
        badCase('第一次心跳 claimed → running', { claimedState, runningState });
    }
}

// ── 12. 状态机：全部合法转移都走得通 ───────────────────────────────
{
    const LEGAL = [
        ['pending', 'ready'], ['pending', 'cancelled'],
        ['ready', 'paused'], ['ready', 'cancelled'], ['ready', 'blocked'], ['ready', 'done'],
        ['claimed', 'ready'], ['claimed', 'paused'], ['claimed', 'cancelled'], ['claimed', 'blocked'],
        ['running', 'ready'], ['running', 'paused'], ['running', 'blocked'], ['running', 'done'], ['running', 'failed'],
        ['paused', 'ready'], ['paused', 'cancelled'], ['paused', 'blocked'], ['paused', 'failed'],
        ['blocked', 'ready'], ['blocked', 'cancelled'],
    ];
    const bad = LEGAL.filter(([f, t]) => !canTransition(f, t)).map(([f, t]) => `${f}→${t}`);
    if (bad.length === 0) okCase('状态机：21 条合法转移全部放行', `count=${LEGAL.length}`);
    else badCase('状态机合法转移', bad);
}

// ── 13. 状态机：非法转移必须被拒 + 终态不许再动 ────────────────────
{
    const ILLEGAL = [
        ['done', 'ready'], ['failed', 'ready'], ['cancelled', 'ready'],   // 终态
        ['pending', 'running'], ['pending', 'done'],                       // 跳步
        ['ready', 'running'],                                              // 没领就 running
        ['blocked', 'done'], ['blocked', 'running'],
    ];
    const wrong = ILLEGAL.filter(([f, t]) => canTransition(f, t)).map(([f, t]) => `${f}→${t}`);
    const terminals = ['done', 'failed', 'cancelled'].filter((s) => !isTerminal(s));
    if (wrong.length === 0 && terminals.length === 0) {
        okCase('状态机：8 条非法转移全被拒、3 个终态确认', `illegal=${ILLEGAL.length}`);
    } else {
        badCase('状态机非法转移', { wrong, terminals });
    }
}

// ── 14. setState / updateJob 也走状态校验 ─────────────────────────
{
    const { db } = freshDb();
    const job = addJob(db, { title: 's', skill: 'collect', assignee: 'alpha' });
    const illegal = setState(db, job.id, JOB_STATE.RUNNING);          // ready → running 不合法
    const legal = setState(db, job.id, JOB_STATE.CANCELLED);
    const illegalPatch = updateJob(db, job.id, { state: JOB_STATE.READY });  // cancelled 是终态
    if (!illegal.ok && legal.ok && !illegalPatch.ok) {
        okCase('setState/updateJob 拒绝非法转移', `${illegal.message}`);
    } else {
        badCase('setState/updateJob 状态校验', { illegal, legal: legal.ok, illegalPatch });
    }
}

// ── 15. 重启后恢复（关库再开，单子还在）──────────────────────────
{
    const dir = join(DIR, 'restart');
    rmSync(dir, { recursive: true, force: true });
    const first = openBoard(dir);
    const job = addJob(first.db, { title: 'restart me', skill: 'collect', assignee: 'alpha' });
    claimFor(first.db, 'alpha');
    heartbeat(first.db, job.id, 'alpha', { progress: { count: 2, want: 9 } });
    updateJob(first.db, job.id, { checkpoint: { step: 2 } });
    try { first.db.close(); } catch { /* ignore */ }

    // 重新打开（模拟进程重启）
    const second = openBoard(dir);
    const back = getJob(second.db, job.id);
    const good = back && back.skill === 'collect'
        && back.state === JOB_STATE.RUNNING
        && back.progress?.count === 2
        && back.checkpoint?.step === 2
        && back.lease.owner === 'alpha';
    if (good) okCase('重启后恢复（单还在、progress/checkpoint 都在）', `${job.id} state=${back?.state}`);
    else badCase('重启后恢复', back);
}

// ── 15b. ★ 重启后加单不能撞 id（真机验收抓到的 bug）─────────────────
//   原来 id 只用"日期 + 进程内计数器"，计数器每个进程从 0 开始 →
//   mindserver 一重启就生成和库里已有单相同的 id → UNIQUE constraint failed。
//   而"重启"恰恰是 B1 要支撑的核心场景，所以这条必须锁住。
{
    const dir = join(DIR, 'idcollide');
    rmSync(dir, { recursive: true, force: true });

    // 第一次进程：加 3 张单
    const first = openBoard(dir);
    const ids1 = [
        addJob(first.db, { title: 'a', skill: 'collect', assignee: 'alpha' }).id,
        addJob(first.db, { title: 'b', skill: 'collect', assignee: 'alpha' }).id,
        addJob(first.db, { title: 'c', skill: 'collect', assignee: 'alpha' }).id,
    ];
    try { first.db.close(); } catch { }

    // 模拟"进程重启"：同一目录重新打开（新进程的计数器从 0 开始）
    const second = openBoard(dir);
    let err = null;
    let ids2 = [];
    try {
        ids2 = [
            addJob(second.db, { title: 'd', skill: 'collect', assignee: 'alpha' }).id,
            addJob(second.db, { title: 'e', skill: 'collect', assignee: 'alpha' }).id,
        ];
    } catch (e) { err = String(e?.message ?? e); }

    const allUnique = new Set([...ids1, ...ids2]).size === ids1.length + ids2.length;
    const total = countJobs(second.db);
    if (!err && allUnique && total === 5) {
        okCase('★ 重启后加单不撞 id（id 跨进程唯一）', `${total} 张，无重复`);
    } else {
        badCase('★ 重启后加单撞 id', { err, ids1, ids2, allUnique, total });
    }
}

// ── 15c. ★ 进度单调：agent 报小了也不许倒退（06 §11）────────────────
//   真机验收暴露：进程重启后 agent 只能按当下所见重新数，可能报 0；
//   若"报什么存什么"，进度就倒退了，而 06 §11 明确要求重启后不倒退。
//   由唯一写库的地方保证：count 取 max(旧, 新)，并把 agent 报的原值留痕。
{
    const { db } = freshDb();
    const job = addJob(db, { title: 'mono', skill: 'mine', assignee: 'alpha', maxAttempts: 9 });
    claimFor(db, 'alpha');

    // 正常推进：0 → 5
    heartbeat(db, job.id, 'alpha', { progress: { count: 5, want: 16 } });
    const afterAdvance = getJob(db, job.id).progress;

    // 重启后 agent 报小了（0）→ **不许倒退**
    const back = heartbeat(db, job.id, 'alpha', { progress: { count: 0, want: 16 } });
    const afterRegress = getJob(db, job.id).progress;

    // 继续往上：5 → 7，应该接受
    heartbeat(db, job.id, 'alpha', { progress: { count: 7, want: 16 } });
    const afterMore = getJob(db, job.id).progress;

    const good = afterAdvance.count === 5
        && afterRegress.count === 5            // ★ 拒绝倒退
        && back.progressClamped === true
        && back.reported === 0                 // agent 原值留痕
        && afterMore.count === 7;              // 往上照常接受
    if (good) {
        okCase('★ 进度单调：报小不倒退（留痕 reported），报大照常接受',
            `5 → (报0) 仍 ${afterRegress.count} → ${afterMore.count}`);
    } else {
        badCase('★ 进度单调', { afterAdvance, afterRegress, clamped: back.progressClamped, reported: back.reported, afterMore });
    }
}

// ── 16. 库损坏 → 自动重建空库（用户决策②），坏文件留证 ─────────────
{
    const dir = join(DIR, 'corrupt');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // 写一个不是 sqlite 的垃圾文件
    writeFileSync(join(dir, 'board.sqlite'), 'this is definitely not a sqlite database', 'utf8');

    const { db, rebuilt, backup } = openBoard(dir);
    const n = countJobs(db);
    const backedUp = backup && existsSync(backup);

    // ★ 光"能打开"不算数（captain 2026-11-02 要求）：新库必须**真的可用** ——
    //   能加单、能读回、能领单。否则"重建成功"只是个空壳。
    let usable = false;
    let detail = null;
    try {
        const j = addJob(db, { title: 'after-rebuild', skill: 'collect', assignee: 'alpha' });
        const back = getJob(db, j.id);
        const claimed = claimFor(db, 'alpha');
        usable = !!back && back.skill === 'collect' && claimed?.id === j.id && countJobs(db) === 1;
        detail = { id: j.id, state: back?.state, claimed: claimed?.id };
    } catch (e) {
        detail = { err: String(e?.message ?? e) };
    }

    if (rebuilt && n === 0 && backedUp && usable) {
        okCase('库损坏 → 重建空库 + **新库确实可用**（能加单/读回/领单），坏文件改名留证',
            `backup=yes usable=${JSON.stringify(detail)}`);
    } else {
        badCase('库损坏重建', { rebuilt, n, backup, usable, detail });
    }
}

// ── 17. listJobs 过滤 / 排序（priority DESC）───────────────────────
{
    const { db } = freshDb();
    addJob(db, { title: 'low', skill: 'collect', assignee: 'alpha', priority: 2 });
    addJob(db, { title: 'high', skill: 'collect', assignee: 'alpha', priority: 8 });
    addJob(db, { title: 'other', skill: 'collect', assignee: 'beta', priority: 9 });

    const mine = listJobs(db, { assignee: 'alpha' });
    const ready = listJobs(db, { states: [JOB_STATE.READY] });
    const good = mine.length === 2 && mine[0].priority === 8 && ready.length === 3;
    if (good) okCase('listJobs 过滤与排序（priority DESC）', `mine=${mine.length} ready=${ready.length}`);
    else badCase('listJobs 过滤与排序', { mine: mine.map((m) => m.priority), ready: ready.length });
}

// ── 18. rowToJob 字段映射（lease 合并、repeat 合并）────────────────
{
    const row = {
        id: 'j_x', kind: 'personal', args: '{"a":1}', requires: null, claims: null,
        progress: '{"count":1,"want":2}', checkpoint: '{"s":1}', result: null, dependsOn: null,
        state: 'running', attempts: 1, maxAttempts: 3,
        lease_owner: 'alpha', lease_until: 12345, repeat_ms: 60000,
    };
    const j = rowToJob(row);
    const good = j.args?.a === 1 && j.progress?.count === 1 && j.checkpoint?.s === 1
        && j.state === 'running' && j.lease?.owner === 'alpha' && j.lease?.until === 12345
        && j.repeat?.everyMs === 60000;
    if (good) okCase('rowToJob 字段映射（lease/repeat 合并、JSON 反序列化）', 'ok');
    else badCase('rowToJob 字段映射', j);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
