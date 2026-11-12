/**
 * `team_chest` × WorldGuard 区域 **只读**自检（t7 结论 1 的落点）。
 *
 * 为什么需要：WorldGuard 只认**区域**（坐标范围），板库 `team_chest` 只认**具体方块坐标**。
 * 两者不一致就出现黑洞 —— WG 放行但账本不记（东西进出没人知道），或账上记了但 WG 不让碰。
 * 这个脚本只回答一个问题：**登记的共享仓坐标，有没有落在任何一个区域里**。
 *
 * 三种输出（必须可区分，别让"没配好"看起来像"全绿"）：
 *   SKIP  区域配置里还有 __FILL_ME__ 之类占位符 ⇒ 配置未生效、**无法校验**（exit 0）
 *   OK    每个坐标都被至少一个 cuboid 区域覆盖（exit 0）
 *   FAIL  有坐标没被任何区域覆盖（exit 1，并逐条列出坐标）
 *
 * 它不是 WorldGuard 的线上文件，也不改任何东西：只读配置 + 只读打开板库。
 *
 * 用法：
 *   node tools/team_wg_crosscheck.mjs                       # 自动找库 + config/worldguard-regions.yml
 *   node tools/team_wg_crosscheck.mjs --db <board.sqlite> --config <regions.yml>
 *   node tools/team_wg_crosscheck.mjs --json
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');       // mindcraft/
const REPO_ROOT = resolve(PKG_ROOT, '..');                                    // 仓库根

/** 占位符长这样：__FILL_ME__ / __FILL_WORLD__ / __PLAYER_NAME__。 */
const PLACEHOLDER = /__[A-Z0-9_]+__/;

const unquote = (v) => String(v ?? '').trim().replace(/^['"]|['"]$/g, '');

/**
 * 解析区域草案（只认本仓 `config/worldguard-regions.yml` 的这套缩进写法，不做通用 YAML）。
 *
 * ★ 为什么不引 YAML 库：这个文件由人手填、结构固定；为了它拉一个依赖不划算。
 *   代价是"解析不了就如实说"，而不是猜 —— 见 `parseRegionDraft` 返回的 `errors`。
 *
 * @param {string} text
 * @returns {{ok:boolean, world:string|null, regions:object[], placeholders:object[], errors:string[]}}
 */
export function parseRegionDraft(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const regions = [];
    const placeholders = [];
    const errors = [];
    let world = null;
    let inRegions = false;
    let cur = null;
    let block = null;

    const notePlaceholder = (where, value) => {
        const v = unquote(value);
        if (PLACEHOLDER.test(v) || v === '') placeholders.push({ where, value: v });
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].replace(/\t/g, '  ');
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const indent = line.length - line.replace(/^\s+/, '').length;

        if (indent === 0) {
            const m = /^([\w-]+):\s*(.*)$/.exec(trimmed);
            if (!m) { errors.push(`第 ${i + 1} 行无法解析：${trimmed}`); continue; }
            const key = m[1];
            if (key === 'regions') { inRegions = true; cur = null; block = null; continue; }
            if (key === 'world') {
                world = unquote(m[2]);
                if (PLACEHOLDER.test(world) || !world) placeholders.push({ where: 'world', value: world });
            }
            continue;
        }
        if (!inRegions) continue;

        if (indent <= 2) {
            const m = /^([\w-]+):\s*$/.exec(trimmed);
            if (!m) { errors.push(`第 ${i + 1} 行（区域名）无法解析：${trimmed}`); cur = null; block = null; continue; }
            cur = { name: m[1], type: null, priority: null, min: null, max: null, line: i + 1 };
            regions.push(cur);
            block = null;
            continue;
        }
        if (!cur) continue;

        if (indent === 4) {
            const m = /^([\w-]+):\s*(.*)$/.exec(trimmed);
            if (!m) continue;
            const key = m[1];
            const val = m[2];
            if (key === 'type') { cur.type = unquote(val); continue; }
            if (key === 'priority') { cur.priority = Number(unquote(val)); continue; }
            if (key === 'min' || key === 'max') { cur[key] = {}; block = key; continue; }
            block = key;                    // members / owners / flags …：本脚本不关心
            continue;
        }
        // indent >= 6：只解析 min/max 下面的 x/y/z
        if (block === 'min' || block === 'max') {
            const m = /^([xyz]):\s*(.*)$/.exec(trimmed);
            if (!m) continue;
            const axis = m[1];
            const raw = unquote(m[2]);
            cur[block][axis] = raw;
            if (PLACEHOLDER.test(raw) || raw === '') {
                placeholders.push({ where: `${cur.name}.${block}.${axis}`, value: raw });
            }
        }
    }

    // min/max 缺轴、非数字、min > max —— 都是"配置没配好"，不是"没有区域"
    for (const r of regions) {
        if (String(r.type ?? '') !== 'cuboid') continue;
        for (const side of ['min', 'max']) {
            if (!r[side]) { errors.push(`区域「${r.name}」缺 ${side}`); continue; }
            for (const axis of ['x', 'y', 'z']) {
                const v = r[side][axis];
                if (v === undefined) { errors.push(`区域「${r.name}」的 ${side}.${axis} 缺失`); continue; }
                if (PLACEHOLDER.test(String(v))) continue;          // 已记进 placeholders
                const n = Number(v);
                if (!Number.isFinite(n)) errors.push(`区域「${r.name}」的 ${side}.${axis} 不是数字：${v}`);
                else r[side][axis] = n;
            }
        }
        if (r.min && r.max) {
            const bad = ['x', 'y', 'z'].filter((a) => Number.isFinite(r.min[a]) && Number.isFinite(r.max[a]) && r.min[a] > r.max[a]);
            if (bad.length) errors.push(`区域「${r.name}」的 min > max（${bad.join('/')}）`);
        }
    }
    return { ok: errors.length === 0, world, regions, placeholders, errors };
}

const inBox = (r, p) => p.x >= r.min.x && p.x <= r.max.x
    && p.y >= r.min.y && p.y <= r.max.y
    && p.z >= r.min.z && p.z <= r.max.z;

/**
 * 归类：SKIP / OK / FAIL。
 *
 * @param {{chests:object[], parsed:ReturnType<typeof parseRegionDraft>}} spec
 * @returns {{status:'SKIP'|'OK'|'FAIL', reason:string, uncovered:object[], covered:number}}
 */
export function classifyCoverage({ chests = [], parsed }) {
    const { regions = [], placeholders = [], errors = [], world = null } = parsed ?? {};
    // ① 占位符没填 ⇒ **配置未生效**：既不能说 OK，也不该报 FAIL（那会让人去查坐标）
    if (placeholders.length) {
        return {
            status: 'SKIP',
            reason: `区域配置里还有 ${placeholders.length} 处占位符未填（${placeholders.slice(0, 3).map((p) => p.where).join('、')}${placeholders.length > 3 ? ' 等' : ''}）：配置未生效，无法校验`,
            uncovered: [],
            covered: 0,
        };
    }
    // ② 解析不通 ⇒ 也归到"无法校验"，但要说清是规则错了，不是坐标错了
    if (errors.length) {
        return { status: 'SKIP', reason: `区域配置无法解析（${errors.slice(0, 3).join('；')}${errors.length > 3 ? ' 等' : ''}）：无法校验`, uncovered: [], covered: 0 };
    }
    const cuboids = regions.filter((r) => String(r.type ?? '') === 'cuboid');
    if (!cuboids.length) {
        return { status: 'SKIP', reason: '区域配置里没有任何 cuboid 区域（只有 global）：等于没有区域保护，无法校验', uncovered: [], covered: 0 };
    }
    // ③ 逐格判定。存档不同的坐标**不算被覆盖**（那正是最危险的一种"看起来对"）
    const uncovered = [];
    let covered = 0;
    for (const c of chests) {
        const same = cuboids.filter((r) => (world == null || String(c.world_id) === String(world)) && inBox(r, c));
        if (same.length) covered += 1;
        else uncovered.push(c);
    }
    if (uncovered.length) {
        return { status: 'FAIL', reason: `${uncovered.length} 个 team_chest 坐标没有被任何区域覆盖（WG 会放行/阻挡而与账本不一致）`, uncovered, covered };
    }
    return { status: 'OK', reason: `${covered} 个坐标全部落在区域里`, uncovered: [], covered };
}

/** 从板库读共享仓坐标（**只读**打开）。表不存在 ⇒ 如实返回 `no-table`（"没有数据可校验"，不是"全部合格"）。 */
export function readTeamChests(dbFile) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='team_chest'").get();
        if (!has) {
            return { ok: false, code: 'no-table', reason: '板库里没有 team_chest 表（schema 还没迁移到队伍版本）：没有共享仓数据可校验' };
        }
        const chests = db.prepare('SELECT world_id, team_id, x, y, z FROM team_chest ORDER BY world_id ASC, x ASC, y ASC, z ASC')
            .all().map((r) => ({
                world_id: String(r.world_id), team_id: String(r.team_id),
                x: Number(r.x), y: Number(r.y), z: Number(r.z),
            }));
        return { ok: true, chests };
    } finally {
        try { db.close(); } catch { /* 关不掉也不影响读到的结果 */ }
    }
}

/** 默认库位置：优先按存档的 `_worlds/<id>/_board/board.sqlite`，其次老位置 `_board/board.sqlite`。 */
export function findBoardDb() {
    const botsRoot = process.env.MC_BOTS_ROOT?.trim() || join(PKG_ROOT, 'bots');
    const worlds = join(botsRoot, '_worlds');
    const hits = [];
    if (existsSync(worlds)) {
        for (const id of readdirSync(worlds)) {
            const p = join(worlds, id, '_board', 'board.sqlite');
            if (existsSync(p)) hits.push(p);
        }
    }
    if (hits.length === 1) return { ok: true, file: hits[0] };
    if (hits.length > 1) return { ok: false, reason: `找到 ${hits.length} 个存档库（${hits.join('、')}）：用 --db 指定要检查哪一个` };
    const legacy = join(botsRoot, '_board', 'board.sqlite');
    if (existsSync(legacy)) return { ok: true, file: legacy };
    return { ok: false, reason: `没有找到板库（找过 ${worlds}/*/_board/board.sqlite 与 ${legacy}）：用 --db 指定` };
}

/** 命令行入口。 */
function main(argv) {
    const arg = (name) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 ? argv[i + 1] : null;
    };
    const json = argv.includes('--json');
    const configFile = arg('config') ?? join(REPO_ROOT, 'config', 'worldguard-regions.yml');
    const dbArg = arg('db');
    const boardDir = arg('board-dir');

    if (!existsSync(configFile)) {
        console.log(`FAIL 找不到区域配置：${configFile}`);
        return 1;
    }
    const parsed = parseRegionDraft(readFileSync(configFile, 'utf8'));

    // ① 配置本身不可用（占位符没填 / 解析不通 / 没有 cuboid）⇒ SKIP，**连库都不必读**：
    //    这种情况下"校验过"这件事根本没发生，读到什么都不能当作结论。
    const configOnly = classifyCoverage({ chests: [], parsed });
    if (configOnly.status === 'SKIP') {
        const out = { status: 'SKIP', reason: configOnly.reason, uncovered: [], config: configFile, world: parsed.world, regions: parsed.regions.length };
        if (json) console.log(JSON.stringify(out, null, 2));
        else {
            console.log(`SKIP ${out.reason}`);
            console.log(`  配置：${configFile}（world=${parsed.world ?? '?'}，区域 ${parsed.regions.length} 个，cuboid ${parsed.regions.filter((r) => String(r.type ?? '') === 'cuboid').length} 个）`);
            console.log('  说明：区域还没配好 ⇒ 本脚本**没有**校验任何坐标。别把它当成"已保护"。');
        }
        return 0;
    }

    let dbFile = dbArg;
    if (!dbFile && boardDir) dbFile = join(boardDir, 'board.sqlite');
    if (!dbFile) {
        const found = findBoardDb();
        if (!found.ok) {
            // 没有库 = 还没有队伍数据；这既不是 OK 也不是 FAIL，**不许**装作校验过
            const out = { status: 'SKIP', reason: `找不到板库：${found.reason}（还没有队伍数据，无法校验）`, uncovered: [] };
            if (json) console.log(JSON.stringify(out, null, 2));
            else console.log(`SKIP ${out.reason}`);
            return 0;
        }
        dbFile = found.file;
    }

    let read;
    try {
        read = readTeamChests(dbFile);
    } catch (e) {
        console.log(`FAIL 读板库失败（${dbFile}）：${String(e?.message ?? e)}`);
        return 1;
    }
    if (!read.ok) {
        const out = { status: 'SKIP', reason: `${read.reason}（${dbFile}）`, uncovered: [], db: dbFile };
        if (json) console.log(JSON.stringify(out, null, 2));
        else console.log(`SKIP ${out.reason}`);
        return 0;
    }
    const chests = read.chests;

    const result = classifyCoverage({ chests, parsed });
    if (json) {
        console.log(JSON.stringify({ ...result, db: dbFile, config: configFile, world: parsed.world, regions: parsed.regions.length, chests: chests.length }, null, 2));
    } else {
        console.log(`${result.status} ${result.reason}`);
        console.log(`  配置：${configFile}（world=${parsed.world ?? '?'}，区域 ${parsed.regions.length} 个，cuboid ${parsed.regions.filter((r) => String(r.type ?? '') === 'cuboid').length} 个）`);
        console.log(`  板库：${dbFile}（team_chest ${chests.length} 行）`);
        for (const c of result.uncovered) {
            console.log(`  - 未覆盖：(${c.x},${c.y},${c.z}) team=${c.team_id} world=${c.world_id}`);
        }
        if (result.status === 'SKIP') {
            console.log('  说明：占位符未填/配置不可用 ⇒ 本脚本**没有**校验任何坐标。别把它当成"已保护"。');
        }
    }
    return result.status === 'FAIL' ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    process.exit(main(process.argv.slice(2)));
}
