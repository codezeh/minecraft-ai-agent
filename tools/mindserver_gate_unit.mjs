/**
 * mindserver 的握手门 + set-agent-settings 白名单（第一轮审查 第 1 条 ①②）—— 不起服务、不碰 socket。
 *
 * 缺陷原貌：
 *   - `send-message`（mindserver.js:392-402）把 `data.from` 原样转发，而"我是谁"在 agent 侧直接
 *     决定权限等级 ⇒ 本机任意进程/页面自报 `from:'HEAVENZEH'` 就是 owner；
 *   - `set-agent-settings`（:336-343）能把运行期设置改成任意值，包括 `allow_insecure_coding`；
 *   - `server-stop` / `shutdown` 直接关服 / `process.exit(0)`。
 *
 * 修复（`src/mindcraft/auth_gate.js`）：
 *   ① 启动时 `crypto.randomUUID()` 生成 token，`io.use(makeHandshakeGate(token))` 校验；
 *      四个特权事件都注册在 `io.on('connection')` 里 ⇒ 全部在门后。
 *   ② `set-agent-settings` 只接受白名单字段，`allow_insecure_coding`/`blocked_actions`/`profile` 直接丢弃。
 *
 * 本测分三层（都不需要真 socket）：
 *   A. 判据本身（token 提取 / 比较 / 中间件放行与拒绝）；
 *   B. 白名单（过滤结果 + 表本身与 settings_spec 一致）；
 *   C. 用**桩 io/socket** 按 socket.io 的语义跑一遍：中间件拒绝 ⇒ 不会收到 connection ⇒
 *      send-message 无人转发、set-agent-settings 改不动 allow_insecure_coding；
 *      **外加**对 mindserver.js 源码的接线断言（防止"函数改对了但没接上"）。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    TOKEN_COOKIE, TOKEN_HEADER, SAFE_RUNTIME_SETTINGS,
    makeToken, tokenEquals, tokenFromHandshake, isAuthorizedHandshake, makeHandshakeGate,
    authCookieHeader, hasAuthCookie, sanitizeAgentSettings,
} from '../src/mindcraft/auth_gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ════════════════════════════════════════════════════════════
// A. 判据本身
// ════════════════════════════════════════════════════════════
const TOKEN = makeToken();
check('makeToken 产出 UUID 形状且两次不同',
    /^[0-9a-f-]{36}$/i.test(TOKEN) && makeToken() !== TOKEN, `→ ${TOKEN}`);

check('tokenEquals 相同 → true', tokenEquals(TOKEN, TOKEN));
check('tokenEquals 不同 → false', !tokenEquals(TOKEN, makeToken()));
check('tokenEquals 长度不同 → false（不抛）', !tokenEquals(TOKEN, TOKEN.slice(1)));
check('tokenEquals 空/非字符串 → false', !tokenEquals('', '') && !tokenEquals(null, TOKEN) && !tokenEquals(TOKEN, undefined));

check('tokenFromHandshake: auth payload',
    tokenFromHandshake({ auth: { token: TOKEN } }) === TOKEN);
check('tokenFromHandshake: 自定义头',
    tokenFromHandshake({ headers: { [TOKEN_HEADER]: TOKEN } }) === TOKEN);
check('tokenFromHandshake: URL query',
    tokenFromHandshake({ query: { token: TOKEN } }) === TOKEN);
check('tokenFromHandshake: cookie（浏览器控制台那条路）',
    tokenFromHandshake({ headers: { cookie: `a=1; ${TOKEN_COOKIE}=${TOKEN}; b=2` } }) === TOKEN);
check('tokenFromHandshake: 什么都没有 → null',
    tokenFromHandshake({ headers: { host: 'localhost:8080', origin: 'http://evil.test' } }) === null);
check('tokenFromHandshake: 空 auth token 不算', tokenFromHandshake({ auth: { token: '' } }) === null);

check('isAuthorizedHandshake: 正确 token → true', isAuthorizedHandshake({ auth: { token: TOKEN } }, TOKEN));
check('isAuthorizedHandshake: 无 token → false',
    !isAuthorizedHandshake({ headers: { host: 'localhost:8080' } }, TOKEN));
check('isAuthorizedHandshake: 错 token → false', !isAuthorizedHandshake({ auth: { token: 'nope' } }, TOKEN));

check('authCookieHeader: HttpOnly + SameSite=Strict',
    /HttpOnly/.test(authCookieHeader(TOKEN)) && /SameSite=Strict/.test(authCookieHeader(TOKEN)),
    `→ ${authCookieHeader(TOKEN)}`);
check('hasAuthCookie: 带着对的 cookie → true', hasAuthCookie(`${TOKEN_COOKIE}=${TOKEN}`, TOKEN));
check('hasAuthCookie: 没有 cookie → false', !hasAuthCookie('', TOKEN));

// 中间件：拒绝 / 放行
{
    const gate = makeHandshakeGate(TOKEN);
    let nextArg = 'unset';
    gate({ handshake: { headers: { host: 'localhost:8080' } } }, (e) => { nextArg = e; });
    check('gate: 无 token → next(err) 且 err.data.code=AUTH_REQUIRED',
        nextArg instanceof Error && nextArg.data?.code === 'AUTH_REQUIRED', `→ ${nextArg}`);
}
{
    const gate = makeHandshakeGate(TOKEN);
    let nextArg = 'unset';
    gate({ handshake: { auth: { token: TOKEN } } }, (e) => { nextArg = e; });
    check('gate: 正确 token → next() 无错误', nextArg === undefined, `→ ${JSON.stringify(nextArg)}`);
}
{
    let threw = false;
    try { makeHandshakeGate(''); } catch { threw = true; }
    check('gate: 空 expected token 直接抛（防止误配成"谁都能进"）', threw);
}

// ════════════════════════════════════════════════════════════
// B. set-agent-settings 白名单
// ════════════════════════════════════════════════════════════
{
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/mindcraft/public/settings_spec.json'), 'utf8'));
    check('白名单里没有 allow_insecure_coding', !SAFE_RUNTIME_SETTINGS.includes('allow_insecure_coding'));
    check('白名单里没有 blocked_actions', !SAFE_RUNTIME_SETTINGS.includes('blocked_actions'));
    check('白名单里没有 profile（里面是 owner 名单）', !SAFE_RUNTIME_SETTINGS.includes('profile'));
    const unknown = SAFE_RUNTIME_SETTINGS.filter((k) => !(k in spec));
    check('白名单每个键都真实存在于 settings_spec（拼错会被静默丢弃，这里挡住）',
        unknown.length === 0, `→ 多余键: ${JSON.stringify(unknown)}`);
}
{
    const { settings, dropped } = sanitizeAgentSettings({
        allow_insecure_coding: true,
        blocked_actions: [],
        profile: { name: 'x', permissions: { owner: 'attacker' } },
        max_messages: 5,
        narrate_behavior: false,
    });
    check('sanitize: 只留白名单字段', Object.keys(settings).sort().join(',') === 'max_messages,narrate_behavior',
        `→ ${JSON.stringify(settings)}`);
    check('sanitize: 危险字段全部进 dropped',
        ['allow_insecure_coding', 'blocked_actions', 'profile'].every((k) => dropped.includes(k)),
        `→ ${JSON.stringify(dropped)}`);
    check('sanitize: allow_insecure_coding 没被带出去', !('allow_insecure_coding' in settings));
}
check('sanitize: 非对象输入不炸', Object.keys(sanitizeAgentSettings(null).settings).length === 0);

// ════════════════════════════════════════════════════════════
// C. 桩 io / socket：按 socket.io 的语义跑一遍
// ════════════════════════════════════════════════════════════
/**
 * 最小的 socket.io 语义桩：
 *   - `io.use(mw)` 收中间件；
 *   - `io.on('connection', fn)` 收连接处理器；
 *   - `connect(socket)` 模拟一次握手：**只有全部中间件放行**才触发 connection。
 */
function makeStubIO() {
    const middlewares = [];
    const handlers = {};
    return {
        middlewares,
        handlers,
        use(mw) { middlewares.push(mw); },
        on(ev, fn) { (handlers[ev] ||= []).push(fn); },
        connect(socket) {
            let rejected = null;
            for (const mw of middlewares) {
                let called = false;
                mw(socket, (err) => { called = true; if (err) rejected = err; });
                if (!called || rejected) return { connected: false, error: rejected };
            }
            for (const fn of handlers.connection || []) fn(socket);
            return { connected: true, error: null };
        },
    };
}

/** 受测方（模拟 mindserver 里那段接线）：门 + 两个特权事件 + 一个 stub agent。 */
function buildStubServer(token) {
    const io = makeStubIO();
    io.use(makeHandshakeGate(token));

    const agentSocket = { sent: [], emit(ev, ...args) { this.sent.push([ev, ...args]); } };
    const agent = { settings: { allow_insecure_coding: false, blocked_actions: ['!newAction'], max_messages: 30 }, socket: agentSocket };

    io.on('connection', (socket) => {
        // send-message：先查形状，再转发（与 mindserver.js 一致）
        socket.on('send-message', (agentName, data) => {
            if (!data || typeof data.from !== 'string' || !data.from || data.from.length > 32) return;
            agent.socket.emit('send-message', data);
        });
        // set-agent-settings：白名单（与 mindserver.js 一致）
        socket.on('set-agent-settings', (agentName, settings) => {
            const { settings: safe, dropped } = sanitizeAgentSettings(settings);
            if (dropped.length) console.log(`  · （预期）丢弃: ${dropped.join(', ')}`);
            if (Object.keys(safe).length === 0) return;
            agent.settings = { ...agent.settings, ...safe };
            agent.socket.emit('restart-agent');
        });
    });

    const makeSocket = (handshake) => {
        const registered = {};
        return { handshake, registered, on(ev, fn) { registered[ev] = fn; } };
    };
    return { io, agent, agentSocket, makeSocket };
}

// C1：**无 token** 的客户端 —— 连不上，于是 send-message 根本不存在
{
    const { io, agentSocket, makeSocket } = buildStubServer(TOKEN);
    const sock = makeSocket({ headers: { host: 'localhost:8080', origin: 'http://evil.test' } });
    const r = io.connect(sock);
    check('C1 无 token 握手被拒（拿不到 connection）', r.connected === false && r.error?.data?.code === 'AUTH_REQUIRED');
    check('C1 被拒的连接上没有任何事件处理器（连 send-message 都不存在）',
        Object.keys(sock.registered).length === 0, `→ ${JSON.stringify(Object.keys(sock.registered))}`);
    // 即使"有人"硬调一次，也没有转发发生（这就是「无 token 的 send-message 被拒」的实证）
    sock.registered['send-message']?.('bot1', { from: 'HEAVENZEH', message: '!newAction(...)' });
    check('C1 无 token 的 send-message 没有被转发给 agent', agentSocket.sent.length === 0,
        `→ ${JSON.stringify(agentSocket.sent)}`);
}

// C2：带 token 的客户端 —— 能连上，但 allow_insecure_coding 仍改不动
{
    const { io, agent, agentSocket, makeSocket } = buildStubServer(TOKEN);
    const sock = makeSocket({ auth: { token: TOKEN } });
    const r = io.connect(sock);
    check('C2 带 token 握手通过', r.connected === true);

    agent.socket = agentSocket;
    sock.registered['set-agent-settings']('bot1', { allow_insecure_coding: true });
    check('C2 set-agent-settings 改不动 allow_insecure_coding', agent.settings.allow_insecure_coding === false,
        `→ ${JSON.stringify(agent.settings)}`);
    check('C2 全被丢弃时不发 restart-agent（避免无意义重启）', agentSocket.sent.length === 0,
        `→ ${JSON.stringify(agentSocket.sent)}`);

    sock.registered['set-agent-settings']('bot1', { allow_insecure_coding: true, blocked_actions: [], max_messages: 7 });
    check('C2 混着发：危险字段丢弃、合法字段生效',
        agent.settings.allow_insecure_coding === false && agent.settings.max_messages === 7 &&
        agent.settings.blocked_actions.length === 1, `→ ${JSON.stringify(agent.settings)}`);

    sock.registered['send-message']('bot1', { from: 'HEAVENZEH', message: 'hi' });
    check('C2 带 token 的 send-message 正常转发', agentSocket.sent.some(([ev]) => ev === 'send-message'),
        `→ ${JSON.stringify(agentSocket.sent)}`);

    const beforeCount = agentSocket.sent.filter(([ev]) => ev === 'send-message').length;
    sock.registered['send-message']('bot1', { from: { evil: true }, message: 'hi' });
    const afterCount = agentSocket.sent.filter(([ev]) => ev === 'send-message').length;
    check('C2 from 非法（非字符串）被拒', afterCount === beforeCount, `→ before=${beforeCount}, after=${afterCount}`);

}

// ════════════════════════════════════════════════════════════
// D. 接线断言：函数改对了，还得真的接上
// ════════════════════════════════════════════════════════════
{
    const src = fs.readFileSync(path.join(__dirname, '../src/mindcraft/mindserver.js'), 'utf8');
    // 用**代码**那处 needle（注释里也提到 io.on('connection')，拿注释当锚点会得出错误结论）
    const CONN = "io.on('connection', (socket) =>";
    const at = (needle) => src.indexOf(needle);

    check('D1 mindserver.js 装了握手门', at('io.use(makeHandshakeGate(handshakeToken))') > 0);
    check('D2 token 来自 randomUUID（makeToken）或 env',
        at('makeToken()') > 0 && at('MINDSERVER_TOKEN') > 0);
    check('D3 io.use 在 io.on(\'connection\') 之前',
        at('io.use(makeHandshakeGate') > 0 && at(CONN) > 0 && at('io.use(makeHandshakeGate') < at(CONN),
        `→ use=${at('io.use(makeHandshakeGate')}, connection=${at(CONN)}`);

    for (const ev of ['send-message', 'set-agent-settings', 'server-stop', 'shutdown']) {
        const evPos = at(`socket.on('${ev}'`);
        check(`D4 ${ev} 注册在 io.on('connection') 之后（= 在门后）`,
            evPos > at(CONN), `→ pos=${evPos}, connection=${at(CONN)}`);
    }

    const setPos = at("socket.on('set-agent-settings'");
    const body = src.slice(setPos, setPos + 900);
    check('D5 set-agent-settings 里用了 sanitizeAgentSettings',
        body.includes('sanitizeAgentSettings('), `→ ${body.slice(0, 120).replace(/\s+/g, ' ')}…`);
    check('D5b set-agent-settings 里不再直接 agent.setSettings(settings)',
        !/agent\.setSettings\(settings\)/.test(body));

    // 第2条：create-agent 的名字校验必须早于 createAgent（否则文件已写出）
    const nameCheck = at("validateNameFormat(settings.profile.name)");
    check('D6 第2条 create-agent 用 validateNameFormat 校验名字',
        nameCheck > 0, `→ pos=${nameCheck}`);
    check('D7 第2条 校验早于 mindcraft.createAgent',
        nameCheck > 0 && nameCheck < at('await mindcraft.createAgent(settings)'),
        `→ check=${nameCheck}, create=${at('await mindcraft.createAgent(settings)')}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
