import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';

/**
 * Litematica (.litematic) 解析器。
 *
 * 为什么不用 prismarine-schematic：
 *   实测它对 litematic 的 Region 结构支持不完整，Schematic.read() 直接抛
 *   "Cannot read properties of undefined (reading 'length')"。
 *   而 prismarine-nbt 能正确解出原始 NBT，所以这里自己做一层解析。
 *
 * litematic 的关键点：
 *   - 文件是 gzip 压缩的 NBT
 *   - 顶层有 Regions（可能多个）
 *   - 每个 Region 有 Size（可能为负，表示该轴朝向）、Position、BlockStates、BlockStatePalette
 *   - BlockStates 是 long 数组，按位打包方块索引
 *   - 每方块占用位数 = max(4, ceil(log2(调色板长度)))
 */

function bitsPerBlock(paletteSize) {
    return Math.max(4, Math.ceil(Math.log2(Math.max(2, paletteSize))));
}

/**
 * 从 long 数组里按位取出第 i 个值。
 * 注意：索引可能跨 long 边界，必须处理拼接。
 */
function readPackedValue(longArray, index, bits) {
    const bitPos = BigInt(index) * BigInt(bits);
    const longIdx = Number(bitPos / 64n);
    const bitOffset = Number(bitPos % 64n);
    const MASK = (1n << BigInt(bits)) - 1n;

    let value = BigInt.asUintN(64, BigInt(longArray[longIdx] ?? 0));
    if (bitOffset + bits > 64) {
        const next = BigInt.asUintN(64, BigInt(longArray[longIdx + 1] ?? 0));
        value = (value >> BigInt(bitOffset)) | (next << BigInt(64 - bitOffset));
    } else {
        value = value >> BigInt(bitOffset);
    }
    return Number(value & MASK);
}

/**
 * 读取一个 litematic 文件。
 * @param {string} filePath 绝对或相对路径
 * @returns {Object} { name, size:{x,y,z}, totalBlocks, blockCount, palette, regions, getBlock(x,y,z) }
 */
export function readLitematic(filePath) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
        throw new Error(`Schematic file not found: ${abs}`);
    }
    const buf = fs.readFileSync(abs);

    // litematic 是 gzip 压缩的 NBT；也兼容未压缩的 .schem（NBT 直接存）
    let raw;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        raw = zlib.gunzipSync(buf);
    } else {
        raw = buf;
    }
    const root = nbt.simplify(nbt.parseUncompressed(raw));

    if (!root.Regions || !Object.keys(root.Regions).length) {
        throw new Error('No Regions found - is this really a litematic file?');
    }

    // 先把所有区域解出来，再合并成一个整体包围盒
    const regions = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const [regionName, r] of Object.entries(root.Regions)) {
        const sx = r.Size?.x ?? 0, sy = r.Size?.y ?? 0, sz = r.Size?.z ?? 0;
        const px = r.Position?.x ?? 0, py = r.Position?.y ?? 0, pz = r.Position?.z ?? 0;
        const ax = Math.abs(sx), ay = Math.abs(sy), az = Math.abs(sz);
        const palette = r.BlockStatePalette || [];
        const states = r.BlockStates || [];
        const bits = bitsPerBlock(palette.length);

        regions.push({
            name: regionName, sx, sy, sz, px, py, pz,
            ax, ay, az, palette, states, bits,
        });

        // litematic 的 Position 是区域最小角；Size 为负时朝反方向延伸
        const x0 = px, x1 = px + sx;
        const y0 = py, y1 = py + sy;
        const z0 = pz, z1 = pz + sz;
        minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
        minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
        minZ = Math.min(minZ, z0, z1); maxZ = Math.max(maxZ, z0, z1);
    }

    const size = {
        x: Math.max(1, maxX - minX),
        y: Math.max(1, maxY - minY),
        z: Math.max(1, maxZ - minZ),
    };

    /**
     * 取某个「蓝图内部坐标」上的方块信息。
     * 内部坐标是 0-based，从包围盒最小角算起（0..size-1），
     * 和 litematic 的 Position/Size 原始坐标系无关 —— 调用方只需要
     * 知道「这个位置在蓝图里是什么方块」。
     * @returns {{name:string, properties:Object}|null}
     */
    const getBlock = (wx, wy, wz) => {
        // 把内部坐标（0-based）换算成 litematic 的原始世界坐标
        const gx = minX + wx, gy = minY + wy, gz = minZ + wz;
        for (const reg of regions) {
            // 该点是否落在本区域内
            const rx = gx - reg.px, ry = gy - reg.py, rz = gz - reg.pz;
            const inX = reg.sx >= 0 ? (rx >= 0 && rx < reg.ax) : (rx <= 0 && rx > -reg.ax);
            const inY = reg.sy >= 0 ? (ry >= 0 && ry < reg.ay) : (ry <= 0 && ry > -reg.ay);
            const inZ = reg.sz >= 0 ? (rz >= 0 && rz < reg.az) : (rz <= 0 && rz > -reg.az);
            if (!inX || !inY || !inZ) continue;

            // litematic 的索引顺序是 y 最快、然后 z、最后 x
            const ix = reg.sx >= 0 ? rx : Math.abs(rx) - 1;
            const iy = reg.sy >= 0 ? ry : Math.abs(ry) - 1;
            const iz = reg.sz >= 0 ? rz : Math.abs(rz) - 1;
            const index = (iy * reg.az + iz) * reg.ax + ix;

            const pi = readPackedValue(reg.states, index, reg.bits);
            const entry = reg.palette[pi];
            if (!entry) return null;
            return { name: entry.Name, properties: entry.Properties || {} };
        }
        return null;
    };

    // 统计非空气方块 —— 直接用 0-based 内部坐标遍历，和 getBlock 口径一致
    const blockCount = {};
    let totalBlocks = 0;
    for (let x = 0; x < size.x; x++) {
        for (let y = 0; y < size.y; y++) {
            for (let z = 0; z < size.z; z++) {
                const b = getBlock(x, y, z);
                if (!b || b.name === 'minecraft:air' || b.name === 'minecraft:cave_air') continue;
                blockCount[b.name] = (blockCount[b.name] || 0) + 1;
                totalBlocks++;
            }
        }
    }

    return {
        name: path.basename(abs, path.extname(abs)),
        size,
        origin: { x: minX, y: minY, z: minZ },
        totalBlocks,
        blockCount,
        regions: regions.map(r => ({ name: r.name, size: { x: r.ax, y: r.ay, z: r.az } })),
        getBlock,
    };
}

/**
 * 列出 schematics 目录里所有可用的蓝图。
 */
export function listSchematics(dir) {
    const d = path.resolve(dir);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d)
        .filter(f => /\.(litematic|schem|schematic)$/i.test(f))
        .map(f => {
            const p = path.join(d, f);
            const st = fs.statSync(p);
            return { file: f, path: p, sizeBytes: st.size };
        });
}
