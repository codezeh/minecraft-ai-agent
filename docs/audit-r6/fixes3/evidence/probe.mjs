/**
 * 控制面冒烟探针（**非产品代码**）：对 8081 上的隔离 mindserver 逐条打 API。
 * 覆盖：#66 token 错误 / #57 控制命令 ack 与四类失败帧 / #33 限流按 agent 分桶
 *       / #68 任务板 socket API / #30 /unlock 限流 / #59 配置确认。
 * 只读产品代码、只打 HTTP+socket，不改仓库文件（#59 例外：按任务要求改一次并改回）。
 */
import { io } from 'socket.io-client';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.PORT || 8081);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const creds = JSON.parse(readFileSync('./smoke-credentials.json', 'utf8'));
const PANEL = creds.panelToken;
const AG = creds.agentTokens;
const SETTINGS = 'E:/我的世界ai/mindcraft/settings.js';

const R = [];
const rec = (id, item, request, response, pass, note = '') => {
    R.push({ id, item, request, response, pass, note });
    console.log(`\n===== ${id} ${item} → ${pass ? 'PASS' : 'FAIL'}`);
    console.log('REQ:', request);
    console.log('RES:', typeof response === 'string' ? response : JSON.stringify(response));
    if (note) console.log('NOTE:', note);
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect({ token, reconnection = false, label = '' } = {}) {
    return new Promise((resolve) => {
        const opts = { reconnection, transports: ['websocket'], timeout: 4000 };
        if (token !== undefined) opts.auth = { token };
        const s = io(ORIGIN, opts);
        const t = setTimeout(() => resolve({ socket: s, ok: false, err: { code: 'TIMEOUT' }, label }), 5000);
        s.on('connect', () => { clearTimeout(t); resolve({ socket: s, ok: true, label }); });
        s.on('connect_error', (e) => { clearTimeout(t); resolve({ socket: s, ok: false, err: { message: e?.message, code: e?.data?.code }, label }); });
    });
}

/** 发一个带 ack 的事件，等 ms 没回就是「服务端不回 ack」。 */
function emitAck(sock, event, args = [], ms = 1200) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve({ acked: false, ms: Date.now() - t0 }); } }, ms);
        sock.emit(event, ...args, (payload) => {
            if (done) return; done = true; clearTimeout(timer);
            resolve({ acked: true, payload, ms: Date.now() - t0 });
        });
    });
}

async function post(path, body) {
    const t0 = Date.now();
    const r = await fetch(`${ORIGIN}${path}?token=${PANEL}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    let json = null;
    try { json = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, body: json, ms: Date.now() - t0 };
}
async function put(path, body) {
    const r = await fetch(`${ORIGIN}${path}?token=${PANEL}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    let json = null;
    try { json = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, body: json };
}

const settingsHashBefore = sha(readFileSync(SETTINGS));

// ─────────────────────────────── #66 ───────────────────────────────
{
    const r1 = await fetch(`${ORIGIN}/api/config`);           // 无 token
    rec('#66-a', 'HTTP 无 token → 401', 'GET /api/config（无 token）',
        { status: r1.status }, r1.status === 401);

    const r2 = await fetch(`${ORIGIN}/api/config?token=${PANEL}`);
    rec('#66-b', 'HTTP 带正确 token → 200', 'GET /api/config?token=<panel>',
        { status: r2.status }, r2.status === 200);

    const bad = await connect({ token: 'wrong-token-0000', label: 'bad' });
    rec('#66-c', '错 token 握手 → AUTH_REQUIRED', 'socket.io connect auth:{token:"wrong-token-0000"}',
        { connected: bad.ok, message: bad.err?.message, code: bad.err?.code },
        !bad.ok && bad.err?.code === 'AUTH_REQUIRED');
    bad.socket.close();

    const none = await connect({ token: undefined, label: 'none' });
    rec('#66-d', '不带 token 握手 → AUTH_REQUIRED', 'socket.io connect（无 auth）',
        { connected: none.ok, message: none.err?.message, code: none.err?.code },
        !none.ok && none.err?.code === 'AUTH_REQUIRED');
    none.socket.close();

    // 自动重连客户端：4 秒内数 connect_error 次数（服务端是否"无限重连"由客户端策略决定）
    let errCount = 0; let lastCode = null;
    const rn = io(ORIGIN, { auth: { token: 'wrong-token-1111' }, transports: ['websocket'], reconnection: true, reconnectionDelay: 200 });
    rn.on('connect_error', (e) => { errCount++; lastCode = e?.data?.code ?? null; });
    await sleep(4000);
    rn.close();
    rec('#66-e', '错 token + 自动重连客户端 4s 内重试次数（服务端每次都拒）',
        'socket.io-client reconnection:true, reconnectionDelay:200ms, 观察 4s',
        { connectErrorCount: errCount, lastCode },
        errCount >= 1 && lastCode === 'AUTH_REQUIRED',
        `服务端是无状态拒绝（不排队、不主动重连）；重试次数完全由客户端策略决定。出厂前端在 AUTH_REQUIRED 时调 pauseReconnect()（web/src/stores/agents.ts:280-284，产物 web-dist 内含该码）。`);
}

// ─────────────────────────────── #57 ───────────────────────────────
const frames = { 'start-agent-failed': [], 'destroy-agent-failed': [], 'agent-channel-rejected': [], 'agent-channel-taken-over': [], 'control-denied': [], 'agents-status': 0 };
{
    const p = await connect({ token: PANEL, label: 'panel' });
    if (!p.ok) { rec('#57-pre', '面板连接', 'connect', p.err, false); }
    for (const ev of Object.keys(frames)) if (ev !== 'agents-status') p.socket.on(ev, (x) => frames[ev].push(x));
    p.socket.on('agents-status', () => { frames['agents-status']++; });

    const a1 = await emitAck(p.socket, 'send-message', ['smokeA', { from: 'panel', message: 'smoke-test' }]);
    rec('#57-1', 'send-message 是否回 ack', `emit('send-message', 'smokeA', {from:'panel',message:'smoke-test'}, cb) 等 1.2s`,
        a1, a1.acked, a1.acked ? '' : '服务端处理器签名 (agentName, data) —— 第 3 个参数（ack）被忽略，回调永不触发。');

    const a2 = await emitAck(p.socket, 'start-agent', ['smokeA']);
    const gotStartedFailed = frames['start-agent-failed'].length > 0;
    rec('#57-2', 'start-agent 是否回 ack + 失败帧', `emit('start-agent','smokeA', cb) 等 1.2s`,
        { ack: a2, 'start-agent-failed': frames['start-agent-failed'] },
        a2.acked && gotStartedFailed,
        a2.acked ? '' : '无 ack（handler 签名 (agentName)）；但失败帧 start-agent-failed 确实发出来了（见 RES）。');

    const a3 = await emitAck(p.socket, 'stop-agent', ['smokeA']);
    rec('#57-3', 'stop-agent 是否回 ack', `emit('stop-agent','smokeA', cb) 等 1.2s`, a3, a3.acked,
        a3.acked ? '' : '无 ack；且"未找到 agent"只打 console.warn，不回任何东西。');

    const a4 = await emitAck(p.socket, 'restart-agent', ['smokeA']);
    rec('#57-4', 'restart-agent 是否回 ack', `emit('restart-agent','smokeA', cb) 等 1.2s`, a4, a4.acked,
        a4.acked ? '' : '无 ack；agent 不在线只打 warn。');

    await sleep(300);
    const a5 = await emitAck(p.socket, 'destroy-agent', ['smokeB']);
    const gotDestroyFailed = frames['destroy-agent-failed'].length > 0;
    rec('#57-5', 'destroy-agent 是否回 ack + 失败帧', `emit('destroy-agent','smokeB', cb) 等 1.2s（smokeB 的假进程拒绝退出）`,
        { ack: a5, 'destroy-agent-failed': frames['destroy-agent-failed'] },
        a5.acked && gotDestroyFailed,
        a5.acked ? '' : '无 ack（handler 签名 (agentName)）；destroy-agent-failed 帧已发出。');

    // 面板连接冒充 agent 通道 → agent-channel-rejected
    p.socket.emit('login-agent', 'smokeA');
    await sleep(500);
    rec('#57-6', '失败帧 agent-channel-rejected 是否真会发',
        `面板连接 emit('login-agent','smokeA')`,
        { frames: frames['agent-channel-rejected'] },
        frames['agent-channel-rejected'].some((f) => f?.reason === 'identity-required'));

    // 两条 agent 凭据连接抢同一名字 → 后者接管，前者收 agent-channel-taken-over
    const tA = AG.smokeA;
    const c1 = await connect({ token: tA, label: 'agentA1' });
    c1.socket.on('agent-channel-taken-over', (x) => frames['agent-channel-taken-over'].push(x));
    c1.socket.emit('login-agent', 'smokeA');
    await sleep(400);
    const c2 = await connect({ token: tA, label: 'agentA2' });
    c2.socket.emit('login-agent', 'smokeA');
    await sleep(600);
    rec('#57-7', '失败帧 agent-channel-taken-over 是否真会发',
        `两条不同 socket 都用 smokeA 的 agent 凭据 login-agent('smokeA')`,
        { frames: frames['agent-channel-taken-over'], c1Connected: c1.ok, c2Connected: c2.ok },
        frames['agent-channel-taken-over'].length > 0,
        '接管后服务端主动断开旧连接（claim.previous.disconnect(true)）。');

    // agent 连接发管理面事件 → control-denied
    const denied = [];
    const c3 = await connect({ token: tA, label: 'agentA3' });
    c3.socket.on('control-denied', (x) => denied.push(x));
    await sleep(200);
    c3.socket.emit('stop-agent', 'smokeB');
    await sleep(500);
    rec('#57-8', '失败帧 control-denied 是否真会发（agent 发管理面事件）',
        `agent 凭据连接 emit('stop-agent','smokeB')`,
        { frames: denied }, denied.length > 0 && denied[0]?.reason === 'panel_only');
    c3.socket.close();

    // ─────────────────────────── #33（用上面活着的 agent 连接）───────────────────────────
    // 桶：`label@主体@地址`，主体 = agent:<name>。smokeA 打满 20 次 get-settings 后，
    // smokeB 的第一次必须**不受影响**。
    const aOwner = c2.ok ? c2 : c1;
    let aLast = null; let aRateLimited = false; let aOkCount = 0;
    for (let i = 1; i <= 21; i++) {
        const r = await new Promise((res) => {
            aOwner.socket.emit('get-settings', 'smokeA', (p) => res(p));
            setTimeout(() => res({ error: 'NO_REPLY' }), 1500);
        });
        aLast = r;
        if (r?.error === 'rate_limited') aRateLimited = true;
        if (r?.settings) aOkCount++;
    }
    const bConn = await connect({ token: AG.smokeB, label: 'agentB' });
    bConn.socket.emit('login-agent', 'smokeB');
    await sleep(300);
    const bRes = await new Promise((res) => {
        bConn.socket.emit('get-settings', 'smokeB', (p) => res(p));
        setTimeout(() => res({ error: 'NO_REPLY' }), 1500);
    });
    rec('#33', '限流按 agent 分桶：smokeA 打满不影响 smokeB',
        `agent smokeA 连打 get-settings 21 次（配额 20/60s）；随后 smokeB 打 1 次`,
        { smokeA: { okCount: aOkCount, rateLimited: aRateLimited, last: aLast }, smokeB: bRes },
        aRateLimited && aOkCount === 20 && bRes?.settings != null,
        '桶键 = label@主体@地址，主体=agent:<name>（mindserver.js:539-556）。同一台机、同一地址，只有主体不同 ⇒ 证明分桶不是按地址。');

    // ─────────────────────────── #68 任务板 ───────────────────────────
    const bogus = await emitAck(p.socket, 'board:add', [{ skill: '__no_such_skill__', args: '{}' }], 3000);
    rec('#68-a', 'board:add 非法 skill → 明确拒绝并列出可用技能',
        `emit('board:add',{skill:'__no_such_skill__',args:'{}'},cb)`, bogus,
        bogus.acked && bogus.payload?.ok === false);

    let skill = null;
    const m = String(bogus.payload?.reason ?? '').match(/可用[:：]\s*(.+)$/);
    if (m) skill = m[1].trim().split(/\s+/)[0];
    if (!skill) skill = 'collectBlocks';

    const added = await emitAck(p.socket, 'board:add', [{ skill, args: '{}' }], 3000);
    rec('#68-b', 'board:add 建单', `emit('board:add',{skill:'${skill}',args:'{}'},cb)`,
        added, added.acked && added.payload?.ok === true);
    const jobId = added.payload?.id ?? null;

    const listed = await emitAck(p.socket, 'board:list', [{ scope: 'all', limit: 50 }], 3000);
    const ids = (listed.payload?.jobs ?? []).map((j) => j.id);
    rec('#68-c', 'board:list 能看到新单', `emit('board:list',{scope:'all',limit:50},cb)`,
        { ok: listed.payload?.ok, count: ids.length, hasJob: jobId ? ids.includes(jobId) : false, jobs: listed.payload?.jobs?.slice(0, 3) },
        listed.acked && listed.payload?.ok === true && !!jobId && ids.includes(jobId));

    const cancelled = jobId
        ? await emitAck(p.socket, 'board:set-state', [{ id: jobId, state: 'cancelled', bot: 'smokeA' }], 3000)
        : { acked: false };
    rec('#68-d', 'board:set-state 取消单（cancel）',
        `emit('board:set-state',{id:'${jobId}',state:'cancelled',bot:'smokeA'},cb)`,
        cancelled, cancelled.acked && cancelled.payload?.ok === true && cancelled.payload?.job?.state === 'cancelled');

    const listed2 = await emitAck(p.socket, 'board:list', [{ scope: 'all', limit: 50 }], 3000);
    const j2 = (listed2.payload?.jobs ?? []).find((j) => j.id === jobId);
    rec('#68-e', '取消后 list 里该单状态为 cancelled',
        `emit('board:list',{scope:'all',limit:50},cb)`,
        { job: j2 ?? null }, j2?.state === 'cancelled');

    p.socket.close();
    c1.socket.close(); c2.socket.close(); bConn.socket.close();
}

// ─────────────────────────────── #30 ───────────────────────────────
{
    const init = await post('/api/vault/init', { passphrase: 'smoke-pass-1234' });
    rec('#30-0', '隔离保管库初始化（只为能测 /unlock 401/429 分支）',
        `POST /api/vault/init {passphrase:'smoke-pass-1234'}（MC_VAULT_DB 指向 tmp）`,
        init, init.status === 201 || init.status === 409);

    const seq = [];
    for (let i = 1; i <= 6; i++) {
        const r = await post('/api/vault/unlock', { passphrase: 'wrong-pass-000' + i });
        seq.push({ n: i, status: r.status, error: r.body?.error ?? null, ms: r.ms });
    }
    const expectSeq = [401, 401, 401, 401, 401, 429];
    rec('#30-a', '/unlock 连打 6 次错口令 → 第 6 次 429（不排队、可重试）',
        `POST /api/vault/unlock {passphrase:'wrong-pass-000N'} ×6（顺序）`,
        seq, JSON.stringify(seq.map((s) => s.status)) === JSON.stringify(expectSeq),
        '口径：先校验口令、后判限流 ⇒ 前 5 次失败 401，第 6 次失败才 429。');

    const ok = await post('/api/vault/unlock', { passphrase: 'smoke-pass-1234' });
    rec('#30-b', '被限流后正确口令仍可解锁（限流不锁死管理员）',
        `POST /api/vault/unlock {passphrase:'smoke-pass-1234'}`,
        ok, ok.status === 200 && ok.body?.ok === true);

    // 并发闸：max=2 in-flight，第 3+ 个立刻 429 VAULT_BUSY（不进队列）
    const par = await Promise.all([1, 2, 3, 4].map((i) => post('/api/vault/unlock', { passphrase: 'wrong-pass-par' + i })));
    const busy = par.filter((r) => r.body?.error === 'VAULT_BUSY');
    rec('#30-c', '并发 /unlock 超上限 → 立刻 429 VAULT_BUSY（不排队）',
        'POST /api/vault/unlock ×4 并发（错口令）',
        par.map((r) => ({ status: r.status, error: r.body?.error ?? null, ms: r.ms })),
        busy.length >= 1 && busy.every((r) => r.ms < 1000),
        '并发闸 (max=2) 在 scrypt 之前；超出直接拒，不排队 —— 所以 BUSY 响应是毫秒级。');

    const ok2 = await post('/api/vault/unlock', { passphrase: 'smoke-pass-1234' });
    rec('#30-d', '并发风暴后正确口令仍可解锁', `POST /api/vault/unlock {passphrase:'smoke-pass-1234'}`,
        ok2, ok2.status === 200 && ok2.body?.ok === true);
}

// ─────────────────────────────── #59 ───────────────────────────────
{
    const before = await fetch(`${ORIGIN}/api/config?token=${PANEL}`);
    const beforeJson = await before.json();

    const r1 = await put('/api/config/runtime', { allow_insecure_coding: true });
    const hashAfterNoConfirm = sha(readFileSync(SETTINGS));
    rec('#59-a', 'false→true 不带 confirm → 409 CONFIG_CONFIRM_REQUIRED 且**不写盘**',
        `PUT /api/config/runtime {"allow_insecure_coding":true}`,
        { status: r1.status, body: r1.body, settingsShaUnchanged: hashAfterNoConfirm === settingsHashBefore },
        r1.status === 409 && r1.body?.error === 'CONFIG_CONFIRM_REQUIRED' && hashAfterNoConfirm === settingsHashBefore);

    const r2 = await put('/api/config/runtime', { allow_insecure_coding: true, confirm: true });
    const hashAfterConfirm = sha(readFileSync(SETTINGS));
    rec('#59-b', '带 confirm:true → 成功且写盘',
        `PUT /api/config/runtime {"allow_insecure_coding":true,"confirm":true}`,
        { status: r2.status, body: r2.body, settingsShaChanged: hashAfterConfirm !== settingsHashBefore },
        r2.status === 200 && r2.body?.ok === true && r2.body?.values?.allow_insecure_coding === true && hashAfterConfirm !== settingsHashBefore);

    const r3 = await put('/api/config/runtime', { allow_insecure_coding: false });
    const hashRestored = sha(readFileSync(SETTINGS));
    rec('#59-c', '改回 false（复原，不需要 confirm）',
        `PUT /api/config/runtime {"allow_insecure_coding":false}`,
        { status: r3.status, body: r3.body, settingsRestored: hashRestored === settingsHashBefore },
        r3.status === 200 && r3.body?.values?.allow_insecure_coding === false && hashRestored === settingsHashBefore,
        '字节级复原：settings.js 的 sha256 与测试前一致。');
}

writeFileSync('./probe-result.json', JSON.stringify({ at: new Date().toISOString(), results: R }, null, 2));
const fails = R.filter((x) => !x.pass);
console.log(`\n\n######## SUMMARY: ${R.length - fails.length}/${R.length} PASS`);
for (const f of fails) console.log(`  FAIL ${f.id} ${f.item}`);
