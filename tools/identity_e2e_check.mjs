/**
 * R4 t24 端到端证据：**面板真的能发出绑定码，玩家真的能凭它变成 owner**。
 *
 * 为什么必须有这个脚本（队长裁决）：
 *   `identity_binding_unit` 66 条全绿，但它是**自己造码**（直接调 `addCode`）——
 *   而生产的链路是「面板 emit identity-issue-code → mindserver 造码写盘 → 人把码打进游戏 →
 *   !claim 核销」。这条链在 web/src 里**一个调用方都没有**（t24 的 blocker），
 *   单测再绿也证明不了它通。所以这里起**真 mindserver + 真 socket.io 客户端**跑一遍。
 *
 * 覆盖：
 *   ① 正例：带 token 的面板连接 ⇒ emit identity-issue-code ⇒ 拿到码 ⇒ 码真的在盘上
 *      ⇒ 该码走一次 !claim ⇒ 等级变 owner；
 *   ② 反向：**不带 token** 的连接 ⇒ 握手被拒（AUTH_REQUIRED），连事件都注册不上；
 *   ③ 反向：**agent 身份**（auth.token）的连接 ⇒ 事件被拒（panel_only，agent 不能自己给自己发码）；
 *   ④ 反向：**过期码** ⇒ !claim 失败；
 *   ⑤ 反向：**二次使用** ⇒ 同一个码第二次 !claim 失败。
 *
 * 用法：node tools/identity_e2e_probe.mjs   （不需要 Minecraft 服务器；全程 127.0.0.1）
 * 输出：PASS/FAIL 逐条 + 退出码。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 隔离：临时 bots 根 + 临时 cwd（createMindServer 会往 cwd 写 .mindserver-token，
// 绝不能覆盖掉正在运行的真服务用的那一份）
const TMP = mkdtempSync(path.join(tmpdir(), 'mc-identity-e2e-'));
process.env.MC_BOTS_ROOT = TMP;
process.env.MINDSERVER_TOKEN = 'e2e-token-' + process.pid;
process.env.MIND_SERVER_HOST = '127.0.0.1';
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const { io } = await import('socket.io-client');
const mindserver = await import('../src/mindcraft/mindserver.js');
const store = await import('../src/mindcraft/identity_store.js');
const { TOKEN_COOKIE } = await import('../src/mindcraft/auth_gate.js');
const { getCommand, identityContextOf } = await import('../src/agent/commands/index.js');
const { resolveLevel, LEVEL } = await import('../src/agent/permissions.js');

const TOKEN = process.env.MINDSERVER_TOKEN;
const AGENT = 'e2ebot';

/** 起一个真 mindserver（端口交给系统挑），返回 {server, port}。 */
async function startServer() {
    mindserver.registerAgent({ profile: { name: AGENT, permissions: { owner: 'Zeh' } } }, 3000);
    const server = mindserver.createMindServer(false, 0);
    await once(server, 'listening');
    return { server, port: server.address().port };
}

/** 连一个客户端；token 的携带方式决定"面板"还是"agent"。 */
function connectClient(port, { mode }) {
    const opts = { transports: ['websocket'], reconnection: false, timeout: 4000 };
    if (mode === 'panel') {
        // 面板：浏览器把 token 换成 HttpOnly cookie，**不带 auth payload**
        opts.extraHeaders = { Cookie: `${TOKEN_COOKIE}=${TOKEN}` };
    } else if (mode === 'agent') {
        // agent 进程：mindserver_proxy 走 auth: { token }
        opts.auth = { token: TOKEN };
    }
    return io(`http://127.0.0.1:${port}`, opts);
}

function emitAck(sock, event, ...args) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ __timeout: true }), 4000);
        sock.emit(event, ...args, (res) => { clearTimeout(timer); resolve(res); });
    });
}

const { server, port } = await startServer();
const clients = [];
try {
    // ── ① 正例：面板连接 → 生成码 ────────────────────────────────────────
    const panel = connectClient(port, { mode: 'panel' });
    clients.push(panel);
    await once(panel, 'connect');

    const issued = await emitAck(panel, 'identity-issue-code', AGENT);
    check('① 面板 emit identity-issue-code ⇒ 拿到码', issued?.ok === true && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(issued.code || ''),
        JSON.stringify(issued));
    check('①-b 回执带 expiresAt，且 TTL ≤ 5 分钟',
        Number(issued?.expiresAt) - Date.now() <= store.DEFAULT_CODE_TTL_MS + 1000,
        `剩余 ${Math.round((Number(issued?.expiresAt) - Date.now()) / 1000)}s`);

    const onDisk = store.readStore(store.codesFileOf(AGENT)).store;
    check('①-c 码真的落在 bots/<agent>/identity-codes.json 上（不是只回了个字符串）',
        onDisk.codes.some((c) => c.code === issued.code),
        `${store.codesFileOf(AGENT)} → ${onDisk.codes.length} 个未核销码`);
    check('①-d 码绑定到当前面板会话（socket.id）',
        onDisk.codes.find((c) => c.code === issued.code)?.sessionId === panel.id);

    // ── ①-e 拿真码走 !claim，再走 resolveLevel ───────────────────────────
    const PREMIUM_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';   // 非离线派生 ⇒ 强绑定
    const fakeAgent = {
        name: AGENT,
        command_author: 'Zeh',
        bot: { username: AGENT, players: { Zeh: { uuid: PREMIUM_UUID } } },
        prompter: { profile: { permissions: { owner: 'Zeh' } } },
    };
    const claimCmd = getCommand('!claim');
    const claimMsg = await claimCmd.perform(fakeAgent, issued.code);
    check('①-e !claim 用真码成功', /绑定成功/.test(String(claimMsg)), String(claimMsg).slice(0, 60));

    const ctx = identityContextOf(fakeAgent);
    const level = resolveLevel({ author: 'Zeh', uuid: PREMIUM_UUID, permissions: { owner: 'Zeh' }, identity: ctx });
    check('①-f ★ 端到端闭环：面板发的码 ⇒ 游戏内 !claim ⇒ 等级 owner', level === LEVEL.OWNER, level);
    const stranger = resolveLevel({ author: 'Zeh', uuid: 'someone-else', permissions: { owner: 'Zeh' }, identity: ctx });
    check('①-g 同名但 uuid 不同的冒名者仍 guest（t13 的保护还在）', stranger === LEVEL.OTHER, stranger);

    // ── ⑤ 反向：二次使用 ────────────────────────────────────────────────
    const reuse = await claimCmd.perform(fakeAgent, issued.code);
    check('⑤ 同一个码第二次使用失败（单次使用）', /无效|没有可用/.test(String(reuse)), String(reuse).slice(0, 40));

    // ── ② 反向：不带 token 的连接 ───────────────────────────────────────
    const anon = connectClient(port, { mode: 'anon' });
    clients.push(anon);
    const anonErr = await Promise.race([
        once(anon, 'connect_error').then(([e]) => e),
        new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    check('② 不带 token ⇒ 握手被拒（AUTH_REQUIRED），根本进不到事件层',
        !!anonErr && anonErr?.data?.code === 'AUTH_REQUIRED', String(anonErr?.message ?? anonErr));
    check('②-b 被拒的连接没有连上', anon.connected === false);

    // ── ③ 反向：agent 身份连接不能自己发码 ──────────────────────────────
    const agentConn = connectClient(port, { mode: 'agent' });
    clients.push(agentConn);
    await once(agentConn, 'connect');
    const agentIssued = await emitAck(agentConn, 'identity-issue-code', AGENT);
    check('③ agent 身份连接（auth.token）⇒ 被拒 panel_only（agent 不能给自己发码）',
        agentIssued?.ok === false && agentIssued?.reason === 'panel_only', JSON.stringify(agentIssued));

    // ── ④ 反向：过期码不生效 ────────────────────────────────────────────
    const expiredCode = store.makeCode();
    const past = Date.now() - 10 * 60_000;
    const withExpired = store.addCode(store.emptyStore(), {
        code: expiredCode, agent: AGENT, sessionId: panel.id, now: past, ttlMs: 60_000,
    });
    store.writeStore(store.codesFileOf(AGENT), withExpired.store);
    const expiredMsg = await claimCmd.perform(fakeAgent, expiredCode);
    check('④ 过期码 !claim 失败（不会因为"文件里还有"就一直有效）',
        /无效|没有可用/.test(String(expiredMsg)), String(expiredMsg).slice(0, 40));
} finally {
    for (const c of clients) { try { c.disconnect(); } catch { /* ignore */ } }
    try { server.close(); } catch { /* ignore */ }
    try { process.chdir(ORIGINAL_CWD); } catch { /* ignore */ }
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个端到端断言通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
