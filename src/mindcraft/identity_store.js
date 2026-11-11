/**
 * 玩家身份绑定（第四轮审计 ①，方案 C）—— **纯逻辑 + 两次读写盘**，不碰 socket / express。
 *
 * 缺陷原貌：`permissions.js` 的等级只由**游戏名字符串**与 profile 名单比对，
 * 而离线服务器（`online-mode=false`）根本不校验"你是不是真的叫这个名字" ⇒
 * 改个客户端名就是 owner。控制面的 token 认证也**完全不传导**到游戏内权限。
 *
 * 现在：面板（已过 token 门）下发**一次性绑定码**；玩家在游戏里 `!claim <码>`；
 * 码核销后写 `bots/<agent>/identity.json`，之后按 **uuid 优先、名字其次** 定级。
 * 名字只在"没启用绑定"（或显式打开兼容回退）时才有意义。
 *
 * 为什么是这个文件（而不是塞进 mindserver.js）：**两个进程都要用它**
 *  —— 面板侧签发/吊销码（mindserver，父进程）、游戏侧核销/定级（agent，子进程）。
 * 所以它必须是**零业务依赖**的（只有 node 内置 + bot_paths 的目录真相），
 * 否则 agent 侧 import 会经 mindserver 把 express/socket.io 拖进来。
 *
 * 诚实边界：
 *   · 码文件（identity-codes.json）落在本机磁盘上 ⇒ **能读文件的人能冒充**。
 *     本层解决的是"改游戏名冒充"，不是"本机提权"（后者见 OPS-003 / F-RT-001）。
 *   · 绑定默认有效期 30 天，过期即自动降级为 guest（fail-closed）。
 */
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { botDirOf } from '../agent/library/bot_paths.js';

/**
 * ★ 注意：`botDirOf` 的入参是 **agent/bot 对象**（它自己取 `.bot.username`）。
 * 直接传字符串会落到兜底名 `'agent'` ⇒ 所有 agent 共用一份身份表（严重串号）。
 * 所以这里统一包一层 `{ username }`。
 */
function dirOfAgentName(agentName) {
    return botDirOf({ username: String(agentName ?? 'agent') });
}

export const IDENTITY_VERSION = 1;

/** 绑定码有效期上限（任务要求 ≤5 分钟）。 */
export const DEFAULT_CODE_TTL_MS = 5 * 60_000;

/** 绑定本身的有效期：默认 30 天，过期自动降级。 */
export const DEFAULT_BINDING_TTL_MS = 30 * 24 * 60 * 60_000;

/** 同时挂着的未核销码上限（防止面板被连点刷出无数码）。 */
export const MAX_PENDING_CODES = 8;

/** 绑定等级：绑定成功即主人（面板持有人 = 主人，这是本机制的全部意义）。 */
export const BOUND_LEVEL = 'owner';

/**
 * ★★★ R4 t20：**离线模式下 uuid 是名字派生出来的** —— 这条不修，"绑定"就是纸糊的。
 *
 * 现场证据（`node_modules/minecraft-protocol/src/datatypes/uuid.js:15`）：
 *   `nameToMcOfflineUUID(name) = javaUUID('OfflinePlayer:' + name)`
 * 而本项目 `server.properties` 是 `online-mode=false` ⇒ 服务端给谁什么 uuid，**只看名字**：
 *
 *   HEAVENZEH -> 3f680b9f-53a9-34c1-900a-6ba8f0262175
 *   Impostor  -> 18cca982-c228-3975-9cb1-45bcfa87adc5
 *
 * 于是 t13 的链路在离线服上有洞：
 *   ① 主人 `!claim <码>` → 绑定 `{uuid: 3f680b9f…, name:'HEAVENZEH', level:'owner'}`；
 *   ② 冒名者把客户端名改成 `HEAVENZEH` → 服务端发**同一个** uuid；
 *   ③ `resolveBinding` 按 uuid **精确命中** → 直接 owner。
 * 注意：这不是"名字回退"那条路（那条只认无 uuid 的绑定），所以 t13 里那条防护在这里不起作用。
 *
 * 结论（必须诚实写进文档与告警）：**离线服 + 无登录插件时，任何"按身份授权"都只能防君子**。
 * 本文件能做的只有两件事：
 *   · 把这类绑定**标记成 `weak`**（可被同名冒用）；
 *   · 让 weak 绑定**不再持久授 owner**（`offline_owner_mode`：**`session` 默认**，限时会话 / `deny` 永不授 owner）。
 * 根治只有两条（都是部署决策，不在代码里自动做）：开正版验证，或装登录插件（AuthMe 等）。
 */
export function offlineUuidOf(name) {
    const raw = String(name ?? '');
    const buf = createHash('md5').update(`OfflinePlayer:${raw}`, 'utf8').digest();
    buf[6] = (buf[6] & 0x0f) | 0x30;      // version 3
    buf[8] = (buf[8] & 0x3f) | 0x80;      // RFC 4122 variant
    const hex = buf.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** uuid 规范化：去掉连字符/花括号、转小写（容忍 32 位与 36 位两种写法）。 */
function normalizeUuid(value) {
    return String(value ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

/**
 * 这个 uuid 是不是**由这个名字派生**出来的（= 离线服发的那个）。
 *
 * @param {string|null} uuid 服务端给的 uuid
 * @param {string|null} name 玩家名
 * @returns {boolean}
 */
export function isOfflineDerivedUuid(uuid, name) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) return false;
    const a = normalizeUuid(uuid);
    if (!a) return false;
    return a === normalizeUuid(offlineUuidOf(n));
}

/**
 * 一条绑定是不是"弱绑定"（可被同名冒用）。
 *
 * 判据两条取或：绑定上已标记的 `weak`，或**现在就重算一遍**（老数据没有 weak 字段）。
 * 重算比读标记可靠：uuid/name 任何一方被改过，重算立刻能发现。
 *
 * @param {{uuid?:string|null, name?:string|null, weak?:boolean}} binding
 * @returns {boolean}
 */
export function isWeakBinding(binding) {
    if (!binding) return false;
    if (binding.weak === true) return true;
    if (!binding.uuid) return true;        // 没有 uuid ⇒ 只按名字 ⇒ 天然可冒用
    return isOfflineDerivedUuid(binding.uuid, binding.name);
}

// ── session 模式的内存态（**不落盘**：重启即失效，这正是"会话"的含义）──────
/** key -> 最近一次核销成功的时刻。 */
const SESSION_CLAIMS = new Map();

function sessionKeyOf({ uuid = null, name = null } = {}) {
    const u = normalizeUuid(uuid);
    if (u) return `u:${u}`;
    const n = typeof name === 'string' && name.trim() ? name.trim() : '';
    return n ? `n:${n}` : null;
}

/**
 * 记一次"刚刚核销过码"（`!claim` 成功后调用）。**只写内存**。
 * @param {{uuid?:string|null, name?:string|null, now?:number}} p
 * @returns {boolean}
 */
export function recordClaim({ uuid = null, name = null, now = Date.now() } = {}) {
    const key = sessionKeyOf({ uuid, name });
    if (!key) return false;
    SESSION_CLAIMS.set(key, now);
    return true;
}

/**
 * session 模式判据：这个人是不是**最近 windowMs 内刚核销过码**。
 *
 * 语义边界：这只表示"刚才那一下是拿着面板发的码做的"，
 * **不担保之后说话的还是同一个人**（离线服上他随时可以退出去换个同名客户端进来）。
 * 所以它是"降低暴露窗口"，不是"证明身份"。
 *
 * @param {{uuid?:string|null, name?:string|null, now?:number, windowMs?:number}} p
 * @returns {boolean}
 */
export function sessionFresh({ uuid = null, name = null, now = Date.now(), windowMs = 60 * 60_000 } = {}) {
    const key = sessionKeyOf({ uuid, name });
    if (!key) return false;
    const at = SESSION_CLAIMS.get(key);
    if (!Number.isFinite(at)) return false;
    const win = Number(windowMs);
    if (!Number.isFinite(win) || win <= 0) return false;
    return now - at <= win;
}

/** 清空会话态（单测用；也用于"面板解绑后立刻失效"）。 */
export function resetSessionClaims() {
    SESSION_CLAIMS.clear();
}

/** 让某一个人的会话态立刻失效（解绑时调用）。 */
export function forgetClaim({ uuid = null, name = null } = {}) {
    const key = sessionKeyOf({ uuid, name });
    if (!key) return false;
    return SESSION_CLAIMS.delete(key);
}

/** 绑定表文件（agent 子进程写，面板读/吊销）。 */
export function identityFileOf(agentName) {
    return path.join(dirOfAgentName(agentName), 'identity.json');
}

/** 待核销绑定码文件（mindserver 写，agent 读并核销）。 */
export function codesFileOf(agentName) {
    return path.join(dirOfAgentName(agentName), 'identity-codes.json');
}

/** 空表。 */
export function emptyStore() {
    // rev：单调版本号（R6 #21 的乐观锁判据；readStore 读出来、writeStore 校验后再 +1）
    return { version: IDENTITY_VERSION, bindings: [], codes: [], rev: 0 };
}

/**
 * 规范化玩家输入的码：大写、去掉空格与连字符（`abcd-efgh` / `abcd efgh` 都认）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCode(value) {
    return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * 生成一个绑定码：`XXXX-XXXX`，字母表去掉了 0/O/1/I/L 这类易混字符。
 * @param {Function} [rand] 注入随机源（用例可给确定性实现）
 * @returns {string}
 */
export function makeCode(rand = randomBytes) {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const buf = rand(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += alphabet[buf[i] % alphabet.length];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 把磁盘上的 JSON 收成已知形状；坏数据一律当空表（不抛、不半信半疑）。 */
function sanitizeStore(raw) {
    const base = emptyStore();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
    base.rev = Number(raw.rev) || 0;
    const bindings = Array.isArray(raw.bindings) ? raw.bindings : [];
    const codes = Array.isArray(raw.codes) ? raw.codes : [];
    base.bindings = bindings.filter((b) => b && typeof b === 'object' && typeof b.level === 'string')
        .map((b) => ({
            uuid: typeof b.uuid === 'string' ? b.uuid : null,
            name: typeof b.name === 'string' ? b.name : null,
            level: String(b.level),
            boundAt: Number(b.boundAt) || 0,
            expiresAt: Number(b.expiresAt) || 0,
            sessionId: typeof b.sessionId === 'string' ? b.sessionId : null,
            // ★ t20：弱绑定标记要能存下来（老数据没有这个字段 ⇒ undefined，resolve 时会重算）
            weak: b.weak === true,
        }));
    base.codes = codes.filter((c) => c && typeof c === 'object' && typeof c.code === 'string')
        .map((c) => ({
            code: String(c.code),
            agent: typeof c.agent === 'string' ? c.agent : null,
            sessionId: typeof c.sessionId === 'string' ? c.sessionId : null,
            createdAt: Number(c.createdAt) || 0,
            expiresAt: Number(c.expiresAt) || 0,
        }));
    return base;
}

/** 把解析失败的身份表改名留证（`.corrupt-<时间戳>`）；改名失败返回 null。 */
function backupCorruptFile(file) {
    try {
        const backup = `${file}.corrupt-${Date.now()}`;
        renameSync(file, backup);
        return backup;
    } catch {
        return null;
    }
}

/**
 * 读表。文件不存在/坏掉 → 空表 + `ok:false`（调用方照常工作，只是"没有绑定"）。
 * @param {string} file
 * @returns {{store:object, ok:boolean, reason:string, corrupt?:boolean, backup?:string|null}}
 */
export function readStore(file) {
    if (!file || !existsSync(file)) return { store: emptyStore(), ok: false, reason: 'missing' };
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (e) {
        return { store: emptyStore(), ok: false, reason: `unreadable:${e?.message ?? e}` };
    }
    try {
        return { store: sanitizeStore(JSON.parse(text)), ok: true, reason: 'ok' };
    } catch (e) {
        // R6 #69：损坏必须留证 + 告警（原来静默返回空表 → 全员降级 guest 且查不到证据）
        const backup = backupCorruptFile(file);
        console.error(`[identity] 身份表损坏，已按空表处理（fail-closed）`
            + `：${file}${backup ? `（原文件已留证：${backup}）` : '（改名留证失败）'}：${e?.message ?? e}`);
        return { store: emptyStore(), ok: false, reason: `corrupt:${e?.message ?? e}`, corrupt: true, backup };
    }
}

/**
 * 写表：**先写临时文件再 rename**（两个进程都会写，半个文件比没有更糟）。
 * @param {string} file
 * @param {object} store
 * @returns {{ok:boolean, file:string, reason:string}}
 */
export function writeStore(file, store) {
    try {
        mkdirSync(path.dirname(file), { recursive: true });
        const clean = sanitizeStore(store);
        const cur = readStore(file);
        const curRev = cur.ok ? Number(cur.store.rev ?? 0) : 0;
        // R6 #21：带 rev 的写（readStore 读出来的那份）遇到别人先写过 → 拒写，不静默覆盖
        if (Number(store?.rev) > 0 && Number(store.rev) !== curRev) {
            return { ok: false, file, reason: 'conflict' };
        }
        clean.rev = curRev + 1;
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
        renameSync(tmp, file);
        return { ok: true, file, reason: 'ok' };
    } catch (e) {
        return { ok: false, file, reason: String(e?.message ?? e) };
    }
}

/** 同步睡 ms（锁重试用）。 */
function sleepMs(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 没有 SAB 就忙等 */ }
}

/** 文件级互斥锁（O_EXCL 建锁；崩溃残留超过 staleMs 视为可抢）。 */
function acquireFileLock(file, { timeoutMs = 3000, staleMs = 10000 } = {}) {
    const lockPath = `${file}.lock`;
    const start = Date.now();
    for (;;) {
        try {
            closeSync(openSync(lockPath, 'wx'));
            return { ok: true, release: () => { try { unlinkSync(lockPath); } catch { /* ignore */ } } };
        } catch (e) {
            if (e?.code !== 'EEXIST') return { ok: false, reason: `lock:${e?.code ?? e?.message}` };
            try { if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath); } catch { /* ignore */ }
            if (Date.now() - start >= timeoutMs) return { ok: false, reason: 'lock-timeout' };
            sleepMs(3);
        }
    }
}

/** 去掉过期码；返回新表（不改入参）。 */
export function pruneCodes(store, now = Date.now()) {
    const next = sanitizeStore(store);
    next.codes = next.codes.filter((c) => c.expiresAt > now);
    return next;
}

/**
 * 挂一个待核销的码（面板侧调用）。
 *
 * 语义：**同一 sessionId 只留最新一个码**（再点一次"生成"就让旧码作废），
 * 总条数受 `MAX_PENDING_CODES` 限制（满了丢最旧的）。
 *
 * @param {object} store
 * @param {{code:string, agent?:string, sessionId?:string, now?:number, ttlMs?:number}} p
 * @returns {{store:object, record:object}}
 */
export function addCode(store, { code, agent = null, sessionId = null, now = Date.now(), ttlMs = DEFAULT_CODE_TTL_MS } = {}) {
    const next = pruneCodes(store, now);
    const record = {
        code: String(code),
        agent,
        sessionId,
        createdAt: now,
        // ★ 硬上限：任务要求"短时（≤5 分钟）"。传更大的 TTL 也压到 5 分钟。
        expiresAt: now + Math.min(Math.max(Number(ttlMs) || 0, 1000), DEFAULT_CODE_TTL_MS),
    };
    next.codes = next.codes.filter((c) => !(sessionId && c.sessionId === sessionId) && c.code !== record.code);
    next.codes.push(record);
    while (next.codes.length > MAX_PENDING_CODES) next.codes.shift();
    return { store: next, record };
}

/**
 * 核销一个码（**单次使用**：核销即从表里删掉）。
 * @param {object} store
 * @param {{code:string, now?:number}} p
 * @returns {{ok:boolean, record:object|null, reason:string, store:object}}
 */
export function consumeCode(store, { code, now = Date.now() } = {}) {
    const want = normalizeCode(code);
    const next = pruneCodes(store, now);
    if (!want) return { ok: false, record: null, reason: 'empty', store: next };
    const idx = next.codes.findIndex((c) => normalizeCode(c.code) === want);
    if (idx === -1) {
        const known = next.codes.length > 0;
        return { ok: false, record: null, reason: known ? 'invalid' : 'no-codes', store: next };
    }
    const [record] = next.codes.splice(idx, 1);
    return { ok: true, record, reason: 'ok', store: next };
}

/**
 * 事务式读-改-写（R6 #21）：**加锁 → 重读 → 改 → 原子 rename**，期间没有别的写者。
 * mutator(store, ctx) 返回 `{store, result}` 落库；返回 `null` 表示"不写"。
 */
export function mutateStore(file, mutator, { now = Date.now(), attempts = 3 } = {}) {
    if (!file) return { ok: false, reason: 'no-file' };
    try { mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 写失败会报出来 */ }
    const locked = acquireFileLock(file);
    if (!locked.ok) return { ok: false, reason: locked.reason };
    try {
        for (let i = 1; i <= attempts; i += 1) {
            const read = readStore(file);
            const out = mutator(read.store, { now, attempt: i, clean: read.ok });
            if (!out) return { ok: true, skipped: true, result: null };
            const wrote = writeStore(file, out.store);
            if (wrote.ok) return { ok: true, result: out.result ?? null, store: out.store, attempts: i };
            if (wrote.reason !== 'conflict') return { ok: false, reason: wrote.reason };
        }
        return { ok: false, reason: 'conflict' };
    } finally {
        locked.release();
    }
}

/**
 * 核销一个绑定码（R6 #21）：**跨进程单次生效** —— 加锁读改写，第二个核销者看到码已不在。
 * 返回值与 `consumeCode` 同形（ok/record/reason），但 store 已落盘。
 */
export function consumeCodeAtomic(file, code, { now = Date.now() } = {}) {
    let why = null;
    const r = mutateStore(file, (store, ctx) => {
        const c = consumeCode(store, { code, now: ctx.now });
        if (!c.ok) { why = c.reason; return null; }
        return { store: c.store, result: c.record };
    }, { now });
    if (!r.ok) return { ok: false, record: null, reason: r.reason };
    if (r.skipped) return { ok: false, record: null, reason: why ?? 'invalid' };
    return { ok: true, record: r.result, reason: 'ok' };
}

/** 签发一个绑定码（面板侧，R6 #21）：与核销同一把锁，避免"读旧写新"抹掉别人刚签的码。 */
export function issueCodeAtomic(file, p = {}) {
    const r = mutateStore(file, (store, ctx) => {
        const out = addCode(store, { ...p, now: p.now ?? ctx.now });
        return { store: out.store, result: out.record };
    });
    return r.ok ? { ...r, record: r.result } : { ...r, record: null };
}

/**
 * 核销成功后落一条绑定（按 uuid + name 都记，解析时 uuid 优先）。
 * 同一个人重复绑定 = 覆盖（不会堆一堆旧租期）。
 * @param {object} store
 * @param {{code:object, uuid?:string|null, name?:string|null, level?:string, now?:number, ttlMs?:number}} p
 * @returns {{store:object, binding:object|null, reason:string}}
 */
export function bindFromCode(store, {
    code = null, uuid = null, name = null, level = BOUND_LEVEL,
    now = Date.now(), ttlMs = DEFAULT_BINDING_TTL_MS,
} = {}) {
    const next = sanitizeStore(store);
    const u = typeof uuid === 'string' && uuid ? uuid : null;
    const n = typeof name === 'string' && name ? name.trim() : null;
    if (!u && !n) return { store: next, binding: null, reason: 'no-identity' };
    const binding = {
        uuid: u,
        name: n,
        level: String(level || BOUND_LEVEL),
        boundAt: now,
        expiresAt: now + Math.max(Number(ttlMs) || 0, 1000),
        sessionId: code?.sessionId ?? null,
        // ★ t20：离线服发的 uuid 由名字派生 ⇒ 同名即可冒用 ⇒ 标记成弱绑定。
        //   标记只是**记录事实**；要不要据此降级由调用方的 offline_owner_mode 决定。
        weak: isWeakBinding({ uuid: u, name: n }),
    };
    next.bindings = next.bindings.filter((b) => !((u && b.uuid === u) || (!u && n && b.name === n)));
    next.bindings.push(binding);
    return { store: next, binding, reason: 'ok' };
}

/**
 * 按身份查绑定等级。
 *
 * 顺序：**uuid 优先**（离线服务器上名字可以随便改，uuid 在"同一客户端"内稳定），
 * 名字只作为"没拿到 uuid"时的退路。过期一律当没绑定。
 *
 * @param {object} store
 * @param {{uuid?:string|null, name?:string|null, now?:number}} p
 * @returns {{level:string|null, binding:object|null, weak:boolean, reason:string}}
 *   `weak=true` 表示这条绑定是**离线服按名字派生 uuid** 得来的（同名者可冒用）；
 *   是否据此降级由调用方的 `offline_owner_mode` 决定（见 permissions / commands 的接线）。
 */
export function resolveBinding(store, { uuid = null, name = null, now = Date.now() } = {}) {
    const s = sanitizeStore(store);
    const u = typeof uuid === 'string' && uuid ? uuid : null;
    const n = typeof name === 'string' && name ? name.trim() : null;
    let binding = null;
    if (u) binding = s.bindings.find((b) => b.uuid === u) ?? null;
    // ★★★ 名字回退**只认"没有 uuid 的绑定"**。
    //   否则：主人绑定了 uuid+name，冒名者改个客户端名字叫 Zeh（uuid 不同）就能命中
    //   这条 fallback ⇒ 直接拿 owner —— 那等于把本机制要堵的洞又开了一遍。
    //   名字只有在"当初就没拿到 uuid"时才是身份（并在 !claim 的回执里明确警告过）。
    if (!binding && n) binding = s.bindings.find((b) => !b.uuid && (b.name ?? '') === n) ?? null;
    if (!binding) return { level: null, binding: null, weak: false, reason: 'unbound' };
    if (Number(binding.expiresAt) > 0 && Number(binding.expiresAt) <= now) {
        return { level: null, binding, weak: isWeakBinding(binding), reason: 'expired' };
    }
    return { level: binding.level, binding, weak: isWeakBinding(binding), reason: 'ok' };
}

/**
 * 解绑（面板"解绑"按钮 / 吊销某个人）。
 * @param {object} store
 * @param {{uuid?:string|null, name?:string|null, sessionId?:string|null}} p
 * @returns {{store:object, removed:number}}
 */
export function revokeBinding(store, { uuid = null, name = null, sessionId = null } = {}) {
    const next = sanitizeStore(store);
    const before = next.bindings.length;
    const u = typeof uuid === 'string' && uuid ? uuid : null;
    const n = typeof name === 'string' && name ? name.trim() : null;
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : null;
    next.bindings = next.bindings.filter((b) => {
        if (u && b.uuid === u) return false;
        if (!u && n && b.name === n) return false;
        if (sid && b.sessionId === sid) return false;
        return true;
    });
    return { store: next, removed: before - next.bindings.length };
}

/**
 * 面板会话断开 ⇒ 它签发的**未核销码**作废（"绑定当前面板会话"的另一半）。
 * 已经绑定成功的条目**不**跟着消失（那是玩家与 bot 的关系，不是面板会话的关系）。
 * @param {object} store
 * @param {string} sessionId
 * @returns {{store:object, removed:number}}
 */
export function revokeSessionCodes(store, sessionId) {
    const next = sanitizeStore(store);
    const before = next.codes.length;
    if (!sessionId) return { store: next, removed: 0 };
    next.codes = next.codes.filter((c) => c.sessionId !== sessionId);
    return { store: next, removed: before - next.codes.length };
}

/**
 * 面板展示用：还剩哪些码、绑定了谁（**不回码本身**以外的东西）。
 * @param {object} store
 * @param {number} [now]
 */
export function previewStatus(store, now = Date.now()) {
    const s = pruneCodes(store, now);
    return {
        codes: s.codes.map((c) => ({ code: c.code, expiresAt: c.expiresAt, sessionId: c.sessionId })),
        bindings: s.bindings.map((b) => ({
            uuid: b.uuid, name: b.name, level: b.level, boundAt: b.boundAt,
            expiresAt: b.expiresAt, expired: Number(b.expiresAt) > 0 && Number(b.expiresAt) <= now,
            // t20：面板要能看出"这条是弱绑定（离线服，同名可冒用）"
            weak: isWeakBinding(b),
        })),
    };
}
