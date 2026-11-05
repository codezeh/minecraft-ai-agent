// 通过面板的 socket 接口优雅关服：
//  1) server-stop  → 走 RCON 'stop'（让纸片端自己刷盘关闭，绝不强杀）
//  2) shutdown     → 让 mindserver 停掉所有 agent 后自己退出
// 跑法：node web/scripts/stop-all.mjs
//
// ★ F-WEB-205（2026-11-06）：**必须带握手 token**。
//   server-stop / shutdown 都在 auth_gate.js 的握手门后面；不带 token 会被直接拒（AUTH_REQUIRED），
//   而旧代码把一切连接失败都说成"mindserver 没在跑" ⇒ 用户以为没开服、去关窗口 ⇒ 非优雅关停
//   （stop-panel.ps1 注释写明"走 RCON stop 会自己刷盘，不是强杀"）⇒ **存档未刷盘风险**。
//   token 来源顺序：环境变量 MINDSERVER_TOKEN → 当前目录 ./.mindserver-token（mindserver 写在它的 cwd）。
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const URL = 'http://127.0.0.1:8080';

function readToken() {
    if (process.env.MINDSERVER_TOKEN) return process.env.MINDSERVER_TOKEN.trim();
    try {
        return readFileSync(path.join(process.cwd(), '.mindserver-token'), 'utf8').trim();
    } catch { return null; }
}

const token = readToken();
if (!token) {
    console.log('[ERROR] 拿不到握手 token：既无 MINDSERVER_TOKEN 环境变量，也无 ./.mindserver-token。');
    console.log('        这**通常不是** "mindserver 没开"：请从 mindcraft/ 目录运行本脚本');
    console.log('        （token 文件写在 mindserver 的工作目录），或显式设 MINDSERVER_TOKEN=<token>。');
    process.exit(2);
}

const s = io(URL, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    auth: { token },        // ← auth_gate 认的四种来源之一（auth payload）
});

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
let connectErr = null;
s.on('connect', () => { connected = true; });
// F-WEB-205：把失败原因留住 —— "没开服" 和 "token 不对/缺失" 必须区分开，
// 否则用户会被"mindserver 可能没开"这句误导，转而去强关窗口（= 存档未刷盘）。
s.on('connect_error', (e) => { connectErr = e; });

await sleep(1500);

if (!connected) {
    const code = connectErr?.data?.code || connectErr?.message || '';
    if (String(code).includes('AUTH_REQUIRED') || /unauthorized/i.test(String(code))) {
        console.log('[ERROR] mindserver 在跑，但**握手被拒**（AUTH_REQUIRED）：token 不对或已过期。');
        console.log('        token 每次启动都会重新生成，请从 mindcraft/.mindserver-token 取当前值，');
        console.log('        或设 MINDSERVER_TOKEN=<当前 token> 后重跑本脚本。');
        console.log('        注意：此时服务器**仍在运行**，不要用关窗口/杀进程的方式停它（会丢未刷盘的存档）。');
        process.exit(3);
    }
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
