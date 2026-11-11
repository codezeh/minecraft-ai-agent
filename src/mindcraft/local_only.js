/**
 * mindserver 的 socket 只放本机连接（第一轮审查的安全项）。
 *
 * 为什么只绑 localhost 不够：浏览器里任何网页都能对 localhost:8080 直接开 WebSocket
 * （socket.io 的 cors 只管 HTTP 长轮询，WebSocket 握手不受同源限制），连上后就能发
 * create-agent / send-message（让 bot 写代码执行）/ server-stop / shutdown。
 *
 * 判据（engine.io 每次握手调一次 allowRequest）：
 *   1. Host 必须是本机名 —— 挡 DNS rebinding（外部域名解析到 127.0.0.1 时，Host 仍是那个域名）
 *   2. 带了 Origin 就必须是本机页面 —— 挡别的网站的网页；`Origin: null`（沙箱 iframe、file://）也挡
 *   3. 不带 Origin 的是 Node 进程（agent 的 mindserver_proxy、tools 脚本），放行
 *
 * 单测：tools/mindserver_local_only_unit.mjs
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * ★ R6 #23：`MIND_SERVER_ALLOWED_HOSTS`（逗号分隔）显式加开 Host 白名单。
 * 原来没有这个开关 ⇒ MIND_SERVER_HOST=0.0.0.0 时 HTTP 能开、socket.io 握手永远 forbidden。
 * 安全默认不变：不设就只有本机名；它只加"Host 头允许出现哪些名字"，token/Origin 判据照旧。
 * 详见 docs/audit-r6/fixes2/control.md §#23。
 * @param {object} [env] 便于单测注入（默认 process.env）
 * @returns {Set<string>}
 */
export function configuredHosts(env = process.env) {
    const set = new Set(LOCAL_HOSTS);
    const raw = String(env?.MIND_SERVER_ALLOWED_HOSTS || '');
    for (const part of raw.split(',')) {
        const h = part.trim().toLowerCase();
        if (h) set.add(h);
    }
    return set;
}

/** "localhost:8080" / "[::1]:8080" → 小写主机名（IPv6 保留方括号）。 */
function hostOfHeader(host) {
    const m = /^(\[[^\]]*\]|[^:]*)/.exec(String(host || '').trim().toLowerCase());
    return m ? m[1] : '';
}

/** "http://localhost:5173" → "localhost"；"null" 或不合法 → ""。 */
function hostOfOrigin(origin) {
    try {
        return new URL(origin).hostname.toLowerCase();
    } catch {
        return '';
    }
}

/** 这个握手请求是不是来自本机（Host 和 Origin 都看）。 */
export function isLocalRequest(req, hosts = configuredHosts()) {
    const headers = req?.headers || {};
    if (!hosts.has(hostOfHeader(headers.host))) return false;
    const origin = headers.origin;
    if (origin === undefined) return true;
    return hosts.has(hostOfOrigin(origin));
}

/** 给 socket.io 的 `allowRequest` 用。 */
export function allowLocalOnly(req, callback) {
    if (isLocalRequest(req)) return callback(null, true);
    console.warn(`[mindserver] 拒绝非本机 socket 连接 host=${JSON.stringify(req?.headers?.host ?? null)} origin=${JSON.stringify(req?.headers?.origin ?? null)}`);
    callback('forbidden', false);
}
