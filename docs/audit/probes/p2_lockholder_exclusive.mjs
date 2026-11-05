// P2-A2：用 EXCLUSIVE 锁 + rollback journal（非 WAL）把读也堵死，
// 这才是 openBoard 的 SCHEMA 读会撞 SQLITE_BUSY 的场景。
// 运行：node docs/audit/probes/p2_lockholder_exclusive.mjs <boardDir> [holdMs]
import { DatabaseSync } from 'node:sqlite';
import { openBoard } from '../../../mindcraft/src/agent/library/board_store.js';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || './p2c');
const holdMs = Number(process.argv[3] || 9000);
const dbPath = join(dir, 'board.sqlite');

// ① 真实 openBoard 建库
const boot = openBoard(dir);
try {
    boot.db.prepare(
        `INSERT INTO jobs (skill,args,priority,kind,state,title,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?)`
    ).run('mine', JSON.stringify({ block: 'oak_log', count: 8 }), 5, 'personal', 'ready', 'P2C 探针单', Date.now(), Date.now());
} catch (e) { console.log('[A2] 插单失败:', e.message); }
// ② 把库切回 rollback journal（WAL 下读不会被写者挡）
try { boot.db.exec('PRAGMA journal_mode = DELETE'); } catch (e) { console.log('[A2] 切 journal_mode 失败:', e.message); }
boot.db.close();

// ③ 用 EXCLUSIVE 事务把整个库锁住
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
const t0 = Date.now();
try {
    db.exec('BEGIN EXCLUSIVE');
    console.log(`[A2 pid=${process.pid}] BEGIN EXCLUSIVE OK → 库级独占锁，保持 ${holdMs}ms  db=${dbPath}`);
} catch (e) {
    console.log(`[A2] BEGIN EXCLUSIVE FAILED: errcode=${e.errcode} ${e.message}`);
    process.exit(2);
}
await new Promise(r => setTimeout(r, holdMs));
try { db.exec('ROLLBACK'); } catch { }
try { db.close(); } catch { }
console.log(`[A2] 释放独占锁，共持有 ${Date.now() - t0}ms`);
