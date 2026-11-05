// P2-A（修正版）：用**真实** openBoard 建出正确的 SCHEMA，再拿 BEGIN IMMEDIATE 写锁保持 N 秒。
// 运行：node docs/audit/probes/p2_lockholder.mjs <boardDir> [holdMs]
import { DatabaseSync } from 'node:sqlite';
import { openBoard } from '../../../mindcraft/src/agent/library/board_store.js';
import { join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const dir = resolve(process.argv[2] || './p2-board');
const holdMs = Number(process.argv[3] || 8000);
const dbPath = join(dir, 'board.sqlite');

// ① 先用真实 openBoard 建库（拿到正确 schema），并塞一条真实单
const boot = openBoard(dir);
const job = {
    skill: 'mine', args: { block: 'oak_log', count: 8 }, priority: 5,
    kind: 'personal', state: 'ready', title: 'P2 探针单', source: 'system',
};
let jobId = null;
try {
    const r = boot.db.prepare(
        `INSERT INTO jobs (skill,args,priority,kind,state,title,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?)`
    ).run(job.skill, JSON.stringify(job.args), job.priority, job.kind, job.state, job.title, Date.now(), Date.now());
    jobId = String(r.lastInsertRowid);
} catch (e) {
    console.log('[A] 插入探针单失败（不影响锁测试）:', e.message);
}
console.log(`[A pid=${process.pid}] db=${dbPath} size=${statSync(dbPath).size} 探针单=${jobId}`);
boot.db.close();

// ② 另开一个连接，只拿写锁
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
const t0 = Date.now();
try {
    db.exec('BEGIN IMMEDIATE');
    console.log(`[A] BEGIN IMMEDIATE OK → 已持有写锁，保持 ${holdMs}ms`);
} catch (e) {
    console.log(`[A] BEGIN IMMEDIATE FAILED: ${e.errcode} ${e.message}`);
    process.exit(2);
}
await new Promise(r => setTimeout(r, holdMs));
try { db.exec('ROLLBACK'); } catch { }
try { db.close(); } catch { }
console.log(`[A] 释放写锁，共持有 ${Date.now() - t0}ms`);
