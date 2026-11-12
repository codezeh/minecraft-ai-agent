/**
 * 存档维度 `world_id`（阶段 3 / ADR-0001 D6）—— 离线，真文件 + 真 sqlite。
 *
 * 钉死的四件事：
 *   ① sidecar 幂等（同目录两次同一个 id；删世界 = 新 id）；坏了/非法 id ⇒ **抛错**，不偷偷重生成；
 *   ② 目录形状 `_worlds/<id>/_board/board.sqlite`，`boardDirOf()` 旧位置仍然可用；
 *   ③ 迁移**跑两次结果一致**：先备份 `.bak-<ts>`（含 WAL/SHM）、旧位置留 MIGRATED-TO.txt、数据可读；
 *   ④ `worldIdOfBoardDb()` 反解不出**必须报错**（绝不返回 null 让调用方当"单库单世界"）。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as W from '../src/mindcraft/world_store.js';
import { boardDirForWorld, boardDirOf, botsRootOf } from '../src/agent/library/bot_paths.js';
import { openBoard } from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
/** 收走模块的 console.warn：本测试要断言"该告警的地方真的告警了"（不静默）。 */
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
const chk = (n, c, i) => {
    if (c) { pass++; console.log(`  PASS  ${n}${i ? '   ' + i : ''}`); }
    else { fail++; console.log(`  FAIL  ${n}   ${JSON.stringify(i)}`); }
};
/** 断言"这行必须抛错"，并且错误码对得上（返回抛出的错误，方便继续看 message）。 */
const chkThrow = (n, fn, code) => {
    try {
        const v = fn();
        chk(n, false, { threw: false, returned: v });
        return null;
    } catch (e) {
        chk(n, code == null || e?.code === code, { code: e?.code, message: String(e?.message ?? e).slice(0, 120) });
        return e;
    }
};

const ROOT = mkdtempSync(join(tmpdir(), 'world-store-test-'));
const BOTS = join(ROOT, 'bots');
const WORLD = join(ROOT, 'world');
mkdirSync(WORLD, { recursive: true });   // 空的世界目录（sidecar 稍后生成）
process.env.MC_BOTS_ROOT = BOTS;
process.env.MC_WORLD_DIR = WORLD;
delete process.env.MC_SERVER_DIR;

const norm = (s) => String(s).replace(/\\/g, '/');
const bytes = (f) => readFileSync(f);
const sameBytes = (a, b) => existsSync(a) && existsSync(b) && Buffer.compare(bytes(a), bytes(b)) === 0;
/** 整棵树的快照（路径 + 大小 + sha256），用来证明"跑两次结果一致"。 */
function snapshot(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) { out.push(`D ${norm(relative(dir, p))}`); walk(p); } else {
                const buf = readFileSync(p);
                out.push(`F ${norm(relative(dir, p))} ${buf.length} ${createHash('sha256').update(buf).digest('hex')}`);
            }
        }
    };
    if (existsSync(dir)) walk(dir);
    return out.sort().join('\n');
}
/** 造一块**真**的旧板库（走 openBoard，所以 user_version/schema 都是真的）。 */
function makeBoardIn(dir, marker) {
    mkdirSync(dir, { recursive: true });
    const h = openBoard(dir, { quiet: true });
    h.db.exec('CREATE TABLE IF NOT EXISTS world_probe(x TEXT)');
    h.db.prepare('INSERT INTO world_probe(x) VALUES (?)').run(marker);
    h.db.close();
    return join(dir, 'board.sqlite');
}
/** 只读打开新位置的库，取回 marker（证明数据真的搬过去了、还能读）。 */
function readMarkerIn(dir) {
    const h = openBoard(dir, { readOnly: true, quiet: true });
    try { return h.db.prepare('SELECT x FROM world_probe').get()?.x ?? null; } finally { h.db.close(); }
}

// ══════════════════════════════════════════════════════════════════════════
// ① sidecar：幂等生成 / 损坏不重生成
// ══════════════════════════════════════════════════════════════════════════
console.log('① sidecar');
{
    const id1 = W.worldIdOf(WORLD);
    chk('worldIdOf 生成合法 id', /^w-\d{8}-[0-9a-f]{8}$/.test(id1), id1);
    const file = join(WORLD, W.WORLD_ID_FILE);
    chk('sidecar 落在世界目录里', existsSync(file), W.WORLD_ID_FILE);
    const sidecar = JSON.parse(readFileSync(file, 'utf8'));
    chk('sidecar 结构 = {schema,id,createdAt}', sidecar.schema === 1 && sidecar.id === id1 && Boolean(sidecar.createdAt), sidecar);
    const raw1 = readFileSync(file, 'utf8');
    const id2 = W.worldIdOf(WORLD);
    chk('同目录两次 → 同一个 id', id2 === id1, { id1, id2 });
    chk('第二次不重写 sidecar（字节一致）', readFileSync(file, 'utf8') === raw1);
    chk('readWorldIdOf 读得出来', W.readWorldIdOf(WORLD).ok === true && W.readWorldIdOf(WORLD).worldId === id1);

    // 删世界 = 新 id —— 换个目录就是另一档
    const other = join(ROOT, 'world2');
    mkdirSync(other, { recursive: true });
    chk('另一个世界目录 → 另一个 id', W.worldIdOf(other) !== id1);

    // 嵌套目录也能建（世界目录不存在时逐级创建）
    const deep = join(ROOT, 'server-x', 'world');
    const deepId = W.worldIdOf(deep);
    chk('世界目录不存在 → 逐级创建 + 生成', existsSync(join(deep, W.WORLD_ID_FILE)) && W.isValidWorldId(deepId), deepId);

    // 损坏：坏了必须抛，且**不许**覆盖原文件（否则 _worlds/<旧 id> 被静默孤立）
    const corruptDir = join(ROOT, 'world-corrupt');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, W.WORLD_ID_FILE), '{ 这不是 json', 'utf8');
    chkThrow('sidecar 损坏 → 抛 WORLD_ID_SIDECAR_CORRUPT', () => W.worldIdOf(corruptDir), 'WORLD_ID_SIDECAR_CORRUPT');
    chk('损坏时原文件原样保留（不重写）', readFileSync(join(corruptDir, W.WORLD_ID_FILE), 'utf8') === '{ 这不是 json');
    chk('readWorldIdOf 如实报 sidecar-corrupt', W.readWorldIdOf(corruptDir).reason === 'sidecar-corrupt', W.readWorldIdOf(corruptDir).reason);

    // 非法 id（路径穿越形态）：一样抛，不"修好它"
    const evilDir = join(ROOT, 'world-evil');
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(evilDir, W.WORLD_ID_FILE), JSON.stringify({ schema: 1, id: '../../etc' }), 'utf8');
    chkThrow('sidecar id 非法 → 抛 WORLD_ID_SIDECAR_CORRUPT', () => W.worldIdOf(evilDir), 'WORLD_ID_SIDECAR_CORRUPT');
    chk('readWorldIdOf 报 sidecar-invalid-id', W.readWorldIdOf(evilDir).reason === 'sidecar-invalid-id');
    chkThrow('worldIdOf("") → 抛（不编 id）', () => W.worldIdOf(''), 'WORLD_ID_UNRESOLVABLE');
    chk('isValidWorldId 挡住 ../x', W.isValidWorldId('../x') === false && W.isValidWorldId('w-1') === true && W.isValidWorldId('_x') === false);
}

// ══════════════════════════════════════════════════════════════════════════
// ② 目录形状
// ══════════════════════════════════════════════════════════════════════════
console.log('② 目录形状');
{
    const id = W.worldIdOf(WORLD);
    chk('worldsRootOf = <bots>/_worlds', norm(W.worldsRootOf()) === `${norm(botsRootOf())}/_worlds`, W.worldsRootOf());
    chk('worldDataDirOf = <bots>/_worlds/<id>', norm(W.worldDataDirOf(id)) === `${norm(botsRootOf())}/_worlds/${id}`, W.worldDataDirOf(id));
    chk('ensureWorldDir 真的建出来', norm(W.ensureWorldDir(id)).endsWith(`/_worlds/${id}`) && existsSync(W.worldDataDirOf(id)));
    chkThrow('worldDataDirOf("../x") → 抛', () => W.worldDataDirOf('../x'), 'WORLD_ID_INVALID');
    chk('boardDirForWorld = <bots>/_worlds/<id>/_board',
        norm(boardDirForWorld(id)) === `${norm(botsRootOf())}/_worlds/${id}/_board`, boardDirForWorld(id));
    chk('boardDirOf（旧位置）保留且不变', norm(boardDirOf()) === `${norm(botsRootOf())}/_board`, boardDirOf());
    const savedEnv = process.env.MC_WORLD_DIR;
    delete process.env.MC_WORLD_DIR;
    chk('currentWorldDir 默认 = <仓库>/server/world', norm(W.currentWorldDir()).endsWith('/server/world'), W.currentWorldDir());
    process.env.MC_WORLD_DIR = savedEnv;
    chk('currentWorldDir 认 MC_WORLD_DIR', norm(W.currentWorldDir()) === norm(WORLD));
    chk('currentWorldId = 当前世界 sidecar 的 id', W.currentWorldId() === W.readWorldIdOf(WORLD).worldId);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 迁移：备份 / 指路牌 / 数据可读 / 跑两次一致
// ══════════════════════════════════════════════════════════════════════════
console.log('③ 迁移');
{
    const id = W.currentWorldId();
    const legacyDb = makeBoardIn(boardDirOf(), 'legacy-job-A');
    const legacyBytes = bytes(legacyDb);
    const m1 = W.migrateLegacyBoardToWorld(id, { quiet: true });
    const targetDir = boardDirForWorld(id);
    const targetDb = join(targetDir, 'board.sqlite');

    chk('迁移后 migrated=true', m1.migrated === true && m1.reason === 'migrated', { reason: m1.reason });
    chk('新位置 board.sqlite 存在', existsSync(targetDb), targetDb);
    chk('新库与迁移前的原库逐字节相同', Buffer.compare(bytes(targetDb), legacyBytes) === 0);
    chk('旧位置不再有 board.sqlite', !existsSync(legacyDb));
    chk('备份是 .bak-<时间戳> 且内容 = 原库', /board\.sqlite\.bak-\d{8}(\d{6})?(-\d+)?$/.test(m1.backup) && sameBytes(m1.backup, targetDb), m1.backup);
    chk('旧位置留 MIGRATED-TO.txt', existsSync(join(boardDirOf(), 'MIGRATED-TO.txt')));
    const note = readFileSync(join(boardDirOf(), 'MIGRATED-TO.txt'), 'utf8');
    chk('MIGRATED-TO.txt 写清 world_id 与去向', note.includes(`world_id: ${id}`) && norm(note).includes(norm(targetDb)), note.split('\n').slice(1, 4));
    chk('数据搬过去还能读', readMarkerIn(targetDir) === 'legacy-job-A', readMarkerIn(targetDir));

    // 跑第二次：一个字节都不该变
    const snap1 = snapshot(BOTS);
    const m2 = W.migrateLegacyBoardToWorld(id, { quiet: true });
    const snap2 = snapshot(BOTS);
    chk('第二次 migrated=false / already-migrated', m2.migrated === false && m2.reason === 'already-migrated', m2.reason);
    chk('第二次整棵树完全一致（幂等）', snap1 === snap2, snap1 === snap2 ? '' : 'tree changed');
    const backups = readdirSync(boardDirOf()).filter((f) => f.startsWith('board.sqlite.bak-'));
    chk('备份只有一个（不重复备份）', backups.length === 1, backups);

    // prepareBoardDirForCurrentWorld：生产入口（幂等 + 返回目录）
    const dir1 = W.prepareBoardDirForCurrentWorld({ quiet: true });
    const dir2 = W.prepareBoardDirForCurrentWorld({ quiet: true });
    chk('prepareBoardDirForCurrentWorld 返回 <bots>/_worlds/<id>/_board', norm(dir1) === norm(targetDir), dir1);
    chk('prepare 两次返回同一目录且不再备份', dir2 === dir1 && readdirSync(boardDirOf()).filter((f) => f.startsWith('board.sqlite.bak-')).length === 1);
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 边界：两边都有库 / 没有旧库 / WAL 家族
// ══════════════════════════════════════════════════════════════════════════
console.log('④ 迁移边界');
{
    // ④.1 两边都有库：不改任何一方（宁可报出来让人决定，也不合并一个已经错了的数据）
    const root2 = join(ROOT, 'bots-both');
    process.env.MC_BOTS_ROOT = root2;
    const id2 = W.worldIdOf(WORLD);
    const legacyDb = makeBoardIn(boardDirOf(), 'legacy-B');
    const targetDb = makeBoardIn(boardDirForWorld(id2), 'target-A');
    const legacySnap = readFileSync(legacyDb);
    const targetSnap = readFileSync(targetDb);
    const m = W.migrateLegacyBoardToWorld(id2, { quiet: true });
    chk('两边都有 → migrated=false / both-exist', m.migrated === false && m.reason === 'both-exist', m.reason);
    chk('两边都有 → 谁都不动', Buffer.compare(readFileSync(legacyDb), legacySnap) === 0 && Buffer.compare(readFileSync(targetDb), targetSnap) === 0);

    // ④.2 没有旧库：建目标目录、不造 MIGRATED-TO
    const root3 = join(ROOT, 'bots-fresh');
    process.env.MC_BOTS_ROOT = root3;
    const m3 = W.migrateLegacyBoardToWorld(id2, { quiet: true });
    chk('没有旧库 → no-legacy-board 且建出目标目录', m3.migrated === false && m3.reason === 'no-legacy-board' && existsSync(boardDirForWorld(id2)), m3.reason);
    chk('没有旧库 → 不写 MIGRATED-TO.txt', !existsSync(join(boardDirOf(), 'MIGRATED-TO.txt')));

    // ④.3 WAL/SHM 一起搬（只搬主文件会丢 WAL 里已提交的页）
    const root4 = join(ROOT, 'bots-wal');
    process.env.MC_BOTS_ROOT = root4;
    mkdirSync(boardDirOf(), { recursive: true });
    const main = join(boardDirOf(), 'board.sqlite');
    writeFileSync(main, 'MAIN');
    writeFileSync(`${main}-wal`, 'WAL');
    writeFileSync(`${main}-shm`, 'SHM');
    const m4 = W.migrateLegacyBoardToWorld(id2, { quiet: true });
    const t = join(boardDirForWorld(id2), 'board.sqlite');
    chk('WAL 家族三件一起搬到新位置', existsSync(t) && existsSync(`${t}-wal`) && existsSync(`${t}-shm`)
        && readFileSync(`${t}-wal`, 'utf8') === 'WAL' && readFileSync(`${t}-shm`, 'utf8') === 'SHM', m4.moved.length);
    const bakWal = dirOfBak(m4.backup, '-wal');
    const bakShm = dirOfBak(m4.backup, '-shm');
    chk('WAL 家族三件都有备份（含 -wal/-shm）', existsSync(m4.backup) && existsSync(bakWal) && existsSync(bakShm)
        && readFileSync(bakWal, 'utf8') === 'WAL' && readFileSync(bakShm, 'utf8') === 'SHM', { bak: m4.backup });
    chk('旧位置三件都不在了', !existsSync(main) && !existsSync(`${main}-wal`) && !existsSync(`${main}-shm`));
    process.env.MC_BOTS_ROOT = BOTS;
}

/** 备份文件名形如 `board.sqlite.bak-<stamp>`；`-wal` 那份是 `board.sqlite-wal.bak-<stamp>`。 */
function dirOfBak(backup, suffix) {
    return backup.replace(/board\.sqlite\.bak-/, `board.sqlite${suffix}.bak-`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ worldIdOfBoardDb：反解 / 反解不出必须抛
// ══════════════════════════════════════════════════════════════════════════
console.log('⑤ worldIdOfBoardDb');
{
    const id = W.currentWorldId();
    const good = `${boardDirForWorld(id)}/board.sqlite`;
    chk('反解新位置 → world_id', W.worldIdOfBoardDb(good) === id, W.worldIdOfBoardDb(good));
    chk('Windows 反斜杠也认', W.worldIdOfBoardDb(good.replace(/\//g, '\\')) === id);
    chkThrow('旧位置 bots/_board/board.sqlite → 抛', () => W.worldIdOfBoardDb(`${boardDirOf()}/board.sqlite`), 'WORLD_ID_UNRESOLVABLE');
    chkThrow('随便一个路径 → 抛', () => W.worldIdOfBoardDb(join(ROOT, 'whatever', 'board.sqlite')), 'WORLD_ID_UNRESOLVABLE');
    chkThrow('空路径 → 抛', () => W.worldIdOfBoardDb(''), 'WORLD_ID_UNRESOLVABLE');
    chkThrow('只到 _worlds/<id>（没指到库文件）→ 抛', () => W.worldIdOfBoardDb(`${botsRootOf()}/_worlds/${id}`), 'WORLD_ID_UNRESOLVABLE');
    chkThrow('_worlds 后面没有 id → 抛', () => W.worldIdOfBoardDb(`${botsRootOf()}/_worlds`), 'WORLD_ID_UNRESOLVABLE');
    chkThrow('_worlds 后面是非法 id → 抛', () => W.worldIdOfBoardDb(`${botsRootOf()}/_worlds/../x/board.sqlite`), 'WORLD_ID_UNRESOLVABLE');
    chkThrow('_worlds/<id>/../../x → 抛（含 ..）', () => W.worldIdOfBoardDb(`${botsRootOf()}/_worlds/${id}/../../../x/board.sqlite`), 'WORLD_ID_UNRESOLVABLE');
    const probe = W.tryWorldIdOfBoardDb(`${boardDirOf()}/board.sqlite`);
    chk('try 版不抛，回 {ok:false, reason}', probe.ok === false && probe.worldId === null && typeof probe.reason === 'string', probe);
    const probeOk = W.tryWorldIdOfBoardDb(good);
    chk('try 版成功回 {ok:true, worldId}', probeOk.ok === true && probeOk.worldId === id, probeOk);
    // 反解出的 id 必须能直接喂给世界目录（两个调用方不许各自拼路径）
    chk('反解 → worldDataDirOf 可用', norm(W.worldDataDirOf(W.worldIdOfBoardDb(good))) === `${norm(botsRootOf())}/_worlds/${id}`);
    chk('旧版 `_worlds/<id>/board.sqlite`（ADR 早期形状）也反解得出来', W.worldIdOfBoardDb(`${botsRootOf()}/_worlds/${id}/board.sqlite`) === id);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ resolveExistingBoardDir：只读观察工具找库（**绝不建目录、绝不写 sidecar**）
// ══════════════════════════════════════════════════════════════════════════
console.log('⑥ resolveExistingBoardDir（只读）');
{
    const worldSidecarRaw = readFileSync(join(WORLD, W.WORLD_ID_FILE), 'utf8');   // ⑥ 全程不许被改写
    // ⑥.1 迁移后：当前世界有 sidecar → 指到 `_worlds/<id>/_board`
    const id = W.currentWorldId();
    chk('迁移后指向 _worlds/<id>/_board',
        norm(W.resolveExistingBoardDir()) === norm(boardDirForWorld(id)), W.resolveExistingBoardDir());

    // ⑥.2 还没迁移（只有旧库）：指到旧位置，且**不写 sidecar**
    const freshWorld = join(ROOT, 'world-nosidecar');
    mkdirSync(freshWorld, { recursive: true });
    const freshBots = join(ROOT, 'bots-legacy-only');
    process.env.MC_BOTS_ROOT = freshBots;
    process.env.MC_WORLD_DIR = freshWorld;
    makeBoardIn(boardDirOf(), 'legacy-only');
    chk('只有旧库 → 指到旧位置', norm(W.resolveExistingBoardDir()) === norm(boardDirOf()), W.resolveExistingBoardDir());
    chk('找库**不会**生成 sidecar（纯读）', !existsSync(join(freshWorld, W.WORLD_ID_FILE)));

    // ⑥.3 当前世界没有库、但磁盘上只有一个存档有库 → 用它（迁移前/换世界诊断都靠这条）
    process.env.MC_WORLD_DIR = WORLD;                       // 这个世界的 id 与下面那个不同
    const otherId = 'w-20260101-aaaaaaaa';
    makeBoardIn(boardDirForWorld(otherId), 'single-world-db');
    rmSync(join(freshBots, '_board'), { recursive: true, force: true });
    chk('只有一个存档有库 → 指到它',
        norm(W.resolveExistingBoardDir()) === norm(boardDirForWorld(otherId)), W.resolveExistingBoardDir());
    chk('⑥ 全程没改写 WORLD 的 sidecar', readFileSync(join(WORLD, W.WORLD_ID_FILE), 'utf8') === worldSidecarRaw);

    // ⑥.4 多个存档都有库 + 当前世界没有 → 不猜，退回旧位置（宁可不给，也不给错的）
    makeBoardIn(boardDirForWorld('w-20260101-bbbbbbbb'), 'second-world-db');
    chk('多个存档都有库 → 退回旧位置（不猜）',
        norm(W.resolveExistingBoardDir()) === norm(boardDirOf()), W.resolveExistingBoardDir());

    process.env.MC_BOTS_ROOT = BOTS;
    process.env.MC_WORLD_DIR = WORLD;
}

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 运维 CLI：`--dry-run` 必须**零写入**（预演不许偷偷生成 sidecar）
// ══════════════════════════════════════════════════════════════════════════
console.log('⑦ world_migrate.mjs');
{
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'world_migrate.mjs');
    const cliRoot = join(ROOT, 'cli');
    const cliBots = join(cliRoot, 'bots');
    const cliWorld = join(cliRoot, 'world');
    mkdirSync(join(cliBots, '_board'), { recursive: true });
    mkdirSync(cliWorld, { recursive: true });
    const env = { ...process.env, MC_BOTS_ROOT: cliBots, MC_WORLD_DIR: cliWorld };
    const run = (args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });

    const dryOut = run(['--dry-run']);
    chk('--dry-run 不写任何文件（连 sidecar 都不生成）', !existsSync(join(cliWorld, W.WORLD_ID_FILE)), cliWorld);
    chk('--dry-run 如实说"还没有 sidecar"', dryOut.includes('还没有 sidecar'), dryOut.split('\n')[2]);

    makeBoardIn(join(cliBots, '_board'), 'cli-legacy');
    const realOut = run([]);
    chk('真跑 → 已搬移', realOut.includes('已搬移'), realOut.split('\n').find((l) => l.startsWith('迁移：')));
    chk('真跑 → 反解校验打印出 world_id', /反解校验：w-\d{8}-[0-9a-f]{8}/.test(realOut), realOut.split('\n').pop());
    const legacyDb = join(cliBots, '_board', 'board.sqlite');
    let legacyExit = 0;
    try { execFileSync(process.execPath, [cli, '--db', legacyDb], { env, encoding: 'utf8' }); } catch (e) { legacyExit = e.status; }
    chk('--db 反解旧位置 → exit 1（解析不出必须报错）', legacyExit === 1, legacyExit);
}

console.warn = realWarn;
// 只有"世界目录本来就存在"的调用不该告警；deep 那一档是**新建**世界目录 ⇒ 必须告警一次（不静默生成 id）
{
    const newDirWarns = warns.filter((w) => w.includes('世界目录原本不存在'));
    chk('新建世界目录时告警一次（不静默生成 id）', newDirWarns.length === 1, newDirWarns);
    chk('告警里点名了那个新建目录', newDirWarns[0]?.includes('server-x'), newDirWarns[0]?.slice(0, 120));
    chk('世界目录已存在时不告警', warns.filter((w) => w.includes(WORLD) && w.includes('世界目录原本不存在')).length === 0);
}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  通过 ${pass} / 失败 ${fail}（临时目录 ${ROOT}）`);
process.exit(fail === 0 ? 0 : 1);
