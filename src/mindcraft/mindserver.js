import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import * as procCtrl from './proc_control.js';
import { allowLocalOnly } from './local_only.js';
// 第一轮审查 第1条 ①②：握手 token 门 + set-agent-settings 字段白名单（见 auth_gate.js 顶部说明）
// R6 #2：再加「凭据 → 角色」（面板 / agent）。角色由**出示的是哪一份凭据**决定。
import {
    makeToken, makeHandshakeGate, authCookieHeader, hasAuthCookie,
    sanitizeAgentSettings, registerCredential, credentialAgent, tokenFromHandshake, ROLE_AGENT, ROLE_PANEL,
} from './auth_gate.js';
// 第2条：create-agent 的 profile 名复用 agent 侧同一份校验（规则只能有一个真相）
import { validateNameFormat } from '../agent/connection_handler.js';
// 第四轮审计 ①：玩家身份绑定（面板下发一次性码 / 查看绑定 / 解绑）
import {
    identityFileOf, codesFileOf, readStore, writeStore, mutateStore,
    makeCode, addCode, previewStatus, revokeBinding, revokeSessionCodes,
    DEFAULT_CODE_TTL_MS,
} from './identity_store.js';
// OPS-003（2026-11-06）：离线模式 + 监听所有网卡 ⇒ 名字可冒用为主人。启动时给出可见告警。
import {
    assessFromProperties, renderOfflineIdentityWarning,
    // ★ t27：online-mode 与 offline_owner_mode 合成策略的**唯一判据入口**
    readServerOnlineMode, resolveIdentityPolicy,
} from './offline_identity_risk.js';
import { readFileSync, existsSync, readdirSync, writeFileSync, fstatSync, unlinkSync } from 'fs';
// ★ R6 #21：身份存储的写前 CAS 要算内容哈希（见 mutateStoreFile）
// t20-C（R5-收口）：token 文件落盘后要收口 NTFS DACL。只用 execFile(argv)，**不用 shell**。
import { execFile } from 'child_process';
// M8 B1（2026-11-02）：任务板。**只有 mindserver 写库**（06 §3：每个 agent 是独立子进程，
// 板放 agent 里别的 bot 看不见；放这里就只有一个写者，省掉多进程锁）。
import { openBoard } from '../agent/library/board_store.js';
import { attachBoardServer } from '../agent/library/board_server.js';
// 注册表与参数解析器：服务端复用 **agent 侧同一份**（参数规则只能有一个真相）。
import * as compositeRegistry from '../agent/library/composite_registry.js';
// R4 t13：启动时自检"有没有人绑定过身份"（只读目录，用于给一条可照做的升级提示）
import { botsRootOf, boardDirOf } from '../agent/library/bot_paths.js';
// R5 t15：凭据保管库（AES-256-GCM + sqlite）。**HTTP 门在这一层**，
// 加密/KDF/存储全在 library 里 —— 分层是故意的：agent 子进程也能 import 那个模块（只读），
// 但只有 mindserver 挂 HTTP 出口。
import {
    autoUnlockFromEnv, clearInjectedEnv, injectEnvFromVault,
    init as vaultInit, isInitialized as vaultIsInitialized, isUnlocked as vaultIsUnlocked,
    listSecrets, lock as vaultLock, MAX_VALUE_BYTES, removeSecret, setSecret,
    status as vaultStatus, uninjectEnv, unlock as vaultUnlock, VAULT_ERROR, NAME_PATTERN,
} from '../agent/library/secrets_vault.js';
import {
    ConfigError, CONFIG_ERROR, GROUP_META, readConfig, updateConfigGroup,
} from './config_center.js';
// T31 / W-2：/unlock 的**按来源分桶**失败限流（抽成模块才能离线证明"正确口令不被锁死"）
import { createUnlockLimiter, addressKeyOf, createConcurrencyGate } from './unlock_limiter.js';
// R4 t20：启动告警要读 identity_binding 的真实配置（离线模式那条限制必须说出来）
import rootSettings from '../../settings.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════════════════════════
// t20-C（R5-收口）：token 文件落盘后**立刻**收口 NTFS DACL
//
// 为什么必须从产品代码修：`.mindserver-token` 每次启动都由本进程**重新创建**，
// 而新建文件会**重新继承父目录 ACL**（mindcraft/ 对 Authenticated Users 有 (RX)）⇒
// 运维侧那次 `harden-credentials-acl.ps1 -Apply` 的一次性加固必然复发
// （t11 实测复发过一次：回归 22/0 → 起一次 mindserver → 20/2）。
//
// 口径：先断开继承（丢掉父目录带来的 AU:(I)(RX)），再只授权三条 ——
// 当前用户、SYSTEM(*S-1-5-18)、Administrators(*S-1-5-32-544)，都给 F。
//
// 安全/兼容约束：
//   · 用 execFile(icacls, argv)，**不开 shell**（与本仓 spawn+argv 口径一致，无注入面）；
//   · 斜杠用 String.fromCharCode(47) 拼，源码里不出现裸斜杠字面量（避免命中 preflight 规则）；
//   · 非 Windows 直接 return；任何失败只 console.warn，**绝不影响启动**；
//   · 幂等：每次重建 token 都会重新收口一遍。
// ════════════════════════════════════════════════════════════════════
const SLASH = String.fromCharCode(47);

function hardenTokenFileAcl(file) {
    if (process.platform !== 'win32') return;
    try {
        const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
        const who = process.env.USERNAME;
        if (!who) { console.warn('[mindserver] token ACL 收口跳过：取不到 USERNAME'); return; }
        // 1) 断开继承（丢掉父目录带来的 Authenticated Users:(I)(RX)）
        execFile(icacls, [file, SLASH + 'inheritance:r'], { windowsHide: true }, (e1) => {
            if (e1) {
                console.warn(`[mindserver] token ACL 断开继承失败（不影响启动）：${e1?.code ?? e1}`);
                return;
            }
            // 2) 只保留 当前用户 / SYSTEM / Administrators
            const grants = [file, SLASH + 'grant:r',
                who + ':(F)', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'];
            execFile(icacls, grants, { windowsHide: true }, (e2) => {
                if (e2) {
                    console.warn(`[mindserver] token ACL 授权收紧失败（不影响启动）：${e2?.code ?? e2}`);
                    return;
                }
                console.log(`[mindserver] token 文件 ACL 已收口（非继承，仅当前用户/SYSTEM/Administrators）：${file}`);
            });
        });
    } catch (e) {
        // 连 execFile 都抛（极端环境）：同样只 warn，不许弄挂启动
        console.warn(`[mindserver] token ACL 收口异常（不影响启动）：${e?.message ?? e}`);
    }
}

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
// 第一轮审查 第1条 ①：本次启动的握手 token（io.use 校验；agent 子进程从 env 拿到同一份）
let handshakeToken = null;
// ★ R6 #2：**第二份凭据**。`handshakeToken` 是**面板**凭据（写 .mindserver-token、走 ?token=/cookie）；
//   `agentToken` 只通过 process.env.MINDSERVER_TOKEN 继承给 agent 子进程。
//   两者是不同的随机串 ⇒ 握手门知道「这条连接出示的是哪一份」⇒ 角色是**鉴权结论**，
//   不再是「客户端有没有发 auth 字段」这种自述。见 auth_gate.js 顶部。
let agentToken = null;
const agent_connections = {};
const agent_listeners = [];

/** 本次启动的握手 token；`init()` 之外的调用方（自动开浏览器）靠它拼 `?token=`。 */
export function getHandshakeToken() {
    return handshakeToken;
}

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

/**
 * F-EXEC-112（2026-11-06）：按 `settings_spec.json` 校验一份 settings，返回**可读的拒绝原因**（合法则返回 null）。
 *
 * 为什么需要：create-agent 原来只读 `required` / `default`，`type` 与 `options` **全仓零读取**
 * ⇒ `port: "abc"`、`auth: "随便"`、`load_memory: "false"` 都会被收下并送进 agent 进程，
 * 到了那边以莫名错误炸开。入口不校验 = 把排查成本推给最下游。
 *
 * 宽容策略（都带日志，不静默）：
 *   · `number`：接受"有限数字的字符串"（面板输入框天然产出字符串）⇒ **就地转成 number 并 warn**；
 *   · `boolean`：**只接受真布尔**。`"false"` 这种 truthy 字符串如果被静默转成 true，会埋雷，
 *     所以明确拒绝并告诉调用方该传什么。
 *   · `object` / `array`：按 `typeof` / `Array.isArray` 判（`null` 对 object 视为非法）。
 *
 * @param {object} settings 已经填过默认值、删过未知键的 settings
 * @param {object} spec settings_spec.json 的内容
 * @returns {string|null} 拒绝原因；合法返回 null
 */
function schemaViolation(settings, spec) {
    for (const key of Object.keys(settings)) {
        const def = spec[key];
        if (!def || settings[key] === undefined) continue;
        const val = settings[key];

        // ── options 白名单（先判：比类型更具体）──
        if (Array.isArray(def.options) && def.options.length) {
            if (!def.options.includes(val)) {
                return `Setting "${key}" 的值 ${JSON.stringify(val)} 不在允许范围内，`
                    + `只能是 ${def.options.map((o) => JSON.stringify(o)).join(' / ')}`;
            }
        }

        // ── type ──
        switch (def.type) {
            case 'boolean':
                if (typeof val !== 'boolean') {
                    return `Setting "${key}" 必须是布尔值（true / false），收到的是 ${JSON.stringify(val)}`
                        + `（${typeof val}）。注意字符串 "false" 不算 false，请传 JSON 布尔。`;
                }
                break;
            case 'number': {
                if (typeof val === 'number' && Number.isFinite(val)) break;
                const n = typeof val === 'string' && val.trim() !== '' ? Number(val) : NaN;
                if (Number.isFinite(n)) {
                    settings[key] = n;                       // 就地转正 + 下面的 warn（不静默）
                    console.warn(`[mindserver] create-agent: Setting "${key}" 收到字符串 ${JSON.stringify(val)}，已按数字 ${n} 处理`);
                    break;
                }
                return `Setting "${key}" 必须是数字，收到的是 ${JSON.stringify(val)}（${typeof val}）`;
            }
            case 'string':
                if (typeof val !== 'string') {
                    return `Setting "${key}" 必须是字符串，收到的是 ${JSON.stringify(val)}（${typeof val}）`;
                }
                break;
            case 'array':
                if (!Array.isArray(val)) {
                    return `Setting "${key}" 必须是数组，收到的是 ${JSON.stringify(val)}（${typeof val}）`;
                }
                break;
            case 'object':
                if (val === null || typeof val !== 'object' || Array.isArray(val)) {
                    return `Setting "${key}" 必须是对象，收到的是 ${JSON.stringify(val)}（${Array.isArray(val) ? 'array' : typeof val}）`;
                }
                break;
            default:
                // spec 里没写 type（或写了未知 type）⇒ 不做类型判断，保持向后兼容
                break;
        }
    }
    return null;
}

function describeShape(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'function') return 'function';
    if (typeof v === 'object') return 'object';
    return `${typeof v} ${JSON.stringify(v)}`;
}

/**
 * ★★★ R4 S1#5：`create-agent` 的 `settings` **先校验形状**，再做默认值/白名单/类型校验。
 *
 * 缺陷原貌（`mindserver.js:607-614`）：处理器一上来就
 *   `for (let key in settings_spec) { if (!(key in settings)) { ... } }`
 *   · `settings` 是 `null` / 字符串 / 数组 ⇒ `in` 运算符直接抛 TypeError；
 *   · `settings.profile` 是字符串或数组 ⇒ 后面的 `settings.profile.name` 取到 undefined 或抛；
 *   · 而且处理器是 `async`：抛出的异常变成**未处理的 Promise 拒绝** ⇒ Node 22 默认
 *     **退出进程**。实测后果：任何持 token 的客户端发一条畸形 create-agent，
 *     整套控制面（全部 bot、面板、任务板）一起没。
 *
 * 现在把形状检查提到最前面，给出**可读原因**（谁传错了、该传什么），再往下走。
 * 注意：这里只管"能不能安全地继续"，值域/类型/白名单仍由 schemaViolation 负责（职责分开）。
 *
 * @param {unknown} settings 客户端原样传进来的东西
 * @returns {string|null} 拒绝原因；合法返回 null
 */
export function validateSettingsShape(settings) {
    if (settings === null || settings === undefined) {
        return 'create-agent 的 settings 不能为空（需要一个 JSON 对象，至少含 profile.name）';
    }
    if (typeof settings !== 'object' || Array.isArray(settings)) {
        return `create-agent 的 settings 必须是对象（JSON object），收到的是 ${describeShape(settings)}`;
    }
    const profile = settings.profile;
    if (profile === null || profile === undefined) {
        return 'settings.profile 不能为空（必须包含 name）';
    }
    if (typeof profile !== 'object' || Array.isArray(profile)) {
        return `settings.profile 必须是对象，收到的是 ${describeShape(profile)}`;
    }
    if (typeof profile.name !== 'string') {
        return `settings.profile.name 必须是字符串，收到的是 ${describeShape(profile.name)}`;
    }
    if (profile.name.trim() === '') {
        return 'settings.profile.name 不能是空字符串';
    }
    return null;
}

/**
 * ★★★ R4 S2#9：这个连接是不是「agent 进程自己」？
 *
 * 为什么需要区分：agent 进程连回来时会带 `auth: { token }`（见
 * `src/agent/mindserver_proxy.js` 的 `auth: (cb) => cb({ token })`），
 * 而面板（浏览器控制台）只用 HttpOnly cookie 过握手门、**不带** auth payload。
 * 于是"带 auth.token 且等于本次 token"= agent 身份；否则 = 面板/其他客户端。
 *
 * 这条判据同时被 `bot-output` / `agent-event`（F-WEB-101）和 `login-agent` 用，
 * 所以抽成一处，避免三份实现悄悄漂移。
 */
export function isAgentIdentity(socket, token = handshakeToken) {
    // ★★★ R6 #2：**先看握手时定下的角色**（凭据种类），这是鉴权结论。
    //   原来这里唯一的判据是「客户端在 auth 里发了 token 吗」——
    //   而面板也可以发、agent 也可以不发，所以它只能算「语义标签」。
    const role = socketRole(socket);
    if (role === ROLE_AGENT) return true;
    if (role === ROLE_PANEL) return false;
    // 兜底：没有角色戳的 socket（离线单测的桩、或极早期代码）才退回旧判据。
    // 生产路径上每个 socket 都过握手门（io.use(makeHandshakeGate)），一定有角色。
    const t = socket?.handshake?.auth?.token;
    return typeof t === 'string' && t !== '' && typeof token === 'string' && t === token;
}

/**
 * ★ R6 #2：这条连接在握手时被认定的**角色**（'panel' | 'agent' | null=未知）。
 * `null` 一律按「不是面板」处理 —— 管理面事件的判据是「明确证明自己是面板」。
 * @param {object} socket
 * @returns {'panel'|'agent'|null}
 */
export function socketRole(socket) {
    const role = socket?.data?.role;
    return role === ROLE_PANEL || role === ROLE_AGENT ? role : null;
}

/**
 * ★ ADR 阶段 1：从连接上取出它出示的凭据（用于反查"这份凭据属于哪只 bot"）。
 * 任何异常一律返回 null —— 这里只做"能查到就查"的辅助判断，绝不因为取不到而抛。
 * @param {object} socket
 * @returns {string|null}
 */
export function tokenFromSocket(socket) {
    try {
        const t = tokenFromHandshake(socket?.handshake);
        return typeof t === 'string' && t ? t : null;
    } catch {
        return null;
    }
}

/**
 * ★ ADR 阶段 1：给一只 bot 发**独立凭据**并登记归属。
 *
 * 原来所有子进程共用一条 `agentToken`：任何持有它的进程都能 `login-agent` 抢任意名字。
 * 每只 bot 一条之后，"抢名字"这条路在 `claimAgentChannel` 里就会被 `identity-mismatch` 拒掉。
 *
 * @param {string} agentName
 * @returns {string|null} 新凭据；agentName 非法时返回 null（调用方退回共享凭据并告警）
 */
export function issueAgentToken(agentName) {
    const name = typeof agentName === 'string' ? agentName.trim() : '';
    if (!name) return null;
    const token = makeToken();
    if (!registerCredential(token, ROLE_AGENT, name)) return null;
    return token;
}

/**
 * ★★★ R4 S2#9：agent 通道的**唯一占用**裁决（纯决策，只更新 churn 计数，不碰 socket）。
 *
 * 缺陷原貌（`mindserver.js:686-703`）：`login-agent` / `connect-agent-process` 只做
 * `if (agent_connections[agentName]) { conn.socket = socket; ... }` ——
 *   · **没有身份校验**：任何持 token 的面板连接都能把自己绑成某个 agent 的通道，
 *     真正的 agent 下一句话就发不到了（`chat-message` 转发给"最后绑上来的那个 socket"）；
 *   · **没有唯一性**：两个同名的 agent 进程（双开）互相把对方踢下通道，
 *     玩家消息一半丢、面板看到 `in_game` 一跳一跳。
 *
 * 现在的规则：
 *   ① 必须是 agent 身份（面板一律拒绝：`identity-required`）；
 *   ② 同一个 socket 重复声明 = 幂等（`rebind`，`connect-agent-process` 之后紧跟 `login-agent` 就是这条路）；
 *   ③ 换连接时**允许接管**（agent 进程重启/瞬断重连是常态，硬拒会把 bot 锁在门外），
 *      但**限速**：同一个 agent 在 `takeoverWindowMs` 内最多接管 `maxTakeovers` 次，
 *      超了就拒绝（`channel-busy`）。于是"两个进程互相踢"不再无声无息地循环，
 *      而是几次之后被挡住并在日志里点名。
 *
 * @returns {{ok:boolean, takeover:boolean, previous:object|null, reason:string}}
 */
export function claimAgentChannel(conn, socket, {
    agentIdentity = false,
    credentialAgentName = null,
    requestedName = null,
    now = Date.now(),
    maxTakeovers = 3,
    takeoverWindowMs = 30_000,
} = {}) {
    if (!conn) return { ok: false, takeover: false, previous: null, reason: 'unknown-agent' };
    if (!socket) return { ok: false, takeover: false, previous: null, reason: 'no-socket' };
    if (!agentIdentity) return { ok: false, takeover: false, previous: conn.socket ?? null, reason: 'identity-required' };
    // ★ ADR 阶段 1：**凭据归属**。每只 bot 有独立凭据，登记时绑定了 agentName。
    //   这份凭据只能占用它自己的名字；拿 A 的凭据去占 B 的名字一律拒绝。
    //   credentialAgentName 为 null 表示"旧式共享凭据"（未逐 agent 发放），此时放行但留日志，
    //   以免打断尚未升级的调用方；一旦全部升级，这条分支应当删掉并把 unknown 视为拒绝。
    if (credentialAgentName && requestedName && credentialAgentName !== requestedName) {
        return { ok: false, takeover: false, previous: conn.socket ?? null, reason: 'identity-mismatch' };
    }

    const prev = conn.socket ?? null;
    if (!prev || prev === socket) {
        return { ok: true, takeover: false, previous: null, reason: prev ? 'rebind' : 'claim' };
    }
    // 旧连接自己已经掉了 ⇒ 这是"接手死连接"，不算抢占，也不计入接管限速
    if (prev.connected === false) {
        return { ok: true, takeover: true, previous: prev, reason: 'takeover-stale' };
    }
    // 接管限速（状态挂在 conn 上：随 agent 注册/销毁自然重置，不需要单独的清理表）
    const churn = conn._channelTakeovers ?? (conn._channelTakeovers = { count: 0, since: now });
    if (now - churn.since > takeoverWindowMs) {
        churn.since = now;
        churn.count = 0;
    }
    if (churn.count >= maxTakeovers) {
        return { ok: false, takeover: false, previous: prev, reason: 'channel-busy' };
    }
    churn.count += 1;
    return { ok: true, takeover: true, previous: prev, reason: 'takeover-live' };
}

/** agent 通道被接管的次数（诊断用：`in_game` 一跳一跳时看它）。 */
export function channelTakeoverCount(agentName) {
    return agent_connections[agentName]?._channelTakeovers?.count ?? 0;
}

/**
 * ★★★ R4 S1#5（兜底）：控制面**不许被单个畸形事件 / 单个 Promise 带走**。
 *
 * 为什么需要：`create-agent` 之类的处理器是 `async`，任何漏出去的异常都会变成
 * 未处理的 Promise 拒绝，而 Node 22 的默认行为是**直接退出进程**。入口校验（
 * validateSettingsShape 等）是"堵住已知的那几条"，这里则是**最后一道网**：
 * 兜住没预料到的，打完整栈，控制面继续运行（bot 不该因为一条坏消息全部掉线）。
 *
 * 诚实边界：这不是"修好了异常"，而是"不再让一个异常扩成整机停机"。所以：
 *   · 一律 `console.error` 带栈（可被抓日志的运维看到）；
 *   · 需要恢复"崩了就退"的严格语义时设 `MINDSERVER_EXIT_ON_UNCAUGHT=1`。
 *
 * @returns {boolean} 本次是否真的装上了（重复调用返回 false，幂等）
 */
const guardedProcs = new WeakSet();

export function installCrashGuards({
    exitOnUncaught = process.env.MINDSERVER_EXIT_ON_UNCAUGHT === '1',
    proc = globalThis.process,
} = {}) {
    // 幂等按**进程对象**判（而不是函数属性）：离线用例可以拿假 EventEmitter 验一遍，
    // 又不会把"真 process 已经装过"这件事提前占掉。
    if (guardedProcs.has(proc)) return false;
    guardedProcs.add(proc);

    proc.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        console.error('[mindserver] 未处理的 Promise 拒绝（已兜住，控制面继续运行；' +
            '这类问题要修根因，别靠这道网）：', err);
    });

    proc.on('uncaughtException', (err) => {
        console.error('[mindserver] 未捕获异常：', err);
        if (exitOnUncaught) {
            console.error('[mindserver] MINDSERVER_EXIT_ON_UNCAUGHT=1 ⇒ 按严格语义退出');
            try { proc.exit(1); } catch { /* ignore */ }
            return;
        }
        console.error('[mindserver] 已兜住该异常并继续运行（bot/面板/任务板不受影响）；' +
            '若要"崩了就退"请设 MINDSERVER_EXIT_ON_UNCAUGHT=1');
    });
    return true;
}

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
    // ★ R6 #25：原型链键（`constructor`）也是真值 —— 只认自有键。
    if (Object.prototype.hasOwnProperty.call(agent_connections, agentName)) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

/**
 * ★★★ R6 #2：`shutdown` 的任务模式判据（纯函数，服务端状态）。
 *
 * 报告 #2 要求「破坏性事件必须有真正的角色判据」。`shutdown` 有一个**既有正常路径**
 * 需要保留：任务模式（`npm start -- --task_path=<file> --task_id=<id>`）下，
 * agent 跑完任务会 `killAll()` → `emit('shutdown')` → 整套退出。
 *
 * 所以这里把「关服」拆成两件事：
 *   · **权限**：agent 永远没有关服权限（面板模式下一律拒绝）；
 *   · **配置**：服务端启动时若被配置成任务模式，那么「任务结束收整套」是**服务端自己的决定**，
 *     agent 的信号只是触发条件。判据全部取自服务端状态：
 *       - `rootSettings.task.task_id`（启动配置）
 *       - `agent_connections[name].settings.task.task_id`（这条连接登记的 agent 的配置）
 *     agent 在 payload 里自述的 `task_id` 只能**收窄**（不相等即拒绝），不能扩大。
 */
function taskIdOf(task) {
    if (!task || typeof task !== 'object') return null;
    const id = task.task_id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** 这条 socket 现在是哪个 agent 的通道（没有则 null）。 */
function agentNameOfSocket(socket) {
    for (const name of Object.keys(agent_connections)) {
        if (agent_connections[name]?.socket === socket) return name;
    }
    return null;
}

/**
 * ★ R6 #72：注册项是不是"已经没有进程、也没有通道"的残留（子进程自杀只删 agent_processes）。
 * 判据全取服务端状态（通道 + 进程表），不信客户端。
 */
function isStaleAgentConn(name) {
    const conn = agent_connections[name];
    if (!conn) return false;
    if (conn.socket) return false;                              // 还有通道 ⇒ 活的
    try {
        if (mindcraft.getAgentProcess?.(name)) return false;    // 进程表里还有 ⇒ 只是没连上
    } catch { /* 取不到就当"没有进程" */ }
    return true;
}

/**
 * ★ R6 #21：身份码/身份表是**两个进程都会写**的文件（面板签发 vs agent 核销），
 * 裸"读-算-写"会静默抹掉别人的改动。这里做**写前 CAS**（比对内容哈希）+ 写后复核。
 * 不是跨进程锁；根治（单一写者）见 docs/audit-r6/fixes2/control.md 残留。
 */
/**
 * 带"进程间文件锁 + rev"的读-改-写。
 *
 * ★ ADR 阶段 1 收尾（T7-2/t8 残留）：本函数原来自己算**内容哈希**做 CAS，与
 * identity_store 的 `mutateStore`（真文件锁 + rev）在同一文件上**并存两套并发保护**。
 * 现在统一委托给 `mutateStore`：锁只有一套，rev 由 writeStore 校验；本函数只额外保留
 * `verify`（写后复核，失败重试）这个调用方需要的能力。
 *
 * @param {string} file
 * @param {(store:object)=>({store:object, result:any}|null)} mutate 返回 null = 无事可做
 * @param {{attempts?:number, what?:string, verify?:Function}} [opts]
 * @returns {{ok:boolean, result:any, reason?:string, skipped?:boolean, attempts?:number}}
 */
function mutateStoreFile(file, mutate, { attempts = 4, what = '身份存储', verify = null } = {}) {
    if (typeof mutate !== 'function') return { ok: false, reason: 'no-mutator', result: null };
    for (let i = 1; i <= attempts; i += 1) {
        // 内层 attempts:1 —— 重试交给外层，这样 verify 失败也能重算
        const out = mutateStore(file, (store) => mutate(store), { attempts: 1 });
        if (!out.ok) {
            const r = String(out.reason ?? '');
            if (r === 'conflict' || r.startsWith('lock')) continue;   // 锁忙/版本冲突：外层重试
            return { ok: false, reason: out.reason, result: null };
        }
        if (out.skipped) return { ok: true, skipped: true, result: null };
        if (typeof verify !== 'function') return { ok: true, result: out.result, attempts: i };
        let landed = false;
        try { landed = verify(readStore(file).store, out.result) === true; } catch { landed = false; }
        if (landed) return { ok: true, result: out.result, attempts: i };
        console.warn(`[mindserver] ${what} 写后复核未通过（第 ${i}/${attempts} 次），重读重算`);
    }
    return { ok: false, reason: 'conflict', result: null };
}

/**
 * ★ R6 #33 / ADR §10.2-5：限流桶的**主体键**。原来按远端地址（全本机 ⇒ 单一全局桶），
 * 上一轮只到 role；现在 agent 连接按服务端判定的 agent 名，未绑定时用凭据指纹。
 */
function rateSubjectOf(socket) {
    const role = socketRole(socket) ?? 'unknown';
    if (role === ROLE_AGENT) {
        const name = socket?.data?.agentName;
        if (typeof name === 'string' && name) return `agent:${name}`;
        const cred = tokenFromSocket(socket);
        return cred ? `agent#${cred.slice(0, 8)}` : 'agent:unbound';
    }
    return role;
}

/**
 * 桶键 `label@主体@来源地址`。导出只为让离线单测能直接断言"按 agent 分桶"（§10.2-5）。
 */
export function rateBucketKeyOf(socket, label) {
    const addr = String(socket?.handshake?.address || socket?.conn?.remoteAddress || 'unknown');
    return `${label}@${rateSubjectOf(socket)}@${addr}`;
}

/** 任务模式下是否已经收过一次尾（幂等：同一个 task 只允许触发一次）。 */
let taskModeShutdownFired = false;

// Initialize the server
// F-WEB-203：按远端地址共享的令牌桶（跨连接，重连不清零）
const RATE_BUCKETS = new Map();
// R3-2：**真上限**（不是"清理触发条件"）。超过就淘汰最旧的那条。
// 512 条 × 每条约 60B ≈ 30KB 上界；本仓只绑 localhost（key 其实只有 2~8 个），这个值只是防将来放开绑定后的长期累积。
const RATE_BUCKETS_MAX = 512;
const STALE_MS = 60000;

/**
 * F-WEB-203（2026-11-06）：取一个令牌。返回 true = 放行，false = 该限流了。
 *
 * 为什么按**远端地址**而不是按 socket：桶挂 socket 上时"断开重连"就清零，可无限绕过（复核席指出）。
 * 为什么按事件分桶（key 里带 label）：`send-message` 可以高频（聊天），而 `restart-agent`
 * 一分钟三次就已经是攻击形态了 —— 两类事件不能共用同一个桶。
 *
 * 参数（capacity / windowMs）由调用方按"该事件的正常使用频率"决定，别一刀切。
 */
function takeToken(socket, label, capacity, windowMs) {
    const now = Date.now();
    const addr = String(socket?.handshake?.address || socket?.conn?.remoteAddress || 'unknown');
    // ★ R6 #33 / ADR §10.2-5：桶键 = label@**主体**@来源地址（主体见 rateSubjectOf）。
    //   上一轮只到 role（所有 agent 共用一个桶）；现在细到"哪一个 agent"。
    const subject = rateSubjectOf(socket);
    const key = rateBucketKeyOf(socket, label);    // ★ R3-2（终审实测）：这里原来是 `if (size > 512) { 删 >60s }` —— 那是**清理触发条件**，
    // 不是上限：513 个新鲜 key 时一个都删不掉，之后每条消息全表扫一遍。名不副实。
    // 现在给它**真上限**：新 key 且已满 ⇒ 先清陈旧项；仍满 ⇒ 淘汰**最旧**的那一条（LRU-ish）。
    // 只在"要插入新 key"时才做，已有 key 的路径不受影响（不引入每条消息的开销）。
    if (!RATE_BUCKETS.has(key) && RATE_BUCKETS.size >= RATE_BUCKETS_MAX) {
        for (const [k, v] of RATE_BUCKETS) { if (now - v.ts > STALE_MS) RATE_BUCKETS.delete(k); }
        while (RATE_BUCKETS.size >= RATE_BUCKETS_MAX) {
            // Map 迭代顺序 = 插入顺序 ⇒ 第一个就是最旧的
            const oldest = RATE_BUCKETS.keys().next().value;
            if (oldest === undefined) break;
            RATE_BUCKETS.delete(oldest);
        }
    }
    let rl = RATE_BUCKETS.get(key);
    if (!rl) { rl = { tokens: capacity, ts: now }; RATE_BUCKETS.set(key, rl); }
    rl.tokens = Math.min(capacity, rl.tokens + ((now - rl.ts) / windowMs) * capacity);
    rl.ts = now;
    if (rl.tokens < 1) {
        console.warn(`[mindserver] 拒绝 ${label}：触发限流（${capacity} 次/${windowMs}ms，主体 ${subject}，来源 ${addr}）`);
        return false;
    }
    rl.tokens -= 1;
    return true;
}

/**
 * ── 凭据保管库 REST（R5 t15）────────────────────────────────────────────────
 *
 * 为什么是 REST 而不是再加一串 socket 事件：保管库是**配置面**（低频、有明确状态码、
 * 需要 curl 就能验），和"控制面"的 socket 事件不是一类东西；而且 token 门在
 * HTTP 层已经存在（见 createMindServer 里那道 `app.use`），挂在这条链**后面**
 * 就自动继承"无 token 一律 401"，不用再实现一遍鉴权。
 *
 * **这一层只搬运，不做密码学**：加解密/口令派生/落盘全在 `secrets_vault.js`。
 * 唯一属于 HTTP 的逻辑是：状态码映射 + 反爆破限流 + 把"锁定态"统一成 409。
 *
 * 明文边界（本轮最硬的约束，改这里之前先读一遍）：
 *   · 响应里**永远**没有 value —— 只有 name/hint/updatedAt/updatedBy；
 *   · 请求体里的 value 只在内存里过一手，进库即加密；
 *   · 日志只打名字，不打值；错误信息也只带名字。
 */
function attachVaultApi(app) {
    const router = express.Router();

    // 小请求体上限：一条 key 最多 4096 字符，32kb 足够，且不让这里变成上传口
    router.use(express.json({ limit: '32kb' }));
    // 凭据页的东西一律不许缓存（代理/浏览器历史里不该留下列表）
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    /**
     * unlock 的失败限流。
     *
     * 谁能打这个接口？—— 已经过了握手 token 门的人（= 本机可信客户端）。
     * 那还要限流吗？要：token 会泄漏（日志、截图、共享终端），而**口令是最后一道**。
     *
     * ★ T31 / W-2（T18 攻击测试判 WEAK，已修）：旧实现是
     *   **全局一份计数 + 先判限流后校验口令** ⇒ 第 6 次起**正确口令也 429**，
     *   持 token 者每 60 秒故意打错一次就能把管理员**永久**锁在门外。
     *   现在：计数**按来源分桶**（见 unlock_limiter.js），并且**先校验口令**，
     *   限流只决定"失败时回 401 还是 429"，**永不阻止一次正确的解锁**。
     *   口径：同一来源连续 5 次失败后，后续**失败**的尝试改回 429。
     */
    const unlockLimiter = createUnlockLimiter({ windowMs: 60_000, maxFails: 5 });
    const UNLOCK_WINDOW_MS = 60_000;   // 只用于文案
    /**
     * ★ R6 #30：scrypt 并发闸（同时最多 2 个）。限流刻意"先校验口令再看限流"，
     * 代价是没有并发上限 ⇒ 并发 /unlock 能把 CPU 打满（症状伪装成"任务板坏了"）。
     * 超出的立刻 429（可重试、不排队）；只管"同时在算几个"。
     */
    const unlockScryptGate = createConcurrencyGate({ max: 2 });

    /** 错误码 → HTTP 状态码（**唯一**一张表，别在路由里散着写 if）。 */
    const STATUS_OF = {
        [VAULT_ERROR.BAD_PASSPHRASE]: 401,
        [VAULT_ERROR.LOCKED]: 409,
        [VAULT_ERROR.NOT_INITIALIZED]: 409,
        [VAULT_ERROR.ALREADY_INITIALIZED]: 409,
        [VAULT_ERROR.BAD_NAME]: 400,
        [VAULT_ERROR.BAD_VALUE]: 400,
        [VAULT_ERROR.NOT_FOUND]: 404,
        [VAULT_ERROR.DECRYPT_FAILED]: 500,
    };

    function fail(res, e) {
        const code = e?.code && STATUS_OF[e.code] ? e.code : null;
        if (!code) {
            // 未预期的错：**不要**把 e.message 原样回出去（可能带着路径/内部细节）
            console.error('[vault] 未预期错误：', e?.stack ?? e?.message ?? e);
            res.status(500).json({ error: 'VAULT_INTERNAL' });
            return;
        }
        // message 由 library 提供，只含名字/口令问题，不含明文
        res.status(STATUS_OF[code]).json({ error: code, message: String(e.message || code) });
    }

    /** 锁定态门：除 status/init/unlock 之外一律 409。 */
    function requireUnlocked(req, res, next) {
        if (!vaultIsUnlocked()) {
            res.status(409).json({
                error: VAULT_ERROR.LOCKED,
                message: '保管库已锁定：先 POST /api/vault/unlock 解锁',
            });
            return;
        }
        next();
    }

    // ── 状态 ────────────────────────────────────────────────────────────
    router.get('/status', (req, res) => {
        res.json(vaultStatus());
    });

    // ── 初始化（只允许一次）──────────────────────────────────────────────
    router.post('/init', (req, res) => {
        const passphrase = req.body?.passphrase;
        try {
            vaultInit(passphrase);
            const r = injectEnvFromVault();
            console.log(`[vault] 已初始化并解锁（${r.injected} 项注入环境）`);
            res.status(201).json({ ok: true, unlocked: true, injected: r.injected });
        } catch (e) {
            fail(res, e);
        }
    });

    // ── 解锁 / 上锁 ─────────────────────────────────────────────────────
    /** 真正的解锁逻辑（并发闸在外层：见下面的 `/unlock` 路由）。 */
    function handleUnlock(req, res) {
        // ★ T31 / W-2：**先校验口令，再看限流**。
        //   顺序颠倒就是原来那个 WEAK：攻击者用错口令把额度耗尽后，管理员的**正确口令**
        //   也会被 429 挡在门外（长期 DoS）。限流只该决定"失败怎么回"，不该否决成功。
        const key = addressKeyOf(req);
        let unlocked = false;
        let error = null;
        try {
            vaultUnlock(req.body?.passphrase);
            unlocked = true;
        } catch (e) {
            error = e;
        }

        if (unlocked) {
            // 成功即清零该来源的失败计数（a 项）：成功后"再错一次"回到第 1 次，不是直接 429
            unlockLimiter.noteSuccess(key);
            const r = injectEnvFromVault();
            console.log(`[vault] 已解锁（${r.injected} 项注入环境，供新起的 agent 子进程继承）`);
            res.json({ ok: true, injected: r.injected });
            return;
        }

        if (error?.code === VAULT_ERROR.BAD_PASSPHRASE) {
            // 先看"失败之前"是否已经到上限：到上限 = 这是又一次失败 ⇒ 429；
            // 未到上限 = 正常失败 ⇒ 401（第 1~5 次都是 401，第 6 次起失败才 429）。
            // 这样"连续 5 次错口令"的口径与文案一致，也不会把第 5 次就判成"次数过多"。
            const wasThrottled = unlockLimiter.isThrottled(key);
            const n = unlockLimiter.noteFailure(key);
            if (wasThrottled) {
                console.warn(`[vault] 来源 ${key} 连续第 ${n} 次口令错误，已限流 ${Math.ceil(UNLOCK_WINDOW_MS / 1000)} 秒（正确口令仍可解锁）`);
                res.status(429).json({
                    error: 'VAULT_TOO_MANY_ATTEMPTS',
                    message: `口令错误次数过多，请等 ${Math.ceil(UNLOCK_WINDOW_MS / 1000)} 秒后再试`
                        + '（提示：正确口令任何时候都可用，限流只影响错误尝试）',
                });
                return;
            }
        }
        fail(res, error);
    }

    router.post('/unlock', (req, res) => {
        // ★ R6 #30：并发闸在**最前面** —— 连一次 scrypt 都不许排进队列。
        const releaseScrypt = unlockScryptGate.tryEnter();
        if (!releaseScrypt) {
            console.warn('[vault] 拒绝解锁：同时在算的解锁请求已达上限（2）');
            res.status(429).json({
                error: 'VAULT_BUSY',
                message: '同时解锁的请求过多（最多 2 个在算），请稍后重试（正确口令任何时候都能解锁）',
            });
            return;
        }
        try {
            handleUnlock(req, res);
        } finally {
            releaseScrypt();
        }
    });

    router.post('/lock', (req, res) => {
        // ★ 按验收口径字面执行："锁定态下除 status/init/unlock 外一律 409" —— **包括 /lock 自己**。
        //   直觉上"再锁一次"该是幂等的 200，但那会让"锁定态"出现一个 200 出口，
        //   验收脚本按"除三个例外外全 409"逐条打的时候会在这里判红。
        //   对客户端没有损失：面板只在已解锁时显示「上锁」按钮；要"确保已锁"看 /status 即可。
        if (!vaultIsUnlocked()) {
            res.status(409).json({
                error: VAULT_ERROR.LOCKED,
                message: '保管库当前已是锁定状态（无需重复上锁）',
            });
            return;
        }
        vaultLock();
        // 上锁 = 把注入过的环境变量也撤掉，否则"锁了但子进程还拿得到"是假的
        const r = clearInjectedEnv();
        console.log(`[vault] 已上锁（撤回 ${r.cleared} 项注入环境）`);
        res.json({ ok: true, locked: true });
    });

    // ── 条目（**永远不返回 value**）──────────────────────────────────────
    router.get('/items', requireUnlocked, (req, res) => {
        try {
            res.json(listSecrets());
        } catch (e) {
            fail(res, e);
        }
    });

    router.put('/items/:name', requireUnlocked, (req, res) => {
        const name = String(req.params.name || '');
        if (!NAME_PATTERN.test(name)) {
            res.status(400).json({
                error: VAULT_ERROR.BAD_NAME,
                message: '名字必须匹配 ^[A-Z][A-Z0-9_]{2,63}$（例如 OPENAI_API_KEY）',
            });
            return;
        }
        const value = req.body?.value;
        if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_BYTES) {
            res.status(400).json({
                error: VAULT_ERROR.BAD_VALUE,
                message: `值必须是非空字符串，长度 ≤ ${MAX_VALUE_BYTES}`,
            });
            return;
        }
        try {
            const item = setSecret(name, value, { updatedBy: 'panel' });
            // 立刻同步到 process.env：这样**已经解锁期间**新起的 agent 子进程能拿到新值，
            // 不用重启 mindserver。老值不会残留（同名直接覆盖）。
            injectEnvFromVault();
            console.log(`[vault] 已写入 ${name}（${item.hint}）`);   // hint 只有后 4 位
            res.json(item);
        } catch (e) {
            fail(res, e);
        }
    });

    router.delete('/items/:name', requireUnlocked, (req, res) => {
        const name = String(req.params.name || '');
        try {
            const r = removeSecret(name);
            uninjectEnv(name);
            if (!r.removed) {
                res.status(404).json({ error: VAULT_ERROR.NOT_FOUND, message: `保管库里没有 ${name}` });
                return;
            }
            console.log(`[vault] 已删除 ${name}`);
            res.json({ ok: true, removed: r.removed });
        } catch (e) {
            fail(res, e);
        }
    });

    // 兜底：这个前缀下的未知路径统一 404 JSON（别落到 SPA fallback 上返回 index.html）
    router.use((req, res) => {
        res.status(404).json({ error: 'NOT_FOUND', message: `没有这个接口：${req.method} ${req.baseUrl}${req.path}` });
    });

    app.use('/api/vault', router);
}

/**
 * ── 设置中心 REST（R5 t28）──────────────────────────────────────────────────
 *
 * 和 vault 那套同样的分层与同样的门：
 *   · 读写在 `config_center.js`（纯逻辑、可单测）；这里只做 HTTP 搬运与状态码映射；
 *   · 注册在握手 token 门**之后**（下面 createMindServer 里调用点紧跟 attachVaultApi），
 *     不新增鉴权面。
 *
 * 两条"别在这里加东西"的边界：
 *   ① **不回显密钥**：这里只回四组配置 + 只读元信息；密钥在保管库（/api/vault），
 *      且保管库也从不回显明文。
 *   ② **不在这里写盘**：所有落盘都走 config_center 的"先备份 + 定向改写 + 写后验加载"。
 */
function attachConfigApi(app) {
    const router = express.Router();
    router.use(express.json({ limit: '64kb' }));
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    const STATUS_OF = {
        [CONFIG_ERROR.BAD_GROUP]: 404,
        [CONFIG_ERROR.BAD_VALUE]: 400,
        [CONFIG_ERROR.UNKNOWN_KEY]: 400,
        [CONFIG_ERROR.BAD_JSON]: 500,
        [CONFIG_ERROR.WRITE_FAILED]: 500,
        [CONFIG_ERROR.SETTINGS_INVALID]: 500,
        // ★ R6 #28 / #29：两者都是"请求本身没错，但状态不允许现在这么做"，用 409 让前端区分
        //   "重读后重试" 与 "必须显式确认"（400 是值非法，别混）。
        [CONFIG_ERROR.CONFLICT]: 409,
        [CONFIG_ERROR.CONFIRM_REQUIRED]: 409,
    };

    function fail(res, e) {
        const code = e?.code && STATUS_OF[e.code] ? e.code : null;
        if (!code) {
            console.error('[config] 未预期错误：', e?.stack ?? e?.message ?? e);
            res.status(500).json({ error: 'CONFIG_INTERNAL' });
            return;
        }
        res.status(STATUS_OF[code]).json({ error: code, message: String(e.message || code) });
    }

    /**
     * 每个 agent 的 model / profile（**只读**，仅取三个字段）。
     *
     * 为什么从 `agent_connections` 取而不是读文件：agent 的 settings 只在
     * 它连上来时才有（`get-settings` 用的就是同一份），文件里没有"当前生效值"。
     * 只取 name/model/api 三个键，**绝不**把整个 settings 对象吐出去
     * （里面可能有 url/密钥之类，面板不需要）。
     */
    function agentInfo() {
        const out = [];
        for (const [name, conn] of Object.entries(agent_connections)) {
            const p = conn?.settings?.profile ?? {};
            out.push({
                name,
                model: typeof p.model === 'string' ? p.model : null,
                profile: typeof p.name === 'string' ? p.name : null,
                api: typeof p.api === 'string' ? p.api : null,
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * 配置里声明的 profile 文件（`settings.profiles`）→ 只读摘要。
     *
     * 同样只取 name/api/model：profile JSON 里可能有 `url`（中转站地址）甚至内嵌凭据，
     * 面板只需要"这个 profile 用哪个模型"，别把整个文件镜像出去。
     */
    function profileInfo() {
        const list = Array.isArray(rootSettings?.profiles) ? rootSettings.profiles : [];
        const mcRoot = path.join(__dirname, '..', '..');
        return list.map((rel) => {
            const file = String(rel);
            const abs = path.isAbsolute(file) ? file : path.join(mcRoot, file);
            const item = { file, name: null, api: null, model: null, ok: false };
            try {
                if (!existsSync(abs)) return { ...item, error: '文件不存在' };
                const raw = JSON.parse(readFileSync(abs, 'utf8'));
                return {
                    ...item,
                    ok: true,
                    name: typeof raw.name === 'string' ? raw.name : null,
                    api: typeof raw.api === 'string' ? raw.api : null,
                    model: typeof raw.model === 'string' ? raw.model : null,
                };
            } catch (e) {
                return { ...item, error: String(e?.message ?? e).slice(0, 120) };
            }
        });
    }

    // ── 读：四组当前值 + 生效方式元信息 ────────────────────────────────
    router.get('/', (req, res) => {
        try {
            // getAgents 传的是**函数**（活状态，每次读重新取），不是调好的结果
            res.json(readConfig({ getAgents: agentInfo, profiles: profileInfo() }));
        } catch (e) {
            fail(res, e);
        }
    });

    // ── 写：部分更新某一组 ──────────────────────────────────────────────
    router.put('/:group', (req, res) => {
        const group = String(req.params.group || '');
        if (!GROUP_META[group]) {
            res.status(404).json({
                error: CONFIG_ERROR.BAD_GROUP,
                message: `未知配置组：${group}（只有 ${Object.keys(GROUP_META).join(' / ')}）`,
            });
            return;
        }
        // updateConfigGroup 是 async（写完要 import 验一次）；浮空 Promise 会被
        // lint_hard 的 no-floating-promise 抓到，所以这里显式 await + catch。
        // ★ R6 #29：`confirm` 与 patch **分开传** —— patch 的每个键都要过 SCHEMA 校验，
        //   而 `confirm` 是个协议层的确认标记，不是配置项。
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
            ? { ...req.body }
            : req.body;
        let confirm = false;
        if (body && typeof body === 'object' && !Array.isArray(body)) {
            confirm = body.confirm === true;
            delete body.confirm;
        }
        updateConfigGroup(group, body, { log: console.log, warn: console.warn, confirm })
            .then((r) => {
                res.json({ ok: true, group: r.group, applied: r.applied, backup: r.backup, values: r.values });
            })
            .catch((e) => fail(res, e));
    });

    router.use((req, res) => {
        res.status(404).json({ error: 'NOT_FOUND', message: `没有这个接口：${req.method} ${req.baseUrl}${req.path}` });
    });

    app.use('/api/config', router);
}

export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);

    // ★★★ R4 S1#5 兜底：先装顶层 unhandledRejection / uncaughtException 处理，
    //   再往下注册所有事件处理器（任何一个异步处理器漏出去的异常都不再带走整个控制面）。
    installCrashGuards();

    // ── 握手 token（第一轮审查 第1条 ①）────────────────────────────────
    // 为什么需要它：只绑 localhost 挡不住「本机任意进程」，local_only.js 的 Origin 判据挡不住
    // 「不带 Origin 的脚本」。这里生成一个每次启动都不同的 token，io.use 校验；
    // 所有特权事件都在 io.on('connection') 里，所以全部落在这道门后。
    // 同用户进程仍能读到它（启动日志/env）—— 那不是这道门能解决的，见 auth_gate.js 顶部说明。
    handshakeToken = process.env.MINDSERVER_TOKEN || makeToken();
    // ★★★ R6 #2：**两份凭据**。
    //   `handshakeToken` = 面板凭据：写进 .mindserver-token、经 ?token= → HttpOnly cookie 交给浏览器、
    //   `scripts/start-panel.ps1` / tools 也读它。拿到它就等于「面板」。
    //   `agentToken` = agent 凭据：**只**通过 process.env.MINDSERVER_TOKEN 继承给子进程
    //   （AgentProcess 默认继承 process.env），从不进 cookie/HTTP 链路、不落盘。
    //   为什么必须分开：报告 #2 指出「同一个 bearer token 区分不了两类主体」——
    //   原来 `isPanelConnection()` 靠「有没有发 auth.token」判定，agent 不发就是面板、
    //   面板发了就是 agent，任何一类连接都能拿到另一类的权力。
    //   现在 agent 子进程默认**根本没有**面板凭据，破坏性事件只认握手时定下的角色。
    agentToken = makeToken();
    registerCredential(agentToken, ROLE_AGENT);
    // agent 子进程（AgentProcess 默认继承 process.env）拿的是 **agent 凭据**
    process.env.MINDSERVER_TOKEN = agentToken;

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
        // t20-C：新建文件会继承父目录 ACL ⇒ 立刻收口（异步、失败只 warn，不阻塞启动）
        hardenTokenFileAcl(TOKEN_FILE);
    } catch (e) {
        // 只读 cwd / 无权限也要能启动：降级为"只在显式开关下打印"
        console.warn(`[mindserver] 写 ${TOKEN_FILE} 失败（${e?.code ?? e}）；本次 token 只能通过 MINDSERVER_TOKEN 环境变量或 MINDSERVER_PRINT_TOKEN=1 获取`);
    }

    // ★ F-RT-003（2026-11-06）：token 文件**退出时删掉**，别让它长期躺盘上。
    // 为什么不在启动时删旧的：start-panel 要在**这次**启动后读它；所以只在进程退出时清。
    // 注意：这只是"减少留存窗口"，不是权限边界（同机其他账户仍可能在运行期读到，见 F-RT-001 手册）。
    const cleanupTokenFile = () => { try { if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE); } catch { /* ignore */ } };
    process.once('exit', cleanupTokenFile);
    // ⚠️ F-EXEC-102：这里**不再**自己挂 SIGINT/SIGTERM → process.exit(0)。
    //    原因：那会抢在 shutdownOnce()（下面的优雅关停入口）之前把进程退掉 ⇒ 子进程又变孤儿。
    //    现在信号统一由 shutdownOnce 接管，它最后 process.exit → 触发上面的 'exit' → 清理 token 文件。

    // 浏览器控制台：把 ?token=… 换成 HttpOnly + SameSite=Strict 的 cookie，之后同源握手自动带上。
    // 不这么做的话，面板（web/dist 已构建，改前端源码要重打包）会直接连不上。
    app.use((req, res, next) => {
        const fromQuery = typeof req.query?.token === 'string' ? req.query.token : null;
        if (fromQuery && fromQuery === handshakeToken) {
            if (!hasAuthCookie(req.headers.cookie, handshakeToken)) {
                res.setHeader('Set-Cookie', authCookieHeader(handshakeToken));
            }
            // ★ F-RT-003（2026-11-06，红队复测）：`?token=…` 会留在**地址栏 → 浏览器历史/书签同步**里，
            // 等于把 token 抄到另一个持久化位置。种完 cookie 就 302 到不带 token 的同一路径。
            //
            // ⚠️ 2026-11-06 真机验证修正（captain）：原实现对**任何**带 ?token= 的 GET 都 302 ——
            // 包括 /settings_spec.json 这类**数据接口**和 curl/脚本调用。它们不跟随重定向，
            // 直接拿 302 就失败了（实测：带 token 请求 settings_spec.json 得到 302 而非 200，
            // 且因为提前 return，连安全响应头都没设上）。
            // 正确边界：**只在"浏览器页面导航"时做这次重定向**（Accept 含 text/html），
            // 目的是把地址栏里的 token 抹掉；数据接口拿到 cookie 就够了，不需要也不应该被重定向。
            const isPageNavigation = req.method === 'GET'
                && String(req.headers.accept || '').includes('text/html');
            if (isPageNavigation) {
                const rest = { ...req.query };
                delete rest.token;
                const qs = new URLSearchParams(rest).toString();
                res.redirect(302, req.path + (qs ? `?${qs}` : ''));
                return;
            }
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
                '<ol><li>打开文件 <code>mindcraft/.mindserver-token</code>，复制里面的值</li>' +
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

    // ── 凭据保管库（R5 t15）─────────────────────────────────────────────
    //
    // 挂在这里而不是更上面：**必须在 token 门之后**（上面的 `app.use` 已经拦掉
    // 所有无 token 请求），这样 `/api/vault/*` 和其它入口共用同一道门，不新增鉴权面。
    // 挂在这里而不是更下面：静态资源与 SPA fallback 注册在后面，避免 `/api/vault/xxx`
    // 这种打错的路径被前端路由吞掉（返回 index.html 会让人以为"接口通了"）。
    attachVaultApi(app);

    // ── 设置中心（R5 t28）──────────────────────────────────────────────
    //
    // 与 vault 同一条链、同一道门、同样"必须在 static / SPA fallback 之前"。
    // 单独一行调用（而不是塞进 attachVaultApi）是为了让两组路由互不牵连：
    // 谁删了谁都能看出来，也不会出现"改设置中心顺手动了凭据路由"。
    attachConfigApi(app);

    // 无头启动便利口：MC_VAULT_PASSPHRASE 存在就自动解锁，并把内容注入进程环境
    // （agent 是子进程 ⇒ 只能靠 env 继承；不写盘）。
    // 锁着也**不报错**：保管库是可选的，没有它时 keys.js 照旧回落 keys.json。
    if (vaultIsInitialized()) {
        if (autoUnlockFromEnv()) {
            const r = injectEnvFromVault();
            console.log(`[vault] 已用 MC_VAULT_PASSPHRASE 自动解锁（${r.injected} 项注入环境）`
                + '；注意：口令在进程环境里对同机同账户可见，别把这条当默认做法');
        } else {
            console.log('[vault] 保管库存在但未解锁：面板「凭据」页解锁后，新起的 agent 才会拿到托管密钥'
                + (vaultIsInitialized() ? '（当前回落 keys.json / 环境变量）' : ''));
        }
    }

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
        // ★ R6 #1：板库目录必须**显式点名**。openBoard() 的默认值曾是 bots/_board（生产库），
        //   于是任何无参调用（含 tools/*_live.mjs 的 DELETE FROM jobs）都会直接清线上任务与预占。
        //   现在默认值已取消、无参即抛错；这里由控制面自己声明「我要的就是生产目录」。
        const board = openBoard(boardDirOf());
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
    //
    // ★ F-WEB-202（2026-11-06，按复核席裁决重做）：这里的真开销不是 `import()`（它本来就幂等），
    // 而是 `mcAssetsFactory(ver)` 的索引构建 + `readFileSync`。而**纯缓存在第一波并发上完全无效** ——
    // 攻击形态恰恰是 20 个请求同时打同一个 `oak_planks.png`。
    // 所以做三件事，缺一不可：
    //   ① **同 key 合并**：并发同 key 只跑一遍流水线，其余请求等同一次的结果；
    //   ② **并发上限**：总数有界，避免把主线程排队排死；
    //   ③ **8 秒硬超时 + finally 清理**：漏 finally 就是内存泄漏 + 该 key 永久卡在 in-flight（永久 503）。
    const TEX_INFLIGHT_MAX = 4;
    const TEX_TIMEOUT_MS = 8000;
    const TEX_CACHE_MAX = 300;
    const TEX_CACHE = new Map();        // key -> Buffer|null（null = 确认找不到，别反复重试）
    const TEX_INFLIGHT = new Map();     // key -> Promise<Buffer|null>

    /** 真正干活：返回 PNG Buffer，或 null（找不到）。**不碰 res**，这样才能被同 key 合并复用。 */
    async function fetchTextureBuffer(itemName, candidates) {
        const mod = await import('minecraft-assets');
        const mcAssetsFactory = mod.default || mod;
        for (const ver of candidates) {
            try {
                const assets = mcAssetsFactory(ver);
                const item = assets.items[itemName];
                const block = assets.blocks[itemName];
                const tex = assets.textureContent?.[itemName]?.texture
                    || (item ? assets.textureContent?.[itemName]?.texture : null)
                    || (block ? assets.textureContent?.[itemName]?.texture : null);
                if (tex && tex.startsWith('data:image')) {
                    return globalThis.Buffer.from(tex.split(',')[1], 'base64');
                }
                // textureContent 缺失时回落到包内静态路径（某些方块如 Leaf Litter 只在这里）
                const guessPaths = [
                    path.join(assets.directory, 'items', `${itemName}.png`),
                    path.join(assets.directory, 'blocks', `${itemName}.png`),
                ];
                for (const p of guessPaths) {
                    try {
                        const fsMod = await import('fs');
                        return fsMod.readFileSync(p);
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
        }
        return null;
    }

    /** 带"同 key 合并 + 缓存 + 并发上限 + 硬超时 + finally"的取图入口。 */
    async function getTexture(itemName, candidates) {
        const key = `${candidates.join('|')}:${itemName}`;
        if (TEX_CACHE.has(key)) return TEX_CACHE.get(key);
        if (TEX_INFLIGHT.has(key)) return TEX_INFLIGHT.get(key);      // ① 合并
        if (TEX_INFLIGHT.size >= TEX_INFLIGHT_MAX) {                  // ② 上限
            const e = new Error('texture proxy busy'); e.code = 'TEX_BUSY'; throw e;
        }
        const task = (async () => {
            let timer;
            try {
                // ③ 硬超时：无论底层卡在哪（import / 索引 / 读盘），8 秒后一定放手
                const timeout = new Promise((_, rej) => {
                    timer = setTimeout(() => {
                        const e = new Error('texture timeout'); e.code = 'TEX_TIMEOUT'; rej(e);
                    }, TEX_TIMEOUT_MS);
                    if (timer.unref) timer.unref();
                });
                const buf = await Promise.race([fetchTextureBuffer(itemName, candidates), timeout]);
                if (TEX_CACHE.size >= TEX_CACHE_MAX) TEX_CACHE.delete(TEX_CACHE.keys().next().value);
                TEX_CACHE.set(key, buf);
                return buf;
            } finally {
                clearTimeout(timer);
                TEX_INFLIGHT.delete(key);   // ← 漏这行 = 该 key 永久 503 + 内存泄漏
            }
        })();
        TEX_INFLIGHT.set(key, task);
        task.catch(() => { });   // 防 unhandled rejection 带走进程；结果由调用方 catch
        return task;
    }

    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            // F-SEC-104（2026-11-06）：路由参数经 Express decodeURIComponent 后可以是
            // `..%2f..%2fsettings` ⇒ `path.join(base,'items','../../settings.png')` 会跳出
            // assets.directory（只能读到 .png，但仍是任意 png 读取 + 存在性探测）。
            // 资源名合法字符集本就只有 [a-z0-9_]（物品/方块名），用白名单一刀切。
            if (!/^[a-z0-9_]{1,64}$/.test(itemName)) {
                res.status(400).json({ ok: false, error: 'invalid texture name' });
                return;
            }
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.8');

            let buf;
            try {
                buf = await getTexture(itemName, candidates);
            } catch (e) {
                if (e?.code === 'TEX_BUSY') {
                    res.status(503).json({ ok: false, error: 'texture proxy busy, retry later' });
                    return;
                }
                // 超时走这里：回 504，且**不缓存**（下次还能重试）
                res.status(504).json({ ok: false, error: 'texture proxy timeout' });
                return;
            }
            if (!buf) {
                res.setHeader('Content-Type', 'image/svg+xml');
                res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
                return;
            }
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');   // 贴图是静态资源
            res.end(buf);
        } catch (e) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // 新版控制台（web/ 用 Vue3 + Vite 构建）。
    //
    // ★ F1（2026-11-07 真机验收）：原来只认 `path.join(__dirname, '../../../web/dist')`，
    //   而容器里 __dirname=/app/src/mindcraft ⇒ 上溯三级是 **/web/dist**（在 /app 之外），
    //   永远不存在 ⇒ 镜像里 /console 静默 404，且**没有任何提示**（existsSync 守卫吞掉了）。
    //   现在改成候选列表，按顺序取第一个存在的：
    //     ① $WEB_DIST            —— 运维显式覆盖（挂载/自定义布局）
    //     ② <repo>/web/dist      —— 本机开发：直接 `node main.js` 时命中
    //                               （__dirname=/…/mindcraft/src/mindcraft 上溯三级 = 仓库根）
    //     ③ /app/web-dist        —— 镜像内：由 Dockerfile 的 `COPY web-dist ./web-dist` 提供
    //                                  （__dirname=/app/src/mindcraft 上溯两级 = /app）
    //   本机开发路径保持在原位且优先级更高，行为不变。
    //   全都找不到时**打一条 warn**，不让"缺 UI"变成无声失败。
    const webDistCandidates = [
        process.env.WEB_DIST,                              // ① 显式覆盖
        path.join(__dirname, '../../../web/dist'),         // ② 本机开发：仓库根 web/dist
        path.join(__dirname, '../../web-dist'),            // ③ 镜像：/app/web-dist
    ].filter(Boolean);
    const webDist = webDistCandidates.find((p) => {
        try { return existsSync(p); } catch { return false; }
    });
    if (webDist) {
        app.use('/console', express.static(webDist));
        // SPA fallback：/console/terrain 这类前端路由都回 index.html
        app.get(['/console', '/console/*'], (req, res) => {
            res.sendFile(path.join(webDist, 'index.html'));
        });
        console.log(`Console UI mounted at http://localhost:${port || 8080}/console (from ${webDist})`);
    } else {
        // F1：不许静默。缺 UI 时明确告诉运维"找过哪些路径、后果是什么"。
        console.warn('[mindserver] 未找到控制台 UI：/console 将返回 404。'
            + `已查找: ${webDistCandidates.join(' | ')}`
            + '（可用 WEB_DIST 环境变量指定固定路径）');
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
                // ★ R4 S3#20（F-WEB-204 同类第 4 处）：这里原来回 `dir: profilesDir` —— **本机绝对路径**
                //   （带用户名、目录结构），等于把前置侦察件交给任何持 token 的客户端；
                //   同一条消息里 `path` 已经改成 basename 了，`dir` 漏了。只回相对名。
                callback({ ok: true, dir: path.basename(profilesDir), profiles: out });
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

        // ---- 第四轮审计 ①：玩家身份绑定（面板 → 一次性码 → 游戏内 !claim）----
        //
        // 为什么由**面板**签发：面板持有人已经过握手 token 门（= 本机/可信客户端），
        // 是这套系统里唯一"能证明自己是谁"的一方。游戏内做不到（离线服务器不校验名字）。
        // 所以链路是：面板点"生成绑定码" → 这里造码写盘 → 人把码在游戏里输 `!claim ABCD-EFGH`
        // → agent 子进程核销并写 identity.json → 之后按 uuid 优先定级。
        //
        // 码的三条硬约束（都在 identity_store 里，这里只负责走流程）：
        //   ① 短时：TTL ≤ 5 分钟（传更大也会被压到 5 分钟）
        //   ② 单次：核销即删
        //   ③ 绑面板会话：码上记 socket.id；该 socket 断开 ⇒ 它签发的未核销码全部作废
        //
        // 诚实边界：码是**明文**写在 bots/<agent>/identity-codes.json 里。能读这个文件的人
        // 可以先自己核销（= 冒充主人）。本机制解决的是"游戏里改个名就冒充"，不是本机提权
        // （后者见 OPS-003 / F-RT-001；token 门与它同级，也不是权限边界）。

        /**
         * ★★★ R6 #2：是不是**面板**连接。
         *
         * 旧判据（已废）：`!isAgentIdentity(socket) && handshake.auth?.token == null`
         *   —— 也就是「**没发** auth.token 就算面板」。可 agent 也可以不发、面板也可以发，
         *   所以只要换一种携带方式（query/header/cookie）就能换一个身份；
         *   这根本不是鉴权，是一条语义标签。报告的结论是：
         *   「同一个 bearer token 区分不了两类主体」。
         *
         * 新判据：**握手时出示的凭据种类**（见 auth_gate.js 的 credentialRole）。
         *   面板凭据（?token=/cookie）⇒ socket.data.role = 'panel'；
         *   agent 凭据（子进程 env 继承）⇒ 'agent'。
         *   `null`（未知）一律当「不是面板」：管理面事件要求**明确证明**自己是面板。
         *
         * @returns {boolean} 这条连接能不能签发/查看/解绑身份、能不能执行管理面动作
         */
        const isPanelConnection = () => socketRole(socket) === ROLE_PANEL;

        /**
         * ★★★ R6 #2：管理面事件的统一闸门。
         *
         * 「管理面」= 会 spawn/杀进程、关服、改别的 agent 的东西：
         *   server-status/start/stop/log、create-agent、destroy-agent、restart-agent、
         *   start-agent、stop-agent、stop-all-agents、set-agent-settings、listen-to-agents、shutdown。
         * 这些以前**全部只落在握手门后**，而握手门对面板与 agent 是同一道 ——
         * 于是一个被提示注入的 bot 就能关掉整台机器上的控制面、批量杀 bot、起新进程。
         *
         * 现在：只有 `role==='panel'` 的连接能进来；agent 连接一律拒绝并留日志，
         * 同时回一个 `control-denied`（面板页面据此能说清"这次为什么没生效"）。
         *
         * @param {string} event 事件名（只用于日志/回执）
         * @param {Function} [ack] 可选 ack（有 ack 的事件既回 control-denied 也回 ack）
         * @returns {boolean} 放行 = true
         */
        const requirePanel = (event, ack) => {
            if (isPanelConnection()) return true;
            const role = socketRole(socket) ?? 'unknown';
            console.warn(`[mindserver] 拒绝 ${event}：这是管理面事件，只允许面板连接（当前角色=${role}）`);
            const payload = { event, reason: 'panel_only', role };
            try { if (typeof ack === 'function') ack({ ok: false, ...payload }); } catch { /* 客户端已断开 */ }
            try { socket.emit('control-denied', payload); } catch { /* 断开中 */ }
            return false;
        };

        /**
         * 只接受已注册的 agent 名；返回规范化名字或 null。
         * （不是"任意字符串"—— 否则可以拿它当路径拼接的入口去碰别的目录。）
         */
        const knownAgent = (agentName) => {
            const name = typeof agentName === 'string' ? agentName.trim() : '';
            return name && Object.prototype.hasOwnProperty.call(agent_connections, name) ? name : null;
        };

        socket.on('identity-status', (agentName, callback) => {
            const cb = typeof callback === 'function' ? callback : () => { };
            if (!isPanelConnection()) {
                console.warn(`[mindserver] 拒绝 identity-status：只允许面板连接（agent 通道不能签发/查看/解绑身份）`);
                cb({ ok: false, reason: 'panel_only' }); return;
            }
            const name = knownAgent(agentName);
            if (!name) { cb({ ok: false, reason: 'unknown_agent' }); return; }
            if (!takeToken(socket, 'identity-status', 30, 60000)) { cb({ ok: false, reason: 'rate_limited' }); return; }
            try {
                const codeRead = readStore(codesFileOf(name));
                const idRead = readStore(identityFileOf(name));
                const st = previewStatus(codeRead.store);
                const bindings = previewStatus(idRead.store).bindings;
                // ★ t27：面板要能显示"当前是离线还是正版 + owner 策略"，
                //   否则用户不知道自己处在哪种状态（也就无从判断要不要去开正版验证）。
                let modeInfo = null;
                let modeError = null;
                try {
                    const online = readServerOnlineMode();
                    const cfg = (rootSettings?.identity_binding && typeof rootSettings.identity_binding === 'object')
                        ? rootSettings.identity_binding : {};
                    const pol = resolveIdentityPolicy({
                        onlineMode: online.onlineMode,
                        offlineOwnerMode: cfg.offline_owner_mode,
                        sessionMinutes: cfg.offline_session_minutes,
                    });
                    modeInfo = {
                        onlineMode: online.onlineMode,          // true/false/null(读不到)
                        source: online.source,
                        effective: pol.effective,               // persistent | session | deny
                        uuidTrusted: pol.uuidTrusted,
                        sessionMinutes: pol.sessionMinutes,
                        reason: pol.reason,
                    };
                } catch (e) {
                    // ★ R6 #74：原来裸 catch {} ⇒ 面板只看到 mode:null，分不清"读不到"与"正常"。
                    //   现在把原因带回（新增字段 modeError，既有字段语义不变）。
                    modeError = String(e?.message ?? e).slice(0, 160);
                    console.warn(`[mindserver] identity-status：读身份策略失败（面板会显示 unknown）：${modeError}`);
                }
                cb({
                    ok: true,
                    agent: name,
                    mode: modeInfo,
                    modeError,
                    // t2 移交（R6 #69）：身份表损坏时 t2 会改名留证（readStore 带回 corrupt/backup）。
                    // 透出去，面板才能说"身份表损坏、已留证 <路径>"，而不是只看到"一个绑定都没有"。
                    corrupt: idRead.corrupt === true,
                    backup: idRead.backup ?? null,
                    // t8 残留：码表（identity-codes.json）损坏此前没透出 —— 面板只知道"没有待用码"，
                    // 分不清"真的没有"与"码表坏了"。补两个字段，口径与身份表一致。
                    codesCorrupt: codeRead.corrupt === true,
                    codesBackup: codeRead.backup ?? null,
                    // 码本身不在这里回（它只出现在"刚生成"那一次的回执里）——
                    // 免得任何持 token 的客户端随手一拉就能捡走别人还没用的码。
                    pendingCodes: st.codes.map((c) => ({ expiresAt: c.expiresAt, sessionId: c.sessionId })),
                    bindings,
                });
            } catch (e) {
                cb({ ok: false, reason: String(e?.message ?? e) });
            }
        });

        socket.on('identity-issue-code', (agentName, callback) => {
            const cb = typeof callback === 'function' ? callback : () => { };
            if (!isPanelConnection()) {
                console.warn(`[mindserver] 拒绝 identity-issue-code：只允许面板连接（agent 通道不能签发/查看/解绑身份）`);
                cb({ ok: false, reason: 'panel_only' }); return;
            }
            const name = knownAgent(agentName);
            if (!name) { cb({ ok: false, reason: 'unknown_agent' }); return; }
            if (!takeToken(socket, 'identity-issue-code', 5, 60000)) { cb({ ok: false, reason: 'rate_limited' }); return; }
            try {
                const code = makeCode();
                const file = codesFileOf(name);
                // ★ R6 #21：写前 CAS（见 mutateStoreFile 的说明）—— 面板签发与游戏内核销
                //   是两个进程，裸的"读-算-写"会让刚签发的码被抹掉、或让已核销的码复活。
                const added = mutateStoreFile(file, (store) => {
                    const r = addCode(store, {
                        code, agent: name, sessionId: socket.id ?? null, ttlMs: DEFAULT_CODE_TTL_MS,
                    });
                    return { store: r.store, result: r.record };
                }, {
                    what: `${name} 的绑定码表`,
                    verify: (store) => store.codes.some((c) => c.code === code),
                });
                if (!added.ok) { cb({ ok: false, reason: `写码失败：${added.reason}` }); return; }
                console.log(`[mindserver] 为 ${name} 生成身份绑定码（5 分钟有效，单次使用，会话 ${socket.id ?? '-'}）`);
                cb({ ok: true, agent: name, code, expiresAt: added.result.expiresAt, ttlMs: DEFAULT_CODE_TTL_MS });
            } catch (e) {
                cb({ ok: false, reason: String(e?.message ?? e) });
            }
        });

        socket.on('identity-unbind', (agentName, who, callback) => {
            if (typeof who === 'function') { callback = who; who = {}; }
            const cb = typeof callback === 'function' ? callback : () => { };
            if (!isPanelConnection()) {
                console.warn(`[mindserver] 拒绝 identity-unbind：只允许面板连接（agent 通道不能签发/查看/解绑身份）`);
                cb({ ok: false, reason: 'panel_only' }); return;
            }
            const name = knownAgent(agentName);
            if (!name) { cb({ ok: false, reason: 'unknown_agent' }); return; }
            if (!takeToken(socket, 'identity-unbind', 10, 60000)) { cb({ ok: false, reason: 'rate_limited' }); return; }
            try {
                const file = identityFileOf(name);
                const uuid = typeof who?.uuid === 'string' ? who.uuid : null;
                const person = typeof who?.name === 'string' ? who.name : null;
                if (!uuid && !person) { cb({ ok: false, reason: 'need_uuid_or_name' }); return; }
                // ★ R6 #21：写前 CAS —— 绑定表同样与 agent 侧的读写并发。
                const out = mutateStoreFile(file, (store) => {
                    const r = revokeBinding(store, { uuid, name: person });
                    return { store: r.store, result: r.removed };
                }, { what: `${name} 的身份表` });
                if (!out.ok) { cb({ ok: false, reason: `写绑定表失败：${out.reason}` }); return; }
                console.log(`[mindserver] 已解绑 ${name} 的玩家 ${person ?? uuid}（移除 ${out.result} 条）`);
                cb({ ok: true, agent: name, removed: out.result });
            } catch (e) {
                cb({ ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ---- 配置向导：paper 服务进程管理 ----
        // ★ R6 #2：这四条是**管理面**（起/停 Minecraft 服务、读服务端日志）。
        //   agent 子进程不需要它们；原来它们在握手门后对谁都开放 ——
        //   一个被提示注入的 bot 可以 `server-stop` 把整个服关掉。现在只给面板。
        socket.on('server-status', async (callback) => {
            const cb = typeof callback === 'function' ? callback : () => { };
            if (!takeToken(socket, 'server-status', 60, 60000)) { cb({ ok: false, reason: 'rate_limited' }); return; }
            if (!requirePanel('server-status', cb)) return;
            try { cb(await procCtrl.getStatus()); }
            catch (e) { cb({ ok: false, reason: String(e && e.message || e) }); }
        });

        socket.on('server-start', async (callback) => {
            const cb = typeof callback === 'function' ? callback : () => { };
            if (!takeToken(socket, 'server-start', 6, 60000)) { cb({ ok: false, reason: 'rate_limited' }); return; }
            if (!requirePanel('server-start', cb)) return;
            try { cb(await procCtrl.startServer()); }
            catch (e) { cb({ ok: false, reason: String(e && e.message || e) }); }
        });

        socket.on('server-stop', async (callback) => {
            const cb = typeof callback === 'function' ? callback : () => { };
            if (!takeToken(socket, 'server-stop', 6, 60000)) { cb({ ok: false, reason: 'rate_limited' }); return; }
            if (!requirePanel('server-stop', cb)) return;
            try { cb(await procCtrl.stopServer()); }
            catch (e) { cb({ ok: false, reason: String(e && e.message || e) }); }
        });

        socket.on('server-log', (n, callback) => {
            if (typeof n === 'function') { callback = n; n = 80; }
            const cb = typeof callback === 'function' ? callback : () => { };
            if (!takeToken(socket, 'server-log', 30, 60000)) { cb({ ok: false, reason: 'rate_limited' }); return; }
            if (!requirePanel('server-log', cb)) return;
            try { cb({ ok: true, lines: procCtrl.tailLog(n) }); }
            catch (e) { cb({ ok: false, reason: String(e && e.message || e) }); }
        });

        socket.on('create-agent', async (settings, callback) => {            console.log('API create agent...');
            // 客户端可能只带一个 ack 函数（畸形事件也要能安全应答）
            if (typeof settings === 'function' && callback === undefined) { callback = settings; settings = undefined; }
            // ★ R4 S1#5：**ack 必须永远安全**。原来是裸 `callback(...)`：客户端 emit 时
            //   不带 ack ⇒ TypeError: callback is not a function ⇒ async 处理器抛 ⇒
            //   （Node 22）未处理的 Promise 拒绝 ⇒ 整个控制面退出。现在统一走 ack()。
            const ack = (payload) => {
                if (typeof callback !== 'function') return;
                try { callback(payload); } catch (e) {
                    console.warn(`[mindserver] create-agent 回执失败（客户端可能已断开）：${e?.message ?? e}`);
                }
            };
            // ★ F-WEB-203：`create-agent` 会 **spawn 一个新 bot 进程**（连 MC 服务器、吃内存与 LLM 配额），
            // 原来完全无限流 ⇒ 单连接可无限拉起 agent。按来源限 5 次/60 秒。
            if (!takeToken(socket, 'create-agent', 5, 60000)) {
                ack({ success: false, error: '太频繁：create-agent 限 5 次/分钟' });
                return;
            }
            // ★ R6 #2：spawn 新进程 = 管理面动作，只给面板。
            if (!requirePanel('create-agent', () => ack({ success: false, error: 'panel_only' }))) return;
            // ★★★ R4 S1#5：**先校验形状**（null / 字符串 / 数组 / profile 不是对象 ⇒ 当场拒绝）。
            //   不做这一步的话，下面 `key in settings` 会抛 TypeError ⇒ 打挂整个控制面。
            {
                const shapeErr = validateSettingsShape(settings);
                if (shapeErr) {
                    console.warn(`[mindserver] create-agent 拒绝非法 settings：${shapeErr}`);
                    ack({ success: false, error: shapeErr });
                    return;
                }
            }
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        ack({ success: false, error: `Setting ${key} is required` });
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
            // ★ F-EXEC-112（2026-11-06）：**按 spec 校验 type / options**。
            //
            // 原来这段只读 `required` 与 `default`，`type` 与 `options` **全仓零读取**
            // ⇒ 前端传什么类型都收（`port: "abc"`、`auth: "whatever"`、`load_memory: "false"` 都会进到 agent），
            // 到了 agent 侧才以各种莫名错误炸开，排查时完全指不到"是面板传错了"。
            // 现在在**入口**就拒，并且给出**可读原因**（不是静默丢弃、也不是静默接受）。
            //
            // 两条宽容规则（都有日志，不算静默）：
            //   · `number` 接受"能表示成有限数字的字符串"（面板输入框天然产出字符串），**转成数字并 warn**；
            //   · `boolean` 只接受真布尔（`"false"` 字符串**不接受** —— 它 truthy，静默转 true 会埋雷）。
            {
                const bad = schemaViolation(settings, settings_spec);
                if (bad) {
                    console.warn(`[mindserver] create-agent 拒绝非法 settings：${bad}`);
                    ack({ success: false, error: bad });
                    return;
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
                    ack({ success: false, error: nameCheck.msg });
                    return;
                }
                if (settings.profile.name in agent_connections) {
                    // ★ R6 #72：**残留条目**（进程已自己退出、通道也断了）不该挡住重建。
                    //   原来只在 destroy-agent 成功时删表，而子进程自杀走的是 unregister → destroyAgent
                    //   （mindcraft 只管 agent_processes）⇒ agent_connections 里留下**永久**条目：
                    //   面板显示"还在"、同名 create-agent 被永久拒（Agent already exists）。
                    if (isStaleAgentConn(settings.profile.name)) {
                        console.warn(`[mindserver] create-agent：${settings.profile.name} 的注册项是残留`
                            + '（无进程、无通道），先摘掉再重建');
                        delete agent_connections[settings.profile.name];
                    } else {
                        ack({ success: false, error: 'Agent already exists' });
                        return;
                    }
                }
                let returned;
                try {
                    returned = await mindcraft.createAgent(settings);
                } catch (e) {
                    console.error('[mindserver] create-agent 失败：', e);
                    ack({ success: false, error: String(e?.message ?? e) });
                    return;
                }
                ack({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    // ★ R4 S1#4：确认退出之后才摘掉注册项（destroyAgent 自己会等；这里 await 是因为
                    //   它现在返回 Promise —— 不 await 就会在子进程还活着时先删 conn，留下孤儿）
                    await mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                ack({ success: false, error: 'Agent name is required in profile' });
            }
        });

        /**
         * ★ R6 #27 + #25：读设置收口 —— 限流 20/min；agent 连接只能读自己那一条
         * （身份取服务端判定，未绑定时退回凭据归属）；名字过 knownAgent（原型链键不再是 agent 名）；
         * ack 永远安全。面板仍可读任意已注册项（设置页的正常路径）。
         */
        socket.on('get-settings', (agentName, callback) => {
            const cb = typeof callback === 'function' ? callback : () => { };
            if (!takeToken(socket, 'get-settings', 20, 60000)) { cb({ error: 'rate_limited' }); return; }
            const wanted = knownAgent(agentName);
            if (!wanted) { cb({ error: `Agent '${agentName}' not found.` }); return; }
            if (socketRole(socket) === ROLE_AGENT) {
                const owner = socket?.data?.agentName ?? credentialAgent(tokenFromSocket(socket));
                // ★ T7-1：owner 取不到时要 fail-closed，不能短路成"放行读任意 agent"。
                if (!owner) {
                    console.warn('[mindserver] 拒绝 get-settings：agent 连接没有可归属的身份（未绑定也未映射凭据）');
                    cb({ error: 'identity-unbound' });
                    return;
                }
                if (owner !== wanted) {
                    console.warn(`[mindserver] 拒绝 get-settings(${wanted})：agent 连接只能读自己的设置（本连接 = ${owner}）`);
                    cb({ error: 'identity-only' });
                    return;
                }
            }
            cb({ settings: agent_connections[wanted].settings });
        });

        /**
         * ★★★ R4 S2#9：把某个 agent 的通道绑到这条连接上 —— **要求 agent 身份 + 唯一占用**。
         *
         * 缺陷原貌：这两个事件都没有身份校验，任何持 token 的面板连接都能把自己绑成 agent 通道
         * （`chat-message` 转发给"最后绑上来的那个 socket"），而且两个同名 agent 会互相踢，
         * 玩家消息一半丢、`in_game` 一跳一跳。现在统一走 claimAgentChannel 的裁决，
         * 并且把"被接管"明说给旧连接（不静默换主人）。
         *
         * @returns {boolean} 是否绑定成功
         */
        function bindAgentChannel(agentName, why) {
            const conn = agent_connections[agentName];
            if (!conn) {
                console.warn(`[mindserver] ${why}: 未注册的 agent ${JSON.stringify(agentName)}（可能已删除）`);
                return false;
            }
            const claim = claimAgentChannel(conn, socket, {
                agentIdentity: isAgentIdentity(socket),
                credentialAgentName: credentialAgent(tokenFromSocket(socket)),
                requestedName: agentName,
            });
            if (!claim.ok) {
                console.warn(`[mindserver] ${why} 拒绝绑定 ${agentName}（${claim.reason}）：` +
                    `来源 socket=${socket.id ?? '?'}，当前持有者 socket=${claim.previous?.id ?? '-'}` +
                    (claim.reason === 'identity-required' ? '（只有 agent 进程自己可以占用 agent 通道）'
                        : claim.reason === 'identity-mismatch' ? '（这份凭据不属于这个名字：每只 bot 的凭据只能占用自己的名字）'
                        : ''));
                try { socket.emit('agent-channel-rejected', { agent: agentName, reason: claim.reason }); } catch { /* 断开中 */ }
                return false;
            }
            if (claim.takeover && claim.previous) {
                console.warn(`[mindserver] agent 通道接管：${agentName} 旧连接 socket=${claim.previous.id ?? '?'} → ` +
                    `新连接 socket=${socket.id ?? '?'}（${claim.reason}）—— 旧连接已摘除`);
                // 明确告诉被顶掉的那条连接（原来是"静默换主人"，面板/旧进程都不知道自己已经不在通道上了）
                try { claim.previous.emit('agent-channel-taken-over', { agent: agentName }); } catch { /* 断开中 */ }
                try { claim.previous.disconnect?.(true); } catch { /* 已经断了 */ }
            }
            conn.socket = socket;
            // ★ R6 #2：把「这条连接是哪个 agent」写成**服务端判定**的戳。
            //   任务板（board_server.js）需要知道"你是谁"才能拒绝冒充：原来它只能取
            //   `payload.bot`（客户端自述 ⇒ 任何连接都能声称自己是任意 bot）。
            //   这里的值来自 agent 自己声明的名字 **+ 服务端唯一占用裁决**（claimAgentChannel），
            //   下游（board:hello 等）据此比对，就不再是"自报"了。
            //   诚实边界：仍是"持有 agent 凭据的进程"粒度，不是每 agent 一份凭据（见 control.md 残留）。
            try {
                if (!socket.data) socket.data = {};
                socket.data.agentName = agentName;
            } catch { /* 桩 socket 不可写：下游按"无绑定"处理 */ }
            return true;
        }

        socket.on('connect-agent-process', (agentName) => {
            if (bindAgentChannel(agentName, 'connect-agent-process')) agentsStatusUpdate();
        });

        socket.on('login-agent', (agentName) => {
            if (!bindAgentChannel(agentName, 'login-agent')) return;
            agent_connections[agentName].in_game = true;
            curAgentName = agentName;
            agentsStatusUpdate();
        });

        socket.on('disconnect', () => {
            // ★ R4 S2#9：只有**当前持有者**断开才清空 —— 否则被接管的旧连接迟到的 disconnect
            //   会把新主人的绑定抹掉（表现为"刚起来就 in_game=false、收不到玩家消息"）。
            if (curAgentName && agent_connections[curAgentName]?.socket === socket) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
            // ★ 第四轮审计 ①：面板会话断开 ⇒ 它签发的**未核销**绑定码作废
            //   （"绑定当前面板会话"的另一半；已绑定成功的条目不受影响）。
            try {
                const sid = socket.id;
                if (sid) {
                    for (const name of Object.keys(agent_connections)) {
                        const file = codesFileOf(name);
                        // ★ R6 #21：写前 CAS + "没有我的码就什么都不写"（幂等）。
                        //   原来这里是裸的"读 → 判 → 写"，与游戏内核销并发时能把**已核销**的码
                        //   写回去（复活一次性码）。
                        const out = mutateStoreFile(file, (store) => {
                            if (!store.codes.some((c) => c.sessionId === sid)) return null;
                            const r = revokeSessionCodes(store, sid);
                            return r.removed > 0 ? { store: r.store, result: r.removed } : null;
                        }, {
                            what: `${name} 的绑定码表`,
                            verify: (store) => !store.codes.some((c) => c.sessionId === sid),
                        });
                        if (out.ok && out.result > 0) {
                            console.log(`[mindserver] 面板会话 ${sid} 断开：作废 ${out.result} 个未核销绑定码（${name}）`);
                        }
                    }
                }
            } catch (e) {
                console.warn(`[mindserver] 作废面板绑定码失败（不影响其他功能）：${e?.message ?? e}`);
            }
        });

        /**
         * ★ R6 #26：chat-message 补身份校验 —— 只有 agent 身份能发（面板走 send-message）；
         * 目标过 knownAgent；载荷要形状（message 非空、≤2000）；限流 30/10s。
         * 原来任何持 token 连接都能向任意 bot 注入"聊天消息"（进 LLM 上下文 = 提示注入）。
         */
        socket.on('chat-message', (agentName, json) => {
            if (!isAgentIdentity(socket)) {
                console.warn(`[mindserver] 丢弃伪造的 chat-message：连接不是 agent 身份，声称目标=${JSON.stringify(agentName)}`
                    + '（面板发玩家消息请用 send-message）');
                return;
            }
            if (!takeToken(socket, 'chat-message', 30, 10000)) return;
            const targetName = knownAgent(agentName);
            if (!targetName) {
                console.warn(`[mindserver] 丢弃 chat-message：未知目标 ${JSON.stringify(agentName)}`);
                return;
            }
            const target = agent_connections[targetName];
            // 停掉的 agent socket 为 null，原来直接 .socket.emit 会让 mindserver 崩（同 D25）
            if (!target?.socket) {
                console.warn(`Agent ${targetName} tried to send a message but is not logged in`);
                return;
            }
            const message = json?.message;
            if (typeof message !== 'string' || !message || message.length > 2000) {
                console.warn(`[mindserver] 丢弃 chat-message：message 形状非法（${typeof message}`
                    + `${typeof message === 'string' ? `，长度 ${message.length}` : ''}）`);
                return;
            }
            console.log(`${curAgentName} sending message to ${targetName}: ${message}`);
            target.socket.emit('chat-message', curAgentName, json);
        });

        // 第1条 ②：运行期设置只走白名单。allow_insecure_coding（= 远程开代码执行 = 本机 root）、
        // blocked_actions（清空即可放出 !newAction 等被封命令）、profile（里面是 owner 名单）
        // 一律丢弃并告警，不再「照存 + 重启生效」。
        socket.on('set-agent-settings', (agentName, settings) => {
            // ★ R6 #2：运行期改别人的设置 = 管理面动作（面板「设置」页用）。
            //   agent 子进程不需要它（它自己的配置走 get-settings 读回），所以只给面板 + 限流。
            if (!takeToken(socket, 'set-agent-settings', 30, 60000)) return;
            if (!requirePanel('set-agent-settings')) return;
            // ★ R6 #25：原来是 `agent_connections[agentName]` —— `'constructor'` 拿到 `Object`
            //   构造函数（真值）⇒ `agent.setSettings` 不是函数 ⇒ 抛进 socket.io 派发。一律过 knownAgent()。
            const wanted = knownAgent(agentName);
            if (!wanted) {
                console.warn(`[mindserver] 忽略 set-agent-settings：未知 agent ${JSON.stringify(agentName)}`);
                return;
            }
            const agent = agent_connections[wanted];
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
            // ★ F-WEB-203：`restart-agent` 循环比"刷消息"更伤可用性 —— 每点一次就杀一个 bot 进程
            // 再拉起，反复点能把机器拖垮。按来源限 3 次/60 秒（正常使用远低于此）。
            if (!takeToken(socket, 'restart-agent', 3, 60000)) return;
            // ★ R6 #2：重启 agent = 管理面动作，只给面板（agent 不能重启别人/自己）。
            if (!requirePanel('restart-agent')) return;
            // D25：停掉的 agent socket 为 null（面板上重启按钮仍可点），原来这里直接崩掉整个 mindserver
            // ★ R6 #25：名字一律过 knownAgent（原型链键不再是"任意字符串 = agent 名"）。
            const restartName = knownAgent(agentName);
            if (!restartName) {
                console.warn(`[mindserver] 忽略 restart-agent：未知 agent ${JSON.stringify(agentName)}`);
                return;
            }
            const conn = agent_connections[restartName];
            if (!conn?.socket) {
                console.warn(`Agent ${agentName} is not running, cannot restart`);
                return;
            }
            conn.socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            // ★ R6 #2：停一只是管理面动作（原来完全无限流、也不区分主体）。
            if (!takeToken(socket, 'stop-agent', 10, 60000)) return;
            if (!requirePanel('stop-agent')) return;
            // ★ R6 #25：stopAgent('constructor') 原来会直接打到进程表上（原型链键）。
            const stopName = knownAgent(agentName);
            if (!stopName) {
                console.warn(`[mindserver] 忽略 stop-agent：未知 agent ${JSON.stringify(agentName)}`);
                return;
            }
            mindcraft.stopAgent(stopName);
            agentsStatusUpdate();
        });

        socket.on('start-agent', async (agentName) => {
            // ★★ R4 S1#3：`start-agent` 原来**完全无限流**，而它会走 forceRestart（= spawn 进程）。
            //   按来源限 6 次/60 秒（正常使用远低于此：点一次启动/重启算一次）。
            //   注意限流只是外层；真正的双开闸在 AgentProcess.start()（running 时拒绝）与
            //   forceRestart()（并发保护 + 等旧进程退出），两层都在。
            if (!takeToken(socket, 'start-agent', 6, 60000)) {
                console.warn(`[mindserver] 拒绝 start-agent：触发限流（6 次/60s）`);
                return;
            }
            // ★ R6 #2：起进程 = 管理面动作，只给面板。
            if (!requirePanel('start-agent')) return;
            const r = await mindcraft.startAgent(agentName);
            if (r && r.started === false) {
                console.warn(`[mindserver] start-agent 未生效（${r.reason}）：${agentName}` +
                    (r.exited === false ? ' —— 旧进程未确认退出，拒绝再起一个（否则就是双开）' : ''));
                try { socket.emit('start-agent-failed', { agent: agentName, reason: r.reason }); } catch { /* 断开中 */ }
            }
            agentsStatusUpdate();
        });

        socket.on('destroy-agent', async (agentName) => {
            // ★★ R4 S1#4：`destroy-agent` 原来 fire-and-forget：`stop()` 发个 SIGINT 就 `delete` 表项。
            //   忽略 SIGINT 的子进程仍然活着（孤儿）⇒ 继续领单/续租，而控制面**再也管不到它**。
            //   现在：等确认退出（SIGINT → 等 → SIGKILL → 再等）；没确认就**不删**，
            //   并把失败原因回给面板（面板据此提示"还在跑，请查进程表"）。
            if (!takeToken(socket, 'destroy-agent', 3, 60000)) {
                console.warn(`[mindserver] 拒绝 destroy-agent：触发限流（3 次/60s）`);
                return;
            }
            // ★ R6 #2：删 agent（连注册表一起）是管理面动作，只给面板。
            if (!requirePanel('destroy-agent')) return;
            // ★ R6 #25：`agent_connections['constructor']` 是真值 ⇒ 原来会一路打到 destroyAgent。
            const destroyName = knownAgent(agentName);
            if (!destroyName) {
                console.warn(`[mindserver] 忽略 destroy-agent：未知 agent ${JSON.stringify(agentName)}`);
                return;
            }
            const r = await mindcraft.destroyAgent(destroyName);
            if (!r?.ok) {
                console.error(`[mindserver] destroy-agent ${agentName} 未确认退出（${r?.reason}）—— **保留注册表**（孤儿仍在领单/续租，需要人工查进程表）`);
                try { socket.emit('destroy-agent-failed', { agent: agentName, reason: r?.reason ?? 'unknown' }); } catch { /* 断开中 */ }
                return;
            }
            delete agent_connections[agentName];
            console.log(`[mindserver] destroy-agent ${agentName}：已确认退出（${r.reason}${r.escalated ? '，强杀' : ''}），注册项已删除`);
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            // ★★★ R6 #2：这是「一键杀光全部 bot」—— 原来**既不判角色也不限流**，
            //   于是任何持 token 的连接（含每个 agent 子进程）都能把整套控制面清空。
            //   现在：管理面动作 ⇒ 只给面板 + 按来源限流。
            if (!takeToken(socket, 'stop-all-agents', 3, 60000)) return;
            if (!requirePanel('stop-all-agents')) return;
            console.log('Killing all agents');
            // ★ R6 #25 / #75：`for...in` 会把原型链上的键一起枚举（`constructor`/`toString`…）。
            //   "枚举注册表"这件事必须只走**自有键**。
            for (const name of Object.keys(agent_connections)) {
                mindcraft.stopAgent(name);
            }
        });

        /**
         * ★★★ R6 #2：`shutdown` —— 关掉**整套**控制面（含任务板、所有 bot）。
         *
         * 缺陷原貌：任何持 token 的连接发一条 `shutdown` 就够了（`shutdownOnce('socket')` →
         * `process.exit(0)`），而 panel / agent 从来没有被区分过。
         *
         * 现在的口径（**判据全在服务端，agent 发来的东西只算"请求"，不算"授权依据"**）：
         *   ① 面板连接 ⇒ 直接允许（面板该能关服）。
         *   ② agent 连接 ⇒ 只有一种情形允许：**服务端启动时自己被配置成任务模式**
         *      （`settings.task` 有 task_id），且这条连接登记的 agent 的配置里就是**那一个** task。
         *      这是既有正常路径：「跑完任务 → 整套退出」（`agent.js` 的 `checkTaskDone → killAll`）。
         *      判据取自 `rootSettings.task` 与 `agent_connections[name].settings.task`（服务端状态），
         *      不取 agent 自述；agent 若额外带了 `task_id`，必须与启动配置**相等**，否则拒绝。
         *   ③ 同一个 task 只允许触发一次（幂等）：第二次回 `already-finished`，不再重复收尾。
         *   ④ 其它一切（agent 在面板模式、未知角色）⇒ 拒绝 + `control-denied`。
         */
        socket.on('shutdown', (payload) => {
            const ack = typeof payload === 'function' ? payload : null;
            const claim = (payload && typeof payload === 'object' && !ack) ? payload : {};

            if (isPanelConnection()) {
                // F-EXEC-102（2026-11-06）：不再"发信号 + 2 秒后硬退"，走 shutdownAndWait。
                shutdownOnce('socket');
                if (ack) { try { ack({ ok: true, accepted: true, by: 'panel' }); } catch { /* 断开中 */ } }
                return;
            }

            const deny = (reason) => {
                console.warn(`[mindserver] 拒绝 shutdown（${reason}）：当前角色=${socketRole(socket) ?? 'unknown'}` +
                    '。关服是管理面能力，只给面板；agent 只有在任务模式下、且完成的是启动时配置的那个 task 才允许收尾。');
                try { socket.emit('control-denied', { event: 'shutdown', reason, role: socketRole(socket) ?? null }); } catch { /* 断开中 */ }
                if (ack) { try { ack({ ok: false, reason, accepted: false }); } catch { /* 断开中 */ } }
            };

            if (socketRole(socket) !== ROLE_AGENT) { deny('panel_only'); return; }

            const bootTaskId = taskIdOf(rootSettings?.task);
            if (!bootTaskId) { deny('not-task-mode'); return; }

            const name = agentNameOfSocket(socket);
            if (!name) { deny('agent-not-bound'); return; }

            const agentTaskId = taskIdOf(agent_connections[name]?.settings?.task);
            if (agentTaskId && agentTaskId !== bootTaskId) {
                deny(`task-mismatch（本连接登记的是 ${agentTaskId}，启动配置的是 ${bootTaskId}）`);
                return;
            }
            if (claim && claim.task_id != null && String(claim.task_id) !== bootTaskId) {
                // agent 自述的 task 只能**收窄**许可，不能扩大。
                deny(`claimed-task-mismatch（${String(claim.task_id)} ≠ ${bootTaskId}）`);
                return;
            }
            if (taskModeShutdownFired) {
                console.warn(`[mindserver] 忽略重复的 shutdown（task ${bootTaskId} 已经收尾过）`);
                try { socket.emit('control-denied', { event: 'shutdown', reason: 'already-finished', task_id: bootTaskId }); } catch { /* 断开中 */ }
                if (ack) { try { ack({ ok: false, reason: 'already-finished', accepted: false }); } catch { /* 断开中 */ } }
                return;
            }

            taskModeShutdownFired = true;
            console.log(`[mindserver] 任务模式收尾：agent ${name} 报告 task ${bootTaskId} 结束 ⇒ 由**服务端**收整套` +
                '（这是启动配置决定的行为，不是 agent 的权限）');
            if (ack) { try { ack({ ok: true, accepted: true, by: 'server-task-mode', task_id: bootTaskId }); } catch { /* 断开中 */ } }
            shutdownOnce('agent-task-done');
        });

		socket.on('send-message', (agentName, data) => {
			// ★ R6 #25：`agent_connections['constructor']` 是真值（`Object` 构造函数）⇒ 下面 `.socket`
			//   会抛错。名字一律先过 knownAgent()。
			const sendTo = knownAgent(agentName);
			if (!sendTo) {
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
			// F-WEB-203：send-message 限 30 条/10 秒/来源。桶按**远端地址**共享
			// （挂 socket.data 上时断开重连即重置，可无限绕过 —— 复核席指出）。
			// 与 restart-agent / create-agent / listen-to-agents 共用同一个 takeToken 实现，
			// 只是 capacity/window 不同（见各处调用）。
			if (!takeToken(socket, 'send-message', 30, 10000)) return;
			if (!data || typeof data.from !== 'string' || !data.from || data.from.length > 32) {
				console.warn(`[mindserver] 拒绝 send-message：from 非法（${JSON.stringify(data?.from ?? null)}）`);
				return;
			}
			try {
                agent_connections[sendTo].socket.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            // ★ F-WEB-101（2026-11-06）：过去这里原样 io.emit 转发，不校验发送方 ⇒
            // 任何持 token 的面板客户端都能伪造"某个 bot 说了某句话"，把排障日志污染成假象。
            // 只有 **agent 自己的连接** 有权发这两类事件：agent 走 `auth:{token}`（见 mindserver_proxy），
            // 面板走 HttpOnly cookie（web/src/api/socket.ts 不带 auth payload）⇒ 两者可区分。
            if (!isAgentIdentity(socket)) {
                console.warn(`[mindserver] 丢弃伪造的 bot-output：连接未以 agent 身份（auth.token）互联，声称 agent=${JSON.stringify(agentName)}`);
                return;
            }
            io.emit('bot-output', agentName, message);
        });

        // agent 进程把结构化事件推上来 → 广播给所有面板（诊断页的事件流）
        socket.on('agent-event', (agentName, e) => {
            // ★ F-WEB-101：同 bot-output —— 只有 agent 自己的连接能发结构化事件，
            // 否则面板客户端可以伪造"挖矿失败/离线/单子卡住"这类诊断事件，误导排障。
            if (!isAgentIdentity(socket)) {
                console.warn(`[mindserver] 丢弃伪造的 agent-event：连接未以 agent 身份互联，声称 agent=${JSON.stringify(agentName)}`);
                return;
            }
            io.emit('agent-event', agentName, e);
        });

        socket.on('listen-to-agents', () => {
            // ★★★ R4 S2#10：**幂等**。已经订阅过的连接直接忽略 —— 不消耗限流令牌、不重复注册 relay、
            //   不会再往 agent_listeners 里塞第二个自己（原来重复 push ⇒ 同一个 socket 被 emit 两次
            //   `state-update`，而且 removeListener 只摘掉一个，剩下的永远留在集合里 ⇒
            //   `agent_listeners.length` 归不了零 ⇒ 1 Hz 轮询**永不停止**）。
            if (agent_listeners.includes(socket)) return;
            // ★ R6 #2：订阅状态广播是**面板**的能力（1 Hz 轮询 + relay 注册都会推高服务端负载）。
            //   agent 不订阅这个（它发 bot-output/agent-event，方向相反），所以只给面板。
            if (!requirePanel('listen-to-agents')) return;
            // ★ F-WEB-203：`listen-to-agents` 会让这个 socket 进入广播订阅集合（服务端按 socket 计数
            // 起计时器），原来无限流 ⇒ 单连接反复订阅可推高服务端负载。按来源限 10 次/60 秒。
            if (!takeToken(socket, 'listen-to-agents', 10, 60000)) return;
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    // ★★★ OPS-010（2026-11-06 深度检查）：绑定地址必须**可显式配置**，否则容器里根本连不上。
    //
    //   缺陷原貌：这里硬编码 `'localhost'`，而 docker-compose 发布的是容器 8080 端口。
    //   容器内的 localhost 是容器自己的回环 ⇒ 宿主机经发布端口**永远访问不到**控制台；
    //   而 compose 里 `- 8080` 不指定宿主端口，宿主实际随机映射，脚本里硬编码的 8080 也对不上。
    //
    //   修法：默认**仍然只绑回环**（安全默认不变），需要时用 MIND_SERVER_HOST 显式放开
    //   （容器里设 0.0.0.0）。安全边界没有松动 —— token + Host/Origin 校验照旧，
    //   而宿主侧仍需显式把端口映射到 127.0.0.1:8080（见 docker-compose.yml 的注释与 README）。
    const host = (process.env.MIND_SERVER_HOST || 'localhost').trim() || 'localhost';
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        // ★ R6 #23：HTTP 门只看 token，而 socket.io 的 Host 白名单仍是本机名 ⇒ 容器里
        // "页面能打开、永远连不上"。这里读 MIND_SERVER_ALLOWED_HOSTS 加开，并说清后果。
        const extraHosts = String(process.env.MIND_SERVER_ALLOWED_HOSTS || '')
            .split(',').map((s) => s.trim()).filter(Boolean);
        console.log(`[mindserver] ⚠ 监听 ${host}：控制台将对本机以外的来源可达。`
            + '请确认已启用 token，并且只在可信网络里这样做。');
        if (extraHosts.length === 0) {
            console.warn('[mindserver] ⚠ 但 socket.io 的 Host 白名单仍只有本机名 ⇒ 用 `http://<非本机名>` 打开面板时'
                + '握手会被拒（页面能加载、连不上）。需要走这条路时显式设 '
                + 'MIND_SERVER_ALLOWED_HOSTS=<宿主IP 或域名>[,...]（逗号分隔）。');
        } else {
            console.log(`[mindserver] socket.io Host 白名单已加开：${extraHosts.join(', ')}`
                + '（来源仍由 token + Host/Origin 双判据把关，不是"对外网无鉴权"）');
        }
    }
    // ★ F-EXEC-102（2026-11-06）：**唯一的关停入口**（socket 的 shutdown 事件 + SIGINT/SIGTERM 共用）。
    // 幂等：重复触发（例如连点两次"停止面板"，或 Ctrl-C 与 socket 同时来）只跑一次。
    // 走 mindcraft.shutdownAndWait：等每个子进程确认退出，超时则 SIGKILL，最后才 exit。
    let __shuttingDown = false;
    function shutdownOnce(trigger = 'unknown') {
        if (__shuttingDown) { console.log(`[shutdown] 已在关停中，忽略重复触发（${trigger}）`); return; }
        __shuttingDown = true;
        console.log(`[mindserver] 开始关停（触发源：${trigger}）`);
        Promise.resolve()
            .then(() => mindcraft.shutdownAndWait?.({ graceMs: 5000, killGraceMs: 3000, exitAfter: true }))
            // shutdownAndWait 正常路径会自己 process.exit；走到这里说明它抛了 ⇒ 别把进程挂死
            .catch((e) => {
                console.error('[mindserver] 关停过程出错，直接退出：', e?.message ?? e);
                globalThis.process.exit(1);
            });
    }
    // 崩溃/正常退出前也要走同一条路（原来**一个信号处理器都没有**，Ctrl-C 直接死、子进程全成孤儿）
    for (const sig of ['SIGINT', 'SIGTERM']) {
        try { globalThis.process.once(sig, () => shutdownOnce(`signal:${sig}`)); } catch { /* ignore */ }
    }

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
        // ★ OPS-003（2026-11-06 深度检查）[P1]：把"离线模式 + 监听所有网卡 ⇒ 名字可冒用"
        //   变成启动时的一条明确告警。这不是自动改配置（那会打断局域网/手机，
        //   报告的处置是三选一、需用户拍板），而是**让风险在每次启动时可见**。
        //   读不到配置就静默跳过 —— 这条告警不该成为启动失败的原因。
        try {
            const propsPath = path.join(__dirname, '..', '..', '..', 'server', 'server.properties');
            if (existsSync(propsPath)) {
                const txt = readFileSync(propsPath, 'utf8');
                const owners = [];
                // 主服白名单就是"会被按名字授予 owner 的那批名字"最贴近的近似（config/network.json）
                try {
                    const netCfg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'network.json'), 'utf8'));
                    const players = netCfg?.servers?.main?.players;
                    if (Array.isArray(players)) owners.push(...players.filter(x => typeof x === 'string'));
                } catch { /* 没有 network.json 就只按通用口径告警 */ }
                const risk = assessFromProperties(txt, owners);
                const warn = renderOfflineIdentityWarning(risk);
                if (warn) console.warn(warn);
            }
        } catch (e) {
            console.warn('[mindserver] OPS-003 风险自检跳过（读配置失败）：', e?.message ?? e);
        }

        // ★★ R4 t13 升级提示：**这条默认变更是会"立刻生效"的**。
        //   身份绑定默认开启 ⇒ 以前靠"名字 = permissions.owner"拿权限的人，
        //   升级后第一条命令就会被拒（这是有意的 fail-closed，不是故障）。
        //   所以启动时**主动说一次**，并给出两条出路（取码绑定 / 显式退回 legacy）。
        //   只在"一台都没绑定过"时提示：绑定过就说明用户已经走过流程了，不必再刷屏。
        try {
            const botsDir = botsRootOf();
            let boundTotal = 0;
            if (existsSync(botsDir)) {
                for (const d of readdirSync(botsDir)) {
                    try {
                        const f = path.join(botsDir, d, 'identity.json');
                        if (!existsSync(f)) continue;
                        boundTotal += readStore(f).store.bindings.length;
                    } catch { /* 单个目录坏了不影响总数判断 */ }
                }
            }
            if (boundTotal === 0) {
                console.warn('[mindserver] 还没有任何玩家身份绑定。身份绑定默认开启（第四轮审计 ①）：');
                console.warn('            ⇒ 玩家现在**不会**因为游戏名写在 profile 的 permissions.owner 里就拿到权限。');
                console.warn('            ⇒ 让玩家在游戏里发 !claim <码>：码在控制台选中 agent 后点「生成绑定码」获取（5 分钟内有效、只能用一次）。');
                console.warn('            ⇒ 想暂时退回"按名字"的老行为（**等于放弃防冒名**）：profile 里设 '
                    + '"permissions": { ..., "identity": { "legacy_profile_names": true } }。');
            }
        } catch (e) {
            console.warn('[mindserver] 身份绑定状态自检跳过：', e?.message ?? e);
        }

        // ★★★ R4 t20：**离线服的根本限制**，启动时必须说一次（不能只写在文档里等人翻）。
        //   为什么：`online-mode=false` 时服务端给玩家发的 uuid 是 **由名字 MD5 派生**的
        //   （minecraft-protocol 的 javaUUID('OfflinePlayer:'+name)）⇒ 任何人把客户端名改成
        //   主人的名字，就拿到**同一个 uuid** ⇒ 身份绑定按 uuid 精确命中 ⇒ 直接 owner。
        //   也就是说：**t13 那层保护在离线服上不存在**，能做的只有"识别出来 + 降级 + 说清楚"。
        try {
            // ★ t27：不再自己写正则 —— 走 readServerOnlineMode（唯一判据入口）
            const online = readServerOnlineMode();
            const onlineMode = online.onlineMode;
            const identityCfg = (rootSettings?.identity_binding && typeof rootSettings.identity_binding === 'object')
                ? rootSettings.identity_binding : {};
            const identityOn = identityCfg.enabled !== false;
            if (onlineMode === false && identityOn) {
                const minutes = Number(identityCfg.offline_session_minutes ?? 720) || 720;
                const policy = resolveIdentityPolicy({
                    onlineMode, offlineOwnerMode: identityCfg.offline_owner_mode, sessionMinutes: minutes,
                });
                console.warn('[mindserver] ⚠ 离线模式（server.properties: online-mode=false）+ 身份绑定已启用。');
                console.warn('            ⇒ 离线模式下**uuid 由名字派生**（OfflinePlayer:<名字>）：同名 = 同 uuid，');
                console.warn('              冒名者改个客户端名就能命中主人的绑定 ⇒ **按身份授权挡不住冒用**。');
                console.warn(`            ⇒ 当前生效策略 = "${policy.effective}"（identity_binding.offline_owner_mode = `
                    + `"${identityCfg.offline_owner_mode ?? 'session'}"，窗口 ${minutes} 分钟）：`
                    + (policy.effective === 'session'
                        ? `仅刚 !claim 后的 ${minutes} 分钟内授 owner，其余时间只聊天（降低暴露窗口，不是证明身份）。`
                        : '这类"弱绑定"在离线服上一律只聊天（owner 不可达）。'));
                console.warn('            ⇒ 想切成正版验证（之后 owner 持久有效，且不可被同名冒用）：');
                console.warn('               ① 改 config/network.json 的 servers.main.onlineMode = true；');
                console.warn('               ② node tools/server-net.mjs apply  ③ 重启 Minecraft 服务器。');
                console.warn('            ⇒ 根治只有两条（需要你拍板，代码不会替你改）：');
                console.warn('               ① 开正版验证：server.properties 设 online-mode=true（客户端须正版登录）；');
                console.warn('               ② 装登录插件（如 AuthMe）：让玩家用密码注册登录，身份由插件保证。');
            }
        } catch (e) {
            console.warn('[mindserver] 离线模式判定跳过：', e?.message ?? e);
        }
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    // ★ R6 #75（Nice）：`for...in` 会把原型链上的键一起枚举（与 #25 同一根因）；
    //   这里每秒广播，偶发的继承键会变成"一条假 agent"。只走自有键。
    for (const agentName of Object.keys(agent_connections)) {
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
/** ★ R4 S2#10：已经注册过 relay 的 socket（WeakSet：socket 断开即自然回收，不需要清理表）。 */
const relayedSockets = new WeakSet();

/**
 * ★★★ R4 S2#10：订阅状态流 + 地图 relay —— **必须幂等**。
 *
 * 缺陷原貌（`mindserver.js:962-964`）：`addListener` 无脑
 *   `registerMapRelay(socket); agent_listeners.push(socket);`
 *   · 同一个 socket 订阅两次 ⇒ 集合里有两个自己 ⇒ 每秒收到两份 `state-update`；
 *   · `registerMapRelay` 里的 `socket.on(...)` 是**追加**语义 ⇒ request-map / request-terrain /
 *     get-events … 各被注册两份，一次请求变成两次 `agent.socket.emit`（重复拉地图/重复读库）；
 *   · `disconnect` 只 `removeListener` 一次 ⇒ 集合里还剩一个引用 ⇒ `length === 0` 永远不成立
 *     ⇒ **1 Hz 轮询永不停止**（服务端每秒还在给一个已断开的 socket emit）。
 *
 * 现在：同一 socket 重复调用 = 无操作；relay 每个 socket 只注册一次;集合归零就停表。
 *
 * @returns {boolean} 这次调用是否真的新增了订阅
 */
export function addListener(listener_socket) {
    if (!listener_socket) return false;
    if (agent_listeners.includes(listener_socket)) return false;   // 幂等
    registerMapRelay(listener_socket);   // 地图按需拉取，不进每秒 state-update
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) startStatePolling();
    return true;
}

/** 起 1 Hz 状态轮询（已启动则不动；集合归零时由 stopStatePolling 停掉）。 */
function startStatePolling() {
    if (listenerInterval) return false;
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
            // ★ R6 #31：并发拉取（Promise.all + 每只独立 5s 超时 + 整轮 6s 兜底），
            //   不再逐只串行 await（原来 10 只卡住 = 面板状态停更 50s）。
            const targets = Object.keys(agent_connections)
                .map((name) => [name, agent_connections[name]])
                .filter(([, agent]) => agent && agent.in_game && agent.socket);

            const fetchOne = (name, agent) => new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ name, ok: false, reason: 'state timeout' }), 5000);
                try {
                    agent.socket.emit('get-full-state', (s) => {
                        clearTimeout(timer);
                        resolve({ name, ok: true, state: s });
                    });
                } catch (e) {
                    clearTimeout(timer);
                    resolve({ name, ok: false, reason: String(e?.message ?? e) });
                }
            });

            const round = Promise.all(targets.map(([name, agent]) => fetchOne(name, agent)));
            const settled = await Promise.race([
                round,
                new Promise((resolve) => {
                    const t = setTimeout(() => resolve(null), 6000);
                    // 不因为这个兜底计时器让进程退不掉
                    try { t.unref?.(); } catch { /* ignore */ }
                }),
            ]);

            for (const [name, agent] of targets) {
                const hit = Array.isArray(settled) ? settled.find((r) => r.name === name) : null;
                if (hit?.ok) {
                    agent.last_state = hit.state;
                    states[name] = hit.state;
                } else if (agent.last_state) {
                    states[name] = agent.last_state;
                } else {
                    states[name] = { error: String(hit?.reason ?? 'state timeout') };
                }
            }
            for (const listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        } finally {
            polling = false;
        }
    }, 1000);
    // 不因为这个定时器而让进程退不掉（真正的存活责任在 http server 上）
    try { listenerInterval?.unref?.(); } catch { /* ignore */ }
    return true;
}

/** 停 1 Hz 状态轮询。 */
function stopStatePolling() {
    if (!listenerInterval) return false;
    clearInterval(listenerInterval);
    listenerInterval = null;
    return true;
}

/** 仅供测试/诊断：1 Hz 状态轮询是否还在跑（"轮询永不停止"这条缺陷的判据）。 */
export function isStatePolling() {
    return listenerInterval !== null;
}

// 前端按需请求某只 bot 的地图（低频，不进每秒的 state-update）
function registerMapRelay(socket) {
    if (!socket) return false;
    // ★ R4 S2#10：每个 socket 只注册一次。`socket.on` 是**追加**语义，
    //   重复调用会把 request-map/request-terrain/诊断 relay 注册成多份 ⇒
    //   一次请求变成 N 次 `agent.socket.emit`（重复扫库/重复拉地形）。
    if (relayedSockets.has(socket)) return false;
    relayedSockets.add(socket);
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
    return true;
}

/**
 * 退订。★ R4 S2#10：**必须容忍"不在集合里"**（断开时可能已经退过、或从未订阅过）。
 * 原来 `splice(indexOf(x), 1)` 在 indexOf 返回 -1 时是 `splice(-1,1)` —— 删掉的是**最后一个**
 * 监听者：别人还订阅着，被这一下清掉后就再也收不到状态了（而 1 Hz 轮询还以为在服务）。
 *
 * @returns {boolean} 这次调用是否真的移除了一个订阅
 */
export function removeListener(listener_socket) {
    const i = agent_listeners.indexOf(listener_socket);
    if (i === -1) return false;
    agent_listeners.splice(i, 1);
    if (agent_listeners.length === 0) stopStatePolling();
    return true;
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