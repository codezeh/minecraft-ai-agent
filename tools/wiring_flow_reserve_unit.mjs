#!/usr/bin/env node
/**
 * 共享库存取用闭环（R6 / fixes4 接线 t4）：**先预占 → 取用 → 结算**，取不到就还券。
 *
 * 缺陷原貌（docs/audit-r6/fixes4/inventory.md §8-2 自认未做）：
 *   `flow_store.fetch` 只做"开箱强刷 + 失败标脏"，**不预占** ⇒ 差额靠事后对账吸收。
 *   多 bot 抢同一批材料时，谁都能先伸手；账实分叉只能靠 reconcile 追平。
 *
 * 本次接线（**显式 opt-in**：`opts.shared === true`，不传 ⇒ 行为与原来完全一致）：
 *   ① 预占成功 → 真取 → `settle(实际量)`（未用掉的额度随 consumed 回池）；
 *   ② 预占失败 ⇒ **一件都不取**，回 NO_ITEM + boardCode=INSUFFICIENT_STOCK + 四个数；
 *   ③ 一件都没取到 ⇒ `release` 还券，额度**立即回池**（不白占、不等 5 分钟 TTL）；
 *   ④ 取出 ≥1 个 ⇒ 结实际量，剩余额度回池。
 *
 * 每条都能红（实测过的红法）：
 *   ③ 去掉 `releaseReservation` 的 `AND holder = ?` ⇒ 用例 ⑦ 红（B 释放了 A 的券）；
 *   ③ 把释放改成"只写账本、状态不动"（等于等 TTL）⇒ 用例 ④ 的"B 立刻能预占到"红；
 *   ② 把"预占失败就不取"改成"先取了再说" ⇒ 用例 ② 的物理守恒断言红。
 *
 * 链路是真的：真 `openBoard`（node:sqlite）+ 真 `attachBoardServer`（socket handler）+
 * 真 `BoardClient`（经假 socket 对上真 handler）+ 假 bot（假窗口，不连服务器）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import Vec3 from 'vec3';
import { openBoard } from '../src/agent/library/board_store.js';
import { attachBoardServer } from '../src/agent/library/board_server.js';
import { BoardClient } from '../src/agent/library/board_client.js';
import { refreshContainerCache } from '../src/agent/library/board_inventory.js';
import { store, fetch as fetchFlow } from '../src/agent/library/flow_store.js';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'wiring-flow-'));
let seq = 0;
const CHEST = { x: 1, y: 64, z: 0 };
const ITEM = 'stone';

/**
 * 假 socket.io：`connect()` 一条"服务端 socket + 客户端 socket"对，事件直接交给真 handler。
 * 与 `inventory_ledger_unit` 的 makePair 同口径（只是同一条 io 上允许多条连接，用例 ⑦ 要两只 bot）。
 */
function makeIo() {
    const io = {
        _onConn: null,
        on(event, fn) { if (event === 'connection') io._onConn = fn; },
        emit() { /* 广播不关心 */ },
        connect(data = {}) {
            const handlers = new Map();
            // 身份戳由服务端注入（真实链路里是 login-agent 成功后才写；这里直接给）
            const serverSocket = { on(e, fn) { handlers.set(e, fn); }, data: { ...data } };
            const clientSocket = {
                on() { /* 忽略服务端广播 */ },
                emit(event, payload, ack) {
                    const h = handlers.get(event);
                    if (!h) { ack?.({ ok: false, code: 'NO_HANDLER', reason: `no handler for ${event}` }); return; }
                    h(payload, ack);
                },
            };
            io._onConn?.(serverSocket);
            return clientSocket;
        },
    };
    return io;
}

/** 一整套真链路：真库 + 真服务端 + 真客户端（名字 = `name` 的 bot）。 */
async function makeStack({ name = 'alpha', worldId = 'w1', visitor = false } = {}) {
    const { db } = openBoard(join(DIR, `db${++seq}`));
    const io = makeIo();
    const server = attachBoardServer({
        io, db,
        worldIdOf: () => worldId,
        ...(visitor ? { isVisitor: () => true } : {}),
    });
    const clientSocket = io.connect({ role: 'agent', agentName: name });
    const board = new BoardClient({ socket: clientSocket, name, skills: ['store', 'fetch'], timeoutMs: 3000 });
    const hello = await board.hello();
    if (!hello.ok) throw new Error(`hello 失败：${JSON.stringify(hello)}`);
    return { db, server, board, io };
}

/**
 * 假 bot + 假窗口（照 `bot009_partial_move_unit` 的成熟做法：窗口内容从 state 现读，
 * 背包靠 `mirror()` 镜像）。`board` 挂在 `bot.agent.board` 上（flow_store.boardOf 的口径）。
 */
function makeBot({ board, chest = 0, inv = 0, withdrawImpl = null, depositImpl = null } = {}) {
    const state = { chest, inv };
    const pos = new Vec3(CHEST.x, CHEST.y, CHEST.z);

    const makeWindow = (over = {}) => {
        const win = {
            slots: new Array(63).fill(null),
            inventoryStart: 27,
            inventoryEnd: 63,
            title: 'chest',
            containerItems() {
                return state.chest > 0 ? [{ name: ITEM, type: 1, count: state.chest }] : [];
            },
            mirror() {
                for (let i = 27; i < 63; i++) win.slots[i] = null;
                if (state.inv > 0) win.slots[27] = { name: ITEM, type: 1, count: state.inv, slot: 0 };
            },
            deposit: async (type, meta, n) => {
                if (over.deposit) { await over.deposit(n, state); win.mirror(); return; }
                const k = Math.min(n, state.inv);
                state.inv -= k; state.chest += k;
                win.mirror();
            },
            withdraw: async (type, meta, n) => {
                if (over.withdraw) { await over.withdraw(n, state); win.mirror(); return; }
                const k = Math.min(n, state.chest);
                state.chest -= k; state.inv += k;
                win.mirror();
            },
        };
        win.mirror();
        return win;
    };

    // 自定义的存取行为（模拟"部分成功后抛错"/"一件都没动"）要通过窗口实现注入
    let current = { over: { ...(withdrawImpl ? { withdraw: withdrawImpl } : {}), ...(depositImpl ? { deposit: depositImpl } : {}) } };
    const bot = {
        username: 'wire-flow-test',
        interrupt_code: null,
        entity: { position: new Vec3(0, 64, 0), height: 1.8 },
        registry: { blocksByName: { chest: { id: 54 } }, itemsByName: { [ITEM]: { id: 1 } } },
        inventory: { items: () => (state.inv > 0 ? [{ name: ITEM, type: 1, count: state.inv, slot: 0 }] : []) },
        currentWindow: null,
        findBlocks: () => [pos],
        blockAt: () => ({ name: 'chest', position: pos }),
        openContainer() {          // 同步返回窗口即可（调用方一律 await，await 非 promise 合法）
            bot.currentWindow = makeWindow(current.over);
            return bot.currentWindow;
        },
        closeWindow() { bot.currentWindow = null; },
        agent: { board },
        __setWindow(over = {}) { current = { over }; },
    };
    return { bot, state };
}

const rowsOf = (db, sql, ...args) => db.prepare(sql).all(...args);
const countOf = (db, sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);
const reservationOf = (db, id) => db.prepare('SELECT * FROM inventory_reservation WHERE id = ?').get(id);
const ledgerOf = (db) => rowsOf(db, 'SELECT item, delta, reason FROM inventory_ledger ORDER BY rowid');
const cacheOf = (db) => JSON.parse(
    db.prepare('SELECT items_json FROM container_cache WHERE world_id = ? AND x = ? AND y = ? AND z = ?')
        .get('w1', CHEST.x, CHEST.y, CHEST.z)?.items_json ?? '{}',
);

// ══════════════════════════════════════════════════════════════════════════
// ① 预占成功 → 取用 → 结算（券消耗、账本 -4、缓存跟着扣）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack();
    refreshContainerCache(db, { worldId: 'w1', ...CHEST, items: { [ITEM]: 10 } });
    const { bot, state } = makeBot({ board, chest: 10, inv: 0 });

    const r = await fetchFlow(bot, ITEM, 4, { shared: true });
    const res = reservationOf(db, r.data?.reservationId);
    const led = ledgerOf(db);

    const ok = r.ok === true && r.data?.taken === 4 && r.data?.settled === true
        && r.data?.released === false && Number(r.data?.reservedQty) === 4
        && state.chest === 6 && state.inv === 4
        && String(res?.status) === 'consumed' && Number(res?.consumed_qty) === 4
        && led.length === 1 && led[0].reason === 'take' && led[0].delta === -4
        && Number(cacheOf(db)?.[ITEM]) === 6;
    if (ok) okCase('① 预占→取用→结算：券 consumed/4、账本 take -4、缓存 10→6、物理 6/4', `taken=${r.data?.taken}`);
    else badCase('① 共享取用没有真的预占/结算', { r, state, res, led, cache: cacheOf(db) });
}

// ══════════════════════════════════════════════════════════════════════════
// ② 预占失败 ⇒ **一件都不取**，回 INSUFFICIENT_STOCK + 四个数
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack();
    refreshContainerCache(db, { worldId: 'w1', ...CHEST, items: { [ITEM]: 2 } });
    const { bot, state } = makeBot({ board, chest: 2, inv: 0 });

    const r = await fetchFlow(bot, ITEM, 5, { shared: true });
    const ok = r.ok === false && r.code === 'NO_ITEM'
        && r.data?.boardCode === 'INSUFFICIENT_STOCK'
        && r.data?.known === 2 && r.data?.reserved === 0 && r.data?.available === 2 && r.data?.requested === 5
        && (r.data?.took ?? 0) === 0
        && state.chest === 2 && state.inv === 0                    // 物理事实：一件没动
        && countOf(db, 'SELECT COUNT(*) AS n FROM inventory_reservation') === 0
        && countOf(db, 'SELECT COUNT(*) AS n FROM inventory_ledger') === 0;
    if (ok) okCase('② 拿不到预占就不取：NO_ITEM + INSUFFICIENT_STOCK(已知2/已占0/可用2/需要5)，箱子 2→2、背包 0',
        `code=${r.code}/${r.data?.boardCode}`);
    else badCase('② 预占失败却取了（或数字没说清）', { r, state, res: countOf(db, 'SELECT COUNT(*) AS n FROM inventory_reservation') });
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 取出 ≥1 个即失败（部分）⇒ 结**实际量**，剩余额度回池
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack();
    refreshContainerCache(db, { worldId: 'w1', ...CHEST, items: { [ITEM]: 10 } });
    const { bot, state } = makeBot({
        board, chest: 10, inv: 0,
        // 只搬出 2 个就"交易被拒"（箱子 10→8、背包 0→2 是物理事实）
        withdrawImpl: (n, st) => {           // 同步抛：模拟"搬了 2 个之后交易被拒"
            const k = Math.min(2, n);
            st.chest -= k; st.inv += k;
            throw new Error('transaction rejected');
        },
    });

    const r = await fetchFlow(bot, ITEM, 6, { shared: true });
    const res = reservationOf(db, r.data?.reservationId);
    const led = ledgerOf(db);
    // 6 张券、只结 2 ⇒ 剩下 4 立刻回池：另一个 bot 现在应该能预占到 8（已知 8）
    const other = await board.inventoryReserve({ item: ITEM, qty: 8 });

    const ok = r.ok === false && r.data?.taken === 2 && r.data?.settled === true
        && String(res?.status) === 'consumed' && Number(res?.consumed_qty) === 2
        && led.length === 1 && led[0].reason === 'take' && led[0].delta === -2
        && state.chest === 8 && state.inv === 2
        && other.ok === true && Number(other.data?.reservation?.qty) === 8;
    if (ok) okCase('③ 部分取用：结实际 2（券 consumed/2、账本 -2），剩余 4 额度回池（下一单能占到 8）',
        `taken=${r.data?.taken} settled=${r.data?.settled}`);
    else badCase('③ 部分取用没有按实际量结算/没回池', { r, state, res, led, other });
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 一件都没取到 ⇒ 券被释放（**额度立刻回池**，不留白占）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack();
    // ★ 用「箱内 4 / 请求 4」这种**刚好用满**的量：券不回池的话，下一单一个都占不到（能红）
    refreshContainerCache(db, { worldId: 'w1', ...CHEST, items: { [ITEM]: 4 } });
    const { bot, state } = makeBot({
        board, chest: 4, inv: 0,
        withdrawImpl: () => { throw new Error('window closed mid-transfer'); },   // 一件都没动
    });

    const r = await fetchFlow(bot, ITEM, 4, { shared: true });
    const res = reservationOf(db, r.data?.reservationId);
    const led = ledgerOf(db);
    // ★ 回池是**立刻**的：另一只 bot 现在就能预占到同一批额度（不是等 TTL）
    const other = await board.inventoryReserve({ item: ITEM, qty: 4 });

    const ok = r.ok === false && (r.data?.taken ?? 0) === 0
        && r.data?.released === true && r.data?.settled === false
        && String(res?.status) === 'released'
        && led.length === 1 && led[0].reason === 'release' && led[0].delta === 0
        && other.ok === true && Number(other.data?.reservation?.qty) === 4
        && state.chest === 4 && state.inv === 0;
    if (ok) okCase('④ 一件没取到 ⇒ 券 released（账本 release/delta 0），额度立刻回池：另一单当场预占成功',
        `released=${r.data?.released}`);
    else badCase('④ 一件没取到却没还券（白占额度）', { r, res, led, other, state });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 缓存没观测过 ⇒ 先"只看不搬"地开箱，再预占（不能因为"未知即 0"就永远取不到）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack();          // 故意不 seed：container_cache 里没有这个箱子
    const { bot, state } = makeBot({ board, chest: 7, inv: 0 });

    const r = await fetchFlow(bot, ITEM, 3, { shared: true });
    const ok = r.ok === true && r.data?.taken === 3 && r.data?.settled === true
        && Number(cacheOf(db)?.[ITEM]) === 4 && state.chest === 4 && state.inv === 3;
    if (ok) okCase('⑤ 从没观测过 ⇒ 先开箱观测（known 7）再预占 3，取到并结算，缓存 4', `taken=${r.data?.taken}`);
    else badCase('⑤ 未知库存时没有"先观测再预占"', { r, state, cache: cacheOf(db) });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 非共享路径**零行为变化**：不碰板上的券与账
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack();
    refreshContainerCache(db, { worldId: 'w1', ...CHEST, items: { [ITEM]: 10 } });
    const { bot, state } = makeBot({ board, chest: 10, inv: 0 });

    const calls = [];
    for (const name of ['inventoryReserve', 'inventorySettle', 'inventoryRelease']) {
        const orig = board[name].bind(board);
        board[name] = (...args) => { calls.push(name); return orig(...args); };
    }

    const r = await fetchFlow(bot, ITEM, 3);          // ← 不传 opts.shared
    const ok = r.ok === true && r.data?.taken === 3
        && r.data?.settled === undefined && r.data?.released === undefined && r.data?.shared === undefined
        && calls.length === 0
        && countOf(db, 'SELECT COUNT(*) AS n FROM inventory_reservation') === 0
        && countOf(db, 'SELECT COUNT(*) AS n FROM inventory_ledger') === 0
        && state.chest === 7 && state.inv === 3;
    if (ok) okCase('⑥ 非共享取用：完全不预占/不结算/不释放、不写账本，物理 3 个照旧', `taken=${r.data?.taken}`);
    else badCase('⑥ 非共享路径被改了行为（E2E 会红）', { r, state, calls });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 权限边界：别人的券不能被释放（能红：去掉 `AND holder = ?`）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board: boardA } = await makeStack({ name: 'alpha' });
    const { board: boardB } = await makeStackIn(db);   // 同一块库、另一条连接（beta）
    refreshContainerCache(db, { worldId: 'w1', ...CHEST, items: { [ITEM]: 10 } });
    const resv = await boardA.inventoryReserve({ item: ITEM, qty: 4 });
    const id = resv.data?.reservation?.id;

    const steal = await boardB.inventoryRelease({ reservationId: id, reason: 'not-mine' });
    const stillHeld = String(reservationOf(db, id)?.status) === 'held';
    const mine = await boardA.inventoryRelease({ reservationId: id, reason: 'mine' });
    const nowReleased = String(reservationOf(db, id)?.status) === 'released';

    const ok = resv.ok === true && steal.ok === false && steal.code === 'NO_PERMISSION'
        && stillHeld && mine.ok === true && mine.data?.changes === 1 && nowReleased;
    if (ok) okCase('⑦ 权限：beta 释放 alpha 的券 ⇒ NO_PERMISSION 且券仍 held；alpha 自己释放 ⇒ changes=1、released',
        `steal=${steal.code}`);
    else badCase('⑦ 别人的券能被释放（权限边界破了）', { steal, stillHeld, mine, status: reservationOf(db, id)?.status });
}

/** 同一块库上的第二只 bot（不同连接/不同名字）。 */
async function makeStackIn(db, name = 'beta') {
    const io = makeIo();
    const server = attachBoardServer({ io, db, worldIdOf: () => 'w1' });
    const clientSocket = io.connect({ role: 'agent', agentName: name });
    const board = new BoardClient({ socket: clientSocket, name, skills: ['store'], timeoutMs: 3000 });
    const hello = await board.hello();
    if (!hello.ok) throw new Error(`hello 失败：${JSON.stringify(hello)}`);
    return { db, server, board };
}

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 访客（服务端判定）：照常取用，但不落券、不记账（只审计）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack({ visitor: true });
    refreshContainerCache(db, { worldId: 'w1', ...CHEST, items: { [ITEM]: 10 } });
    const { bot, state } = makeBot({ board, chest: 10, inv: 0 });

    const r = await fetchFlow(bot, ITEM, 2, { shared: true });
    const ok = r.ok === true && r.data?.taken === 2 && r.data?.visitor === true
        && r.data?.settled === false && r.data?.released === false
        && countOf(db, 'SELECT COUNT(*) AS n FROM inventory_reservation') === 0
        && countOf(db, 'SELECT COUNT(*) AS n FROM inventory_ledger') === 0
        && countOf(db, 'SELECT COUNT(*) AS n FROM inventory_audit') >= 1
        && state.chest === 8 && state.inv === 2;
    if (ok) okCase('⑧ 访客：物理照常取 2，但券 0 行、账本 0 行、只留审计（不对外报 settled/released）',
        `audit=${countOf(db, 'SELECT COUNT(*) AS n FROM inventory_audit')}`);
    else badCase('⑧ 访客路径把账写进本机了（或对空券报 settled）', { r, state });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑨ 存入（store）共享入账：账本 reason 必须是 'store'（**不许**混进 reconcile），且不传 shared 不记账
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack();
    const { bot, state } = makeBot({ board, chest: 0, inv: 6 });
    const reconcileBefore = countOf(db, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'reconcile'");
    const r = await store(bot, ITEM, 4, { shared: true });
    const led = ledgerOf(db);
    const reconcileAfter = countOf(db, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'reconcile'");

    const { db: db2, board: board2 } = await makeStack();
    const { bot: bot2, state: state2 } = makeBot({ board: board2, chest: 0, inv: 6 });
    const plain = await store(bot2, ITEM, 4);         // 不传 shared

    const ok = r.ok === true && r.data?.stored === 4
        && Array.isArray(r.data?.ledger) && r.data.ledger[0]?.recorded === true
        && led.length === 1 && led[0].reason === 'store' && led[0].delta === 4
        // ★ 能红点（captain 裁决）：正常存入**不许**产出 reconcile 行 —— 那行的语义是"账实不符修正"
        && reconcileBefore === 0 && reconcileAfter === 0
        && Number(cacheOf(db)?.[ITEM]) === 4
        && state.chest === 4 && state.inv === 2
        && plain.ok === true && plain.data?.ledger === undefined
        && countOf(db2, 'SELECT COUNT(*) AS n FROM inventory_ledger') === 0
        && state2.chest === 4;
    if (ok) okCase("⑨ 共享存入：账本 +4 且 reason='store'（reconcile 行数仍为 0）、缓存=真实；非共享不记账、行为不变",
        `ledger=${JSON.stringify(led)}`);
    else badCase('⑨ 存入的账本口径不对（reason 混进 reconcile / 没入账 / 非共享被改动）',
        { r, led, reconcileBefore, reconcileAfter, cache: cacheOf(db), plain });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑩ 对账行为不变（防"改账本入口把对账带跑"）：只有**真有差异**才写 reconcile 行
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack();
    refreshContainerCache(db, { worldId: 'w1', ...CHEST, items: { [ITEM]: 10 } });

    // ① 账实一致 ⇒ 一行都不写；再跑一次仍然 0（对账可重复跑而不制造噪音）
    const same1 = await board.inventoryReconcile({ observations: [{ ...CHEST, items: { [ITEM]: 10 } }] });
    const same2 = await board.inventoryReconcile({ observations: [{ ...CHEST, items: { [ITEM]: 10 } }] });
    const rowsAfterSame = countOf(db, 'SELECT COUNT(*) AS n FROM inventory_ledger');

    // ② 真有差异（缓存 10、真实 7）⇒ 只写 1 行 reconcile，delta = -3，缓存改成真实
    const diff = await board.inventoryReconcile({ observations: [{ ...CHEST, items: { [ITEM]: 7 } }] });
    const led = ledgerOf(db);

    // ③ 存入也不该被对账"顺手"记成 store（两条入口各管各的）
    const rowsAfterDiff = countOf(db, 'SELECT COUNT(*) AS n FROM inventory_ledger');

    const ok = same1.ok === true && same1.data?.written === 0
        && same2.ok === true && same2.data?.written === 0 && rowsAfterSame === 0
        && diff.ok === true && diff.data?.written === 1
        && led.length === 1 && led[0].reason === 'reconcile' && led[0].delta === -3
        && Number(cacheOf(db)?.[ITEM]) === 7
        && rowsAfterDiff === 1
        && countOf(db, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'store'") === 0;
    if (ok) okCase('⑩ 对账行为不变：账实一致两跑都 0 行；有差异只写 1 行 reconcile(-3) 并把缓存改成真实',
        `written=${diff.data?.written}`);
    else badCase('⑩ 对账被改坏了（或与存入记账混成一条路）',
        { same1: same1.data, same2: same2.data, rowsAfterSame, diff: diff.data, led, cache: cacheOf(db) });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑪ 访客存入：不写本机账本（只审计），与 reserve/settle 同一口径（D7-6）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db, board } = await makeStack({ visitor: true });
    const r = await board.inventoryStore({ item: ITEM, qty: 5, chestKey: CHEST, observed: { [ITEM]: 5 } });
    const ok = r.ok === true && r.data?.visitor === true
        && countOf(db, 'SELECT COUNT(*) AS n FROM inventory_ledger') === 0
        && countOf(db, "SELECT COUNT(*) AS n FROM inventory_audit WHERE action = 'store'") === 1;
    if (ok) okCase('⑪ 访客存入：账本 0 行、审计 store +1（不污染房主库存账）',
        `audit=${countOf(db, "SELECT COUNT(*) AS n FROM inventory_audit WHERE action = 'store'")}`);
    else badCase('⑪ 访客存入写进本机账本了', { r, ledger: countOf(db, 'SELECT COUNT(*) AS n FROM inventory_ledger') });
}

// ── 收尾 ────────────────────────────────────────────────────────────────
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
console.log(`\n${pass} pass / ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
