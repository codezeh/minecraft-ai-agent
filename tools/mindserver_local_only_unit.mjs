/**
 * mindserver 的 socket 只放本机连接 —— 第一轮审查的安全项，不需要 Minecraft 服务器。
 *
 * 缺陷原貌：mindserver 只绑 localhost，但浏览器里**任何网页**都能直接对 localhost:8080 开 WebSocket
 * （socket.io 的 cors 只管 HTTP 长轮询，管不到 WebSocket 握手），连上后就能发
 * create-agent / send-message（让 bot 写代码执行）/ server-stop / shutdown。
 *
 * 修复：io 的 allowRequest = allowLocalOnly（src/mindcraft/local_only.js）：
 *   Host 必须是本机名（挡 DNS rebinding），带了 Origin 就必须是本机页面（挡跨站网页）；
 *   不带 Origin 的是 Node 进程（agent、tools 脚本），照放。
 *
 * 这里起一个只挂 allowLocalOnly 的临时 socket.io（随机端口、只绑 127.0.0.1），
 * 不 import mindserver.js —— 那会连带 mindcraft.js 的 agent 进程管理。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import http from 'node:http';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import WebSocket from 'ws';
import { isLocalRequest, allowLocalOnly } from '../src/mindcraft/local_only.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ── 1. 判据本身 ─────────────────────────────────────────────
const req = (host, origin) => ({ headers: { ...(host !== undefined && { host }), ...(origin !== undefined && { origin }) } });
const table = [
    ['agent 进程（无 Origin）', req('localhost:8080'), true],
    ['本机面板（同源）', req('localhost:8080', 'http://localhost:8080'), true],
    ['127.0.0.1 面板', req('127.0.0.1:8080', 'http://127.0.0.1:8080'), true],
    ['IPv6 回环', req('[::1]:8080', 'http://[::1]:8080'), true],
    ['vite 开发代理（Origin 是 5173）', req('127.0.0.1:8080', 'http://localhost:5173'), true],
    ['别的网站的网页', req('localhost:8080', 'https://evil.example'), false],
    ['DNS rebinding（Host 是外部域名）', req('evil.example:8080', 'http://evil.example:8080'), false],
    ['沙箱 iframe（Origin: null）', req('localhost:8080', 'null'), false],
    ['长得像 localhost 的域名', req('localhost.evil.example:8080', 'http://localhost.evil.example:8080'), false],
    ['没有 Host', req(undefined, undefined), false],
];
for (const [name, r, want] of table) {
    check(`判据：${name}`, isLocalRequest(r) === want, `got=${isLocalRequest(r)}`);
}

// ── 2. 挂到真的 socket.io 上 ────────────────────────────────
const httpServer = http.createServer();
const io = new Server(httpServer, { allowRequest: allowLocalOnly });
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const port = httpServer.address().port;

/** 直接打 engine.io 的长轮询握手：返回 HTTP 状态码 */
function pollHandshake(headers) {
    return new Promise((resolve) => {
        const r = http.request({ host: '127.0.0.1', port, path: '/socket.io/?EIO=4&transport=polling', headers }, (res) => {
            res.resume();
            resolve(res.statusCode);
        });
        r.on('error', (e) => resolve(`error ${e.code}`));
        r.end();
    });
}

/** 用 ws 直接做 WebSocket 握手（可以自带 Origin，模拟网页）：返回 'open' 或拒绝原因 */
function wsHandshake(origin) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { headers: { Origin: origin } });
        const t = setTimeout(() => { ws.terminate(); resolve('timeout'); }, 3000);
        ws.on('open', () => { clearTimeout(t); ws.close(); resolve('open'); });
        ws.on('unexpected-response', (_req, res) => { clearTimeout(t); resolve(`http ${res.statusCode}`); ws.terminate(); });
        ws.on('error', (e) => { clearTimeout(t); resolve(`error ${e.message}`); });
    });
}

const pollLocal = await pollHandshake({ Host: `127.0.0.1:${port}` });
check('长轮询：本机 Host、无 Origin → 放行', pollLocal === 200, String(pollLocal));
const pollEvil = await pollHandshake({ Host: `127.0.0.1:${port}`, Origin: 'https://evil.example' });
check('长轮询：别的网站 Origin → 403', pollEvil === 403, String(pollEvil));
const pollRebind = await pollHandshake({ Host: `evil.example:${port}` });
check('长轮询：DNS rebinding Host → 403', pollRebind === 403, String(pollRebind));

const wsLocal = await wsHandshake(`http://localhost:${port}`);
check('WebSocket：本机页面 Origin → 放行', wsLocal === 'open', wsLocal);
const wsEvil = await wsHandshake('https://evil.example');
check('WebSocket：别的网站 Origin → 拒绝', wsEvil !== 'open', wsEvil);

// 真实客户端（和 mindserver_proxy 一样：Node + 只走 websocket）照常能连
const connected = await new Promise((resolve) => {
    const c = ioc(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, timeout: 3000 });
    c.on('connect', () => { c.close(); resolve(true); });
    c.on('connect_error', (e) => { c.close(); resolve(`connect_error ${e.message}`); });
});
check('socket.io-client（Node，无 Origin）照常连上', connected === true, String(connected));

io.close();

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
