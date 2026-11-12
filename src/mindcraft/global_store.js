/**
 * `_global` 记忆库：events（**追加写**）+ relations（可更新）—— ADR 记忆结构化（D8）。
 *
 * 口径、字段、迁移与接线清单见 `docs/audit-r6/fixes4/events.md`；本文件只有实现。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { botsRootOf } from '../agent/library/bot_paths.js';
import { isValidWorldId } from './world_store.js';

/** 全局层目录名（`_` 开头表示"不是某只 bot 的名字"）。 */
export const GLOBAL_DIR_NAME = '_global';
/** 全局库文件名：跨存档共享的"人 / 关系 / 事件"层。 */
export const GLOBAL_DB_FILE = 'mind.sqlite';
/** 库结构版本（`PRAGMA user_version`）：加表/加索引必须升版本并写幂等迁移。 */
// v2（阶段 4 联邦）：新增 visit_grants / peer_allowlist / known_peers / import_cursors 四张表。
// 老库一行数据都不动（全是 `CREATE TABLE IF NOT EXISTS` + 索引），events/relations 语义不变。
export const GLOBAL_SCHEMA_VERSION = 2;

/** 单条事件 payload 的 JSON 上限（8 KiB）：事件是审计/记忆，不是数据搬运通道。 */
export const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;
/** 允许的 kind（**封闭白名单**）：新增 kind 必须改这里，不许调用方自造。 */
export const EVENT_KINDS = Object.freeze([
    'identity.claim', 'identity.invite', 'identity.revoke', 'identity.recover', 'identity.relink',
    'avatar.retire',
    'team.create', 'team.join', 'team.leave', 'team.disband',
    'inventory.reserve', 'inventory.settle', 'inventory.reconcile', 'inventory.rollback',
    'world.migrate', 'world.reset',
    'federation.visit', 'federation.depart', 'federation.card',
    'federation.grant', 'federation.relations', 'federation.peer',
    'block.break', 'block.place',
    // 外部日志（CoreProtect）汇入：第三人称记录（谁改了哪一格），与上面的"我这一下的结果"不是同一件事，
    // 合并会让"按 kind 统计"把导入量和真实增量加在一起 —— 见 docs/audit-r6/fixes4/federation.md §6。
    'block-change',
    'chat.say', 'chat.receive',
    'player.join', 'player.quit',
]);
const KIND_SET = new Set(EVENT_KINDS);
/** kind 语法：小写分段、点连接，段内允许 `-`（`block-change` 这类合成词）与 `_`。 */
const KIND_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
/** 标识长度上限（avatar_id / source_ip / 显式 event id）。 */
const MAX_ID_LEN = 64;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
/** 查询默认/上限条数：给面板分页用，避免一次把整库读进内存。 */
export const DEFAULT_EVENT_LIMIT = 200;
export const MAX_EVENT_LIMIT = 2000;
/** 关系标签上限：标签是检索用的粗粒度标记，不是自由文本。 */
export const MAX_RELATION_TAGS = 32;
export const MAX_TAG_LEN = 48;
export const MAX_AFFINITY = 1_000_000;

const SCHEMA = `
-- events：**追加写**（下面两个触发器让 UPDATE/DELETE 在库层就失败，不只是"没有导出"）
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    world_id TEXT,
    avatar_id TEXT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    at INTEGER NOT NULL,
    source_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at, id);
CREATE INDEX IF NOT EXISTS idx_events_kind_at ON events(kind, at);
CREATE INDEX IF NOT EXISTS idx_events_world_at ON events(world_id, at);

-- relations：按 (from,to) 唯一；affinity 的增量在 SQL 里做（不在 JS 里读改写）
CREATE TABLE IF NOT EXISTS relations (
    from_avatar TEXT NOT NULL,
    to_avatar TEXT NOT NULL,
    affinity INTEGER NOT NULL DEFAULT 0,
    tags_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (from_avatar, to_avatar)
);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_avatar);

-- ── 阶段 4 联邦（D5/D9）────────────────────────────────────────────────────
-- 访客凭证：主机签发、客机核销。token **只存 sha256**（同恢复码口径：明文只在签发回执里出现一次）。
-- 一次性/重放由 used_count < max_uses 在 UPDATE 的 WHERE 里挡（不做"先查后写"）。
CREATE TABLE IF NOT EXISTS visit_grants (
    grant_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    guest_id TEXT NOT NULL,
    token_sha256 TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER,
    revoked_at INTEGER,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_grants_guest ON visit_grants(guest_id, expires_at);

-- 访问白名单：凭证核销只认名单内的 guest（"受白名单限制"的唯一落点）。
CREATE TABLE IF NOT EXISTS peer_allowlist (
    peer_id TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL,
    note TEXT
);

-- 见过的对端：首次见面把公钥钉住（TOFU），之后名片公钥必须与之一致；
-- card_seq 单调递增，旧名片重放直接被拒（公钥可轮换，但必须显式 forgetPeer 再重见）。
CREATE TABLE IF NOT EXISTS known_peers (
    peer_id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    last_addr TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    card_seq INTEGER NOT NULL DEFAULT 0,
    card_json TEXT
);

-- 外部日志导入游标（CoreProtect 等）：一行一个 source，cursor 只增不减。
CREATE TABLE IF NOT EXISTS import_cursors (
    source TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
`;

/** 事件表的**库层**追加写约束：任何 UPDATE/DELETE 直接 ABORT（连误操作也改不了历史）。 */
const APPEND_ONLY_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only: UPDATE is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only: DELETE is forbidden'); END;
`;

const errWithCode = (code, message) => Object.assign(new Error(message), { code });
const nowOf = (at) => (Number.isFinite(at) && Number(at) > 0 ? Math.trunc(Number(at)) : Date.now());
const newEventId = (at) => `ev-${at.toString(36)}-${randomBytes(4).toString('hex')}`;

/** 已打开的写句柄（按**绝对路径**缓存）：`MC_BOTS_ROOT` 变化时各用各的，测试互不串。 */
const OPEN = new Map();

/** `_global` 目录（绝对路径，锚在 bots 根）。 */
export function globalDirOf() {
    return `${botsRootOf()}/${GLOBAL_DIR_NAME}`;
}

/** 全局库文件路径。 */
export function globalDbPathOf() {
    return join(globalDirOf(), GLOBAL_DB_FILE);
}

/** kind 是否在白名单内（调用方可以先问再写，不必靠异常判）。 */
export function eventKindAllowed(kind) {
    return typeof kind === 'string' && KIND_RE.test(kind) && KIND_SET.has(kind);
}

/** PRAGMA 是否真生效必须读回核对：静默降级比报错更难查（同 `board_store` 口径）。 */
function tune(db, { wal, warnings }) {
    if (wal) {
        try {
            const mode = String(db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode ?? '').toLowerCase();
            if (mode !== 'wal') warnings.push(`journal_mode 未生效（${mode || '?'}）：多进程并发写更容易 BUSY`);
        } catch (e) {
            warnings.push(`PRAGMA journal_mode = WAL 失败：${String(e?.message ?? e)}`);
        }
    }
    try {
        db.prepare('PRAGMA busy_timeout = 5000').get();
    } catch (e) {
        warnings.push(`PRAGMA busy_timeout 失败：${String(e?.message ?? e)}`);
    }
}

/** 幂等建表 + 落版本号；库比代码新时**拒绝打开**（旧代码写新库会静默丢字段）。 */
function ensureSchema(db) {
    const from = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (from > GLOBAL_SCHEMA_VERSION) {
        throw errWithCode('GLOBAL_SCHEMA_TOO_NEW',
            `全局库结构版本 ${from} 比本代码（${GLOBAL_SCHEMA_VERSION}）新：拒绝用旧代码写新库`);
    }
    db.exec(SCHEMA);
    db.exec(APPEND_ONLY_TRIGGERS);
    db.exec(`PRAGMA user_version = ${GLOBAL_SCHEMA_VERSION}`);
    return { from, to: GLOBAL_SCHEMA_VERSION };
}

/**
 * 打开（必要时创建）全局库。只读模式不建目录/不建表/不迁移，库不存在直接抛。
 *
 * @param {{path?:string, readOnly?:boolean, quiet?:boolean}} [opts]
 * @returns {{db:DatabaseSync, path:string, created:boolean, readOnly:boolean, warnings:string[]}}
 */
export function openGlobalDb(opts = {}) {
    const path = opts.path ?? globalDbPathOf();
    if (opts.readOnly === true) {
        // 只读**不复用**写句柄：观察者不该共享写连接（也避免把 WAL 写锁留在面板进程里）。
        if (!existsSync(path)) {
            throw errWithCode('GLOBAL_DB_MISSING', `只读打开失败：${path} 不存在（拒绝凭空建空库）`);
        }
        const db = new DatabaseSync(path, { readOnly: true });
        const warnings = [];
        tune(db, { wal: false, warnings });
        db.prepare('SELECT count(*) FROM sqlite_master').get();   // 惰性打开：坏文件在打开点就报
        return { db, path, created: false, readOnly: true, warnings };
    }
    const hit = OPEN.get(path);
    if (hit) return hit;
    const created = !existsSync(path);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    const warnings = [];
    tune(db, { wal: true, warnings });
    try {
        ensureSchema(db);
    } catch (e) {
        try { db.close(); } catch { /* 关不掉也照抛 */ }
        throw e;
    }
    const handle = { db, path, created, readOnly: false, warnings };
    if (!opts.quiet && warnings.length) for (const w of warnings) console.warn(`[global] ${w}`);
    OPEN.set(path, handle);
    return handle;
}

/** 关掉本进程缓存的所有写句柄（测试清临时目录前必须调，否则 Windows 上 rmSync 会 EPERM）。 */
export function closeGlobalDb() {
    let n = 0;
    for (const [path, h] of OPEN) {
        try { h.db.close(); n++; } catch { /* 已关/正忙：不再抛 */ }
        OPEN.delete(path);
    }
    return n;
}

/**
 * 查询入口统一走这里：`{db}` 用调用方的句柄，`{readOnly:true}` 用完即关（不留给进程），
 * 否则每次查询都会多开一条永不关闭的连接。
 */
function readVia(opts, fn) {
    if (opts.db) return fn(opts.db);
    if (opts.readOnly === true) {
        const h = openGlobalDb({ readOnly: true });
        try {
            return fn(h.db);
        } finally {
            try { h.db.close(); } catch { /* 关不掉不影响结果 */ }
        }
    }
    return fn(openGlobalDb().db);
}

/** 记录一次事件（**唯一入口**）。任何拒绝/写失败都只返回结果，不抛给调用方。 */
export function recordEvent(kind, payload, ctx = {}) {
    const head = { ok: false, kind: typeof kind === 'string' ? kind : null };
    if (!eventKindAllowed(kind)) {
        return reject('kind-not-allowed', `${head.kind ?? JSON.stringify(kind ?? null)} 不在 kind 白名单内`, head);
    }
    let json;
    try {
        json = JSON.stringify(payload === undefined ? {} : payload);
    } catch (e) {
        return reject('payload-not-serializable', `payload 无法 JSON 序列化：${String(e?.message ?? e)}`, head);
    }
    if (typeof json !== 'string') {
        return reject('payload-not-serializable', `payload 序列化后不是字符串（${typeof json}）`, head);
    }
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
        return reject('payload-too-large', `payload ${bytes} 字节 > 上限 ${MAX_EVENT_PAYLOAD_BYTES}`, { ...head, bytes });
    }
    if (ctx.at !== undefined && !Number.isFinite(ctx.at)) {
        return reject('time-invalid', `at 不是有限数字：${JSON.stringify(ctx.at)}`, head);
    }
    const at = nowOf(ctx.at);
    const worldId = ctx.worldId == null || ctx.worldId === '' ? null : String(ctx.worldId).trim();
    if (worldId !== null && !isValidWorldId(worldId)) {
        return reject('world-id-invalid', `world_id 不合法：${JSON.stringify(ctx.worldId)}`, head);
    }
    const avatarId = normalizeId(ctx.avatarId);
    if (avatarId === false) return reject('avatar-id-invalid', `avatar_id 不合法：${JSON.stringify(ctx.avatarId)}`, head);
    const sourceIp = normalizeId(ctx.sourceIp);
    if (sourceIp === false) return reject('source-ip-invalid', `source_ip 不合法：${JSON.stringify(ctx.sourceIp)}`, head);
    const id = ctx.id === undefined ? newEventId(at) : ctx.id;
    if (typeof id !== 'string' || !EVENT_ID_RE.test(id)) {
        return reject('event-id-invalid', `event id 不合法：${JSON.stringify(ctx.id)}`, head);
    }
    try {
        const { db } = openGlobalDb();
        // 单行 insert，不做"先查再插"：显式 id 的重复（联邦重放）靠 OR IGNORE 吃掉。
        const r = db.prepare(
            'INSERT OR IGNORE INTO events(id, world_id, avatar_id, kind, payload_json, at, source_ip) VALUES(?,?,?,?,?,?,?)',
        ).run(id, worldId, avatarId, kind, json, at, sourceIp);
        if (Number(r?.changes ?? 0) === 0) return { ok: false, reason: 'duplicate-id', id, kind, at };
        return { ok: true, id, kind, at, bytes };
    } catch (e) {
        console.error(`[global] 事件写入失败 kind=${kind}：${String(e?.message ?? e)}`);
        return { ok: false, reason: 'write-failed', kind, detail: String(e?.message ?? e) };
    }
}

/** 有没有控制字符（换行/退格等）：标识会进日志，含控制字符可伪造多行。 */
function hasControl(s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 32 || c === 127) return true;
    }
    return false;
}

/** 归一化"可选标识"：缺省 → null；合法 → 字符串；不合法 → false（调用方据此拒绝）。 */
function normalizeId(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') return false;
    const s = raw.trim();
    if (!s || s.length > MAX_ID_LEN) return false;
    return hasControl(s) ? false : s;
}

/** 拒绝：统一 warn（按 kind+reason 去重，避免刷屏）+ 返回结构化结果，**不抛**。 */
const WARNED = new Set();
function reject(reason, detail, head = {}) {
    const key = `${reason}|${head.kind ?? ''}`;
    if (!WARNED.has(key)) {
        WARNED.add(key);
        console.warn(`[global] 拒绝记录事件（${reason}）：${detail}`);
    }
    return { ok: false, reason, ...head, detail };
}

/**
 * 按 `since` 取事件（`at` 升序、同 `at` 按 id 升序）。
 *
 * `since` = 毫秒时间戳（`at >= since`，宁可重复不许漏）或 `{at, id}` 元组游标（严格 `>`，同毫秒也不漏）。
 */
export function sinceEvents(since, opts = {}) {
    const where = [];
    const args = [];
    if (since !== undefined && since !== null) {
        if (typeof since === 'number' && Number.isFinite(since) && since >= 0) {
            where.push('at >= ?');
            args.push(Math.trunc(since));
        } else if (typeof since === 'object' && Number.isFinite(since.at)) {
            where.push('(at > ? OR (at = ? AND id > ?))');
            const at = Math.trunc(Number(since.at));
            args.push(at, at, typeof since.id === 'string' ? since.id : '');
        } else {
            throw errWithCode('SINCE_INVALID',
                `since 必须是毫秒时间戳或 {at,id} 元组游标，收到 ${JSON.stringify(since)}`);
        }
    }
    if (opts.worldId !== undefined && opts.worldId !== null) {
        where.push('world_id = ?');
        args.push(String(opts.worldId));
    }
    if (opts.kind !== undefined && opts.kind !== null) {
        if (!eventKindAllowed(opts.kind)) {
            throw errWithCode('KIND_INVALID', `kind 不在白名单内：${JSON.stringify(opts.kind)}`);
        }
        where.push('kind = ?');
        args.push(opts.kind);
    }
    const limit = normalizeLimit(opts.limit);
    const sql = 'SELECT id, world_id, avatar_id, kind, payload_json, at, source_ip FROM events'
        + `${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at ASC, id ASC LIMIT ?`;
    return readVia(opts, (db) => db.prepare(sql).all(...args, limit).map(rowToEvent));
}

/** 库行 → 事件对象（payload 解析失败要能被看见，不能当成 `null` 蒙过去）。 */
function rowToEvent(row) {
    let payload = null;
    let payloadOk = true;
    try {
        payload = JSON.parse(String(row.payload_json));
    } catch {
        payloadOk = false;
    }
    return {
        id: String(row.id),
        worldId: row.world_id ?? null,
        avatarId: row.avatar_id ?? null,
        kind: String(row.kind),
        payload,
        payloadOk,
        at: Number(row.at),
        sourceIp: row.source_ip ?? null,
    };
}

function normalizeLimit(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_EVENT_LIMIT;
    return Math.min(Math.floor(n), MAX_EVENT_LIMIT);
}

/** 按 kind 统计（面板/复盘用）：条数 + 首末时间；`worldId` 给了就只看那一档。 */
export function statsByKind(opts = {}) {
    const args = [];
    let where = '';
    if (opts.worldId !== undefined && opts.worldId !== null) {
        where = ' WHERE world_id = ?';
        args.push(String(opts.worldId));
    }
    return readVia(opts, (h) => h.prepare(
        `SELECT kind, COUNT(*) AS n, MIN(at) AS firstAt, MAX(at) AS lastAt FROM events${where} GROUP BY kind ORDER BY n DESC, kind ASC`,
    ).all(...args).map((r) => ({
        kind: String(r.kind), count: Number(r.n), firstAt: Number(r.firstAt), lastAt: Number(r.lastAt),
    })));
}

/** 事件总条数（对账/测试用）。 */
export function countEvents(opts = {}) {
    const args = [];
    const where = [];
    if (opts.worldId !== undefined && opts.worldId !== null) {
        where.push('world_id = ?');
        args.push(String(opts.worldId));
    }
    if (opts.kind !== undefined && opts.kind !== null) {
        where.push('kind = ?');
        args.push(String(opts.kind));
    }
    return readVia(opts, (db) => Number(db.prepare(
        `SELECT COUNT(*) AS n FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    ).get(...args)?.n ?? 0));
}

// ───────────────────────────────────────────────────────────────────────────
// relations
// ───────────────────────────────────────────────────────────────────────────

/** 校验关系端点：非空、不超长、不含控制字符、不自指。 */
function checkPair(from, to) {
    const a = normalizeId(from);
    const b = normalizeId(to);
    if (a === false || a === null) return { reason: 'from-avatar-invalid' };
    if (b === false || b === null) return { reason: 'to-avatar-invalid' };
    if (a === b) return { reason: 'self-relation-refused' };
    return { from: a, to: b };
}

/** 标签归一化：去重保序、逐个校验长度与字符；不合法返回 false，缺省返回 null。 */
function normalizeTags(tags) {
    if (tags === undefined || tags === null) return null;
    if (!Array.isArray(tags)) return false;
    const out = [];
    for (const t of tags) {
        if (typeof t !== 'string') return false;
        const s = t.trim();
        if (!s || s.length > MAX_TAG_LEN) return false;
        if (hasControl(s)) return false;
        if (!out.includes(s)) out.push(s);
    }
    return out.length > MAX_RELATION_TAGS ? false : out;
}

function checkAffinity(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || Math.abs(n) > MAX_AFFINITY) return null;
    return n;
}

function rowToRelation(row) {
    let tags = [];
    try {
        const raw = JSON.parse(String(row.tags_json));
        if (Array.isArray(raw)) tags = raw.map(String);
    } catch { /* 坏数据按空标签返回，不抛 */ }
    return {
        from: String(row.from_avatar),
        to: String(row.to_avatar),
        affinity: Number(row.affinity),
        tags,
        updatedAt: Number(row.updated_at),
    };
}

/** 绝对写：把 affinity / tags 设成给定值（upsert，单条 SQL）。 */
export function setRelation(from, to, opts = {}) {
    const pair = checkPair(from, to);
    if (!pair.from) return { ok: false, reason: pair.reason };
    const affinity = opts.affinity === undefined ? 0 : checkAffinity(opts.affinity);
    if (affinity === null) return { ok: false, reason: 'affinity-invalid' };
    const tags = normalizeTags(opts.tags);
    if (tags === false) return { ok: false, reason: 'tags-invalid' };
    try {
        const { db } = openGlobalDb();
        db.prepare(
            `INSERT INTO relations(from_avatar,to_avatar,affinity,tags_json,updated_at) VALUES(?,?,?,?,?)
             ON CONFLICT(from_avatar,to_avatar) DO UPDATE SET
               affinity=excluded.affinity, tags_json=excluded.tags_json, updated_at=excluded.updated_at`,
        ).run(pair.from, pair.to, affinity, JSON.stringify(tags ?? []), nowOf(opts.at));
        return { ok: true, relation: getRelation(pair.from, pair.to) };
    } catch (e) {
        console.error(`[global] 关系写入失败 ${pair.from}->${pair.to}：${String(e?.message ?? e)}`);
        return { ok: false, reason: 'write-failed', detail: String(e?.message ?? e) };
    }
}

/** 增量写：`affinity += delta`（加法在 SQL 里做，**不做** JS 读改写）；给了 tags 才覆盖。 */
export function addRelationAffinity(from, to, delta, opts = {}) {
    const pair = checkPair(from, to);
    if (!pair.from) return { ok: false, reason: pair.reason };
    const d = checkAffinity(delta);
    if (d === null || d === 0) return { ok: false, reason: 'delta-invalid' };
    const tags = normalizeTags(opts.tags);
    if (tags === false) return { ok: false, reason: 'tags-invalid' };
    const json = tags === null ? null : JSON.stringify(tags);
    try {
        const { db } = openGlobalDb();
        db.prepare(
            `INSERT INTO relations(from_avatar,to_avatar,affinity,tags_json,updated_at) VALUES(?,?,?,COALESCE(?, '[]'),?)
             ON CONFLICT(from_avatar,to_avatar) DO UPDATE SET
               affinity=relations.affinity + excluded.affinity,
               tags_json=COALESCE(?, relations.tags_json),
               updated_at=excluded.updated_at`,
        ).run(pair.from, pair.to, d, json, nowOf(opts.at), json);
        return { ok: true, relation: getRelation(pair.from, pair.to) };
    } catch (e) {
        console.error(`[global] 关系增量失败 ${pair.from}->${pair.to}：${String(e?.message ?? e)}`);
        return { ok: false, reason: 'write-failed', detail: String(e?.message ?? e) };
    }
}

/** 批量增量（联邦的关系增量）：一次事务内全部生效，坏条目**跳过并报告**。 */
export function applyRelationDeltas(list, opts = {}) {
    if (!Array.isArray(list)) return { ok: false, reason: 'deltas-invalid', applied: 0, rejected: [] };
    const rejected = [];
    const rows = [];
    for (let i = 0; i < list.length; i++) {
        const item = list[i] ?? {};
        const pair = checkPair(item.from, item.to);
        const d = checkAffinity(item.delta);
        const tags = normalizeTags(item.tags);
        if (!pair.from || d === null || d === 0 || tags === false) {
            rejected.push({
                index: i,
                reason: !pair.from ? pair.reason : (d === null || d === 0 ? 'delta-invalid' : 'tags-invalid'),
            });
            continue;
        }
        rows.push({ pair, delta: d, tags, at: nowOf(item.at ?? opts.at) });
    }
    if (!rows.length) return { ok: rejected.length === 0, applied: 0, rejected };
    try {
        const { db } = openGlobalDb();
        const stmt = db.prepare(
            `INSERT INTO relations(from_avatar,to_avatar,affinity,tags_json,updated_at) VALUES(?,?,?,COALESCE(?, '[]'),?)
             ON CONFLICT(from_avatar,to_avatar) DO UPDATE SET
               affinity=relations.affinity + excluded.affinity,
               tags_json=COALESCE(?, relations.tags_json),
               updated_at=excluded.updated_at`,
        );
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const r of rows) {
                const json = r.tags === null ? null : JSON.stringify(r.tags);
                stmt.run(r.pair.from, r.pair.to, r.delta, json, r.at, json);
            }
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
        return { ok: true, applied: rows.length, rejected };
    } catch (e) {
        console.error(`[global] 关系批量增量失败：${String(e?.message ?? e)}`);
        return { ok: false, reason: 'write-failed', applied: 0, rejected, detail: String(e?.message ?? e) };
    }
}

/** 读一条关系；没有就返回 null（"没关系"不是错误）。 */
export function getRelation(from, to) {
    const pair = checkPair(from, to);
    if (!pair.from) return null;
    const { db } = openGlobalDb();
    const row = db.prepare('SELECT * FROM relations WHERE from_avatar=? AND to_avatar=?').get(pair.from, pair.to);
    return row ? rowToRelation(row) : null;
}

/** 列出关系（可按 from / to 过滤），按 |affinity| 降序、再按 updatedAt 降序。 */
export function listRelations(opts = {}) {
    const where = [];
    const args = [];
    if (opts.from !== undefined && opts.from !== null) {
        where.push('from_avatar = ?');
        args.push(String(opts.from));
    }
    if (opts.to !== undefined && opts.to !== null) {
        where.push('to_avatar = ?');
        args.push(String(opts.to));
    }
    const limit = normalizeLimit(opts.limit);
    return readVia(opts, (db) => db.prepare(
        `SELECT * FROM relations${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ABS(affinity) DESC, updated_at DESC LIMIT ?`,
    ).all(...args, limit).map(rowToRelation));
}

// ───────────────────────────────────────────────────────────────────────────
// 关系增量同步（联邦）：按 updated_at 拉取 / 推送，推送幂等
// ───────────────────────────────────────────────────────────────────────────

/** 按 `updated_at` 拉增量（`>=` 宁重不漏；同一毫秒的多行靠 from/to 定序，游标可安全重放）。 */
export function exportRelationsSince(updatedAt = 0, opts = {}) {
    const since = Number.isFinite(Number(updatedAt)) ? Math.trunc(Number(updatedAt)) : 0;
    const limit = normalizeLimit(opts.limit);
    return readVia(opts, (db) => {
        const rows = db.prepare(
            `SELECT * FROM relations WHERE updated_at >= ?
             ORDER BY updated_at ASC, from_avatar ASC, to_avatar ASC LIMIT ?`,
        ).all(since, limit).map(rowToRelation);
        return {
            ok: true,
            cursor: rows.length ? rows[rows.length - 1].updatedAt : since,
            rows: rows.map((r) => ({ from: r.from, to: r.to, affinity: r.affinity, tags: r.tags, updatedAt: r.updatedAt })),
            limit,
        };
    });
}

/**
 * 接收对端推来的关系增量（**幂等**）。
 *
 * 冲突策略（顺序即优先级）：① 本地没有 → 插入；② 对端 `updatedAt` 更新 → 覆盖；
 * ③ 对端更旧 → 丢弃；④ `updatedAt` 相同：内容一致 → 什么都不做（幂等），内容不同 →
 * **确定性 tie-break**（`affinity:tags` 字典序较大者胜）。④ 保证两台机器互推同一个时间戳的不同版本
 * 时**必然收敛到同一行**（否则每推一次结果都变，等于不幂等）。
 */
export function pushRelations(rows, opts = {}) {
    const base = { ok: false, inserted: 0, updated: 0, identical: 0, older: 0, conflicts: 0, rejected: [] };
    if (!Array.isArray(rows)) return { ...base, reason: 'rows-invalid' };
    const rejected = [];
    const clean = [];
    for (let i = 0; i < rows.length; i++) {
        const item = rows[i] ?? {};
        const pair = checkPair(item.from, item.to);
        const affinity = checkAffinity(item.affinity);
        const tags = normalizeTags(item.tags);
        const at = Number(item.updatedAt);
        if (!pair.from || affinity === null || tags === false || !Number.isFinite(at) || at <= 0) {
            rejected.push({
                index: i,
                reason: !pair.from ? pair.reason
                    : affinity === null ? 'affinity-invalid'
                        : tags === false ? 'tags-invalid' : 'updated-at-invalid',
            });
            continue;
        }
        clean.push({ from: pair.from, to: pair.to, affinity, tags, updatedAt: Math.trunc(at) });
    }
    if (!clean.length) return { ...base, ok: rejected.length === 0, rejected };
    let inserted = 0;
    let updated = 0;
    let identical = 0;
    let older = 0;
    let conflicts = 0;
    let cursor = 0;
    try {
        const { db } = openGlobalDb();
        const sel = db.prepare('SELECT affinity, tags_json, updated_at FROM relations WHERE from_avatar=? AND to_avatar=?');
        const ins = db.prepare('INSERT INTO relations(from_avatar,to_avatar,affinity,tags_json,updated_at) VALUES(?,?,?,?,?)');
        const upd = db.prepare('UPDATE relations SET affinity=?, tags_json=?, updated_at=? WHERE from_avatar=? AND to_avatar=?');
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const r of clean) {
                cursor = Math.max(cursor, r.updatedAt);
                const tagsJson = JSON.stringify(r.tags);
                const cur = sel.get(r.from, r.to);
                if (!cur) {
                    ins.run(r.from, r.to, r.affinity, tagsJson, r.updatedAt);
                    inserted++;
                    continue;
                }
                const curAt = Number(cur.updated_at);
                if (r.updatedAt > curAt) {
                    upd.run(r.affinity, tagsJson, r.updatedAt, r.from, r.to);
                    updated++;
                    continue;
                }
                if (r.updatedAt < curAt) {
                    older++;
                    continue;
                }
                if (Number(cur.affinity) === r.affinity && String(cur.tags_json) === tagsJson) {
                    identical++;
                    continue;
                }
                conflicts++;
                if (`${r.affinity}:${tagsJson}` > `${Number(cur.affinity)}:${String(cur.tags_json)}`) {
                    upd.run(r.affinity, tagsJson, r.updatedAt, r.from, r.to);
                    updated++;
                }
            }
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    } catch (e) {
        console.error(`[global] 关系增量推送失败：${String(e?.message ?? e)}`);
        return { ...base, reason: 'write-failed', rejected, detail: String(e?.message ?? e) };
    }
    return { ok: true, inserted, updated, identical, older, conflicts, rejected, cursor };
}
