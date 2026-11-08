/**
 * T6：资源协调显式化（架构收敛项 3）—— 离线，真 sqlite。
 *
 * 覆盖四件事：
 *   ① `deriveClaims` 补的四类（station/area/entity/item）+ "推不出来就不推"
 *   ② 冲突时序：两个 owner 抢同一 key → CLAIM_CONFLICT；TTL 过期 → 别人能拿到
 *   ③ **owner + state 守卫**：renewClaims / release / finish 三条都校验，
 *      `changes===0` → `LEASE_STALE` 且**一个字段都不写**
 *   ④ 执行期补占位：`ctx.reserveNow` / `bot.__reserveNow`（动作层注入），以及 noBoard 不再 fail-open
 *
 * 输出：PASS / FAIL，全过退出码 0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, addJob, getJob, claimFor, finish, setState, updateJob,
    reserve, release, renewClaims, listClaims, expireClaims,
    JOB_STATE, CLAIM_TTL_MS, BOARD_RESULT_CODES, LEASE_MS,
} from '../src/agent/library/board_store.js';
import { deriveClaims } from '../src/agent/library/board_claims.js';
import { makeCtx } from '../src/agent/library/composite_registry.js';
import { planStop } from '../src/agent/library/control.js';

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, a) => { fail++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'board-coord-test-'));
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); return openBoard(d).db; };

// ══════════════════════════════════════════════════════════════════════════
// ① deriveClaims：补齐四类（原来只有 block:/container:）
// ══════════════════════════════════════════════════════════════════════════
{
    const cases = [
        ['block（原有）', { skill: 'collect', args: { target: { x: 1, y: 64, z: 2 } } }, ['block:1,64,2']],
        ['container（原有）', { skill: 'store', args: { pos: { x: 3, y: 64, z: 4 } } }, ['container:3,64,4']],
        ['station:furnace（新）', { skill: 'smelt', args: { target: { x: 5, y: 64, z: 6 } } }, ['station:furnace@5,64,6']],
        ['station:crafting_table（新）', { skill: 'craft', args: { bench: { x: 7, y: 64, z: 8 } } }, ['station:crafting_table@7,64,8']],
        ['area（新）', { skill: 'build', args: { area: { x: 0, y: 64, z: 0, r: 8 } } }, ['area:0,64,0:8']],
        ['entity（新）', { skill: 'attack', args: { target: 'ent-9' } }, ['entity:ent-9']],
        ['item 材料额度（新）', { skill: 'craft', args: { target: { x: 1, y: 64, z: 1 }, materials: { oak_log: 4 } } }, ['station:crafting_table@1,64,1', 'item:oak_log:4']],
    ];
    const bad = [];
    for (const [name, job, want] of cases) {
        const got = deriveClaims(job);
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ name, got, want });
    }
    if (!bad.length) okCase('★ ① deriveClaims 六类都推导得出（block/container 原有 + station/area/entity/item 新增）', `${cases.length} 组`);
    else badCase('① deriveClaims 推导不符', bad);
}

// ①-b 推不出来就不推（不猜坐标 —— 猜出来的 key 挡不住真撞车，比不预约更糟）
{
    const got1 = deriveClaims({ skill: 'smelt', args: { item: 'iron_ingot' } });      // 没熔炉坐标
    const got2 = deriveClaims({ skill: 'mine', args: {} });
    const got3 = deriveClaims({ skill: 'craft', args: { item: 'stick' } });            // item 是产物，不是材料
    const good = got1.length === 0 && got2.length === 0 && got3.length === 0;
    if (good) okCase('①-b 推不出来就不推（熔炉没坐标/无目标/只有产物名 → 空）', JSON.stringify([got1, got2, got3]));
    else badCase('①-b 推导在猜坐标/猜材料', { got1, got2, got3 });
}

// ①-c 显式 claims 优先（不许被推导覆盖）
{
    const got = deriveClaims({ skill: 'mine', claims: ['area:1,1,1:4'], args: { target: { x: 9, y: 9, z: 9 } } });
    if (got.length === 1 && got[0] === 'area:1,1,1:4') okCase('①-c 单里显式 claims 优先于推导', JSON.stringify(got));
    else badCase('①-c 显式 claims 被覆盖', got);
}

// ══════════════════════════════════════════════════════════════════════════
// ② 冲突时序：两个 owner 抢同一 key
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const t0 = 1_000_000;
    const A = reserve(db, 'jobA', 'alpha', ['container:1,64,1'], { now: t0, ttlMs: CLAIM_TTL_MS });
    const B = reserve(db, 'jobB', 'beta', ['container:1,64,1'], { now: t0 + 10, ttlMs: CLAIM_TTL_MS });
    const conflictOk = A.ok === true && B.ok === false && B.code === 'CLAIM_CONFLICT'
        && (B.conflicts ?? []).includes('container:1,64,1');
    // 过期回收：ttl 到了之后 B 能拿到（"死掉的 bot 自动释放"）
    const B2 = reserve(db, 'jobB', 'beta', ['container:1,64,1'], { now: t0 + CLAIM_TTL_MS + 1, ttlMs: CLAIM_TTL_MS });
    const holder = listClaims(db, 'jobB').find((c) => c.key === 'container:1,64,1');
    if (conflictOk && B2.ok === true && holder?.owner === 'beta') {
        okCase('★ ② 冲突时序：alpha 占着 → beta CLAIM_CONFLICT；TTL 过期 → beta 拿到（自动释放）',
            `B.code=${B.code} 过期后B.ok=${B2.ok} holder=${holder?.owner}`);
    } else {
        badCase('② 冲突/过期回收时序不对', { A, B, B2, holder });
    }
}

// ②-b 跨类型冲突：area 挡住圆内的 block（"只做同类型精确匹配"等于没防住）
{
    const db = freshDb();
    const t0 = 2_000_000;
    const A = reserve(db, 'jobA', 'alpha', ['area:0,64,0:8'], { now: t0 });
    const B = reserve(db, 'jobB', 'beta', ['block:3,64,3'], { now: t0 + 1 });
    if (A.ok && !B.ok && B.code === 'CLAIM_CONFLICT') {
        okCase('★ ②-b 跨类型冲突：area:0,64,0:8 挡住圆内的 block:3,64,3', `B.code=${B.code}`);
    } else badCase('②-b 跨类型没挡住', { A, B });
}

// ══════════════════════════════════════════════════════════════════════════
// ③ owner + state 守卫（T6 的核心安全项）
// ══════════════════════════════════════════════════════════════════════════

// ③-a renewClaims：别人不能替你续预约（原来 `UPDATE ... WHERE id=?` 谁都能续）
{
    const db = freshDb();
    const t0 = 3_000_000;
    const job = addJob(db, { title: 'A 在跑', skill: 'mine', maxAttempts: 3 });
    claimFor(db, 'A', { now: t0 });
    reserve(db, job.id, 'A', ['block:9,9,9'], { now: t0, ttlMs: CLAIM_TTL_MS });
    const untilBefore = listClaims(db, job.id)[0].until;

    const steal = renewClaims(db, job.id, { now: t0 + 1000, owner: 'B' });
    const untilAfterSteal = listClaims(db, job.id)[0].until;
    const own = renewClaims(db, job.id, { now: t0 + 2000, owner: 'A' });
    const untilAfterOwn = listClaims(db, job.id)[0].until;

    const good = steal.ok === false && steal.code === BOARD_RESULT_CODES.LEASE_STALE
        && untilAfterSteal === untilBefore            // ★ 一个字段都没写
        && own.ok === true && own.renewed === 1 && untilAfterOwn > untilBefore;
    if (good) {
        okCase('★ ③-a renewClaims 只认 owner：B 续不动（LEASE_STALE 且 until 未变），A 能续',
            `steal=${steal.code} until ${untilBefore}→${untilAfterSteal}→${untilAfterOwn}`);
    } else {
        badCase('③-a renewClaims owner 守卫失效', { steal, untilBefore, untilAfterSteal, own, untilAfterOwn });
    }
}

// ③-b renewClaims：单不在跑（ready/终态）就不该续预约
{
    const db = freshDb();
    const t0 = 3_500_000;
    const job = addJob(db, { title: '停在 ready', skill: 'mine', maxAttempts: 3 });
    reserve(db, job.id, 'A', ['block:8,9,9'], { now: t0 });
    const untilBefore = listClaims(db, job.id)[0].until;
    const r = renewClaims(db, job.id, { now: t0 + 1000, owner: 'A' });
    const untilAfter = listClaims(db, job.id)[0].until;
    if (r.ok === false && r.code === BOARD_RESULT_CODES.LEASE_STALE && untilAfter === untilBefore) {
        okCase('★ ③-b renewClaims 看 state：单在 ready（没人在跑）→ 不续，字段未变', `code=${r.code}`);
    } else badCase('③-b renewClaims 不看 state', { r, untilBefore, untilAfter });
}

// ③-c release：别人不能把你正在用的资源全放掉
{
    const db = freshDb();
    const t0 = 4_000_000;
    const job = addJob(db, { title: 'A 在跑', skill: 'store', maxAttempts: 3 });
    claimFor(db, 'A', { now: t0 });
    reserve(db, job.id, 'A', ['container:2,64,2'], { now: t0 });

    const steal = release(db, job.id, 'B', null, { now: t0 + 100 });
    const stillThere = listClaims(db, job.id).length;
    const own = release(db, job.id, 'A', null, { now: t0 + 200 });
    const goneAfter = listClaims(db, job.id).length;

    const good = steal.ok === false && steal.code === BOARD_RESULT_CODES.LEASE_STALE
        && stillThere === 1 && own.ok === true && goneAfter === 0;
    if (good) {
        okCase('★ ③-c release 只认 owner：B 放不动（LEASE_STALE，预约还在），A 放得掉',
            `steal=${steal.code} 剩余=${stillThere}→${goneAfter}`);
    } else {
        badCase('③-c release owner 守卫失效（别人能放掉我的预约）', { steal, stillThere, own, goneAfter });
    }
}

// ③-d finish：租约不归我 → LEASE_STALE 且**一个字段都不写**
{
    const db = freshDb();
    const t0 = 5_000_000;
    const job = addJob(db, { title: 'A 在跑', skill: 'mine', maxAttempts: 3 });
    claimFor(db, 'A', { now: t0 });
    const before = getJob(db, job.id);
    const r = finish(db, job.id, { ok: true, code: 'OK', progress: { count: 9, want: 9 } }, { bot: 'B', now: t0 + 100 });
    const after = getJob(db, job.id);
    const untouched = after.state === before.state && after.progress?.count === before.progress?.count
        && JSON.stringify(after.result) === JSON.stringify(before.result);
    if (r.ok === false && r.code === BOARD_RESULT_CODES.LEASE_STALE && untouched) {
        okCase('★ ③-d finish：非 owner → LEASE_STALE 且 state/progress/result 一个字段都没写', `code=${r.code}`);
    } else badCase('③-d finish 无守卫（非 owner 也能写）', { r, before: before.state, after: after.state });
}

// ③-e finish：状态不该被收尾（blocked 是"等前置"的挂起态，不该被一次迟到 finish 推回 ready）
{
    const db = freshDb();
    const t0 = 5_500_000;
    const job = addJob(db, { title: '等前置', skill: 'mine', maxAttempts: 3 });
    setState(db, job.id, JOB_STATE.BLOCKED, {});
    const before = getJob(db, job.id);
    const r = finish(db, job.id, { ok: true, code: 'OK' }, { now: t0 + 100 });
    const after = getJob(db, job.id);
    if (r.ok === false && r.code === BOARD_RESULT_CODES.LEASE_STALE
        && after.state === JOB_STATE.BLOCKED && after.attempts === before.attempts) {
        okCase('★ ③-e finish 看 state：blocked 单不许被 finish 推回 ready（LEASE_STALE，字段未变）', `code=${r.code}`);
    } else badCase('③-e finish 不看 state', { r, state: after.state, attempts: after.attempts });
}

// ③-f `!stop` 的 patch 必须真的清租约（applyStop → board.update(patch)
//      → store 的 updateJob 要认 `lease` 这个字段名）
//      ★ 这条锁的是"paused 但租约还挂在自己名下"的那个根因。
{
    const db = freshDb();
    const t0 = 6_000_000;
    const job = addJob(db, { title: '被按停', skill: 'mine', maxAttempts: 3 });
    claimFor(db, 'A', { now: t0 });
    const plan = planStop({ reason: 'player', job: getJob(db, job.id), now: t0 + 100 });
    const r = updateJob(db, job.id, plan.patch, { now: t0 + 100 });
    const after = getJob(db, job.id);
    if (r.ok && after.state === JOB_STATE.PAUSED && after.lease?.owner == null && after.lease?.until == null) {
        okCase('★ ③-f planStop(player) 的 patch.lease=null 真的清掉了租约（paused 不再挂着租约）',
            `state=${after.state} lease=${JSON.stringify(after.lease)}`);
    } else {
        badCase('③-f patch.lease 被丢掉（paused 仍挂着自己的租约）', { r: r.ok, state: after.state, lease: after.lease });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 执行期补占位 + noBoard 不再 fail-open
// ══════════════════════════════════════════════════════════════════════════

/** 记账用的假板（形状与 BoardClient 一致：reserve/release 返回 ActionResult）。 */
function makeRecBoard() {
    const calls = [];
    const held = new Map();     // key → owner
    let nextConflict = null;
    return {
        calls, held,
        setConflict(keys) { nextConflict = keys; },
        reserve(id, keys) {
            calls.push({ op: 'reserve', id, keys });
            if (nextConflict) { const c = nextConflict; nextConflict = null; return Promise.resolve({ ok: false, code: 'CLAIM_CONFLICT', data: { conflicts: c } }); }
            for (const k of keys) held.set(k, id);
            return Promise.resolve({ ok: true, data: { reserved: keys, until: Date.now() + 30000 } });
        },
        release(id, keys) {
            calls.push({ op: 'release', id, keys });
            const list = Array.isArray(keys) ? keys : [keys];
            let n = 0;
            for (const k of list) if (held.delete(k)) n++;
            return Promise.resolve({ ok: true, data: { released: n } });
        },
    };
}

// ④-a ctx.reserveNow：有板有单 → 真的占位；冲突 → CLAIM_CONFLICT（交给上层换目标）
{
    const board = makeRecBoard();
    const job = { id: 'J1', skill: 'store', args: {} };
    const ctx = makeCtx({ bot: { name: 'b' }, board, boardClient: board }, job, null);
    const r1 = await ctx.reserveNow('container:5,64,5');
    board.setConflict(['container:5,64,5']);
    const r2 = await ctx.reserveNow('container:5,64,5');
    const keys = ctx.reservedKeys();
    if (r1.ok && r2.ok === false && r2.code === 'CLAIM_CONFLICT' && keys.includes('container:5,64,5')) {
        okCase('★ ④-a ctx.reserveNow：按真实目标占位；冲突 → CLAIM_CONFLICT（不静默继续）',
            `r1=${r1.ok} r2=${r2.code} tracked=${keys.length}`);
    } else badCase('④-a ctx.reserveNow 行为不对', { r1, r2, keys });
}

// ④-b 收尾释放：执行期补占的 key 必须被放掉（否则只能等 30 秒 TTL）
{
    const board = makeRecBoard();
    const ctx = makeCtx({ bot: { name: 'b' }, board, boardClient: board }, { id: 'J2', skill: 'store', args: {} }, null);
    await ctx.reserveNow('container:6,64,6');
    const n = await ctx.releaseRuntimeClaims();
    if (n === 1 && board.held.size === 0) okCase('★ ④-b releaseRuntimeClaims 把补占的 key 放干净（不用等 TTL）', `released=${n}`);
    else badCase('④-b 补占的 key 没被释放', { n, held: [...board.held.keys()] });
}

// ④-c noBoard：ctx.reserve 不再返回 ok:true（fail-open 改成显式）
{
    const ctx = makeCtx({ bot: { name: 'b' }, board: null }, { id: 'J3', skill: 'store', args: {} }, null);
    const r = await ctx.reserve('container:7,64,7');
    const rNow = await ctx.reserveNow('container:7,64,7');
    if (r.ok === false && r.code === 'NO_BOARD' && r.data?.noBoard === true
        && rNow.ok === false && rNow.code === 'NO_BOARD') {
        okCase('★ ④-c 无板时 ctx.reserve/reserveNow → ok:false + code=NO_BOARD（不再静默成功）',
            `${r.code}/${rNow.code}`);
    } else badCase('④-c 无板仍然 fail-open', { r, rNow });
}

// ④-d 无单（jobId=null）：明确 NO_JOB，且不当成"占位成功"
{
    const board = makeRecBoard();
    const ctx = makeCtx({ bot: { name: 'b' }, board, boardClient: board }, null, null);
    const r = await ctx.reserveNow('container:8,64,8');
    if (r.ok === false && r.code === 'NO_JOB' && board.calls.length === 0) {
        okCase('★ ④-d 没有任务单时 reserveNow → NO_JOB（连请求都不发，没有可归属的预约）', `code=${r.code}`);
    } else badCase('④-d 无单却被当成占位成功', { r, calls: board.calls.length });
}

// ④-e 动作层接线：`makeCtx` 必须把 reserveNow **挂到 bot 上**
//     （act_container / act_craft 拿不到 ctx，且**不许 import board** —— 分层规则）。
{
    const board = makeRecBoard();
    const bot = { name: 'b' };
    const ctx = makeCtx({ bot, board, boardClient: board }, { id: 'J4', skill: 'store', args: {} }, null);
    // 接线判据：bot 上真的有这个回调，且它就是 ctx 的那个（同一份实现）
    const wired = typeof bot.__reserveNow === 'function' && bot.__reserveNow === ctx.reserveNow;
    const r = typeof bot.__reserveNow === 'function' ? await bot.__reserveNow('container:9,64,9') : null;
    const noBoardBot = { name: 'b' };
    const ctxNoBoard = makeCtx({ bot: noBoardBot, board: null }, { id: 'J5', skill: 'store', args: {} }, null);
    const noBoardR = typeof noBoardBot.__reserveNow === 'function'
        ? await noBoardBot.__reserveNow('container:9,64,9') : null;
    if (wired && r?.ok === true && noBoardR?.ok === false && noBoardR.code === 'NO_BOARD'
        && ctxNoBoard.reserveNow !== undefined) {
        okCase('★ ④-e makeCtx 把 reserveNow 挂到 bot 上（动作层据此占位；无板 → NO_BOARD）',
            `wired=${wired} noBoard=${noBoardR?.code}`);
    } else badCase('④-e bot.__reserveNow 接线缺失/行为不对', { wired, r, noBoardR });
}

// ④-f 租约过期扫描不会把"有预约的单"和"没预约的单"区别对待（回归：预约不影响回收）
{
    const db = freshDb();
    const t0 = 9_000_000;
    const job = addJob(db, { title: 'A 崩了', skill: 'mine', maxAttempts: 5 });
    claimFor(db, 'A', { now: t0 });
    reserve(db, job.id, 'A', ['block:1,2,3'], { now: t0 });
    const { expireLeases } = await import('../src/agent/library/board_store.js');
    expireLeases(db, t0 + LEASE_MS + 1);
    expireClaims(db, t0 + LEASE_MS + 1 + CLAIM_TTL_MS + 1);
    const after = getJob(db, job.id);
    if (after.state === JOB_STATE.READY && after.lease?.owner == null && listClaims(db, job.id).length === 0) {
        okCase('★ ④-f 主人崩了：租约过期 → 单回 ready + 预约随 TTL 清空（资源不会永久被占）', `state=${after.state}`);
    } else {
        badCase('④-f 崩溃后资源没释放', { state: after.state, lease: after.lease, claims: listClaims(db, job.id).length });
    }
}

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* Windows 上可能删不掉，无妨 */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
