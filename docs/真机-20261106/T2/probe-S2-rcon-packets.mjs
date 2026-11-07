// 诊断（含真机上下文）：bot 到场 → 放 2 煤 + 4 原料 → 用裸 socket 打印 RCON 每个包
// 解决两个疑问：
//   ① `data get block ... Items` 的长响应是否被拆包 / 我的客户端是否漏了后半段
//   ② 熔炉燃料槽在 NBT 里到底存了几份煤
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { connectBot, setupPlatform, setFurnace, clearInv, sleep, Rcon } from './lib-probe.mjs';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;

function rawDump(cmd, waitMs = 2500) {
    const txt = readFileSync('E:/我的世界ai/server/server.properties', 'utf8');
    const props = {};
    for (const l of txt.split(/\r?\n/)) { if (!l || l.startsWith('#')) continue; const i = l.indexOf('='); if (i > 0) props[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    const pw = props['rcon.password'];
    const port = Number(props['rcon.port'] || 25575);
    return new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1');
        let buf = Buffer.alloc(0);
        const packets = [];
        let stage = 'auth';
        const t0 = Date.now();
        const pack = (id, type, body) => {
            const b = Buffer.from(body, 'utf8');
            const o = Buffer.alloc(14 + b.length);
            o.writeInt32LE(10 + b.length, 0); o.writeInt32LE(id, 4); o.writeInt32LE(type, 8);
            b.copy(o, 12); o.writeInt16LE(0, 12 + b.length);
            return o;
        };
        sock.on('connect', () => sock.write(pack(1, 3, pw)));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 12) {
                const size = buf.readInt32LE(0);
                if (size < 10 || buf.length < size + 4) break;
                const id = buf.readInt32LE(4), type = buf.readInt32LE(8);
                const body = buf.slice(12, size + 4 - 2).toString('utf8');
                buf = buf.slice(size + 4);
                packets.push({ atMs: Date.now() - t0, id, type, size, bodyLen: body.length, body });
                if (stage === 'auth') { stage = 'cmd'; sock.write(pack(7, 2, cmd)); }
            }
        });
        setTimeout(() => { sock.end(); resolve(packets); }, waitMs);
    });
}

const rcon = new Rcon();
let bot;
try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await sleep(300);
    await rcon.cmd(`item replace block ${FX} ${FY} ${FZ} container.0 with minecraft:raw_iron 4`);
    await rcon.cmd(`item replace block ${FX} ${FY} ${FZ} container.1 with minecraft:coal 2`);

    const packets = await rawDump(`data get block ${FX} ${FY} ${FZ} Items`);
    console.log(JSON.stringify({ furnace: { FX, FY, FZ }, packets }, null, 2));
} catch (e) {
    console.error('DIAG FAILED', e?.stack ?? e);
    process.exitCode = 1;
} finally {
    try { bot?.quit('d'); } catch { }
    rcon.close(); await sleep(200);
    process.exit(process.exitCode ?? 0);
}
