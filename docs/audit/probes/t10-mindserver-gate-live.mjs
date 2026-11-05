/**
 * 第1条 ① 证据：握手门的两个方向 + 浏览器 cookie 那条路（真起 mindserver，随机端口）。
 *
 * 不需要 Minecraft 服务器：createMindServer 只起 http + socket.io + 任务板。
 * 用法（cwd 不限）：node docs/audit/probes/t10-mindserver-gate-live.mjs
 * 判读：无 token / 错 token → connect_error 且 code=AUTH_REQUIRED；
 *       对 token（auth payload / 自定义头 / 仅 cookie）→ 连上。
 *       `?token=` 只在 token 正确时才发 HttpOnly + SameSite=Strict 的 cookie。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINDCRAFT = path.resolve(__dirname, '../../../mindcraft');
const load = (rel) => import(pathToFileURL(path.join(MINDCRAFT, rel)).href);

// 让 mindserver 的 cwd 语义与生产一致（bots/ 等相对路径）
process.chdir(MINDCRAFT);

const { createMindServer, getHandshakeToken } = await load('src/mindcraft/mindserver.js');
const { io: ioc } = await load('node_modules/socket.io-client/build/esm/index.js');

const PORT = 18097;
createMindServer(false, PORT);
await new Promise((r) => setTimeout(r, 800));
const token = getHandshakeToken();

const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: p }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] }));
    }).on('error', reject);
});

const withToken = await get(`/?token=${token}`);
const cookie = (withToken.setCookie || [])[0]?.split(';')[0] || '';
const noToken = await get('/');
const badToken = await get('/?token=deadbeef');
console.log('[probe] GET /?token=正确 → Set-Cookie:', JSON.stringify(withToken.setCookie));
console.log('[probe] HttpOnly =', /HttpOnly/i.test(String(withToken.setCookie)), '| SameSite=Strict =', /SameSite=Strict/i.test(String(withToken.setCookie)));
console.log('[probe] GET /（无 token）不发 cookie =', !noToken.setCookie, '| GET /?token=错 不发 cookie =', !badToken.setCookie);

const tryConnect = (label, opts) => new Promise((resolve) => {
    const s = ioc(`http://localhost:${PORT}`, { transports: ['websocket'], reconnection: false, timeout: 3000, ...opts });
    const t = setTimeout(() => { s.close(); resolve(`${label}: TIMEOUT`); }, 4000);
    s.on('connect', () => { clearTimeout(t); s.close(); resolve(`${label}: CONNECTED`); });
    s.on('connect_error', (e) => { clearTimeout(t); s.close(); resolve(`${label}: REJECTED ${e?.data?.code || e.message}`); });
});
console.log('[probe]', await tryConnect('无 token', {}));
console.log('[probe]', await tryConnect('错 token', { auth: { token: 'wrong-token-value' } }));
console.log('[probe]', await tryConnect('对 token（auth）', { auth: { token } }));
console.log('[probe]', await tryConnect('对 token（自定义头）', { extraHeaders: { 'x-mindserver-token': token } }));
console.log('[probe]', await tryConnect('仅 cookie（浏览器控制台路径）', cookie ? { extraHeaders: { cookie } } : {}));
process.exit(0);
