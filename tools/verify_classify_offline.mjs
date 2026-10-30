// 离线验证：新判据在真实存档上的效果（不需要服务器）。
// 对比旧窗口（±2, -2..5, art<=2）与新窗口（±2 先扫，不够扩 ±5/-2..10, art<=6）。
import { readFileSync } from 'fs';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';

const buf = readFileSync('./');
const chunks = new Map();

function decodeChunk(i) {
    const off = buf.readUIntBE(i * 4, 3), sec = buf[i * 4 + 3];
    if (!off || !sec) return null;
    const start = off * 4096, len = buf.readUInt32BE(start), comp = buf[start + 4];
    const payload = buf.subarray(start + 5, start + 4 + len);
    let raw;
    try { raw = comp === 1 ? zlib.gunzipSync(payload) : comp === 2 ? zlib.inflateSync(payload) : payload; } catch { return null; }
    try { return nbt.simplify(nbt.parseUncompressed(raw)); } catch { return null; }
}
function secBlocks(s) {
    const bs = s.block_states; if (!bs) return null;
    const pal = (bs.palette || []).map(p => (p?.Name || 'minecraft:air').replace('minecraft:', ''));
    if (!bs.data) return new Array(4096).fill(pal[0] || 'air');
    const bits = Math.max(4, Math.ceil(Math.log2(Math.max(1, pal.length))));
    const longs = bs.data, out = new Array(4096).fill('air');
    for (let i = 0; i < 4096; i++) {
        const bi = i * bits; let v = 0;
        for (let b = 0; b < bits; b++) { const li = Math.floor((bi + b) / 64); if (li >= longs.length) break; const lo = (bi + b) % 64; if ((longs[li] >> BigInt(lo)) & 1n) v |= (1 << b); }
        out[i] = pal[v] || 'air';
    }
    return out;
}
function get(ci, lx, y, lz) {
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return null;
    if (!chunks.has(ci)) {
        const d = decodeChunk(ci);
        if (!d) { chunks.set(ci, null); return null; }
        const secs = [];
        for (const s of d.sections) { if (!s.block_states) continue; const bl = secBlocks(s); if (bl) secs.push({ y: s.Y, b: bl }); }
        chunks.set(ci, secs);
    }
    const secs = chunks.get(ci);
    if (!secs) return null;
    const sy = Math.floor(y / 16);
    const sec = secs.find(s => s.y === sy);
    if (!sec) return 'air';
    const ly = ((y % 16) + 16) % 16;
    return sec.b[ly * 256 + lz * 16 + lx];
}

const ART = /(_planks$|_bricks$|_glass|_wool$|_concrete|_terracotta$|_carpet$|_stairs$|_slab$|_door$|_trapdoor$|_fence|_bed$|_sign$|chest$|barrel$|furnace$|crafting_table$|bookshelf|lantern$|torch$|_button$|_lever$|_pressure_plate$)/;

function counts(L, rx, ry0, ry1) {
    let leaves = 0, art = 0;
    for (let dx = -rx; dx <= rx; dx++) for (let dz = -rx; dz <= rx; dz++) for (let dy = ry0; dy <= ry1; dy++) {
        if (dx === 0 && dz === 0 && dy === 0) continue;
        const b = get(L.ci, L.lx + dx, L.y + dy, L.lz + dz);
        if (!b) continue;
        if (b.endsWith('_leaves')) leaves++;
        else if (ART.test(b)) art++;
    }
    return { leaves, art };
}

// 采样
const logs = [];
for (let ci = 0; ci < 1024; ci++) {
    for (let lx = 0; lx < 16; lx += 2) for (let lz = 0; lz < 16; lz += 2) {
        for (let y = 50; y < 110; y++) if (get(ci, lx, y, lz) === 'oak_log') logs.push({ ci, lx, y, lz });
    }
}
console.log(`采样原木 ${logs.length} 根\n`);

let oldPass = 0, newPass = 0, bothFail = 0, oldFailNewPass = 0, oldPassNewFail = 0;
for (const L of logs) {
    const a = counts(L, 2, -2, 5);
    const oldOk = a.leaves >= 3 && a.art <= 2;
    let nb = a;
    if (nb.leaves < 3) nb = counts(L, 5, -2, 10);
    const newOk = nb.leaves >= 3 && nb.art <= 6;

    if (oldOk) oldPass++;
    if (newOk) newPass++;
    if (!oldOk && newOk) oldFailNewPass++;
    if (oldOk && !newOk) oldPassNewFail++;
    if (!oldOk && !newOk) bothFail++;
}

console.log(`旧判据通过: ${oldPass} (${(oldPass / logs.length * 100).toFixed(1)}%)`);
console.log(`新判据通过: ${newPass} (${(newPass / logs.length * 100).toFixed(1)}%)`);
console.log(`旧拒→新过（救回来的）: ${oldFailNewPass}`);
console.log(`旧过→新拒（新引入的误杀）: ${oldPassNewFail}`);
console.log(`仍然被拒: ${bothFail}`);
