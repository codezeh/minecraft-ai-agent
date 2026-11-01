import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import * as procCtrl from './proc_control.js';
import { allowLocalOnly } from './local_only.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

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
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    // 心跳参数放宽：默认 pingInterval 25s / pingTimeout 20s 对本地回环太紧 ——
    // agent 进程在等模型 API 或跑大段同步代码时，一次 20s 的停顿就会被判掉线，
    // 进而触发断连->重连->超时->杀进程的连锁（实测踩过）。
    io = new Server(server, {
        pingInterval: 25000,
        pingTimeout: 60000,
        // 只放本机连接（第一轮审查）：只绑 localhost 挡不住浏览器网页直连 WebSocket，见 local_only.js
        allowRequest: allowLocalOnly,
    });

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            const conn = agent_connections[agentName];
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
                            path: full,
                            name: j.name || null,
                            api: j.api || null,
                            model: model || null,
                            url: j.url || (typeof j.model === 'object' ? j.model?.url : null) || null,
                            bytes: readFileSync(full, 'utf8').length,
                        });
                    } catch (e) {
                        out.push({ file: f, path: full, error: '解析失败: ' + (e.message || e) });
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
                callback({ ok: true, file: safe, path: full, raw, json: JSON.parse(raw) });
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

        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (agent) {
                agent.setSettings(settings);
                // 停着的 agent 没有 socket：设置照存，下次启动生效（同 D25）
                agent.socket?.emit('restart-agent');
            }
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
			try {
                agent_connections[agentName].socket.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        // agent 进程把结构化事件推上来 → 广播给所有面板（诊断页的事件流）
        socket.on('agent-event', (agentName, e) => {
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
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;