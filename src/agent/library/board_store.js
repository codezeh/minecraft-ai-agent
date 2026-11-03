/**
 * 任务板存储（M8 B1，06_task_board.md §3/§6，设计见 M8_实施设计.md §3.1）。
 *
 * **mindserver 侧、唯一写库的地方。** 所有状态转移都在这里，调用方（board_server）
 * 只做"校验参数 → 调我 → 回 ack"，业务逻辑不许漏到 socket 层。
 *
 * 为什么放 mindserver：每只 agent 是独立子进程，板放 agent 里别的 bot 看不见；
 * 放 mindserver 就只有**一个进程写库**，省掉多进程锁（06 §3、§9.3）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条最容易写错的规则（06 §6，每条都有对应测试）：
 *
 *   ① **领单原子性**：靠 `UPDATE ... WHERE state='ready'` 的 `changes` 判断。
 *      **绝对不许"先 SELECT 再 UPDATE"** —— 两个 bot 会在 SELECT 与 UPDATE 之间同时领到。
 *      这不是风格问题：真发生就是两个 bot 做同一张单、互相打断、都报失败。
 *
 *   ② **重试计数分三类**：
 *      · `INTERRUPTED` / `PREEMPTED` → **不计** attempts（玩家喊停不该让单子被消耗）
 *      · `TIMEOUT` / `STUCK` / `NO_PATH` → **计**（这类是"真做不成"，重试几次再放弃）
 *      · `NO_ITEM` / `NO_TOOL` / `NO_RECIPE` → **直接 blocked**（重试没用，得先补料/换单）
 *
 *   ③ **完成判据**：`ok` **且** `progress.count >= want`。
 *      只看"没报错"不算完成 —— 很多流程会返回 ok 但只做了一部分（`count < want`），
 *      把它当完成会让任务永远差几个却显示"做完了"。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { boardDirOf } from './bot_paths.js';
import { claimsConflict, normalizeClaimKeys, parseClaimKey } from './board_claims.js';

/** 任务单状态（06 §4 原表，别自造）。 */
export const JOB_STATE = Object.freeze({
    PENDING: 'pending',
    READY: 'ready',
    CLAIMED: 'claimed',
    RUNNING: 'running',
    PAUSED: 'paused',
    BLOCKED: 'blocked',
    DONE: 'done',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

/** 全部合法状态（给校验用）。 */
export const ALL_STATES = new Set(Object.values(JOB_STATE));

/**
 * 合法状态转移表（06 §4/§6）。
 * 只列"业务上真的会发生"的边；不在表里的转移一律拒绝（06 §12 要求测非法转移）。
 */
const TRANSITIONS = {
    pending: ['ready', 'cancelled'],
    ready: ['claimed', 'paused', 'cancelled', 'blocked', 'done'],
    claimed: ['running', 'ready', 'paused', 'cancelled', 'blocked', 'failed', 'done'],
    running: ['ready', 'paused', 'blocked', 'done', 'failed', 'cancelled'],
    paused: ['ready', 'cancelled', 'blocked', 'failed'],
    blocked: ['ready', 'cancelled'],
    done: [],            // 终态
    failed: [],          // 终态
    cancelled: [],       // 终态
};

/** 该状态是不是终态（终态不许再动）。 */
export const isTerminal = (state) => (TRANSITIONS[state] ?? []).length === 0;

/** 转移是否合法。 */
export function canTransition(from, to) {
    if (!ALL_STATES.has(from) || !ALL_STATES.has(to)) return false;
    return (TRANSITIONS[from] ?? []).includes(to);
}

/** 决定 attempts 怎么算的码集合（06 §6 规则②）。 */
const NO_COUNT_CODES = new Set(['INTERRUPTED', 'PREEMPTED']);
const COUNT_CODES = new Set(['TIMEOUT', 'STUCK', 'NO_PATH']);
const DIRECT_BLOCK_CODES = new Set(['NO_ITEM', 'NO_TOOL', 'NO_RECIPE']);

/** 默认租约时长（06 §6：30 秒）。 */
export const LEASE_MS = 30 * 1000;

/** 默认最大尝试次数。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

// ───────────────────────────────────────────────────────────────────────────
// 建库 / 打开
// ───────────────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'personal',
    parentId TEXT,
    title TEXT, skill TEXT, args TEXT,
    why TEXT, priority INTEGER NOT NULL DEFAULT 5,
    source TEXT, assignee TEXT,
    requires TEXT, claims TEXT,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    maxAttempts INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
    lease_owner TEXT, lease_until INTEGER,
    progress TEXT, checkpoint TEXT, result TEXT,
    interrupted TEXT,
    notBefore INTEGER, repeat_ms INTEGER,
    dependsOn TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, priority, createdAt);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_until);

-- 预约表（06 §9.2）。B1 建表未填，B3 起真正使用：
--   id    = 持有它的任务单 id
--   key   = block:x,y,z / area:x,y,z:r / container: / station: / entity: / item:
--   owner = 哪只 bot（冲突判定按 owner 区分"自己"与"别人"）
--   until = TTL 到期时刻；跟着 heartbeat 续期，过期由 expireClaims 清掉
CREATE TABLE IF NOT EXISTS claims (
    id TEXT NOT NULL, key TEXT NOT NULL, owner TEXT, until INTEGER,
    PRIMARY KEY (id, key)
);
CREATE INDEX IF NOT EXISTS idx_claims_key ON claims(key);
-- 共享数据（B4，06 §9.3）：地标 / 危险点 / 箱子内容。三种 kind 共用一张表。
--   kind = 'landmark' | 'danger' | 'chest'
--   key  = 名字（地标）/ "x,z"（危险）/ "x,y,z"（箱子）
--   value= JSON（形状按 kind 不同，读的人自己知道）
CREATE TABLE IF NOT EXISTS shared (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    owner TEXT,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_claims_until ON claims(until);
`;

/**
 * 打开（必要时创建）板库。
 *
 * ★ "库损坏自动重建空库"（用户决策②）：板是**可重建的调度状态**，不是用户数据；
 *   宁可丢单也不能让整个 agent 起不来。做法：SQLite 打开/建表抛错 → 把坏文件改名留证
 *   （`.corrupt-<时间戳>`）→ 建新库。**不静默删**，坏文件留着能查。
 *
 * @param {string} [dir] 板库目录，默认 `boardDirOf()`（`./bots/_board`）
 * @returns {{db:DatabaseSync, dir:string, path:string, rebuilt:boolean}}
 */
export function openBoard(dir = boardDirOf()) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'board.sqlite');

    /** 最近一次构造的 db 句柄（用于失败时 close 掉，否则文件被锁住没法改名/删）。 */
    let lastDb = null;

    const tryOpen = () => {
        const db = new DatabaseSync(path);
        lastDb = db;
        // WAL + busy 超时：mindserver 是唯一写者，但读可能并发（面板/别的查询）
        try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* 有的构建不支持，忽略 */ }
        try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* ignore */ }
        db.exec(SCHEMA);
        return db;
    };

    try {
        return { db: tryOpen(), dir, path, rebuilt: false };
    } catch (e) {
        // 坏了：**先把坏文件移走留证，再建空库**（用户决策②）。
        //
        // 坑（2026-11-02 实测）：第一次 `new DatabaseSync(path)` 抛错时，句柄可能还占着文件，
        // Windows 上 `renameSync` 会 EPERM/EBUSY。所以这里分级处理：
        //   ① 先尝试改名到 `board.sqlite.corrupt-<时间戳>`（最好的结果：坏文件留着能查）
        //   ② 改名失败就 `rmSync` 删掉（板是可重建的调度状态，不能因为一个坏文件让 agent 起不来）
        //   ③ 顺手清掉同名的 `-wal` / `-shm`（残留的 WAL 会让新库也打不开）
        //
        //   ★ 另一个实测坑：`new DatabaseSync()` **即使 exec 抛错也会占着文件句柄**，
        //     直接 rename/rm 会 EBUSY。所以必须先 `close()` 掉那个句柄再动文件。
        try { lastDb?.close?.(); } catch { /* 关不掉也继续试 */ }
        lastDb = null;
        const backupBase = `${path}.corrupt-${Date.now()}`;
        let backup = null;
        for (const suffix of ['', '-wal', '-shm']) {
            const f = `${path}${suffix}`;
            if (!existsSync(f)) continue;
            try {
                if (suffix === '') { renameSync(f, backupBase); backup = backupBase; }
                else renameSync(f, `${backupBase}${suffix}`);
            } catch {
                try {
                    if (suffix === '') { rmSync(f, { force: true }); backup = null; }
                    else rmSync(f, { force: true });
                } catch { /* 实在删不掉就让下面 tryOpen 再报错 */ }
            }
        }
        let db;
        try {
            db = tryOpen();
        } catch (e2) {
            // 连重建都失败：把两个错都带上，别让上层只看到第二个
            throw new Error(`任务板库损坏且重建失败：原始错误=${String(e?.message ?? e)}；重建错误=${String(e2?.message ?? e2)}`);
        }
        return { db, dir, path, rebuilt: true, backup, error: String(e?.message ?? e) };
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 行 ↔ 对象
// ───────────────────────────────────────────────────────────────────────────

const JSON_COLS = new Set(['args', 'requires', 'claims', 'progress', 'checkpoint', 'result', 'dependsOn', 'interrupted']);

/** DB 行 → 任务单对象（字段名与 06 §4 一致）。 */
export function rowToJob(row) {
    if (!row) return null;
    const job = {};
    for (const [k, v] of Object.entries(row)) {
        if (JSON_COLS.has(k)) {
            job[k] = v == null ? null : safeParse(v);
        } else if (k === 'repeat_ms') {
            job.repeat = v == null ? null : { everyMs: v };
        } else if (k === 'lease_owner' || k === 'lease_until') {
            // 合并成 06 §4 的 lease:{owner,until}
            job.lease = job.lease ?? { owner: null, until: null };
            if (k === 'lease_owner') job.lease.owner = v ?? null;
            else job.lease.until = v ?? null;
        } else {
            job[k] = v;
        }
    }
    if (!job.lease) job.lease = { owner: null, until: null };
    return job;
}

function safeParse(s) {
    try { return JSON.parse(s); } catch { return null; }
}

const j = (v) => (v == null ? null : JSON.stringify(v));

// ───────────────────────────────────────────────────────────────────────────
// 进度单调（06 §11「重启后进度不倒退」）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 合并进度：**count 只许往上**。
 *
 * ★ 为什么这条必须在 store 里（2026-11-02 真机验收暴露）：
 *   `progress.count` 的语义是"**这张单累计做到多少**"。而进程重启后，agent 只能从
 *   它当时看到的东西重新数（`mine` 返回的是"本次运行新挖多少"的相对量、或背包总量——
 *   如果重启时背包没保存下来，它会报 0）。**agent 报什么就存什么，进度就会倒退**，
 *   而 06 §11 明确要求"重启后进度不丢、不倒退"。
 *
 *   所以由**唯一写库的地方**来保证：`count` 取 `max(旧, 新)`。
 *   `want` 用新值（它不变，但万一单子被改过，以最新声明为准）。
 *   这不隐藏信息：`data` 里同时记 `reported`（agent 这次报的原值），差的量一眼能看出来。
 */
function mergeProgress(oldP, newP) {
    if (!newP) return { progress: oldP ?? null, reported: null, clamped: false };
    const oldCount = Number(oldP?.count ?? -Infinity);
    const newCount = Number(newP?.count ?? 0);
    const want = newP?.want ?? oldP?.want ?? null;
    const kept = Number.isFinite(oldCount) && oldCount > newCount;
    return {
        progress: { ...newP, count: kept ? oldCount : newCount, want },
        reported: newCount,           // agent 这次报的原值（留痕用）
        clamped: kept,                // 是否发生了"拒绝倒退"
    };
}

// ───────────────────────────────────────────────────────────────────────────
// 写操作
// ───────────────────────────────────────────────────────────────────────────

/**
 * 生成 id：`j_<yyyyMMdd>_<seq>_<rand>`（保留 06 §4 示例的可读形状）。
 *
 * ★ 2026-11-02 真机验收抓到的 bug：原来只用进程内计数器 `j_<日期>_<0001>`。
 *   计数器**每个进程都从 0 开始**，所以 mindserver 一重启就会生成和库里已有单
 *   **完全相同的 id** → `UNIQUE constraint failed: jobs.id` → 加单直接失败。
 *   而"重启"恰恰是 B1 要支撑的核心场景 —— 这个 id 方案从根上是错的。
 *
 *   修法：日期 + 计数器（可读）+ **进程级随机段**（防跨进程撞号），
 *   并由 `addJob` 在真撞号时重试（极小概率，仍要兜住）。
 */
let seqCounter = 0;
const ID_SALT = Math.floor(Math.random() * 0x10000).toString(36).padStart(3, '0');

function newId(now = Date.now()) {
    const d = new Date(now);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    seqCounter = (seqCounter + 1) % 10000;
    return `j_${ymd}_${String(seqCounter).padStart(4, '0')}_${ID_SALT}`;
}

/**
 * 加一张单。
 *
 * @param {object} db
 * @param {object} job 不含 id/state 也可（会补）
 * @param {object} [opts] { now }
 * @returns {object} 落库后的任务单
 */
export function addJob(db, job, opts = {}) {
    const now = opts.now ?? Date.now();
    const state = job.state ?? JOB_STATE.READY;      // 个人单加进来就是 ready（B1 不做 dependsOn 门）
    if (!ALL_STATES.has(state)) throw new Error(`addJob: 非法状态 ${state}`);

    const insertId = job.id ?? newId(now);
    try {
        return insertJobRow(db, job, insertId, state, now);
    } catch (e) {
        // 万一还是撞号（多进程同 salt / 外部指定了重复 id）：换个 id 再试一次，
        // **不要**把 `UNIQUE constraint failed` 这种底层错误抛给调用方。
        if (job.id || !/UNIQUE constraint failed: jobs\.id/.test(String(e?.message ?? ''))) throw e;
        return insertJobRow(db, job, newId(now + 1), state, now);
    }
}

/** 真正执行 INSERT 的那一步（addJob 里唯一会因撞号失败的地方）。 */
function insertJobRow(db, job, id, state, now) {
    db.prepare(`INSERT INTO jobs
        (id, kind, parentId, title, skill, args, why, priority, source, assignee, requires, claims,
         state, attempts, maxAttempts, lease_owner, lease_until, progress, checkpoint, result, interrupted,
         notBefore, repeat_ms, dependsOn, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id,
        job.kind ?? 'personal',
        job.parentId ?? null,
        job.title ?? null,
        job.skill ?? null,
        j(job.args ?? {}),
        job.why ?? null,
        Number.isFinite(job.priority) ? job.priority : 5,
        job.source ?? null,
        job.assignee ?? null,
        j(job.requires ?? null),
        j(job.claims ?? null),
        state,
        0,
        Number.isFinite(job.maxAttempts) ? job.maxAttempts : DEFAULT_MAX_ATTEMPTS,
        null, null,
        j(job.progress ?? null),
        j(job.checkpoint ?? null),
        j(job.result ?? null),
        j(job.interrupted ?? null),
        job.notBefore ?? null,
        job.repeat?.everyMs ?? null,
        j(job.dependsOn ?? null),
        now, now,
    );
    return getJob(db, id);
}

/** 读一张单。 */
export function getJob(db, id) {
    return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
}

/**
 * 列单。
 *
 * @param {object} filter { states?, mine?, assignee?, claimableFor?, skill?, limit? }
 *   ★ `claimableFor`（2026-11-02 t23 新增）：**可领**语义 —— `assignee IS NULL OR assignee = ?`，
 *     与 `claimFor()` 的候选条件**逐字一致**。抢占用它，才不会漏掉共享单（assignee=null）。
 */
export function listJobs(db, filter = {}) {
    const where = [];
    const params = [];
    if (Array.isArray(filter.states) && filter.states.length) {
        where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
        params.push(...filter.states);
    }
    if (filter.assignee) { where.push('assignee = ?'); params.push(filter.assignee); }
    // ★ 可领 = 共享单（assignee 为空，谁都能领）+ 指派给我的单 —— 与 claimFor 的候选条件保持一致
    if (filter.claimableFor) {
        where.push('(assignee IS NULL OR assignee = ?)');
        params.push(filter.claimableFor);
    }
    if (filter.skill) { where.push('skill = ?'); params.push(filter.skill); }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY priority DESC, createdAt ASC
                 LIMIT ?`;
    params.push(Number.isFinite(filter.limit) ? filter.limit : 200);
    return db.prepare(sql).all(...params).map(rowToJob);
}

/**
 * 「进度已达标」的单 → 直接收敛成 `done`，**不再派给人 / 继续跑**。
 *
 * ★ 2026-11-02（t20，captain 拍板）：这是 B1 真机"不重复计数"验收失败的根因。
 *   实测：A 跑 collect（want=8）被 SIGKILL 时进度已到 15，但没来得及 finish；
 *   租约过期后单回到 `ready`，B 重新领到同一张单又挖了 9 → 最终 24/8。
 *   不是同一批重复计，是**已达标的单被重新派了一遍**。
 *
 * 判据：`want > 0 且 progress.count >= want`。
 *
 * ★ **绝不截断 count**（不做 `Math.min(count, want)`）：`24/8` 里的 24 是真实发生过的事实
 *   （背包确实多了 24 个），截成 8 就是篡改记录；超额本身也是有用信息（want 定小了）。
 *   展示层标「超额」即可（见 `!jobs`）。
 *
 * @returns {object|null} 收敛后的单；没达标返回 null
 */
function convergeIfSatisfied(db, id, now, reason = 'satisfied') {
    const job = getJob(db, id);
    if (!job) return null;
    const want = Number(job.progress?.want ?? job.want ?? 0);
    const count = Number(job.progress?.count ?? 0);
    if (!(want > 0) || count < want) return null;            // 没达标 → 不收敛
    if (isTerminal(job.state)) return job;                    // 已是终态
    if (!canTransition(job.state, JOB_STATE.DONE)) return null;

    db.prepare(`UPDATE jobs
        SET state=?, lease_owner=NULL, lease_until=NULL, result=?, updatedAt=?
        WHERE id=? AND state=?`).run(
        JOB_STATE.DONE,
        j({ ok: true, code: 'OK', message: `进度已达标（${count}/${want}），直接收敛为 done`, reason, at: now }),
        now, id, job.state,
    );
    return getJob(db, id);
}

/**
 * 领单（**原子**）。
 *
 * ★ 规则①：只用一条 `UPDATE ... WHERE state='ready'`，靠 **`changes`** 判断成败。
 *   绝不"先 SELECT 再 UPDATE" —— 那中间有个窗口，两个 bot 会同时领到同一张单。
 *
 * 个人单优先（assignee 是自己），再多人单（assignee 为 null）；按 priority DESC、createdAt ASC。
 *
 * ★ 2026-11-02（t20）：派单前先收敛"进度已达标"的单（见 `convergeIfSatisfied`）——
 *   否则被 kill 在"已跑够但没 finish"时刻的单会被重新派一遍，计数虚涨。
 *
 * @returns {object|null} 领到的单；没有可领的返回 null
 */
export function claimFor(db, bot, opts = {}) {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? LEASE_MS;
    /** 这只 bot 的能力（角色 / 背包物品），用于 `requires` 过滤（B3，06 §9.4）。 */
    const who = { roles: opts.roles ?? [], items: opts.items ?? [] };

    // 候选：ready 且（个人单是我的 或 多人单没指派）；notBefore 已到
    const cands = db.prepare(`
        SELECT id FROM jobs
        WHERE state = 'ready'
          AND (assignee IS NULL OR assignee = ?)
          AND (notBefore IS NULL OR notBefore <= ?)
        ORDER BY (assignee = ?) DESC, priority DESC, createdAt ASC
        LIMIT 16`).all(bot, now, bot);

    for (const c of cands) {
        // ★ 先看"是不是已经跑够了"：跑够的直接收敛成 done，**不派发**（t20 修的就是这里）
        const converged = convergeIfSatisfied(db, c.id, now, 'claim-sweep');
        if (converged) continue;

        // ★ B3 资格过滤（06 §9.4）：角色/物品不满足 → 跳过这张，继续看下一张。
        //   注意顺序：**在原子 UPDATE 之前**过滤，抢不到的不该白占 leases。
        const candJob = getJob(db, c.id);
        if (!candJob) continue;
        if (!meetsRequires(candJob, who)) continue;
        // ★ dependsOn：前置没 done → 这张还不能领（06 §9.1 按工序拆单）
        if (!dependsSatisfied(db, candJob)) continue;
        // 原子抢：**这一条**就是全部关键。changes===1 → 我抢到了；0 → 别人先抢走了，试下一个
        const r = db.prepare(`
            UPDATE jobs SET state='claimed', assignee=?, lease_owner=?, lease_until=?, updatedAt=?
            WHERE id = ? AND state = 'ready'`).run(bot, bot, now + leaseMs, now, c.id);
        if (r.changes === 1) return getJob(db, c.id);
        // 没抢到（被别人抢先/状态已变）→ 继续试下一个候选
    }
    return null;
}

/**
 * 续租（心跳）。
 *
 * 租约语义（06 §6）：owner 不符或已过期 → `LEASE_LOST`，调用方**立刻停手**
 * （别人可能已经接手同一张单，再动世界就是两个 bot 做同一件事）。
 *
 * @returns {{ok:true, job:object} | {ok:false, code:'LEASE_LOST'|'NO_TARGET'}}
 */
export function heartbeat(db, id, bot, opts = {}) {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? LEASE_MS;
    const progress = opts.progress ?? null;

    const job = getJob(db, id);
    if (!job) return { ok: false, code: 'NO_TARGET' };
    if (job.lease?.owner !== bot) return { ok: false, code: 'LEASE_LOST' };
    if (Number.isFinite(job.lease?.until) && job.lease.until < now) return { ok: false, code: 'LEASE_LOST' };

    // 续租同时把 claimed 推进到 running（第一次心跳即"真的开工了"）
    const nextState = job.state === JOB_STATE.CLAIMED ? JOB_STATE.RUNNING : job.state;
    // ★ 进度单调：agent 报的原值比已有的小 → 取大的（06 §11「不倒退」）
    const merged = mergeProgress(job.progress, progress);
    db.prepare(`UPDATE jobs SET lease_until=?, state=?, progress=?, updatedAt=? WHERE id=?`)
        .run(now + leaseMs, nextState, j(merged.progress), now, id);

    // ★ 2026-11-02（t20，captain 要求）：心跳报到"已达标"就当场收敛成 done，**别等 finish**。
    //   理由：B1 真机里 A 在"已跑够 15/8"时被 kill，如果只能靠 finish 收敛，
    //   那张单会一直停在 running/ready，直到租约过期被人重领再跑一遍（计数虚涨）。
    const converged = convergeIfSatisfied(db, id, now, 'heartbeat-satisfied');
    if (converged) {
        return {
            ok: true, job: converged, progressClamped: merged.clamped, reported: merged.reported,
            convergedToDone: true,
        };
    }
    return { ok: true, job: getJob(db, id), progressClamped: merged.clamped, reported: merged.reported };
}

/**
 * 完成一张单 —— 按结果决定 done / ready(attempts+1) / blocked / failed。
 *
 * ★ 规则②③都在这里：
 *   · 完成 = `ok` **且** `progress.count >= want`
 *   · `INTERRUPTED`/`PREEMPTED` 不计 attempts；`TIMEOUT`/`STUCK`/`NO_PATH` 计；
 *     `NO_ITEM`/`NO_TOOL`/`NO_RECIPE` 直接 blocked
 *
 * @param {object} result { ok, code, message, progress:{count,want}, checkpoint? }
 * @returns {{ok:true, job:object, next:string, counted:boolean}}
 */
export function finish(db, id, result = {}, opts = {}) {
    const now = opts.now ?? Date.now();
    const job = getJob(db, id);
    if (!job) return { ok: false, code: 'NO_TARGET' };

    const code = result.code ?? 'OK';
    const okFlag = result.ok === true;
    // ★ 同样单调：finish 报的 progress 不能把已有的进度压小
    const merged = mergeProgress(job.progress, result.progress ?? null);
    const progress = merged.progress ?? job.progress ?? null;
    const count = Number(progress?.count ?? 0);
    const want = Number(progress?.want ?? 0);
    // 规则③：ok **且** count>=want 才算完成；want 未知（0）时退化为只看 ok
    const completed = okFlag && (want <= 0 || count >= want);

    let next;
    let counted = false;

    // ★★ 2026-11-03（t60）：**派了子单的策略单，不能按"自己的进度"判完成或重试**。
    //
    //   真机证据（verify 第 4 跑，第一夜最后一个卡点）：
    //     obtain:oak_log  → attempts=3 耗尽 → blocked，progress {"count":2,"want":8}
    //     但它的子单 mine{count:4} **已经 done 并真的挖到 6 个**
    //   父子账对不上的原因是这一支：
    //     `okFlag && want > 0 && count < want` → 不够就 READY 重试
    //   对**叶子单**（flow 自己干活）这条是对的；对**策略单**是错的——
    //     策略层的活是**子单干的**，它自己的 `count` 只是"某一瞬间背包里有多少"，
    //     而下游 craft 还会消耗它 → `count` 永远追不上 `want` → 无限重试
    //     → 每次重试还**重复派一遍子单**（第 4 跑里 craft 单被派了 3 次）。
    //
    //   正确语义（04 §6.3「策略不自己做动作，只拆子单、等子单结果」）：
    //     父单有**活着的子单** → 它就该保持 `running`，**不消耗 attempts**，
    //     等 `rollupParent` 在子单全部结束后决定 done/blocked。
    const kids = db.prepare('SELECT state FROM jobs WHERE parentId = ?').all(id);
    const kidsAlive = kids.some((c) => [
        JOB_STATE.READY, JOB_STATE.CLAIMED, JOB_STATE.RUNNING, JOB_STATE.PAUSED,
    ].includes(c.state));

    if (completed) {
        next = JOB_STATE.DONE;
    } else if (kids.length && kidsAlive) {
        // 子单还在跑：父单挂着等，既不算完成也不算失败
        next = JOB_STATE.RUNNING;
        counted = false;
    } else if (DIRECT_BLOCK_CODES.has(code)) {
        next = JOB_STATE.BLOCKED;                       // 重试没用，直接 blocked
    } else if (NO_COUNT_CODES.has(code)) {
        next = JOB_STATE.READY;                         // 不计 attempts（玩家喊停不该消耗单子）
    } else if (COUNT_CODES.has(code)) {
        counted = true;
        next = (job.attempts + 1 >= job.maxAttempts) ? JOB_STATE.FAILED : JOB_STATE.READY;
    } else if (okFlag && want > 0 && count < want) {
        // 报了 ok 但没做够：**不算完成**。这是规则③最常被漏的一支。
        counted = true;
        next = (job.attempts + 1 >= job.maxAttempts) ? JOB_STATE.BLOCKED : JOB_STATE.READY;
    } else {
        // 其它码：算一次失败尝试
        counted = true;
        next = (job.attempts + 1 >= job.maxAttempts) ? JOB_STATE.FAILED : JOB_STATE.READY;
    }

    // ★★ 2026-11-04（t69）：**"目标状态 == 当前状态" 是 no-op，不该走转移校验。**
    //
    //   真 bug（fixture 盘点时抓到，并被我 t60 的假绿用例掩盖了）：
    //     `finish()` 对「父单 state='running' + 有活子单」算出的 `next` 也是 `running`，
    //     而 `TRANSITIONS.running` **不含 'running'**（自转移没登记）
    //     → `!canTransition` → `return { ok:false, code:'INTERNAL', message:'非法转移 running → running' }`
    //     → **数据库那一行一字未动**。
    //
    //   后果最严重的是：**t60 的修复对它本来要修的场景根本走不到**。
    //   `strat_first_night` / `strat_obtain` 建父单用的正是 `state:'running'`，
    //   所以"父单挂着等子单"这条路一直是 bail-out，不是真的挂着等。
    //
    //   而且 t60 的用例是**假绿**：它断言 `state==='running' && attempts===0`，
    //   而 bail-out 恰好也满足（行没被改）→ 分不清"决定挂着等"和"报错退出"。
    //
    //   修法：目标状态与当前相同时，**只更新 progress/checkpoint/result，不动 state**，
    //   并如实返回 `next === job.state`（不是失败）。
    if (next !== job.state && !canTransition(job.state, next)) {
        return { ok: false, code: 'INTERNAL', message: `非法转移 ${job.state} → ${next}` };
    }

    const attempts = counted ? job.attempts + 1 : job.attempts;
    db.prepare(`UPDATE jobs
        SET state=?, attempts=?, lease_owner=NULL, lease_until=NULL,
            progress=?, checkpoint=?, result=?, interrupted=?, updatedAt=?
        WHERE id=?`).run(
        next, attempts,
        j(progress ?? job.progress),
        j(result.checkpoint ?? job.checkpoint),
        j({ ok: okFlag, code, message: result.message ?? '', at: now }),
        // 回到 ready 时清掉 interrupted（与 control.js 的 requeue 语义一致）；
        // 其它状态保留（paused 时要留着"被打断的原因/时刻"）
        next === JOB_STATE.READY ? null : j(result.interrupted ?? job.interrupted),
        now, id,
    );
    return { ok: true, job: getJob(db, id), next, counted };
}

/**
 * 扫描过期租约 → 回 `ready`，**checkpoint 保留**（06 §6：留给下一个接手的）。
 *
 * @returns {string[]} 被回收的单 id
 */
export function expireLeases(db, now = Date.now()) {
    const expired = db.prepare(`
        SELECT id FROM jobs
        WHERE state IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until < ?`)
        .all(now).map((r) => r.id);

    const out = [];
    for (const id of expired) {
        // 同样用"条件 UPDATE + changes"的写法，避免把刚刚续过租的单误回收
        const r = db.prepare(`
            UPDATE jobs SET state='ready', lease_owner=NULL, lease_until=NULL, updatedAt=?
            WHERE id=? AND state IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until < ?`)
            .run(now, id, now);
        if (r.changes === 1) out.push(id);
    }
    return out;
}

/**
 * 设置状态（cancel / pause / resume / 被抢占退回）。
 *
 * @returns {{ok:true, job:object} | {ok:false, code:'NO_TARGET'|'INTERNAL', message?}}
 */
export function setState(db, id, state, opts = {}) {
    const now = opts.now ?? Date.now();
    const job = getJob(db, id);
    if (!job) return { ok: false, code: 'NO_TARGET' };
    if (!ALL_STATES.has(state)) return { ok: false, code: 'INTERNAL', message: `未知状态 ${state}` };
    if (!canTransition(job.state, state)) {
        return { ok: false, code: 'INTERNAL', message: `非法转移 ${job.state} → ${state}` };
    }
    const clearLease = [JOB_STATE.READY, JOB_STATE.PAUSED, JOB_STATE.CANCELLED, JOB_STATE.BLOCKED].includes(state);
    db.prepare(`UPDATE jobs SET state=?, updatedAt=?${clearLease ? ', lease_owner=NULL, lease_until=NULL' : ''} WHERE id=?`)
        .run(state, now, id);
    return { ok: true, job: getJob(db, id) };
}

/**
 * 就地更新任意字段（控制层 `board.update(jobId, patch)` 的落点）。
 *
 * 只允许改白名单字段 —— 防止调用方顺手把 id/createdAt 改掉。
 */
const PATCHABLE = new Set(['state', 'priority', 'progress', 'checkpoint', 'result', 'assignee',
    'lease_owner', 'lease_until', 'notBefore', 'repeat_ms', 'title', 'why', 'args', 'requires', 'claims',
    // ★ 2026-11-02 B2 真机验收发现的缺陷：`control.js` 早就在写 `patch.interrupted`
    //   （planStop 记"被打断的时刻"），`requeueStaleBrief()` 也在读 `job.interrupted.at`，
    //   但**库里没有这一列、白名单也不许写** → 字段被**静默丢弃** →
    //   brief 超时回收机制**从上线起就不可能生效**（读到的永远是 undefined）。
    //   这正是"两个地方都以为自己在管同一件事、实际谁都没管"的典型。
    'interrupted']);

export function updateJob(db, id, patch = {}, opts = {}) {
    const now = opts.now ?? Date.now();
    const job = getJob(db, id);
    if (!job) return { ok: false, code: 'NO_TARGET' };

    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(patch ?? {})) {
        if (k === 'lease') {
            // 控制层会传 { lease: null } 表示放掉租约
            if (v == null) { sets.push('lease_owner=NULL', 'lease_until=NULL'); }
            else { sets.push('lease_owner=?', 'lease_until=?'); params.push(v.owner ?? null, v.until ?? null); }
            continue;
        }
        if (!PATCHABLE.has(k)) continue;
        if (k === 'state') {
            if (!ALL_STATES.has(v)) return { ok: false, code: 'INTERNAL', message: `未知状态 ${v}` };
            if (!canTransition(job.state, v)) {
                return { ok: false, code: 'INTERNAL', message: `非法转移 ${job.state} → ${v}` };
            }
        }
        // progress 也走单调合并（控制层可能 patch 进度）
        if (k === 'progress') {
            const m = mergeProgress(job.progress, v);
            sets.push('progress=?');
            params.push(j(m.progress));
            continue;
        }
        sets.push(`${k}=?`);
        params.push(JSON_COLS.has(k) ? j(v) : v);
    }
    if (!sets.length) return { ok: true, job };
    sets.push('updatedAt=?');
    params.push(now, id);
    db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id=?`).run(...params);
    return { ok: true, job: getJob(db, id) };
}

/** 库里共有多少张单（诊断用）。 */
export function countJobs(db, state = null) {
    const r = state
        ? db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE state=?').get(state)
        : db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
    return Number(r?.n ?? 0);
}

// ───────────────────────────────────────────────────────────────────────────
// 预约（B3，06 §9.2）—— 单 bot 恒成功，且**没有第二条路径**
// ───────────────────────────────────────────────────────────────────────────

/** 预约的默认 TTL（与租约同步：30 秒，跟着 heartbeat 续期）。 */
export const CLAIM_TTL_MS = LEASE_MS;

/**
 * 抢占一批预约（原子：要么全拿到，要么一个都不占）。
 *
 * ★★ **"单 bot 恒成功"是怎么保证的 —— 关键：没有 if 分支**
 *
 *   判据只有一条：**同一个 key 上，有没有"别的 owner"持有的未过期预约**。
 *   · 单 bot 时，库里所有预约的 owner 都是自己 → 永远查不到"别人" → 必然成功。
 *   · 多 bot 时，同样的代码就会查到别人 → 返回 CLAIM_CONFLICT。
 *
 *   所以**不需要** `if (bots.length === 1) return ok(...)` —— 那种写法会让单机/多机
 *   变成两条路径（06 §9.2 明令禁止），而且单机路径永远不会被真实冲突检验到，
 *   等到上多机才发现是另一套行为。
 *
 * @param {object} db
 * @param {string} jobId 持有它的单
 * @param {string} owner 哪只 bot
 * @param {string[]} keys
 * @param {object} [opts] { now, ttlMs }
 * @returns {{ok:true, reserved:string[], until:number} | {ok:false, code:string, conflicts:string[], message:string}}
 */
export function reserve(db, jobId, owner, keys, opts = {}) {
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? CLAIM_TTL_MS;
    const norm = normalizeClaimKeys(keys);
    if (!norm.ok) return { ok: false, code: 'INTERNAL', conflicts: [], message: norm.error };
    if (!norm.keys.length) return { ok: true, reserved: [], until: now + ttlMs };

    // 先清掉过期预约（否则死掉的 bot 会永久占着 —— 06 §9.2 "bot 掉线自动释放"）
    expireClaims(db, now);

    // 查"别人持有的未过期预约"，逐个跟我要的 key 比（**跨类型**也比）
    const live = db.prepare(
        'SELECT id, key, owner, until FROM claims WHERE until > ? AND (owner IS NULL OR owner <> ?)',
    ).all(now, owner);

    const conflicts = [];
    for (const want of norm.keys) {
        const mine = parseClaimKey(want);
        if (!mine.ok) { conflicts.push(want); continue; }
        for (const held of live) {
            if (held.id === jobId) continue;                 // 同一张单自己的旧预约
            const theirs = parseClaimKey(held.key);
            if (theirs.ok && claimsConflict(mine, theirs)) {
                conflicts.push(want);
                break;
            }
        }
    }

    if (conflicts.length) {
        // **全有或全无**：一个都不占（否则半占着会把别人堵死）
        return {
            ok: false, code: 'CLAIM_CONFLICT', conflicts,
            message: `预约冲突：${conflicts.join(', ')} 已被别人占着`,
        };
    }

    const until = now + ttlMs;
    const stmt = db.prepare('INSERT INTO claims (id, key, owner, until) VALUES (?,?,?,?) '
        + 'ON CONFLICT(id, key) DO UPDATE SET owner=excluded.owner, until=excluded.until');
    for (const k of norm.keys) stmt.run(jobId, k, owner, until);
    return { ok: true, reserved: norm.keys, until };
}

/**
 * 放掉预约（不传 keys = 放掉这张单的全部）。
 * @returns {{ok:true, released:number}}
 */
export function release(db, jobId, owner, keys = null) {
    if (Array.isArray(keys) && keys.length) {
        const norm = normalizeClaimKeys(keys);
        const list = norm.ok ? norm.keys : [];
        let n = 0;
        for (const k of list) {
            const r = db.prepare('DELETE FROM claims WHERE id=? AND (owner IS NULL OR owner = ?) AND key=?')
                .run(jobId, owner, k);
            n += Number(r.changes ?? 0);
        }
        return { ok: true, released: n };
    }
    const r = db.prepare('DELETE FROM claims WHERE id=? AND (owner IS NULL OR owner = ?)').run(jobId, owner);
    return { ok: true, released: Number(r.changes ?? 0) };
}

/**
 * 清掉过期预约（bot 掉线后它的预约自然失效）。
 * @returns {string[]} 被清掉的 key（诊断用）
 */
export function expireClaims(db, now = Date.now()) {
    const rows = db.prepare('SELECT key FROM claims WHERE until IS NOT NULL AND until <= ?').all(now);
    if (!rows.length) return [];
    db.prepare('DELETE FROM claims WHERE until IS NOT NULL AND until <= ?').run(now);
    return rows.map((r) => r.key);
}

/**
 * 续期这张单持有的全部预约（heartbeat 时调）。
 * @returns {number} 续了几条
 */
export function renewClaims(db, jobId, opts = {}) {
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? CLAIM_TTL_MS;
    const r = db.prepare('UPDATE claims SET until=? WHERE id=?').run(now + ttlMs, jobId);
    return Number(r.changes ?? 0);
}

/** 列预约（诊断/断言用）。 */
export function listClaims(db, jobId = null) {
    const rows = jobId
        ? db.prepare('SELECT * FROM claims WHERE id=? ORDER BY key').all(jobId)
        : db.prepare('SELECT * FROM claims ORDER BY id, key').all();
    return rows.map((r) => ({
        id: r.id,
        key: r.key,
        owner: r.owner,
        until: r.until,
        parsed: parseClaimKey(r.key),
    }));
}

// ───────────────────────────────────────────────────────────────────────────
// 资格（B3，06 §9.4）：角色 / 物品 / dependsOn
// ───────────────────────────────────────────────────────────────────────────

/**
 * 这只 bot 有没有资格领这张单。
 *
 * ★ **缺省行为**：单里没写 `requires.roles` → **谁都能领**（06 §9.4："不配就什么都能领"）。
 *   这条很重要：如果把"bot 没配 roles"当成"不满足"，新装的 bot 会一张多人单都领不到，
 *   表现成"任务板不工作"。
 *
 * @param {object} job
 * @param {{roles?:string[], items?:string[]}} who
 * @returns {boolean}
 */
export function meetsRequires(job, who = {}) {
    const req = job?.requires ?? null;
    if (!req) return true;

    // ★ 角色判定三条（2026-11-02 t25 修正；**这是全系统唯一的实现**，别在别处再写一份）：
    //   1) `requires.roles` 空/未配 → 不受限；
    //   2) `who.roles` **空/未配** → **也视为不受限**（06 §9.4「不配就什么都能领」）；
    //      原来写的是 `new Set(who.roles ?? [])` + `!some(...)` → 空集合必然"一个都对不上" →
    //      没配角色的人**什么带角色的单都领不到**，与上面这段注释和 06 §9.4 正好相反。
    //      （这是"注释说一套、代码走另一套"的典型，而且旧单测把错的行为写成了期望值。）
    //   3) 两边都配了 → **任一命中即可**（`some`，不是 `every`）：
    //      `['miner','farmer']` 对上 `['farmer']` 就够。⚠️ 别"顺手"改成 `every`。
    const wantRoles = Array.isArray(req.roles) ? req.roles : [];
    if (wantRoles.length) {
        const have = who.roles ?? null;
        // 只有"明确配了角色、且一个都对不上"才拒；没配 = 不受限
        if (Array.isArray(have) && have.length && !wantRoles.some((r) => have.includes(r))) return false;
    }
    const wantItems = Array.isArray(req.items) ? req.items : [];
    if (wantItems.length) {
        const have = new Set(who.items ?? []);
        if (!wantItems.every((i) => have.has(i))) return false;
    }
    return true;
}

/** 前置单是否都已完成（`dependsOn`）。 */
export function dependsSatisfied(db, job) {
    const deps = Array.isArray(job?.dependsOn) ? job.dependsOn : [];
    if (!deps.length) return true;
    for (const depId of deps) {
        const dep = getJob(db, depId);
        if (!dep) return false;                  // 前置不存在 → 不放行（宁可不领也不要乱跑）
        if (dep.state !== JOB_STATE.DONE) return false;
    }
    return true;
}

// ───────────────────────────────────────────────────────────────────────────
// 父子单收敛（B3，06 §9.1）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 按子单状态收敛父单。
 *
 * 规则（06 §9.1）：
 *   · 所有子单 `done` → 父单 `done`
 *   · 有子单 `failed` 且没有还能再试的子单 → 父单 `blocked`
 *
 * @returns {{changed:boolean, parent?:object, reason?:string}}
 */
/**
 * ★★ 2026-11-04（t83）：**"卡住"的单，材料后来到了，要给它一次重试机会。**
 *
 *   真机证据（第 28 跑）：
 *     obtain crafting_table  blocked
 *       ├ craft oak_planks     done   prog={"count":4,"want":4}   dep=null
 *       └ craft crafting_table blocked «料不够合 crafting_table»  dep=["14_jb2"]  ← 依赖已满足！
 *
 *   `NO_ITEM` 在 `DIRECT_BLOCK_CODES` 里 → 直接进 `blocked`（**终态，永不重试**）。
 *   但在**依赖图**里，`NO_ITEM` 常常意味着"**材料还没做出来**" —— 那只是**暂时**的：
 *   它的兄弟单（`craft oak_planks`）正在做。等材料到了，它本该能跑，却因为早就是终态而永远不跑。
 *
 *   **这是"终态吃掉了后续机会"** —— 和 t60（bail-out 吃掉"挂着等"）同族：
 *   **把"暂时不能"判成了"永远不能"。**
 *
 *   修法：扫同一个父单下所有 `blocked` 的子单，若它的 `dependsOn` **现在全部 done**，
 *   就放回 `ready` 重试一次。用 `checkpoint.reopenedOnce` 记账，**只给一次机会**
 *   ——避免"真缺料又永远满足不了"时反复重开造成死循环。
 *
 * @returns {Array} 被重开的单（供调用方广播）
 */
export function reopenBlockedWithSatisfiedDeps(db, parentId = null, opts = {}) {
    const now = opts.now ?? Date.now();
    const rows = parentId == null
        ? db.prepare("SELECT id FROM jobs WHERE state = 'blocked'").all()
        : db.prepare("SELECT id FROM jobs WHERE state = 'blocked' AND parentId = ?").all(parentId);
    const out = [];
    for (const { id } of rows) {
        const job = getJob(db, id);
        if (!job) continue;
        const deps = Array.isArray(job.dependsOn) ? job.dependsOn : [];
        if (!deps.length) continue;                       // 没依赖 → NO_ITEM 是真缺料，不重开
        if (job.checkpoint?.reopenedOnce) continue;       // 只给一次机会
        if (!dependsSatisfied(db, job)) continue;         // 依赖还没满足 → 继续等
        const r = setState(db, id, JOB_STATE.READY, { now });
        if (!r.ok) continue;
        updateJob(db, id, { checkpoint: { ...(job.checkpoint ?? {}), reopenedOnce: true } });
        out.push(getJob(db, id));
    }
    return out;
}

export function rollupParent(db, parentId, opts = {}) {
    const now = opts.now ?? Date.now();
    const parent = getJob(db, parentId);
    if (!parent) return { changed: false, reason: 'no-parent' };
    if ([JOB_STATE.DONE, JOB_STATE.CANCELLED].includes(parent.state)) {
        return { changed: false, reason: 'parent-terminal' };
    }

    const children = db.prepare('SELECT * FROM jobs WHERE parentId = ?').all(parentId).map(rowToJob);
    if (!children.length) return { changed: false, reason: 'no-children' };

    const allDone = children.every((c) => c.state === JOB_STATE.DONE);
    if (allDone) {
        const r = setState(db, parentId, JOB_STATE.DONE, { now });
        return { changed: r.ok, parent: r.job, reason: 'all-children-done' };
    }

    const failed = children.filter((c) => c.state === JOB_STATE.FAILED);
    const blocked = children.filter((c) => c.state === JOB_STATE.BLOCKED);
    const stillAlive = children.some((c) => [
        JOB_STATE.READY, JOB_STATE.CLAIMED, JOB_STATE.RUNNING, JOB_STATE.PAUSED,
    ].includes(c.state));

    // ★ 2026-11-02 B3 真机验收补：**blocked 的子单也要能顶起父单**。
    //   原来只处理了 `failed`。实测：一张子单变 `blocked`（比如料不够/工具没了），
    //   父单既不是 done 也不是 blocked，就**永远停在 running** ——
    //   没人会再推进它，表现为"这个任务永远不结束"（静默卡死，比报错更难查）。
    if (blocked.length && !stillAlive) {
        const r = setState(db, parentId, JOB_STATE.BLOCKED, { now });
        return { changed: r.ok, parent: r.job, reason: `children-blocked(${blocked.length})` };
    }
    if (failed.length && !stillAlive) {
        const r = setState(db, parentId, JOB_STATE.BLOCKED, { now });
        return { changed: r.ok, parent: r.job, reason: `children-failed(${failed.length})` };
    }
    return { changed: false, reason: 'in-progress' };
}

/**
 * 拆单：按**数量**拆成 N 张子单（06 §9.1 第一种）。
 *
 * @param {object} db
 * @param {object} parentSpec { title, skill, args, countKey, total, parts, priority, source, requires, claimsFor }
 * @returns {{ok:true, parent:object, children:object[]}}
 */
export function splitByCount(db, parentSpec = {}, opts = {}) {
    const now = opts.now ?? Date.now();
    const total = Math.max(1, Math.floor(Number(parentSpec.total) || 1));
    const parts = Math.max(1, Math.floor(Number(parentSpec.parts) || 1));
    const countKey = parentSpec.countKey ?? 'count';
    const baseArgs = parentSpec.args ?? {};

    // 父单：一个不干活的壳（skill 为空），等子单收敛
    const parent = addJob(db, {
        kind: 'shared',
        title: parentSpec.title ?? `拆单：${parentSpec.skill}`,
        skill: null,
        args: { ...baseArgs, [countKey]: total },
        priority: parentSpec.priority ?? 5,
        source: parentSpec.source ?? 'panel',
        assignee: null,
        requires: parentSpec.requires ?? null,
        claims: null,
        state: JOB_STATE.RUNNING,
    }, { now });

    const children = [];
    const per = Math.floor(total / parts);
    let remainder = total - per * parts;
    for (let i = 0; i < parts; i++) {
        const n = per + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        if (n <= 0) continue;
        children.push(addJob(db, {
            kind: 'shared',
            parentId: parent.id,
            title: `${parentSpec.title ?? parentSpec.skill} (${i + 1}/${parts})`,
            skill: parentSpec.skill,
            args: { ...baseArgs, [countKey]: n },
            priority: parentSpec.priority ?? 5,
            source: `strat:${parent.id}`,
            assignee: null,
            requires: parentSpec.requires ?? null,
            claims: parentSpec.claimsFor ? parentSpec.claimsFor(i) : null,
            state: JOB_STATE.READY,
        }, { now }));
    }
    return { ok: true, parent, children };
}

/**
 * 拆单：按**区域**切成网格（06 §9.1 第二种）。
 *
 * @param {object} db
 * @param {object} spec { title, skill, args, center:{x,y,z}, size, cell=16, priority }
 */
export function splitByArea(db, spec = {}, opts = {}) {
    const now = opts.now ?? Date.now();
    const c = spec.center ?? { x: 0, y: 64, z: 0 };
    const size = Math.max(1, Math.floor(Number(spec.size) || 32));
    const cell = Math.max(1, Math.floor(Number(spec.cell) || 16));
    const cells = Math.max(1, Math.ceil(size / cell));
    const half = Math.floor(size / 2);

    const parent = addJob(db, {
        kind: 'shared',
        title: spec.title ?? `拆区：${spec.skill}`,
        skill: null,
        args: { ...spec.args, area: { x: c.x, y: c.y, z: c.z, size } },
        priority: spec.priority ?? 5,
        source: spec.source ?? 'panel',
        state: JOB_STATE.RUNNING,
    }, { now });

    const children = [];
    for (let gx = 0; gx < cells; gx++) {
        for (let gz = 0; gz < cells; gz++) {
            const x = c.x - half + gx * cell + Math.floor(cell / 2);
            const z = c.z - half + gz * cell + Math.floor(cell / 2);
            const r = Math.ceil(cell / 2);
            children.push(addJob(db, {
                kind: 'shared',
                parentId: parent.id,
                title: `${spec.title ?? spec.skill} [${gx},${gz}]`,
                skill: spec.skill,
                args: { ...spec.args, center: { x, y: c.y, z }, radius: r },
                priority: spec.priority ?? 5,
                source: `strat:${parent.id}`,
                // ★ 每块**预约自己的区域** —— 这就是"两个 bot 不会在同一片地方干"的机制
                claims: [`area:${x},${c.y},${z}:${r}`],
                state: JOB_STATE.READY,
            }, { now }));
        }
    }
    return { ok: true, parent, children };
}

// ───────────────────────────────────────────────────────────────────────────
// 共享数据（B4，06 §9.3）：地标 / 危险点 / 箱子内容
//
// ★ 为什么 `terrain3d` **不在**这里（06 §9.3 原文，抄下来免得以后有人"顺手"合并）：
//   「3D 地形库 `terrain3d`：每个 bot 一份 SQLite —— **暂不共享**：
//     多进程写同一个 SQLite 要处理 WAL 和 busy 重试，收益不值。」
//   也就是说：任务是低频、小体积、必须一致的东西（共享）；地形是高频、大体积、
//   每只 bot 各扫各的本来就不同（不共享）。**不要**把 terrain3d 搬进来。
// ───────────────────────────────────────────────────────────────────────────

/** 共享数据的三种 namespace（06 §9.3）。 */
export const SHARED_KINDS = Object.freeze(['landmark', 'danger', 'chest']);

/**
 * 写一条共享数据（upsert）。
 *
 * `key` 的语义按 kind 不同：
 *   landmark → 名字（'home' / 'mine_entrance'）
 *   danger   → `x,z`（危险是点+半径）
 *   chest    → `x,y,z`（箱子按坐标唯一）
 */
export function putShared(db, kind, key, value, opts = {}) {
    const now = opts.now ?? Date.now();
    if (!SHARED_KINDS.includes(kind)) return { ok: false, code: 'INTERNAL', message: `未知共享种类 ${kind}` };
    if (key == null || String(key) === '') return { ok: false, code: 'NO_TARGET', message: '共享数据需要 key' };
    const owner = opts.owner ?? null;
    db.prepare(`INSERT INTO shared (kind, key, value, owner, updatedAt) VALUES (?,?,?,?,?)
        ON CONFLICT(kind, key) DO UPDATE SET value=excluded.value, owner=excluded.owner, updatedAt=excluded.updatedAt`)
        .run(String(kind), String(key), JSON.stringify(value ?? null), owner, now);
    return { ok: true, kind, key: String(key) };
}

/** 读一条（没有返回 null）。 */
export function getShared(db, kind, key) {
    const row = db.prepare('SELECT * FROM shared WHERE kind=? AND key=?').get(String(kind), String(key));
    return row ? sharedRowToObj(row) : null;
}

/** 列某一类的全部（`kind` 为空则全部）。 */
export function listShared(db, kind = null) {
    const rows = kind
        ? db.prepare('SELECT * FROM shared WHERE kind=? ORDER BY updatedAt DESC').all(String(kind))
        : db.prepare('SELECT * FROM shared ORDER BY kind, updatedAt DESC').all();
    return rows.map(sharedRowToObj);
}

/** 删一条。 */
export function delShared(db, kind, key) {
    const r = db.prepare('DELETE FROM shared WHERE kind=? AND key=?').run(String(kind), String(key));
    return { ok: true, deleted: Number(r.changes ?? 0) };
}

/**
 * 找"哪个箱子有这个物品"（B4 验收核心：A 存的，B 不开箱就能知道）。
 *
 * @returns {Array<{key:string, pos:{x,y,z}, count:number, owner:string|null}>}
 */
export function findItemInSharedChests(db, itemName, opts = {}) {
    const want = String(itemName ?? '');
    if (!want) return [];
    const minCount = Number(opts.minCount ?? 1);
    const out = [];
    for (const row of listShared(db, 'chest')) {
        const items = row.value?.items ?? row.value?.contents ?? null;
        if (!items || typeof items !== 'object') continue;
        const n = Number(items[want] ?? 0);
        if (Number.isFinite(n) && n >= minCount) {
            out.push({ key: row.key, pos: row.value?.pos ?? parseChestKey(row.key), count: n, owner: row.owner });
        }
    }
    // 多的排前面（和 landmarks.findItemInChests 的口径一致）
    return out.sort((a, b) => b.count - a.count);
}

function parseChestKey(key) {
    const p = String(key ?? '').split(',').map(Number);
    if (p.length !== 3 || p.some((v) => !Number.isFinite(v))) return null;
    return { x: p[0], y: p[1], z: p[2] };
}

function sharedRowToObj(row) {
    let value = null;
    try { value = row.value == null ? null : JSON.parse(row.value); } catch { value = null; }
    return { kind: row.kind, key: row.key, value, owner: row.owner, updatedAt: row.updatedAt };
}

/**
 * 一次性把旧的分域文件搬进板库（**搬完就废弃旧文件，不两边都读**）。
 *
 * 为什么要搬：B1–B3 之前地标/危险/箱子在 `bots/<name>/memory/*.json`，每只 bot 各一份，
 * 于是 A 记的箱子 B 看不见（B4 要解决的就是这个）。
 *
 * 规则（06 §9.3 + 用户要求"不许两份真相"）：
 *   · 每个 namespace 只搬一次（板库里已有该 namespace 的任何行就跳过，幂等）
 *   · 搬完在返回值里报告搬了多少条
 *   · **旧文件不删**（保留作事故取证），但**代码路径不再读它** —— 这一点写在下面各 API 的注释里
 *
 * @param {object} db
 * @param {object} bot
 * @param {object} reader { readStore(bot, ns) } 注入，避免 store 反向依赖 agent 侧
 * @returns {{moved:object, skipped:string[]}}
 */
export function migrateLocalToBoard(db, bot, reader, opts = {}) {
    const moved = {};
    const skipped = [];
    const now = opts.now ?? Date.now();
    const hasAny = (kind) => {
        const r = db.prepare('SELECT COUNT(*) AS n FROM shared WHERE kind=?').get(kind);
        return Number(r?.n ?? 0) > 0;
    };

    // 地标（sites + storage）
    if (hasAny('landmark')) skipped.push('landmark');
    else {
        let n = 0;
        const sites = (() => { try { return reader.readStore(bot, 'sites') || []; } catch { return []; } })();
        for (const s of (Array.isArray(sites) ? sites : [])) {
            if (!s || !Number.isFinite(s.x)) continue;
            putShared(db, 'landmark', s.name ?? `site_${s.x}_${s.z}`, s, { now });
            n++;
        }
        const storage = (() => { try { return reader.readStore(bot, 'storage') || null; } catch { return null; } })();
        if (storage && Number.isFinite(storage.x)) { putShared(db, 'landmark', 'storage', storage, { now }); n++; }
        moved.landmark = n;
    }

    // 危险点
    if (hasAny('danger')) skipped.push('danger');
    else {
        const dangers = (() => { try { return reader.readStore(bot, 'dangers') || []; } catch { return []; } })();
        let n = 0;
        for (const d of (Array.isArray(dangers) ? dangers : [])) {
            if (!d || !Number.isFinite(d.x)) continue;
            putShared(db, 'danger', `${Math.floor(d.x)},${Math.floor(d.z)}`, d, { now });
            n++;
        }
        moved.danger = n;
    }

    // 箱子（landmarks 的 chests 文件 —— 注意**不是** flow_store 那个 map 形状的）
    if (hasAny('chest')) skipped.push('chest');
    else {
        const chests = (() => { try { return reader.readStore(bot, 'chests') || []; } catch { return []; } })();
        let n = 0;
        for (const c of (Array.isArray(chests) ? chests : [])) {
            if (!c || !Number.isFinite(c.x)) continue;
            const key = `${Math.floor(c.x)},${Math.floor(c.y)},${Math.floor(c.z)}`;
            putShared(db, 'chest', key, { pos: { x: c.x, y: c.y, z: c.z }, items: c.contents ?? {}, category: c.category ?? null, note: c.note ?? '' }, { now });
            n++;
        }
        moved.chest = n;
    }
    return { moved, skipped };
}
