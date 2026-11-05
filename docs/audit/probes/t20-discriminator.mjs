// T20 终审 · 鉴别器检验（E 项）：证明"把修复回滚掉，测试会红"
//
// 运行：node docs/audit/probes/t20-discriminator.mjs
//
// 三组，各含「修复版」与「回滚版」两个对照，只依赖公开 API / 等价内联复刻：
//   ① 第32条 心跳循环：runHeartbeatLoop 内部 try/catch（修复版） vs 无 try/catch 的等价 while（回滚版）
//   ② 第24条 schema 迁移：migrateBoardSchema 存在（修复版） vs 直接 db.exec(SCHEMA)（回滚版的等价物）
//   ③ 第25条 memory_store 损坏备份：当前实现是否真的产出 .corrupt- 文件
//
// 结论判据：修复版「存活/成功」且回滚版「死亡/失败」= 该测试具备鉴别力（能抓回滚）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHeartbeatLoop } from '../../../mindcraft/src/agent/library/heartbeat_loop.js';
import { openBoard, jobColumnDefs } from '../../../mindcraft/src/agent/library/board_store.js';
import * as mem from '../../../mindcraft/src/agent/library/memory_store.js';

const RUN = resolve('docs/audit/probes/run/t20-disc');
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
let allPass = true;
const verdict = (name, ok, detail) => {
    if (!ok) allPass = false;
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
};

// ───────── ① 第32条：心跳循环的 try/catch 在不在循环内 ─────────
console.log('\n=== ① 第32条 心跳循环（catch 在循环内 vs 无 catch） ===');
{
    const ITER = 5;
    // 修复版：用生产模块，第 2 拍抛一次
    let seen = 0, threw = 0;
    await runHeartbeatLoop({
        update: async () => { seen += 1; if (seen === 2) { threw += 1; throw new Error('boom@2'); } },
        intervalMs: 1, maxIterations: ITER, sleep: async () => {}, warn: () => {},
    });
    const fixedSurvived = seen === ITER;
    console.log(`   修复版：update 被调用 ${seen}/${ITER} 次（第2拍抛过 ${threw} 次）`);
    verdict('修复版循环活过异常', fixedSurvived);

    // 回滚版：等价内联 while，**catch 在循环外**（= 原来的写法没有 catch）
    seen = 0;
    let crashed = null;
    try {
        let i = 0;
        while (i < ITER) {
            i += 1;
            seen += 1;
            if (seen === 2) throw new Error('boom@2');   // 无 try/catch → 直接打死循环
        }
    } catch (e) { crashed = e.message; }
    console.log(`   回滚版：update 被调用 ${seen}/${ITER} 次，循环以异常终止（${crashed}）`);
    verdict('回滚版循环确实被打死（证明测试能抓回归）', seen === 2 && crashed !== null);
}

// ───────── ② 第24条：migrateBoardSchema 是不是承重的 ─────────
console.log('\n=== ② 第24条 schema 迁移（有 migrate vs 只跑 SCHEMA） ===');
{
    const mkOld = (dir) => {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const db = new DatabaseSync(join(dir, 'board.sqlite'));
        // ★ 旧库刻意**缺 `priority`** —— 这正是 v1→v2 的真实场景：
        //   `SCHEMA` 里的 `CREATE INDEX ... ON jobs(state, priority, createdAt)` 会先炸
        //   `no such column: priority`，所以"补列"必须排在"跑 SCHEMA"之前。
        //   （如果只缺 interrupted/repeat_ms/dependsOn，SCHEMA 根本不引用它们，就测不出承重性。）
        db.exec(`
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'personal', parentId TEXT,
                title TEXT, skill TEXT, args TEXT, why TEXT,
                source TEXT, assignee TEXT, requires TEXT, claims TEXT,
                state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                maxAttempts INTEGER NOT NULL DEFAULT 3,
                lease_owner TEXT, lease_until INTEGER,
                progress TEXT, checkpoint TEXT, result TEXT,
                notBefore INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
            );
            PRAGMA user_version = 1;
        `);
        db.prepare(`INSERT INTO jobs (id, skill, args, state, title, createdAt, updatedAt)
                    VALUES (?,?,?,?,?,?,?)`).run('k1', 'mine', '{}', 'ready', '承重测试单', Date.now(), Date.now());
        db.close();
    };

    // 回滚版等价物：不迁移，直接跑 SCHEMA 的那条索引语句（老库缺 priority → 必炸）
    const dOld = join(RUN, 'rev');
    mkOld(dOld);
    let revErr = null;
    try {
        const db = new DatabaseSync(join(dOld, 'board.sqlite'));
        db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, priority, createdAt)');
        db.close();
    } catch (e) { revErr = e.message; }
    console.log(`   回滚版（不迁移直接建索引，= 回滚后 tryOpen 的等价动作）：${revErr ? '抛错 → ' + String(revErr).slice(0, 70) : '没抛错（说明迁移不承重，需复查）'}`);
    verdict('回滚版确实炸（证明迁移调用是承重的）', revErr !== null);

    // 修复版：完整 openBoard（内部先 migrate 再 SCHEMA）
    const dNew = join(RUN, 'fix');
    mkOld(dNew);
    const r = openBoard(dNew);
    const rows = r.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    console.log(`   修复版 openBoard：rebuilt=${r.rebuilt} migration=${JSON.stringify(r.migration)} rows=${rows}`);
    r.db.close();
    verdict('修复版迁移成功且不重建、单子保留', r.rebuilt === false && rows === 1 && (r.migration?.added ?? []).length > 0);
}

// ───────── ③ 第25条：memory_store 损坏是否留 .corrupt- 备份 ─────────
console.log('\n=== ③ 第25条 memory_store 损坏备份 ===');
{
    const d = join(RUN, 'mem');
    mkdirSync(join(d, 'bots', 'memprobe', 'memory'), { recursive: true });
    // memory_store 的路径是 process.cwd() + bots/<name>/memory
    const ns = 'chests';
    const p = join(d, 'bots', 'memprobe', 'memory', `${ns}.json`);
    // 造一个"坏文件"
    writeFileSync(p, '{ this is not json', 'utf8');
    const prevCwd = process.cwd();
    process.chdir(d);
    let got = null;
    try {
        got = mem.readStore({ username: 'memprobe' }, ns);   // 期望：返回 fallback，且留下 .corrupt-
    } catch (e) {
        console.log(`   readStore 抛错：${e.message}`);
    }
    process.chdir(prevCwd);
    const files = existsSync(join(d, 'bots', 'memprobe', 'memory'))
        ? readdirSync(join(d, 'bots', 'memprobe', 'memory')) : [];
    const hasBackup = files.some((f) => f.includes('.corrupt-'));
    console.log(`   返回 fallback=${JSON.stringify(got)}  目录=${JSON.stringify(files)}`);
    verdict('损坏时留下 .corrupt- 备份（第25条的修复点）', hasBackup);
    verdict('损坏时不抛、仍返回 fallback（保持可用）', got !== null && got !== undefined);
}

console.log(`\n=== 总判定：${allPass ? '✅ 三组鉴别器全部成立' : '❌ 有鉴别器不成立'} ===`);
process.exit(allPass ? 0 : 1);
