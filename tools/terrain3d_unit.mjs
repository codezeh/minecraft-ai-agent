/**
 * terrain3d 连接复用与 fail 表 TTL 的回归测试 —— 不需要服务器。
 *
 * 修的两个问题：
 *  1) 每个函数都 openDb3d() → 干活 → db.close()：
 *     一次查询要付一次构造 + WAL + 3 条 PRAGMA + 开关文件的代价（实测 ~50ms），
 *     而游走时每秒查几十次。现在按库目录缓存连接。
 *  2) fail 表的 TTL **从来没生效过**：
 *     语句是 `SELECT x, z, y, hits FROM fail`，没取 last_at，
 *     于是 `now - r.last_at` 恒为 NaN，`NaN > ttlMs` 恒为 false。
 *     现在 TTL 下推到 SQL（WHERE last_at >= ?）并加了索引，另有 pruneFails 真删过期行。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    dbFor, closeDb3d, saveSurfaces, columnSurfaces, boxSurfaces,
    recordFail, readFails, pruneFails, stats3d,
} from '../src/agent/library/terrain3d.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

const dir = mkdtempSync(join(tmpdir(), 't3d-unit-'));
try {
    // ── 1. dbFor 必须复用同一个连接实例 ────────────────────────────────
    {
        const a = dbFor(dir);
        const b = dbFor(dir);
        if (a === b) okCase('dbFor 复用连接', 'same instance');
        else badCase('dbFor 复用连接', 'different instances');
    }

    // ── 2. 重复读不再触发 open/close（用统计函数探活，且连接仍可用）────
    {
        saveSurfaces(dir, [
            { x: 0, z: 0, y: 64, t: 1 },
            { x: 1, z: 0, y: 65, t: 1 },
        ]);
        const col = columnSurfaces(dir, 0, 0);
        const box = boxSurfaces(dir, 0, 0, 1, 0);
        const st = stats3d(dir);
        // 注意：写入/读取走的是同一个缓存连接，若被 close 过，这里会抛
        if (col.length === 1 && col[0].y === 64 && box.length === 2 && st.cells >= 1) {
            okCase('缓存连接读写正常', `col=${col.length} box=${box.length} cells=${st.cells}`);
        } else {
            badCase('缓存连接读写正常', JSON.stringify({ col, box, st }));
        }
    }

    // ── 3. fail TTL：11 分钟前的失败必须读不到（旧代码这里是 NaN 判断）──
    {
        const now = Date.now();
        recordFail(dir, 10, 64, 10, { now: now - 11 * 60 * 1000 });   // 过期
        recordFail(dir, 20, 64, 20, { now: now - 60 * 1000 });        // 1 分钟前，仍有效
        const live = readFails(dir, { now, ttlMs: 10 * 60 * 1000 });
        const hasOld = live.has('10,64,10');
        const hasNew = live.has('20,64,20');
        if (!hasOld && hasNew) {
            okCase('fail TTL 生效', `live=${JSON.stringify([...live.keys()])}`);
        } else {
            badCase('fail TTL 生效', `hasOld=${hasOld} hasNew=${hasNew}`);
        }
    }

    // ── 4. pruneFails 真的把过期行删掉 ─────────────────────────────────
    {
        const now = Date.now();
        const removed = pruneFails(dir, { now, ttlMs: 10 * 60 * 1000 });
        // 只剩 1 分钟前那条有效记录
        const live = readFails(dir, { now, ttlMs: 10 * 60 * 1000 });
        if (removed >= 1 && live.size === 1) {
            okCase('pruneFails 删除过期行', `removed=${removed} left=${live.size}`);
        } else {
            badCase('pruneFails 删除过期行', `removed=${removed} left=${live.size}`);
        }
    }
} finally {
    closeDb3d(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶尔占用 */ }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
