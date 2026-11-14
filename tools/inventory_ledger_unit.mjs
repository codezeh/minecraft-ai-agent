/**
 * 共享库存（ADR 阶段 3 / D7）离线测试：预占 / 结算 / 对账 / 访客不记账。
 *
 * 每条都能红，重点两条：
 *   · ② 并发（两个连接 + 在 INSERT 前插一刀）：证明"读-判断-写"真的在同一个写事务里 ——
 *     把 `runInImmediateTx` 摘掉，对手方的预占会插进来，总数变 12 > 已知库存 10 ⇒ 红。
 *   · ④ 对账以真实为准：缓存说 57、真实是 50，账本必须记 -7 并把缓存改成 50；
 *     同样输入再跑一次必须**不再写任何行**（对账可重复跑）。
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openBoard, BOARD_SCHEMA_VERSION } from '../src/agent/library/board_store.js';
import { attachBoardServer } from '../src/agent/library/board_server.js';
import {
    refreshContainerCache, markContainerDirty, reserveStock, settleTake, reconcileContainers,
    inventorySnapshot, inventoryLedger, expireReservations, INVENTORY_RESULT_CODES,
} from '../src/agent/library/board_inventory.js';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'inventory-test-'));

// ★ 同 team_store_unit / wiring_flow_reserve_unit：`_global/mind.sqlite` 的路径只由
//   botsRootOf() 决定，只隔离 board 目录不够 ⇒ 本文件走真 attachBoardServer 时
//   会把 w_inv 的测试事件写进**生产** bots/_global。
process.env.MC_BOTS_ROOT = join(DIR, 'bots');
let seq = 0;
const freshBoard = () => openBoard(join(DIR, `db${++seq}`));
const CACHE = { x: 10, y: 64, z: -3 };

const seed = (db, worldId, items, pos = CACHE) => refreshContainerCache(db, { worldId, ...pos, items });
const sumReserved = (db, worldId, item) => Number(db.prepare(
    "SELECT COALESCE(SUM(qty), 0) AS n FROM inventory_reservation WHERE world_id = ? AND item = ? AND status = 'held'",
).get(worldId, item)?.n ?? 0);
const countLedger = (db, worldId, reason = null) => Number(
    (reason
        ? db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger WHERE world_id = ? AND reason = ?').get(worldId, reason)
        : db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger WHERE world_id = ?').get(worldId)
    )?.n ?? 0,
);

// ══════════════════════════════════════════════════════════════════════════
// ① 结构：schema v5 + 四张表（三张库存 + 一张访客审计）+ 索引
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    const want = ['inventory_reservation', 'inventory_ledger', 'container_cache', 'inventory_audit'];
    const missing = want.filter((t) => !tables.includes(t));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => String(r.name));
    const missIdx = ['idx_inv_res_open', 'idx_inv_ledger'].filter((i) => !idx.includes(i));
    const uv = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? -1);
    if (!missing.length && !missIdx.length && uv === BOARD_SCHEMA_VERSION && BOARD_SCHEMA_VERSION === 5) {
        okCase('① schema=v5，四张库存表与索引都在', `uv=${uv} missing=0`);
    } else {
        badCase('① 库存表/索引/版本号不齐', { missing, missIdx, uv, want: BOARD_SCHEMA_VERSION });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ② 并发：预占的"读-判断-写"必须在同一个 BEGIN IMMEDIATE 里（对手方插不进来）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db: dbA } = freshBoard();
    // 同文件的第二连接 = "另一个写者"（直接用 node:sqlite，不重跑一遍迁移）
    const { DatabaseSync } = await import('node:sqlite');
    const file = dbA.prepare('PRAGMA database_list').all().find((r) => String(r.name) === 'main')?.file;
    if (!file) throw new Error('拿不到板库文件路径：并发用例无法进行');
    const rival = new DatabaseSync(String(file));
    rival.exec('PRAGMA busy_timeout = 30');                // 抢不到就立刻失败（不等 5 秒）
    seed(dbA, 'w1', { oak_log: 10 });

    let fired = false;
    const probe = { blocked: false, raced: false, err: null };
    /** 在"我方 INSERT 预占"之前，让对手方试着插一条 6 个 —— 它能不能成功，就是事务边界有没有生效的判据。 */
    const tryRival = () => {
        if (fired) return;
        fired = true;
        try {
            rival.exec('BEGIN IMMEDIATE');
            rival.prepare(`INSERT INTO inventory_reservation (id, world_id, item, qty, holder, created_at, expires_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'held')`).run('rival-row', 'w1', 'oak_log', 6, 'rival', Date.now(), Date.now() + 60000);
            rival.exec('COMMIT');
            probe.raced = true;                            // 写锁没被我们持有 ⇒ 事务边界不成立
        } catch (e) {
            probe.blocked = /locked|busy/i.test(String(e?.message ?? e));
            probe.err = String(e?.message ?? e);
            try { rival.exec('ROLLBACK'); } catch { /* 没开成事务就不用回滚 */ }
        }
    };
    const spy = {
        get isTransaction() { return dbA.isTransaction; },
        exec: (sql) => dbA.exec(sql),
        prepare: (sql) => {
            const stmt = dbA.prepare(sql);
            return {
                get: (...a) => stmt.get(...a),
                all: (...a) => stmt.all(...a),
                run: (...a) => {
                    if (/INSERT INTO inventory_reservation/.test(sql)) tryRival();
                    return stmt.run(...a);
                },
            };
        },
    };

    const got = reserveStock(spy, { worldId: 'w1', item: 'oak_log', qty: 6, holder: 'alpha' });
    const total = sumReserved(dbA, 'w1', 'oak_log');
    const rivalRows = Number(dbA.prepare("SELECT COUNT(*) AS n FROM inventory_reservation WHERE id = 'rival-row'").get()?.n ?? 0);
    if (got.ok === true && probe.raced === false && probe.blocked === true && total === 6 && rivalRows === 0) {
        okCase('② 并发预占不超卖：写事务期间对手方 BEGIN IMMEDIATE 被挡（blocked），库里只我方 6 个', `total=${total} blocked=${probe.blocked}`);
    } else {
        badCase('② 预占没有把校验和写入关在一个写事务里（或对手方插进来了）', { got, total, rivalRows, probe });
    }
    try { rival.close(); } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 预占：可用量算错就要报两个数字；世界维度隔离
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    seed(db, 'w1', { oak_log: 60, stone: 5 });
    seed(db, 'w2', { oak_log: 1 }, { x: 0, y: 0, z: 0 });
    const a = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 40, holder: 'alpha' });
    const over = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 30, holder: 'beta' });
    const otherWorld = reserveStock(db, { worldId: 'w2', item: 'oak_log', qty: 1, holder: 'alpha' });
    const bad = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 0, holder: 'alpha' });
    // TTL 上限：客户端不能靠"要一个超长 TTL"把库存锁死
    const longTtl = reserveStock(db, { worldId: 'w1', item: 'stone', qty: 1, holder: 'alpha', ttlMs: 999 * 60 * 60 * 1000 });
    const ttlCapped = longTtl.ok === true && longTtl.expiresAt - Date.now() <= 60 * 60 * 1000 + 1000;
    const noWho = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 1, holder: '  ' });
    const ok = a.ok === true && a.known === 60 && a.reserved === 0 && a.available === 20
        && over.ok === false && over.code === INVENTORY_RESULT_CODES.INSUFFICIENT_STOCK
        && over.known === 60 && over.reserved === 40 && over.available === 20 && over.requested === 30
        && otherWorld.ok === true && otherWorld.known === 1
        && bad.ok === false && noWho.ok === false && noWho.code === INVENTORY_RESULT_CODES.NO_PERMISSION
        && ttlCapped;
    if (ok) okCase('③ 预占按"已知-已预占"判定；超额给 known/reserved/available/requested 四个数字；存档隔离', `over=${over.code} ${over.known}/${over.reserved}/${over.available}`);
    else badCase('③ 预占判定或报数不对', { a, over, otherWorld, bad, noWho });
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 过期自动作废：额度回到可用池；再结算 ⇒ RESERVATION_EXPIRED
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    seed(db, 'w1', { oak_log: 10 });
    const t0 = Date.now();
    const held = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 10, holder: 'alpha', ttlMs: 1000, now: t0 });
    const blockedByHold = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 1, holder: 'beta', now: t0 });
    const after = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 10, holder: 'beta', now: t0 + 2000 });
    const lateSettle = settleTake(db, { worldId: 'w1', reservationId: held.id, holder: 'alpha', qty: 10, now: t0 + 2000 });
    const status = String(db.prepare('SELECT status FROM inventory_reservation WHERE id = ?').get(held.id)?.status ?? '');
    const ok = held.ok === true && blockedByHold.ok === false
        && after.ok === true && after.reserved === 0 && after.known === 10
        && lateSettle.ok === false && lateSettle.code === INVENTORY_RESULT_CODES.RESERVATION_EXPIRED
        && status === 'void' && countLedger(db, 'w1') === 0;
    if (ok) okCase('④ 过期自动作废：额度回池（reserved=0），旧券再结算 ⇒ RESERVATION_EXPIRED，且不写账本', `status=${status} code=${lateSettle.code}`);
    else badCase('④ 过期/作废行为不对', { held, blockedByHold, after, lateSettle, status });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 结算：写账本 + 预占转消耗 + 缓存扣减；重复结算幂等
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    seed(db, 'w1', { oak_log: 60 });
    const held = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 5, holder: 'alpha' });
    const settled = settleTake(db, { worldId: 'w1', reservationId: held.id, holder: 'alpha', qty: 3, container: CACHE });
    const again = settleTake(db, { worldId: 'w1', reservationId: held.id, holder: 'alpha', qty: 3, container: CACHE });
    const cacheAfter = JSON.parse(db.prepare('SELECT items_json FROM container_cache WHERE world_id = ? AND x = ? AND y = ? AND z = ?')
        .get('w1', CACHE.x, CACHE.y, CACHE.z)?.items_json ?? '{}');
    const res = db.prepare('SELECT status, consumed_qty FROM inventory_reservation WHERE id = ?').get(held.id);
    const led = inventoryLedger(db, { worldId: 'w1' });
    const held2 = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 4, holder: 'alpha' });
    const tooMuch = settleTake(db, { worldId: 'w1', reservationId: held2.id, holder: 'alpha', qty: 9 });
    const ok = settled.ok === true && settled.already === false && settled.ledger?.delta === -3
        && again.ok === true && again.already === true && again.ledger?.delta === -3
        && countLedger(db, 'w1') === 1 && led.entries.length === 1
        && String(res?.status) === 'consumed' && Number(res?.consumed_qty) === 3
        && Number(cacheAfter.oak_log) === 57 && settled.cache?.applied === true
        && tooMuch.ok === false && tooMuch.code === INVENTORY_RESULT_CODES.TOO_MUCH;
    if (ok) okCase('⑤ 结算：账本 -3、预占 consumed、缓存 60→57；重复结算 already=true 且**不重复扣**（账本仍 1 行）', `cache=${cacheAfter.oak_log} ledger=${led.entries.length}`);
    else badCase('⑤ 结算/幂等/缓存扣减不对', { settled, again, cacheAfter, res, led: led.entries, tooMuch });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 结算的身份与归属：别人的券不能结；跨存档不能结
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    seed(db, 'w1', { oak_log: 10 });
    const held = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 4, holder: 'alpha' });
    const other = settleTake(db, { worldId: 'w1', reservationId: held.id, holder: 'beta', qty: 1 });
    const otherWorld = settleTake(db, { worldId: 'w2', reservationId: held.id, holder: 'alpha', qty: 1 });
    const ghost = settleTake(db, { worldId: 'w1', reservationId: 'no-such', holder: 'alpha', qty: 1 });
    const ok = other.ok === false && other.code === INVENTORY_RESULT_CODES.NO_PERMISSION
        && otherWorld.ok === false && otherWorld.code === INVENTORY_RESULT_CODES.NO_TARGET
        && ghost.ok === false && ghost.code === INVENTORY_RESULT_CODES.NO_TARGET
        && countLedger(db, 'w1') === 0;
    if (ok) okCase('⑥ 别人的券/跨存档/不存在的券一律拒，且账本 0 行', `${other.code}/${otherWorld.code}/${ghost.code}`);
    else badCase('⑥ 归属校验不对', { other, otherWorld, ghost });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 对账（必选）：以真实为准修正账本 + 可读差异报告；重复跑不制造噪音
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    seed(db, 'w1', { oak_log: 60, stone: 5 });
    const held = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 5, holder: 'alpha' });
    settleTake(db, { worldId: 'w1', reservationId: held.id, holder: 'alpha', qty: 3, container: CACHE });   // 缓存 57
    const dry = reconcileContainers(db, { worldId: 'w1', observations: [{ ...CACHE, items: { oak_log: 50 } }], dryRun: true });
    const afterDry = JSON.parse(db.prepare('SELECT items_json FROM container_cache WHERE world_id = ?').get('w1')?.items_json ?? '{}');
    const real = reconcileContainers(db, { worldId: 'w1', observations: [{ ...CACHE, items: { oak_log: 50 } }], holder: 'reconciler' });
    const cacheNow = JSON.parse(db.prepare('SELECT items_json FROM container_cache WHERE world_id = ?').get('w1')?.items_json ?? '{}');
    const adj = db.prepare("SELECT delta, reason, holder FROM inventory_ledger WHERE world_id = ? AND reason = 'reconcile'").all('w1');
    const second = reconcileContainers(db, { worldId: 'w1', observations: [{ ...CACHE, items: { oak_log: 50 } }] });
    const ledCount = countLedger(db, 'w1');
    const deltas = adj.map((r) => Number(r.delta)).sort((x, y) => x - y);
    const ok = dry.ok === true && dry.written === 0 && Number(afterDry.oak_log) === 57
        && real.ok === true && real.changed === 1 && real.written === 2
        && real.diffs.length === 2 && real.diffs.some((d) => d.item === 'oak_log' && d.delta === -7)
        && real.diffs.some((d) => d.item === 'stone' && d.delta === -5)
        && Number(cacheNow.oak_log) === 50 && !('stone' in cacheNow)
        && adj.length === 2 && deltas[0] === -7 && deltas[1] === -5 && String(adj[0].holder) === 'reconciler'
        && /oak_log 账 57 → 真 50（修正 -7）/.test(real.lines.join('\n'))
        && second.ok === true && second.changed === 0 && second.written === 0 && countLedger(db, 'w1') === ledCount;
    if (ok) okCase('⑦ 对账以真实为准：dryRun 不写；正式跑记 -7 并把缓存改成 50（stone 消失）；再跑一次 0 差异 0 写入', `${real.summary}`);
    else badCase('⑦ 对账没有以真实为准/重复跑有噪音', { dry, real, cacheNow, adj, second, ledCount });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 访客不记账：无 reservation、无 ledger，只留审计；取用把容器标脏
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    seed(db, 'w1', { oak_log: 20 });
    const resCount0 = Number(db.prepare('SELECT COUNT(*) AS n FROM inventory_reservation').get()?.n ?? 0);
    const heard = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 99, holder: 'visitor-bot', visitor: true });
    const took = settleTake(db, { worldId: 'w1', reservationId: null, holder: 'visitor-bot', qty: 4, container: CACHE, visitor: true });
    const resCount1 = Number(db.prepare('SELECT COUNT(*) AS n FROM inventory_reservation').get()?.n ?? 0);
    const audits = db.prepare("SELECT action, actor FROM inventory_audit WHERE actor = 'visitor-bot'").all();
    const dirty = Number(db.prepare('SELECT dirty FROM container_cache WHERE world_id = ?').get('w1')?.dirty ?? -1);
    const ok = heard.ok === true && heard.visitor === true && heard.skipped === true
        && took.ok === true && took.skipped === true
        && resCount0 === 0 && resCount1 === 0 && countLedger(db, 'w1') === 0
        && audits.length === 2 && dirty === 1;
    if (ok) okCase('⑧ 访客：预占/结算都不落本机账本（reservation 0、ledger 0），只留 2 条审计；容器标脏 dirty=1', `audits=${audits.length}`);
    else badCase('⑧ 访客把账写进本机了（或没留审计）', { heard, took, resCount1, ledger: countLedger(db, 'w1'), audits, dirty });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑨ 开箱强刷 / 取用失败标脏 / 未知库存不超卖
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    const unknown = reserveStock(db, { worldId: 'w1', item: 'diamond', qty: 1, holder: 'alpha' });
    const dirty = markContainerDirty(db, { worldId: 'w1', ...CACHE, reason: 'take-failed', now: 1234 });
    const row1 = db.prepare('SELECT items_json, dirty, updated_at FROM container_cache WHERE world_id = ?').get('w1');
    const refresh = refreshContainerCache(db, { worldId: 'w1', ...CACHE, items: { oak_log: 7, bad: 0, neg: -2 }, now: 2234 });
    const row2 = db.prepare('SELECT items_json, dirty, updated_at FROM container_cache WHERE world_id = ?').get('w1');
    const items2 = JSON.parse(row2?.items_json ?? '{}');
    const after = reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 7, holder: 'alpha' });
    const ok = unknown.ok === false && unknown.code === INVENTORY_RESULT_CODES.INSUFFICIENT_STOCK && unknown.known === 0
        && dirty.ok === true && Number(row1?.dirty) === 1 && Number(row1?.updated_at) === 1234
        && refresh.ok === true && refresh.changed === true && refresh.dropped.length === 2
        && Number(row2?.dirty) === 0 && Number(row2?.updated_at) === 2234
        && Number(items2.oak_log) === 7 && !('bad' in items2) && !('neg' in items2)
        && after.ok === true && after.known === 7;
    if (ok) okCase('⑨ 没观测过 ⇒ 已知 0 且拒（不超卖）；标脏生效、强刷清脏并丢弃非法条目', `known=${unknown.known} dropped=${refresh.dropped.length}`);
    else badCase('⑨ 强刷/标脏/未知库存行为不对', { unknown, dirty, row1, refresh, row2, items2, after });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑩ 没有存档维度 ⇒ 一律拒（NO_BOARD，绝不退化）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    const r1 = reserveStock(db, { worldId: '', item: 'oak_log', qty: 1, holder: 'a' });
    const r2 = settleTake(db, { worldId: '', reservationId: 'x', holder: 'a' });
    const r3 = reconcileContainers(db, { worldId: '', observations: [{ ...CACHE, items: {} }] });
    const r4 = inventorySnapshot(db, { worldId: '' });
    const r5 = expireReservations(db, {});
    const r6 = markContainerDirty(db, { worldId: '', ...CACHE });
    const all = [r1, r2, r3, r4, r5, r6];
    if (all.every((r) => r.ok === false && r.code === INVENTORY_RESULT_CODES.NO_BOARD)) {
        okCase('⑩ 没有 world_id ⇒ 六个入口全部 NO_BOARD（不退化到"单库单世界"）');
    } else {
        badCase('⑩ 缺存档维度时没有全部拒绝', all);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑪ 快照：known/reserved/available 与预占明细
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard();
    seed(db, 'w1', { oak_log: 60, stone: 5 });
    reserveStock(db, { worldId: 'w1', item: 'oak_log', qty: 20, holder: 'alpha' });
    const snap = inventorySnapshot(db, { worldId: 'w1' });
    const oak = snap.items?.find((i) => i.item === 'oak_log');
    const one = inventorySnapshot(db, { worldId: 'w1', item: 'stone' });
    const ok = snap.ok === true && snap.items.length === 2
        && oak && oak.known === 60 && oak.reserved === 20 && oak.available === 40
        && snap.reservations.length === 1 && snap.containers.length === 1
        && one.ok === true && one.items.length === 1 && one.items[0].item === 'stone' && one.items[0].available === 5;
    if (ok) okCase('⑪ 快照：oak_log 60/20/40、单物品过滤、预占明细在', `items=${snap.items.length}`);
    else badCase('⑪ 快照数字不对', { snap, one });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑫ 真接线（socket）：世界只认服务端裁决；访客只认服务端注入的判定
// ══════════════════════════════════════════════════════════════════════════
function makePair(serverData) {
    const handlers = new Map();
    const serverSocket = { on(event, fn) { handlers.set(event, fn); }, data: { ...serverData } };
    const clientSocket = {
        on() { /* 忽略广播 */ },
        emit(event, payload, ack) {
            const h = handlers.get(event);
            if (!h) { ack?.({ ok: false, code: 'NO_HANDLER', reason: `no handler for ${event}` }); return; }
            h(payload, ack);
        },
    };
    const io = { on(event, fn) { if (event === 'connection') fn(serverSocket); }, emit() { /* 广播不关心 */ } };
    return { io, clientSocket };
}
const call = (clientSocket, event, payload) => new Promise((resolve) => {
    let done = false;
    clientSocket.emit(event, payload, (a) => { if (done) return; done = true; resolve(a); });
    setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: 'timeout' }); } }, 1500);
});

{
    const { io, clientSocket } = makePair({ role: 'agent', agentName: 'alpha' });
    const db = openBoard(join(DIR, 'wired', '_worlds', 'w_inv', '_board')).db;
    seed(db, 'w_inv', { oak_log: 8 });
    const server = attachBoardServer({
        io, db,
        worldIdOf: () => 'w_inv',
        isVisitor: ({ bot }) => bot === 'guest-bot',   // 服务端注入：只有 guest-bot 是访客
    });
    try {
        await call(clientSocket, 'board:hello', { bot: 'alpha', skills: [] });
        const res = await call(clientSocket, 'inventory:reserve', { item: 'oak_log', qty: 3, bot: 'alpha' });
        const rows = db.prepare('SELECT world_id, item FROM inventory_reservation').all();
        const settled = await call(clientSocket, 'inventory:settle', {
            reservationId: res?.reservation?.id, qty: 2, container: CACHE, bot: 'alpha',
        });
        const snap = await call(clientSocket, 'inventory:snapshot', { bot: 'alpha' });
        const recon = await call(clientSocket, 'inventory:reconcile', {
            observations: [{ ...CACHE, items: { oak_log: 0 } }], dryRun: true,
        });
        // 对账的"真实内容"由客户端上报，所以必须**可归因**：payload.holder 是自称，必须被忽略
        const reconWrite = await call(clientSocket, 'inventory:reconcile', {
            observations: [{ ...CACHE, items: { oak_log: 0 } }], holder: 'liar',
        });
        const reconLed = db.prepare("SELECT holder, delta FROM inventory_ledger WHERE reason = 'reconcile'").all();

        // 访客：`payload.visitor` 是客户端自报，**必须被忽略**；只有注入的判定算数
        const g = makePair({ role: 'agent', agentName: 'guest-bot' });
        const guestServer = attachBoardServer({ io: g.io, db, worldIdOf: () => 'w_inv', isVisitor: () => true });
        await call(g.clientSocket, 'board:hello', { bot: 'guest-bot', skills: [] });
        const gRes = await call(g.clientSocket, 'inventory:reserve', { item: 'oak_log', qty: 5, bot: 'guest-bot', visitor: false });
        guestServer.stop();
        const ledgerRows = countLedger(db, 'w_inv');

        const ok = res.ok === true && res.reservation?.known === 8 && res.reservation?.available === 5
            && rows.length === 1 && String(rows[0].world_id) === 'w_inv'
            && settled.ok === true && settled.ledger?.delta === -2
            && snap.ok === true && snap.items?.some((i) => i.item === 'oak_log' && i.known === 6)
            && recon.ok === true && recon.dryRun === true && recon.diffs?.some((d) => d.delta === -6)
            && reconWrite.ok === true && reconLed.length === 1
            && String(reconLed[0].holder) === 'alpha' && Number(reconLed[0].delta) === -6   // 归因给 alpha，不是自称的 liar
            && gRes.ok === true && gRes.visitor === true
            && ledgerRows === 2;    // take 1 行 + reconcile 1 行；访客那条**没进账本**
        if (ok) okCase('⑫ 真接线：世界由 worldIdOf 裁决并落库；reserve→settle→snapshot→reconcile 全通；访客只认服务端注入（payload.visitor 被忽略）',
            `world=${rows[0]?.world_id} ledger=${ledgerRows}`);
        else badCase('⑫ 库存 socket 接线不对', { res, rows, settled, snap, recon, gRes, ledgerRows });
    } finally { server.stop(); }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑬ 真接线（socket）：拿不到存档维度 ⇒ 一律 NO_BOARD（旧位置/内存库不许记账）
// ══════════════════════════════════════════════════════════════════════════
{
    const { io, clientSocket } = makePair({ role: 'agent', agentName: 'beta' });
    const db = openBoard(join(DIR, 'legacy', '_board')).db;
    const server = attachBoardServer({ io, db, worldIdOf: () => { throw new Error('WORLD_ID_UNRESOLVABLE'); } });
    try {
        await call(clientSocket, 'board:hello', { bot: 'beta', skills: [] });
        const res = await call(clientSocket, 'inventory:reserve', { item: 'oak_log', qty: 1, bot: 'beta' });
        const snap = await call(clientSocket, 'inventory:snapshot', { bot: 'beta' });
        const n = Number(db.prepare('SELECT COUNT(*) AS n FROM inventory_reservation').get()?.n ?? 0);
        if (res.ok === false && res.code === 'NO_BOARD' && snap.ok === false && snap.code === 'NO_BOARD' && n === 0) {
            okCase('⑬ 旧位置/解析不出存档 ⇒ 预占与快照都 NO_BOARD，库表 0 行（不退化）', `code=${res.code}`);
        } else {
            badCase('⑬ 缺存档维度时库存没有拒绝', { res, snap, n });
        }
    } finally { server.stop(); }
}

// ── ㉒ expired 口径：数组 vs 数字（同名字段两种类型的歧义）─────────────
//   `inventorySnapshot().expired` 是**券 id 数组**；`expireReservations().expired` 是**数字**。
//   前端若写 `Number(expired)||0`，`Number([])===0` ⇒ "刚作废 3 张"会显示成 0（可读的谎话）。
//   现统一补 `expiredCount`（数字），让调用方不必自己数、也不必猜类型。
{
    const wid = 'w-expired-shape';
    // 自己开一块库（上面两个块各自 const db，作用域不通）
    const db = openBoard(join(DIR, 'expired-shape', '_worlds', wid, '_board')).db;
    db.prepare("INSERT OR REPLACE INTO inventory_reservation (id, world_id, item, qty, holder, created_at, expires_at, status, consumed_qty, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run('r-exp-1', wid, 'oak_log', 3, 'botX', 1, 2, 'held', 0, null);
    const snap = inventorySnapshot(db, { worldId: wid, now: 10_000 });
    if (snap.ok && Array.isArray(snap.expired) && snap.expired.length === 1 && snap.expiredCount === 1) {
        okCase("㉒ snapshot.expired 是数组且 expiredCount 是数字（同名字段歧义已消除）",
            `expired=${JSON.stringify(snap.expired)} expiredCount=${snap.expiredCount}`);
    } else {
        badCase("㉒ snapshot.expired / expiredCount 形状不对", snap);
    }
    // 反向：把 expiredCount 写成 Number(expired)||0 的常见错误 ⇒ 必须能被抓到
    const wrong = Number(snap.expired) || 0;
    if (wrong === 0 && snap.expired.length === 1) {
        okCase("㉒ 反证：Number(expired)||0 会把 1 张算成 0（说明为什么必须有 expiredCount）", `wrong=${wrong}`);
    } else {
        badCase("㉒ 反证不成立（说明这条断言没意义）", { wrong, len: snap.expired.length });
    }
    db.exec(`DELETE FROM inventory_reservation WHERE world_id = '${wid}'`);
}

// ── 收尾 ────────────────────────────────────────────────────────────────
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
console.log(`\n${pass} pass / ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
