import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import * as procCtrl from './proc_control.js';
import { allowLocalOnly } from './local_only.js';
// 第一轮审查 第1条 ①②：握手 token 门 + set-agent-settings 字段白名单（见 auth_gate.js 顶部说明）
import {
    makeToken, makeHandshakeGate, authCookieHeader, hasAuthCookie,
    sanitizeAgentSettings,
} from './auth_gate.js';
// 第2条：create-agent 的 profile 名复用 agent 侧同一份校验（规则只能有一个真相）
import { validateNameFormat } from '../agent/connection_handler.js';
import { readFileSync, existsSync, readdirSync, writeFileSync, fstatSync } from 'fs';
// M8 B1（2026-11-02）：任务板。**只有 mindserver 写库**（06 §3：每个 agent 是独立子进程，
// 板放 agent 里别的 bot 看不见；放这里就只有一个写者，省掉多进程锁）。
import { openBoard } from '../agent/library/board_store.js';
import { attachBoardServer } from '../agent/library/board_server.js';
// 注册表与参数解析器：服务端复用 **agent 侧同一份**（参数规则只能有一个真相）。
import * as compositeRegistry from '../agent/library/composite_registry.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
// 第一轮审查 第1条 ①：本次启动的握手 token（io.use 校验；agent 子进程从 env 拿到同一份）
let handshakeToken = null;
const agent_connections = {};
const agent_listeners = [];

/** 本次启动的握手 token；`init()` 之外的调用方（自动开浏览器）靠它拼 `?token=`。 */
export function getHandshakeToken() {
    return handshakeToken;
}

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

// Initialize the server
// F-WEB-203：按远端地址共享的令牌桶（跨连接，重连不清零）
const RATE_BUCKETS = new Map();

export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);

    // ── 握手 token（第一轮审查 第1条 ①）────────────────────────────────
    // 为什么需要它：只绑 localhost 挡不住「本机任意进程」，local_only.js 的 Origin 判据挡不住
    // 「不带 Origin 的脚本」。这里生成一个每次启动都不同的 token，io.use 校验；
    // 所有特权事件都在 io.on('connection') 里，所以全部落在这道门后。
    // 同用户进程仍能读到它（启动日志/env）—— 那不是这道门能解决的，见 auth_gate.js 顶部说明。
    handshakeToken = process.env.MINDSERVER_TOKEN || makeToken();
    // agent 子进程（AgentProcess 默认继承 process.env）靠这个连回来
    process.env.MINDSERVER_TOKEN = handshakeToken;

    // F-SEC-205（2026-11-06）：token 不再无条件打到 stdout。
    // 为什么：scripts/start-panel.ps1:189 把 mindcraft 的 stdout 重定向进
    // `logs/mindcraft-console.log` ⇒ 原来那三行 `token=…` 会**落盘**，而日志正是
    // "出问题时发给别人看"的东西（拿到它 = 能指挥 bot / 改设置 / 停服）。
    // 新通道：写到 cwd 下的 `.mindserver-token`（已进 .gitignore，F-SEC-206），
    // 注意：mode 0600 只在 POSIX 生效，**Windows/NTFS 上不保证只有本机用户可读**
    // （那边由 NTFS ACL 决定）。所以这层不是权限边界，它的目的是"别再进日志"。
    // start-panel.ps1 从它读 token 拼出可点的面板地址。
    // 仍然需要"在终端里看见完整值"时，显式设 MINDSERVER_PRINT_TOKEN=1（调试用）。
    const TOKEN_FILE = path.join(process.cwd(), '.mindserver-token');
    try {
        writeFileSync(TOKEN_FILE, handshakeToken, { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
        // 只读 cwd / 无权限也要能启动：降级为"只在显式开关下打印"
        console.warn(`[mindserver] 写 ${TOKEN_FILE} 失败（${e?.code ?? e}）；本次 token 只能通过 MINDSERVER_TOKEN 环境变量或 MINDSERVER_PRINT_TOKEN=1 获取`);
    }

    // 浏览器控制台：把 ?token=… 换成 HttpOnly + SameSite=Strict 的 cookie，之后同源握手自动带上。
    // 不这么做的话，面板（web/dist 已构建，改前端源码要重打包）会直接连不上。
    app.use((req, res, next) => {
        const fromQuery = typeof req.query?.token === 'string' ? req.query.token : null;
        if (fromQuery && fromQuery === handshakeToken && !hasAuthCookie(req.headers.cookie, handshakeToken)) {
            res.setHeader('Set-Cookie', authCookieHeader(handshakeToken));
        }
        next();
    });

    // ★ F-WEB-201 + F-WEB-204（2026-11-06）：HTTP 层也要有门 + 安全响应头。
    //
    // 原来的问题（侦察席实测）：`/`、`/settings_spec.json`、`/console/` 三个出口**无需任何 token**
    // 就返回 200；`io.use(makeHandshakeGate)` 只管 socket.io，管不到 HTTP。且零安全头、
    // 还带着 `X-Powered-By: Express`（版本指纹）。
    // 诚实边界：socket 事件仍需 token，所以这不是 RCE；但 `/settings_spec.json` 会把配置结构
    // （含 allow_insecure_coding / task 这类键名）交给任何本机进程或任意网页。
    //
    // 修法：**同一个 token**，两种携带方式（已种下的 cookie / 首屏的 ?token=）。不新增依赖。
    // 注意：socket.io 的 `/socket.io/` 请求由 engine.io 自己接管，不经 express 中间件，
    //      所以它仍由 `allowRequest` + `io.use(makeHandshakeGate)` 把关（两套门各管各的）。
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader(
            'Content-Security-Policy',
            // 诚实交代一处**故意放宽**（由 captain 复核时实测发现并纠正）：
            // public/index.html 里有 1 个内联 <script> 与 15 个 onclick= 内联事件属性。
            // CSP 的 script-src 'self' 会同时拦掉两者 ⇒ 旧控制台按钮全失灵、页面变白。
            // 而 CSP 在本条修复里只是**附加防御**：真正堵住 F-WEB-201 的是下面的 token 门。
            // 所以 script-src 保留 'unsafe-inline'（与 style-src 同理），其余不动：
            //   default-src 'self' 仍然挡住外部源脚本（XSS 最现实的外链向量）
            //   frame-ancestors 'none' + X-Frame-Options 挡点击劫持
            // 后续可选加固（另单）：把 index.html 的内联 onclick 迁到外部 js，再收紧回 script-src 'self'。
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'"
        );
        next();
    });
    app.use((req, res, next) => {
        const viaCookie = hasAuthCookie(req.headers.cookie, handshakeToken);
        const viaQuery = typeof req.query?.token === 'string' && req.query.token === handshakeToken;
        if (viaCookie || viaQuery) return next();
        // req.path 是解码后的，%0A 会变成真换行 ⇒ 可伪造日志行。去控制字符后再打。
        const safePath = String(req.path).replace(/[\r\n\t]/g, ' ');
        console.warn(`[mindserver] 拒绝无 token 的 HTTP 请求 ${req.method} ${safePath}`);
        // F-WEB-201 P0（captain 补修）：浏览器访问时返回**可读的 HTML**，而不是一行纯文本。
        // 一行 "unauthorized" 看起来像服务器坏了；给一段人能照做的说明，差一个数量级。
        // 复核席建议：port 来自环境变量（非 HTTP 参数，网络不可达）；但既然 CSP 已放宽，
        // 就不该再靠"不可达"当防御 —— 一行归一把它变成纯数字。
        const safePort = String(Number.parseInt(port, 10) || 8080);
        const wantsHtml = String(req.headers.accept || '').includes('text/html');
        if (wantsHtml) {
            res.status(401).type('html; charset=utf-8').send(
                '<!doctype html><meta charset="utf-8"><title>需要握手 token</title>' +
                '<body style="font:14px/1.7 system-ui;max-width:640px;margin:60px auto;padding:0 20px">' +
                '<h2>面板需要握手 token</h2>' +
                '<p>这不是故障。MindServer 每次启动生成一个新 token，必须带上它才能打开面板。</p>' +
                '<ol><li>打开文件 <code>mindcraft\.mindserver-token</code>，复制里面的值</li>' +
                '<li>访问 <code>http://localhost:' + safePort + '/?token=&lt;那个值&gt;</code></li>' +
                '<li>之后浏览器会把它换成 cookie，整站不再需要带 token</li></ol>' +
                '<p style="color:#666">也可以直接双击 <code>启动面板.bat</code>，它会自动读该文件。</p>' +
                '</body>');
            return;
        }
        res.status(401).type('text/plain; charset=utf-8')
            .send('unauthorized: 需要握手 token。用 `mindcraft/.mindserver-token` 里的值打开 ' +
                  '`http://localhost:<port>/?token=<token>`（浏览器会把它换成 cookie）。');
    });

    // 心跳参数放宽：默认 pingInterval 25s / pingTimeout 20s 对本地回环太紧 ——
    // agent 进程在等模型 API 或跑大段同步代码时，一次 20s 的停顿就会被判掉线，
    // 进而触发断连->重连->超时->杀进程的连锁（实测踩过）。
    io = new Server(server, {
        pingInterval: 25000,
        pingTimeout: 60000,
        // 只放本机连接（第一轮审查）：只绑 localhost 挡不住浏览器网页直连 WebSocket，见 local_only.js
        allowRequest: allowLocalOnly,
    });
    // 第一道门：握手 token（第二道是上面的 allowRequest；第三道是事件本身住在 connection 里）
    io.use(makeHandshakeGate(handshakeToken));

    // ── 任务板（M8 B1）─────────────────────────────────────────────────
    //
    // 失败**绝不许**阻止 mindserver 启动：板是可选能力，没有它 agent 照样能聊天/走/挖。
    // 所以整块 try 住，出错就把 board 留成 null，`board:*` 事件自然没人应答
    // （client 侧会收到 ack 超时 → TIMEOUT → agent 保持 board=null 走降级）。
    let boardHandle = null;
    try {
        const board = openBoard();
        if (board.rebuilt) {
            console.log(`[任务板] 库损坏已重建空库${board.backup ? `（坏文件留在 ${board.backup}）` : ''}`);
        }
        // 注册表与参数校验器从 agent 侧借（**同一份**真相：服务端校验和 !do 用的是同一个解析器）
        const reg = compositeRegistry;
        const registry = new Map((reg.SKILL_NAMES ?? []).map((n) => [n, reg.getSkill(n)?.manifest ?? {}]));
        boardHandle = attachBoardServer({
            io,
            db: board.db,
            registry,
            validateArgs: (skill, args) => {
                const manifest = reg.getSkill(skill)?.manifest;
                if (!manifest) return { ok: false, error: `没有叫 ${skill} 的技能` };
                // args 可能是对象（上层已解析）或字符串（直接来的）——统一走 parseSkillArgs
                const parsed = reg.parseSkillArgs(manifest, typeof args === 'string' ? args : toArgString(args));
                return parsed.ok ? { ok: true, args: parsed.args } : { ok: false, error: parsed.error };
            },
        });
        console.log(`[任务板] 已启用（${registry.size} 个技能可派单，库 ${board.path}）`);
    } catch (e) {
        // ★★★ T30 第3条：这里**必须说清"库文件还在"**。
        //   以前 `openBoard` 把任何异常都当库损坏 → 改名/删除后建空库，日志只写
        //   "库损坏已重建空库"；于是"另一个进程持锁 10 秒"这种**可恢复**的问题
        //   会静默变成"工单全丢"。判据收窄后走到这里 = **没有动过任何文件**。
        console.log(`[任务板] 板起不来（库文件原样保留，未改名/未删除）`
            + `，按"没有板"继续：${String(e?.message ?? e).slice(0, 160)}`);
    }

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    // F-WEB-202：贴图代理的在飞请求上限（模块级，跨请求共享）
    const TEX_INFLIGHT_MAX = 4;
    let TEX_INFLIGHT = 0;
    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            // F-SEC-104（2026-11-06）：路由参数经 Express decodeURIComponent 后可以是
            // `..%2f..%2fsettings` ⇒ `path.join(base,'items','../../settings.png')` 会跳出
            // assets.directory（只能读到 .png，但仍是任意 png 读取 + 存在性探测）。
            // 资源名合法字符集本就只有 [a-z0-9_]（物品/方块名），用白名单一刀切。
            // 注意：这条是**不需要认证的 HTTP 端**（io.use 的握手门只管 socket.io，见 F-SEC-104 证据）。
            if (!/^[a-z0-9_]{1,64}$/.test(itemName)) {
                res.status(400).json({ ok: false, error: 'invalid texture name' });
                return;
            }
            const conn = agent_connections[agentName];
            // ★ F-WEB-202（2026-11-06）：这个路由每次请求都要 import('minecraft-assets') + 建资源索引
            // + readFileSync，侦察席实测"合法名与穿越名都 10s 打满不返回，CLOSE_WAIT 堆积"。
            // F-WEB-201 的 HTTP token 门已经把"任意网页 <img> 反复触发"这条外部向量关掉了；
            // 这里再补一道**并发上限**（防同一客户端/面板刷爆 + 防自己把自己堵死）：
            // 用 res 的 finish/close 回收计数，不需要重构 handler 的控制流。
            if (TEX_INFLIGHT >= TEX_INFLIGHT_MAX) {
                res.status(503).json({ ok: false, error: 'texture proxy busy, retry later' });
                return;
            }
            TEX_INFLIGHT++;
            {
                let released = false;
                const release = () => { if (!released) { released = true; TEX_INFLIGHT--; } };
                res.on('finish', release);
                res.on('close', release);
            }
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.8');

            // Lazy import to avoid ESM/CJS conflicts
            const mod = await import('minecraft-assets');
            const mcAssetsFactory = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets = mcAssetsFactory(ver);
                    // Prefer items path first, then blocks
                    const item = assets.items[itemName];
                    const block = assets.blocks[itemName];
                    const tex = assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex) {
                        // textureContent already provides a data URL in many versions
                        if (tex.startsWith('data:image')) {
                            const base64 = tex.split(',')[1];
                            const img = globalThis.Buffer.from(base64, 'base64');
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(img);
                        }
                    }
                    // If textureContent missing, try static path resolution inside package
                    // Helps with some strange blocks like Leaf Litter
                    const guessPaths = [];
                    const base = assets.directory;
                    guessPaths.push(path.join(base, 'items', `${itemName}.png`));
                    guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
                    for (const p of guessPaths) {
                        try {
                            const fsMod = await import('fs');
                            const buf = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(buf);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // Not found, fallback svg
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch (e) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // 新版控制台（web/ 用 Vue3 + Vite 构建）。存在才挂，缺了不影响旧面板。
    const webDist = path.join(__dirname, '../../../web/dist');
    if (existsSync(webDist)) {
        app.use('/console', express.static(webDist));
        // SPA fallback：/console/terrain 这类前端路由都回 index.html
        app.get(['/console', '/console/*'], (req, res) => {
            res.sendFile(path.join(webDist, 'index.html'));
        });
        console.log(`Console UI mounted at http://localhost:${port || 8080}/console`);
    }

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        // ---- 配置向导：profile 列表 / 读取（纯文件操作，不涉及 agent）----
        const profilesDir = path.join(__dirname, '../../profiles');

        socket.on('get-profiles', (callback) => {
            try {
                if (!existsSync(profilesDir)) { callback({ ok: false, reason: 'profiles 目录不存在' }); return; }
                const out = [];
                for (const f of readdirSync(profilesDir)) {
                    if (!f.endsWith('.json')) continue;
                    const full = path.join(profilesDir, f);
                    try {
                        const j = JSON.parse(readFileSync(full, 'utf8'));
                        const model = typeof j.model === 'object' && j.model ? (j.model.model || JSON.stringify(j.model)) : j.model;
                        out.push({
                            file: f,
            // F-WEB-204：只回相对名，不回本机绝对路径（带用户名/目录结构 = 前置侦察件）
                            path: path.basename(full),
                            name: j.name || null,
                            api: j.api || null,
                            model: model || null,
                            url: j.url || (typeof j.model === 'object' ? j.model?.url : null) || null,
                            bytes: readFileSync(full, 'utf8').length,
                        });
                    } catch (e) {
                        out.push({ file: f, path: path.basename(full), error: '解析失败: ' + (e.message || e) });
                    }
                }
                out.sort((a, b) => a.file.localeCompare(b.file));
                callback({ ok: true, dir: profilesDir, profiles: out });
            } catch (e) {
                callback({ ok: false, reason: String(e && e.message || e) });
            }
        });

        // 读单个 profile 全文（前端"选 profile 即填表单/创建 agent"要用）
        socket.on('get-profile', (file, callback) => {
            if (typeof file === 'function') { callback = file; file = ''; }
            try {
                const safe = path.basename(String(file || ''));       // 防目录穿越
                const full = path.join(profilesDir, safe);
                if (!existsSync(full)) { callback({ ok: false, reason: 'profile 不存在: ' + safe }); return; }
                const raw = readFileSync(full, 'utf8');
                callback({ ok: true, file: safe, path: path.basename(full), raw, json: JSON.parse(raw) });
            } catch (e) {
                callback({ ok: false, reason: String(e && e.message || e) });
            }
        });

        // ---- 配置向导：paper 服务进程管理 ----
        socket.on('server-status', async (callback) => {
            try { callback(await procCtrl.getStatus()); }
            catch (e) { callback({ ok: false, reason: String(e && e.message || e) }); }
        });

        socket.on('server-start', async (callback) => {
            try { callback(await procCtrl.startServer()); }
            catch (e) { callback({ ok: false, reason: String(e && e.message || e) }); }
        });

        socket.on('server-stop', async (callback) => {
            try { callback(await procCtrl.stopServer()); }
            catch (e) { callback({ ok: false, reason: String(e && e.message || e) }); }
        });

        socket.on('server-log', (n, callback) => {
            if (typeof n === 'function') { callback = n; n = 80; }
            try { callback({ ok: true, lines: procCtrl.tailLog(n) }); }
            catch (e) { callback({ ok: false, reason: String(e && e.message || e) }); }
        });

        socket.on('create-agent', async (settings, callback) => {            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                // 第2条：名字**先用同一份规则校验**，再往下走。
                // 原来这里只查重不查格式，名字一路拼到 prompter.js 的 `./bots/<name>` 上，
                // 而 agent 侧的 validateNameFormat 要晚 58 行才跑 —— 文件早写出去了。
                // 复用 agent 侧那一份（connection_handler.js:87），规则只能有一个真相。
                const nameCheck = validateNameFormat(settings.profile.name);
                if (!nameCheck.success) {
                    console.warn(`[mindserver] create-agent 拒绝非法 profile.name: ${JSON.stringify(settings.profile.name)}`);
                    callback({ success: false, error: nameCheck.msg });
                    return;
                }
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            // 停掉的 agent socket 为 null，原来直接 .socket.emit 会让 mindserver 崩（同 D25）
            if (!agent_connections[agentName]?.socket) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        // 第1条 ②：运行期设置只走白名单。allow_insecure_coding（= 远程开代码执行 = 本机 root）、
        // blocked_actions（清空即可放出 !newAction 等被封命令）、profile（里面是 owner 名单）
        // 一律丢弃并告警，不再「照存 + 重启生效」。
        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (!agent) return;
            const { settings: safe, dropped } = sanitizeAgentSettings(settings);
            if (dropped.length) {
                console.warn(`[mindserver] set-agent-settings 丢弃非白名单字段（${agentName}）: ${dropped.join(', ')}`);
            }
            if (Object.keys(safe).length === 0) return;
            // 保留已有字段，只覆盖白名单里给到的键（原来整份替换会把没发的字段抹成 undefined）
            agent.setSettings({ ...agent.settings, ...safe });
            // 停着的 agent 没有 socket：设置照存，下次启动生效（同 D25）
            agent.socket?.emit('restart-agent');
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            // D25：停掉的 agent socket 为 null（面板上重启按钮仍可点），原来这里直接崩掉整个 mindserver
            const conn = agent_connections[agentName];
            if (!conn?.socket) {
                console.warn(`Agent ${agentName} is not running, cannot restart`);
                return;
            }
            conn.socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                globalThis.process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
			}
			// 第1条 ①：这条通路决定了「谁在说话」→ 权限等级，所以它必须落在握手门后。
			// 门在 io.use(makeHandshakeGate)（见 createMindServer 顶部）：没 token 的连接
			// 根本进不到 io.on('connection')，也就没有这个处理器。
			// 另外补一条形状校验：from 必须是短字符串，别让对象/超长串进到 agent 侧的等级计算。
			// ★ F-WEB-203（2026-11-06）：过去 send-message 只校验 data.from 的形状，不限制
			// message 长度与调用频率；叠加 settings.max_commands=-1（→Infinity）与按量计费
			// ⇒ 单连接就能刷爆 token 并把上下文挤出。两道内存闸（不引依赖）：
			//   ① 单条 ≤ 2000 字符；② 每连接 30 条 / 10 秒（令牌桶，按时间回填）。
			if (typeof data?.message === 'string' && data.message.length > 2000) {
				console.warn(`[mindserver] 拒绝 send-message：message 过长（${data.message.length} > 2000）`);
				return;
			}
			{
				// F-WEB-203 补修（复核席指出）：桶原本挂在 socket.data 上 ⇒ **断开重连即重置**，
				// 可以无限绕过。改为按远端地址计数（跨连接共享），并做容量上限防 Map 无限增长。
				const now = Date.now();
				const rlKey = String(socket.handshake?.address || socket.conn?.remoteAddress || 'unknown');
				// 注意（复核席 review-captain-fixes）：本仓只绑 localhost，handshake.address 只可能是
				// 127.0.0.1 或 ::1 ⇒ key 最多 2 个，永远到不了这个阈值。此分支实际防的是
				// **将来放开绑定后的长期累积**，不是"无限增长"。注释如实写清，别让人以为这里挡着什么。
				if (RATE_BUCKETS.size > 512) {
					for (const [k, v] of RATE_BUCKETS) { if (now - v.ts > 60000) RATE_BUCKETS.delete(k); }
				}
				let rl = RATE_BUCKETS.get(rlKey);
				if (!rl) { rl = { tokens: 30, ts: now }; RATE_BUCKETS.set(rlKey, rl); }
				rl.tokens = Math.min(30, rl.tokens + ((now - rl.ts) / 10000) * 30);
				rl.ts = now;
				if (rl.tokens < 1) {
					console.warn(`[mindserver] 拒绝 send-message：触发限流（30 条/10 秒/来源 ${rlKey}）`);
					return;
				}
				rl.tokens -= 1;
			}
			if (!data || typeof data.from !== 'string' || !data.from || data.from.length > 32) {
				console.warn(`[mindserver] 拒绝 send-message：from 非法（${JSON.stringify(data?.from ?? null)}）`);
				return;
			}
			try {
                agent_connections[agentName].socket.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            // ★ F-WEB-101（2026-11-06）：过去这里原样 io.emit 转发，不校验发送方 ⇒
            // 任何持 token 的面板客户端都能伪造"某个 bot 说了某句话"，把排障日志污染成假象。
            // 只有 **agent 自己的连接** 有权发这两类事件：agent 走 `auth:{token}`（见 mindserver_proxy），
            // 面板走 HttpOnly cookie（web/src/api/socket.ts 不带 auth payload）⇒ 两者可区分。
            if (!(typeof socket.handshake?.auth?.token === 'string' && socket.handshake.auth.token === handshakeToken)) {
                console.warn(`[mindserver] 丢弃伪造的 bot-output：连接未以 agent 身份（auth.token）互联，声称 agent=${JSON.stringify(agentName)}`);
                return;
            }
            io.emit('bot-output', agentName, message);
        });

        // agent 进程把结构化事件推上来 → 广播给所有面板（诊断页的事件流）
        socket.on('agent-event', (agentName, e) => {
            // ★ F-WEB-101：同 bot-output —— 只有 agent 自己的连接能发结构化事件，
            // 否则面板客户端可以伪造"挖矿失败/离线/单子卡住"这类诊断事件，误导排障。
            if (!(typeof socket.handshake?.auth?.token === 'string' && socket.handshake.auth.token === handshakeToken)) {
                console.warn(`[mindserver] 丢弃伪造的 agent-event：连接未以 agent 身份互联，声称 agent=${JSON.stringify(agentName)}`);
                return;
            }
            io.emit('agent-event', agentName, e);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
        // 第1条 ①：token 必须让人拿得到 —— 否则正常用户会被自己的门挡在外面。
        // F-SEC-205：但**不能无条件写进 stdout**（start-panel.ps1 把它重定向进 logs/，等于落盘）。
        // 默认只打印指纹 + 取用位置；完整值在 `.mindserver-token` / MINDSERVER_TOKEN，
        // 或显式 `MINDSERVER_PRINT_TOKEN=1` 打开（调试用，会进日志，用完请关掉）。
        const tokenHint = `${handshakeToken.slice(0, 4)}…${handshakeToken.slice(-4)}(len=${handshakeToken.length})`;
        console.log(`[mindserver] 握手 token 已生成: ${tokenHint}`);
        console.log(`[mindserver] 完整 token 位置: ${TOKEN_FILE}（或环境变量 MINDSERVER_TOKEN）`);
        console.log(`[mindserver] 控制台地址: http://${host}:${port}/?token=<见上>`);
        // ★ F-RT-002（2026-11-06，红队复测）：`MINDSERVER_PRINT_TOKEN=1` 曾被 start.bat 当"找不到 token
        // 就照这个做"推荐给用户 —— 而 start-panel.ps1 把 stdout 重定向进 logs\mindcraft-console.log，
        // Start-Process 又继承父环境 ⇒ 用户一照做，完整 token 就进日志，F-SEC-205 原样复活。
        // 修法：**stdout 是文件（被重定向）时，忽略这个开关**，并明确解释为什么忽略。
        // 只有真正的交互终端（isTTY / 非文件）才允许把完整值打出来。
        if (process.env.MINDSERVER_PRINT_TOKEN === '1') {
            let stdoutIsFile = false;
            try { stdoutIsFile = fstatSync(1).isFile(); } catch { /* 取不到就当不是文件 */ }
            if (stdoutIsFile || !process.stdout.isTTY) {
                console.warn('[mindserver] 忽略 MINDSERVER_PRINT_TOKEN：stdout 不是交互终端（很可能被重定向进日志）。');
                console.warn('           完整 token 请读 .mindserver-token 文件；这样不会把 token 落盘。');
            } else {
                console.log(`[mindserver] ★ 调试模式（MINDSERVER_PRINT_TOKEN=1）完整值: ${handshakeToken}`);
                console.log(`[mindserver] ★ 可直接打开: http://${host}:${port}/?token=${handshakeToken}`);
            }
        }
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    registerMapRelay(listener_socket);   // 地图按需拉取，不进每秒 state-update
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        // 第一轮审查：原来没有超时 —— 一个 agent 卡住（等模型 API / 跑大段同步代码），
        // 所有面板的状态一起停，而且每秒再叠一个永远不 resolve 的 Promise。
        // 现在：单个 agent 5 秒没回就沿用它上一次的状态（新面板 StatusCard 读 `s?.gameplay.health`，
        // 收到 { error } 会渲染报错，所以超时不发 error）；上一轮还没跑完就跳过这一轮。
        let polling = false;
        listenerInterval = setInterval(async () => {
            if (polling) return;
            polling = true;
            try {
                const states = {};
                for (let agentName in agent_connections) {
                    let agent = agent_connections[agentName];
                    if (agent.in_game) {
                        try {
                            const state = await new Promise((resolve, reject) => {
                                const timer = setTimeout(() => reject(new Error('state timeout')), 5000);
                                agent.socket.emit('get-full-state', (s) => { clearTimeout(timer); resolve(s); });
                            });
                            agent.last_state = state;
                            states[agentName] = state;
                        } catch (e) {
                            states[agentName] = (String(e?.message) === 'state timeout' && agent.last_state)
                                ? agent.last_state
                                : { error: String(e) };
                        }
                    }
                }
                for (let listener of agent_listeners) {
                    listener.emit('state-update', states);
                }
            } finally {
                polling = false;
            }
        }, 1000);
    }
}

// 前端按需请求某只 bot 的地图（低频，不进每秒的 state-update）
function registerMapRelay(socket) {
    socket.on('request-map', async (agentName, opts, callback) => {
        if (typeof opts === 'function') { callback = opts; opts = {}; }
        const agent = agent_connections[agentName];
        if (!agent || !agent.in_game) {
            callback({ ok: false, reason: 'agent_not_in_game' });
            return;
        }
        try {
            const map = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('map timeout')), 8000);
                agent.socket.emit('get-map', opts || {}, (m) => { clearTimeout(timer); resolve(m); });
            });
            callback(map);
        } catch (e) {
            callback({ ok: false, reason: String(e && e.message || e) });
        }
    });

    // 3D 地形按需拉取（terrain3d.db 要扫库，给足超时；同样不进每秒 state-update）
    socket.on('request-terrain', async (agentName, opts, callback) => {
        if (typeof opts === 'function') { callback = opts; opts = {}; }
        const agent = agent_connections[agentName];
        if (!agent || !agent.in_game) {
            callback({ ok: false, reason: 'agent_not_in_game' });
            return;
        }
        try {
            const terrain = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('terrain timeout')), 30000);
                agent.socket.emit('get-terrain', opts || {}, (t) => { clearTimeout(timer); resolve(t); });
            });
            callback(terrain);
        } catch (e) {
            callback({ ok: false, reason: String(e && e.message || e) });
        }
    });

    // 诊断面板：事件流 / 任务状态 / 记忆（都是按需 ack，不进 1 Hz 状态流）
    const diagRelay = (event, timeoutMs, buildArgs) => {
        socket.on(event, async (agentName, ...rest) => {
            // 最后一个参数是 ack 回调
            const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : () => { };
            const agent = agent_connections[agentName];
            if (!agent || !agent.in_game) {
                callback({ ok: false, reason: 'agent_not_in_game' });
                return;
            }
            try {
                const payload = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error(event + ' timeout')), timeoutMs);
                    agent.socket.emit(event, ...buildArgs(rest), (r) => { clearTimeout(timer); resolve(r); });
                });
                callback(payload);
            } catch (e) {
                callback({ ok: false, reason: String(e && e.message || e) });
            }
        });
    };

    diagRelay('get-events', 8000, (rest) => [rest[0] ?? 0]);   // (sinceSeq)
    diagRelay('clear-events', 8000, () => []);                 // ()
    diagRelay('get-task-state', 15000, () => []);              // ()
    diagRelay('get-memory', 8000, () => []);                   // ()
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
/**
 * 把 `{count: 4, block: 'oak_log'}` 转回 `count=4 block=oak_log`。
 *
 * 为什么绕一圈：服务端要复用 **agent 侧同一个** `parseSkillArgs`（参数规则只有一个真相）。
 * 但那个解析器的入参是字符串，而 socket 传过来的可能是对象 —— 转一下，别为对象再写一份校验。
 */
function toArgString(args) {
    if (args == null || typeof args !== 'object') return '';
    return Object.entries(args)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
        .join(' ');
}

export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;