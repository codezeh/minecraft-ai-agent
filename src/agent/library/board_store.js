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
    notBefore INTEGER, repeat_ms INTEGER,
    dependsOn TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, priority, createdAt);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_until);

-- 预约表：B1 建表但不填（B3 才真正用，06 §9.2）
CREATE TABLE IF NOT EXISTS claims (
    id TEXT NOT NULL, key TEXT NOT NULL, owner TEXT, until INTEGER,
    PRIMARY KEY (id, key)
);
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

const JSON_COLS = new Set(['args', 'requires', 'claims', 'progress', 'checkpoint', 'result', 'dependsOn']);

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
         state, attempts, maxAttempts, lease_owner, lease_until, progress, checkpoint, result,
         notBefore, repeat_ms, dependsOn, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
 * @param {object} filter { states?, mine?, assignee?, skill?, limit? }
 */
export function listJobs(db, filter = {}) {
    const where = [];
    const params = [];
    if (Array.isArray(filter.states) && filter.states.length) {
        where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
        params.push(...filter.states);
    }
    if (filter.assignee) { where.push('assignee = ?'); params.push(filter.assignee); }
    if (filter.skill) { where.push('skill = ?'); params.push(filter.skill); }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY priority DESC, createdAt ASC
                 LIMIT ?`;
    params.push(Number.isFinite(filter.limit) ? filter.limit : 200);
    return db.prepare(sql).all(...params).map(rowToJob);
}

/**
 * 领单（**原子**）。
 *
 * ★ 规则①：只用一条 `UPDATE ... WHERE state='ready'`，靠 **`changes`** 判断成败。
 *   绝不"先 SELECT 再 UPDATE" —— 那中间有个窗口，两个 bot 会同时领到同一张单。
 *
 * 个人单优先（assignee 是自己），再多人单（assignee 为 null）；按 priority DESC、createdAt ASC。
 *
 * @returns {object|null} 领到的单；没有可领的返回 null
 */
export function claimFor(db, bot, opts = {}) {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? LEASE_MS;

    // 候选：ready 且（个人单是我的 或 多人单没指派）；notBefore 已到
    const cands = db.prepare(`
        SELECT id FROM jobs
        WHERE state = 'ready'
          AND (assignee IS NULL OR assignee = ?)
          AND (notBefore IS NULL OR notBefore <= ?)
        ORDER BY (assignee = ?) DESC, priority DESC, createdAt ASC
        LIMIT 8`).all(bot, now, bot);

    for (const c of cands) {
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

    if (completed) {
        next = JOB_STATE.DONE;
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

    if (!canTransition(job.state, next)) {
        return { ok: false, code: 'INTERNAL', message: `非法转移 ${job.state} → ${next}` };
    }

    const attempts = counted ? job.attempts + 1 : job.attempts;
    db.prepare(`UPDATE jobs
        SET state=?, attempts=?, lease_owner=NULL, lease_until=NULL,
            progress=?, checkpoint=?, result=?, updatedAt=?
        WHERE id=?`).run(
        next, attempts,
        j(progress ?? job.progress),
        j(result.checkpoint ?? job.checkpoint),
        j({ ok: okFlag, code, message: result.message ?? '', at: now }),
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
    'lease_owner', 'lease_until', 'notBefore', 'repeat_ms', 'title', 'why', 'args', 'requires', 'claims']);

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
