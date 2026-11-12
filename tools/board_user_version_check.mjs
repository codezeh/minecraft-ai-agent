/**
 * 板库 `PRAGMA user_version` 线上状态：**只读**体检（R6 #24 的运维侧）。
 *
 * 为什么需要：`user_version` 是 `openBoard` 判断"要不要跑幂等迁移"的唯一依据。
 * 它一旦落后于 `BOARD_SCHEMA_VERSION`，方向是**安全的**（下次 openBoard 会补列+写回），
 * 但如果它**超前**、或版本与真实列结构不一致，就说明"版本号在说谎"：
 * 代码以为库已经是新结构，不会再补列 → 缺列错误在最深处才爆。
 * 这类问题只能在线上库上看出来，任何离线测试都造不出来。
 *
 * 判据（三条一起看，缺一不可）：
 *   1. `PRAGMA user_version` 是否等于 `BOARD_SCHEMA_VERSION`；
 *   2. `jobs` 表实际有的列 是否覆盖代码期望的列（缺列但版本号已高 = 说谎）；
 *   3. `PRAGMA quick_check(1)` 是否 ok（库本身别是坏的）。
 *
 * **只读**：用 `readonly: true` 打开，且只执行 PRAGMA / SELECT。
 * 没有 `readonly` 打开失败时的写回退路 —— 打不开就报错，绝不改成可写。
 *
 * 用法：
 *   node tools/board_user_version_check.mjs                 # 默认 bots/_board/board.sqlite
 *   node tools/board_user_version_check.mjs --db <path>
 *   node tools/board_user_version_check.mjs --json
 *
 * 输出：PASS/WARN/FAIL 逐条；有 FAIL 退出码 1，否则 0。
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 与 board_store.js 用同一个驱动（Node 24 内置 node:sqlite），不额外引 better-sqlite3
import { DatabaseSync } from 'node:sqlite';
import { BOARD_SCHEMA_VERSION, jobColumnDefs } from '../src/agent/library/board_store.js';
import { boardDirOf } from '../src/agent/library/bot_paths.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = resolve(HERE, '..');

let pass = 0, warn = 0, fail = 0;
const rows = [];
const ok = (name, detail = '') => { pass++; rows.push({ level: 'PASS', name, detail }); };
const wn = (name, detail = '') => { warn++; rows.push({ level: 'WARN', name, detail }); };
const bad = (name, detail = '') => { fail++; rows.push({ level: 'FAIL', name, detail }); };

function parseArgs(argv) {
    const out = { db: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--db') out.db = argv[++i];
        else if (argv[i] === '--json') out.json = true;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
// boardDirOf() 已经锚到包根绝对路径（不随 cwd 变），这里只是把默认值算出来
const dbPath = args.db ? resolve(args.db) : resolve(boardDirOf(), 'board.sqlite');

if (!existsSync(dbPath)) {
    wn('板库存在', `找不到 ${dbPath} —— 还没跑过 mindserver？库是 openBoard 首次创建的`);
} else {
    ok('板库存在', dbPath);
    const size = statSync(dbPath).size;
    if (size === 0) bad('板库非空', '文件 0 字节（是个空壳，openBoard 会当成损坏并重建）');
    else ok('板库大小', `${size} 字节`);

    let db = null;
    try {
        // ★ 只读打开：本脚本存在的意义是"看",不是"修"。
        db = new DatabaseSync(dbPath, { readOnly: true });
        ok('只读打开', 'readOnly=true（不会写 user_version、不会触发迁移）');
    }
    catch (e) {
        bad('只读打开', `${e?.message ?? e}`);
    }

    if (db) {
        try {
            // ── 1. user_version ────────────────────────────────────────────
            const uv = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
            const expected = BOARD_SCHEMA_VERSION;
            if (uv === expected) ok('user_version', `${uv}（与 BOARD_SCHEMA_VERSION 一致）`);
            else if (uv < expected) {
                wn('user_version', `${uv} < 期望 ${expected}：落后。下次 openBoard/迁移会补列并写回；也可手动 node -e 走 migrateBoardSchema`);
            } else {
                bad('user_version', `${uv} > 期望 ${expected}：**超前**。说明库被更晚的代码改过，当前代码以为结构已就绪 → 不会再补列，缺列会在深处才爆（降级代码前必须先备份库）`);
            }

            // ── 2. 表结构 vs 版本号（版本号会不会在说谎）───────────────────
            const hasJobs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get();
            if (!hasJobs) {
                bad('jobs 表存在', '没有 jobs 表，但库文件不是空的 —— 结构不完整');
            } else {
                const cols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((r) => String(r.name)));
                ok('jobs 表列数', `${cols.size} 列`);
                // 期望列**不硬编码**：以 board_store 的 SCHEMA 为唯一权威（jobColumnDefs 就是从它解析的）。
                // 硬编码列名会写错（本项目实际是 state/createdAt/args，不是 status/created_at/payload），
                // 写错就会出现"库明明好的却报缺列"的假报警。
                const expectedCols = jobColumnDefs().map((c) => c.name);
                if (expectedCols.length === 0) {
                    wn('jobs 期望列', 'jobColumnDefs() 解析不出列（SCHEMA 结构变了？）—— 跳过列比对');
                }
                else {
                    const missing = expectedCols.filter((c) => !cols.has(c));
                    if (missing.length === 0) ok('jobs 列齐全', `SCHEMA 期望的 ${expectedCols.length} 列都在`);
                    else if (uv >= expected) {
                        bad('jobs 列齐全', `缺 ${missing.join(', ')}，但 user_version 已是 ${uv}（版本号说谎：迁移不会再跑）`);
                    }
                    else {
                        wn('jobs 列齐全', `缺 ${missing.join(', ')}，但 user_version=${uv} 落后 → 下次迁移会补上`);
                    }
                }
            }

            const hasClaims = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claims'").get();
            if (hasClaims) {
                const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='claims'").all();
                const uniq = idx.filter((r) => /UNIQUE/i.test(String(r.sql || '')));
                if (uniq.length > 0) ok('claims 唯一索引', uniq.map((r) => r.name).join(', '));
                else wn('claims 唯一索引', '没有 UNIQUE 索引 —— 同一 key 可被重复插入（R6 #5 的前置条件）');
            } else {
                wn('claims 表', '不存在（从没用过认领功能？）');
            }

            // ── 3. 库本身是否完好 ─────────────────────────────────────────
            const check = db.prepare('PRAGMA quick_check(1)').all();
            const verdict = check.map((r) => Object.values(r)[0]).join('; ');
            if (verdict === 'ok') ok('quick_check', 'ok');
            else bad('quick_check', verdict);
        }
        catch (e) {
            bad('读取库信息', `${e?.message ?? e}`);
        }
        finally {
            try { db.close(); } catch { /* 关闭失败不影响结论 */ }
        }
    }
}

// ── 输出 ─────────────────────────────────────────────────────────────────
if (args.json) {
    console.log(JSON.stringify({ dbPath, expected: BOARD_SCHEMA_VERSION, pass, warn, fail, rows }, null, 2));
} else {
    console.log(`板库 user_version 只读体检`);
    console.log(`  库路径  : ${dbPath}`);
    console.log(`  期望版本: ${BOARD_SCHEMA_VERSION}（BOARD_SCHEMA_VERSION）`);
    console.log('');
    for (const r of rows) {
        const tag = r.level === 'PASS' ? 'PASS' : r.level === 'WARN' ? 'WARN' : 'FAIL';
        console.log(`${tag} ${r.name} ${r.detail}`);
    }
    console.log('');
    console.log(`PASS ${pass} / WARN ${warn} / FAIL ${fail}`);
    console.log('MODE=read-only（readonly 打开，不写 user_version、不跑迁移、不改库）');
    if (fail > 0) {
        console.log('');
        console.log('修法（按 FAIL 类型）：');
        console.log('  · user_version 超前（> 期望）：先 backups/ 备份 board.sqlite，再决定是回退代码还是前滚迁移；');
        console.log('    不要手改 PRAGMA user_version 假装对齐 —— 那会让缺列永远不被补。');
        console.log('  · 关键列缺失但版本号已高：同上，备份后用 migrateBoardSchema(db) 跑一次幂等迁移（它会补列+写回版本）。');
        console.log('  · quick_check 不为 ok：库真的坏了 → openBoard 会改名 .corrupt-<ts> 重建；先把 board.sqlite* 三个文件备份留证。');
    }
}
process.exit(fail === 0 ? 0 : 1);
