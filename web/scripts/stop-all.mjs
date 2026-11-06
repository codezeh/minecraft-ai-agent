// 通过面板的 socket 接口优雅关服：
//  1) server-stop  → 走 RCON 'stop'（让纸片端自己刷盘关闭，绝不强杀）
//  2) shutdown     → 让 mindserver 停掉所有 agent 后自己退出
// 跑法：node web/scripts/stop-all.mjs
//
// 退出码：0=已停 / 本来没跑；2=拿不到 token；3=握手被拒；4=**关服没成功**（此时管理端保持运行）。
// ★ OPS-002（2026-11-06 深度检查）：4 就是这条修出来的 —— 以前关服失败也照样关管理端并 exit 0。
//
// ★ F-WEB-205（2026-11-06）：**必须带握手 token**。
//   server-stop / shutdown 都在 auth_gate.js 的握手门后面；不带 token 会被直接拒（AUTH_REQUIRED），
//   而旧代码把一切连接失败都说成"mindserver 没在跑" ⇒ 用户以为没开服、去关窗口 ⇒ 非优雅关停
//   （stop-panel.ps1 注释写明"走 RCON stop 会自己刷盘，不是强杀"）⇒ **存档未刷盘风险**。
//   token 来源顺序：环境变量 MINDSERVER_TOKEN → 当前目录 ./.mindserver-token（mindserver 写在它的 cwd）。
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { decideAfterStop, decideAfterExitWait, STOP_EXIT } from './stop-policy.mjs';

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

// ★ OPS-002（2026-11-06 深度检查）：关服失败**不许**照样关掉管理端并报告"完成"。
//
//   缺陷原貌：这里无论 `r.ok` 是什么都往下走 —— 打印一句"跳过：rcon_failed"，
//   然后 emit('shutdown') 关掉 mindserver，最后 exit 0 + "完成。"。
//   用户看到"完成"，实际 Minecraft 还在后台跑（RCON 没配/认证失败/超时都走这条），
//   接着很可能去强关窗口 ⇒ 存档没刷盘。
//
//   现在的口径：
//     · not_running  → 本来就没跑，跳过是正确行为（继续收尾）；
//     · ok           → 发出停止指令后**必须确认它真的退出**（端口不再监听）才关管理端；
//     · 其它（rcon_failed / rcon_disabled / 超时）→ **保留管理端、非零退出**，
//       文案说清"服务器可能仍在运行"以及怎么修。
const MC_PORT = Number(process.env.MINECRAFT_PORT || process.env.MC_PORT || 25565);

/** 端口还在监听吗（纯 node:net，不引依赖）。 */
function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800) {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host });
        const done = (v) => { try { sock.destroy(); } catch { } resolve(v); };
        const t = setTimeout(() => done(false), timeoutMs);
        sock.once('connect', () => { clearTimeout(t); done(true); });
        sock.once('error', () => { clearTimeout(t); done(false); });
    });
}

/** 等 Minecraft 自己刷盘退出：最多 timeoutMs，超时返回 false。 */
async function waitServerExit(timeoutMs = 45000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (!(await isPortOpen(MC_PORT))) return true;
        await sleep(1000);
    }
    return !(await isPortOpen(MC_PORT));
}

function failStop(reason, hint) {
    console.log('');
    console.log('[ERROR] 关服没有成功：' + (reason || '?') + (hint ? ' — ' + hint : ''));
    console.log('        Minecraft **很可能仍在运行**，所以管理端（mindserver）**保持开启**，');
    console.log('        方便你修复后重跑本脚本。请不要用关窗口/杀进程的方式停它（会丢未刷盘的存档）。');
    console.log('        常见修法：server.properties 里 enable-rcon=true + rcon.password=<非空>，重启服务器后再试。');
    try { s.close(); } catch { /* ignore */ }
    // 退出码 4：关服失败（2=拿不到 token，3=握手被拒，4=关服没成功）—— stop-panel.ps1 按它给提示。
    process.exit(STOP_EXIT.STOP_FAILED);
}

if (r?.ok) {
    console.log('   已发出停止指令，等它自己刷盘退出（5~15 秒）');
    const d = decideAfterExitWait(await waitServerExit());
    if (d.action === 'fail') failStop(d.reason, d.hint);
    console.log('   已确认 Minecraft 退出（' + MC_PORT + ' 端口已关闭）');
}
else {
    const d = decideAfterStop(r);
    if (d.action === 'fail') failStop(d.reason, d.hint);
    console.log('   跳过：Minecraft 本来就没在运行');
}

console.log('2) 停止 agent 并关闭 mindserver...');
try {
    s.emit('shutdown');
} catch { /* ignore */ }

await sleep(4000);
console.log('完成。');
s.close();
process.exit(0);
