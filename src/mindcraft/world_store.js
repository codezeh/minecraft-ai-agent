/**
 * 存档维度 `world_id` —— **唯一真相**（ADR-0001 D6 / 阶段 3）。
 *
 * 本文件只做三件事：
 *   ① 世界目录 sidecar `<worldDir>/world-id.json`（删世界 = 新 id，随备份走）；
 *   ② `_worlds/<id>/` 分层寻址（一个存档一套板库/队伍/账本）；
 *   ③ 旧单库 `bots/_board/board.sqlite` → `_worlds/<id>/_board/` 的**幂等**迁移。
 *
 * `worldIdOfBoardDb()` 是"这块库属于哪个存档"的**唯一入口**（t3 队伍 / t4 库存都调它）：
 * **解析不出就抛**，绝不返回 null 让调用方默默当"单库单世界"。
 * 完整口径（目录形状、迁移步骤、失败模式、未改的调用点）见 `docs/audit-r6/fixes4/world.md`。
 */
import { randomBytes } from 'node:crypto';
import {
    copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardDirForWorld, boardDirOf, botsRootOf } from '../agent/library/bot_paths.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `mindcraft/src/mindcraft/` 上溯三级 = 仓库根（与 `offline_identity_risk.js` 同口径） */
const REPO_ROOT = resolve(HERE, '..', '..', '..');

/** sidecar 文件名：放在**世界目录**里，跟着存档备份走 */
export const WORLD_ID_FILE = 'world-id.json';
/** sidecar 结构版本（将来加字段时按它升级） */
const WORLD_ID_SCHEMA = 1;
/** 合法 id：字母数字开头，只允许 `._-`，1~64 字符 —— 同时挡掉 `../` 这类路径穿越 */
const WORLD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 板库文件家族：迁移时必须一起搬，只搬主文件会丢 WAL 里已提交的页 */
const DB_SUFFIXES = ['', '-wal', '-shm'];

const err = (code, message) => Object.assign(new Error(message), { code });

/** 这个字符串能不能当 world_id 用（导出给 t3/t4 做入参校验）。 */
export function isValidWorldId(id) {
    return typeof id === 'string' && WORLD_ID_RE.test(id);
}

function assertWorldId(id) {
    const s = typeof id === 'string' ? id.trim() : '';
    if (!isValidWorldId(s)) {
        throw err('WORLD_ID_INVALID',
            `world_id 不合法：${JSON.stringify(id ?? null)}（只允许字母数字开头、字符集 [A-Za-z0-9._-]、1~64 位）`);
    }
    return s;
}

/** 生成一个新 id，形如 `w-20261112-1a2b3c4d`（日期只为可读，唯一性靠 8 位随机）。 */
export function newWorldId(now = Date.now()) {
    const d = new Date(now);
    const p2 = (n) => String(n).padStart(2, '0');
    return `w-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${randomBytes(4).toString('hex')}`;
}

/**
 * 读世界目录里的 sidecar（**不创建任何东西**）。
 * @param {string} worldDir
 * @returns {{ok:boolean, worldId:string|null, file:string|null, reason:string, detail?:string, schema?:number, createdAt?:string|null}}
 *   `reason` ∈ sidecar-missing（还没开过存档）/ sidecar-corrupt / sidecar-invalid-id / sidecar-unreadable / no-world-dir
 */
export function readWorldIdOf(worldDir) {
    const dir = typeof worldDir === 'string' ? worldDir.trim() : '';
    if (!dir) return { ok: false, worldId: null, file: null, reason: 'no-world-dir' };
    const file = join(dir, WORLD_ID_FILE);
    if (!existsSync(file)) return { ok: false, worldId: null, file, reason: 'sidecar-missing' };
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch (e) {
        return { ok: false, worldId: null, file, reason: 'sidecar-unreadable', detail: String(e?.message ?? e) };
    }
    let obj;
    try {
        obj = JSON.parse(raw);
    } catch (e) {
        return { ok: false, worldId: null, file, reason: 'sidecar-corrupt', detail: String(e?.message ?? e) };
    }
    const id = typeof obj?.id === 'string' ? obj.id.trim() : '';
    if (!isValidWorldId(id)) {
        return { ok: false, worldId: null, file, reason: 'sidecar-invalid-id', detail: id || '(缺 id 字段)' };
    }
    return { ok: true, worldId: id, file, reason: '', schema: Number(obj?.schema ?? 0), createdAt: obj?.createdAt ?? null };
}

/**
 * 该世界目录的 world_id：有就返回，没有就**生成并落盘**（删世界 = 新 id）。
 *
 * ★ sidecar 坏了（存在但读不出合法 id）时**抛错，不重新生成**：
 *   重新生成等于把 `_worlds/<旧 id>` 下的队伍/账本静默孤立 —— 那是最贵的假修复。
 *   要重开一档就**人工删掉**这个 sidecar 文件，动作可见、可追溯。
 *
 * @param {string} worldDir 世界目录（生产默认 `<仓库>/server/world`）
 * @returns {string} world_id
 */
export function worldIdOf(worldDir, opts = {}) {
    const dir = typeof worldDir === 'string' ? worldDir.trim() : '';
    if (!dir) {
        throw err('WORLD_ID_UNRESOLVABLE', 'worldIdOf(worldDir) 需要一个世界目录：拒绝在没有存档的情况下编一个 id');
    }
    const abs = resolve(dir);
    const got = readWorldIdOf(abs);
    if (got.ok) return got.worldId;
    if (got.reason !== 'sidecar-missing') {
        throw err('WORLD_ID_SIDECAR_CORRUPT',
            `${got.file} 存在但不可用（${got.reason}${got.detail ? `：${got.detail}` : ''}）。`
            + '拒绝自动生成新 id（会让 _worlds/ 下旧 id 的队伍/账本被静默孤立）。'
            + '请人工修复该文件；确认要重开一档时再删除它。');
    }
    // 世界目录**本来就不存在**时要说出来：容器/临时目录里生成 id，重建容器就换一档（板"看起来被清空"）。
    // 静默生成正是本仓最贵的一类故障，所以这条日志只在该目录是新建时打，且可读可查。
    const dirExisted = existsSync(abs);
    mkdirSync(abs, { recursive: true });
    const file = join(abs, WORLD_ID_FILE);
    const id = newWorldId();
    const body = `${JSON.stringify({ schema: WORLD_ID_SCHEMA, id, createdAt: new Date().toISOString() }, null, 2)}\n`;
    const tmp = join(abs, `${WORLD_ID_FILE}.tmp-${process.pid}-${Date.now()}`);
    writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx' });
    try {
        // 硬链接：原子且**不覆盖**——两路同时首次启动时只有一个赢，另一个读赢家的 id（幂等）
        linkSync(tmp, file);
    } catch (e) {
        if (e?.code === 'EEXIST') {
            try { unlinkSync(tmp); } catch { /* 删不掉不影响结果 */ }
            const again = readWorldIdOf(abs);
            if (again.ok) return again.worldId;
            throw err('WORLD_ID_SIDECAR_CORRUPT', `${file} 刚被另一路写成不可用状态（${again.reason}）`);
        }
        // 个别文件系统不支持硬链接 → 退化为 rename（仍有极小竞态，但读到的永远是完整文件）
        renameSync(tmp, file);
        return id;
    }
    try { unlinkSync(tmp); } catch { /* 临时文件删不掉不影响结果 */ }
    if (opts.quiet !== true && !dirExisted) {
        console.warn(`[存档] 世界目录原本不存在，已创建并生成 world_id：${abs}`
            + '（sidecar 落在该目录里）。'
            + '容器/临时部署请把存档目录挂进来或设 MC_WORLD_DIR —— '
            + '否则重建容器会换 world_id，板/队伍看起来像被清空（数据仍在旧 id 下）。');
    }
    return id;
}

/**
 * 当前生效世界的目录：`MC_WORLD_DIR` 优先，否则 `<server>/world`
 * （`MC_SERVER_DIR` 可改服务端根，默认 `<仓库>/server`）。
 */
export function currentWorldDir() {
    const override = String(process.env.MC_WORLD_DIR ?? '').trim();
    if (override) return resolve(override);
    const serverDir = String(process.env.MC_SERVER_DIR ?? '').trim();
    return join(serverDir ? resolve(serverDir) : join(REPO_ROOT, 'server'), 'world');
}

/** 当前生效的 world_id（从当前世界目录解析，必要时生成 sidecar）。`opts.quiet` 关掉"新建世界目录"告警。 */
export function currentWorldId(opts = {}) {
    return worldIdOf(currentWorldDir(), opts);
}

/** 所有存档数据的根：`<bots>/_worlds`。 */
export function worldsRootOf() {
    return join(botsRootOf(), '_worlds');
}

/** 某个存档的数据目录：`<bots>/_worlds/<id>`（不创建）。 */
export function worldDataDirOf(worldId) {
    return join(worldsRootOf(), assertWorldId(worldId));
}

/** 确保存档数据目录存在，返回它。 */
export function ensureWorldDir(worldId) {
    const dir = worldDataDirOf(worldId);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * 从板库路径反解 world_id（**不抛**的检查版，给诊断/单测用）。
 *
 * 认的形状：`.../_worlds/<id>/_board/board.sqlite`（也接受 `.../_worlds/<id>/<任意库文件>`）。
 *
 * @param {string} dbPath 板库文件路径（`openBoard().path`）
 * @returns {{ok:true, worldId:string} | {ok:false, worldId:null, reason:string}}
 */
export function tryWorldIdOfBoardDb(dbPath) {
    const raw = typeof dbPath === 'string' ? dbPath.trim() : '';
    if (!raw) return { ok: false, worldId: null, reason: '没有给板库路径' };
    const parts = raw.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
    if (parts.includes('..')) return { ok: false, worldId: null, reason: `路径里有 ".."：${raw}` };
    const i = parts.lastIndexOf('_worlds');
    if (i < 0) return { ok: false, worldId: null, reason: `${raw} 不在 _worlds/<id>/ 下面（旧位置 bots/_board 没有存档维度）` };
    if (i + 1 >= parts.length) return { ok: false, worldId: null, reason: `${raw} 的 _worlds/ 后面没有 id` };
    const id = parts[i + 1];
    if (!isValidWorldId(id)) return { ok: false, worldId: null, reason: `_worlds 后面的 ${JSON.stringify(id)} 不是合法 world_id` };
    if (i + 2 >= parts.length) return { ok: false, worldId: null, reason: `${raw} 只到 _worlds/<id>，没有指向具体库文件` };
    return { ok: true, worldId: id };
}

/**
 * ★ t3（队伍）/ t4（库存）的**唯一**反解入口：板库路径 → world_id。
 *
 * **不返回 null，也不给 'default' 兜底**：解析不出就抛 `WORLD_ID_UNRESOLVABLE`。
 * 兜底的后果是队伍/账本安静地记到"单库单世界"上，等真分存档那天全部对不上却又没有报错。
 *
 * @param {string} dbPath `openBoard(...).path`
 * @returns {string} world_id
 */
export function worldIdOfBoardDb(dbPath) {
    const r = tryWorldIdOfBoardDb(dbPath);
    if (!r.ok) {
        throw err('WORLD_ID_UNRESOLVABLE',
            `无法从板库路径反解 world_id：${r.reason}。`
            + '绝不退化成"单库单世界"——板库必须落在 bots/_worlds/<id>/_board/ 下。'
            + '迁移：node tools/world_migrate.mjs');
    }
    return r.worldId;
}

function tsStamp(now = Date.now()) {
    const d = new Date(now);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * 找**已经存在**的板库目录 —— 只读观察工具专用（**绝不生成 sidecar、绝不迁移、绝不建目录**）。
 *
 * 顺序：当前世界的 `_worlds/<id>/_board` → 磁盘上唯一一个有库的 `_worlds/<id>/_board`
 * → 旧位置 `bots/_board` → 都没有就返回旧位置（调用方 readOnly 打开会如实抛"库不存在"）。
 * 用途：`tools/t37_*` / `t51_*` / `t52_*` / `board_user_version_check` 这类"看真实系统"的工具，
 * 迁移前后都指向同一块真库。等旧位置彻底清空后，本函数与它的调用点一起删。
 */
export function resolveExistingBoardDir() {
    const hasDb = (dir) => existsSync(join(dir, 'board.sqlite'));
    const sidecar = readWorldIdOf(currentWorldDir());
    if (sidecar.ok && hasDb(boardDirForWorld(sidecar.worldId))) return boardDirForWorld(sidecar.worldId);
    const root = worldsRootOf();
    if (existsSync(root)) {
        const hits = readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => join(root, d.name, '_board'))
            .filter(hasDb);
        if (hits.length === 1) return hits[0];
    }
    return boardDirOf();
}

/**
 * 幂等迁移：旧 `bots/_board/board.sqlite` → `_worlds/<id>/_board/board.sqlite`。
 *
 * 顺序（不可颠倒）：**先备份** `.bak-<时间戳>`（主文件 + WAL/SHM）→ 搬家 → 旧位置留
 * `MIGRATED-TO.txt`。重复运行只会得出 `already-migrated`，不改任何文件。
 *
 * @param {string} worldId
 * @param {{quiet?:boolean, now?:number}} [opts]
 * @returns {{ok:true, worldId:string, migrated:boolean, reason:string, from:string, to:string, backup:string|null, moved:string[]}}
 */
export function migrateLegacyBoardToWorld(worldId, opts = {}) {
    const id = assertWorldId(worldId);
    const quiet = opts.quiet === true;
    const legacyDir = boardDirOf();
    const from = join(legacyDir, 'board.sqlite');
    const targetDir = boardDirForWorld(id);
    const to = join(targetDir, 'board.sqlite');
    const out = { ok: true, worldId: id, migrated: false, reason: '', from, to, backup: null, moved: [] };

    if (existsSync(to)) {
        // 已经是新形状：一个字节都不动（这就是"跑两次结果一致"的保证）
        out.reason = existsSync(from) ? 'both-exist' : 'already-migrated';
        if (out.reason === 'both-exist' && !quiet) {
            console.warn(`[存档] 新旧两处都有板库：旧=${from} 未动，使用新=${to}。请人工确认旧库还要不要合并。`);
        }
        return out;
    }
    if (!existsSync(from)) {
        mkdirSync(targetDir, { recursive: true });
        out.reason = 'no-legacy-board';
        return out;
    }

    // ① 备份：主文件 + WAL/SHM 一起（只备主文件会丢 WAL 里已提交的页）
    const present = DB_SUFFIXES.filter((s) => existsSync(`${from}${s}`));
    let stamp = tsStamp(opts.now ?? Date.now());
    const backupOf = (s) => join(legacyDir, `board.sqlite${s}.bak-${stamp}`);
    for (let n = 2; present.some((s) => existsSync(backupOf(s))); n += 1) stamp = `${tsStamp(opts.now ?? Date.now())}-${n}`;
    for (const s of present) copyFileSync(`${from}${s}`, backupOf(s));
    out.backup = backupOf('');

    // ② 搬家：同盘 rename；跨盘退化为 copy+rm（旧文件删不掉就留着，指路牌已指向新位置）
    mkdirSync(targetDir, { recursive: true });
    for (const s of present) {
        const dst = `${to}${s}`;
        try {
            renameSync(`${from}${s}`, dst);
        } catch {
            copyFileSync(`${from}${s}`, dst);
            try { rmSync(`${from}${s}`, { force: true }); } catch { /* 删不掉不影响新位置可用 */ }
        }
        out.moved.push(dst);
    }

    // ③ 旧位置留指路牌：这个目录不再有 board.sqlite，别让下一个人以为"板库丢了"
    writeFileSync(join(legacyDir, 'MIGRATED-TO.txt'), [
        '# 任务板库已迁到「存档维度」（ADR-0001 D6 / 阶段 3）',
        `world_id: ${id}`,
        `moved_at: ${new Date(opts.now ?? Date.now()).toISOString()}`,
        `to: ${to}`,
        `backup: ${present.map((s) => `board.sqlite${s}.bak-${stamp}`).join('、')}`,
        '',
        '本目录不再有 board.sqlite（迁移前已备份，见上面 backup）。',
        '回滚：停服 → 把备份改回 board.sqlite → 把新位置的 board.sqlite 移走 → 起服。',
        '注意：回滚后新版本会再次迁移到**同一个** world_id（sidecar 不动）。',
        '',
    ].join('\n'), 'utf8');

    out.migrated = true;
    out.reason = 'migrated';
    if (!quiet) console.log(`[存档] 任务板库已迁移：${from} → ${to}（备份 ${out.backup}）`);
    return out;
}

/**
 * 生产入口：当前存档的板库目录（幂等迁移旧库后返回）。
 * 唯一调用方是 `mindserver.js` 的 `openBoard(prepareBoardDirForCurrentWorld())`。
 *
 * @param {{quiet?:boolean}} [opts]
 * @returns {string} 形如 `<bots>/_worlds/w-20261112-1a2b3c4d/_board`
 */
export function prepareBoardDirForCurrentWorld(opts = {}) {
    const worldId = currentWorldId(opts);
    ensureWorldDir(worldId);
    migrateLegacyBoardToWorld(worldId, opts);
    return boardDirForWorld(worldId);
}
