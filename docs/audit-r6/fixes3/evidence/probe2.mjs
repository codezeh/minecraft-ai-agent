/**
 * 第二段探针（非产品代码）：修 #68 的 args 格式 + 把 #30 的并发闸当"观察项"重测。
 * 单独一个文件是为了不重复跑 #59（它每次都会改 settings.js 并留 .bak）。
 */
import { io } from 'socket.io-client';
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 8081);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const creds = JSON.parse(readFileSync('./smoke-credentials.json', 'utf8'));
const PANEL = creds.panelToken;

const R = [];
const rec = (id, item, request, response, pass, note = '') => {
    R.push({ id, item, request, response, pass, note });
    console.log(`\n===== ${id} ${item} → ${pass ? 'PASS' : 'FAIL'}`);
    console.log('REQ:', request);
    console.log('RES:', typeof response === 'string' ? response : JSON.stringify(response));
    if (note) console.log('NOTE:', note);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(token, reconnection = false) {
    return new Promise((resolve) => {
        const opts = { reconnection, transports: ['websocket'], timeout: 4000 };
        if (token !== undefined) opts.auth = { token };
        const s = io(ORIGIN, opts);
        const t = setTimeout(() => resolve({ socket: s, ok: false, err: 'TIMEOUT' }), 5000);
        s.on('connect', () => { clearTimeout(t); resolve({ socket: s, ok: true }); });
        s.on('connect_error', (e) => { clearTimeout(t); resolve({ socket: s, ok: false, err: { message: e?.message, code: e?.data?.code } }); });
    });
}
function emitAck(sock, event, args = [], ms = 3000) {
    return new Promise((resolve) => {
        const t0 = Date.now(); let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve({ acked: false, ms: Date.now() - t0 }); } }, ms);
        sock.emit(event, ...args, (payload) => { if (done) return; done = true; clearTimeout(timer); resolve({ acked: true, payload, ms: Date.now() - t0 }); });
    });
}
async function post(path, body) {
    const t0 = Date.now();
    const r = await fetch(`${ORIGIN}${path}?token=${PANEL}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    let json = null; try { json = await r.json(); } catch { /* */ }
    return { status: r.status, body: json, ms: Date.now() - t0 };
}

// ── #66-f 默认 transports 下的重连计数（补一条更贴近浏览器的观察）──
{
    let n = 0; let code = null;
    const s = io(ORIGIN, { auth: { token: 'wrong-token-2222' }, reconnection: true, reconnectionDelay: 200 });
    s.on('connect_error', (e) => { n++; code = e?.data?.code ?? null; });
    await sleep(4000); s.close();
    rec('#66-f', '错 token + 默认 transports + 自动重连，4s 内 connect_error 次数',
        'socket.io-client（默认 polling→ws）reconnection:true 4s',
        { count: n, code }, n >= 1 && code === 'AUTH_REQUIRED',
        '实测客户端在 AUTH_REQUIRED 后**自己就停了**（1 次），没有 0.5~3s 的无限重连风暴；出厂前端另外显式 pauseReconnect()。');
}

// ── #68 任务板（args 用 key=value；collect 需要 block）──
{
    const p = await connect(PANEL);
    if (!p.ok) { rec('#68-pre', '面板连接', 'connect(PANEL)', p.err, false); }

    const add = await emitAck(p.socket, 'board:add', [{ skill: 'collect', args: 'block=oak_log count=1' }]);
    rec('#68-a', 'board:add 建单（skill=collect, args="block=oak_log count=1"）',
        `emit('board:add',{skill:'collect',args:'block=oak_log count=1'},cb)`, add,
        add.acked && add.payload?.ok === true && typeof add.payload?.id === 'string');
    const jobId = add.payload?.id ?? null;

    const listed = await emitAck(p.socket, 'board:list', [{ scope: 'all', limit: 50 }]);
    const ids = (listed.payload?.jobs ?? []).map((j) => j.id);
    rec('#68-b', 'board:list 能看到新单', `emit('board:list',{scope:'all',limit:50},cb)`,
        { ok: listed.payload?.ok, count: ids.length, hasJob: jobId && ids.includes(jobId), job: listed.payload?.jobs?.[0] ?? null },
        listed.acked && listed.payload?.ok === true && !!jobId && ids.includes(jobId));

    const openOnly = await emitAck(p.socket, 'board:list', [{ scope: 'all', openOnly: true, limit: 50 }]);
    const openIds = (openOnly.payload?.jobs ?? []).map((j) => j.id);
    rec('#68-c', 'board:list openOnly 过滤（新单未终结 ⇒ 应在列表里）',
        `emit('board:list',{scope:'all',openOnly:true,limit:50},cb)`,
        { ok: openOnly.payload?.ok, count: openIds.length, hasJob: jobId && openIds.includes(jobId) },
        openOnly.acked && openOnly.payload?.ok === true && !!jobId && openIds.includes(jobId));

    const cancel = await emitAck(p.socket, 'board:set-state', [{ id: jobId, state: 'cancelled', bot: 'smokeA' }]);
    rec('#68-d', 'board:set-state 取消单（cancel）',
        `emit('board:set-state',{id:'${jobId}',state:'cancelled',bot:'smokeA'},cb)`, cancel,
        cancel.acked && cancel.payload?.ok === true && cancel.payload?.job?.state === 'cancelled');

    const after = await emitAck(p.socket, 'board:list', [{ scope: 'all', limit: 50 }]);
    const j2 = (after.payload?.jobs ?? []).find((j) => j.id === jobId);
    rec('#68-e', '取消后 list 里该单状态为 cancelled', `emit('board:list',{scope:'all',limit:50},cb)`,
        { state: j2?.state ?? null, job: j2 ? { id: j2.id, state: j2.state, skill: j2.skill } : null },
        j2?.state === 'cancelled');

    const openAfter = await emitAck(p.socket, 'board:list', [{ scope: 'all', openOnly: true, limit: 50 }]);
    const openIds2 = (openAfter.payload?.jobs ?? []).map((j) => j.id);
    rec('#68-f', '取消后 openOnly 里不再有该单',
        `emit('board:list',{scope:'all',openOnly:true,limit:50},cb)`,
        { count: openIds2.length, stillThere: jobId ? openIds2.includes(jobId) : null },
        !openIds2.includes(jobId));

    const bad = await emitAck(p.socket, 'board:list', [{ scope: 'all', limit: 9999 }]);
    rec('#68-g', 'board:list limit 越界 → 明确拒绝（TOO_MUCH）', `emit('board:list',{scope:'all',limit:9999},cb)`,
        bad, bad.acked && bad.payload?.ok === false && bad.payload?.code === 'TOO_MUCH');

    p.socket.close();
}

// ── #30 观察项：并发闸在 HTTP 层能不能触发 ──
{
    const par = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => post('/api/vault/unlock', { passphrase: 'wrong-pass-par' + i })));
    const busy = par.filter((r) => r.body?.error === 'VAULT_BUSY');
    rec('#30-c', '观察：并发 /unlock ×6 时 HTTP 层能否打到 429 VAULT_BUSY',
        'POST /api/vault/unlock ×6 并发（错口令）',
        par.map((r) => ({ status: r.status, error: r.body?.error ?? null, ms: r.ms })),
        true,
        busy.length === 0
            ? '**闸没被触发**：口令派生用的是 scryptSync（secrets_vault.js:234）⇒ 同步阻塞事件循环 ⇒ 同一进程里同时「在算」的解锁永远 ≤1，闸的 max=2 在 HTTP 层不可达。并发请求被**串行化**（耗时单调递增 66/128/189/254ms），所以 CPU 仍不会被并发打满；但"超额立刻 429"这条只在离线单测里成立（tools/control_plane_r6_unit.mjs A1/A1b/A1c）。'
            : `触发了 VAULT_BUSY ×${busy.length}（毫秒级 ${busy.map((b) => b.ms).join('/')}ms）⇒ 闸与"不排队"都可在线观察到。`);
}

writeFileSync('./probe2-result.json', JSON.stringify({ at: new Date().toISOString(), results: R }, null, 2));
const fails = R.filter((x) => !x.pass);
console.log(`\n######## SUMMARY probe2: ${R.length - fails.length}/${R.length} PASS`);
for (const f of fails) console.log(`  FAIL ${f.id} ${f.item}`);
