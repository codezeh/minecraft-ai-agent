/**
 * Paper 服务进程管理（给配置向导用）。
 *
 * ★ 2026-10-30 新建。
 *
 * 红线（都是踩过/文档里写死的）：
 *  1. **禁止 blanket kill node/java 进程** —— 这台机器上还跑着用户的 SillyTavern 等进程。
 *     只操作自己 spawn 出来的那个子进程句柄。
 *  2. **停止必须先走 RCON `stop`**，让它自己刷盘关闭；拿不到 RCON 就只报错、不强杀，
 *     否则存档有损坏风险。
 *  3. **起服前先探端口**：25565 已有服务就拒绝启动，避免起第二个服把端口抢崩。
 *  4. 就绪判定认 stdout 里的 `Done (xx.xxxs)!`，不用固定 sleep（冷启动 15s，热启动可能 40s+）。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
// server.properties 的唯一读法（M1，09 §4）
import { loadRconConfigs } from '../agent/server_props.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** mindcraft/src/mindcraft → 上三级 = 项目根（我的世界ai） */
const ROOT = path.resolve(__dirname, '../../..');
const SERVER_DIR = path.join(ROOT, 'server');
const LOG_MAX = 300;

const state = {
    proc: null,
    status: 'stopped',      // stopped | starting | running | stopping
    startedAt: 0,
    readyAt: 0,
    exitCode: null,
    error: '',
    log: [],
    port: 25565,
    rconPort: 25575,
    rconPassword: '',
    /** ★ OPS-008：进行中的启动 Promise（并发启动闸；null = 当前没有启动在进行）。 */
    startingPromise: null,
};

function pushLog(line) {
    const s = String(line).replace(/\r$/, '');
    if (!s) return;
    state.log.push(s);
    if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
    if (/Done \([\d.]+s\)!/.test(s)) {
        state.status = 'running';
        state.readyAt = Date.now();
    }
}

/** 找项目自带的 JDK（.tools/jdk-*），找不到再退回 PATH 里的 java */
function findJava() {
    const tools = path.join(ROOT, '.tools');
    if (existsSync(tools)) {
        for (const d of readdirSync(tools)) {
            if (!/^jdk/i.test(d)) continue;
            for (const exe of ['java.exe', 'java']) {
                const p = path.join(tools, d, 'bin', exe);
                if (existsSync(p)) return p;
            }
        }
    }
    return 'java';
}

function findServerJar() {
    const p = path.join(SERVER_DIR, 'server.jar');
    return existsSync(p) ? p : null;
}

/** 读 server.properties 里的 RCON 配置（Paper 可能放在 server/ 或 server/config/）。
 *
 * ★ 2026-11-01（M1，09 §4）：解析逻辑**收进 src/agent/server_props.js 一份**，
 * 这里只负责按「本面板管着的服务端目录」挑出对应那一条。
 * 原来是本文件自己手写一遍（rcon_client.js 又写死一遍密码），
 * 两份实现迟早对不上 —— 一份数据只有一个读法。
 */
function loadRconConfig() {
    const dirs = [SERVER_DIR, path.join(SERVER_DIR, 'config')];
    const cfgs = loadRconConfigs({ root: ROOT });
    const hit = cfgs.find(c => c.file && dirs.includes(path.dirname(c.file))) ?? cfgs[0];
    return hit ?? { port: 25575, password: '', enabled: false };
}

/** 端口是否有人在听（用来判断服是否已在跑、避免起第二个） */
export function isPortOpen(port = state.port, host = '127.0.0.1', timeoutMs = 800) {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host });
        const done = (v) => { try { sock.destroy(); } catch { } resolve(v); };
        const t = setTimeout(() => done(false), timeoutMs);
        sock.once('connect', () => { clearTimeout(t); done(true); });
        sock.once('error', () => { clearTimeout(t); done(false); });
    });
}

/**
 * 最小 RCON 客户端（协议实现照 tools/rcon.mjs，纯 node:net 无依赖）。
 * 只发一条命令就断开。
 */
export function rcon(command, { host = '127.0.0.1', port = state.rconPort, password = state.rconPassword, timeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        if (!password) { reject(new Error('没有 rcon.password，无法优雅停止')); return; }
        const sock = net.connect(port, host);
        const t = setTimeout(() => { sock.destroy(); reject(new Error('rcon timeout')); }, timeout);
        let buf = Buffer.alloc(0);
        let authed = false;
        const send = (id, type, body) => {
            const b = Buffer.from(body, 'utf8');
            const out = Buffer.alloc(4 + 4 + 4 + b.length + 2);
            out.writeInt32LE(4 + 4 + b.length + 2, 0);
            out.writeInt32LE(id, 4);
            out.writeInt32LE(type, 8);
            b.copy(out, 12);
            sock.write(out);
        };
        sock.on('connect', () => send(1, 3, password));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length < 4) return;
            const len = buf.readInt32LE(0);
            if (buf.length < 4 + len) return;
            const id = buf.readInt32LE(4);
            const body = buf.slice(12, 4 + len - 2).toString('utf8');
            buf = buf.slice(4 + len);
            if (!authed) {
                if (id === -1) { clearTimeout(t); sock.destroy(); reject(new Error('rcon 认证失败')); return; }
                authed = true;
                send(2, 2, command);
                return;
            }
            clearTimeout(t);
            sock.end();
            resolve(body);
        });
        sock.on('error', (e) => { clearTimeout(t); reject(e); });
    });
}

export async function getStatus() {
    const rconCfg = loadRconConfig();
    state.rconPort = rconCfg.port || 25575;
    state.rconPassword = rconCfg.password || '';
    const listening = await isPortOpen();
    return {
        ok: true,
        status: state.status,
        // 端口在听 且 我们没管着进程 → 是外部起的服（start.bat 起的那种）
        listening,
        externallyStarted: listening && !state.proc,
        pid: state.proc?.pid ?? null,
        uptimeMs: state.startedAt ? Date.now() - state.startedAt : 0,
        ready: state.status === 'running',
        exitCode: state.exitCode,
        error: state.error,
        port: state.port,
        rcon: { enabled: !!rconCfg.enabled, port: state.rconPort, hasPassword: !!state.rconPassword },
        serverDir: SERVER_DIR,
        jar: findServerJar(),
        java: findJava(),
    };
}

export async function startServer() {
    if (state.proc) return { ok: false, reason: 'already_started_by_us', hint: '我已经管着一个服了，先停掉再启动' };
    // ★★★ OPS-008（2026-11-06 深度检查）：**并发启动闸**。
    //
    //   缺陷原貌：这个函数的第一件事就是 `await isPortOpen()`。两个面板连接
    //   （或用户快速重复点击）同时进来时，**两次调用都会在这里让出执行权**，
    //   而 `state.proc` 要等 spawn 之后才被赋值 ⇒ 两个都通过检查、各 spawn 一个 Paper
    //   ⇒ 抢同一个世界目录/端口、启动状态互相覆盖，还可能留下孤儿进程。
    //   报告实测：两个 Promise.all 调用得到 spawnCount=2。
    //
    //   修法：**在第一个 await 之前**就同步登记"启动中"，并复用同一个启动 Promise。
    //   第二个调用直接拿到进行中的那个 Promise（不是再起一份）。
    //   释放放在 finally：失败也要放开，否则"启动失败一次 = 永远不能启动"。
    if (state.startingPromise) {
        console.log('[launcher] 已有一次启动在进行中，复用同一个启动流程（不重复 spawn）');
        return await state.startingPromise;
    }
    state.status = 'starting';
    state.startingPromise = _startServerOnce();
    try {
        return await state.startingPromise;
    } finally {
        state.startingPromise = null;
    }
}

/** 真正的启动流程（**只由 startServer 的闸调用**，外部不要直接调）。 */
async function _startServerOnce() {
    if (state.proc) return { ok: false, reason: 'already_started_by_us', hint: '我已经管着一个服了，先停掉再启动' };
    if (await isPortOpen()) {
        return {
            ok: false,
            reason: 'port_in_use',
            hint: `端口 ${state.port} 已经有服务在听（可能是 start.bat 起的）。不重复启动，避免两个服抢端口。`,
        };
    }
    const jar = findServerJar();
    if (!jar) return { ok: false, reason: 'server_jar_missing', hint: `找不到 ${path.join(SERVER_DIR, 'server.jar')}` };
    const java = findJava();

    try {
        const args = ['-Xms1G', '-Xmx2G', '-XX:+UseG1GC', '-jar', 'server.jar', 'nogui'];
        const proc = spawn(java, args, { cwd: SERVER_DIR, windowsHide: true });
        state.proc = proc;
        state.status = 'starting';
        state.startedAt = Date.now();
        state.readyAt = 0;
        state.exitCode = null;
        state.error = '';
        state.log = [];
        pushLog(`[launcher] ${java} ${args.join(' ')}`);
        pushLog(`[launcher] cwd=${SERVER_DIR}`);

        proc.stdout.on('data', (d) => String(d).split('\n').forEach(pushLog));
        proc.stderr.on('data', (d) => String(d).split('\n').forEach(pushLog));
        proc.on('exit', (code, signal) => {
            state.exitCode = code;
            state.status = 'stopped';
            state.proc = null;
            pushLog(`[launcher] 进程退出 code=${code} signal=${signal}`);
        });
        proc.on('error', (e) => {
            state.error = String(e && e.message || e);
            state.status = 'stopped';
            state.proc = null;
            pushLog('[launcher] 启动失败: ' + state.error);
        });
        return { ok: true, pid: proc.pid, java, jar };
    } catch (e) {
        state.status = 'stopped';
        state.error = String(e && e.message || e);
        return { ok: false, reason: 'spawn_failed', hint: state.error };
    }
}

export async function stopServer() {
    const cfg = loadRconConfig();
    state.rconPort = cfg.port || 25575;
    state.rconPassword = cfg.password || '';

    if (!(await isPortOpen())) {
        return { ok: false, reason: 'not_running', hint: '端口没人在听，服本来就没跑' };
    }
    if (!cfg.enabled || !cfg.password) {
        return {
            ok: false,
            reason: 'rcon_disabled',
            hint: 'server.properties 里 enable-rcon/rcon.password 没配好，不敢强杀（会损坏存档）。请手动关服。',
        };
    }
    try {
        state.status = 'stopping';
        const res = await rcon('stop');
        return { ok: true, response: res, hint: '已发出优雅停止指令，等它自己刷盘退出（约 5~15s）' };
    } catch (e) {
        state.status = 'running';
        return { ok: false, reason: 'rcon_failed', hint: String(e && e.message || e) };
    }
}

export function tailLog(n = 80) {
    const k = Math.min(Math.max(Number(n) || 80, 1), LOG_MAX);
    return state.log.slice(-k);
}
