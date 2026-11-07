// T0 minimal RCON client (Minecraft RCON protocol) — one command per invocation.
// Usage: node rcon.mjs "<command>"
// Reads rcon.host/rcon.port/rcon.password from E:\我的世界ai\server\server.properties.
// SECURITY: the password is never echoed; output only contains the server's reply.
import net from 'node:net';
import { readFileSync } from 'node:fs';

const PROPS = 'E:\\我的世界ai\\server\\server.properties';
const raw = readFileSync(PROPS, 'utf8');
const props = {};
for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const host = props['rcon.ip'] || '127.0.0.1';
const port = Number(props['rcon.port'] || 25575);
const password = props['rcon.password'];
if (!password) { console.error('no rcon.password configured'); process.exit(2); }

const command = process.argv.slice(2).join(' ');
if (!command) { console.error('usage: node rcon.mjs "<command>"'); process.exit(2); }

const TYPE_AUTH = 3, TYPE_AUTH_RESP = 2, TYPE_CMD = 2, TYPE_RESP = 0;

function packet(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(14 + b.length);
    buf.writeInt32LE(10 + b.length, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    b.copy(buf, 12);
    buf.writeInt16LE(0, 12 + b.length);
    return buf;
}

const sock = net.connect(port, host);
let stage = 'auth';
let buf = Buffer.alloc(0);
const chunks = [];
const timer = setTimeout(() => { console.error('RCON timeout'); process.exit(3); }, 10000);

function drain() {
    while (buf.length >= 12) {
        const size = buf.readInt32LE(0);
        if (size < 10 || buf.length < size + 4) return;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.slice(12, size + 4 - 2).toString('utf8');
        buf = buf.slice(size + 4);
        if (stage === 'auth') {
            if (id === -1) { console.error('AUTH FAILED (wrong rcon.password)'); process.exit(4); }
            if (type === TYPE_AUTH_RESP || type === TYPE_RESP) {
                stage = 'cmd';
                sock.write(packet(7, TYPE_CMD, command));
            }
            continue;
        }
        // command response(s)
        chunks.push(body);
        if (id === 7) {
            // final response; small grace window in case of split packets
            setTimeout(() => { clearTimeout(timer); sock.end(); console.log(chunks.join('')); }, 120);
        }
    }
}

sock.on('connect', () => { sock.write(packet(1, TYPE_AUTH, password)); });
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); drain(); });
sock.on('error', (e) => { console.error('RCON socket error: ' + e.message); process.exit(5); });
sock.on('close', () => { clearTimeout(timer); });
