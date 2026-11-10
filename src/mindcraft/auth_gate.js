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
 * **诚实的边界**：这不是「进程隔离」。同一操作系统用户下的任意进程仍能读到 `.mindserver-token`
 * 文件（已 gitignore）或父进程环境变量 —— 那是同用户权限模型本身的问题，不是这道门能解决的。
 * （F-SEC-205 起完整 token 已不再打进启动日志，只打指纹；但同一个用户仍能直接读那个文件。）
 * 这道门挡的是
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

/**
 * 从 `Cookie:` 头里取某个 cookie 的值。
 *
 * SEC-001（2026-11-06 深度检查）修复：原来这里直接 `decodeURIComponent(raw)`。
 * 客户端只要发 `Cookie: mindserver_token=%`，`decodeURIComponent` 就抛 URIError；
 * 而这条链是**鉴权判定期间**执行的（tokenFromHandshake → cookieValue → decodeURIComponent），
 * 异常穿过 Socket.IO 握手中间件逃出 Namespace.run，整个 mindserver 进程退出。
 * 也就是说「一个不需要正确 token 的畸形请求」就能让控制面不可用。
 *
 * 现在的口径：**解码失败 = 没带这个 cookie**（返回 null），由上层按「未授权」正常拒绝。
 * 鉴权路径上不允许任何客户端可控输入把进程带崩。
 * 单测：tools/sec001_cookie_unit.mjs
 */
export function cookieValue(cookieHeader, name) {
    if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== name) continue;
        const raw = part.slice(i + 1).trim();
        try {
            return decodeURIComponent(raw);
        } catch {
            // 无效百分号（"%"、"%" 后跟非法字节）或非法 UTF-8（%FF）：一律视为「没带这个 cookie」。
            return null;
        }
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

// ════════════════════════════════════════════════════════════════════════════
// R6 #2：**角色**（面板 / agent）—— 凭据决定身份，不再靠「发没发 auth.token」
// ════════════════════════════════════════════════════════════════════════════
//
// 缺陷原貌（报告 #2）：`isPanelConnection()` 的判据是「**没有**发 auth.token」，
//   而 agent 也完全可以不发、面板也可以发 ⇒ 只要换一种携带方式就换一个身份。
//   于是「agent / 面板」不是鉴权结论，只是一个**语义标签**：任何持握手 token 的连接
//   （包括每个 agent 子进程）都能发 stop-all-agents → shutdown 把整套控制面关掉。
//
// 现在的口径：**两份不同的随机凭据**（启动时各生成一次）：
//   · 面板凭据 = `?token=` → HttpOnly cookie 那条路，也是 `.mindserver-token` 文件里的值；
//   · agent 凭据 = 只通过 `process.env.MINDSERVER_TOKEN` 继承给子进程，**不进 cookie 链路**。
// 握手门按「出示的是哪一份」定角色，把结论写到 `socket.data.role`；此后所有事件的判据
// 只认这个角色。要冒充得**拿到另一份凭据**，而不是「换个字段携带」。
//
// **诚实的边界**：这仍是「同用户权限模型」之内 —— 同机同用户进程能读 `.mindserver-token`
//   文件（= 面板凭据）。本层解决的是「agent 子进程默认拿不到面板凭据」以及
//   「判据不再取决于客户端自述的字段」，不是进程隔离。

export const ROLE_PANEL = 'panel';
export const ROLE_AGENT = 'agent';

/**
 * 额外凭据（token → 角色）。
 *
 * 为什么用登记表而不是给 `makeHandshakeGate` 加参数：控制面那行接线
 * `io.use(makeHandshakeGate(handshakeToken))` 是既有单测（tools/mindserver_gate_unit.mjs D1）
 * 的锚点，也是「门只有一处」的可 grep 证据。登记表让「面板凭据」仍是唯一的主参数，
 * 额外凭据（agent）由 `registerCredential` 显式登记进来。
 */
const EXTRA_CREDENTIALS = new Map();

/**
 * 登记一份额外凭据及其角色。返回值只表示「登记成功」，不表示「现在有连接通过」。
 * @param {string} token
 * @param {'panel'|'agent'} role
 * @returns {boolean}
 */
export function registerCredential(token, role) {
    if (typeof token !== 'string' || token.length === 0) return false;
    if (role !== ROLE_PANEL && role !== ROLE_AGENT) return false;
    EXTRA_CREDENTIALS.set(token, role);
    return true;
}

/** 清空额外凭据（进程内多次 createMindServer 时用；单测也用它隔离）。 */
export function clearCredentials() {
    EXTRA_CREDENTIALS.clear();
}

/**
 * 这次握手出示的是**哪一份**凭据 → 角色；不认识/没带 → null。
 *
 * 逐条 `tokenEquals`（定长比较）而不是 Map 直查：比较要在常量时间内完成，
 * 不让「前缀匹配程度」从时间差里漏出去。登记表很小（≤ 几条），代价可忽略。
 *
 * @param {object} handshake socket.handshake
 * @param {string} panelToken 面板凭据（= makeHandshakeGate 的主参数）
 * @returns {'panel'|'agent'|null}
 */
export function credentialRole(handshake, panelToken) {
    let presented = null;
    try {
        presented = tokenFromHandshake(handshake);
    } catch {
        return null;
    }
    if (typeof presented !== 'string' || presented.length === 0) return null;
    if (tokenEquals(presented, panelToken)) return ROLE_PANEL;
    for (const [token, role] of EXTRA_CREDENTIALS) {
        if (tokenEquals(presented, token)) return role;
    }
    return null;
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
    const reject = (socket, reason) => {
        const hints = socket?.handshake?.headers || {};
        console.warn(
            `[mindserver] 拒绝未握手的连接 host=${JSON.stringify(hints.host ?? null)} ` +
            `origin=${JSON.stringify(hints.origin ?? null)}（${reason}；` +
            `浏览器请用启动日志打印的 http://localhost:<port>/?token=… 打开控制台）`,
        );
        const err = new Error('unauthorized: mindserver 需要握手 token');
        err.data = { code: 'AUTH_REQUIRED' };
        return err;
    };
    return function handshakeGate(socket, next) {
        // SEC-001：判定本身也必须兜住。任何来自 handshake 的畸形数据（Cookie / query / header）
        // 都只能变成一次「拒绝」，不能变成一次未捕获异常 —— 未捕获异常会带走整个进程。
        let role = null;
        try {
            role = credentialRole(socket?.handshake, expectedToken);
        } catch (err) {
            console.warn('[mindserver] 握手判定异常（按未授权处理）:', err?.message ?? err);
            return next(reject(socket, '握手数据畸形'));
        }
        if (!role) return next(reject(socket, '缺 token 或 token 不对'));
        // ★ R6 #2：角色在**这里**定，之后所有事件只认它。
        //   agent 凭据 ⇒ 'agent'；面板凭据 ⇒ 'panel'。两者是不同的随机串，
        //   「换个字段携带同一份 token」不再能换身份。
        try {
            if (!socket.data) socket.data = {};
            socket.data.role = role;
        } catch { /* 桩 socket 不可写：下游按「角色未知」处理（= 管理面事件一律拒绝） */ }
        return next();
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
 * 四条**故意排除**：
 *   - `allow_insecure_coding`：等于「远程开代码执行 = 本机 root」；
 *   - `blocked_actions`：清空它等于把 `!newAction` 等被封命令放出来，和上面等价；
 *   - `profile`：里面是 `permissions`（谁是这个 bot 的主人），改它等于自己给自己发权限；
 *   - `speak`（F-EXEC-201，2026-11-06）：打开后模型输出会被送去本机 TTS；
 *     原来是"拼字符串进 shell"，现虽已改成 spawn+stdin，但**语音是把模型输出送进本机进程**这件事本身
 *     应当由人改 settings.json 后重启决定，不该让持 token 的客户端在运行期一键打开。
 * 单测会断言这几个不在表里、且表里每个键都真的存在于 settings_spec（防拼错后静默丢弃）。
 */
export const SAFE_RUNTIME_SETTINGS = Object.freeze([
    'minecraft_version', 'host', 'port', 'auth', 'base_profile', 'load_memory',
    'init_message', 'only_chat_with', 'language', 'allow_vision',
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
