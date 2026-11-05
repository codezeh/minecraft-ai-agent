/**
 * 区块级世界地图（粗规划用）。
 *
 * 为什么按区块而不是按格：实测逐格 bot.blockAt 扫 36×36 格要 ~200ms，
 * 而直接读区块数据扫 64×64 格（16 区块）只要 87ms —— 快 7 倍、覆盖 3 倍。
 * 一格 = 一个区块 = 16×16 格，这是「粗规划」的自然粒度。
 *
 * 数据形状（每个区块一条）：
 *   { explored, y, h, water, lava, built, solid, samples, seenAt, res }
 *   - y       抽样柱的地表平均高度
 *   - h       该区块内最高与最低地表的高差（粗规划要避开大落差）
 *   - built   玩家建筑占比（0..1）
 *   - res     按需补扫的资源计数，如 { oak_log: 12 }
 *
 * 未探索 = 文件里没有这条记录。前端与模型都能直接看出「这里是空的」。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { dirname } from 'path';

const REGION_CHUNKS = 16;        // 一个区域文件管 16×16 个区块 = 256×256 格
const SAMPLE_STEP = 2;           // 每区块抽 8×8 根柱（16/2）
const SURFACE_FROM = 120;        // 从 y=120 往下找地表
const SURFACE_TO = -64;          // 一直找到基岩层（-60 会漏掉 y=-61 的平地，实测漏扫 61/64 根柱）

const AIR = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'vine', 'snow', 'seagrass']);
const WATER = /water|kelp|seagrass/;
const LAVA = /lava|magma/;
const BUILT = /(_planks$|_bricks$|_glass|_wool$|_concrete|_terracotta$|_carpet$|_stairs$|_slab$|_door$|_trapdoor$|_fence|_bed$|_sign$|chest$|barrel$|furnace$|crafting_table$|bookshelf|lantern$|_button$|_lever$)/;
const LEAVES = /_leaves$/;

/** 区块坐标 → 区域文件名（每 16×16 区块一个文件）。 */
function regionFile(baseDir, cx, cz) {
    const rx = Math.floor(cx / REGION_CHUNKS);
    const rz = Math.floor(cz / REGION_CHUNKS);
    return { path: `${baseDir}/r${rx}_${rz}.json`, key: `${cx},${cz}` };
}

function loadRegion(path) {
    try {
        if (!existsSync(path)) return {};
        return JSON.parse(readFileSync(path, 'utf8')) || {};
    } catch {
        return {};   // 坏文件当空区域，不阻塞
    }
}

function saveRegion(path, data) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = path + '.tmp';
        writeFileSync(tmp, JSON.stringify(data));
        renameSync(tmp, path);      // 原子替换，避免写一半崩了留下坏文件
    } catch (e) {
        console.warn('[chunk_map] 保存失败:', e.message);
    }
}

/**
 * 扫一个区块：8×8 柱抽样，从 y=120 往下找第一个非空气方块。
 * @returns 该区块的地形摘要，读不到（未加载）返回 null
 */
export function scanChunk(bot, cx, cz, hintY = null) {
    const column = bot.world?.getColumn?.(cx, cz);
    if (!column) return null;

    let sumY = 0, n = 0, minY = 999, maxY = -999;
    let water = 0, lava = 0, built = 0, solid = 0;
    let leaves = 0;

    // 性能关键：如果给了 hintY（相邻区块的地表高度），就从 hintY+16 开始往下扫，
    // 而不是每次都从 y=120 扫下来。实测 8×8 区块 595ms → 约 200ms。
    // +16 的余量覆盖同一片地形内的高度起伏。
    const from = Number.isFinite(hintY) ? Math.min(SURFACE_FROM, hintY + 16) : SURFACE_FROM;

    for (let dx = 0; dx < 16; dx += SAMPLE_STEP) {
        for (let dz = 0; dz < 16; dz += SAMPLE_STEP) {
            // 关键：ChunkColumn.getBlock() 要的是【区块内相对坐标 0..15】，
            // 不是世界坐标。传世界坐标会读到错误位置（实测：中心区块读到
            // 一堆 y=63 的石头，而那里其实是草地和树林）。
            // 测试服因为坐标在 0 附近、相对与世界坐标接近，才一直没暴露。
            const x = dx;
            const z = dz;
            let foundSurface = false;
            // 每根柱最多记一次水/岩浆/树叶：水面下往往是十几层水，
            // 按层累加会让占比超过 1（实测出现过 水=17.58）。
            let sawWater = false, sawLava = false, sawLeaves = false;

            for (let y = from; y >= SURFACE_TO; y--) {
                let b;
                try { b = column.getBlock({ x, y, z }); } catch { break; }
                if (!b) break;
                const name = String(b.name || '');

                if (AIR.has(name)) continue;
                if (LEAVES.test(name)) { if (!sawLeaves) { sawLeaves = true; leaves++; } continue; }
                if (WATER.test(name)) { if (!sawWater) { sawWater = true; water++; } continue; }
                if (LAVA.test(name)) { if (!sawLava) { sawLava = true; lava++; } continue; }

                // 第一个实心方块 = 地表
                foundSurface = true;
                solid++;
                sumY += y;
                n++;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (BUILT.test(name)) built++;
                break;
            }
            if (!foundSurface) { /* 该柱全空：不计入地表统计 */ }
        }
    }

    const samples = Math.ceil(16 / SAMPLE_STEP) ** 2;
    if (n === 0) return { explored: false };
    return {
        explored: true,
        y: Math.round(sumY / n),
        h: maxY - minY,
        water: +(water / samples).toFixed(2),
        lava: +(lava / samples).toFixed(2),
        built: +(built / Math.max(1, n)).toFixed(2),
        solid: n,
        samples,
        leaves: +(leaves / samples).toFixed(2),
        seenAt: Date.now(),
    };
}

/**
 * 以 (cx,cz) 为中心扫半径 r 个区块，写入地图。
 * @returns { scanned, skipped, ms }
 */
export function scanArea(bot, baseDir, cx, cz, radius = 4) {
    const t0 = Date.now();
    let scanned = 0, skipped = 0;
    const dirty = new Map();   // path -> region data
    let hintY = null;          // 相邻区块的地表高度，用来跳过上方的空气层

    for (let dx = -radius; dx < radius; dx++) {
        for (let dz = -radius; dz < radius; dz++) {
            const x = cx + dx, z = cz + dz;
            const info = scanChunk(bot, x, z, hintY);
            if (!info || !info.explored) { skipped++; continue; }
            if (Number.isFinite(info.y)) hintY = info.y;   // 后面的区块沿用
            const { path, key } = regionFile(baseDir, x, z);
            if (!dirty.has(path)) dirty.set(path, loadRegion(path));
            dirty.get(path)[key] = info;
            scanned++;
        }
    }
    for (const [path, data] of dirty) saveRegion(path, data);
    return { scanned, skipped, ms: Date.now() - t0 };
}

/**
 * 批量写入若干区块记录（供 .mca 导入用）。
 * 按区域文件分组，每个区域只读写一次。
 */
export function saveChunks(baseDir, entries) {
    const byRegion = new Map();
    for (const { cx, cz, info } of entries) {
        const { path, key } = regionFile(baseDir, cx, cz);
        if (!byRegion.has(path)) byRegion.set(path, loadRegion(path));
        byRegion.get(path)[key] = info;
    }
    for (const [path, data] of byRegion) saveRegion(path, data);
    return entries.length;
}

/** 读一个区块的地图记录（不存在 = 未探索）。 */
export function getChunk(baseDir, cx, cz) {
    const { path, key } = regionFile(baseDir, cx, cz);
    const data = loadRegion(path);
    return data[key] || null;
}

/**
 * 建一个「地图读取器」：把区域文件缓存进内存，之后按格查询走内存。
 *
 * 为什么需要：getChunk 每次都要 readFile + JSON.parse。A* 扩展一个节点要看
 * 8 个邻居，跑几十步就是几百次磁盘读（实测 119ms）。用读取器后降到个位数毫秒。
 * 扫描写入后调用 reader.invalidate() 让缓存失效。
 */
export function openMapReader(baseDir) {
    const regions = new Map();   // path -> parsed object
    return {
        chunk(cx, cz) {
            const { path, key } = regionFile(baseDir, cx, cz);
            let data = regions.get(path);
            if (!data) { data = loadRegion(path); regions.set(path, data); }
            return data[key] || null;
        },
        invalidate() { regions.clear(); },
    };
}

/**
 * 找一个「值得去」的方向：附近哪个已探索区块有目标资源 / 没去过。
 * 给粗规划当目标点用。
 */
export function findChunkWith(baseDir, cx, cz, radius, predicate) {
    const hits = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const c = getChunk(baseDir, cx + dx, cz + dz);
            const d = Math.hypot(dx, dz);
            if (!c) { hits.push({ cx: cx + dx, cz: cz + dz, kind: 'unexplored', d }); continue; }
            if (predicate && predicate(c)) hits.push({ cx: cx + dx, cz: cz + dz, kind: 'match', d, info: c });
        }
    }
    hits.sort((a, b) => a.d - b.d);
    return hits;
}

/**
 * 粗规划：把一段路拆成若干个「区块中心路标」。
 * 只做直线 + 危险规避，真正的绕障交给精规划（pathfinder）。
 */
export function coarseWaypoints(baseDir, from, to, maxSteps = 32) {
    const cx0 = Math.floor(from.x / 16), cz0 = Math.floor(from.z / 16);
    const cx1 = Math.floor(to.x / 16), cz1 = Math.floor(to.z / 16);

    const steps = Math.max(Math.abs(cx1 - cx0), Math.abs(cz1 - cz0));
    if (steps === 0) return [{ cx: cx1, cz: cz1, x: to.x, z: to.z }];

    const out = [];
    for (let i = 1; i <= Math.min(steps, maxSteps); i++) {
        const t = i / steps;
        const cx = Math.round(cx0 + (cx1 - cx0) * t);
        const cz = Math.round(cz0 + (cz1 - cz0) * t);
        const info = getChunk(baseDir, cx, cz);
        out.push({
            cx, cz,
            x: cx * 16 + 8,
            z: cz * 16 + 8,
            explored: !!info,
            // 粗规划要避开的信息，交给调用方决定绕不绕
            water: info?.water ?? null,
            lava: info?.lava ?? null,
            built: info?.built ?? null,
            h: info?.h ?? null,
            y: info?.y ?? null,
        });
    }
    // 相邻重复去掉（一条直线穿过多个区块时会出现）
    return out.filter((p, i) => i === 0 || p.cx !== out[i - 1].cx || p.cz !== out[i - 1].cz);
}

/** 给模型读的一行摘要（文字比图好读）。 */
export function describeArea(baseDir, cx, cz, radius = 4) {
    let explored = 0, total = 0, water = 0, lava = 0, built = 0, flat = 0;
    let minY = 999, maxY = -999;
    for (let dx = -radius; dx < radius; dx++) {
        for (let dz = -radius; dz < radius; dz++) {
            total++;
            const c = getChunk(baseDir, cx + dx, cz + dz);
            if (!c) continue;
            explored++;
            if (c.water > 0.3) water++;
            if (c.lava > 0) lava++;
            if (c.built > 0.3) built++;
            if (c.h <= 3) flat++;
            if (c.y < minY) minY = c.y;
            if (c.y > maxY) maxY = c.y;
        }
    }
    const pct = Math.round((explored / total) * 100);
    if (!explored) return `这一带的 ${total} 个区块都还没探索过。`;
    return `已探索 ${explored}/${total} 个区块（${pct}%）；地表 y=${minY}~${maxY}；` +
        `平坦 ${flat}、有水 ${water}、有岩浆 ${lava}、有建筑 ${built}；其余未探索。`;
}
