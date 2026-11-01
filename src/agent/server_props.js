/**
 * server.properties 读取 —— RCON 凭据的**唯一来源**（M1 安全，09 §4）。
 *
 * 为什么需要（第一轮安全审查的结论）：
 *   原来 RCON 密码 `localdev` + 端口写死在 `library/rcon_client.js` 和 5 个 tools 脚本里，
 *   已经推到 GitHub 了。等于「谁看仓库谁知道我服的控制台密码」。
 *   而 `src/mindcraft/proc_control.js` 早就从 server.properties 读了 —— 只是没人复用。
 *
 * 规矩：
 *  1. 密码只在内存里传，**不进日志、不进提交、不在对话里打印**。
 *     要打印配置就调 `describeRconConfig()`（只有 hasPassword，没有明文）。
 *  2. 端口按「谁在听」匹配：主服 25565→25575、测试服 25566→25576，
 *     两个目录各有一份 server.properties，`rconConfigForPort(port)` 按 rcon.port 认领，
 *     不会把主服的密码拿去连测试服。
 *  3. 候选顺序可被环境变量顶掉（临时排查用，不必改代码）：
 *     `MC_SERVER_PROPS`（直接指定文件）、`MC_SERVER_DIR`（指定服务端目录）、
 *     `RCON_PORT` / `RCON_PASSWORD`（旧脚本一直支持 RCON_PASSWORD）。
 *
 * 位置：放 `src/agent/`（不是 `library/`）—— 它不是游戏规则模块，而是进程级配置读取。
 * 同理 `connection_handler.js` / `history.js` / `self_prompter.js` 也在这层。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** mindcraft/src/agent → 上三级 = 项目根（我的世界ai） */
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** 解析用的缓存：{ [file]: { mtimeMs, size, values } } */
const _cache = new Map();

/**
 * 解析 .properties 文本。
 *
 * 注意两点（都是踩过的）：
 *  1. 文件是 CRLF，且**不能拿正则 `^...$` 逐行匹配**（实测键数变 0）；
 *     统一按 indexOf('=') 切最稳（proc_control.js 的现成做法）。
 *  2. 注释行有 `#` 和 `!` 两种前缀。
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseProperties(text) {
    const kv = {};
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        const i = line.indexOf('=');
        if (i < 0) continue;
        kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return kv;
}

/**
 * 候选 server.properties 路径（按优先级）。
 * @param {{root?:string}} [opts]
 * @returns {string[]}
 */
export function serverPropertiesCandidates({ root = PROJECT_ROOT } = {}) {
    const out = [];
    if (process.env.MC_SERVER_PROPS) out.push(path.resolve(process.env.MC_SERVER_PROPS));
    if (process.env.MC_SERVER_DIR) {
        const d = path.resolve(process.env.MC_SERVER_DIR);
        out.push(path.join(d, 'server.properties'), path.join(d, 'config', 'server.properties'));
    }
    // 主服在前（默认目标），测试服在后（tools 按端口认领时才会用到）
    for (const dir of ['server', 'server-test']) {
        out.push(path.join(root, dir, 'server.properties'));
        out.push(path.join(root, dir, 'config', 'server.properties'));
    }
    // 去重（env 可能和默认路径撞上）
    return [...new Set(out)];
}

/**
 * 读一份 server.properties（带 mtime 缓存，文件变了自动重读）。
 * @param {string} file
 * @returns {{file:string, values:Record<string,string>, ok:boolean}}
 */
export function loadServerPropertiesFrom(file) {
    try {
        if (!existsSync(file)) return { file, values: {}, ok: false };
        const st = statSync(file);
        const hit = _cache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
            return { file, values: hit.values, ok: true };
        }
        const values = parseProperties(readFileSync(file, 'utf8'));
        _cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, values });
        return { file, values, ok: true };
    } catch {
        return { file, values: {}, ok: false };
    }
}

/** 第一份读得到的 server.properties（默认主服）。 */
export function loadServerProperties({ root } = {}) {
    for (const file of serverPropertiesCandidates({ root })) {
        const r = loadServerPropertiesFrom(file);
        if (r.ok) return r;
    }
    return { file: null, values: {}, ok: false };
}

/**
 * 把一份 properties 里的 rcon 段落取出来。
 * @returns {{file:string, port:number, password:string, enabled:boolean}}
 */
function rconOf({ file, values }) {
    return {
        file,
        enabled: String(values['enable-rcon'] ?? '').trim().toLowerCase() === 'true',
        port: Number(values['rcon.port']) || 25575,
        password: values['rcon.password'] || '',
    };
}

/**
 * 所有读得到的 server.properties 的 rcon 段落（主服、测试服各一条）。
 * @param {{root?:string}} [opts]
 */
export function loadRconConfigs({ root } = {}) {
    const out = [];
    const seen = new Set();
    for (const file of serverPropertiesCandidates({ root })) {
        const r = loadServerPropertiesFrom(file);
        if (!r.ok || seen.has(r.file)) continue;
        seen.add(r.file);
        out.push(rconOf(r));
    }
    return out;
}

/**
 * 按 RCON 端口认领配置（25575→主服、25576→测试服）。
 * @param {number} port
 * @param {{root?:string}} [opts]
 * @returns {{file:string, port:number, password:string, enabled:boolean}|null}
 */
export function rconConfigForPort(port, { root } = {}) {
    const p = Number(port);
    if (!Number.isFinite(p)) return null;
    return loadRconConfigs({ root }).find(c => Number(c.port) === p) ?? null;
}

/** 默认配置 = 第一份（主服）。 */
export function defaultRconConfig({ root } = {}) {
    return loadRconConfigs({ root })[0] ?? null;
}

/**
 * 日志/面板用的脱敏描述 —— **永不含密码明文**。
 */
export function describeRconConfig(cfg) {
    if (!cfg) return { file: null, enabled: false, port: null, hasPassword: false };
    return {
        file: cfg.file,
        enabled: !!cfg.enabled,
        port: cfg.port ?? null,
        hasPassword: !!cfg.password,
    };
}
