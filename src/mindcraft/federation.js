/**
 * 阶段 4 联邦串门（D5 / D9）：访问凭证、名片、关系增量、CoreProtect 汇入 events。
 *
 * 表结构在 `global_store.js`（`_global` 库的唯一拥有者），本文件只放判定与流程。
 * 全部口径、诚实边界（离线模式只能挡诚实客户端）与"未验证"清单见 `docs/audit-r6/fixes4/federation.md`。
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGlobalDb, recordEvent, exportRelationsSince, pushRelations } from './global_store.js';
import { activeKeyOf, signWithAvatarKey } from './people_store.js';
import { isValidWorldId } from './world_store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `mindcraft/src/mindcraft/` 上溯三级 = 工作区根（`server/` 与 `mindcraft/` 同级） */
const WORKSPACE_ROOT = resolve(HERE, '..', '..', '..');

/** 凭证默认有效期 10 分钟；上限 24h（够跨时区约一次，又不至于变成长期通行证）。 */
export const DEFAULT_GRANT_TTL_MS = 10 * 60_000;
export const MAX_GRANT_TTL_MS = 24 * 60 * 60_000;
/** 单张凭证最多可核销次数（一次性是 1；>1 只用于"多人同场"的显式场景）。 */
export const MAX_GRANT_USES = 32;
/** 名片格式版本（字段变了必须升版本，旧名片验不过比"偷偷解释"安全）。 */
export const CARD_VERSION = 1;
/** 名片 `seq` 单调：旧名片重放必须能拒（防"把上周的名片再放一遍"）。 */
export const MAX_PEER_ID_LEN = 64;
/** CoreProtect 库默认位置（相对工作区根；`MC_COREPROTECT_DB` 可覆盖）。 */
export const CP_RELATIVE_PATH = 'server/plugins/CoreProtect/database.db';
/** CoreProtect 导入游标在 `import_cursors` 里的 source 名。 */
export const CP_IMPORT_SOURCE = 'coreprotect';

const err = (message, code) => Object.assign(new Error(message), { code });
const nowOf = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : Date.now());
const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
const PEER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const GRANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
/** 有没有控制字符（标识会进日志与事件 payload）。 */
function hasControl(s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 32 || c === 127) return true;
    }
    return false;
}

/** 对端标识归一化：缺省 null、非法 false（调用方据此拒绝）。 */
function peerIdOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') return false;
    const s = raw.trim();
    if (!s || s.length > MAX_PEER_ID_LEN || hasControl(s)) return false;
    return PEER_ID_RE.test(s) ? s : false;
}

/** 规范 JSON（键排序、跳过 undefined）：签名必须对**同一串字节**验，不能依赖对象键序。 */
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function withGlobal(fn) {
    try {
        return fn(openGlobalDb().db);
    } catch (e) {
        console.error(`[federation] 全局库不可用：${String(e?.message ?? e)}`);
        return { ok: false, reason: 'db-unavailable', detail: String(e?.message ?? e) };
    }
}

/** 审计事件（旁路：写不进去只影响日志，不影响判定）。 */
function audit(kind, payload, ctx = {}) {
    const r = recordEvent(kind, payload, ctx);
    if (!r.ok) console.error(`[federation] 审计事件未落库 kind=${kind} reason=${r.reason}`);
    return r;
}

// ───────────────────────────────────────────────────────────────────────────
// ① 访问白名单（凭证核销只认名单内的 guest）
// ───────────────────────────────────────────────────────────────────────────

/** 加白名单（幂等：重复加返回 added=false）。 */
export function allowPeer(peerId, opts = {}) {
    const id = peerIdOf(peerId);
    if (!id) return { ok: false, reason: 'peer-id-invalid' };
    return withGlobal((db) => {
        const r = db.prepare('INSERT OR IGNORE INTO peer_allowlist(peer_id, added_at, note) VALUES(?,?,?)')
            .run(id, nowOf(opts.now), opts.note == null ? null : String(opts.note).slice(0, 200));
        if (Number(r?.changes ?? 0) === 0) return { ok: true, peerId: id, added: false };
        audit('federation.peer', { action: 'allow', peerId: id }, { sourceIp: opts.sourceIp });
        return { ok: true, peerId: id, added: true };
    });
}

/** 移出白名单（幂等：不在名单里也返回 ok, removed=false）。 */
export function revokePeer(peerId, opts = {}) {
    const id = peerIdOf(peerId);
    if (!id) return { ok: false, reason: 'peer-id-invalid' };
    return withGlobal((db) => {
        const r = db.prepare('DELETE FROM peer_allowlist WHERE peer_id = ?').run(id);
        if (Number(r?.changes ?? 0) === 0) return { ok: true, peerId: id, removed: false };
        audit('federation.peer', { action: 'unallow', peerId: id }, { sourceIp: opts.sourceIp });
        return { ok: true, peerId: id, removed: true };
    });
}

/** 在不在白名单（名单为空 = 谁都不许，不做"没配置就放行"的兜底）。 */
export function isPeerAllowed(peerId) {
    const id = peerIdOf(peerId);
    if (!id) return false;
    try {
        return Boolean(openGlobalDb().db.prepare('SELECT 1 AS x FROM peer_allowlist WHERE peer_id = ?').get(id));
    } catch {
        return false;
    }
}

/** 列白名单。 */
export function listAllowedPeers(opts = {}) {
    try {
        return openGlobalDb().db.prepare('SELECT peer_id AS peerId, added_at AS addedAt, note FROM peer_allowlist ORDER BY added_at ASC')
            .all().map((r) => ({ peerId: String(r.peerId), addedAt: Number(r.addedAt), note: r.note ?? null }));
    } catch {
        return [];
    }
}

// ───────────────────────────────────────────────────────────────────────────
// ② 访问凭证（主机发、客机核）：一次性 token + 过期 + 白名单
// ───────────────────────────────────────────────────────────────────────────

/**
 * 签发访问凭证。**幂等**：同一个 `grantId` 再签一次不会产生第二行，也不会重新吐 token
 * （token 明文只在首次签发回执里出现一次，与恢复码同一口径 —— 它不可能再被"取回来"）。
 */
export function issueVisitGrant(input = {}, opts = {}) {
    const hostId = peerIdOf(input.hostId);
    const guestId = peerIdOf(input.guestId);
    if (!hostId) return { ok: false, reason: 'host-id-invalid' };
    if (!guestId) return { ok: false, reason: 'guest-id-invalid' };
    const now = nowOf(opts.now ?? input.now);
    const ttlMs = input.ttlMs === undefined ? DEFAULT_GRANT_TTL_MS : Number(input.ttlMs);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_GRANT_TTL_MS) return { ok: false, reason: 'ttl-invalid', ttlMs };
    const maxUses = input.maxUses === undefined ? 1 : Number(input.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_GRANT_USES) return { ok: false, reason: 'max-uses-invalid', maxUses };
    const grantId = input.grantId === undefined ? `vg-${now.toString(36)}-${randomBytes(5).toString('hex')}` : input.grantId;
    if (typeof grantId !== 'string' || !GRANT_ID_RE.test(grantId)) return { ok: false, reason: 'grant-id-invalid' };
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + Math.trunc(ttlMs);
    return withGlobal((db) => {
        const r = db.prepare(
            `INSERT OR IGNORE INTO visit_grants(grant_id, host_id, guest_id, token_sha256, issued_at, expires_at, max_uses, used_count, note)
             VALUES(?,?,?,?,?,?,?,0,?)`,
        ).run(grantId, hostId, guestId, sha256hex(token), now, expiresAt, maxUses, input.note == null ? null : String(input.note).slice(0, 200));
        if (Number(r?.changes ?? 0) === 0) {
            const cur = db.prepare('SELECT * FROM visit_grants WHERE grant_id = ?').get(grantId);
            if (!cur) return { ok: false, reason: 'write-failed', grantId };
            if (String(cur.host_id) !== hostId || String(cur.guest_id) !== guestId) {
                return { ok: false, reason: 'grant-id-taken', grantId };
            }
            return {
                ok: true, grantId, token: null, idempotent: true,
                expiresAt: Number(cur.expires_at), maxUses: Number(cur.max_uses), usedCount: Number(cur.used_count),
            };
        }
        audit('federation.grant', { action: 'issue', grantId, hostId, guestId, expiresAt, maxUses }, { sourceIp: opts.sourceIp });
        return { ok: true, grantId, token, idempotent: false, expiresAt, maxUses };
    });
}

/** 把"为什么核销不了"说清楚（顺序即优先级）；**没问题返回 null**；不写库，供 redeem 的失败分支复用。 */
function diagnoseGrant(cur, tokenSha, now) {
    if (!cur) return 'unknown-grant';
    if (cur.revoked_at !== null && cur.revoked_at !== undefined) return 'revoked';
    if (Number(cur.expires_at) < now) return 'expired';
    if (String(cur.token_sha256) !== tokenSha) return 'bad-token';
    if (Number(cur.used_count) >= Number(cur.max_uses)) return 'already-used';
    return null;
}

/**
 * 核销访问凭证。**重放必须失败**：靠 `UPDATE ... WHERE used_count < max_uses` 的 `changes` 判定，
 * 不做"先查再写"（两个进程同时核销同一张一次性凭证时，先查再写会双花）。
 */
export function redeemVisitGrant(input = {}, opts = {}) {
    const grantId = input.grantId;
    if (typeof grantId !== 'string' || !GRANT_ID_RE.test(grantId)) return { ok: false, reason: 'grant-id-invalid' };
    const token = typeof input.token === 'string' ? input.token : '';
    const now = nowOf(opts.now ?? input.now);
    return withGlobal((db) => {
        const cur = db.prepare('SELECT * FROM visit_grants WHERE grant_id = ?').get(grantId);
        if (!cur) {
            audit('federation.grant', { action: 'reject', grantId, reason: 'unknown-grant' }, { sourceIp: opts.sourceIp });
            return { ok: false, reason: 'unknown-grant' };
        }
        const boundGuest = String(cur.guest_id);
        const claimedGuest = peerIdOf(input.guestId);
        if (claimedGuest === false) return { ok: false, reason: 'guest-id-invalid' };
        if (claimedGuest && claimedGuest !== boundGuest) {
            audit('federation.grant', { action: 'reject', grantId, reason: 'guest-mismatch', guestId: claimedGuest }, { sourceIp: opts.sourceIp });
            return { ok: false, reason: 'guest-mismatch', guestId: claimedGuest };
        }
        // 白名单先于 token：名单外的访客连"猜 token"的资格都不给（也让拒绝原因可解释）。
        if (!isPeerAllowed(boundGuest)) {
            audit('federation.grant', { action: 'reject', grantId, reason: 'not-allowlisted', guestId: boundGuest }, { sourceIp: opts.sourceIp });
            return { ok: false, reason: 'not-allowlisted', guestId: boundGuest };
        }
        const tokenSha = sha256hex(token);
        const reason = diagnoseGrant(cur, tokenSha, now);
        if (reason) {
            // 失败不烧码（bad-token 不该让合法持票人作废），只留审计。
            audit('federation.grant', { action: 'reject', grantId, reason, guestId: boundGuest }, { sourceIp: opts.sourceIp });
            return { ok: false, reason, guestId: boundGuest };
        }
        const r = db.prepare(
            `UPDATE visit_grants SET used_count = used_count + 1, used_at = ?
             WHERE grant_id = ? AND token_sha256 = ? AND revoked_at IS NULL
               AND expires_at >= ? AND used_count < max_uses`,
        ).run(now, grantId, tokenSha, now);
        if (Number(r?.changes ?? 0) !== 1) {
            // 到了这里说明在"诊断"与"写"之间被别的进程抢先核销/撤销 → 按最新状态回答。
            const fresh = db.prepare('SELECT * FROM visit_grants WHERE grant_id = ?').get(grantId);
            return { ok: false, reason: diagnoseGrant(fresh, tokenSha, now) ?? 'lost-race' };
        }
        const usedCount = Number(cur.used_count) + 1;
        const maxUses = Number(cur.max_uses);
        audit('federation.grant', { action: 'redeem', grantId, guestId: boundGuest, usedCount, maxUses }, { sourceIp: opts.sourceIp });
        return { ok: true, grantId, guestId: boundGuest, usedCount, maxUses, usesLeft: maxUses - usedCount };
    });
}

/** 作废凭证（幂等：重复作废返回 alreadyRevoked=true，只有第一次写 revoked_at）。 */
export function revokeVisitGrant(grantId, opts = {}) {
    if (typeof grantId !== 'string' || !GRANT_ID_RE.test(grantId)) return { ok: false, reason: 'grant-id-invalid' };
    const now = nowOf(opts.now);
    return withGlobal((db) => {
        const r = db.prepare('UPDATE visit_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now, grantId);
        if (Number(r?.changes ?? 0) === 1) {
            audit('federation.grant', { action: 'revoke', grantId }, { sourceIp: opts.sourceIp });
            return { ok: true, grantId, alreadyRevoked: false };
        }
        const cur = db.prepare('SELECT grant_id AS id FROM visit_grants WHERE grant_id = ?').get(grantId);
        if (!cur) return { ok: false, reason: 'unknown-grant' };
        return { ok: true, grantId, alreadyRevoked: true };
    });
}

/** 预览凭证（**不返回 token / 也不返回 hash**：hash 虽不可逆，但没有理由扩散）。 */
export function previewVisitGrants(opts = {}) {
    const where = [];
    const args = [];
    if (opts.hostId) { where.push('host_id = ?'); args.push(String(opts.hostId)); }
    if (opts.guestId) { where.push('guest_id = ?'); args.push(String(opts.guestId)); }
    const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(500, Math.trunc(Number(opts.limit)))) : 100;
    try {
        const rows = openGlobalDb().db.prepare(
            `SELECT grant_id, host_id, guest_id, issued_at, expires_at, max_uses, used_count, used_at, revoked_at, note
             FROM visit_grants${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY issued_at DESC LIMIT ?`,
        ).all(...args, limit);
        return rows.map((r) => ({
            grantId: String(r.grant_id), hostId: String(r.host_id), guestId: String(r.guest_id),
            issuedAt: Number(r.issued_at), expiresAt: Number(r.expires_at),
            maxUses: Number(r.max_uses), usedCount: Number(r.used_count),
            usedAt: r.used_at == null ? null : Number(r.used_at), revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
            note: r.note ?? null,
        }));
    } catch {
        return [];
    }
}

// ───────────────────────────────────────────────────────────────────────────
// ③ 名片（Ed25519，与 people_store 同一套 PEM / `verify(null, msg, key, sig)` 口径）
// ───────────────────────────────────────────────────────────────────────────

/** 名片参与签名的字段（`sig` 不在内；顺序按 `canonicalJson` 排序，不依赖键序）。 */
function cardBody(fields) {
    return {
        v: CARD_VERSION,
        peerId: fields.peerId,
        pubkey: fields.pubkey,
        addr: fields.addr ?? null,
        caps: fields.caps ?? [],
        seq: fields.seq,
        at: fields.at,
    };
}

function checkCardInput(input) {
    const peerId = peerIdOf(input?.peerId);
    if (!peerId) return { reason: 'peer-id-invalid' };
    const seq = Number(input.seq);
    if (!Number.isInteger(seq) || seq < 1) return { reason: 'seq-invalid' };
    const at = Number(input.at);
    if (!Number.isFinite(at) || at <= 0) return { reason: 'at-invalid' };
    const caps = input.caps === undefined ? [] : input.caps;
    if (!Array.isArray(caps) || caps.length > 16 || caps.some((c) => typeof c !== 'string' || !c || c.length > 32)) {
        return { reason: 'caps-invalid' };
    }
    const addr = input.addr === undefined || input.addr === null ? null : String(input.addr);
    if (addr !== null && (addr.length > 128 || hasControl(addr))) return { reason: 'addr-invalid' };
    return { peerId, seq, at: Math.trunc(at), caps, addr };
}

/** 用给定私钥（PKCS8 PEM）签一张名片。密钥可放 opts 或 input；也认 people_store 的 `{pub, priv}` 命名。 */
export function signPeerCard(input = {}, opts = {}) {
    const checked = checkCardInput(input);
    if (checked.reason) return { ok: false, reason: checked.reason };
    const pubkey = [opts.pubkey, opts.pub, input.pubkey].find((v) => typeof v === 'string');
    const privateKeyPem = [opts.privateKeyPem, opts.priv, input.privateKeyPem].find((v) => typeof v === 'string');
    if (typeof pubkey !== 'string' || !pubkey.includes('BEGIN PUBLIC KEY')) return { ok: false, reason: 'pubkey-invalid' };
    if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('BEGIN PRIVATE KEY')) return { ok: false, reason: 'private-key-invalid' };
    try {
        const body = cardBody({ ...checked, pubkey });
        const sig = sign(null, Buffer.from(canonicalJson(body)), createPrivateKey(privateKeyPem)).toString('base64');
        return { ok: true, card: { ...body, sig } };
    } catch (e) {
        return { ok: false, reason: 'sign-failed', detail: String(e?.message ?? e) };
    }
}

/** 用本机 people_store 里某 avatar 的**生效钥匙**签名片（生产侧私钥不离开所属机器）。 */
export function signPeerCardWithAvatar(store, avatarId, input = {}) {
    const key = activeKeyOf(store, avatarId);
    if (!key) return { ok: false, reason: 'no-active-key' };
    const checked = checkCardInput(input);
    if (checked.reason) return { ok: false, reason: checked.reason };
    const body = cardBody({ ...checked, pubkey: key.pub });
    const signed = signWithAvatarKey(store, avatarId, canonicalJson(body));
    if (!signed.ok) return { ok: false, reason: signed.reason ?? 'sign-failed' };
    return { ok: true, card: { ...body, sig: Buffer.from(signed.signature).toString('base64') } };
}

/** 结构校验 + 验签 + 公钥固定（TOFU）+ seq 单调；任何一条不过都**说清原因**。 */
export function verifyPeerCard(card, opts = {}) {
    if (!card || typeof card !== 'object') return { ok: false, reason: 'card-invalid', detail: '不是对象' };
    if (Number(card.v) !== CARD_VERSION) return { ok: false, reason: 'card-version-unsupported', v: card.v };
    const checked = checkCardInput(card);
    if (checked.reason) return { ok: false, reason: checked.reason };
    if (typeof card.pubkey !== 'string' || typeof card.sig !== 'string') {
        return { ok: false, reason: 'card-invalid', detail: '缺 pubkey/sig' };
    }
    let pub;
    try {
        pub = createPublicKey(card.pubkey);
    } catch (e) {
        return { ok: false, reason: 'pubkey-invalid', detail: String(e?.message ?? e) };
    }
    const body = cardBody({ ...checked, pubkey: card.pubkey });
    let good = false;
    try {
        good = verify(null, Buffer.from(canonicalJson(body)), pub, Buffer.from(card.sig, 'base64'));
    } catch (e) {
        return { ok: false, reason: 'bad-signature', detail: String(e?.message ?? e) };
    }
    if (!good) return { ok: false, reason: 'bad-signature' };
    // 公钥固定：见过的对端换 key 必须人工确认（`forgetPeer` 再重见），否则一律当冒充。
    const pinned = knownPeerRow(checked.peerId);
    if (pinned) {
        if (String(pinned.pubkey) !== card.pubkey) return { ok: false, reason: 'pubkey-mismatch', peerId: checked.peerId };
        if (Number(card.seq) <= Number(pinned.cardSeq)) {
            return { ok: false, reason: 'stale-card', peerId: checked.peerId, seq: Number(card.seq), knownSeq: Number(pinned.cardSeq) };
        }
    } else if (opts.requirePin === true) {
        return { ok: false, reason: 'unknown-peer', peerId: checked.peerId };
    }
    return { ok: true, peerId: checked.peerId, seq: checked.seq, at: checked.at, addr: checked.addr, caps: checked.caps };
}

/** 收名片：验过才落 `known_peers`（首次见面钉公钥）；验不过也留审计（谁在冒充、被什么挡住）。 */
export function acceptPeerCard(card, opts = {}) {
    const verdict = verifyPeerCard(card, opts);
    const peerId = card && typeof card.peerId === 'string' ? card.peerId : null;
    if (!verdict.ok) {
        if (peerId) {
            audit('federation.peer', { action: 'card-reject', peerId, reason: verdict.reason, seq: Number(card?.seq) || null }, { sourceIp: opts.sourceIp });
        }
        return { ...verdict, recorded: Boolean(peerId) };
    }
    const now = nowOf(opts.now);
    return withGlobal((db) => {
        const cur = db.prepare('SELECT first_seen FROM known_peers WHERE peer_id = ?').get(verdict.peerId);
        if (cur) {
            db.prepare(
                'UPDATE known_peers SET pubkey=?, last_addr=?, last_seen=?, card_seq=?, card_json=? WHERE peer_id=?',
            ).run(card.pubkey, verdict.addr, now, verdict.seq, JSON.stringify(card), verdict.peerId);
        } else {
            db.prepare(
                'INSERT INTO known_peers(peer_id,pubkey,last_addr,first_seen,last_seen,card_seq,card_json) VALUES(?,?,?,?,?,?,?)',
            ).run(verdict.peerId, card.pubkey, verdict.addr, now, now, verdict.seq, JSON.stringify(card));
        }
        audit('federation.peer', { action: 'card-accept', peerId: verdict.peerId, seq: verdict.seq, addr: verdict.addr }, { sourceIp: opts.sourceIp });
        return {
            ok: true, peerId: verdict.peerId, seq: verdict.seq,
            firstSeen: cur ? Number(cur.first_seen) : now, lastSeen: now, newPeer: !cur,
        };
    });
}

/** 取本机记着的对端（公钥、最近地址、首末见面）。 */
export function knownPeerRow(peerId) {
    const id = peerIdOf(peerId);
    if (!id) return null;
    try {
        const r = openGlobalDb().db.prepare('SELECT * FROM known_peers WHERE peer_id = ?').get(id);
        if (!r) return null;
        return {
            peerId: String(r.peer_id), pubkey: String(r.pubkey), lastAddr: r.last_addr ?? null,
            firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen),
            cardSeq: Number(r.card_seq), card: r.card_json ? safeJson(r.card_json) : null,
        };
    } catch {
        return null;
    }
}

function safeJson(text) {
    try { return JSON.parse(String(text)); } catch { return null; }
}

/** 列对端。 */
export function listKnownPeers(opts = {}) {
    const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(500, Math.trunc(Number(opts.limit)))) : 100;
    try {
        return openGlobalDb().db.prepare(
            `SELECT peer_id, last_addr, first_seen, last_seen, card_seq FROM known_peers ORDER BY last_seen DESC LIMIT ?`,
        ).all(limit).map((r) => ({
            peerId: String(r.peer_id), lastAddr: r.last_addr ?? null,
            firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), cardSeq: Number(r.card_seq),
        }));
    } catch {
        return [];
    }
}

/** 忘记对端（**换钥的唯一合法途径**：必须有人显式调它，不能由名片自己"换"）。 */
export function forgetPeer(peerId) {
    const id = peerIdOf(peerId);
    if (!id) return { ok: false, reason: 'peer-id-invalid' };
    return withGlobal((db) => {
        const r = db.prepare('DELETE FROM known_peers WHERE peer_id = ?').run(id);
        return { ok: true, peerId: id, removed: Number(r?.changes ?? 0) === 1 };
    });
}

// ───────────────────────────────────────────────────────────────────────────
// ④ 关系增量同步（幂等：同一批推两次结果一致）
// ───────────────────────────────────────────────────────────────────────────

/** 拉增量（按 `updated_at >= since`，宁重不漏；对端重复推同一批不会长出新行）。 */
export function exportRelationDelta(opts = {}) {
    const out = exportRelationsSince(opts.since ?? 0, { limit: opts.limit });
    if (opts.sourcePeerId) {
        audit('federation.relations', {
            action: 'export', sourcePeerId: String(opts.sourcePeerId), rows: out.rows.length, cursor: out.cursor,
        });
    }
    return out;
}

/** 推增量（接收端调用）。返回逐项计数，并留一条审计事件（冲突也算"发生过"）。 */
export function pushRelationDelta(rows, opts = {}) {
    const res = pushRelations(rows, {});
    if (res.ok && res.inserted + res.updated + res.conflicts > 0) {
        audit('federation.relations', {
            action: 'push', sourcePeerId: opts.sourcePeerId ?? null,
            pushed: Array.isArray(rows) ? rows.length : 0,
            inserted: res.inserted, updated: res.updated, older: res.older, conflicts: res.conflicts, identical: res.identical,
        }, { sourceIp: opts.sourceIp });
    }
    return res;
}

// ───────────────────────────────────────────────────────────────────────────
// ⑤ CoreProtect 日志汇入 events（只读导入；找不到库就明说"未安装"）
// ───────────────────────────────────────────────────────────────────────────

/** CoreProtect 库路径（`MC_COREPROTECT_DB` 优先，否则 `<工作区>/server/plugins/CoreProtect/database.db`）。 */
export function coreProtectDbPath() {
    const env = process.env.MC_COREPROTECT_DB;
    if (typeof env === 'string' && env.trim()) return resolve(env.trim());
    return join(WORKSPACE_ROOT, CP_RELATIVE_PATH);
}

/**
 * 体检：未安装 / 打开失败 / 表不认识 / 正常，四态可区分。
 * **绝不"看起来成功"**：库里没有 `co_block`（CP 22.x）或 `co_blocks`（旧版）就不算装好。
 */
export function coreProtectStatus(opts = {}) {
    const path = opts.dbPath ? resolve(String(opts.dbPath)) : coreProtectDbPath();
    if (!existsSync(path)) {
        return { installed: false, status: 'not-installed', path, tables: [], table: null, detail: '库文件不存在：CoreProtect 未安装或未启用' };
    }
    let db = null;
    try {
        db = new DatabaseSync(path, { readOnly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => String(r.name));
        const table = CP_TABLES.find((t) => tables.includes(t)) ?? null;
        if (!table) {
            return { installed: false, status: 'unrecognized-schema', path, tables, table, detail: '没有 co_block / co_blocks 表：不是 CoreProtect 库' };
        }
        const rows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
        return { installed: true, status: 'installed', path, tables, table, rows };
    } catch (e) {
        return { installed: false, status: 'open-failed', path, tables: [], table: null, detail: String(e?.message ?? e) };
    } finally {
        try { db?.close(); } catch { /* 关不掉不影响结论 */ }
    }
}

/** 导入游标（没有记录 = 0，从头导）。 */
export function importCursorOf(source = CP_IMPORT_SOURCE) {
    try {
        return Number(openGlobalDb().db.prepare('SELECT cursor FROM import_cursors WHERE source = ?').get(String(source))?.cursor ?? 0);
    } catch {
        return 0;
    }
}

/** 推进游标（**只增不减**：往回拨等于让同一段历史被导两次）。 */
export function advanceImportCursor(source, cursor, opts = {}) {
    const c = Number(cursor);
    if (!Number.isFinite(c) || c < 0) return { ok: false, reason: 'cursor-invalid' };
    const src = String(source ?? CP_IMPORT_SOURCE);
    return withGlobal((db) => {
        const prev = Number(db.prepare('SELECT cursor FROM import_cursors WHERE source = ?').get(src)?.cursor ?? 0);
        if (c <= prev) return { ok: true, source: src, from: prev, to: prev, advanced: false };
        db.prepare(
            `INSERT INTO import_cursors(source, cursor, updated_at) VALUES(?,?,?)
             ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`,
        ).run(src, Math.trunc(c), nowOf(opts.now));
        return { ok: true, source: src, from: prev, to: Math.trunc(c), advanced: true };
    });
}

/** CP 的 `time` 是 unix **秒**；>= 1e11 认为已经是毫秒（两种库都能导，不猜错方向）。 */
function cpTimeToMs(raw) {
    const t = Number(raw);
    if (!Number.isFinite(t) || t <= 0) return null;
    return t >= 1e11 ? Math.trunc(t) : Math.trunc(t * 1000);
}

const CP_ACTION = { 0: 'break', 1: 'place' };
/** CP 22.x = `co_block`（单数，实测本机 106120 行）；旧版/部分分支 = `co_blocks`。两种都认。 */
const CP_TABLES = ['co_block', 'co_blocks'];

/** 从映射表读 `id → 名字`（表不存在就返回空 Map：名字留 null，绝不猜）。 */
function loadLookup(db, table, idCol, nameCol) {
    const out = new Map();
    try {
        for (const r of db.prepare(`SELECT ${idCol} AS id, ${nameCol} AS name FROM ${table}`).all()) {
            out.set(Number(r.id), r.name == null ? null : String(r.name));
        }
    } catch { /* 没有这张映射表：保持空 */ }
    return out;
}

/**
 * 一行 co_block → 事件 payload。
 *
 * 名字（玩家/方块/方块数据/世界）**只从库里的映射表解析**；查不到就留 `null` 并保留原始数字 id。
 * 用数字 id 硬猜名字等于编数据 —— 宁可少字段，不许假字段。
 */
function mapCpRow(row, lookups = {}) {
    const rowid = Number(row.rid);
    const typeId = Number(row.type);
    const dataId = row.data == null ? null : Number(row.data);
    const widId = row.wid == null ? null : Number(row.wid);
    const userId = row.user == null ? null : Number(row.user);
    return {
        rowid,
        action: CP_ACTION[Number(row.action)] ?? 'other',
        rawAction: Number(row.action),
        userId,
        user: userId === null ? null : (lookups.users?.get(userId) ?? null),
        // ★ 不叫 `worldId`：事件本身的 `world_id` 是**我们的**存档 id（`w-…`），这里是 CP 自己的数字宽度。
        cpWorldId: widId,
        cpWorld: widId === null ? null : (lookups.worlds?.get(widId) ?? null),
        x: Number(row.x), y: Number(row.y), z: Number(row.z),
        materialId: typeId,
        block: lookups.materials?.get(typeId) ?? null,
        blockDataId: dataId,
        blockData: dataId === null ? null : (lookups.blockData?.get(dataId) ?? null),
        rolledBack: Number(row.rolled_back ?? 0) === 1,
        at: cpTimeToMs(row.time),
    };
}

/**
 * 导一批 CoreProtect 变更到 `events`（kind=`block-change`）。
 *
 * 去重是**双保险**：① `import_cursors` 游标（快）；② 事件 id 用 `cp-<rowid>`（确定性，
 * 游标被清掉/换机器重导时 `duplicate-id` 仍然挡住重复）。任一缺失都会让"导入一次"变成"每次启动都导一遍"。
 */
export function importCoreProtect(opts = {}) {
    const worldId = opts.worldId ?? null;
    if (worldId !== null && !isValidWorldId(worldId)) {
        return { ok: false, status: 'world-id-invalid', imported: 0, skipped: 0, worldId };
    }
    const status = coreProtectStatus({ dbPath: opts.dbPath });
    if (!status.installed) {
        return { ok: false, status: status.status, path: status.path, imported: 0, skipped: 0, detail: status.detail ?? null };
    }
    const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(5000, Math.trunc(Number(opts.limit)))) : 500;
    const source = opts.source ?? CP_IMPORT_SOURCE;
    // source 会进事件 id：必须能安全拼进 `cp-<source>-<rowid>`（多机/多库同号时不撞车）
    if (typeof source !== 'string' || !/^[A-Za-z0-9_.:-]{1,32}$/.test(source)) {
        return { ok: false, status: 'source-invalid', imported: 0, skipped: 0, source: opts.source ?? null };
    }
    const cursor = opts.cursor === undefined ? importCursorOf(source) : Math.max(0, Math.trunc(Number(opts.cursor) || 0));
    const table = status.table ?? CP_TABLES[0];
    let db = null;
    let rows;
    let lookups = {};
    try {
        db = new DatabaseSync(status.path, { readOnly: true });
        rows = db.prepare(
            `SELECT rowid AS rid, time, user, wid, x, y, z, type, data, action, rolled_back
             FROM ${table} WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
        ).all(cursor, limit);
        // 名字只在**真要导入时**才读（dry-run 也读，好让回执可核对；映射表都很小：实测 464/133/78/3 行）
        lookups = {
            users: loadLookup(db, 'co_user', 'id', 'user'),
            worlds: loadLookup(db, 'co_world', 'id', 'world'),
            materials: loadLookup(db, 'co_material_map', 'id', 'material'),
            blockData: loadLookup(db, 'co_blockdata_map', 'id', 'data'),
        };
    } catch (e) {
        return { ok: false, status: 'schema-mismatch', path: status.path, imported: 0, skipped: 0, detail: String(e?.message ?? e) };
    } finally {
        try { db?.close(); } catch { /* ignore */ }
    }
    const mapped = rows.map((r) => mapCpRow(r, lookups));
    const nextCursor = mapped.length ? mapped[mapped.length - 1].rowid : cursor;
    if (opts.dryRun === true) {
        return {
            ok: true, status: 'dry-run', path: status.path, cursor, nextCursor,
            imported: 0, skipped: 0, scanned: mapped.length, wouldImport: mapped.length,
            hasMore: mapped.length === limit, samples: mapped.slice(0, 3),
        };
    }
    let imported = 0;
    let skipped = 0;
    for (const m of mapped) {
        const at = m.at ?? nowOf(opts.now);
        const r = recordEvent('block-change', m, { worldId, id: `cp-${source}-${m.rowid}`, at });
        if (r.ok) { imported++; continue; }
        if (r.reason === 'duplicate-id') { skipped++; continue; }
        console.error(`[federation] CoreProtect 行 ${m.rowid} 导入失败：${r.reason}`);
        return {
            ok: false, status: 'write-failed', path: status.path, cursor, nextCursor,
            imported, skipped, scanned: mapped.length, reason: r.reason,
        };
    }
    if (nextCursor > cursor) advanceImportCursor(source, nextCursor, { now: opts.now });
    return {
        ok: true, status: 'imported', path: status.path, cursor, nextCursor,
        imported, skipped, scanned: mapped.length, hasMore: mapped.length === limit,
    };
}
