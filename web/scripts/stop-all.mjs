// 通过面板的 socket 接口优雅关服：
//  1) server-stop  → 走 RCON 'stop'（让纸片端自己刷盘关闭，绝不强杀）
//  2) shutdown     → 让 mindserver 停掉所有 agent 后自己退出
// 跑法：node web/scripts/stop-all.mjs
import { io } from 'socket.io-client';

const URL = 'http://127.0.0.1:8080';
const s = io(URL, { path: '/socket.io', transports: ['websocket'], reconnection: false });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ack(event, ...args) {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => {
            if (!done) { done = true; resolve({ ok: false, reason: '超时（mindserver 可能没开）' }); }
        }, 20000);
        s.emit(event, ...args, (r) => {
            if (done) return;
            done = true;
            clearTimeout(t);
            resolve(r ?? { ok: false, reason: '空响应' });
        });
    });
}

let connected = false;
s.on('connect', () => { connected = true; });
s.on('connect_error', () => { });

await sleep(1500);

if (!connected) {
    console.log('mindserver 没在跑（8080 连不上），不用停。');
    process.exit(0);
}

console.log('1) 优雅停止 Minecraft 服务器（RCON stop）...');
const r = await ack('server-stop');
if (r?.ok) {
    console.log('   已发出停止指令，等它自己刷盘退出（5~15 秒）');
} else {
    console.log('   跳过：' + (r?.reason || '?') + (r?.hint ? ' — ' + r.hint : ''));
}

console.log('2) 停止 agent 并关闭 mindserver...');
try {
    s.emit('shutdown');
} catch { /* ignore */ }

await sleep(4000);
console.log('完成。');
s.close();
process.exit(0);
