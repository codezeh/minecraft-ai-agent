/**
 * 共享库存（ADR 阶段 3 / D7）：数量级预占 → 结算 → 对账。
 *
 * 三条口径（本文件只有这三句；为什么这样做见 docs/audit-r6/fixes4/inventory.md）：
 *   ① 真相是**真实箱子**：`container_cache` 只是"最近一次开箱看到的东西"，开箱强刷、取用失败标脏；
 *      对账以真实为准修正账本（D7-4），没有对账账实必然分叉。
 *   ② 预占的"读-判断-写"必须在**同一个 `BEGIN IMMEDIATE`** 内完成（复用 board_store 的
 *      `runInImmediateTx`），否则两个 bot 各自读到同一份可用量、各自插入 ⇒ 超卖。
 *   ③ 访客 bot 的活动**不写本机账本**（D7-6）：只在 `inventory_audit` 留一行审计，不占不结不计账。
 */
import { randomUUID } from 'node:crypto';
import { runInImmediateTx } from './board_store.js';

/** 预占默认有效期：够一次"走过去 + 开箱 + 取"的时间；过期由下一次预占/结算自动作废。 */
export const INVENTORY_TTL_MS = 5 * 60 * 1000;

/** 预占有效期上限（1 小时）：客户端不能靠"要一个超长 TTL"把库存锁死。 */
export const INVENTORY_TTL_MAX_MS = 60 * 60 * 1000;

/** 库存域的专有码（具名常量：这些码不在 contract.CODES 里，字面量会被 preflight 判成未注册）。 */
export const INVENTORY_RESULT_CODES = Object.freeze({
    INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
    RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
    NO_BOARD: 'NO_BOARD',
    NO_TARGET: 'NO_TARGET',
    NO_PERMISSION: 'NO_PERMISSION',
    TOO_MUCH: 'TOO_MUCH',
});

const C = INVENTORY_RESULT_CODES;

/** 整数判定（不走 `parseInt`：'12abc' 会被它读成 12，等于替调用方猜）。 */
function intOf(v) {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
}

function textOf(v) {
    return String(v ?? '').trim();
}

/** 物品名：非空、≤64 字符、无控制字符（控制字符会把日志与 ack 撑坏）。 */
function itemNameOf(v) {
    const name = textOf(v);
    if (!name) return { ok: false, code: C.NO_TARGET, message: '库存操作必须给物品名（item）' };
    if (name.length > 64) return { ok: false, code: C.TOO_MUCH, message: `物品名最多 64 个字符（收到 ${name.length} 个）` };
    if ([...name].some((ch) => ch.charCodeAt(0) < 0x20)) {
        return { ok: false, code: C.NO_TARGET, message: '物品名里不能有控制字符' };
    }
    return { ok: true, name };
}

/** 方块坐标：三个整数（与 team_chest 同一口径，不四舍五入替调用方做决定）。 */
function coordsOf(pos) {
    const pt = [pos?.x, pos?.y, pos?.z].map((v) => intOf(v));
    if (pt.some((v) => v == null)) {
        return { ok: false, code: C.NO_TARGET, message: `容器坐标必须是三个整数（收到 ${JSON.stringify({ x: pos?.x, y: pos?.y, z: pos?.z })}）` };
    }
    return { ok: true, x: pt[0], y: pt[1], z: pt[2] };
}

/** 一份物品表 → `{name: 正整数}`；0/负数/非法值**丢弃并记录**（不替调用方猜数量）。 */
function normalizeItems(raw) {
    if (raw == null) return { ok: true, items: {}, dropped: [] };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, code: C.NO_TARGET, message: 'items 必须是 {物品名: 数量} 的对象' };
    }
    const items = {};
    const dropped = [];
    for (const [name, rawCount] of Object.entries(raw)) {
        const key = textOf(name);
        const n = intOf(rawCount);
        if (!key || n == null || n <= 0) { dropped.push({ item: String(name), count: rawCount }); continue; }
        items[key] = (items[key] ?? 0) + n;
    }
    return { ok: true, items, dropped };
}

function parseItemsJson(json) {
    try {
        const v = JSON.parse(String(json ?? '{}'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        const out = {};
        for (const [k, n] of Object.entries(v)) {
            const q = intOf(n);
            if (q != null && q > 0) out[String(k)] = q;
        }
        return out;
    } catch { return {}; }
}

function cacheRowOf(db, worldId, { x, y, z }) {
    return db.prepare('SELECT * FROM container_cache WHERE world_id = ? AND x = ? AND y = ? AND z = ?')
        .get(worldId, x, y, z) ?? null;
}

/** 写缓存行（唯一写入口：`refresh` / `settle` 扣减 / `dirty` 标记都走它）。 */
function writeCacheRow(db, { worldId, x, y, z, items, now, dirty = 0 }) {
    db.prepare(`INSERT INTO container_cache (world_id, x, y, z, items_json, updated_at, dirty)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(world_id, x, y, z) DO UPDATE SET
            items_json = excluded.items_json, updated_at = excluded.updated_at, dirty = excluded.dirty`)
        .run(worldId, x, y, z, JSON.stringify(items ?? {}), Number(now), dirty ? 1 : 0);
}

/** 审计（append-only）。写不进去也**不能**改变业务结论：审计是留痕，不是交易的一部分。 */
function audit(db, { worldId, actor = null, action, item = null, qty = null, detail = null, now }) {
    try {
        db.prepare(`INSERT INTO inventory_audit (id, world_id, actor, action, item, qty, detail, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), worldId, actor, String(action), item, qty == null ? null : Number(qty),
                detail == null ? null : JSON.stringify(detail), Number(now));
    } catch { /* 审计失败不影响业务 */ }
}

function ledgerRowToObj(row) {
    if (!row) return null;
    return {
        id: String(row.id), world_id: String(row.world_id), item: String(row.item),
        delta: Number(row.delta), holder: row.holder == null ? null : String(row.holder),
        reason: String(row.reason), at: Number(row.at),
    };
}

function reservationRowToObj(row) {
    if (!row) return null;
    return {
        id: String(row.id), world_id: String(row.world_id), item: String(row.item), qty: Number(row.qty),
        holder: String(row.holder), created_at: Number(row.created_at), expires_at: Number(row.expires_at),
        status: String(row.status),
        consumed_qty: row.consumed_qty == null ? null : Number(row.consumed_qty),
        closed_at: row.closed_at == null ? null : Number(row.closed_at),
    };
}

/** 已知库存：缓存里各容器该物品数量之和（可选只看某几个容器）。 */
function knownStockOf(db, { worldId, item, containers = null }) {
    const rows = Array.isArray(containers) && containers.length
        ? containers.map((c) => {
            const pt = coordsOf(c);
            return pt.ok ? cacheRowOf(db, worldId, pt) : null;
        }).filter(Boolean)
        : db.prepare('SELECT * FROM container_cache WHERE world_id = ?').all(worldId);
    let total = 0;
    for (const row of rows) total += Number(parseItemsJson(row.items_json)[item] ?? 0);
    return total;
}

/** 已预占：仍处于 held 且未过期的数量之和（调用前事务内已作废过期行，这里只按 status 求和）。 */
function reservedQtyOf(db, { worldId, item }) {
    const row = db.prepare(
        "SELECT COALESCE(SUM(qty), 0) AS n FROM inventory_reservation WHERE world_id = ? AND item = ? AND status = 'held'",
    ).get(worldId, item);
    return Number(row?.n ?? 0);
}

/** 把过期预占标成 void（**不删行**：结算幂等要靠它区分"过期"与"从没存在过"）。 */
function voidExpired(db, { worldId, now }) {
    const rows = db.prepare(
        "SELECT id FROM inventory_reservation WHERE world_id = ? AND status = 'held' AND expires_at <= ?",
    ).all(worldId, Number(now));
    if (!rows.length) return [];
    db.prepare(
        "UPDATE inventory_reservation SET status = 'void', closed_at = ? WHERE world_id = ? AND status = 'held' AND expires_at <= ?",
    ).run(Number(now), worldId, Number(now));
    return rows.map((r) => String(r.id));
}

/** 开箱强刷缓存（D7-1）：把**刚看到**的真实内容写进缓存并清 dirty。 */
export function refreshContainerCache(db, { worldId, x, y, z, items, holder = null, now = Date.now() } = {}) {
    const wid = textOf(worldId);
    if (!wid) return { ok: false, code: C.NO_BOARD, message: '当前板库没有存档维度（world_id 为空）：拒绝写库存缓存' };
    const pt = coordsOf({ x, y, z });
    if (!pt.ok) return pt;
    const norm = normalizeItems(items);
    if (!norm.ok) return norm;
    const prev = cacheRowOf(db, wid, pt);
    const before = prev ? parseItemsJson(prev.items_json) : null;
    writeCacheRow(db, { worldId: wid, ...pt, items: norm.items, now, dirty: 0 });
    return {
        ok: true, world_id: wid, ...pt, items: norm.items, before,
        changed: JSON.stringify(before ?? {}) !== JSON.stringify(norm.items),
        dropped: norm.dropped, holder: holder == null ? null : String(holder),
    };
}

/** 取用失败 ⇒ 缓存标脏（D7-1）：内容不确定，别拿它当账；下一次开箱会强刷回来。 */
export function markContainerDirty(db, { worldId, x, y, z, reason = null, now = Date.now() } = {}) {
    const wid = textOf(worldId);
    if (!wid) return { ok: false, code: C.NO_BOARD, message: '当前板库没有存档维度（world_id 为空）：拒绝标脏' };
    const pt = coordsOf({ x, y, z });
    if (!pt.ok) return pt;
    const prev = cacheRowOf(db, wid, pt);
    // 从没观测过的容器：建一行空账 + dirty=1（"未知即 0"，宁可后续拒单也不超卖）
    writeCacheRow(db, { worldId: wid, ...pt, items: prev ? parseItemsJson(prev.items_json) : {}, now, dirty: 1 });
    return { ok: true, world_id: wid, ...pt, dirty: true, reason: reason == null ? null : String(reason) };
}

/**
 * 预占（D7-2）：`已预占 + 请求量 <= 已知库存` 全在**一个 `BEGIN IMMEDIATE`** 内判定。
 *
 * @returns {{ok:true, id:string, item:string, qty:number, known:number, reserved:number, available:number, expiresAt:number}
 *          | {ok:false, code:string, message:string, known?:number, reserved?:number, available?:number, requested?:number}}
 */
export function reserveStock(db, {
    worldId, item, qty, holder, ttlMs = INVENTORY_TTL_MS, containers = null, visitor = false, now = Date.now(),
} = {}) {
    const wid = textOf(worldId);
    if (!wid) return { ok: false, code: C.NO_BOARD, message: '当前板库没有存档维度（world_id 为空）：拒绝预占，避免记到错误的存档上' };
    const name = itemNameOf(item);
    if (!name.ok) return name;
    const who = textOf(holder);
    if (!who) return { ok: false, code: C.NO_PERMISSION, message: '不知道你是谁（holder 为空）：预占必须说明持有人' };
    const want = intOf(qty);
    if (want == null || want <= 0) return { ok: false, code: C.TOO_MUCH, message: `预占数量必须是正整数（收到 ${JSON.stringify(qty)}）` };
    const nowMs = Number(now);

    // 访客不占本机库存：只读一份数（给调用方提示）+ 留审计，不写 reservation / ledger
    if (visitor === true) {
        const known = knownStockOf(db, { worldId: wid, item: name.name, containers });
        const reserved = reservedQtyOf(db, { worldId: wid, item: name.name });
        audit(db, { worldId: wid, actor: who, action: 'reserve', item: name.name, qty: want, now: nowMs,
            detail: { visitor: true, known, reserved } });
        return { ok: true, visitor: true, skipped: true, id: null, item: name.name, qty: want,
            known, reserved, available: known - reserved, expiresAt: null };
    }

    return runInImmediateTx(db, () => {
        voidExpired(db, { worldId: wid, now: nowMs });
        const known = knownStockOf(db, { worldId: wid, item: name.name, containers });
        const reserved = reservedQtyOf(db, { worldId: wid, item: name.name });
        const available = known - reserved;
        if (want > available) {
            return {
                ok: false, code: C.INSUFFICIENT_STOCK,
                message: `库存不足：已知库存 ${known}、已预占 ${reserved}、可用 ${available}，请求 ${want}`,
                known, reserved, available, requested: want,
            };
        }
        const ttl = Math.min(Math.max(1, Number(ttlMs) || INVENTORY_TTL_MS), INVENTORY_TTL_MAX_MS);
        const expiresAt = nowMs + ttl;
        const id = randomUUID();
        db.prepare(`INSERT INTO inventory_reservation (id, world_id, item, qty, holder, created_at, expires_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'held')`)
            .run(id, wid, name.name, want, who, nowMs, expiresAt);
        return { ok: true, id, item: name.name, qty: want, holder: who, known, reserved, available: available - want, expiresAt };
    });
}

/**
 * 结算（D7-3）：实际取用写账本 + 预占转消耗（**同事务**）。
 *
 * 幂等：同一个 `reservationId` 重复结算只返回第一次的结果（账本 id 固定为 `<id>:take`，
 * 不会重复扣减）；已过期的预占返回 `RESERVATION_EXPIRED`，不是"再给你一次机会"。
 */
export function settleTake(db, {
    worldId, reservationId, holder, qty = null, container = null, visitor = false, now = Date.now(),
} = {}) {
    const wid = textOf(worldId);
    if (!wid) return { ok: false, code: C.NO_BOARD, message: '当前板库没有存档维度（world_id 为空）：拒绝结算' };
    const who = textOf(holder);
    if (!who) return { ok: false, code: C.NO_PERMISSION, message: '不知道你是谁（holder 为空）：结算必须说明取用者' };
    const nowMs = Number(now);

    if (visitor === true) {
        const pt = container ? coordsOf(container) : null;
        if (pt?.ok) markContainerDirty(db, { worldId: wid, ...pt, reason: 'visitor-take', now: nowMs });
        audit(db, { worldId: wid, actor: who, action: 'take', item: null, qty: intOf(qty), now: nowMs,
            detail: { visitor: true, container: pt?.ok ? { x: pt.x, y: pt.y, z: pt.z } : null } });
        return { ok: true, visitor: true, skipped: true, ledger: null, reservation: null };
    }

    return runInImmediateTx(db, () => {
        voidExpired(db, { worldId: wid, now: nowMs });
        const rid = textOf(reservationId);
        if (!rid) return { ok: false, code: C.NO_TARGET, message: '结算必须给 reservationId（先预占再取用）' };
        const row = db.prepare('SELECT * FROM inventory_reservation WHERE id = ?').get(rid);
        if (!row) return { ok: false, code: C.NO_TARGET, message: `没有这条预占（id=${rid}）` };
        if (String(row.world_id) !== wid) return { ok: false, code: C.NO_TARGET, message: '这条预占属于另一个存档' };
        if (String(row.holder) !== who) {
            return { ok: false, code: C.NO_PERMISSION, message: `这条预占是「${String(row.holder)}」的，不是「${who}」的` };
        }
        const reservation = reservationRowToObj(row);
        const ledgerId = `${rid}:take`;
        if (reservation.status === 'consumed') {
            const led = db.prepare('SELECT * FROM inventory_ledger WHERE id = ?').get(ledgerId);
            return { ok: true, already: true, reservation, ledger: ledgerRowToObj(led) };
        }
        if (reservation.status !== 'held') {
            return {
                ok: false, code: C.RESERVATION_EXPIRED,
                message: `预占已过期作废（到期 ${new Date(reservation.expires_at).toISOString()}）：重新预占再取`, reservation,
            };
        }
        const reserved = Number(row.qty);
        const take = qty == null ? reserved : intOf(qty);
        if (take == null || take <= 0) return { ok: false, code: C.TOO_MUCH, message: `实际取用必须是正整数（收到 ${JSON.stringify(qty)}）` };
        if (take > reserved) {
            return { ok: false, code: C.TOO_MUCH, message: `预占只有 ${reserved} 个，实际取用 ${take} 个：先补预占` };
        }
        const at = nowMs;
        db.prepare('INSERT INTO inventory_ledger (id, world_id, item, delta, holder, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(ledgerId, wid, String(row.item), -take, who, 'take', at);
        db.prepare("UPDATE inventory_reservation SET status = 'consumed', consumed_qty = ?, closed_at = ? WHERE id = ?")
            .run(take, at, rid);
        // 缓存跟着真实移动走：扣掉本次取用（缓存缺行/坐标没给 ⇒ 不动它，由对账兜底）
        let cache = { applied: false, reason: 'no-container' };
        if (container) {
            const pt = coordsOf(container);
            if (!pt.ok) cache = { applied: false, reason: 'bad-container' };
            else {
                const crow = cacheRowOf(db, wid, pt);
                if (!crow) cache = { applied: false, reason: 'cache-missing' };
                else {
                    const items = parseItemsJson(crow.items_json);
                    const before = Number(items[String(row.item)] ?? 0);
                    const after = Math.max(0, before - take);
                    if (after > 0) items[String(row.item)] = after; else delete items[String(row.item)];
                    // dirty 保持原样：本来就"不确定"的缓存，扣一次已知移动也不会变确定
                    writeCacheRow(db, { worldId: wid, ...pt, items, now: at, dirty: Number(crow.dirty) === 1 });
                    cache = { applied: true, x: pt.x, y: pt.y, z: pt.z, before, after };
                }
            }
        }
        const ledger = db.prepare('SELECT * FROM inventory_ledger WHERE id = ?').get(ledgerId);
        const updated = db.prepare('SELECT * FROM inventory_reservation WHERE id = ?').get(rid);
        return { ok: true, already: false, reservation: reservationRowToObj(updated), ledger: ledgerRowToObj(ledger), cache };
    });
}

/** 作废过期预占（可被定时扫描直接调用；预占/结算/对账内部也会先跑一遍）。 */
export function expireReservations(db, { worldId, now = Date.now() } = {}) {
    const wid = textOf(worldId);
    if (!wid) return { ok: false, code: C.NO_BOARD, message: '当前板库没有存档维度（world_id 为空）：拒绝清理预占' };
    const nowMs = Number(now);
    // 零行快查：定时扫描每秒调一次，没有过期行就**不开写事务**（别为了没事干去抢写锁）
    const any = db.prepare(
        "SELECT 1 AS hit FROM inventory_reservation WHERE world_id = ? AND status = 'held' AND expires_at <= ? LIMIT 1",
    ).get(wid, nowMs);
    if (!any) return { ok: true, world_id: wid, expired: 0, ids: [] };
    return runInImmediateTx(db, () => {
        const ids = voidExpired(db, { worldId: wid, now: nowMs });
        return { ok: true, world_id: wid, expired: ids.length, ids };
    });
}

/**
 * 对账（D7-4，**必选项**）：缓存 vs 真实，以真实为准。
 *
 * 对每个观测到的容器：`delta = 真实 - 缓存`，差额写进账本（reason='reconcile'）并把缓存改成真实；
 * 账实一致的容器**不写任何行**（对账必须可重复跑而不制造噪音）。
 *
 * @param {{worldId:string, observations:Array<{x:number,y:number,z:number,items:object}>, holder?:string, dryRun?:boolean, now?:number}} spec
 */
export function reconcileContainers(db, {
    worldId, observations = [], holder = null, dryRun = false, now = Date.now(),
} = {}) {
    const wid = textOf(worldId);
    if (!wid) return { ok: false, code: C.NO_BOARD, message: '当前板库没有存档维度（world_id 为空）：拒绝对账' };
    if (!Array.isArray(observations) || !observations.length) {
        return { ok: false, code: C.NO_TARGET, message: '对账至少要给一个容器观测（observations）' };
    }
    const who = textOf(holder) || null;
    const nowMs = Number(now);

    return runInImmediateTx(db, () => {
        voidExpired(db, { worldId: wid, now: nowMs });
        const report = {
            ok: true, world_id: wid, dry_run: dryRun === true,
            checked: 0, changed: 0, written: 0,
            containers: [], diffs: [], warnings: [], lines: [],
        };
        for (const obs of observations) {
            const pt = coordsOf(obs);
            if (!pt.ok) return pt;
            const norm = normalizeItems(obs?.items);
            if (!norm.ok) return norm;
            const actual = norm.items;
            const row = cacheRowOf(db, wid, pt);
            const cached = row ? parseItemsJson(row.items_json) : null;
            const wasDirty = row ? Number(row.dirty) === 1 : false;
            const names = new Set([...Object.keys(actual), ...Object.keys(cached ?? {})]);
            const diffs = [];
            for (const name of names) {
                const a = Number(actual[name] ?? 0);
                const c = Number(cached?.[name] ?? 0);
                if (a !== c) diffs.push({ item: name, cached: c, actual: a, delta: a - c });
            }
            report.checked++;
            const where = `(${pt.x},${pt.y},${pt.z})`;
            if (!diffs.length) {
                report.containers.push({ x: pt.x, y: pt.y, z: pt.z, changed: false, dirty: wasDirty, diffs: [] });
                report.lines.push(`箱子${where}：账实一致（${Object.keys(actual).length} 种物品）${wasDirty ? '（脏标记已清）' : ''}`);
                if (!dryRun && wasDirty) writeCacheRow(db, { worldId: wid, ...pt, items: actual, now: nowMs, dirty: 0 });
                continue;
            }
            for (const d of diffs) {
                report.diffs.push({ x: pt.x, y: pt.y, z: pt.z, ...d });
                const sign = d.delta > 0 ? '+' : '';
                report.lines.push(`箱子${where}：${d.item} 账 ${d.cached} → 真 ${d.actual}（修正 ${sign}${d.delta}）`);
                if (!dryRun) {
                    db.prepare('INSERT INTO inventory_ledger (id, world_id, item, delta, holder, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                        .run(randomUUID(), wid, d.item, d.delta, who, 'reconcile', nowMs);
                    report.written++;
                }
            }
            report.changed++;
            report.containers.push({ x: pt.x, y: pt.y, z: pt.z, changed: true, dirty: wasDirty, diffs });
            if (!dryRun) writeCacheRow(db, { worldId: wid, ...pt, items: actual, now: nowMs, dirty: 0 });
            // 预占超过真实库存 ⇒ 不能自动改预占（别人可能正拿着券在开箱），但必须**明说**
            for (const [name, a] of Object.entries(actual)) {
                const held = reservedQtyOf(db, { worldId: wid, item: name });
                if (held > a) {
                    report.warnings.push({ item: name, reserved: held, actual: a });
                    report.lines.push(`⚠ ${name}：已预占 ${held} 个超过真实库存 ${a} 个（对账不会替你撤销别人的券，请人工确认）`);
                }
            }
        }
        report.summary = report.changed
            ? `对账完成：检查 ${report.checked} 个容器，${report.changed} 个不一致，写入 ${report.written} 条修正`
            : `对账完成：检查 ${report.checked} 个容器，账实一致`;
        return report;
    });
}

/** 库存快照（面板/排障用）：每个物品的已知/已预占/可用 + 缓存与预占明细。 */
export function inventorySnapshot(db, { worldId, item = null, now = Date.now() } = {}) {
    const wid = textOf(worldId);
    if (!wid) return { ok: false, code: C.NO_BOARD, message: '当前板库没有存档维度（world_id 为空）：拒绝读库存快照' };
    const want = item == null ? null : itemNameOf(item);
    if (want && !want.ok) return want;
    return runInImmediateTx(db, () => {
        const expired = voidExpired(db, { worldId: wid, now: Number(now) });
        const rows = db.prepare('SELECT * FROM container_cache WHERE world_id = ? ORDER BY x, y, z').all(wid);
        const known = new Map();
        const containers = rows.map((r) => {
            const items = parseItemsJson(r.items_json);
            for (const [name, n] of Object.entries(items)) known.set(name, (known.get(name) ?? 0) + Number(n));
            return {
                x: Number(r.x), y: Number(r.y), z: Number(r.z), items,
                updated_at: Number(r.updated_at), dirty: Number(r.dirty) === 1,
            };
        });
        const resRows = db.prepare("SELECT * FROM inventory_reservation WHERE world_id = ? AND status = 'held' ORDER BY created_at ASC").all(wid);
        const reserved = new Map();
        for (const r of resRows) reserved.set(String(r.item), (reserved.get(String(r.item)) ?? 0) + Number(r.qty));
        const names = new Set([...known.keys(), ...reserved.keys(), ...(want ? [want.name] : [])]);
        const items = [...names].sort().filter((n) => !want || n === want.name).map((name) => {
            const k = Number(known.get(name) ?? 0);
            const r = Number(reserved.get(name) ?? 0);
            return { item: name, known: k, reserved: r, available: k - r };
        });
        return {
            ok: true, world_id: wid, expired, items, containers,
            reservations: resRows.map(reservationRowToObj),
        };
    });
}

/** 账本（对账/复盘用）：按时间倒序，可按物品过滤。 */
export function inventoryLedger(db, { worldId, item = null, limit = 100 } = {}) {
    const wid = textOf(worldId);
    if (!wid) return { ok: false, code: C.NO_BOARD, message: '当前板库没有存档维度（world_id 为空）：拒绝读账本' };
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = item
        ? db.prepare('SELECT * FROM inventory_ledger WHERE world_id = ? AND item = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(wid, String(item), n)
        : db.prepare('SELECT * FROM inventory_ledger WHERE world_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(wid, n);
    return { ok: true, world_id: wid, entries: rows.map(ledgerRowToObj) };
}
