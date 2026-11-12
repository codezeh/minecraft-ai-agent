/**
 * 身份注册表（ADR 阶段 2 / D4 / D6）：`people` + `avatars` + `avatar_keys`。
 *
 * 为什么另起一份、而不是塞进 identity_store：
 *   · identity_store 是**每 agent 一份**（`bots/<name>/identity.json`），表达的是
 *     "这只 bot 认哪个玩家"；而 D4 要求的"人"是**跨存档、跨 bot** 的稳定主体。
 *   · 两者生命周期不同：人不会因为换 bot 或换存档就换 UUID。
 * 所以人放在共享目录 `bots/_identity/people.json`（阶段 3 引入 `_global` 时整体搬过去即可）。
 *
 * 与 identity_store 共用同一套并发手法：读-改-写走文件锁 + rev 乐观锁（不引第二套）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, generateKeyPairSync, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import { botsRootOf } from '../agent/library/bot_paths.js';

export const PEOPLE_VERSION = 1;
/** 人的状态：active（正常）/ revoked（被撤了邀请，仍在表里留证）。 */
export const PERSON_STATE = Object.freeze({ ACTIVE: 'active', REVOKED: 'revoked' });
/** avatar 状态：active / retired（退役，不再对应任何在线 bot）。 */
export const AVATAR_STATE = Object.freeze({ ACTIVE: 'active', RETIRED: 'retired' });

/** `bots/_identity` —— 跨 bot、跨存档的共享身份目录。 */
export function identityDirOf() {
    return `${botsRootOf()}/_identity`;
}

/** 身份注册表文件路径。 */
export function peopleFileOf() {
    return join(identityDirOf(), 'people.json');
}

/** 空表（首次使用/文件缺失时）。 */
export function emptyPeopleStore() {
    return { version: PEOPLE_VERSION, rev: 0, people: [], avatars: [], keys: [] };
}

/**
 * 读表。区分"没有"与"坏了"：
 *   · 没有 → ok:false, reason:'missing'（调用方按空表继续，等价于"还没人"）
 *   · 解析失败 → corrupt:true + backup（改名留证，后续写不覆盖证据）
 * @param {string} [file]
 */
export function readPeopleStore(file = peopleFileOf()) {
    if (!file || !existsSync(file)) return { store: emptyPeopleStore(), ok: false, reason: 'missing', corrupt: false };
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (e) {
        return { store: emptyPeopleStore(), ok: false, reason: `unreadable:${e?.code ?? e}`, corrupt: false };
    }
    try {
        const raw = JSON.parse(text);
        const store = emptyPeopleStore();
        if (Array.isArray(raw?.people)) store.people = raw.people;
        if (Array.isArray(raw?.avatars)) store.avatars = raw.avatars;
        if (Array.isArray(raw?.keys)) store.keys = raw.keys;
        store.rev = Number(raw?.rev) || 0;
        return { store, ok: true, corrupt: false };
    } catch (e) {
        // 损坏：改名留证（与 identity_store 的 #69 口径一致），再按空表返回
        const backup = `${file}.corrupt-${Date.now()}`;
        try { renameSync(file, backup); } catch { /* 改不了名也继续按空表 */ }
        console.error(`[people] 身份注册表损坏，已留证：${backup}（${e?.message ?? e}）`);
        return { store: emptyPeopleStore(), ok: false, reason: 'corrupt', corrupt: true, backup };
    }
}

/** 原子写（临时文件 + rename），并校验 rev 未被别人改过。 */
export function writePeopleStore(file, store, { expectRev = null } = {}) {
    if (!file) return { ok: false, reason: 'no-file' };
    try { mkdirSync(dirname(file), { recursive: true }); } catch { /* 写失败会报出来 */ }
    const curRev = readPeopleStore(file).store.rev ?? 0;
    if (expectRev !== null && Number(expectRev) !== curRev) return { ok: false, reason: 'conflict' };
    const next = { ...store, version: PEOPLE_VERSION, rev: curRev + 1, updated_at: new Date().toISOString() };
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
        writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, file);
        return { ok: true, store: next };
    } catch (e) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        return { ok: false, reason: String(e?.message ?? e) };
    }
}

/** 进程间文件锁（与 identity_store 同思路：lock 文件 + 过期兜底）。 */
function acquireLock(file, { staleMs = 10_000 } = {}) {
    const lock = `${file}.lock`;
    try { mkdirSync(dirname(file), { recursive: true }); } catch { /* ignore */ }
    try {
        closeSync(openSync(lock, 'wx'));
        return { ok: true, release: () => { try { unlinkSync(lock); } catch { /* ignore */ } } };
    } catch (e) {
        if (e?.code !== 'EEXIST') return { ok: false, reason: `lock:${e?.code ?? e}` };
        let age = 0;
        try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = staleMs + 1; }
        if (age > staleMs) {
            try { unlinkSync(lock); } catch { /* 别人也删了 */ }
            try {
                closeSync(openSync(lock, 'wx'));
                return { ok: true, release: () => { try { unlinkSync(lock); } catch { /* ignore */ } } };
            } catch { /* 抢不到 */ }
        }
        return { ok: false, reason: 'lock:busy' };
    }
}

/**
 * 持锁的读-改-写。mutator 返回 null ⇒ 无事可做（幂等）。
 * @param {string} [file]
 * @param {(store:object)=>({store:object,result:any}|null)} mutator
 */
export function mutatePeople(mutator, { file = peopleFileOf(), attempts = 3, now = Date.now() } = {}) {
    if (typeof mutator !== 'function') return { ok: false, reason: 'no-mutator' };
    const locked = acquireLock(file);
    if (!locked.ok) return { ok: false, reason: locked.reason };
    try {
        for (let i = 1; i <= attempts; i += 1) {
            const read = readPeopleStore(file);
            const out = mutator(read.store, { now, attempt: i });
            if (!out) return { ok: true, skipped: true, result: null };
            const wrote = writePeopleStore(file, out.store, { expectRev: read.store.rev ?? 0 });
            if (wrote.ok) return { ok: true, result: out.result ?? null, store: wrote.store, attempts: i };
            if (wrote.reason !== 'conflict') return { ok: false, reason: wrote.reason };
        }
        return { ok: false, reason: 'conflict' };
    } finally {
        locked.release();
    }
}

/** 按 uuid 或名字找人（名字匹配含别名，大小写不敏感）。 */
export function findPerson(store, { personId = null, name = null } = {}) {
    if (!store?.people?.length) return null;
    if (personId) return store.people.find((p) => p.id === personId) ?? null;
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return null;
    return store.people.find((p) => {
        if (String(p.name ?? '').toLowerCase() === key) return true;
        return (p.aliases ?? []).some((a) => String(a).toLowerCase() === key);
    }) ?? null;
}

/**
 * 建人（幂等：同名/同 uuid 已存在就返回既有的，不新建）。
 * @returns {{store:object, result:{person:object, created:boolean}}}
 */
export function ensurePerson(store, { name, now = Date.now() } = {}) {
    const clean = String(name ?? '').trim();
    if (!clean) throw new Error('ensurePerson 需要 name');
    const existing = findPerson(store, { name: clean });
    if (existing) {
        // 别名累积：同一人换了 id 仍然认得
        if (!(existing.aliases ?? []).includes(clean) && existing.name !== clean) {
            existing.aliases = [...(existing.aliases ?? []), clean];
        }
        return { store, result: { person: existing, created: false } };
    }
    const person = {
        id: randomUUID(), name: clean, aliases: [], state: PERSON_STATE.ACTIVE,
        created_at: now, revoked_at: null,
    };
    store.people = [...store.people, person];
    return { store, result: { person, created: true } };
}

/** 把某个 bot（avatar）挂到某个人名下；一只 bot 同一时刻只属于一个人。 */
export function linkAvatar(store, { avatarName, personId, now = Date.now() } = {}) {
    const name = String(avatarName ?? '').trim();
    if (!name) throw new Error('linkAvatar 需要 avatarName');
    if (!store.people.some((p) => p.id === personId)) throw new Error(`没有这个人：${personId}`);
    const held = store.avatars.find((a) => a.name === name && a.state === AVATAR_STATE.ACTIVE);
    if (held && held.person_id !== personId) {
        return { store, result: { ok: false, reason: 'avatar-taken', by: held.person_id } };
    }
    if (held) return { store, result: { ok: true, avatar: held, created: false } };
    const avatar = { id: randomUUID(), name, person_id: personId, state: AVATAR_STATE.ACTIVE, created_at: now, retired_at: null };
    store.avatars = [...store.avatars, avatar];
    return { store, result: { ok: true, avatar, created: true } };
}

/** 退役一只 avatar（保留记录，便于"这个分身是谁的"可追溯）。 */
export function retireAvatar(store, { avatarName, now = Date.now() } = {}) {
    const name = String(avatarName ?? '').trim();
    let changed = 0;
    for (const a of store.avatars) {
        if (a.name === name && a.state === AVATAR_STATE.ACTIVE) {
            a.state = AVATAR_STATE.RETIRED;
            a.retired_at = now;
            changed += 1;
        }
    }
    return { store, result: { retired: changed } };
}

/** 生成一对 Ed25519 密钥（D4：身份 = 稳定 UUID + 可轮换密钥）。 */
export function generateAvatarKey(rand = null) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
        pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
}

/** 给 avatar 装一把新钥匙（旧钥匙挪进 rotated 列表，便于验旧签名/审计）。 */
export function issueAvatarKey(store, { avatarId, now = Date.now() } = {}) {
    if (!store.avatars.some((a) => a.id === avatarId)) throw new Error(`没有这个 avatar：${avatarId}`);
    const pair = generateAvatarKey();
    const prev = store.keys.filter((k) => k.avatar_id === avatarId && k.state === 'active');
    for (const k of prev) { k.state = 'rotated'; k.rotated_at = now; }
    const rec = {
        avatar_id: avatarId, pub: pair.pub, priv: pair.priv,
        state: 'active', created_at: now, rotated_at: null,
    };
    store.keys = [...store.keys, rec];
    return { store, result: { key: rec, rotated: prev.length } };
}

/** 取某 avatar 当前生效的钥匙。 */
export function activeKeyOf(store, avatarId) {
    return (store.keys ?? []).find((k) => k.avatar_id === avatarId && k.state === 'active') ?? null;
}

/** 验签（用 avatar 当前生效的公钥）。 */
export function verifyAvatarSignature(store, avatarId, message, signature) {
    const k = activeKeyOf(store, avatarId);
    if (!k) return { ok: false, reason: 'no-active-key' };
    try {
        const pub = createPublicKey(k.pub);
        const ok = verify(null, Buffer.from(message), pub, Buffer.from(signature));
        return { ok, reason: ok ? null : 'bad-signature' };
    } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
    }
}

/** 用私钥签名（主要给测试与"本地自证"用；生产侧私钥应留在所属机器）。 */
export function signWithAvatarKey(store, avatarId, message) {
    const k = activeKeyOf(store, avatarId);
    if (!k) return { ok: false, reason: 'no-active-key' };
    try {
        const priv = createPrivateKey(k.priv);
        return { ok: true, signature: sign(null, Buffer.from(message), priv) };
    } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
    }
}

/** 面板/命令用的一览（不含私钥）。 */
export function previewPeople(store) {
    const people = (store.people ?? []).map((p) => ({
        id: p.id, name: p.name, aliases: [...(p.aliases ?? [])], state: p.state,
        avatars: (store.avatars ?? []).filter((a) => a.person_id === p.id && a.state === AVATAR_STATE.ACTIVE).map((a) => a.name),
    }));
    return { people, total: people.length };
}
