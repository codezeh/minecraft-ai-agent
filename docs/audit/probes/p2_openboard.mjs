// P2-B：调真实的 openBoard()，看它遇到 SQLITE_BUSY 时到底做什么。
// 运行：node docs/audit/probes/p2_openboard.mjs <boardDir>
// 判定依据：rebuilt 是否为 true（= 把库当损坏、改名重建）；以及板库文件是否被换掉。
import { openBoard } from '../../../mindcraft/src/agent/library/board_store.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || './p2-board');
const dbPath = join(dir, 'board.sqlite');

console.log(`[B] 目标库：${dbPath}`);
console.log(`[B] 打开前 exists=${existsSync(dbPath)}` + (existsSync(dbPath) ? ` size=${statSync(dbPath).size}` : ''));

const t0 = Date.now();
let res, err;
try {
    res = openBoard(dir);
} catch (e) {
    err = e;
}
const ms = Date.now() - t0;

if (err) {
    console.log(`[B] openBoard 抛出异常（${ms}ms）`);
    console.log(`[B]   name    = ${err.name}`);
    console.log(`[B]   code    = ${err.code}`);
    console.log(`[B]   errcode = ${err.errcode}`);
    console.log(`[B]   errstr  = ${err.errstr}`);
    console.log(`[B]   message = ${String(err.message).slice(0, 300)}`);
} else {
    console.log(`[B] openBoard 正常返回（${ms}ms）`);
    console.log(`[B]   rebuilt = ${res.rebuilt}      ← true 表示"当成坏库删了重建"`);
    console.log(`[B]   backup  = ${res.backup ?? '(none)'}`);
    console.log(`[B]   error   = ${String(res.error ?? '(none)').slice(0, 200)}`);
    // 库里的原有数据还在吗？
    let rows = [];
    try { rows = res.db.prepare('SELECT * FROM jobs').all(); } catch (e) { rows = ['<查询失败: ' + e.message + '>']; }
    console.log(`[B]   重建后 jobs 行 = ${JSON.stringify(rows)}   ← 若是空数组，说明原来的单没了`);
    try { res.db.close(); } catch { }
}

console.log(`[B] 打开后目录内容：${JSON.stringify(readdirSync(dir))}`);
