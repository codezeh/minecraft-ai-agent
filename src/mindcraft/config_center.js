/**
 * 设置中心（R5 t28）—— 把散落在三个配置源里的常用项收成一个可读可写的接口。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这一层（而不是让前端直接读文件）：三个源的**生效方式完全不同**，
 * 前端如果自己猜"改完就生效"，用户会以为网络改了、其实还要 apply + 重启服务器。
 * 所以这里除了取值，还要把"这个字段怎么生效"一起提供给面板：
 *
 *   | 组       | 文件                     | 生效方式                          |
 *   |----------|--------------------------|-----------------------------------|
 *   | network  | config/network.json      | 还要 `server-net.mjs apply` + 重启服务器 |
 *   | backup   | config/backup.json       | **立即生效**                      |
 *   | identity | mindcraft/settings.js    | 重启 agent（agent 启动时读 settings） |
 *   | runtime  | mindcraft/settings.js    | 对新起的 agent 生效                |
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 写盘两条铁律（改这里之前先读）：
 *
 *   ① **先备份**：`config/x.json` 与 `settings.js` 改写前都复制成
 *      `<文件>.bak-<YYYYMMDDHHMMSS>`。配置写坏了没有备份 = 用户现场丢失。
 *
 *   ② **settings.js 绝不能 JSON 序列化重写**。它不是数据文件，是**带注释的源码**：
 *      `JSON.parse` 都过不了，`JSON.stringify` 更是把几十行解释性注释全部抹掉
 *      （"为什么默认关 allow_insecure_coding" 那段就是全项目最重要的注释之一）。
 *      所以改成**正则/行级定向替换**：只动 `"key": <literal>` 里的那个 literal，
 *      行尾注释、缩进、其余行一个字节都不碰。写完整文件后再 `import()` 验一次
 *      能不能加载 —— 加载不了就回滚（把备份拷回去）并报 500。
 *
 *   `config/*.json` 是纯数据（有 `_说明` 这类键，但没有注释语法），可以
 *   `JSON.parse` → 只改目标键 → `JSON.stringify(obj, null, 2)`，
 *   因为解析后的对象**包含全部 `_说明` 键**，序列化不会丢内容。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveIdentityPolicy, readServerOnlineMode } from './offline_identity_risk.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** mindcraft/ */
const MC_ROOT = join(HERE, '..', '..');
/** 仓库根（父仓）*/
const REPO_ROOT = join(MC_ROOT, '..');

const NETWORK_PATH = join(REPO_ROOT, 'config', 'network.json');
const BACKUP_PATH = join(REPO_ROOT, 'config', 'backup.json');
const SETTINGS_PATH = join(MC_ROOT, 'settings.js');
const BACKUP_LOG = join(REPO_ROOT, 'logs', 'backup-auto.log');

/** 错误码：调用方只看 code（HTTP 层映射状态码），不解析 message。 */
export const CONFIG_ERROR = Object.freeze({
    BAD_GROUP: 'CONFIG_BAD_GROUP',
    BAD_VALUE: 'CONFIG_BAD_VALUE',
    BAD_JSON: 'CONFIG_BAD_JSON',
    WRITE_FAILED: 'CONFIG_WRITE_FAILED',
    SETTINGS_INVALID: 'CONFIG_SETTINGS_INVALID',
    UNKNOWN_KEY: 'CONFIG_UNKNOWN_KEY',
});

export class ConfigError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'ConfigError';
        this.code = code;
    }
}

/**
 * 「生效方式」元信息 —— **唯一一份真相**，前端与文档都从这里派生。
 *
 * 为什么要把它放进接口而不是写死在 Vue 里：同一句话现在有三个副本
 * （network.json 的 `_说明`、README、面板文案）。改一处忘一处，用户就会
 * "改完以为立刻生效"。这里给一个 id，前端只负责翻译成中文标签。
 */
export const GROUP_META = Object.freeze({
    network: {
        title: '服务器网络与准入',
        source: 'config/network.json',
        apply: 'restart-server',
        applyText: '需重启服务器',
        detail: '保存只改 config/network.json；要让改动进 server.properties，还要跑 '
            + '`node mindcraft/tools/server-net.mjs apply`（会自动备份 server.properties），然后重启服务器。',
        applyCommand: 'node mindcraft/tools/server-net.mjs apply',
    },
    identity: {
        title: '身份与权限',
        source: 'mindcraft/settings.js · identity_binding',
        apply: 'restart-agent',
        applyText: '需重启 agent',
        detail: 'agent 在**启动时**读 settings；改完要重启对应 agent（或 mindserver）才生效。',
    },
    backup: {
        title: '备份',
        source: 'config/backup.json',
        apply: 'immediate',
        applyText: '立即生效',
        detail: '备份逻辑每次触发都会重新读这个文件，改完不需要重启任何东西。',
    },
    runtime: {
        title: '运行时与安全',
        source: 'mindcraft/settings.js（顶层）',
        apply: 'new-agent',
        applyText: '对新启动的 bot 生效',
        detail: '这些键在 agent 启动时被读进内存；已经在跑的 bot 不受影响。',
    },
});

/* ───────────────────────── 校验表（后端才是安全边界）───────────────────────── */

/**
 * 每个可写字段的类型/范围。前端滑块**不是**安全边界 —— 手搓 curl 一样能提交
 * `keep: 999`，所以这里必须再校验一遍，非法值一律 400。
 */
const SCHEMA = {
    network: {
        bind: { kind: 'enum', values: ['localhost', 'all', 'custom'] },
        nic: { kind: 'string', maxLen: 64, pattern: /^[0-9A-Za-z.:_-]*$/ },
        whiteList: { kind: 'bool' },
        enforceWhiteList: { kind: 'bool' },
        onlineMode: { kind: 'bool' },
        players: { kind: 'stringArray', maxItems: 200, itemPattern: /^[A-Za-z0-9_]{1,16}$/ },
    },
    identity: {
        enabled: { kind: 'bool' },
        offline_owner_mode: { kind: 'enum', values: ['session', 'deny'] },
        // 15 分钟步进：不限制步进（否则用户拿到 90 就存不进去会很困惑），但夹在 15~720
        offline_session_minutes: { kind: 'int', min: 15, max: 720, step: 15 },
        code_ttl_ms: { kind: 'int', min: 60_000, max: 3_600_000 },        // 1 分钟 ~ 60 分钟
        binding_ttl_ms: { kind: 'int', min: 86_400_000, max: 31_536_000_000 }, // 1 天 ~ 365 天
    },
    backup: {
        enabled: { kind: 'bool' },
        onServerStop: { kind: 'bool' },
        excludeSecrets: { kind: 'bool' },
        dailyAt: { kind: 'time' },
        keep: { kind: 'int', min: 1, max: 30 },
    },
    runtime: {
        allow_insecure_coding: { kind: 'bool' },
        allow_vision: { kind: 'bool' },
        code_timeout_mins: { kind: 'int', min: 1, max: 120 },
        max_messages: { kind: 'int', min: 10, max: 100 },
        num_examples: { kind: 'int', min: 0, max: 10 },
        spawn_timeout: { kind: 'int', min: 5, max: 300 },
        log_all_prompts: { kind: 'bool' },
        speak: { kind: 'bool' },
        chat_ingame: { kind: 'bool' },
        narrate_behavior: { kind: 'bool' },
        chat_bot_messages: { kind: 'bool' },
    },
};

/** settings.js 里由本模块管理的键（**只**碰这些，其余原样保留）。 */
const SETTINGS_KEYS = {
    identity: ['enabled', 'offline_owner_mode', 'offline_session_minutes', 'code_ttl_ms', 'binding_ttl_ms'],
    runtime: [
        'allow_insecure_coding', 'allow_vision', 'code_timeout_mins', 'max_messages', 'num_examples',
        'spawn_timeout', 'log_all_prompts', 'speak', 'chat_ingame', 'narrate_behavior', 'chat_bot_messages',
    ],
};

/* ───────────────────────── 读 ───────────────────────── */

function readJson(file, fallback) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        if (e?.code === 'ENOENT') return fallback;
        throw new ConfigError(CONFIG_ERROR.BAD_JSON, `${file} 不是合法 JSON：${e.message}`);
    }
}

/**
 * 从 settings.js **源码文本**里读一个标量。
 *
 * 为什么不 `import()`：mindserver 启动时已经 import 过一份，模块缓存里的那份
 * 在文件被改后**不会变**（这是踩过的坑：改完 GET 还是旧值）。带 `?v=` 查参数
 * 可以绕缓存，但每次 GET 都执行一遍模块、而且文件语法错时整个接口 500。
 * 配置项就这十几个标量，正则读反而更稳、更快、也不受缓存影响。
 */
function readScalar(text, key) {
    const m = new RegExp(`^\\s*"${key}"\\s*:\\s*("((?:[^"\\\\\\n]|\\\\.)*)"|true|false|-?\\d+(?:\\.\\d+)?)`, 'm').exec(text);
    if (!m) return undefined;
    const raw = m[1];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw.startsWith('"')) return m[2].replace(/\\(.)/g, '$1');
    return Number(raw);
}

function readSettingsText() {
    if (!existsSync(SETTINGS_PATH)) {
        throw new ConfigError(CONFIG_ERROR.WRITE_FAILED, `找不到 ${SETTINGS_PATH}`);
    }
    return readFileSync(SETTINGS_PATH, 'utf8');
}

function pickSettings(text, keys) {
    const out = {};
    for (const k of keys) {
        const v = readScalar(text, k);
        if (v !== undefined) out[k] = v;
    }
    return out;
}

/**
 * 读四组配置的当前值（**绝不包含任何密钥**：这里只碰上面 SCHEMA 里的键）。
 *
 * @param {{getAgents?: () => Array<object>, profiles?: Array<object>}} [opts]
 *   `getAgents` 是**函数**（不是数组）：agent 列表是调用方进程里的活状态，
 *   每次读都该重新取；传数组会在"读的这一刻"就定格（而且调用方很容易误传结果）。
 */
export function readConfig({ getAgents = () => [], profiles = [] } = {}) {
    const networkRaw = readJson(NETWORK_PATH, { servers: {} });
    const main = networkRaw?.servers?.main ?? {};
    const backupRaw = readJson(BACKUP_PATH, {});
    const settingsText = existsSync(SETTINGS_PATH) ? readSettingsText() : '';

    const network = {
        bind: main.bind ?? 'localhost',
        nic: main.nic ?? '',
        whiteList: main.whiteList === true,
        enforceWhiteList: main.enforceWhiteList === true,
        onlineMode: main.onlineMode === true,
        players: Array.isArray(main.players) ? main.players.slice() : [],
    };
    const identity = {
        ...pickSettings(settingsText, SETTINGS_KEYS.identity),
    };
    const backup = {
        enabled: backupRaw.enabled !== false,
        onServerStop: backupRaw.onServerStop !== false,
        excludeSecrets: backupRaw.excludeSecrets !== false,
        dailyAt: typeof backupRaw.dailyAt === 'string' ? backupRaw.dailyAt : '04:30',
        keep: Number.isFinite(Number(backupRaw.keep)) ? Number(backupRaw.keep) : 7,
    };
    const runtime = { ...pickSettings(settingsText, SETTINGS_KEYS.runtime) };

    // 生效策略：用 **server.properties 的实际值**（不是 network.json 的期望值）——
    // 两者可能不一致（改了 config 还没 apply），那正该被看见。
    //
    // ⚠️ readServerOnlineMode() 返回的是**对象** `{onlineMode, propsPath, source, detail}`，
    //   不是布尔值。直接把对象丢给 resolveIdentityPolicy 会因为"对象恒真"被当成
    //   正版验证（= 误报"持久授 owner"），这是本轮自查抓到的坑 —— 所以这里显式取 `.onlineMode`。
    const onlineModeProbe = readServerOnlineMode();
    const actualOnlineMode = onlineModeProbe?.onlineMode ?? null;
    const policy = resolveIdentityPolicy({
        onlineMode: actualOnlineMode,
        offlineOwnerMode: identity.offline_owner_mode,
        sessionMinutes: identity.offline_session_minutes,
    });

    return {
        network,
        identity,
        backup,
        runtime,
        meta: {
            groups: GROUP_META,
            policy: {
                ...policy,
                // desired（config 里的）与 actual（server.properties 里的）分开报，
                // 让"改了没 apply"这件事在界面上是**可见的**，而不是靠记忆
                desiredOnlineMode: network.onlineMode,
                actualOnlineMode,
                onlineModeSource: onlineModeProbe?.source ?? 'unknown',
                propsPath: onlineModeProbe?.propsPath ?? null,
            },
            pendingApply: {
                // network 改了但没 apply 的判据：期望值 vs server.properties 实际值。
                // 读不到 online-mode（null）时不算 pending —— 不能凭空报"没生效"。
                network: actualOnlineMode !== null && actualOnlineMode !== network.onlineMode,
            },
            backupLogTail: tailBackupLog(5),
            // 传错类型（比如误传数组）时降级成空列表，**不让整个 GET 500** ——
            // 这个坑本轮真踩过：路由把 `agentInfo()` 的结果传给了"应当传函数"的参数，
            // 于是 GET /api/config 直接 500（TypeError: agentInfo is not a function）。
            agents: typeof getAgents === 'function' ? getAgents() : [],
            profiles: Array.isArray(profiles) ? profiles : [],
        },
    };
}

/** `logs/backup-auto.log` 的最后 N 行（让用户能确认"它真的在跑"）。 */
function tailBackupLog(n = 5) {
    try {
        if (!existsSync(BACKUP_LOG)) return { exists: false, lines: [] };
        const text = readFileSync(BACKUP_LOG, 'utf8');
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
        return { exists: true, lines: lines.slice(-n) };
    } catch (e) {
        return { exists: false, lines: [], error: String(e?.message ?? e).slice(0, 120) };
    }
}

/* ───────────────────────── 写 ───────────────────────── */

function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 写 JSON 配置：**保留原文件的换行风格**。
 *
 * 为什么要在意这个：这两个 `.json` 在 Windows 上是 CRLF（`.gitattributes` 也按 CRLF 签出）。
 * 如果直接 `JSON.stringify(obj, null, 2)` 写回，整份文件会变成 LF —— 内容一个字没改，
 * 但从"逐字节对比"的角度等于**整文件被重写**（实测发现：改一个值，sha256 全变）。
 * 对备份/审计/`git diff --stat` 都是噪音，也会让"定向改写"这句话变成空话。
 */
function writeJsonFile(file, obj) {
    let eol = '\n';
    try {
        const before = readFileSync(file, 'utf8');
        if (before.includes('\r\n')) eol = '\r\n';
    } catch { /* 文件不存在就用 LF */ }
    const body = JSON.stringify(obj, null, 2).replace(/\n/g, eol) + eol;
    return backupThenWrite(file, body);
}

/** 先备份再写（备份失败就**不写**：宁可保存失败，也不让现场没有退路）。 */
function backupThenWrite(file, content) {
    const bak = `${file}.bak-${stamp()}`;
    try {
        if (existsSync(file)) copyFileSync(file, bak);
    } catch (e) {
        throw new ConfigError(CONFIG_ERROR.WRITE_FAILED, `备份 ${bak} 失败，已放弃写入：${e.message}`);
    }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
        const dir = dirname(file);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(tmp, content, 'utf8');
        renameSync(tmp, file);   // 原子替换：不会出现"写了一半的 settings.js"
    } catch (e) {
        try { if (existsSync(tmp)) writeFileSync(tmp, ''); } catch { /* ignore */ }
        throw new ConfigError(CONFIG_ERROR.WRITE_FAILED, `写入 ${file} 失败：${e.message}`);
    }
    return bak;
}

/** 校验一个值；返回规范化后的值，非法则抛 CONFIG_BAD_VALUE。 */
function validateValue(group, key, value) {
    const spec = SCHEMA[group]?.[key];
    if (!spec) throw new ConfigError(CONFIG_ERROR.UNKNOWN_KEY, `未知配置项：${group}.${key}`);
    const where = `${group}.${key}`;

    if (spec.kind === 'bool') {
        if (typeof value !== 'boolean') throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 必须是 true/false`);
        return value;
    }
    if (spec.kind === 'enum') {
        if (!spec.values.includes(value)) {
            throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 只能是 ${spec.values.join(' / ')}`);
        }
        return value;
    }
    if (spec.kind === 'int') {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isInteger(n)) throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 必须是整数`);
        if (n < spec.min || n > spec.max) {
            throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 必须在 ${spec.min} ~ ${spec.max} 之间（收到 ${n}）`);
        }
        return n;
    }
    if (spec.kind === 'string') {
        if (typeof value !== 'string') throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 必须是字符串`);
        if (value.length > spec.maxLen) throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 不能超过 ${spec.maxLen} 字符`);
        if (spec.pattern && !spec.pattern.test(value)) {
            throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 含有非法字符（只允许字母数字与 . : _ -）`);
        }
        return value;
    }
    if (spec.kind === 'time') {
        if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
            throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 必须是 HH:mm（00:00 ~ 23:59）`);
        }
        return value;
    }
    if (spec.kind === 'stringArray') {
        if (!Array.isArray(value)) throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 必须是字符串数组`);
        if (value.length > spec.maxItems) {
            throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 最多 ${spec.maxItems} 项`);
        }
        const seen = new Set();
        const out = [];
        for (const raw of value) {
            if (typeof raw !== 'string') throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 里每项都必须是字符串`);
            const item = raw.trim();
            if (!spec.itemPattern.test(item)) {
                throw new ConfigError(CONFIG_ERROR.BAD_VALUE,
                    `${where} 里的 "${item}" 不是合法玩家名（1~16 位字母/数字/下划线）`);
            }
            if (seen.has(item)) continue;   // 去重（不是错误，只是别让列表里出现两个一样的名字）
            seen.add(item);
            out.push(item);
        }
        return out;
    }
    throw new ConfigError(CONFIG_ERROR.BAD_VALUE, `${where} 的类型未实现：${spec.kind}`);
}

/**
 * 定向改写 settings.js：只替换 `"key": <literal>` 里的 literal。
 *
 * **不要**改成 JSON 序列化 —— 这个文件里 60% 是解释性注释（每一条都解释
 * "为什么这么默认"），序列化会把它们全丢掉。见文件头 ②。
 */
function patchSettingsText(text, group, patch) {
    let out = text;
    for (const [key, value] of Object.entries(patch)) {
        if (!SETTINGS_KEYS[group]?.includes(key)) {
            throw new ConfigError(CONFIG_ERROR.UNKNOWN_KEY, `settings.js 里没有归本模块管理的键：${key}`);
        }
        const literal = typeof value === 'string' ? JSON.stringify(value) : String(value);
        // 只匹配行首缩进 + "key": + 一个标量 literal；行尾的 , 与注释都在匹配范围外，原样保留
        const re = new RegExp(`^([ \\t]*"${key}"[ \\t]*:[ \\t]*)(?:"(?:[^"\\\\\\n]|\\\\.)*"|true|false|-?\\d+(?:\\.\\d+)?)`, 'm');
        const hits = out.match(new RegExp(re.source, 'gm'));
        if (!hits || hits.length !== 1) {
            throw new ConfigError(CONFIG_ERROR.WRITE_FAILED,
                `settings.js 里 "${key}" 出现 ${hits ? hits.length : 0} 次（应当是 1 次），拒绝盲改`);
        }
        out = out.replace(re, (_m, head) => head + literal);
    }
    return out;
}

/** 写完立刻验一次"还能不能被 import"；不能就回滚。 */
async function verifySettingsLoadable() {
    const url = `${pathToFileURL(SETTINGS_PATH).href}?v=${Date.now()}`;
    const mod = await import(url);
    if (!mod?.default || typeof mod.default !== 'object') {
        throw new ConfigError(CONFIG_ERROR.SETTINGS_INVALID, 'settings.js 能加载但 default export 不是对象');
    }
    return mod.default;
}

/**
 * 写一组配置。
 *
 * @param {'network'|'identity'|'backup'|'runtime'} group
 * @param {object} patch 只包含要改的键（部分更新）
 * @param {{log?: {info:Function, warn:Function}}} [io]
 * @returns {Promise<{ok:true, group:string, applied:object, backup:string|null, values:object}>}
 */
export async function updateConfigGroup(group, patch, io = {}) {
    const log = io.log ?? console.log;
    const warn = io.warn ?? console.warn;

    if (!GROUP_META[group]) {
        throw new ConfigError(CONFIG_ERROR.BAD_GROUP, `未知配置组：${group}（只有 ${Object.keys(GROUP_META).join(' / ')}）`);
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ConfigError(CONFIG_ERROR.BAD_VALUE, '请求体必须是对象（部分更新，只包含要改的键）');
    }
    const keys = Object.keys(patch);
    if (!keys.length) throw new ConfigError(CONFIG_ERROR.BAD_VALUE, '没有任何要改的键');

    // 先全部校验，**再**落盘：不允许"改了一半发现第 3 个键非法"
    const applied = {};
    for (const k of keys) applied[k] = validateValue(group, k, patch[k]);

    // 跨字段约束：custom 必须有 nic
    if (group === 'network') {
        const current = readJson(NETWORK_PATH, { servers: { main: {} } })?.servers?.main ?? {};
        const nextBind = applied.bind ?? current.bind ?? 'localhost';
        const nextNic = applied.nic ?? current.nic ?? '';
        if (nextBind === 'custom' && !String(nextNic).trim()) {
            throw new ConfigError(CONFIG_ERROR.BAD_VALUE, 'bind = custom 时必须填 nic（要绑的网卡地址，如 192.168.1.23）');
        }
    }

    if (group === 'network' || group === 'backup') {
        const file = group === 'network' ? NETWORK_PATH : BACKUP_PATH;
        const obj = readJson(file, group === 'network' ? { servers: { main: {} } } : {});
        if (group === 'network') {
            if (!obj.servers) obj.servers = {};
            if (!obj.servers.main) obj.servers.main = {};
            Object.assign(obj.servers.main, applied);
        } else {
            Object.assign(obj, applied);
        }
        const backup = writeJsonFile(file, obj);
        log(`[config] 已写入 ${file}（备份 ${backup}）`);
        return { ok: true, group, applied, backup, values: groupValues(group) };
    }

    // settings.js —— 行级定向替换 + 写完验加载
    const before = readSettingsText();
    const after = patchSettingsText(before, group, applied);
    const oldInsecure = readScalar(before, 'allow_insecure_coding');
    const backup = backupThenWrite(SETTINGS_PATH, after);
    try {
        await verifySettingsLoadable();
    } catch (e) {
        // 回滚：把备份原样写回，绝不把坏文件留在现场
        try {
            writeFileSync(SETTINGS_PATH, before, 'utf8');
            warn(`[config] settings.js 写后校验失败，已回滚到改动前内容（备份 ${backup}）：${e?.message ?? e}`);
        } catch (re) {
            warn(`[config] 回滚失败！请用 ${backup} 手工恢复：${re?.message ?? re}`);
        }
        throw new ConfigError(CONFIG_ERROR.SETTINGS_INVALID, `settings.js 改写后无法加载：${e?.message ?? e}`);
    }
    log(`[config] 已写入 ${SETTINGS_PATH}（备份 ${backup}）`);

    // 危险项：从 false 打开成 true 必须留痕（谁、什么时候、从什么改成什么）
    if (group === 'runtime' && applied.allow_insecure_coding === true && oldInsecure !== true) {
        warn('[config] ⚠ allow_insecure_coding 已从 false 改为 true —— '
            + '等于允许模型在本机写并执行代码（本机 root）。请确认这是你手动开启的。');
    }

    return { ok: true, group, applied, backup, values: groupValues(group) };
}

/** 取某一组的"当前值"（PUT 的返回体用，避免前端再 GET 一次）。 */
function groupValues(group) {
    const all = readConfig();
    return all[group] ?? {};
}

/** 测试/文档用：暴露路径，免得别人再拼一遍相对路径。 */
export const CONFIG_PATHS = Object.freeze({
    network: NETWORK_PATH,
    backup: BACKUP_PATH,
    settings: SETTINGS_PATH,
    backupLog: BACKUP_LOG,
});

/** 只读：某个文件的 mtime（面板显示"最后修改"用；不参与任何判定）。 */
export function fileMtime(file) {
    try { return statSync(file).mtimeMs; } catch { return null; }
}
