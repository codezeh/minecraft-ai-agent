// T2 probe harness — shared helpers for real-machine (Paper + mineflayer) probes.
// NOT product code: everything here lives in docs/真机-20261106/T2/.
//
// Provides:
//   • Rcon        — in-process RCON client (password read from server.properties, never printed)
//   • connectBot  — real mineflayer bot (reuses mindcraft/node_modules, mineflayer 4.39.0)
//   • world setup — flat platform + furnace/chest placement via server commands
//   • item/inv    — /give, /clear, inventory counts, block-entity NBT reads
import net from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export const T2 = 'E:/我的世界ai/docs/真机-20261106/T2';
export const ROOT = 'E:/我的世界ai';
const MIND_PKG = ROOT + '/mindcraft/package.json';
const PROPS = ROOT + '/server/server.properties';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();

// ────────────────────────────── RCON ──────────────────────────────
export class Rcon {
    constructor() {
        const txt = readFileSync(PROPS, 'utf8');
        const props = {};
        for (const line of txt.split(/\r?\n/)) {
            if (!line || line.startsWith('#')) continue;
            const i = line.indexOf('=');
            if (i > 0) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        this.port = Number(props['rcon.port'] || 25575);
        this.host = '127.0.0.1';
        this._pw = props['rcon.password'];   // never logged
        if (!this._pw) throw new Error('no rcon.password in server.properties');
        this._id = 0;
        this._pending = new Map();
        this._buf = Buffer.alloc(0);
        this._ready = null;
    }

    static _packet(id, type, body) {
        const b = Buffer.from(body, 'utf8');
        const buf = Buffer.alloc(14 + b.length);
        buf.writeInt32LE(10 + b.length, 0);
        buf.writeInt32LE(id, 4);
        buf.writeInt32LE(type, 8);
        b.copy(buf, 12);
        buf.writeInt16LE(0, 12 + b.length);
        return buf;
    }

    connect() {
        if (this._ready) return this._ready;
        this._ready = new Promise((resolve, reject) => {
            this.sock = net.connect(this.port, this.host);
            this.sock.on('connect', () => {
                this.sock.write(Rcon._packet(1, 3, this._pw));
                this._authResolve = resolve;
            });
            this.sock.on('data', (d) => this._onData(d));
            this.sock.on('error', reject);
        });
        return this._ready;
    }

    _onData(d) {
        this._buf = Buffer.concat([this._buf, d]);
        while (this._buf.length >= 12) {
            const size = this._buf.readInt32LE(0);
            if (size < 10 || this._buf.length < size + 4) return;
            const id = this._buf.readInt32LE(4);
            const body = this._buf.slice(12, size + 4 - 2).toString('utf8');
            this._buf = this._buf.slice(size + 4);
            if (id === 1) { this._authResolve?.(); continue; }   // auth ack
            const p = this._pending.get(id);
            if (!p) continue;
            // ★ 关键：RCON 的响应可能被拆成**多个包**（长 NBT / data get 就超 4096 字节）。
            //   第一版实现在这里直接 resolve(首包) → `data get block` 的结果被腰斩成
            //   `{Slot: 1b, id: "minecraft:...`，于是 A2 的装料快照把燃料槽读成了"没有"。
            //   这是**探针端**的 bug（不是产品问题）：改成"收到包后静默 80ms 再收尾"，
            //   把同一 id 的所有分片拼起来。
            p.chunks.push(body);
            if (p.quiet) clearTimeout(p.quiet);
            p.quiet = setTimeout(() => {
                this._pending.delete(id);
                clearTimeout(p.timer);
                p.resolve(p.chunks.join(''));
            }, 80);
        }
    }

    async cmd(command, timeoutMs = 10000) {
        await this.connect();
        const id = ++this._id + 10;
        const body = await new Promise((resolve, reject) => {
            const entry = { chunks: [], resolve, quiet: null };
            entry.timer = setTimeout(() => {
                this._pending.delete(id);
                if (entry.quiet) clearTimeout(entry.quiet);
                reject(new Error('rcon timeout: ' + command));
            }, timeoutMs);
            this._pending.set(id, entry);
            this.sock.write(Rcon._packet(id, 2, command));
        });
        return String(body).trim();
    }

    close() { try { this.sock?.end(); } catch { } }
}

// ────────────────────────────── bot ──────────────────────────────
const require = createRequire(MIND_PKG);
const mineflayer = require('mineflayer');

export async function connectBot(username = 'probe2', opts = {}) {
    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: 25565,
        username, auth: 'offline', version: '1.21.8',
        chatLengthLimit: 256,
        ...opts,
    });
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('spawn timeout')), 30000);
        bot.once('spawn', () => { clearTimeout(t); resolve(); });
        bot.once('kicked', (r) => { clearTimeout(t); reject(new Error('kicked: ' + JSON.stringify(r))); });
        bot.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    return bot;
}

// ────────────────────────────── world setup ──────────────────────────────
/**
 * 在 center 附近铺一块 9x9 石台并把 bot 传送过去；返回几何信息。
 * 必须先传送（把 chunk 载入），否则 setblock/fill 会报 "That position is not loaded"。
 */
export async function setupPlatform(rcon, username, cx, cy, cz) {
    await rcon.cmd(`tp ${username} ${cx + 0.5} ${cy + 2} ${cz + 0.5}`);
    await sleep(700);
    await rcon.cmd(`fill ${cx - 4} ${cy} ${cz - 4} ${cx + 4} ${cy} ${cz + 4} minecraft:stone`);
    await rcon.cmd(`fill ${cx - 4} ${cy + 1} ${cz - 4} ${cx + 4} ${cy + 3} ${cz + 4} minecraft:air`);
    await rcon.cmd(`tp ${username} ${cx + 0.5} ${cy + 1} ${cz + 0.5}`);
    await sleep(500);
    return { floorY: cy, standY: cy + 1, center: { x: cx, y: cy, z: cz } };
}

export async function setFurnace(rcon, x, y, z) {
    return rcon.cmd(`setblock ${x} ${y} ${z} minecraft:furnace replace`);
}

export async function setChest(rcon, x, y, z) {
    return rcon.cmd(`setblock ${x} ${y} ${z} minecraft:chest replace`);
}

export async function give(rcon, username, item, count) {
    return rcon.cmd(`give ${username} minecraft:${item} ${count}`);
}

export async function clearInv(rcon, username) {
    return rcon.cmd(`clear ${username}`);
}

/** 读方块实体 NBT（furnace/chest 的 Items）。需要该 chunk 已加载。 */
export async function blockItems(rcon, x, y, z) {
    const raw = await rcon.cmd(`data get block ${x} ${y} ${z} Items`);
    const out = [];
    const re = /Slot:\s*(-?\d+)b?[^}]*?id:\s*"minecraft:([a-z0-9_]+)"[^}]*?count:\s*(\d+)/g;
    let m;
    while ((m = re.exec(raw))) out.push({ slot: Number(m[1]), id: m[2], count: Number(m[3]) });
    // Paper 可能先打 "has no block data" 之类
    return { raw, items: out, empty: out.length === 0 };
}

/**
 * ★ 可靠版：逐格查 `Items[i].id` / `Items[i].count`。
 *
 * 为什么不能用上面的 `blockItems` 判"箱子装了几格"：
 *   vanilla 的 `/data get` 会把长结果**截断成 `...`**（实测正文 111 字符就截了，
 *   见 probe-S2-rcon-packets.mjs：bodyLen=111，结尾就是 `{Slot: 1b, id: "minecraft:`）。
 *   一次多格的箱子/熔炉，第一条命令只能看到第 0、1 格 ⇒ 会把"24 格已填满"误读成"1 格"。
 *   逐格路径查询的返回值都很短，不受截断影响。
 * @param {number} n 容器槽位数（箱子 27，大箱子 54，熔炉 3）
 */
export async function blockSlots(rcon, x, y, z, n = 27) {
    const slots = [];
    for (let i = 0; i < n; i++) {
        const idRaw = await rcon.cmd(`data get block ${x} ${y} ${z} Items[${i}].id`);
        const cntRaw = await rcon.cmd(`data get block ${x} ${y} ${z} Items[${i}].count`);
        const mi = /minecraft:[a-z0-9_]+/.exec(idRaw);
        const mc = /block data:\s*(\d+)/.exec(cntRaw);
        if (mi) slots.push({ slot: i, id: mi[0].replace('minecraft:', ''), count: mc ? Number(mc[1]) : null });
    }
    return { slots, used: slots.length, free: n - slots.length };
}

/** 服务端权威的玩家背包计数：`clear <p> <item> 0` 只报告不删除。 */
export async function serverItemCount(rcon, username, item) {
    const raw = await rcon.cmd(`clear ${username} minecraft:${item} 0`);
    const m = /[Ff]ound\s+(\d+)/.exec(raw);
    return { raw, count: m ? Number(m[1]) : null };
}

/** 熔炉三格（0=输入 1=燃料 2=产物）摘要。 */
export async function furnaceState(rcon, x, y, z) {
    const { items, raw } = await blockItems(rcon, x, y, z);
    const pick = (slot) => items.find((i) => i.slot === slot) ?? null;
    return {
        input: pick(0), fuel: pick(1), output: pick(2),
        all: items, raw,
    };
}

export function invCount(bot, itemName) {
    let n = 0;
    for (const it of bot.inventory.items()) if (it.name === itemName) n += it.count;
    return n;
}

export function invSummary(bot) {
    const o = {};
    for (const it of bot.inventory.items()) o[it.name] = (o[it.name] ?? 0) + it.count;
    return o;
}

export function writeResult(name, data) {
    const path = `${T2}/${name}`;
    writeFileSync(path, JSON.stringify(data, null, 2));
    return path;
}

/** 带时间戳的一行日志。 */
export function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}
