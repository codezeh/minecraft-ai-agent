// 通过 MindServer(8080) 给 bot 发一条"玩家说的话"。
// 用法: node tools/say.mjs "去砍 8 个橡木" [from]
import { io } from 'socket.io-client';
// t23：mindserver 有握手 token 门了，裸 io(...) 会 AUTH_REQUIRED；走统一取 token 的工具
import { connectMindserver } from './lib/ms_token.mjs';

const msg = process.argv[2] || '你好';
const from = process.argv[3] || 'player';

function once(transports) {
    return new Promise((resolve) => {
        const sock = connectMindserver(io, 8080, { transports, timeout: 6000, reconnection: false });
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
if (/token|unauthor/i.test(String(a.reason) + String(b.reason))) {
    console.log('  原因：mindserver 拒绝握手（缺 token 或 token 错）。用 MINDSERVER_TOKEN=<token> 重试，或确认服务端已写出 .mindserver-token。');
}
process.exit(1);
