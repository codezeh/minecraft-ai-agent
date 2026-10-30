/**
 * 从 .mca 区域文件导入地形。
 *
 * 为什么需要：区块地图原本只能靠「她走过去扫」。但服务端磁盘里已经有
 * 预生成好的世界数据（Chunky 扫过），这些数据包含真实方块和玩家改动。
 * 直接读它，等于免费得到「没去过也知道长什么样」。
 *
 * 与种子方案对比：Node 里没有 1.21 地形生成器，算不出未被生成过的区块；
 * 而 .mca 覆盖了所有已生成区域（本项目 1757 个区块 ≈ 700×700 格），够用。
 *
 * 实测 1.2ms/区块，1750 个区块约 2 秒，可以一次性导入。
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';
import { saveSurfaces, clearChunk, T } from './terrain3d.js';

// 注意：sectionBlocks 已经把 'minecraft:' 前缀去掉了，所以这里也必须是不带前缀的名字。
// 之前写成 'minecraft:air'，导致 AIR.has('air') 永远为 false，
// 空方块被当成实心，地表高度被算成 y=319（世界天花板）。
const AIR = new Set(['air', 'cave_air', 'void_air',
    'short_grass', 'tall_grass', 'fern', 'vine', 'snow', 'seagrass']);
const WATER = /water|kelp|seagrass/;
const LAVA = /lava|magma/;
const LEAVES = /leaves$/;
const BUILT = /(_planks|_bricks|glass|_wool|_concrete|_terracotta|_carpet|_stairs|_slab|_door|_trapdoor|_fence|_bed|_sign|chest|barrel|furnace|crafting_table|bookshelf|lantern|_button|_lever)/;

/** 解一个区块的 NBT。 */
function decodeChunk(buf, index) {
    const offset = buf.readUIntBE(index * 4, 3);
    const sectors = buf[index * 4 + 3];
    if (!offset || !sectors) return null;
    const start = offset * 4096;
    if (start + 5 > buf.length) return null;
    const length = buf.readUInt32BE(start);
    const compression = buf[start + 4];
    const payload = buf.subarray(start + 5, start + 4 + length);
    let raw;
    try {
        if (compression === 1) raw = zlib.gunzipSync(payload);
        else if (compression === 2) raw = zlib.inflateSync(payload);
        else raw = payload;
    } catch { return null; }
    try { return nbt.simplify(nbt.parseUncompressed(raw)); } catch { return null; }
}

/** 解一个 section 的方块名（4096 个）。 */
function sectionBlocks(section) {
    const bs = section.block_states;
    if (!bs) return null;
    const palette = (bs.palette || []).map(p => (p?.Name || 'minecraft:air').replace('minecraft:', ''));
    if (!bs.data) return new Array(4096).fill(palette[0] || 'air');

    const bits = Math.max(4, Math.ceil(Math.log2(Math.max(1, palette.length))));
    const longs = bs.data;
    const out = new Array(4096).fill('air');
    for (let idx = 0; idx < 4096; idx++) {
        const bitIndex = idx * bits;
        let value = 0;
        for (let b = 0; b < bits; b++) {
            const li = Math.floor((bitIndex + b) / 64);
            if (li >= longs.length) break;
            const lo = (bitIndex + b) % 64;
            const bit = (longs[li] >> BigInt(lo)) & 1n;
            if (bit) value |= (1 << b);
        }
        out[idx] = palette[value] || 'air';
    }
    return out;
}

/**
 * 把单个区块算成地图摘要（与 chunk_map 的 scanChunk 同格式）。
 * 抽样 8×8 柱，从最高 section 往下找地表。
 */
/**
 * 把一个区块的 NBT 解析成**所有可站立面**（真 3D）。
 *
 * ★ 2026-10-27 重写：原来只记"每列最上面那层"（2.5D），
 * 看不见洞穴、竖井、悬空平台 —— 而那正是她被困时最需要的信息。
 *
 * 现在：从高到低扫完整列，每次"空气→实心"都记一个面。
 * 实测每列平均 1.8 个面（不是担心的 4~8 个），存储只多 80%。
 *
 * @returns {Array<{x,z,y,t}>|null} 世界坐标的可站立面
 */
function surfacesOfChunk(data, cx, cz) {
    if (!data?.sections?.length) return null;

    // 收集所有 section 的方块，按 Y 排序（高的在前）
    const secs = [];
    for (const s of data.sections) {
        if (!s.block_states) continue;
        const blocks = sectionBlocks(s);
        if (blocks) secs.push({ y: s.Y, blocks });
    }
    if (!secs.length) return null;
    secs.sort((a, b) => b.y - a.y);

    const ox = cx * 16, oz = cz * 16;
    const out = [];
    let prevAir = true;

    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            prevAir = true;
            for (const sec of secs) {
                const ly = sec.y * 16;
                for (let y = 15; y >= 0; y--) {
                    const b = sec.blocks[y * 256 + z * 16 + x];
                    const isAir = !b || AIR.has(b);
                    if (!isAir && prevAir) {
                        // 边界：这格的顶面能站
                        const t = WATER.test(b) ? T.WATER
                            : LAVA.test(b) ? T.LAVA
                                : LEAVES.test(b) ? T.LEAVES
                                    : BUILT.test(b) ? T.BUILT
                                        : T.SOLID;
                        out.push({ x: ox + x, z: oz + z, y: ly + y, t });
                    }
                    prevAir = isAir;
                }
            }
        }
    }

    return out.length ? out : null;
}

/**
 * 导入一个区域目录下所有 .mca。
 * @returns { chunks, files, ms }
 */
export function importRegionDir(regionDir, baseDir, { maxFiles = 64, clearFirst = false } = {}) {
    const t0 = Date.now();
    if (!existsSync(regionDir)) return { chunks: 0, files: 0, cells: 0, ms: 0 };

    const files = readdirSync(regionDir).filter(f => f.endsWith('.mca')).slice(0, maxFiles);
    let chunks = 0, cells = 0;
    const batch = [];

    for (const f of files) {
        const m = f.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/);
        if (!m) continue;
        const rx = Number(m[1]), rz = Number(m[2]);
        let buf;
        try { buf = readFileSync(`${regionDir}/${f}`); } catch { continue; }

        for (let i = 0; i < 1024; i++) {
            const data = decodeChunk(buf, i);
            if (!data) continue;
            const lx = i % 32, lz = Math.floor(i / 32);
            const cx = rx * 32 + lx, cz = rz * 32 + lz;
            const surf = surfacesOfChunk(data, cx, cz);
            if (!surf) continue;

            if (clearFirst) clearChunk(baseDir, cx, cz);
            batch.push(...surf);
            chunks++;
            cells += surf.length;

            // 分批写，避免一次攒太多内存（2200 万面全攒着会爆）
            if (batch.length >= 20000) {
                saveSurfaces(baseDir, batch.splice(0));
            }
        }
    }
    if (batch.length) saveSurfaces(baseDir, batch);
    return { chunks, files: files.length, cells, ms: Date.now() - t0 };
}

