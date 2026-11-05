/**
 * 任务板库：**「坏库才重建」与「加列不重建」**（报告第3、24条）—— 离线，真 sqlite。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 第3条（病根）：`openBoard()` 原来把 `tryOpen()` 的**任何**异常都当"库损坏"
 *   → `rename`/`rm` 掉原文件 → 建空库。
 *   最刺眼的组合：另一个进程 `BEGIN EXCLUSIVE` 持锁 → 这边是 `SQLITE_BUSY(5)`
 *   → 被当成"文件坏了" → **好库被改名，工单全丢**，日志还写"库损坏已重建空库"。
 *   现在判据只有两条：`errcode ∈ {11,26}` 或 message 出现
 *   "file is not a database"/"malformed"；其余一律原样 throw。
 *
 * 第24条（病根）：`CREATE TABLE IF NOT EXISTS` **不会给已存在的表补列**，
 *   于是"加一列"只能靠删库重建。现在有 `PRAGMA user_version` + 幂等迁移。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。临时库在 tmp/，跑完删除。
 */
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    openBoard, addJob, getJob, countJobs, listJobs,
    isCorruptError, migrateBoardSchema, jobColumnDefs, BOARD_SCHEMA_VERSION,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = join('tmp', 'board-open-test');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
let seq = 0;
const freshDir = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };
const corruptBackups = (dir) => readdirSync(dir).filter((f) => f.includes('.corrupt-'));

// ══════════════════════════════════════════════════════════════════════════
// ① 判据表（第3条的全部）：正反两面逐条钉死
//    ★ 这条是本次修复的**核心**，也是最容易被"看起来更保守"骗过去的地方 ——
//      判宽一格 = 好库被删；判窄一格 = 真坏库起不来。所以两面都测。
// ══════════════════════════════════════════════════════════════════════════
{
    const mkErr = (msg, errcode) => { const e = new Error(msg); if (errcode != null) e.errcode = errcode; return e; };
    const CORRUPT = [
        ['errcode 11 (SQLITE_CORRUPT)', mkErr('database disk image is malformed', 11)],
        ['errcode 26 (SQLITE_NOTADB)', mkErr('file is not a database', 26)],
        ['只有 message：file is not a database', mkErr('file is not a database')],
        ['只有 message：malformed', mkErr('database disk image is malformed')],
    ];
    const NOT_CORRUPT = [
        ['errcode 5 (SQLITE_BUSY) —— ★另一个进程持锁', mkErr('database is locked', 5)],
        ['只有 message：database is locked', mkErr('database is locked')],
        ['errcode 8 (SQLITE_READONLY)', mkErr('attempt to write a readonly database', 8)],
        ['errcode 13 (SQLITE_FULL)', mkErr('database or disk is full', 13)],
        ['普通 Error（无 errcode）', mkErr('Cannot open database because the directory does not exist')],
        ['EACCES（权限）', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })],
    ];
    const wrongPos = CORRUPT.filter(([, e]) => !isCorruptError(e)).map(([n]) => n);
    const wrongNeg = NOT_CORRUPT.filter(([, e]) => isCorruptError(e)).map(([n]) => n);
    if (!wrongPos.length && !wrongNeg.length) {
        okCase('★ ① 判据表：4 条真损坏必重建、6 条非损坏必须 throw（锁忙不算坏库）',
            `corrupt=${CORRUPT.length} 非corrupt=${NOT_CORRUPT.length}`);
    } else {
        badCase('① isCorruptError 判据不对（第3条回归）', { 漏判: wrongPos, 误判: wrongNeg });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ② 旧库缺列 → **自动补列**、不重建、老数据完好（第24条）
//    ★ "完成度以旧库能自动迁移为准，别用删库重建让测试变绿" —— 这条就是那句要求。
// ══════════════════════════════════════════════════════════════════════════
{
    const dir = freshDir();
    const path = join(dir, 'board.sqlite');
    // 造一张"老版本"的 jobs 表：只有最早那几列（缺 dependsOn / checkpoint / interrupted…）
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'personal', parentId TEXT,
        title TEXT, skill TEXT, args TEXT, state TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    raw.prepare('INSERT INTO jobs (id, kind, title, skill, state, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)')
        .run('j_old_1', 'personal', '老单甲', 'mine', 'ready', 111, 111);
    raw.prepare('INSERT INTO jobs (id, kind, title, skill, state, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)')
        .run('j_old_2', 'personal', '老单乙', 'craft', 'done', 222, 222);
    raw.close();

    const before = readdirSync(dir);
    const handle = openBoard(dir);
    const backups = corruptBackups(dir);
    const cols = handle.db.prepare('PRAGMA table_info(jobs)').all().map((r) => String(r.name));
    const j1 = getJob(handle.db, 'j_old_1');
    const j2 = getJob(handle.db, 'j_old_2');
    const expect = jobColumnDefs().map((c) => c.name);
    const missing = expect.filter((c) => !cols.includes(c));

    const good = handle.rebuilt === false
        && !backups.length
        && missing.length === 0
        && countJobs(handle.db) === 2
        && j1?.title === '老单甲' && j1?.state === 'ready'
        && j2?.title === '老单乙' && j2?.state === 'done'
        && Number(handle.migration?.added?.length) > 0;
    if (good) {
        okCase('★ ② 老库缺列 → 自动补列、rebuilt=false、两张老单原样还在',
            `补列=${handle.migration.added.length} 列数=${cols.length} 行数=${countJobs(handle.db)} 备份=${backups.length}`);
    } else {
        badCase('② 老库没有正确迁移（第24条回归）', {
            rebuilt: handle.rebuilt, backups, before, missing,
            rows: countJobs(handle.db), j1, migration: handle.migration,
        });
    }

    // ③ 幂等：再开一次 → 不再补任何列；user_version 已写回
    const handle2 = openBoard(dir);
    const uv = Number(handle2.db.prepare('PRAGMA user_version').get()?.user_version ?? -1);
    if (handle2.rebuilt === false && (handle2.migration?.added ?? ['x']).length === 0
        && uv === BOARD_SCHEMA_VERSION && countJobs(handle2.db) === 2) {
        okCase('③ 幂等：第二次打开不再补列，user_version=' + BOARD_SCHEMA_VERSION + '，行数不变',
            `added=${JSON.stringify(handle2.migration?.added)} uv=${uv}`);
    } else {
        badCase('③ 迁移不幂等 / user_version 没写回', {
            added: handle2.migration?.added, uv, rows: countJobs(handle2.db), want: BOARD_SCHEMA_VERSION,
        });
    }

    // ③-b 迁移后的库能正常工作（不是"补了列但写不进去"）
    const added = addJob(handle2.db, { title: '迁移后新单', skill: 'mine', dependsOn: ['j_old_1'] });
    const ok = added?.id && getJob(handle2.db, added.id)?.dependsOn?.[0] === 'j_old_1';
    if (ok) okCase('③-b 迁移后的库可正常下单（dependsOn 列可用）', `id=${added.id}`);
    else badCase('③-b 迁移后写不进去', { added });
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 真损坏（垃圾字节）→ 必须重建 + 留证（备份，不静默删）
// ══════════════════════════════════════════════════════════════════════════
{
    const dir = freshDir();
    const path = join(dir, 'board.sqlite');
    writeFileSync(path, 'this is definitely not a sqlite database file\n'.repeat(10), 'utf8');
    let handle = null, err = null;
    try { handle = openBoard(dir); } catch (e) { err = e; }
    const backups = corruptBackups(dir);
    if (handle?.rebuilt === true && backups.length === 1 && countJobs(handle.db) === 0) {
        const canWrite = addJob(handle.db, { title: '重建后', skill: 'mine' });
        okCase('★ ④ 真损坏文件 → rebuilt=true + .corrupt- 留证 + 新库可正常下单',
            `备份=${backups[0]} 新库行数=${countJobs(handle.db)} 可写=${!!canWrite?.id}`);
    } else {
        badCase('④ 真损坏没有按"改名留证 + 建空库"处理', { err: String(err?.message ?? err), rebuilt: handle?.rebuilt, backups });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★★ 第3条的验收场景（离线版）：**另一个连接持 EXCLUSIVE 锁** → 必须 throw，
//    而且**库文件还在、字节没变、没有 .corrupt- 备份**。
//
//    ★ 这里用同进程的第二个连接持锁（确定性、不依赖子进程时序）；
//      真·跨进程 10 秒版见 docs/audit-执行/T30 里记录的那条命令与输出。
//    ★ 会等 busy_timeout(5s) —— 这 5 秒是**故意的**：它证明我们没有"等不及就把库删了"。
// ══════════════════════════════════════════════════════════════════════════
{
    const dir = freshDir();
    const path = join(dir, 'board.sqlite');
    const first = openBoard(dir);
    addJob(first.db, { title: '被锁住的单', skill: 'mine' });
    const bytesBefore = readFileSync(path).length;

    const locker = new DatabaseSync(path);
    locker.exec('BEGIN EXCLUSIVE');
    let err = null;
    const t0 = Date.now();
    try { openBoard(dir); } catch (e) { err = e; }
    const waited = Date.now() - t0;
    try { locker.exec('ROLLBACK'); } catch { /* ignore */ }
    try { locker.close(); } catch { /* ignore */ }

    const backups = corruptBackups(dir);
    const bytesAfter = readFileSync(path).length;
    const stillThere = existsSync(path);
    const msg = String(err?.message ?? '');
    const dataIntact = countJobs(first.db) === 1;

    const good = err != null
        && !isCorruptError(err)
        && /locked|busy/i.test(msg)
        && stillThere && bytesAfter === bytesBefore
        && backups.length === 0
        && dataIntact;
    if (good) {
        okCase('★ ⑤ 另一个连接持 EXCLUSIVE → openBoard 原样 throw（不是"坏库"）、文件与数据完好',
            `等了 ${waited}ms 报「${msg}」 备份=${backups.length} 行数=${countJobs(first.db)}`);
    } else {
        badCase('⑤ 锁忙被当成了坏库（第3条回归：好库会被删）', {
            err: msg || '(没有抛错)', isCorrupt: err ? isCorruptError(err) : null,
            stillThere, bytesBefore, bytesAfter, backups, dataIntact, waited,
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 接线：mindserver 的日志必须说清"库文件原样保留"
//    （否则"锁忙 → 起不来"在日志里又是一句没有信息量的话，与以前那句
//      "库损坏已重建空库"一样误导人）
// ══════════════════════════════════════════════════════════════════════════
{
    const srv = readFileSync('src/mindcraft/mindserver.js', 'utf8');
    const has = (t) => srv.includes(t);
    const good = has('板起不来') && has('未改名/未删除') && has('按"没有板"继续');
    if (good) okCase('⑥ 接线：mindserver 的失败日志明说「板起不来（库文件原样保留，未改名/未删除）」', 'found=3');
    else badCase('⑥ mindserver 日志没说清"库文件还在"', { 板起不来: has('板起不来'), 未改名: has('未改名/未删除') });

    // ⑥-b 判据必须来自 `isCorruptError`（不能又出现"什么都当坏库"的第二条路径）
    const opened = readFileSync('src/agent/library/board_store.js', 'utf8');
    const used = opened.includes('if (!isCorruptError(e))');
    if (used) okCase('⑥-b 接线：openBoard 里确实用 isCorruptError 分流（没有第二条"全当坏库"路径）', 'found=1');
    else badCase('⑥-b openBoard 没用 isCorruptError 分流', { used });
}

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
