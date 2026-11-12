#!/usr/bin/env node
/**
 * 存档维度运维小工具（阶段 3 / ADR-0001 D6）。
 *
 * 三件事，都不改库内容：
 *   node tools/world_migrate.mjs                  # 报告当前 world_id + 板库位置，并跑**幂等**迁移
 *   node tools/world_migrate.mjs --dry-run        # 只报告，**不写任何文件**（连 sidecar 都不生成）
 *   node tools/world_migrate.mjs --db <file>      # 反解某块板库属于哪个存档（解析不出 = FAIL + exit 1）
 *
 * 为什么 --dry-run 要单独一条路径：`currentWorldId()` **有写副作用**（首次会建目录 + 写 sidecar）。
 * 预演号称"不写任何文件"却偷偷生成一个 id，就是下一个"假绿"。所以 dry-run 只走纯读的
 * `readWorldIdOf()`；还没 sidecar 就如实说"首次启动会生成新的"。
 *
 * `--db` 是纯字符串反解，**不打开数据库**。迁移的前提是板库没有进程在写
 * （正常路径是 mindserver 启动时自己迁移，这个脚本给"人工排查/预演"用）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { boardDirForWorld, boardDirOf, botsRootOf } from '../src/agent/library/bot_paths.js';
import {
    currentWorldDir, currentWorldId, migrateLegacyBoardToWorld, readWorldIdOf,
    tryWorldIdOfBoardDb, worldIdOfBoardDb,
} from '../src/mindcraft/world_store.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const arg = (f) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : null; };

/** 现有 `_worlds/*` 目录清单（只读，用来发现"已经分过档但当前世界不是它"的情况）。 */
function worldsOnDisk() {
    const root = join(botsRootOf(), '_worlds');
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ id: d.name, db: join(root, d.name, '_board', 'board.sqlite') }))
        .map((w) => ({ ...w, hasDb: existsSync(w.db) }));
}

const json = has('json');
if (has('db')) {
    const dbFile = arg('db');
    const probe = tryWorldIdOfBoardDb(dbFile);
    if (json) console.log(JSON.stringify({ db: dbFile, ...probe }, null, 2));
    else if (probe.ok) console.log(`OK world_id=${probe.worldId}  (${dbFile})`);
    else console.log(`FAIL 反解不出 world_id：${probe.reason}`);
    process.exit(probe.ok ? 0 : 1);
}

const dryRun = has('dry-run');
const worldDir = currentWorldDir();
const sidecar = readWorldIdOf(worldDir);
// ★ dry-run 只读：不生成 sidecar（生成 id 是写操作，见文件头）
const worldId = dryRun ? (sidecar.ok ? sidecar.worldId : null) : currentWorldId();
const legacyFrom = join(boardDirOf(), 'board.sqlite');
const targetDir = worldId ? boardDirForWorld(worldId) : null;
const targetTo = targetDir ? join(targetDir, 'board.sqlite') : null;

const report = {
    botsRoot: botsRootOf(),
    worldDir,
    dryRun,
    sidecar: { file: sidecar.file, exists: sidecar.ok },
    worldId,
    legacy: { file: legacyFrom, exists: existsSync(legacyFrom) },
    target: targetTo
        ? { dir: targetDir, file: targetTo, exists: existsSync(targetTo) }
        : { dir: null, file: null, exists: false, note: '还没有 sidecar ⇒ 还没有目标目录（首次启动时才生成 id）' },
    worldsOnDisk: worldsOnDisk(),
    migration: null,
};

if (!dryRun) {
    // quiet=false：迁移真发生时打一行日志（运维要知道库动了）
    report.migration = migrateLegacyBoardToWorld(worldId);
} else {
    // 纯预演：只比"存在不存在"，不动文件
    const legacyExists = existsSync(legacyFrom);
    let reason;
    if (!worldId) reason = legacyExists ? 'would-generate-id-then-migrate' : 'no-sidecar-yet（首次启动生成新 id；旧库有的话会一起迁过去）';
    else if (existsSync(targetTo)) reason = legacyExists ? 'both-exist（旧库未动，需要人工决定是否合并）' : 'already-migrated';
    else reason = legacyExists ? 'would-migrate' : 'no-legacy-board';
    report.migration = { wouldMigrate: legacyExists, reason };
}

const m = report.migration;
if (json) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log(`bots 根目录：${report.botsRoot}`);
    console.log(`当前世界目录：${worldDir}`);
    if (worldId) console.log(`当前 world_id：${worldId}${sidecar.ok ? '' : '（本次生成 sidecar）'}`);
    else console.log('当前 world_id：（还没有 sidecar —— dry-run 不生成；首次启动才会生成）');
    if (targetTo) console.log(`板库目标位置：${targetTo}${existsSync(targetTo) ? '  [已存在]' : ''}`);
    console.log(`旧板库位置：${legacyFrom}${existsSync(legacyFrom) ? '  [仍存在]' : '  [无]'}`);
    if (dryRun) console.log(`预演：${m.reason}`);
    else if (m.migrated) console.log(`迁移：已搬移（备份 ${m.backup}）`);
    else console.log(`迁移：未搬移（${m.reason}）`);
    const others = report.worldsOnDisk.filter((w) => w.id !== worldId);
    if (others.length) {
        console.log('注意：磁盘上还有别的存档目录（当前世界不是它们）：');
        for (const w of others) console.log(`  - ${w.id}${w.hasDb ? '' : '（无板库）'}`);
    }
    if (targetTo && existsSync(targetTo)) {
        // 反解校验：唯一入口自证一次（解析不出会抛，这里兜住并如实报）
        try {
            console.log(`反解校验：${worldIdOfBoardDb(targetTo)}  ← ${targetTo}`);
        } catch (e) {
            console.log(`反解校验失败：${String(e?.message ?? e)}`);
        }
    } else {
        console.log('反解校验：（板库还没建出来，起服后才有）');
    }
}
