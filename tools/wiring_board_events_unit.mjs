/**
 * board_server 接线（team.* / inventory.* 写 events + 访客判定）—— R6 fixes4 · **t2**。
 *
 * 钉死的是什么（每一条都是"实现了但生产不可达 / 看起来接了"的反面）：
 *   A. 写入口 `recordBoardEvent`：**worldId 拿不到就不写**（绝不兜底 'default'）、
 *      写失败/抛错**不炸业务**、只调一次记录器；
 *   B. **源码断言**（防"函数改对了但没人调用"/"绕过入口直接写"）：
 *      `recordEvent(` 在 board_server.js 里**恰好 1 处**（唯一入口）、
 *      每个事件调用都是 `void ev(...)`（返回值不参与业务判断）、
 *      8 个 kind 字面量都在、没有 `?? 'default'` 之类兜底；
 *   C. **真接线**（真 board 库 + 真 `_global` events 库 + 真 `recordEvent`）：
 *      team.create/join/leave/disband、inventory.reserve/settle/rollback/reconcile
 *      真的落进 events 表，且 `world_id` / `avatar_id` 都对；幂等重放**不重复记**；
 *      worldId 解析不出 ⇒ 业务本来就是 NO_BOARD，且 **events 零行**（兜底写 'default' 这里就会红）；
 *   D. **访客判定真的有效**（不是"接线存在"）：注入 true ⇒ reservation / ledger **零行**、
 *      `inventory_audit` **有行**、且 events 里**没有** inventory.reserve/settle（旁路不记被跳过的动作）；
 *      客户端自报 `payload.visitor=false` **无效**；注入器抛错 ⇒ 判 false（不炸业务、也不误判访客）。
 *
 * ⚠ 本测试**不验**真机 E2E（那归 t5）：这里用假 socket + 真库，验证"接上了且有效"。
 * 输出：PASS/FAIL 逐条，全过退出码 0（unit_all 按 PASS 行数判"真的跑了用例"）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBoard } from '../src/agent/library/board_store.js';
import { attachBoardServer, recordBoardEvent } from '../src/agent/library/board_server.js';
import { closeGlobalDb, countEvents, sinceEvents } from '../src/mindcraft/global_store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name}${detail ? '   ' + detail : ''}`); }
    else { fail++; console.log(`FAIL ${name}${detail ? '   ' + detail : ''}`); }
};

/** 所有"真接线"用例都在这个临时根里跑：events 库 = <ROOT>/_global/mind.sqlite。 */
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'wiring-board-'));
const prevRoot = process.env.MC_BOTS_ROOT;
process.env.MC_BOTS_ROOT = ROOT;

let seq = 0;
/** 已开过的板句柄：结束时必须 close，否则 Windows 上 rmSync 会 EPERM。 */
const opened = [];
/** 每个用例一块独立板库：互不污染（事件库是共享的，用 worldId 隔离）。 */
const freshBoard = (sub = '') => {
    const b = openBoard(path.join(ROOT, 'boards', `${sub || 'db'}${++seq}`));
    try { opened.push(b.db); } catch { /* ignore */ }
    return b;
};

const CACHE = { x: 10, y: 64, z: -3 };

/** 事件查询（真库）：按 kind 取，可选按 worldId 过滤。 */
const eventsOf = (kind, worldId = null) => sinceEvents(0, {
    kind, ...(worldId ? { worldId } : {}), limit: 2000,
});

// ════════════════════════════════════════════════════════════════════════════
// A. 写入口（纯函数）：worldId 门禁 + 旁路语义
// ════════════════════════════════════════════════════════════════════════════
{
    const mkRecorder = () => {
        const calls = [];
        const rec = (kind, payload, ctx) => { calls.push({ kind, payload, ctx }); return { ok: true, id: 'ev-test' }; };
        rec.calls = calls;
        return rec;
    };

    const r1 = mkRecorder();
    const noWorld = recordBoardEvent(r1, 'team.create', { a: 1 }, {});
    check('A1 ★ worldId 缺失 ⇒ **不调记录器**（不写事件），reason=no-world-id',
        noWorld.ok === false && noWorld.reason === 'no-world-id' && r1.calls.length === 0,
        `reason=${noWorld.reason} calls=${r1.calls.length}`);

    const r2 = mkRecorder();
    const blank = recordBoardEvent(r2, 'team.create', {}, { worldId: '   ' });
    check('A2 空白 worldId 等同于缺失（trim 之后为空 ⇒ 不写）',
        blank.ok === false && blank.reason === 'no-world-id' && r2.calls.length === 0);

    const r3 = mkRecorder();
    const okOne = recordBoardEvent(r3, 'team.join', { teamId: 't1' }, { worldId: ' w-1 ', avatarId: 'alpha' });
    check('A3 正常路径：只调一次记录器，且 ctx.worldId 已 trim、avatarId 透传',
        okOne.ok === true && r3.calls.length === 1
        && r3.calls[0].ctx.worldId === 'w-1' && r3.calls[0].ctx.avatarId === 'alpha'
        && r3.calls[0].kind === 'team.join',
        JSON.stringify(r3.calls[0]?.ctx));

    const r4 = () => { throw new Error('库忙'); };
    let threw = null;
    try {
        threw = recordBoardEvent(r4, 'inventory.settle', {}, { worldId: 'w-1' });
    } catch (e) { threw = { threw: String(e?.message ?? e) }; }
    check('A4 ★ 记录器抛错 ⇒ 写入口**不抛**（reason=threw），业务侧无从被拖垮',
        threw?.ok === false && threw?.reason === 'threw', JSON.stringify(threw));

    const r5 = recordBoardEvent(() => ({ ok: false, reason: 'write-failed' }), 'inventory.reserve', {}, { worldId: 'w-1' });
    check('A5 记录器返回 ok:false ⇒ 透传 reason（只影响日志）',
        r5.ok === false && r5.reason === 'write-failed');

    const r6 = recordBoardEvent(null, 'team.leave', {}, { worldId: 'w-1' });
    check('A6 没有记录器（部署没接 events）⇒ no-recorder，不抛', r6.ok === false && r6.reason === 'no-recorder');

    const r7 = mkRecorder();
    recordBoardEvent(r7, 'team.leave', null, { worldId: 'w-1' });
    check('A7 payload=null ⇒ 记录器收到 {}（不把 null 写进 JSON 列）',
        r7.calls.length === 1 && JSON.stringify(r7.calls[0].payload) === '{}');
}

// ════════════════════════════════════════════════════════════════════════════
// B. 源码断言：唯一入口 / 返回值不参与判断 / kind 齐全 / 无兜底 worldId
// ════════════════════════════════════════════════════════════════════════════
{
    const src = readFileSync(path.join(HERE, '..', 'src', 'agent', 'library', 'board_server.js'), 'utf8');

    // 去掉注释再数，避免注释里写一句 `recordEvent(...)` 就被算成调用点（"注释骗人"防护）。
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    const recordEventCalls = [...code.matchAll(/\brecordEvent\s*\(/g)].length;
    check('B1 ★ 没有任何**直接** `recordEvent(...)` 调用（事件只能经 recordBoardEvent 入口 ⇒ 绕不过 worldId 门禁）',
        recordEventCalls === 0, `directCalls=${recordEventCalls}`);

    // 入口绑定只有一处：`const ev = (...) => recordBoardEvent(typeof deps.recordEvent === 'function'
    //   ? deps.recordEvent : recordEvent, ...)` —— 文本上恰好 3 次引用（deps.×2 + 默认×1）
    const evBindIdx = code.indexOf('const ev =');
    const evBind = evBindIdx >= 0 ? code.slice(evBindIdx, code.indexOf(');', evBindIdx) + 2) : '';
    const refsInBind = [...evBind.matchAll(/recordEvent/g)].length;
    const refsTotal = [...code.matchAll(/recordEvent/g)].length;
    check('B1b `recordEvent` 只出现在 import 与那一处 `ev` 绑定里（没有第二个写入路径）',
        evBindIdx >= 0 && refsInBind === 3 && refsTotal === 4,
        `inBind=${refsInBind} total=${refsTotal}`);

    const evCalls = [...code.matchAll(/(^|[^A-Za-z0-9_$.])ev\s*\(/g)].length;
    const voidEvCalls = [...code.matchAll(/\bvoid\s+ev\s*\(/g)].length;
    check('B2 ★ 每个事件调用都是 `void ev(...)`（返回值一律丢弃 ⇒ 不可能参与业务判断）',
        evCalls > 0 && evCalls === voidEvCalls, `ev(=${evCalls}) void ev(=${voidEvCalls})`);

    const badUses = [
        /\bconst\s+\w+\s*=\s*ev\s*\(/,                 // 接了返回值
        /\bif\s*\(\s*ev\s*\(/,                          // 拿来判分支
        /\bev\s*\([^;]*\)\s*\.\s*ok\b/,                 // 读 .ok
        /\breturn\s+ev\s*\(/,                           // 把事件结果当返回值
    ].filter((re) => re.test(code));
    check('B3 没有 `const r = ev(...)` / `if (ev(...))` / `ev(...).ok` / `return ev(...)` 这类接法',
        badUses.length === 0, `命中规则数=${badUses.length}`);

    const kinds = [
        'team.create', 'team.join', 'team.leave', 'team.disband',
        'inventory.reserve', 'inventory.settle', 'inventory.rollback', 'inventory.reconcile',
        'inventory.store',
    ];
    const missing = kinds.filter((k) => !code.includes(`'${k}'`));
    check('B4 九个 kind 字面量全在（团队 4 + 库存 5，且都在 EVENT_KINDS 白名单里）',
        missing.length === 0, missing.length ? `缺：${missing.join(',')}` : '');

    // 兜底只会长这样：`worldId ?? 'default'` / `worldId || 'unknown'` / `worldId = 'default'`
    //   （注意别把日志里 `${r?.reason ?? 'unknown'}` 算进来 —— 那不是 worldId 的兜底）
    const defaultFallback = [
        /worldId\s*(\?\?|\|\|)\s*['"]/g,
        /worldId\s*=\s*['"](default|unknown)/g,
    ].reduce((n, re) => n + [...code.matchAll(re)].length, 0);
    check('B5 ★ 没有 `worldId ?? \'default\'` / `worldId || \'unknown\'` 之类兜底',
        defaultFallback === 0, `命中=${defaultFallback}`);

    const injected = /isVisitor\s*:\s*visitorOf/.test(
        readFileSync(path.join(HERE, '..', 'src', 'mindcraft', 'mindserver.js'), 'utf8'),
    );
    check('B6 `mindserver` 真的把 isVisitor 注入 attachBoardServer（接线存在性；有效性见 D 段）', injected);

    // ★ B7（captain 复核点）：**每个**事件调用都在它**自己 handler** 的 `ack(cb` **之后** —— 顺序可机器验证。
    //   用户等的是回执，审计是旁路；"先写后 ack"最坏情况是：事件库慢/被锁时，
    //   一条本该立刻回执的操作被扣在审计上。★ 判据按 **handler 边界**切（不是全文找"前面有没有 ack"）：
    //   否则把 ack 挪到事件后面，全文里前面总还有别的 handler 的 ack，会假绿。
    const KIND_TO_EVENT = {
        'team.create': 'team:create', 'team.join': 'team:join',
        'team.leave': 'team:leave', 'team.disband': 'team:leave',
        'inventory.reserve': 'inventory:reserve', 'inventory.settle': 'inventory:settle',
        'inventory.rollback': 'inventory:release', 'inventory.reconcile': 'inventory:reconcile',
        'inventory.store': 'inventory:store',
    };
    const ackFirstViolations = [];
    for (const [kind, evName] of Object.entries(KIND_TO_EVENT)) {
        const hStart = code.indexOf(`socket.on('${evName}'`);
        const hNext = hStart < 0 ? -1 : code.indexOf('socket.on(', hStart + 10);
        const body = hStart < 0 ? '' : code.slice(hStart, hNext < 0 ? undefined : hNext);
        // ★ 只认**成功回执**（`ack(cb, { ok: true ...`）：handler 开头还有失败路径的
        //   `if (!pre.ok) return ack(cb, pre.ack)`，把它当成"回执已回"会让本用例假绿
        //   （第一版就栽在这里：把 ev 挪到成功 ack 之前，B7 照样 PASS）。
        const okAck = /ack\(cb,\s*\{\s*ok:\s*true/.exec(body);
        const a = okAck ? okAck.index : -1;
        const k = body.indexOf(`void ev('${kind}'`);
        if (!body || a < 0 || k < 0 || a > k) ackFirstViolations.push(kind);
    }
    const kindCount = Object.keys(KIND_TO_EVENT).length;
    check(`B7 ★ ${kindCount} 个事件调用全部在**各自 handler 的** \`ack(cb ...)\` 之后（先回执、再写审计；没有"写事件延迟 ack"）`,
        ackFirstViolations.length === 0,
        ackFirstViolations.length ? `违规：${ackFirstViolations.join(',')}` : `${kindCount}/${kindCount} ack-first`);
}

// ════════════════════════════════════════════════════════════════════════════
// C. 真接线：假 socket + 真板库 + 真 events 库
// ════════════════════════════════════════════════════════════════════════════
/** 假 socket.io 对：`attachBoardServer` 只注册一次 connection 回调。 */
function mkPair(serverData = { role: 'panel' }) {
    const handlers = new Map();
    const serverSocket = { on(event, fn) { handlers.set(event, fn); }, data: { ...serverData } };
    const clientSocket = {
        on() { /* 忽略服务端广播 */ },
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
    clientSocket.emit(event, payload, (a) => { if (!done) { done = true; resolve(a); } });
    setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: 'timeout' }); } }, 2000);
});

/**
 * 事件是**旁路**：ack 先回、事件随后落地。这里**有界轮询**等它落地
 * （而不是"假设 ack 返回时事件已写完" —— 那会把测试写成对实现顺序的过强假设）。
 */
async function waitFor(pred, { timeoutMs = 3000, stepMs = 20 } = {}) {
    const t0 = Date.now();
    for (;;) {
        const v = pred();
        if (v) return v;
        if (Date.now() - t0 > timeoutMs) return null;
        await new Promise((r) => setTimeout(r, stepMs));
    }
}

const W = 'w-evt';                       // 合法 world_id（world_store: [A-Za-z0-9][A-Za-z0-9._-]{0,63}）

{
    const { db } = freshBoard('team_evt');
    const { io, clientSocket } = mkPair();
    const srv = attachBoardServer({ io, db, worldIdOf: () => W });
    try {
        // 面板连接可以替多只 bot 声明（board:hello 后按名字行动）
        for (const b of ['alpha', 'beta', 'gamma']) await call(clientSocket, 'board:hello', { bot: b, skills: [] });

        const created = await call(clientSocket, 'team:create', { bot: 'alpha', name: '挖矿组' });
        const joined = await call(clientSocket, 'team:join', { bot: 'beta', teamId: created?.team?.id });
        await call(clientSocket, 'team:join', { bot: 'gamma', teamId: created?.team?.id });

        check('C1 team:create 成功（业务侧前提）', created?.ok === true && joined?.ok === true);

        const cr = eventsOf('team.create', W);
        check('C2 ★ team.create 真的落 events（world_id / avatar_id 都对）',
            cr.length === 1 && cr[0].worldId === W && cr[0].avatarId === 'alpha'
            && cr[0].payload?.teamId === created.team.id,
            JSON.stringify(cr[0]?.payload));

        const jn = eventsOf('team.join', W);
        check('C3 team.join 落 events（两只加入 = 2 行，payload 带 teamId/role）',
            jn.length === 2 && jn.every((e) => e.worldId === W) && jn.every((e) => e.payload?.teamId === created.team.id)
            && jn.some((e) => e.avatarId === 'beta') && jn.some((e) => e.avatarId === 'gamma'),
            `rows=${jn.length}`);

        // ── 离队：普通成员走（不提升、不解散）→ 队长走（提升 beta）→ 最后一人走（解散） ──
        const gLeave = await call(clientSocket, 'team:leave', { bot: 'gamma' });
        const aLeave = await call(clientSocket, 'team:leave', { bot: 'alpha' });
        const bLeave = await call(clientSocket, 'team:leave', { bot: 'beta' });

        const lv = (await waitFor(() => {
            const rows = eventsOf('team.leave', W);
            return rows.length >= 3 ? rows : null;
        })) ?? [];
        const dis = (await waitFor(() => {
            const rows = eventsOf('team.disband', W);
            return rows.length >= 1 ? rows : null;
        })) ?? [];
        check('C4 三次离队 ⇒ team.leave 3 行；只有最后一人离队 ⇒ team.disband 1 行',
            gLeave?.ok === true && aLeave?.ok === true && bLeave?.ok === true
            && lv.length === 3 && dis.length === 1,
            `leave=${lv.length} disband=${dis.length}`);

        check('C5 队长离队那一行带 promoted=beta（谁接任要能复盘）',
            lv.some((e) => e.avatarId === 'alpha' && e.payload?.promoted === 'beta'),
            JSON.stringify(lv.map((e) => [e.avatarId, e.payload?.promoted])));
        check('C6 解散事件与离队事件都在同一 world_id 下、解散那行标了 disbanded',
            dis[0]?.worldId === W
            && lv.some((e) => e.avatarId === 'beta' && e.payload?.disbanded === true),
            JSON.stringify(dis[0]?.payload));

        // ── 库存：预占 → 结算 → 释放（回滚）→ 对账 ──
        const refresh = await call(clientSocket, 'inventory:cache-refresh', {
            bot: 'alpha', ...CACHE, items: { oak_log: 20 },
        });
        const reserved = await call(clientSocket, 'inventory:reserve', { bot: 'alpha', item: 'oak_log', qty: 5 });
        const settled = await call(clientSocket, 'inventory:settle', { bot: 'alpha', reservationId: reserved?.reservation?.id, qty: 5 });
        check('C7 库存业务链打通（refresh / reserve / settle 都 ok）',
            refresh?.ok === true && reserved?.ok === true && settled?.ok === true,
            JSON.stringify({ refresh: refresh?.ok, reserved: reserved?.ok, settled: settled?.ok }));

        const ivr = eventsOf('inventory.reserve', W);
        const ivs = eventsOf('inventory.settle', W);
        check('C8 ★ inventory.reserve 落 events（item/qty/reservationId 对得上）',
            ivr.length === 1 && ivr[0].worldId === W && ivr[0].avatarId === 'alpha'
            && ivr[0].payload?.item === 'oak_log' && ivr[0].payload?.qty === 5
            && ivr[0].payload?.reservationId === reserved.reservation.id,
            JSON.stringify(ivr[0]?.payload));
        check('C9 ★ inventory.settle 落 events，且 delta 是**负的实际取用量**（账实不符时唯一的第三方证据）',
            ivs.length === 1 && ivs[0].payload?.delta === -5 && ivs[0].payload?.item === 'oak_log'
            && ivs[0].payload?.reservationId === reserved.reservation.id,
            JSON.stringify(ivs[0]?.payload));

        // 幂等重放：同一个 reservationId 再结算一次 ⇒ already=true，不再写事件
        const settledAgain = await call(clientSocket, 'inventory:settle', { bot: 'alpha', reservationId: reserved.reservation.id, qty: 5 });
        check('C10 ★ 结算幂等重放（already）**不重复记事件**',
            settledAgain?.ok === true && settledAgain?.already === true && eventsOf('inventory.settle', W).length === 1,
            `settle_events=${eventsOf('inventory.settle', W).length}`);

        // 释放（回滚）：新预占 → 释放 ⇒ inventory.rollback 一行；再释放 ⇒ 不再写
        const r2 = await call(clientSocket, 'inventory:reserve', { bot: 'alpha', item: 'oak_log', qty: 3 });
        const rel1 = await call(clientSocket, 'inventory:release', { bot: 'alpha', reservationId: r2?.reservation?.id });
        const rel2 = await call(clientSocket, 'inventory:release', { bot: 'alpha', reservationId: r2?.reservation?.id });
        const rb = eventsOf('inventory.rollback', W);
        check('C11 ★ 释放预占 ⇒ inventory.rollback 一行（changes>0）；幂等重放不再写',
            rel1?.ok === true && rel1?.changes === 1 && rel2?.ok === true && rel2?.already === true
            && rb.length === 1 && rb[0].payload?.reservationId === r2.reservation.id,
            `rows=${rb.length} rel2=${JSON.stringify({ ok: rel2?.ok, already: rel2?.already })}`);

        // 对账：dryRun 不写事件；真跑（有差额）写一条
        await call(clientSocket, 'inventory:cache-refresh', { bot: 'alpha', ...CACHE, items: { oak_log: 20 } });
        const dry = await call(clientSocket, 'inventory:reconcile', {
            bot: 'alpha', dryRun: true, observations: [{ ...CACHE, items: { oak_log: 12 } }],
        });
        const real = await call(clientSocket, 'inventory:reconcile', {
            bot: 'alpha', observations: [{ ...CACHE, items: { oak_log: 12 } }],
        });
        const recon = eventsOf('inventory.reconcile', W);
        check('C12 ★ 对账 dryRun ⇒ **零事件**；真跑且有差额 ⇒ 一行，带 written/diffsTotal',
            dry?.ok === true && real?.ok === true && real?.written === 1
            && recon.length === 1 && recon[0].payload?.written === 1 && recon[0].payload?.diffsTotal === 1,
            `rows=${recon.length} written=${real?.written}`);

        // ── 存入（inventory:store）：正 delta，与 settle 对称 ──
        const stored = await call(clientSocket, 'inventory:store', {
            bot: 'alpha', item: 'oak_log', qty: 4, chestKey: '10,64,-3',
        });
        const stEv = (await waitFor(() => {
            const rows = eventsOf('inventory.store', W);
            return rows.length >= 1 ? rows : null;
        })) ?? [];
        check('C12b ★ inventory.store 落 events（qty 是**正**的实际存入量、带 chestKey、item 对）',
            stored?.ok === true && stEv.length === 1 && stEv[0].worldId === W && stEv[0].avatarId === 'alpha'
            && stEv[0].payload?.item === 'oak_log' && stEv[0].payload?.qty === 4
            && stEv[0].payload?.chestKey === '10,64,-3',
            JSON.stringify(stEv[0]?.payload));

        const ledgerStore = db.prepare("SELECT delta FROM inventory_ledger WHERE reason = 'store'").all();
        check('C12c 事件里的 qty 与库里的 delta 一致（都是 +qty ⇒ 与 settle 的 −take 方向对称）',
            ledgerStore.length === 1 && Number(ledgerStore[0].delta) === 4
            && stEv[0]?.payload?.qty === Number(ledgerStore[0].delta),
            JSON.stringify({ ledger: ledgerStore, qty: stEv[0]?.payload?.qty }));

        check('C13 全部事件都在同一 world_id 下（没有任何一行落到别的档/空档）',
            ['team.create', 'team.join', 'team.leave', 'team.disband',
                'inventory.reserve', 'inventory.settle', 'inventory.rollback', 'inventory.reconcile',
                'inventory.store']
                .every((k) => eventsOf(k, W).every((e) => e.worldId === W)));
    } finally {
        srv.stop?.();
    }
}

// ── worldId 解析不出 ⇒ 业务 NO_BOARD 且**零事件**（兜底写成 'default' 的实现在这里必红） ──
{
    const { db } = freshBoard('no_world');
    const { io, clientSocket } = mkPair();
    const before = countEvents({});
    const srv = attachBoardServer({
        io, db,
        worldIdOf: () => '',                       // 空串 = 解析不出（teamWorld 会翻成 NO_BOARD）
    });
    try {
        await call(clientSocket, 'board:hello', { bot: 'alpha', skills: [] });
        const team = await call(clientSocket, 'team:create', { bot: 'alpha', name: '无档组' });
        const inv = await call(clientSocket, 'inventory:reserve', { bot: 'alpha', item: 'oak_log', qty: 1 });
        const after = countEvents({});
        check('C14 worldId 解析不出 ⇒ 团队/库存都回 NO_BOARD（业务不静默降级）',
            team?.code === 'NO_BOARD' && inv?.code === 'NO_BOARD',
            JSON.stringify({ team: team?.code, inv: inv?.code }));
        check('C15 ★ 事件零新增（**绝不**用 \'default\'/\'unknown\' 兜底写事件）',
            after === before, `before=${before} after=${after}`);
        check('C16 也没有任何一行 world_id 为 \'default\'/\'unknown\'/空',
            sinceEvents(0, { limit: 2000 }).every((e) => e.worldId !== 'default' && e.worldId !== 'unknown' && e.worldId !== null));
    } finally {
        srv.stop?.();
    }
}

// ── 记录器写失败/抛错 ⇒ 业务照常（旁路，不参与判断） ──
{
    for (const [label, recorder] of [
        ['返回 ok:false', () => ({ ok: false, reason: 'write-failed' })],
        ['直接抛错', () => { throw new Error('disk full'); }],
    ]) {
        const { db } = freshBoard('rec_fail');
        const { io, clientSocket } = mkPair();
        const srv = attachBoardServer({
            io, db, worldIdOf: () => W,
            recordEvent: recorder,                 // 注入点：证明"写失败只进日志"
        });
        try {
            await call(clientSocket, 'board:hello', { bot: 'alpha', skills: [] });
            await call(clientSocket, 'inventory:cache-refresh', { bot: 'alpha', ...CACHE, items: { oak_log: 6 } });
            const res = await call(clientSocket, 'inventory:reserve', { bot: 'alpha', item: 'oak_log', qty: 2 });
            const set = await res?.ok === true
                ? await call(clientSocket, 'inventory:settle', { bot: 'alpha', reservationId: res.reservation.id, qty: 2 })
                : null;
            const rows = db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get()?.n;
            check(`C17 记录器${label} ⇒ 预占/结算**照常成功**，账本照常落行（事件是旁路）`,
                res?.ok === true && set?.ok === true && Number(rows) === 1,
                `reserve=${res?.ok} settle=${set?.ok} ledger=${rows}`);
        } finally {
            srv.stop?.();
        }
    }
}

// ── 真写失败（不用注入）：events 库打不开 ⇒ 业务照常（旁路） ──
//
// 造法与"只读库"等价，但换了个更狠的方式：把 `<root>/_global` 造成一个**普通文件**，
// 于是 openGlobalDb() 的 mkdir 直接失败 ⇒ 真 recordEvent 返回 write-failed。
// 这样验的是**真链路**（不是注入的假记录器）：业务必须照常成功，且不抛。
{
    const brokenRoot = mkdtempSync(path.join(os.tmpdir(), 'wiring-board-broken-'));
    writeFileSync(path.join(brokenRoot, '_global'), 'not a directory', 'utf8');
    const prev = process.env.MC_BOTS_ROOT;
    process.env.MC_BOTS_ROOT = brokenRoot;          // 新路径 ⇒ global_store 的句柄缓存不复用
    const { db } = freshBoard('broken_evt');
    const { io, clientSocket } = mkPair();
    const srv = attachBoardServer({ io, db, worldIdOf: () => W });
    try {
        await call(clientSocket, 'board:hello', { bot: 'alpha', skills: [] });
        const created = await call(clientSocket, 'team:create', { bot: 'alpha', name: '无事件库组' });
        const teamRows = Number(db.prepare('SELECT COUNT(*) AS n FROM team').get()?.n ?? -1);
        check('C18 ★ **真的**写不进 events（_global 不是目录）⇒ 队伍操作仍然成功、队伍行仍在、不抛',
            created?.ok === true && created?.team?.id != null && teamRows === 1,
            JSON.stringify({ ok: created?.ok, teamRows }));
    } finally {
        srv.stop?.();
        process.env.MC_BOTS_ROOT = prev;
        try { rmSync(brokenRoot, { recursive: true, force: true }); } catch { /* 句柄没开成就删得掉 */ }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// D. 访客判定：注入 true ⇒ 不占本机账，只留 audit；events 里也没有"被跳过的动作"
// ════════════════════════════════════════════════════════════════════════════
{
    const { db } = freshBoard('visitor');
    const { io, clientSocket } = mkPair();
    const seen = [];
    const srv = attachBoardServer({
        io, db, worldIdOf: () => 'w-guest',
        // 服务端注入的判定：只认这里；`payload.visitor` 是客户端自报，**必须被忽略**
        isVisitor: ({ bot, worldId }) => {
            seen.push({ bot, worldId });
            if (bot === 'boom-bot') throw new Error('凭证库炸了');
            return bot === 'guest-bot';
        },
    });
    try {
        await call(clientSocket, 'board:hello', { bot: 'guest-bot', skills: [] });
        await call(clientSocket, 'board:hello', { bot: 'alpha', skills: [] });
        await call(clientSocket, 'inventory:cache-refresh', { bot: 'alpha', ...CACHE, items: { oak_log: 9 } });

        const evBefore = countEvents({});
        // ★ 客户端自报 visitor:false（说谎）—— 注入 true 必须压过它
        const gRes = await call(clientSocket, 'inventory:reserve', { bot: 'guest-bot', item: 'oak_log', qty: 4, visitor: false });
        const gSet = await call(clientSocket, 'inventory:settle', { bot: 'guest-bot', reservationId: null, qty: 4, container: CACHE, visitor: false });

        const reservations = Number(db.prepare('SELECT COUNT(*) AS n FROM inventory_reservation').get()?.n ?? -1);
        const ledger = Number(db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get()?.n ?? -1);
        const audits = Number(db.prepare("SELECT COUNT(*) AS n FROM inventory_audit WHERE actor = 'guest-bot'").get()?.n ?? -1);
        const evAfter = countEvents({});

        // ack 形状是 {ok, reservation, visitor}：`skipped`/`id` 在 reservation 里（没有单独开字段）
        check('D1 ★ 注入 isVisitor=true ⇒ reservation **零行**、ledger **零行**（不占本机库存/不记账）',
            gRes?.ok === true && gRes?.visitor === true && gRes?.reservation?.skipped === true
            && gRes?.reservation?.id === null
            && gSet?.ok === true && gSet?.visitor === true && gSet?.reservation === null
            && reservations === 0 && ledger === 0,
            JSON.stringify({ reservations, ledger, gResRes: gRes?.reservation, gSetOk: gSet?.ok }));
        check('D2 ★ 但 `inventory_audit` **有行**（访客动作留痕，2 条：reserve + take）',
            audits === 2, `audits=${audits}`);
        check('D3 ★ 客户端自报 `visitor:false` **被忽略**（免账只看服务端注入）',
            gRes?.visitor === true && gSet?.visitor === true);
        check('D4 ★ 被跳过的动作**不写** inventory.reserve/settle 事件（旁路只记真实发生的账变）',
            evAfter === evBefore,
            `before=${evBefore} after=${evAfter} reserve=${countEvents({ kind: 'inventory.reserve' })} settle=${countEvents({ kind: 'inventory.settle' })}`);
        check('D5 判定器真的被调用，且拿到的是**服务端解析出的 worldId**（不是 payload 自报）',
            seen.length >= 2 && seen.every((s) => s.worldId === 'w-guest'),
            JSON.stringify(seen.slice(0, 3)));

        // 注入器抛错 ⇒ 判 false（不误判成访客、也不炸业务）
        await call(clientSocket, 'board:hello', { bot: 'boom-bot', skills: [] });
        const boom = await call(clientSocket, 'inventory:reserve', { bot: 'boom-bot', item: 'oak_log', qty: 1 });
        check('D6 判定器抛错 ⇒ 判"非访客"（照常占额度）且业务不被打断',
            boom?.ok === true && boom?.visitor !== true && boom?.reservation?.id != null,
            JSON.stringify({ ok: boom?.ok, visitor: boom?.visitor }));

        // ── D7：访客**存入**也不写 inventory.store（stockIn 只留 audit，账本零行） ──
        //   为什么单独一条：store 是唯一"正向 delta"的库存动作，很容易被写成
        //   "反正访客也想存，就记一条正数吧" —— 那会让访客的本机账本凭空长出余额。
        const storeEvBefore = countEvents({ kind: 'inventory.store' });
        const gStore = await call(clientSocket, 'inventory:store', {
            bot: 'guest-bot', item: 'oak_log', qty: 3, chestKey: '10,64,-3', visitor: false,
        });
        const storeLedger = Number(db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'store'").get()?.n ?? -1);
        const gStoreAudit = Number(db.prepare("SELECT COUNT(*) AS n FROM inventory_audit WHERE actor = 'guest-bot' AND action = 'store'").get()?.n ?? -1);
        check('D7 ★ 访客 `inventory:store` ⇒ ledger **零行**、`inventory_audit` 有 store 行、events 里**没有** inventory.store',
            gStore?.ok === true && gStore?.visitor === true && gStore?.ledger === null
            && storeLedger === 0 && gStoreAudit === 1
            && countEvents({ kind: 'inventory.store' }) === storeEvBefore,
            JSON.stringify({ ledgerRows: storeLedger, audit: gStoreAudit, evDelta: countEvents({ kind: 'inventory.store' }) - storeEvBefore }));
    } finally {
        srv.stop?.();
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 清理 + 汇总（先关库再删目录：Windows 上句柄没关会 EPERM）
// ════════════════════════════════════════════════════════════════════════════
check('E1 事件库确实建在**临时根**里（本测试没有碰生产 bots/_global）',
    existsSync(path.join(ROOT, '_global', 'mind.sqlite')),
    path.join(ROOT, '_global', 'mind.sqlite'));

closeGlobalDb();
process.env.MC_BOTS_ROOT = prevRoot;
// 板库句柄也要关：Windows 上没关的 sqlite 句柄会让 rmSync 直接 EPERM
for (const d of opened) { try { d.close(); } catch { /* 已关/正忙：不再抛 */ } }
let cleaned = true;
try { rmSync(ROOT, { recursive: true, force: true }); } catch { cleaned = false; }

check('E2 临时目录清理完成（Windows 上句柄没关会 EPERM）', cleaned || !existsSync(ROOT));

console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
if (fail) console.log('FAILED');
process.exit(fail ? 1 : 0);
