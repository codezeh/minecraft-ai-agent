/**
 * mindserver 的「握手门」（第一轮审查 第 1 条 ①/②）。
 *
 * 缺陷原貌：mindserver 只是绑在 localhost，**没有任何认证**。
 *   - `send-message`（`mindserver.js:392-402`）把 `data.from` 原样转发给 agent，
 *     而「我是谁」在 agent 侧直接决定权限等级 —— 任何本机脚本/页面自称主人即可拿 owner 级权限；
 *   - `set-agent-settings`（`:336-343`）能把运行期设置改成任意值（含 `allow_insecure_coding`），
 *     还能把 `blocked_actions` 清空（`blocked_actions=[]` 等于把 `!newAction` 这些被封的命令放出来）；
 *   - `server-stop`（`:239-242`）/`shutdown`（`:379-390`）直接关服/`process.exit(0)`。
 *
 * 修复分两层，都在这个文件里：
 *   ① **握手 token**：mindserver 启动时 `crypto.randomUUID()` 生成，`io.use(...)` 校验；
 *      `send-message` / `set-agent-settings` / `server-stop` / `shutdown` 全部落在 `io.on('connection')`
 *      里，因此全部落在这道门后（没 token 根本进不到事件注册那一层）。
 *   ② **字段白名单**：`set-agent-settings` 只接受 `SAFE_RUNTIME_SETTINGS` 里的字段，
 *      `allow_insecure_coding` / `blocked_actions` / `profile` 直接丢弃并告警。
 *
 * token 怎么到客户端手里（三种，都是「同一个 token」）：
 *   - 浏览器控制台：打开 `http://localhost:<port>/?token=<token>`，HTTP 层换成 HttpOnly +
 *     SameSite=Strict 的 cookie，之后 socket.io 握手自动带上（同源 / 同主机，cookie 不分端口，
 *     所以 vite 代理的开发模式也照常工作）。别家网页拿不到：跨源读不到 cookie，
 *     而且 SameSite=Strict 的 cookie 根本不会随后者发出的握手送出去。
 *   - agent 子进程：mindserver 把 token 写进 `process.env.MINDSERVER_TOKEN` 再 spawn，子进程继承。
 *   - 本机脚本 / 探针：`MINDSERVER_TOKEN=<token> node xxx.mjs`。
 *
 * **诚实的边界**：这不是「进程隔离」。同一操作系统用户下的任意进程仍能读到启动日志里的 token
 * 或父进程环境变量 —— 那是同用户权限模型本身的问题，不是这道门能解决的。这道门挡的是
 * 「没有 token 的本机脚本 / 任意网页」：随机 UUID 每次启动都不同，硬编码 `ws://127.0.0.1:8080`
 * 的老脚本、以及浏览器里任何网站的页面，都进不来了。
 *
 * 单测：tools/mindserver_gate_unit.mjs
 */
import crypto from 'crypto';

/** cookie 名（HttpOnly，前端 JS 读不到，只用于 socket.io 握手自动携带）。 */
export const TOKEN_COOKIE = 'mindserver_token';

/** 非浏览器客户端用的自定义头。 */
export const TOKEN_HEADER = 'x-mindserver-token';

/** 生成一个握手 token。`MINDSERVER_TOKEN` 环境变量在 mindserver 侧优先（便于本机脚本对接）。 */
export function makeToken() {
    return crypto.randomUUID();
}

/** 定长口令比较（长度不同直接判失败，长度相同走 timingSafeEqual）。 */
export function tokenEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
    } catch {
        return false;
    }
}

/** 从 `Cookie:` 头里取某个 cookie 的值。 */
export function cookieValue(cookieHeader, name) {
    if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== name) continue;
        return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
}

/**
 * 从一次 socket.io 握手里取出客户端出示的 token。
 * 顺序：auth payload → 自定义头 → URL query → cookie。
 * @param {object} handshake socket.handshake（或同形状的桩）
 * @returns {string|null}
 */
export function tokenFromHandshake(handshake) {
    const h = handshake || {};
    const fromAuth = h.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth) return fromAuth;
    const headers = h.headers || {};
    const fromHeader = headers[TOKEN_HEADER];
    if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
    const fromQuery = h.query?.token;
    if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
    const fromCookie = cookieValue(headers.cookie, TOKEN_COOKIE);
    if (typeof fromCookie === 'string' && fromCookie) return fromCookie;
    return null;
}

/** 这次握手是不是带了正确 token。 */
export function isAuthorizedHandshake(handshake, expectedToken) {
    return tokenEquals(tokenFromHandshake(handshake), expectedToken);
}

/**
 * 给 socket.io 的 `io.use(...)` 用的中间件：token 不对就断开，**不注册任何事件处理器**。
 * 注意 `next(err)` 的 err 会被 socket.io 送到客户端 `connect_error`；
 * `err.data.code` 是给前端看的稳定标识。
 */
export function makeHandshakeGate(expectedToken) {
    if (typeof expectedToken !== 'string' || !expectedToken) {
        throw new Error('makeHandshakeGate 需要 non-empty token');
    }
    return function handshakeGate(socket, next) {
        if (isAuthorizedHandshake(socket?.handshake, expectedToken)) return next();
        const hints = socket?.handshake?.headers || {};
        console.warn(
            `[mindserver] 拒绝未握手的连接 host=${JSON.stringify(hints.host ?? null)} ` +
            `origin=${JSON.stringify(hints.origin ?? null)}（缺 token 或 token 不对；` +
            `浏览器请用启动日志打印的 http://localhost:<port>/?token=… 打开控制台）`,
        );
        const err = new Error('unauthorized: mindserver 需要握手 token');
        err.data = { code: 'AUTH_REQUIRED' };
        return next(err);
    };
}

/** HTTP 层给浏览器发的 Set-Cookie 值（HttpOnly：JS 读不到；SameSite=Strict：别站发起的握手不带它）。 */
export function authCookieHeader(token) {
    return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

/** 请求里已经带了正确的 cookie 吗（避免重复 Set-Cookie）。 */
export function hasAuthCookie(cookieHeader, expectedToken) {
    return tokenEquals(cookieValue(cookieHeader, TOKEN_COOKIE), expectedToken);
}

/**
 * `set-agent-settings` 允许改的运行期字段白名单。
 *
 * 取值来自 `src/mindcraft/public/settings_spec.json`（面板本来就只发这些），
 * 三条**故意排除**：
 *   - `allow_insecure_coding`：等于「远程开代码执行 = 本机 root」；
 *   - `blocked_actions`：清空它等于把 `!newAction` 等被封命令放出来，和上面等价；
 *   - `profile`：里面是 `permissions`（谁是这个 bot 的主人），改它等于自己给自己发权限。
 * 单测会断言这三个不在表里、且表里每个键都真的存在于 settings_spec（防拼错后静默丢弃）。
 */
export const SAFE_RUNTIME_SETTINGS = Object.freeze([
    'minecraft_version', 'host', 'port', 'auth', 'base_profile', 'load_memory',
    'init_message', 'only_chat_with', 'speak', 'language', 'allow_vision',
    'relevant_docs_count', 'max_messages', 'num_examples', 'max_commands',
    'narrate_behavior', 'log_all_prompts', 'show_command_syntax', 'chat_ingame',
    'chat_bot_messages', 'render_bot_view', 'code_timeout_mins', 'spawn_timeout',
]);

/** 落在白名单外的字段（无论值是什么，一律丢弃）。 */
export function rejectedSettingKeys(settings) {
    if (!settings || typeof settings !== 'object') return [];
    return Object.keys(settings).filter((k) => !SAFE_RUNTIME_SETTINGS.includes(k));
}

/**
 * 按白名单过滤一份 `set-agent-settings` 载荷。
 * @param {object} settings 客户端发来的设置
 * @returns {{settings: object, dropped: string[]}}
 */
export function sanitizeAgentSettings(settings) {
    const out = {};
    const dropped = [];
    if (!settings || typeof settings !== 'object') return { settings: out, dropped };
    for (const [k, v] of Object.entries(settings)) {
        if (SAFE_RUNTIME_SETTINGS.includes(k)) out[k] = v;
        else dropped.push(k);
    }
    return { settings: out, dropped };
}
