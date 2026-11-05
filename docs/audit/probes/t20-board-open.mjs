// T20 终审探针：board_store 的「误判损坏」两个场景（锁冲突 / schema 不匹配）
//
// 运行：
//   node docs/audit/probes/t20-board-open.mjs schema <dir>          # 场景2：老库缺列 → 应迁移而不是重建
//   node docs/audit/probes/t20-board-open.mjs hold   <dir> <ms>     # 前台持 EXCLUSIVE 锁（DELETE 日志模式，保证读者被堵）
//   node docs/audit/probes/t20-board-open.mjs probe  <dir>          # 在锁被持有时调 openBoard
//
// 为什么 holder 必须切回 DELETE(rollback) journal：
//   WAL 模式下「读者不被写者阻塞」，所以 EXCLUSIVE 锁 + WAL 根本造不出 SQLITE_BUSY，
//   上一版探针就是这样"看起来通过、其实没测到"（openBoard 1124ms 正常返回、零错误）。
//   本探针在 holder 里把 journal_mode 显式压回 DELETE，并删掉 -wal/-shm，确保读者必被堵。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBoard, BOARD_SCHEMA_VERSION } from '../../../mindcraft/src/agent/library/board_store.js';

const mode = process.argv[2] || 'schema';
const dir = resolve(process.argv[3] || './t20-board');
const ms = Number(process.argv[4] || 10000);
const dbPath = join(dir, 'board.sqlite');

const listDir = () => existsSync(dir) ? readdirSync(dir).sort() : [];
const rows = (db) => {
    try { return db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n; } catch { return 'no-table'; }
};

// ─────────────────────────────── 场景 2：schema 不匹配 ───────────────────────────────
if (mode === 'schema') {
    rmSync(dir, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });

    // 用「旧 schema」建库：jobs 表故意缺 `interrupted` / `repeat_ms` / `dependsOn` 三列，
    // 并且 priority 存在（避免索引优先级干扰，先单独验证纯缺列场景）。
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
        CREATE TABLE jobs (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'personal', parentId TEXT,
            title TEXT, skill TEXT, args TEXT, why TEXT, priority INTEGER NOT NULL DEFAULT 5,
            source TEXT, assignee TEXT, requires TEXT, claims TEXT,
            state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            maxAttempts INTEGER NOT NULL DEFAULT 3,
            lease_owner TEXT, lease_until INTEGER,
            progress TEXT, checkpoint TEXT, result TEXT,
            notBefore INTEGER,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
    `);
    raw.prepare(`INSERT INTO jobs (id, skill, args, priority, state, title, createdAt, updatedAt)
                 VALUES (?,?,?,?,?,?,?,?)`)
        .run('old_1', 'mine', '{"block":"oak_log","count":8}', 5, 'ready', '老库里的单子', Date.now(), Date.now());
    console.log(`[schema] 造好旧库：user_version=${raw.prepare('PRAGMA user_version').get().user_version}`
        + ` jobs=${raw.prepare('SELECT COUNT(*) AS n FROM jobs').get().n}`
        + ` 列数=${raw.prepare('PRAGMA table_info(jobs)').all().length}`);
    const before = raw.prepare('SELECT id, title, priority, state FROM jobs').all();
    raw.close();

    console.log(`[schema] 目标 ${dbPath}  size=${statSync(dbPath).size}`);
    const t0 = Date.now();
    let r;
    try {
        r = openBoard(dir);
    } catch (e) {
        console.log(`[schema] ❌ openBoard 抛错（${Date.now() - t0}ms）：${e?.message}`);
        console.log(`[schema] 目录：${JSON.stringify(listDir())}`);
        process.exit(2);
    }
    const dt = Date.now() - t0;
    const after = r.db.prepare('SELECT id, title, priority, state FROM jobs').all();
    const cols = r.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
    console.log(`[schema] openBoard 返回（${dt}ms）`);
    console.log(`[schema]   rebuilt  = ${r.rebuilt}   ← true 就是"把好库删了重建"，本条判定为没修`);
    console.log(`[schema]   migration= ${JSON.stringify(r.migration)}`);
    console.log(`[schema]   user_version 现在 = ${r.db.prepare('PRAGMA user_version').get().user_version}（期望 ${BOARD_SCHEMA_VERSION}）`);
    console.log(`[schema]   表里行数 前=${before.length} 后=${after.length}   ← 少一行就是丢单`);
    console.log(`[schema]   老行还在？ ${JSON.stringify(after)}`);
    console.log(`[schema]   补上的列：${JSON.stringify(cols.filter((c) => ['interrupted', 'repeat_ms', 'dependsOn'].includes(c)))}`);
    console.log(`[schema]   目录：${JSON.stringify(listDir())}`);
    r.db.close();
    const ok = r.rebuilt === false && after.length === before.length
        && ['interrupted', 'repeat_ms', 'dependsOn'].every((c) => cols.includes(c));
    console.log(`[schema] 判定：${ok ? '✅ 迁移成功、未重建、单子全在' : '❌ 不符合预期'}`);
    process.exit(ok ? 0 : 3);
}

// ─────────────────────────────── 场景 1：锁冲突 ───────────────────────────────
if (mode === 'hold') {
    // 先用真实 openBoard 建一个正常库（含 WAL 与列全），再压回 DELETE 模式。
    if (!existsSync(dbPath)) {
        const b = openBoard(dir);
        b.db.prepare(`INSERT INTO jobs (id, skill, args, priority, state, title, createdAt, updatedAt)
                      VALUES (?,?,?,?,?,?,?,?)`)
            .run('lock_1', 'mine', '{"block":"oak_log","count":8}', 5, 'ready', '锁测试单', Date.now(), Date.now());
        b.db.close();
    }
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = DELETE');       // ★ 关键：关掉 WAL，否则读不被堵
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
    console.log(`[hold pid=${process.pid}] BEGIN EXCLUSIVE OK  模式=${db.prepare('PRAGMA journal_mode').get().journal_mode}  保持 ${ms}ms`);
    console.log(`[hold] 库内行数=${db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n}  size=${statSync(dbPath).size}`);
    await new Promise((r) => setTimeout(r, ms));
    try { db.exec('COMMIT'); } catch { /* ignore */ }
    db.close();
    console.log(`[hold] 释放`);
    process.exit(0);
}

if (mode === 'probe') {
    console.log(`[probe] 打开前：exists=${existsSync(dbPath)} size=${existsSync(dbPath) ? statSync(dbPath).size : 0} 目录=${JSON.stringify(listDir())}`);
    const t0 = Date.now();
    let r = null, err = null;
    try { r = openBoard(dir); } catch (e) { err = e; }
    const dt = Date.now() - t0;
    if (err) {
        console.log(`[probe] openBoard 抛错（${dt}ms）：${String(err.message).slice(0, 120)}`);
        console.log(`[probe]   errcode=${err.errcode ?? '(none)'}`);
    } else {
        console.log(`[probe] openBoard 正常返回（${dt}ms）`);
        console.log(`[probe]   rebuilt = ${r.rebuilt}   ← true 表示把好库当坏库改名重建`);
        console.log(`[probe]   backup  = ${r.backup ?? '(none)'}`);
        try { console.log(`[probe]   jobs 行 = ${rows(r.db)}`); } catch { /* ignore */ }
        r.db.close();
    }
    const dirNow = listDir();
    console.log(`[probe] 打开后：exists=${existsSync(dbPath)} 目录=${JSON.stringify(dirNow)}`);
    const corrupt = dirNow.filter((f) => f.includes('.corrupt-'));
    console.log(`[probe] 是否出现 .corrupt- 备份：${corrupt.length ? JSON.stringify(corrupt) : '无'}`);
    // 判定：好库必须还在、且没有 .corrupt-（若抛错是"锁忙"的正确定性，也算修对）
    const survived = existsSync(dbPath) && corrupt.length === 0;
    console.log(`[probe] 判定：${survived ? '✅ 好库没被删/改名' : '❌ 好库被动了'}`);
    process.exit(survived ? 0 : 4);
}

console.log('用法：schema <dir> | hold <dir> <ms> | probe <dir>');
