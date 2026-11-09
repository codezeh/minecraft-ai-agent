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
// ★ BOARD-003：`attemptSeqOfJob` —— "这张单现在是第几次尝试"的**唯一口径**
//   （收尾归属校验 attemptGuardSql / 保留序号 / 客户端都读它，避免各判一遍）。
import { claimsConflict, normalizeClaimKeys, parseClaimKey, attemptSeqOfJob } from './board_claims.js';

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

/**
 * **任务板结果码**（写在 `result.code` 上）。
 *
 * ★ 它和 contract 的 ActionResult `CODES` **是两套词汇表**，不要混
 *   （T02/preflight §3 已裁决 `DIED` 属这一类，不进 CODES —— 塞进去会让
 *   `assertResult` 误认它是 ActionResult 码）。
 * ★ 所以这里**具名化**：对象字面量里直接写死一个全大写的 code 字符串，
 *   会被 preflight §3 判成"未注册错误码"，而这些码本就不该进 CODES。
 *   具名常量既不改线上字符串，也不污染那套词表。
 *   （★ 这条注释本身也不能出现那种字面量：preflight 的正则**会扫注释** ——
 *     我第一版就在注释里写了个样本，结果被自己的审计抓成"未注册码 XXX"，已改成散文。）
 */
export const BOARD_RESULT_CODES = Object.freeze({
    LEASE_STALE: 'LEASE_STALE',
    LEASE_EXPIRED: 'LEASE_EXPIRED',
    DEP_DEAD: 'DEP_DEAD',
    ORPHAN_PARENT: 'ORPHAN_PARENT',
});

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

// ───────────────────────────────────────────────────────────────────────────
// 库结构版本与幂等迁移（第24条）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 板库结构版本（写在 `PRAGMA user_version`）。
 *
 * ★ 为什么必须有它：`CREATE TABLE IF NOT EXISTS` 只建"**不存在的表**"，
 *   **不会给已存在的表补列**。而以前"加一列"只有一条路 —— 让 `openBoard` 把
 *   "缺列"当成库损坏、改名重建空库（见 `isCorruptError`）。于是**每次加字段都在丢单**，
 *   而且丢得"合理"（日志写着"库损坏已重建"）。
 *   有了版本号，"加列"变成一次**幂等迁移**：读版本 → 补列 → 写回。
 *
 * ★ 为什么 BOARD-003 **没有**新增 `attemptSeq` 列：`claimFor` 早就把当前尝试序号写在
 *   `checkpoint.attemptSeq` 上，而 `checkpoint` 本来就是这张单的"进度/断点"载体。
 *   再加一列等于**同一件事有两个真相**：要么两处都要在领单时写，要么迟早漂移。
 *   所以收尾归属校验直接读 `checkpoint.attemptSeq`（见 `attemptGuardSql`），
 *   不新增列、不做迁移、不回填老库。
 */
export const BOARD_SCHEMA_VERSION = 2;

/**
 * 从 `SCHEMA` 里抽出 `jobs` 表的列定义（`[{name, def}]`）。
 *
 * ★ 故意**从建表语句抽**，而不是另写一份列清单：两份清单一定会漂移
 *   （这正是全仓反复出现的"两个地方都以为自己在管同一件事"）。
 *   以后往 `SCHEMA` 里加一列，迁移**自动**纳管。
 */
export function jobColumnDefs(schema = SCHEMA) {
    const head = 'CREATE TABLE IF NOT EXISTS jobs (';
    const start = typeof schema === 'string' ? schema.indexOf(head) : -1;
    if (start < 0) return [];
    const open = schema.indexOf('(', start);
    const close = schema.indexOf('\n);', open);
    if (open < 0 || close < 0) return [];
    return schema.slice(open + 1, close).split(',')
        .map((def) => def.trim()).filter(Boolean)
        .map((def) => ({ name: def.split(' ')[0], def }));
}

/**
 * 幂等迁移：把「老库缺的列」补上，再写回 `PRAGMA user_version`。
 *
 * @returns {{added:string[], from:number, to:number}} 无事可做时 `added` 为空数组
 */
export function migrateBoardSchema(db) {
    // ★ 表还不存在（全新库）→ 无事可做：`SCHEMA` 会一次建全，不需要"补列"。
    //   （而且 `ALTER TABLE jobs` 对不存在的表必然报错。）
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
    if (!exists) {
        const from0 = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
        return { added: [], from: from0, to: BOARD_SCHEMA_VERSION, skipped: 'no-table' };
    }
    const have = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((r) => String(r.name)));
    const added = [];
    for (const { name, def } of jobColumnDefs()) {
        if (have.has(name)) continue;
        // ★ `ALTER TABLE ... ADD COLUMN` 不接受「NOT NULL 且无 DEFAULT」的列（SQLite 直接报错）。
        //   这种列只能退化成**可空**：老行本来就没这个值，硬塞一个默认值等于编造数据。
        let ddl = def;
        if (/NOT NULL/i.test(ddl) && !/DEFAULT/i.test(ddl)) ddl = ddl.replace(' NOT NULL', '');
        db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`);
        added.push(name);
    }
    const from = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (from !== BOARD_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${BOARD_SCHEMA_VERSION}`);
    return { added, from, to: BOARD_SCHEMA_VERSION };
}

/** 只有这两个 SQLite 错误码算"文件真的坏了"：11 = SQLITE_CORRUPT、26 = SQLITE_NOTADB。 */
const CORRUPT_ERRCODES = new Set([11, 26]);

/**
 * 异常是不是「**库文件真的坏了**」。
 *
 * ★★★ 第3条的病根就在这里：`openBoard` 原来把 `tryOpen()` 的**任何**异常都当成库损坏
 *   → `rename`/`rm` 掉原文件 → 建空库。最刺眼的一种组合：
 *   另一个进程 `BEGIN EXCLUSIVE` 持锁 → 这边拿到的是 `SQLITE_BUSY(5)`
 *   （message "database is locked"）→ 被当成"文件坏了" → **好库被改名、工单全丢**，
 *   日志还写着"库损坏已重建空库"（看起来像文件的问题，实际是我的判据写错了）。
 *
 * → 判据收到两条：`errcode ∈ {11, 26}`，或 message 明确是 "file is not a database" /
 *   "malformed"（不同 SQLite 构建措辞不同，留一道兜底）。
 * → **其余一律原样 throw**：让调用方看见真错误（锁忙 / 权限 / 磁盘满），
 *   绝不能"因为读不到就把数据删了换个空库"。
 */
export function isCorruptError(e) {
    const code = Number(e?.errcode ?? NaN);
    if (CORRUPT_ERRCODES.has(code)) return true;
    const msg = String(e?.message ?? e ?? '');
    return /file is not a database|malformed|not a database/i.test(msg);
}

/**
 * 打开（必要时创建）板库。
 *
 * ★ "库损坏自动重建空库"（用户决策②）：板是**可重建的调度状态**，不是用户数据；
 *   宁可丢单也不能让整个 agent 起不来。做法：SQLite 打开/建表抛错 → 把坏文件改名留证
 *   （`.corrupt-<时间戳>`）→ 建新库。**不静默删**，坏文件留着能查。
 *
 * @param {string} dir 板库目录。**必填，无默认值** —— 见下方 R6 #1 说明。
 * @returns {{db:DatabaseSync, dir:string, path:string, rebuilt:boolean}}
 */
export function openBoard(dir) {
    // ★★★ R6 #1（2026-11-10）：**取消默认目录**。
    //
    //   原来的签名是 `openBoard(dir = boardDirOf())`，默认指向 `bots/_board` —— 那是**生产库**。
    //   后果：任何"忘了传参"的调用都会静默操作线上数据。实测 `tools/board_b3_live.mjs:128-131`
    //   等 12 个 live 工具就是无参调用，随后 `DELETE FROM jobs` / `DELETE FROM claims`；
    //   生产库当时 jobs=0/claims=0 且目录内无 `.corrupt-*` 备份（正常 DELETE 不留备份，删了就是删了）。
    //
    //   现在：谁要生产库，谁就显式写出来（唯一合法调用方是 mindserver.js:965 的 `openBoard(boardDirOf())`）。
    //   工具/临时脚本一律用 `tools/_tmp_board.mjs` 的 `openTempBoard()`，每次跑一个新临时目录。
    //   宁可让忘记传参的脚本**当场报错**，也不让它静默清库。
    if (!dir) {
        throw new Error(
            'openBoard(dir) 必须显式传板库目录：默认值 bots/_board 是生产库，' +
            '无参调用会直接清空线上任务与预占（R6 #1）。' +
            '生产侧请传 boardDirOf()；临时脚本请用 tools/_tmp_board.mjs 的 openTempBoard()。'
        );
    }
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
        // ★★ 第24条：**必须先迁移、再跑 SCHEMA**。
        //   因为 `SCHEMA` 里除了建表还有 `CREATE INDEX ... ON jobs(state, priority, createdAt)` ——
        //   老库缺 `priority` 时，索引语句会先炸（`no such column: priority`），
        //   于是"补列"永远等不到执行的机会（实测踩到）。
        //   顺序：① 老库补列 → ② 建表（IF NOT EXISTS，存在即 no-op）→ ③ 建索引。
        const migration = migrateBoardSchema(db);
        db.exec(SCHEMA);
        return { db, migration };
    };

    try {
        const opened = tryOpen();
        return { db: opened.db, dir, path, rebuilt: false, migration: opened.migration };
    } catch (e) {
        // ★★★ 第3条：**只有"文件真的坏了"才重建**。
        //   锁忙（另一个进程 BEGIN EXCLUSIVE）/ 权限 / 磁盘满 → 一律原样抛出去。
        //   以前这里无条件往下走，等于"读不到就把库删了"—— 比不启动严重得多。
        if (!isCorruptError(e)) {
            try { lastDb?.close?.(); } catch { /* 关不掉也继续抛 */ }
            lastDb = null;
            throw e;
        }
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
            db = tryOpen().db;
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

    // ★★★ 第14条：`openOnly` —— **把"未终结"的过滤放进 SQL**。
    //
    //   病根：`LIMIT 200` + `ORDER BY priority DESC, createdAt ASC`（同级取最老）。
    //   `jobs` 表**从不删除**（全仓无 DELETE FROM jobs），累计超过 200 张单后，
    //   最老的 200 张把窗口占满 → **新单进不了调度器视野**，抢占/残局回收静默失效。
    //   （同族事故：t141/t142 在 `convergeOrphanParents` 上踩的是同一个坑。）
    //   → 过滤必须在 SQL 里：结果集天然小，LIMIT 永远不会被历史垃圾占满。
    if (filter.openOnly) { where.push("state NOT IN ('done','failed','cancelled')"); }
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
 * ★ 例外（第15条）：`craft` 单的判据是 `want > 0 且 checkpoint.producedTotal >= want`
 *   —— 它的 `progress.count` 历史语义是"背包总量"，不能当进度用（见函数体 t120 注释）。
 *   没有 `producedTotal` 的老 row 不收敛。
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

    // ★★★ 2026-11-04（t120）：**`craft` 单不能用"背包总数"收敛。**
    //
    //   真机证据（第 47/48 跑，两轮完全一样）：
    //     `craft wooden_pickaxe → missing:{"oak_planks":1}`
    //     而所有 `craft oak_planks` 都 done。
    //
    //   机制：`craft` 的 `progress.want` 语义是"**这一单还要再做几个**"，
    //   而 `progress.count` 被赋成"**背包里该物品总数**"（`strat_obtain` 的 `count` = `countInventory`）。
    //   两个口径不同 → 当同一物品被多处需要（木镐要 3 板、木棍又要 2 板）时：
    //     · 第一张 `c=3` 做完 → 背包 4 块
    //     · 第二张 `c=2`：`count=4 ≥ want=2` → **这里提前收敛、压根不合成**
    //     · `craft stick` 吃掉 2 块 → 剩 2 块 → 木镐要 3 块 → **missing: 1**
    //
    //   修法：**`craft` 单必须真的跑一次**（它才是产出动作），不做"按库存收敛"。
    //   `mine`/`collect`/`obtain` 这些"弄到 N 个"的语义用库存收敛是对的（库存真有就够了），
    //   所以只对 `craft` 关掉 —— 改动面最小。
    //
    // ★★★ 第15条（R1 收尾）：**craft 的收敛改成看"产出账"，不是关掉。**
    //
    //   t120 关掉它是对的 —— 因为当时的 `count` 是"背包总量"，拿它当进度必然误判。
    //   现在 `finish` 会给每张 craft 单记 `checkpoint.producedTotal`（**本单累计产出**），
    //   这才是"这张单真的做够数了"的判据。于是：
    //     · 有账且 ≥ want → 可以收敛（**这就是"重试不再扣第二次料"的关键**：
    //       被打断后回 ready 的单，下一轮 claim 时在这里直接收敛成 done，不再跑一遍流程）
    //     · **没有账的老行（producedTotal 缺失）→ 仍然不收敛**（保持 t120 的行为，不猜）
    const isCraft = String(job.skill) === 'craft';
    let count;
    if (isCraft) {
        count = Number(job.checkpoint?.producedTotal);
        if (!Number.isFinite(count)) return null;             // 老行没有产出账 → 不收敛
    } else {
        count = Number(job.progress?.count ?? 0);
    }
    if (!(want > 0) || count < want) return null;            // 没达标 → 不收敛

    if (isTerminal(job.state)) return job;                    // 已是终态
    if (!canTransition(job.state, JOB_STATE.DONE)) return null;

    db.prepare(`UPDATE jobs
        SET state=?, lease_owner=NULL, lease_until=NULL, result=?, updatedAt=?
        WHERE id=? AND state=?`).run(
        JOB_STATE.DONE,
        j({
            ok: true, code: 'OK',
            message: isCraft
                ? `产出账已达标（本单已产出 ${count}/${want}），直接收敛为 done —— 不再重跑（不重复扣料）`
                : `进度已达标（${count}/${want}），直接收敛为 done`,
            reason, at: now,
            ...(isCraft ? { craftLedger: { producedTotal: count } } : {}),
        }),
        now, id, job.state,
    );
    return getJob(db, id);
}

/**
 * ★★★ BOARD-003（2026-11-06 深度检查）：**尝试标识守卫**。
 *
 * 病根：租约归属只核对**机器人名字**（`lease_owner = ?`）。于是
 *   `claim(attemptSeq=1)` → 租约过期被回收 → **同名**再领（attemptSeq=2）
 *   → 旧尝试的**迟到** finish 仍满足 `lease_owner = 我` → 被当成当前尝试的结果接受，
 *   清掉新租约并把任务置 done。报告实测：staleAccepted=true、最终 done。
 *   （`attemptSeq` 早就存在，只是从没用于收尾归属校验。）
 *
 * 修法：把「这次写入属不属于当前尝试」做成 **SQL 条件**（和租约守卫一样落在
 *   `changes` 上，不能用"先读再写"的快照判断，那中间仍有窗口）。
 *   老行没有 `attemptSeq`（json_extract → NULL）时**不加约束**，保持旧行为，
 *   这样离线工具/历史数据不受影响。
 *
 * @param {number|string|null|undefined} attemptSeq 调用方带来的尝试序号
 * @returns {{sql:string, params:Array}} 可直接拼进 `WHERE id=?` 之后
 */
function attemptGuardSql(attemptSeq) {
    const n = Number(attemptSeq);
    if (attemptSeq == null || attemptSeq === '' || !Number.isFinite(n)) return { sql: '', params: [] };
    return {
        sql: " AND (json_extract(checkpoint,'$.attemptSeq') IS NULL"
            + " OR CAST(json_extract(checkpoint,'$.attemptSeq') AS INTEGER) = ?)",
        params: [n],
    };
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
    //
    // ★★★ BOARD-001（2026-11-06 深度检查）：**不能先截断再过滤**。
    //
    //   缺陷原貌：这里原来是 `LIMIT 16` —— 先把高优先级的前 16 张捞出来，再逐张做
    //   `convergeIfSatisfied` / `meetsRequires` / `dependsSatisfied` 过滤。
    //   于是"前 16 张都在等前置、真正可执行的前置单排在第 17 位"时：
    //   16 张全部 `continue` → `return null` → 下一轮**捞到的还是同一批** → 调度停摆。
    //   报告实测：16 张 priority=9 的单依赖一张 priority=5 的前置单，连续两次 claim
    //   都是 null，而那张前置单一直是 ready —— 状态看着有活，实际一张都领不出。
    //
    //   修法：**去掉截断**，按同一顺序扫到底（只在找到可领的就 return，所以正常情况
    //   第 1 张就结束）。`MAX_SCAN` 只是防御病态积压（10 万张单不该让一次 claim 卡住），
    //   不是调度窗口 —— 它比原来的 16 大三个数量级，不会重新引入饿死。
    const MAX_SCAN = 5000;
    const cands = db.prepare(`
        SELECT id FROM jobs
        WHERE state = 'ready'
          AND (assignee IS NULL OR assignee = ?)
          AND (notBefore IS NULL OR notBefore <= ?)
        ORDER BY (assignee = ?) DESC, priority DESC, createdAt ASC
        LIMIT ?`).all(bot, now, bot, MAX_SCAN);

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
        // ★★★ 第15条（R1 收尾）：**每次领单 = 新的一次尝试**，在这里打一个只增的序号。
        //
        //   为什么需要它：`attempts` 不足以区分"**同一次尝试被重复 finish**"和"**下一次尝试**"
        //   —— 因为 `attempts` 只在 finish 计数的**那一刻**才 +1，两次 finish 之间它是不动的。
        //   而产出账必须分清这两件事：重复 finish 不许多记账，换了一次尝试必须累加。
        //   领单是**唯一**能开始新尝试的入口，所以序号打在这里。（老 row 没有 `attemptSeq`
        //   → `settleCraftLedger` 按"不同尝试"处理，即**只会少记、不会虚记**。）
        const cpForClaim = j({
            ...(candJob.checkpoint && typeof candJob.checkpoint === 'object' ? candJob.checkpoint : {}),
            attemptSeq: (Number(candJob.checkpoint?.attemptSeq) || 0) + 1,
        });
        // 原子抢：**这一条**就是全部关键。changes===1 → 我抢到了；0 → 别人先抢走了，试下一个
        const r = db.prepare(`
            UPDATE jobs SET state='claimed', assignee=?, lease_owner=?, lease_until=?, checkpoint=?, updatedAt=?
            WHERE id = ? AND state = 'ready'`).run(bot, bot, now + leaseMs, cpForClaim, now, c.id);
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
    // ★★★ BOARD-003：心跳也要校验尝试标识 —— 否则"租约过期→同名重领"之后，
    //   旧尝试还能继续给新尝试续租/写进度，把新租约的 until 往前推、把进度覆盖。
    const hbGuard = attemptGuardSql(opts.attemptSeq);
    const hb = db.prepare(`UPDATE jobs SET lease_until=?, state=?, progress=?, updatedAt=? WHERE id=?${hbGuard.sql}`)
        .run(now + leaseMs, nextState, j(merged.progress), now, id, ...hbGuard.params);
    if (hb.changes === 0) return { ok: false, code: 'LEASE_LOST' };

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

// ───────────────────────────────────────────────────────────────────────────
// craft 单的「产出账」（R1 终审 §9 第 1 项 / 报告第 15 条）
// ───────────────────────────────────────────────────────────────────────────
/**
 * 从流程结果里取「本次尝试到目前为止产出了几个」（单位：**件**，不是合成次数）。
 *
 * 取值优先级（**宁可少记，绝不虚记**）：
 *   ① `data.producedTotal` —— 动作层自报的累计（`act_craft` 的 `after - before`）；
 *   ② `data.produced`      —— 动作层自报的单次真实产出（同一口径）；
 *   ③ `progress.count`     —— **只在流程报 `ok` 时**采信（那时它就是 `flow_craft` 的产出增量）；
 *   ④ 都没有 → **0**（不猜）。
 *
 * ★ 为什么不用 `data.count`、也不在失败分支采信 `progress.count`：
 *   `flow_craft` 的失败分支写的是 `base = { count: r.data?.got ?? got }`，而 `got` 在
 *   `act_craft` 里是 `limit`（**合成次数**）。perCraft=1 的配方下"要 3 次只做出 1 件"是常态
 *   → 拿次数当件数会**虚记**。**虚记比不记危险得多**：账报大了，单子会被判"已达标"
 *   而提前 done（该做的活没做）。宁可少记：失败分支只认动作层明确报出的 `produced*`。
 */
export function craftProducedOf(result) {
    const d = result?.data ?? null;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
    const explicit = num(d?.producedTotal);
    if (explicit != null) return explicit;
    const perCall = num(d?.produced);
    if (perCall != null) return perCall;
    if (result?.ok === true) {
        const fromProgress = num(result?.progress?.count);
        if (fromProgress != null) return fromProgress;
    }
    return 0;
}

/**
 * 结算一张 craft 单的产出账 —— **按增量**累加，写进 `checkpoint.producedTotal`。
 *
 * 病灶（报告第 15 条）：库里**没有任何"这张单已经产出过多少"的账**。
 * `act_craft` 的 `produced` 只活在返回值里，`finish` 之后连痕迹都没有
 * （`progress.count` 对 craft 是"背包里该物品总数"，被 `mergeProgress` 取 max，
 * 看不出"重试扣了几次料"）。于是「做出东西 → 被打断/失败 → 重跑」每重跑一次
 * 就**真扣一次材料**，而账面看不出来 —— 玩家看到的是"材料莫名少了，单子还在跑"。
 *
 * 现在：`producedTotal` = 本单**跨尝试累计**产出（单调不减）。
 * 增量口径 = **本次产 − 上次已计**（同一个 attempt 里用 `checkpoint.producedAttempt`
 * 当"上次已计"），所以同一次尝试被重复 finish（收敛后再收尾 / 崩溃重放）不会重复记账。
 *
 * ★ 边界（如实说明，别夸大）：checkpoint 只在 **finish**（或显式塞断点）时落库。
 *   进程被 SIGKILL 时这次尝试**根本没走到 finish** → 这次产出记不进库 → 重试仍会重做一份。
 *   它能覆盖的是"**走到了 finish 的那一类**"：INTERRUPTED / TIMEOUT / 部分产出后失败 /
 *   后续步骤失败 / 被抢占后收尾 —— 这一类正是"重试重复扣料"的原发场景。
 *
 * @returns {{producedTotal:number, attemptProduced:number, countedSeq:number|null, delta:number, prevProducedTotal:number}}
 */
export function settleCraftLedger(job, result) {
    const cp = (job?.checkpoint && typeof job.checkpoint === 'object') ? job.checkpoint : {};
    const prevTotal = Math.max(0, Number(cp.producedTotal) || 0);
    const reported = craftProducedOf(result);
    // 「是不是同一次尝试」用 `claimFor` 打上的只增序号（`attemptSeq`）判，
    // **不能用 `attempts`** —— attempts 只在 finish 计数时才 +1，区分不开
    // "同一次尝试重复 finish" 与 "下一次尝试"（见 claimFor 里的注释）。
    const seq = Number(cp.attemptSeq);
    const countedSeq = Number(cp.countedSeq);
    const sameAttempt = Number.isFinite(seq) && Number.isFinite(countedSeq) && countedSeq === seq;
    const alreadyCounted = sameAttempt ? Math.max(0, Number(cp.producedAttempt) || 0) : 0;
    const delta = Math.max(0, reported - alreadyCounted);        // 本次产 − 上次已计 = 本次应记
    return {
        producedTotal: prevTotal + delta,
        attemptProduced: Math.max(alreadyCounted, reported),
        countedSeq: Number.isFinite(seq) ? seq : null,
        delta,
        prevProducedTotal: prevTotal,
    };
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

    // ★★★ 第4条：`opts.bot` = 调用者身份。传了就必须过租约归属校验；
    //   不传（老调用方没有身份）保持旧行为，不做归属校验。
    const bot = opts.bot == null || opts.bot === '' ? null : String(opts.bot);
    const now = opts.now ?? Date.now();
    const job = getJob(db, id);
    if (!job) return { ok: false, code: 'NO_TARGET' };

    // ★★ T6（架构收敛项 3）：**finish 必须校验"当前 state 允许被收尾"**。
    //
    //   原来只有"租约归属"这一道（`lease_owner IS NULL OR = 我`），没看状态 ——
    //   于是 `pending` / `blocked` 这种**根本没有执行者**的单也能被 finish 写进去。
    //   `blocked` 是"等前置/等资源"的挂起态，一次迟到的 finish 会按"失败一次"把它
    //   推回 ready 重新派单，而它的前置可能仍然没好 ⇒ blocked/ready 反复抖动。
    //   判据取"**真的有人可能正在跑它**"的四个状态：
    //     claimed / running（正常在跑）、paused（按停后收尾）、
    //     ready（无人持有的草稿态，保持既有语义："没人持有 ⇒ 谁都可能是合法收尾者"）。
    //   只拒 `pending` / `blocked` / 终态 —— 不改变任何正常路径。
    //   ★ 需要老的宽松行为时显式传 `{ anyState: true }`（离线夹具/工具）。
    const FINISHABLE_STATES = [JOB_STATE.READY, JOB_STATE.CLAIMED, JOB_STATE.RUNNING, JOB_STATE.PAUSED];
    if (opts.anyState !== true && !FINISHABLE_STATES.includes(job.state)) {
        return {
            ok: false, code: BOARD_RESULT_CODES.LEASE_STALE,
            message: `单 ${id} 的状态是 ${job.state}，不该被 finish（一个字段都没写）`,
        };
    }

    const code = result.code ?? 'OK';
    const okFlag = result.ok === true;
    // ★ 同样单调：finish 报的 progress 不能把已有的进度压小
    const merged = mergeProgress(job.progress, result.progress ?? null);
    const progress = merged.progress ?? job.progress ?? null;
    const count = Number(progress?.count ?? 0);
    const want = Number(progress?.want ?? 0);
    // 规则③：ok **且** count>=want 才算完成；want 未知（0）时退化为只看 ok
    //
    // ★★★ 2026-11-04（t125）：**`craft` 单不能用 `count >= want` 这个短路。**
    //
    //   真机证据（第 51 跑，三轮完全一致）：
    //     `craft:oak_planks x1` → `state=done`、`attempts=0`、**木板数始终停在 2**
    //     而轮2 她手上有 **6 个原木**（够做 24 块板）→ **这张单报了 done 却零产出**。
    //
    //   机制就在这里：`want=1`、`count`=**背包里 oak_planks 总数=2** → `2 >= 1` → `completed=true` → DONE。
    //   **但 `count` 是"库存总量"，`want` 是"这张单要做几个"** —— 两个口径不同（今晚第 4 次同族）。
    //   她本来就有 2 块板，所以"看起来达标"，可这单根本不需要做就会被标完成。
    //
    //   t120 只关了 `convergeIfSatisfied` 那一条路径，**这是同一病的第二处**。
    //
    //   修法：`craft` 单的完成只看 `okFlag` ——
    //   因为 `act_craft` 在 `produced <= 0` 时**必然返回 fail**，
    //   所以"ok=true"就意味着"真的产出够了"，不需要再用库存数二次判断。
    const isCraftJob = String(job.skill) === 'craft';
    // ★★★ 第15条（R1 收尾）：**craft 单的产出账**。
    //   账本落在 `checkpoint.producedTotal`（本单跨尝试累计产出），按增量累加。
    //   见 `settleCraftLedger` 的注释（含它覆盖不到的那种崩溃）。
    const ledger = isCraftJob ? settleCraftLedger(job, result) : null;
    // ★★★ 第15条：craft 单的**第二个**完成判据 —— **账上已经够了就别再跑一遍**。
    //   「做出 N 个 → 被打断 / 后续步骤失败 → 单子回 ready → 重新领 → 再做 N 个」
    //   每重跑一次就**真扣一次材料**（这正是第15条的病灶，t125 只修了"零产出也 done"）。
    //   现在账够了就直接 done：第二次扣料根本不会发生。
    const ledgerSatisfied = isCraftJob && want > 0 && ledger.producedTotal >= want;
    const completed = ledgerSatisfied || (okFlag && (isCraftJob || want <= 0 || count >= want));

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

    // ★★★ 第4条：**租约归属校验**（全仓唯一写 finish 结果的地方）。
    //
    //   原来 `WHERE id=?` 只看 id —— 于是"租约过期 / 已被别人接手"的旧持有者，
    //   照样能把**别人正在跑的单**写回 ready/done。真机表现就是两个 bot 抢同一张单、
    //   互相打断、进度互相覆盖。
    //   判据必须与 `heartbeat()` 的 LEASE_LOST 同源：
    //     `lease_owner IS NULL`（没人持有）**或** `lease_owner = 我`。
    //   `changes === 0` → 一个字段都不写，返回 `LEASE_STALE`（调用方立刻停手）。
    // ★★★ 补充A（T31，补 T30 留下的 fail-open 洞）：**漏传 bot 时归属校验会静默消失。**
    //
    //   T30 的规则是"不传 bot 就不做归属校验"（那条 Must 级防护**对漏传者不存在**）。
    //   这里只收紧**危险窗口**，不动其它：
    //     `bot` 未传 **且** 该行 `lease_owner` 非空 **且** 租约**还没过期**
    //     → `LEASE_STALE` + 一行 warn。
    //   也就是"我说不清我是谁、但这单确实有人在跑"必须 fail **closed**。
    //   其余情形一律不变：无租约 / 租约已过期 / 正常传了 bot —— 老签名与离线工具
    //   操作的都是无租约单，所以它们完全不受影响。
    if (bot == null && job.lease?.owner != null && job.lease?.owner !== '') {
        const until = Number(job.lease?.until);
        const stillHeld = !Number.isFinite(until) || until > now;
        if (stillHeld) {
            try {
                console.warn(`[board] finish 未传 bot，而单 ${id} 的租约仍属于 ${job.lease.owner}`
                    + `（until=${job.lease?.until ?? 'null'}）→ 拒绝写入（LEASE_STALE，fail closed）`);
            } catch { /* 打不出日志也要拒 */ }
            return {
                ok: false, code: BOARD_RESULT_CODES.LEASE_STALE,
                message: 'finish 未传 bot，且该单的租约仍在别人身上 —— 拒绝写入（fail closed）',
            };
        }
    }
    const leaseGuard = bot == null ? '' : ' AND (lease_owner IS NULL OR lease_owner = ?)';
    // ★★★ BOARD-003：同名不同尝试也要能区分（租约只看名字是不够的）。
    const aGuard = attemptGuardSql(opts.attemptSeq);

    // ★★★ 第15条：把产出账落盘（唯一持久的地方）。
    //   · `checkpoint.producedTotal`   —— 本单**累计**产出（单调不减，跨尝试累加）
    //   · `checkpoint.producedAttempt` —— 本次尝试已计多少（增量对账用）
    //   · `checkpoint.countedSeq`      —— 上面那个数属于第几次尝试（领单时打的 `attemptSeq`）
    //   · `progress.count` 对 craft 改成"**本单累计产出**"（原来它是背包总量，
    //     看不出重试扣了几次料 —— 复审 §3.2 点的就是这个）。**只许涨**：
    //     老行上可能已有更大的"背包总量"，不在这里回退（回退是另一种篡改记录）。
    const progressForWrite = (() => {
        if (!ledger) return progress ?? job.progress;
        if (!progress) return { count: ledger.producedTotal, want: want > 0 ? want : null };
        return { ...progress, count: Math.max(Number(progress.count ?? 0) || 0, ledger.producedTotal) };
    })();
    const checkpointForWrite = (() => {
        const base = ledger
            ? {
                ...(result.checkpoint ?? job.checkpoint ?? {}),
                producedTotal: ledger.producedTotal,
                producedAttempt: ledger.attemptProduced,
                countedSeq: ledger.countedSeq,
            }
            : (result.checkpoint ?? job.checkpoint);
        // ★★★ BOARD-003：**收尾写的 checkpoint 也必须带着"这是第几次尝试"。**
        //   否则 `result.checkpoint` 一覆盖，序号就没了 → 下一次 `claimFor` 从 0 开始重新数，
        //   于是"旧尝试 seq=1"和"新一轮的 seq=1"撞成同一个数 → 收尾守卫再也分不开新旧尝试
        //   （BOARD-003 的防护被悄悄关掉，而且不报错）。序号在这里**原样保留**（不 +1）：
        //   +1 的时机只有"领单"这一个入口。
        const curSeq = attemptSeqOfJob(job);
        if (curSeq == null) return base;
        return { ...(base ?? {}), attemptSeq: curSeq };
    })();

    const r = db.prepare(`UPDATE jobs
        SET state=?, attempts=?, lease_owner=NULL, lease_until=NULL,
            progress=?, checkpoint=?, result=?, interrupted=?, updatedAt=?
        WHERE id=?${leaseGuard}${aGuard.sql}`).run(
        next, attempts,
        j(progressForWrite),
        j(checkpointForWrite),
        // ★★★ 2026-11-04（t105）：**必须存 `result.data` —— 这是 diag() 加了 4 次还看不见的真因。**
        //
        //   verify 报了 **4 次**「`craft` 失败时 `data={}`」，我改了 3 处转发：
        //     t89 加 `diag()`、t92 修 `flow_craft:255` 重建对象、t95 修 `flow_craft:167` 同型泄漏。
        //   但**数据仍然看不到** —— 因为**最后一层 `finish()`（唯一写库的地方）只存四个字段**：
        //     `{ ok, code, message, at }`   ← `data` 被整个丢掉
        //
        //   → 前面每一层都传对了，**最后一层不存**。这和今晚那些"中间层丢字段"是同一族的**终点版本**：
        //     **一路传到底，最后一步扔了。**
        //   → 也说明我前三次修的都是"看起来最像"的那一层，而没从"数据最终落在哪"往下查。
        j({
            ok: okFlag, code, message: result.message ?? '', at: now, data: result.data ?? null,
            // ★ 第15条：产出账也留一份在 `result` 里（`checkpoint` 是账本，`result` 是这次的快照）。
            //   这样"这张单总共扣了几次料"不用 join 也能一眼读出来：
            //   `producedTotal` = 累计产出，`producedDelta` = 这一次新记了多少。
            ...(ledger ? { craftLedger: { producedTotal: ledger.producedTotal, delta: ledger.delta, attemptSeq: ledger.countedSeq } } : {}),
        }),
        // 回到 ready 时清掉 interrupted（与 control.js 的 requeue 语义一致）；
        // 其它状态保留（paused 时要留着"被打断的原因/时刻"）
        next === JOB_STATE.READY ? null : j(result.interrupted ?? job.interrupted),
        now, id, ...(bot == null ? [] : [bot]), ...aGuard.params,
    );

    // ★★★ 第4条：`changes === 0` = **租约已不属于调用者** → 一字不写，直接拒。
    //   判据必须落在 UPDATE 的 `changes` 上，不能只靠上面那次 `getJob` 的读快照 ——
    //   两次调用之间可能被别人接手。那正是"先 SELECT 再 UPDATE"的老坑的 finish 版本。
    //
    //   ★ BOARD-003：`changes === 0` 现在有两种成因 —— 租约不属于我，**或**
    //   我的 `attemptSeq` 已经不是当前尝试（同名重领之后旧尝试迟到写入）。
    //   两者对调用方的处置完全一样：**立刻停手、不写结果**，所以统一返回
    //   `LEASE_STALE`（稳定码，调用方不用分辨是哪种）。
    if (r.changes === 0) {
        return {
            ok: false, code: BOARD_RESULT_CODES.LEASE_STALE,
            message: opts.attemptSeq == null
                ? '租约已不属于调用者（被回收/别人接手），本次 finish 一个字段都没写'
                : '租约已不属于调用者，或这是**过期尝试**的迟到写入（attemptSeq 不匹配当前尝试）；本次 finish 一个字段都没写',
        };
    }
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
        // ★★★ 第15条：**租约过期必须记一次 attempt。**
        //
        //   原来这里一个字都不动 `attempts`（看着很像有意，其实是漏了），于是
        //   「崩一次 → 单回 ready → 再领 → 再崩」可以**无限循环**；
        //   而合成单每跑一次都**真扣一次材料** —— 料被无限往里填。
        //   语义上它和 TIMEOUT/STUCK 同类：这次尝试**失败了**。
        //
        //   `attempts+1 >= maxAttempts` → `failed` + `result.code=LEASE_EXPIRED`（留痕，
        //   否则"这张单为什么没了"在库里看不出来）；没耗尽 → 回 `ready`，
        //   **不动 result**（保留上次结果/断点，留给下一个接手的）。
        //
        // ★★★ 补充B（T31）：**`assignee` 必须跟租约一起释放。**
        //
        //   领单时 `claimFor` 会把 `assignee` 写成领单的人；而这里原来只清 lease，
        //   于是过期回 ready 的单**仍然"指派给"那个已经死掉的 bot** →
        //   `claimFor` 的候选条件是 `assignee IS NULL OR assignee = 我` →
        //   **别的 bot 永远抢不到这张单**（多 bot 下的永久死锁，且不报错）。
        //   清空 assignee = 退回共享池（与"租约过期 = 这次尝试失败"同一语义）。
        //   注意：这确实会让"原本只给 A 的个人单"在 A 崩后可能被 B 领走 ——
        //   但另一条路是永久僵尸单，账算下来这样更划算，且与 06 §6「租约过期即回收」一致。
        const job = getJob(db, id);
        if (!job) continue;
        const attempts = Number(job.attempts ?? 0) + 1;
        const max = Number(job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
        const exhausted = attempts >= max;
        const next = exhausted ? JOB_STATE.FAILED : JOB_STATE.READY;
        const result = exhausted
            ? {
                ok: false, code: BOARD_RESULT_CODES.LEASE_EXPIRED, at: now,
                message: `租约过期且重试耗尽（${attempts}/${max}）：持有者没有续租（进程崩了/断线）`,
            }
            : job.result;
        // 同样用"条件 UPDATE + changes"的写法，避免把刚刚续过租的单误回收
        const r = db.prepare(`
            UPDATE jobs SET state=?, attempts=?, assignee=NULL, lease_owner=NULL,
                            lease_until=NULL, result=?, updatedAt=?
            WHERE id=? AND state IN ('claimed','running')
              AND lease_until IS NOT NULL AND lease_until < ?`)
            .run(next, attempts, j(result ?? null), now, id, now);
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
    // ★★★ BOARD-003 补洞（2026-11-06 深度检查）：**setState 也要过尝试守卫**。
    //
    //   报告的回归项只列了 finish/heartbeat/checkpoint，但这一处同样会**放掉新尝试的租约**：
    //   `clearLease` 四个状态里有 ready/paused/blocked，全都会把 lease 清成 NULL。
    //   于是"同名重领之后，**旧尝试**调一次 board:set-state(paused/ready)"就能把
    //   新尝试的租约摘掉 —— 与"旧 finish 结束新尝试"是同一个洞的另一扇门。
    //   兼容：不传 attemptSeq（老客户端/控制层离线工具）时行为完全不变。
    const stGuard = attemptGuardSql(opts.attemptSeq);
    const st = db.prepare(`UPDATE jobs SET state=?, updatedAt=?${clearLease ? ', lease_owner=NULL, lease_until=NULL' : ''} WHERE id=?${stGuard.sql}`)
        .run(state, now, id, ...stGuard.params);
    if (st.changes === 0) {
        return {
            ok: false, code: BOARD_RESULT_CODES.LEASE_STALE,
            message: '这不是当前尝试（attemptSeq 不匹配）：本次改状态一个字段都没落库',
        };
    }
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
        // ★★★ BOARD-003（回归用例 board003 ⑦）：**租约归属不能存在"会被业务覆盖的地方"。**
        //
        //   `checkpoint` 是"进度/断点"的**整体载体**，`board:checkpoint` 就是整份替换它。
        //   而"第几次尝试"（`attemptSeq`）也存在里面 —— 于是新尝试只写一次普通断点，
        //   就把自己的尝试序号**抹掉**了 → 收尾守卫读成 NULL（`attemptGuardSql` 的
        //   "老行不加约束"分支）→ **fail open** → 旧尝试的迟到 finish 又能结束新尝试，
        //   正好是 BOARD-003 要防的那件事（离线用例实测：staleAccepted 又变回 true）。
        //
        //   修法：写 `checkpoint` 时**自动保留当前行的 attemptSeq**（本次显式给了就用给的）。
        //   只保留这一个字段，不碰业务字段、不碰产出账 —— 改动面最小。
        //   ★ 为什么不是另加一列：`claimFor` 早就把序号写在 checkpoint 上，
        //     另建一列会让"同一件事有两个写入路径"（见 BOARD_SCHEMA_VERSION 处的注释）。
        if (k === 'checkpoint') {
            const curSeq = attemptSeqOfJob(job);
            const incoming = (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
            if (curSeq != null && (incoming == null || incoming.attemptSeq == null)) {
                sets.push('checkpoint=?');
                params.push(j({ ...(incoming ?? {}), attemptSeq: curSeq }));
                continue;
            }
        }
        sets.push(`${k}=?`);
        params.push(JSON_COLS.has(k) ? j(v) : v);
    }
    if (!sets.length) return { ok: true, job };
    sets.push('updatedAt=?');
    params.push(now, id);
    // ★★★ BOARD-003：断点写入同样要落在"同一次尝试"上。
    //   报告回归验收明确要求"迟到 checkpoint 不得修改新尝试字段"。
    const ujGuard = attemptGuardSql(opts.attemptSeq);
    const uj = db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id=?${ujGuard.sql}`).run(...params, ...ujGuard.params);
    if (uj.changes === 0) {
        return {
            ok: false, code: BOARD_RESULT_CODES.LEASE_STALE,
            message: '这不是当前尝试（attemptSeq 不匹配）：本次写入一个字段都没落库',
        };
    }
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
 *
 * ★ T6：**校验 owner 与当前 state**（原来只按 `claims.owner` 过滤，完全不看这张单）。
 *   漏掉单这一层的后果：`release(jobId, 别人)` 能把**别人正在用**的资源全放掉
 *   （单 id 是共享可见的），于是两个 bot 同时开同一个箱子 —— 正是预约要防的事。
 *
 * 判据：这张单的租约若**在别人手上且未过期** → 拒绝（`LEASE_STALE`，一个字段都不删）。
 * 反过来，"租约已过期/没人持有/就是我自己"三种情形一律放行（清理残局必须能做）。
 *
 * @returns {{ok:true, released:number} | {ok:false, code:string, released:0, message:string}}
 */
export function release(db, jobId, owner, keys = null, opts = {}) {
    const now = opts.now ?? Date.now();
    const id = jobId == null ? '' : String(jobId);
    const me = owner == null || owner === '' ? null : String(owner);
    const job = id ? getJob(db, id) : null;
    // ★ 兼容：`claims` 表里可能有"还没有任务单行（或单已被归档）"的预约
    //   （离线工具/夹具直接 `reserve(db,'jobA',…)`）。没有单行 = 没有租约归属可校验
    //   ⇒ 退回旧行为，不因为"查不到单"就拒（否则纯预约层用例全红，而那不是本条的靶子）。
    if (!job) {
        if (Array.isArray(keys) && keys.length) {
            const norm = normalizeClaimKeys(keys);
            const list = norm.ok ? norm.keys : [];
            let n = 0;
            for (const k of list) {
                const r = db.prepare('DELETE FROM claims WHERE id=? AND (owner IS NULL OR owner = ?) AND key=?')
                    .run(id, me, k);
                n += Number(r.changes ?? 0);
            }
            return { ok: true, released: n, noJobRow: true };
        }
        const r0 = db.prepare('DELETE FROM claims WHERE id=? AND (owner IS NULL OR owner = ?)').run(id, me);
        return { ok: true, released: Number(r0.changes ?? 0), noJobRow: true };
    }
    const holder = job.lease?.owner ?? null;
    const untilLease = Number(job.lease?.until);
    const leaseExpired = Number.isFinite(untilLease) && untilLease <= now;
    if (me != null && holder != null && holder !== me && !leaseExpired) {
        return {
            ok: false, code: BOARD_RESULT_CODES.LEASE_STALE, released: 0,
            message: `单 ${id} 的租约属于 ${holder}，不是 ${me}：一条预约都没放`,
        };
    }
    if (Array.isArray(keys) && keys.length) {
        const norm = normalizeClaimKeys(keys);
        const list = norm.ok ? norm.keys : [];
        let n = 0;
        for (const k of list) {
            const r = db.prepare('DELETE FROM claims WHERE id=? AND (owner IS NULL OR owner = ?) AND key=?')
                .run(id, me, k);
            n += Number(r.changes ?? 0);
        }
        return { ok: true, released: n };
    }
    const r = db.prepare('DELETE FROM claims WHERE id=? AND (owner IS NULL OR owner = ?)').run(id, me);
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
 *
 * ★ T6（架构收敛项 3）：**必须校验 owner 与当前 state**。
 *   原来 `UPDATE claims SET until=? WHERE id=?` —— 只要知道 jobId（任务板的单 id
 *   是**共享可见**的：list/board:changed 都能拿到别人的单 id），任何 bot 都能替
 *   **别人正在跑的单**续预约 ⇒ 那个 bot 掉线后预约永远不过期，资源被永久占住。
 *
 * 判据（与 `heartbeat()` 的 LEASE_LOST 同源）：
 *   ① 单必须处于 `claimed`/`running`（真的被持有）—— ready/paused/终态都不续；
 *   ② 给了 `owner` 时，租约必须属于它（`lease_owner` 为空 = 没人持有，按"谁都可能是合法者"放行，
 *      与 finish 的既有判据一致）；
 *   ③ UPDATE 只命中 `owner IS NULL OR owner = ?` 的预约行。
 *
 * @returns {{ok:true, code:'OK', renewed:number, until:number} | {ok:false, code:string, renewed:0, message:string}}
 *   ★ 返回值从"数字"改成形状化结果（T6）：`changed === 0` 与"不归我"必须能区分，
 *     数字 0 分不清。调用方只有 `board_server` 的心跳，它不看返回值。
 */
export function renewClaims(db, jobId, opts = {}) {
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? CLAIM_TTL_MS;
    const owner = opts.owner == null || opts.owner === '' ? null : String(opts.owner);
    const id = jobId == null ? null : String(jobId);
    const job = id == null ? null : getJob(db, id);
    // ★ 兼容：`claims` 表可以有一张**还不存在（或已归档）的任务单**的预约
    //   （离线工具/夹具直接 `reserve(db,'jobA',…)`）。没有单行 = 没有租约归属可校验
    //   ⇒ 退回旧行为（只按 owner 过滤），不因为"查不到单"就拒。
    if (!job) {
        const until = now + ttlMs;
        const r0 = owner == null
            ? db.prepare('UPDATE claims SET until=? WHERE id=?').run(until, id)
            : db.prepare('UPDATE claims SET until=? WHERE id=? AND (owner IS NULL OR owner=?)').run(until, id, owner);
        return { ok: true, code: 'OK', renewed: Number(r0.changes ?? 0), until, noJobRow: true };
    }
    if (![JOB_STATE.CLAIMED, JOB_STATE.RUNNING].includes(job.state)) {
        return {
            ok: false, code: BOARD_RESULT_CODES.LEASE_STALE, renewed: 0,
            message: `单 ${id} 的状态是 ${job.state}（不在跑），不续预约`,
        };
    }
    const holder = job.lease?.owner ?? null;
    const untilLease = Number(job.lease?.until);
    const leaseExpired = Number.isFinite(untilLease) && untilLease <= now;
    if (owner != null && holder != null && holder !== owner && !leaseExpired) {
        return {
            ok: false, code: BOARD_RESULT_CODES.LEASE_STALE, renewed: 0,
            message: `单 ${id} 的租约属于 ${holder}，不是 ${owner}：一条预约都没续`,
        };
    }
    const until = now + ttlMs;
    const r = owner == null
        ? db.prepare('UPDATE claims SET until=? WHERE id=?').run(until, id)
        : db.prepare('UPDATE claims SET until=? WHERE id=? AND (owner IS NULL OR owner=?)').run(until, id, owner);
    return { ok: true, code: 'OK', renewed: Number(r.changes ?? 0), until };
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
/**
 * ★★★ 2026-11-05（t142）：**兜底重开 —— 扫"blocked 且依赖已满足"的单。**
 *
 *   `reopenBlockedWithSatisfiedDeps` 只在 `board:finish` 那个事件里被调（`board_server.js:262`）。
 *   这是**纯事件驱动**的：只要那次 finish 的时间窗没对上（比如依赖是在**别的路径**下变成 done 的），
 *   这张 blocked 单就**永远不会被重开，而且不报错** —— 与 t140（父单永不收敛）**完全同构**。
 *
 *   → 挂进 `scanTimer` 定期扫（和 `convergeOrphanParents` 同一个兜底思路）。
 *
 *   ★ SQL 必须带**状态过滤**，否则会被历史垃圾占满 LIMIT（t141 在
 *     `convergeOrphanParents` 上踩过：`jobs` 表从不删除，distinct parentId 超 LIMIT 后
 *     第 LIMIT+1 个之后的单**永不被扫**，且不报错）。
 *   ★ `ORDER BY rowid DESC`：优先看新单（老的 blocked 单多半已 `reopenedOnce`，看了也没用）。
 *
 * @param {object} [opts] { now, limit }
 * @returns {Array<object>} 被重开的单（供调用方广播）
 */
export function reopenOrphanBlocked(db, opts = {}) {
    const now = opts.now ?? Date.now();
    const limit = Math.max(1, Math.floor(Number(opts.limit) || 200));
    const out = [];
    let rows = [];
    try {
        // ★ 状态过滤放在 SQL 里（不是拿回来再 continue）—— 这是 t141 的教训：
        //   `WHERE state='blocked'` 让结果集天然小，LIMIT 不会被历史垃圾占满。
        rows = db.prepare(
            "SELECT id FROM jobs WHERE state = 'blocked' ORDER BY rowid DESC LIMIT ?",
        ).all(limit);
    } catch { return out; }

    for (const { id } of rows) {
        const job = getJob(db, id);
        if (!job) continue;
        const deps = Array.isArray(job.dependsOn) ? job.dependsOn : [];
        if (!deps.length) continue;                       // 没依赖 → NO_ITEM 是真缺料，不重开
        if (job.checkpoint?.reopenedOnce) continue;       // 只给一次机会（防死循环）

        // ★★★ 第5条：**依赖已死**（failed/blocked/cancelled）→ 这张单永远等不到，
        //   别再指望它自己好起来：落成 blocked + `result.code=DEP_DEAD`（留痕）。
        //   现场（报告第5条）：依赖死掉的单永久卡 ready、父单永久 running，最长卡 166 分钟。
        if (depDead(db, job)) { markDepDeadBlocked(db, id, { now }); continue; }
        if (!dependsSatisfied(db, job)) continue;         // 依赖还没满足 → 继续等
        const r = setState(db, id, JOB_STATE.READY, { now });
        if (!r.ok) continue;
        updateJob(db, id, { checkpoint: { ...(job.checkpoint ?? {}), reopenedOnce: true } });
        out.push(getJob(db, id));
    }
    return out;
}

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

        // ★★★ 第5条：**依赖已死**（failed/blocked/cancelled）→ 这张单永远等不到，
        //   别再指望它自己好起来：落成 blocked + `result.code=DEP_DEAD`（留痕）。
        //   现场（报告第5条）：依赖死掉的单永久卡 ready、父单永久 running，最长卡 166 分钟。
        if (depDead(db, job)) { markDepDeadBlocked(db, id, { now }); continue; }
        if (!dependsSatisfied(db, job)) continue;         // 依赖还没满足 → 继续等
        const r = setState(db, id, JOB_STATE.READY, { now });
        if (!r.ok) continue;
        updateJob(db, id, { checkpoint: { ...(job.checkpoint ?? {}), reopenedOnce: true } });
        out.push(getJob(db, id));
    }
    return out;
}

/**
 * ★★★ 2026-11-05（t140）：**兜底收敛 —— 扫出"子单全终态但父单还挂着"的父单。**
 *
 *   真机证据（第 59 跑轮 1，第一夜五个步骤首次全部走通）：
 *     父单 `08_ngl` = **running**
 *     子单 5 张 = done / done / done / done / done（全部终态）
 *   → **`rollupParent` 没被触发，父单永远挂在 running。第一夜就差这一步。**
 *
 *   为什么只在 `board:finish` 里调 `rollupParent` 不够：
 *     那是"**事件驱动**"的 —— 依赖"每张子单 finish 的那一刻，回头看父单"。
 *     只要有一次时间窗没对上（最后一张 finish 时另一张还在 ready/running，
 *     之后就再也没有 finish 事件了），父单就**永久卡住**，而且**没有任何东西会再来重试**。
 *
 *   → 需要"**最终一致**"的兜底：定期扫描，凡是
 *     「state=running **且** 有子单 **且** 子单全部终态」的父单，重新 rollup 一次。
 *     这是幂等的（rollupParent 自己会判断 allDone），重复调用无害。
 *
 *   ★ 扫 `running` **和** `ready`（原注释写成"只扫 running"，与实现不符 —— control 抓出来的）：
 *     - `running`：正常在跑，子单全终态 → 该收敛
 *     - `ready`  ：通常是"退避后等着重试"的形态。**若它已有子单且子单全部终态**，
 *                  说明"退避后没有任何东西再推它" → **同样该收敛**（否则永久挂着）
 *     - `paused` / 终态：不碰（`paused` 是人为暂停，替它做决定是错的）
 *   → **保留 READY 是有意的，不是笔误。**
 *
 * @returns {Array<object>} 被收敛的父单（只含真正 changed 的）
 */
export function convergeOrphanParents(db, opts = {}) {
    const now = opts.now ?? Date.now();
    const limit = Math.max(1, Math.floor(Number(opts.limit) || 200));
    const out = [];
    // ★★★ 2026-11-05（t142，control 的审计抓出来的"时间炸弹"，我离线证伪了）：
    //
    //   原来写的是：
    //     SELECT DISTINCT parentId FROM jobs WHERE parentId IS NOT NULL LIMIT ?
    //   **无 ORDER BY、无 offset、也不过滤"父单是否还挂着"** ——
    //   于是**每次都拿同一批前 200 个 parentId**。
    //
    //   而 `jobs` 表**从不删除**（全仓无 `DELETE FROM jobs`），只增不减 →
    //   **distinct parentId 一旦 > 200，第 201 个之后的父单永远扫不到
    //   → 退回"永久 running 且无人重试"，而且不报错。**
    //
    //   离线复现（250 组已完成父子对 + 2 个真该收敛的）：
    //     总单数 504 ｜ distinct parentId **252** ｜ 实际收敛 **0** ｜ 目标父单仍 **running**
    //   → 完全确认。
    //
    //   修法：**只取"还挂着的"父单**。这样结果集是"需要收敛的"，天然很小，
    //   `LIMIT` 永远不会被"历史垃圾"占满；再按 rowid 倒序，保证新的优先。
    let rows = [];
    try {
        rows = db.prepare(`
            SELECT DISTINCT p.id AS parentId
              FROM jobs p
              JOIN jobs c ON c.parentId = p.id
             WHERE p.state IN (?, ?)
             ORDER BY p.rowid DESC
             LIMIT ?
        `).all(JOB_STATE.RUNNING, JOB_STATE.READY, limit);
    } catch { return out; }

    const terminal = new Set([JOB_STATE.DONE, JOB_STATE.FAILED, JOB_STATE.BLOCKED, JOB_STATE.CANCELLED]);
    for (const row of rows) {
        const parentId = row?.parentId;
        if (!parentId) continue;
        const parent = getJob(db, parentId);
        if (!parent) continue;
        // 只处理"挂着的"父单：running 或 ready 都可能卡住（ready 是退避后的形态）
        if (![JOB_STATE.RUNNING, JOB_STATE.READY].includes(parent.state)) continue;

        // ★★★ 第5条：**先把"依赖已死"的子单落成 blocked**，再判父单能不能收敛。
        //   否则它永远 ready（既不终态、又永远领不到）→ 下面的
        //   `kids.some(!terminal)` 恒真 → **父单永久 running**。
        //   现场那张卡了 166 分钟的单就是这个形态。
        for (const kid of db.prepare('SELECT id, state FROM jobs WHERE parentId = ?').all(parentId)) {
            if (terminal.has(kid.state)) continue;
            const kidJob = getJob(db, kid.id);
            if (!kidJob || !depDead(db, kidJob)) continue;
            markDepDeadBlocked(db, kid.id, { now });
        }
        const kids = db.prepare('SELECT state FROM jobs WHERE parentId = ?').all(parentId);
        if (!kids.length) continue;
        // 有活着的子单 → 还没到收敛时机
        if (kids.some((c) => !terminal.has(c.state))) continue;
        const r = rollupParent(db, parentId, { now });
        if (r?.changed && r.parent) out.push(r.parent);
    }
    return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 第5条：依赖已死（DEP_DEAD）—— "在等一张永远不会完成的单"必须当场落地
// ───────────────────────────────────────────────────────────────────────────

/** 依赖处于这些状态 → 永远不可能变成 done → 后继"等也白等"。 */
const DEAD_DEP_STATES = new Set([JOB_STATE.FAILED, JOB_STATE.BLOCKED, JOB_STATE.CANCELLED]);

/**
 * 这张单的依赖里有没有**已经死了**的。
 *
 * ★★ 为什么需要这个判据：`dependsSatisfied()` 只认 `done`，于是
 *   「前置已失败（永远好不了）」和「前置还没跑完（之后会自己好）」**在库里长得一模一样**。
 *   没有任何路径会再碰前者 → 后继单永久 `ready`、父单永久 `running`（现场卡 166 分钟）。
 *
 * ★ 前置**不存在**（`dependsOn` 指向库里没有的 id）**不算死**：那多半是跨库/尚未落库的
 *   中间态，判死会让本来能恢复的单提前 blocked。宁可等，不要误杀。
 */
export function depDead(db, job) {
    const deps = Array.isArray(job?.dependsOn) ? job.dependsOn : [];
    if (!deps.length) return false;
    const rows = db.prepare(
        `SELECT id, state FROM jobs WHERE id IN (${deps.map(() => '?').join(',')})`,
    ).all(...deps);
    const stateOf = new Map(rows.map((r) => [String(r.id), r.state]));
    return deps.some((d) => DEAD_DEP_STATES.has(stateOf.get(String(d))));
}

/**
 * 把"依赖已死"的单落成 `blocked` + `result.code=DEP_DEAD`（幂等）。
 *
 * @returns {object|null} 落好之后的单；没动 / 动不了 返回 null
 */
export function markDepDeadBlocked(db, id, opts = {}) {
    const now = opts.now ?? Date.now();
    const job = getJob(db, id);
    if (!job) return null;
    // 已经记过账就不再写（这个函数会被 scanTimer 每轮扫到，写空转噪音没意义）
    if (job.state === JOB_STATE.BLOCKED && job.result?.code === BOARD_RESULT_CODES.DEP_DEAD) return null;
    let cur = job;
    if (cur.state !== JOB_STATE.BLOCKED) {
        const r = setState(db, id, JOB_STATE.BLOCKED, { now });
        if (!r.ok) return null;
        cur = r.job;
    }
    // `setState` 不动 result —— 这里单独写一次，把"为什么卡住"落到库里（别再一次静默）
    updateJob(db, id, {
        result: {
            ok: false, code: BOARD_RESULT_CODES.DEP_DEAD, at: now,
            message: '依赖处于终态(failed/blocked/cancelled)：这张单永远等不到前置完成',
            deps: Array.isArray(cur.dependsOn) ? cur.dependsOn : [],
        },
    }, { now });
    return getJob(db, id);
}

/**
 * 兜底扫：`ready` 且依赖已死 → `blocked` + `DEP_DEAD`。
 *
 * ★ 与 t140/t142 的兜底同一个理由：**必须有周期性扫描**，不能只挂事件上 ——
 *   事件漏一次就永久不一致，而且不报错。
 * ★ 状态过滤放 SQL + `ORDER BY rowid DESC`：`jobs` 从不删除，
 *   老单会把 LIMIT 占满（t141 的教训）。
 */
export function sweepDeadDepJobs(db, opts = {}) {
    const now = opts.now ?? Date.now();
    const limit = Math.max(1, Math.floor(Number(opts.limit) || 200));
    const out = [];
    let rows = [];
    try {
        rows = db.prepare(`
            SELECT id FROM jobs
             WHERE state = ? AND dependsOn IS NOT NULL
               AND dependsOn <> '[]' AND dependsOn <> 'null'
             ORDER BY rowid DESC
             LIMIT ?`).all(JOB_STATE.READY, limit);
    } catch { return out; }
    for (const { id } of rows) {
        const job = getJob(db, id);
        if (!job) continue;
        if (!depDead(db, job)) continue;
        const marked = markDepDeadBlocked(db, id, { now });
        if (marked) out.push(marked);
    }
    return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 第17条：幽灵父单（拆单中途崩溃 → 永久 running 且无子单）
// ───────────────────────────────────────────────────────────────────────────

/** 幽灵父单的时间阈值：2 分钟（报告给的数）。 */
export const ORPHAN_PARENT_MS = 120 * 1000;

/**
 * ★★★ 第17条：扫「**壳单**（`skill` 为空 = 自己不干活、只派子单）既无子单、
 *   又没人持有租约」的幽灵父单 → `blocked` + `result.code=ORPHAN_PARENT`。
 *
 *   真机形态：`splitByCount` / `splitByArea` **先建父单**（`state:'running'`、`skill:null`）
 *   **再建子单**，两步之间崩了 → 父单永久 `running` 且 0 子单。
 *   而 `convergeOrphanParents` **明确跳过无子单的父单**（`if (!kids.length) continue`），
 *   于是没有任何路径会再碰它 —— 它就一直挂在面板上，永远"正在跑"。
 *
 * ★★ **两处必要的收窄（相对报告字面写法，理由在此，请复核）**：
 *   ① 只认 **`skill` 为空**的单。报告写的是「running/ready 且无子单」——
 *      可「`ready` 且无子单」**正是队列里每一张还没人领的正常单**！
 *      照字面实现，上线 2 分钟后**整个待办队列会被一口气全部 blocked**。
 *      而"壳单"（skill 空）在库里**根本无法自己执行**，没有子单就等于永远不会前进
 *      —— 这才是"幽灵"的准确刻画，也是 `splitBy*` 崩溃时的确切形态。
 *   ② 只认**租约已过期/无租约**的。租约还活着 = 有人正在跑它，
 *      这时候判"幽灵"等于杀掉正在干活的单。
 *   两条收窄都写进了 `board_orphan_parent_unit` 的用例（有 skill 的 ready 单必须不被误伤）。
 *
 * @returns {Array<object>} 被落成 blocked 的单（供调用方广播）
 */
export function blockOrphanParents(db, opts = {}) {
    const now = opts.now ?? Date.now();
    const idleMs = Number.isFinite(opts.idleMs) ? opts.idleMs : ORPHAN_PARENT_MS;
    const limit = Math.max(1, Math.floor(Number(opts.limit) || 200));
    const out = [];
    let rows = [];
    try {
        rows = db.prepare(`
            SELECT id FROM jobs j
             WHERE j.state IN (?, ?)
               AND (j.skill IS NULL OR TRIM(j.skill) = '')
               AND j.createdAt < ?
               AND (j.lease_until IS NULL OR j.lease_until <= ?)
               AND NOT EXISTS (SELECT 1 FROM jobs c WHERE c.parentId = j.id)
             ORDER BY j.rowid DESC
             LIMIT ?`).all(JOB_STATE.RUNNING, JOB_STATE.READY, now - idleMs, now, limit);
    } catch { return out; }
    for (const { id } of rows) {
        const job = getJob(db, id);
        if (!job) continue;
        if (job.state === JOB_STATE.BLOCKED && job.result?.code === BOARD_RESULT_CODES.ORPHAN_PARENT) continue;
        const r = setState(db, id, JOB_STATE.BLOCKED, { now });
        if (!r.ok) continue;
        updateJob(db, id, {
            result: {
                ok: false, code: BOARD_RESULT_CODES.ORPHAN_PARENT, at: now,
                message: '幽灵父单：壳单无子单且无人持有租约（拆单中途崩溃），永远不会有东西再推进它',
            },
        }, { now });
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

/** 共享数据的种类常量（`mergeSharedChest` 只服务箱子）。 */
export const SHARED_CHEST_KIND = 'chest';

/**
 * ★★★ T31 第16条：**箱子内容的原子合并**（服务端做，一次往返）。
 *
 * 病根：`flow_store.rememberChest` 原来是「`sharedGet` → 本地叠加 → `sharedPut`」，
 *   跨**两次 socket 往返**。两个 bot 同时往同一个箱子存东西时：
 *     A 读 {oak_log:5} → B 读 {oak_log:5} → A 写 {oak_log:5, stone:3} → B 写 {oak_log:5}
 *   **A 那次写入被整份覆盖**（丢件），而且没人报错。
 *
 * 修法：把"读-改-写"**收进一个事务、放到唯一写库的进程里**（mindserver 是唯一写者，
 *   06 §3）。`BEGIN IMMEDIATE` 先拿写锁再读，保证中间不会被插进来。
 *
 * ★ 合并语义（与原来一致，只是搬了个地方）：
 *   `delta` 是**增量**（存 +N / 取 -N）；合计 ≤ 0 的条目直接删掉（别留 0 条垃圾）。
 *
 * @param {object} db
 * @param {string} key `"x,y,z"`
 * @param {object} delta `{ oak_log: +5, stone: -3 }`
 * @param {string|null} [owner] 谁合并的（记进 value.owner）
 * @param {{now?:number, pos?:{x:number,y:number,z:number}|null}} [opts]
 * @returns {{ok:true, key:string, value:object} | {ok:false, code:string, message:string}}
 */
export function mergeSharedChest(db, key, delta, owner = null, opts = {}) {
    const now = opts.now ?? Date.now();
    if (key == null || String(key) === '') {
        return { ok: false, code: 'NO_TARGET', message: '合并箱子需要 key' };
    }
    const k = String(key);
    const d = (delta && typeof delta === 'object') ? delta : {};

    let inTx = false;
    try { db.exec('BEGIN IMMEDIATE'); inTx = true; } catch { inTx = false; }
    try {
        const prev = getShared(db, SHARED_CHEST_KIND, k);
        const prevValue = prev?.value ?? null;
        const items = { ...(prevValue?.items ?? {}) };
        for (const [name, raw] of Object.entries(d)) {
            const n = Number(raw);
            if (!Number.isFinite(n) || n === 0) continue;
            const next = Number(items[name] ?? 0) + n;
            if (next > 0) items[name] = next;
            else delete items[name];
        }
        const value = {
            pos: prevValue?.pos ?? opts.pos ?? null,
            items,
            owner: owner ?? prevValue?.owner ?? null,
            at: now,
        };
        putShared(db, SHARED_CHEST_KIND, k, value, { now, owner: owner ?? null });
        if (inTx) db.exec('COMMIT');
        return { ok: true, key: k, value };
    } catch (e) {
        if (inTx) { try { db.exec('ROLLBACK'); } catch { /* 回滚失败也别吞原始错误 */ } }
        return { ok: false, code: 'INTERNAL', message: String(e?.message ?? e) };
    }
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
