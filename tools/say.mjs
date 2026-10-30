// 通过 MindServer(8080) 给 bot 发一条"玩家说的话"。
// 用法: node tools/say.mjs "去砍 8 个橡木" [from]
import { io } from 'socket.io-client';

const msg = process.argv[2] || '你好';
const from = process.argv[3] || 'player';

function once(transports) {
    return new Promise((resolve) => {
        const sock = io('http://127.0.0.1:8080', { transports, timeout: 6000, reconnection: false });
        const done = (ok, reason) => { try { sock.close(); } catch {} resolve({ ok, reason }); };
        const timer = setTimeout(() => done(false, 'TIMEOUT'), 9000);
        sock.on('connect', () => {
            sock.emit('send-message', 'deepseek', { from, message: msg });
            setTimeout(() => { clearTimeout(timer); done(true, 'SENT'); }, 500);
        });
        sock.on('connect_error', (e) => { clearTimeout(timer); done(false, e.message); });
    });
}

const a = await once(['polling']);
if (a.ok) { console.log(`已发送（polling）→ deepseek: ${msg}`); process.exit(0); }
const b = await once(['websocket']);
if (b.ok) { console.log(`已发送（websocket）→ deepseek: ${msg}`); process.exit(0); }
console.log(`发送失败: polling=${a.reason} websocket=${b.reason}`);
process.exit(1);
