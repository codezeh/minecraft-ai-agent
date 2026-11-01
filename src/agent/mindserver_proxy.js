import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { mapDirOf } from './library/bot_paths.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';
import { since as traceSince, stats as traceStats, clear as traceClear, onPush as traceOnPush } from './library/trace_bus.js';
import { startLoopLagWatch, describeLoopLag } from '../utils/loop_lag.js';

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        this.agents = [];
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        
        this.name = name;
        // socket.io 默认配置在本地连接上偏脆：
        //  - 默认 transports=['polling','websocket']，先长轮询再升级，多一层不必要的故障面
        //  - 默认 pingTimeout=20s、连接 timeout=20s，进程稍有停顿就判死
        // 实测踩过：等模型 API 期间 ping timeout -> 断连 -> 每次重连又各超时 20s
        // -> 30s 宽限期根本不够 -> cleanKill -> 进程 exit 1 -> 被当成崩溃重启。
        // 本地回环没必要走 polling，直接 websocket，并把超时放宽。
        this.socket = io(`http://localhost:${port}`, {
            transports: ['websocket'],
            pingInterval: 25000,
            pingTimeout: 60000,
            timeout: 30000,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            reconnectionDelayMax: 3000,
        });

        let settled = false;
        await new Promise((resolve, reject) => {
            this.socket.on('connect', () => { if (!settled) { settled = true; resolve(); } });
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err.message);
                // 首连失败才算致命；连上之后的偶发 connect_error 交给自动重连，
                // 不能在这里 reject（那个 Promise 早就 settle 了，reject 是无效操作且误导日志）
                if (!settled) { settled = true; reject(err); }
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');
        // 开始量事件循环延迟：万一以后掉线，日志能说清是不是主线程被卡住
        startLoopLagWatch();

        this.socket.on('disconnect', (reason) => {
            console.log('Disconnected from MindServer:', reason);
            // 把当时的事件循环延迟一并打出来：下次再掉线就能区分
            // "主线程被卡住导致心跳发不出" 还是 "网络/上游 API 慢"。
            console.log(`[disconnect-diag] ${describeLoopLag()}`);
            this.connected = false;
            if (!this.agent) return;
            // 原来是立刻 cleanKill 杀掉 agent 进程。
            // 但 socket.io 本身会自动重连，一次瞬断（ping timeout / 传输抖动）
            // 就把 bot 弄下线，玩家那边看到的就是"她说 Exiting. 然后不见了"。
            // 宽限期 30s -> 120s：默认每次重连尝试要等 20s 超时，30s 只够 1.5 次，
            // 实测就是卡在这个边界上被杀的。120s 给足 5-6 次尝试机会。
            if (this._killTimer) return;
            this._killTimer = setTimeout(() => {
                this._killTimer = null;
                if (!this.connected) {
                    this.agent.cleanKill('Disconnected from MindServer. Killing agent process.');
                }
            }, 120000);
        });

        // 重连成功时（首次 connect 已在上面的 Promise 里处理过，这里只会是重连）
        this.socket.on('connect', () => {
            if (this.connected) return;
            this.connected = true;
            if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
            console.log('Reconnected to MindServer, re-registering agent...');
            this.socket.emit('get-settings', this.name, (response) => {
                if (response?.error) { console.error('Re-register failed:', response.error); return; }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', this.name);
                this.login();
                console.log('Agent re-registered after reconnect.');
            });
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        // 地图按需拉取（surveyArea 要 200~350ms，不能塞进每秒一次的状态里）。
        // 返回 renderAscii 的字符网格 + 色阶信息，前端把它渲染成彩色格子。
        this.socket.on('get-map', (opts, callback) => {
            // 允许两种调用方式：get-map(cb) 或 get-map(opts, cb)
            if (typeof opts === 'function') { callback = opts; opts = {}; }
            (async () => {
                try {
                    const skills = await import('./library/skills.js');
                    const radius = Math.min(Math.max(opts?.radius ?? 64, 16), 128);
                    const r = skills.surveyArea(this.agent.bot, radius);
                    // 注意：surveyArea 的 ascii 是**字符串**（整个网格），
                    // blockSize / extent / legend 都在顶层，不在 ascii 里面。
                    callback(r && r.ok
                        ? { ok: true, ascii: r.ascii, legend: r.legend, style: r.style,
                            blockSize: r.blockSize, extent: r.extent,
                            position: r.position, facing: r.facing, summary: r.summary }
                        : { ok: false, reason: r?.reason || 'survey_failed' });
                } catch (err) {
                    callback({ ok: false, reason: String(err && err.message || err) });
                }
            })();
        });

        // 3D 地形按需拉取（terrain3d.db）。与 request-map 同思路：不进 1 Hz 状态流。
        // 返回：bbox + 相对 origin 的整型坐标 + 类型码 + 失败点。
        // mode='around' 以她为中心取半径；mode='full' 取全库。
        this.socket.on('get-terrain', async (opts, callback) => {
            if (typeof opts === 'function') { callback = opts; opts = {}; }
            const t0 = Date.now();
            try {
                const bot = this.agent?.bot;
                if (!bot?.entity) { callback({ ok: false, reason: 'bot_not_spawned' }); return; }

                const { boxSurfaces, readFails } = await import('./library/terrain3d.js');
                const mapDir = mapDirOf(bot);
                const p = bot.entity.position;
                const mode = opts?.mode === 'full' ? 'full' : 'around';
                const lod = Math.min(Math.max(Number(opts?.lod) || 1, 1), 8);
                const radius = Math.min(Math.max(Number(opts?.radius) || 48, 8), 256);

                let x0, z0, x1, z1;
                if (mode === 'full') {
                    // 全库：范围给足，SQLite 走 (x,z,y) 主键范围扫描
                    x0 = -30000; z0 = -30000; x1 = 30000; z1 = 30000;
                } else {
                    const cx = Math.floor(p.x), cz = Math.floor(p.z);
                    x0 = cx - radius; x1 = cx + radius;
                    z0 = cz - radius; z1 = cz + radius;
                }

                const rows = boxSurfaces(mapDir, x0, z0, x1, z1, -64, 320);
                if (!rows.length) { callback({ ok: false, reason: 'no_terrain_data' }); return; }

                // bbox 用**全量行**算，保证加了 lod 之后取景范围不跳
                let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
                let by0 = Infinity, by1 = -Infinity;
                for (const r of rows) {
                    if (r.x < bx0) bx0 = r.x; if (r.x > bx1) bx1 = r.x;
                    if (r.z < bz0) bz0 = r.z; if (r.z > bz1) bz1 = r.z;
                    if (r.y < by0) by0 = r.y; if (r.y > by1) by1 = r.y;
                }

                // 坐标跨度决定整型宽度，避免 Int16 溢出（全图模式跨度可能很大）
                const spanMax = Math.max(bx1 - bx0, bz1 - bz0, by1 - by0);
                const dtype = spanMax < 32760 ? 'int16' : 'int32';
                const keep = [];
                for (const r of rows) {
                    // LOD 只按 (x,z) 取样，保留该列**所有** y —— 垂直细节不能丢
                    if ((r.x - bx0) % lod !== 0 || (r.z - bz0) % lod !== 0) continue;
                    keep.push(r);
                }

                const n = keep.length;
                const pos = dtype === 'int16' ? new Int16Array(n * 3) : new Int32Array(n * 3);
                const types = new Uint8Array(n);
                for (let i = 0; i < n; i++) {
                    const r = keep[i];
                    pos[i * 3] = r.x - bx0;
                    pos[i * 3 + 1] = r.y - by0;
                    pos[i * 3 + 2] = r.z - bz0;
                    types[i] = r.t;
                }

                // 失败点：只取落在本次范围里的，最多 3000 个。
                // readFails 默认有 10 分钟 TTL（那是给寻路用的），
                // 诊断可视化要看历史全量，所以显式 ttlMs=Infinity。
                // 返回是 Map<"x,y,z", hits>，键要拆开。
                let fails = [];
                try {
                    const fm = readFails(mapDir, { ttlMs: Infinity }) || new Map();
                    for (const [k, hits] of fm) {
                        const [fx, fy, fz] = k.split(',').map(Number);
                        if (fx < bx0 || fx > bx1 || fz < bz0 || fz > bz1) continue;
                        fails.push({ x: fx, y: fy, z: fz, hits: hits || 1 });
                        if (fails.length >= 3000) break;
                    }
                } catch (_) { /* 失败点拿不到不影响主功能 */ }

                callback({
                    ok: true,
                    mode,
                    lod,
                    bbox: { x0: bx0, x1: bx1, z0: bz0, z1: bz1, y0: by0, y1: by1 },
                    origin: [bx0, by0, bz0],
                    dtype,
                    count: n,
                    pos: Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength).toString('base64'),
                    types: Buffer.from(types.buffer, types.byteOffset, types.byteLength).toString('base64'),
                    fails,
                    ms: Date.now() - t0,
                });
            } catch (error) {
                callback({ ok: false, reason: String(error && error.message || error) });
            }
        });

        this.socket.on('get-full-state', (callback) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        // ---- 诊断面板：事件流 / 任务状态 / 记忆 ----

        // 事件流：增量拉取 + 实时推送
        this.socket.on('get-events', (sinceSeq, callback) => {
            if (typeof sinceSeq === 'function') { callback = sinceSeq; sinceSeq = 0; }
            try {
                callback({ ok: true, events: traceSince(sinceSeq || 0), stats: traceStats() });
            } catch (e) {
                callback({ ok: false, reason: String(e && e.message || e) });
            }
        });

        this.socket.on('clear-events', (callback) => {
            try { traceClear(); callback?.({ ok: true }); } catch (e) { callback?.({ ok: false }); }
        });

        // 新事件实时转发给 mindserver（由它广播给所有面板）
        traceOnPush((e) => {
            try {
                if (this.socket && this.socket.connected) {
                    this.socket.emit('agent-event', this.agent?.name || 'agent', e);
                }
            } catch { /* 推送失败不影响主链路 */ }
        });

        // 任务/运行时状态（面板"她现在在干什么、任务库多大、有多少有效失败点"）
        this.socket.on('get-task-state', async (callback) => {
            try {
                const agent = this.agent;
                const bot = agent?.bot;
                if (!bot?.entity) { callback({ ok: false, reason: 'bot_not_spawned' }); return; }
                const mapDir = mapDirOf(bot);

                let store = null;
                let activeFails = 0;
                try {
                    const t3 = await import('./library/terrain3d.js');
                    store = t3.stats3d(mapDir);                 // {cells, chunks}
                    activeFails = (t3.readFails(mapDir) || new Map()).size;  // 默认 10 分钟 TTL
                } catch { /* 地形库读不到不影响其它字段 */ }

                const sp = agent.self_prompter;
                callback({
                    ok: true,
                    name: agent.name,
                    action: {
                        current: agent.actions?.currentActionLabel || '',
                        isIdle: agent.isIdle ? agent.isIdle() : null,
                        executing: !!agent.actions?.executing,
                    },
                    selfPrompter: {
                        stopped: sp?.isStopped ? sp.isStopped() : null,
                        paused: sp?.isPaused ? sp.isPaused() : null,
                        active: sp?.isActive ? sp.isActive() : null,
                        loopActive: sp?.loop_active ?? null,
                    },
                    task: agent.task ? { present: true, name: agent.task.task_id || null } : { present: false },
                    modes: (bot.modes && bot.modes.getMiniDocs) ? bot.modes.getMiniDocs() : '',
                    store,
                    activeFails,
                    events: traceStats(),
                });
            } catch (e) {
                callback({ ok: false, reason: String(e && e.message || e) });
            }
        });

        // 记忆：只看摘要（memory 正文 + 版本），不把整份 turns 推给前端
        this.socket.on('get-memory', async (callback) => {
            try {
                const bot = this.agent?.bot;
                const name = bot?.username || bot?.entity?.name || this.agent?.name || 'agent';
                const fs = await import('fs');
                const p = `./bots/${name}/memory.json`;
                if (!fs.existsSync(p)) { callback({ ok: false, reason: 'memory_not_found', path: p }); return; }
                const raw = fs.readFileSync(p, 'utf8');
                let j = null;
                try { j = JSON.parse(raw); } catch { /* 坏 JSON 也要能看 */ }
                callback({
                    ok: true,
                    path: p,
                    bytes: raw.length,
                    codeVersion: j?.codeVersion ?? null,
                    memory: typeof j?.memory === 'string' ? j.memory.slice(0, 8000) : null,
                    turns: Array.isArray(j?.turns) ? j.turns.length : 0,
                });
            } catch (e) {
                callback({ ok: false, reason: String(e && e.message || e) });
            }
        });

        // Request settings and wait for response
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for chatting with other bots
export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
export function sendOutputToServer(agentName, message) {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}
