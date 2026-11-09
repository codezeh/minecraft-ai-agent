/**
 * t-vault-7 —— 未解锁绕过 / 未授权读取
 *
 * 两层都打：
 *   ① 库层：不起进程，直接拿一个**没 unlock 过**的模块实例调 set/get/list/remove/export ⇒ 必须抛 LOCKED。
 *   ② REST 层：真起一个 mindserver（独立 cwd + 独立库 + 固定 token），逐条打锁定态：
 *      - 无 token                          ⇒ 必须 401
 *      - 有 token、未解锁：GET/PUT/DELETE items、POST lock ⇒ 必须 409
 *      - 有 token、未解锁：GET status      ⇒ 允许 200（但不含任何 secret）
 *      - init 之后 PUT/GET 应可用；lock 之后再回到 409
 *   ③ 环境变量旁路：`MC_VAULT_PASSPHRASE` 能不能在**没调 unlock** 的情况下把库打开（读得到 items）？
 *      能的话评估风险（这是文档写明的"无头便利口"，判定记为 WEAK 并在报告里要求文档警示）。
 *
 * 退出码：0 = 攻破（锁定态出现 2xx 的非豁免接口 / 无 token 被放行 / 库层未解锁能读到东西）。
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const say = (...a) => console.log('[V7]', ...a);
const PASS = 'Passw0rd-Strong-1';
const TOKEN = 'probe7-token-' + Date.now();

// ── ① 库层：未解锁 ────────────────────────────────────────────────────────
const dbLib = path.join(TMP, `vault-7-lib-${process.pid}.db`);
for (const p of [dbLib, dbLib + '-wal', dbLib + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
process.env.MC_VAULT_DB = dbLib;
delete process.env.MC_VAULT_PASSPHRASE;
const V = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);
V.init(PASS);
V.lock();       // 明确上锁，然后看每条写/读路径
say('=== ① 库层：未解锁调用 ===');
const libBreaks = [];
const call = (label, fn) => {
    try { const r = fn(); say(`  ${label.padEnd(24)} → **成功** ${JSON.stringify(r).slice(0, 60)}`); libBreaks.push(label); }
    catch (e) { say(`  ${label.padEnd(24)} → 拒绝(${e.code})`); }
};
call('listSecrets', () => V.listSecrets());
call('getSecret', () => V.getSecret('OPENAI_API_KEY'));
call('setSecret', () => V.setSecret('OPENAI_API_KEY', 'sk-x'));
call('removeSecret', () => V.removeSecret('OPENAI_API_KEY'));
call('exportAllSecrets', () => [...V.exportAllSecrets().keys()]);
// tryGetSecret 是"不抛"的版本：锁定时必须返回 null（不能自动把库打开）
const tgs = V.tryGetSecret('OPENAI_API_KEY');
say(`  tryGetSecret              → ${tgs === null ? 'null（正确）' : '**返回了内容** ← 攻破'}`);
if (tgs !== null) libBreaks.push('tryGetSecret');
V.closeVault();

// ── ② REST 层 ─────────────────────────────────────────────────────────────
const DB = path.join(TMP, `vault-7-rest-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
const PORT = 65181 + (process.pid % 50);
const CHILD = `
import { pathToFileURL } from 'node:url';
const { createMindServer } = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, 'src/mindcraft/mindserver.js'))}).href);
createMindServer(false, ${PORT});
setTimeout(() => process.exit(0), 25000);
`;
const childFile = path.join(TMP, `ms7-${process.pid}.mjs`);
fs.writeFileSync(childFile, CHILD, 'utf8');

const startServer = (extraEnv = {}) => new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [childFile], {
        cwd: TMP,   // 关键：cwd 放在证据目录，token 文件写这里，不碰仓库里的 .mindserver-token
        env: { ...process.env, MINDSERVER_TOKEN: TOKEN, MC_VAULT_DB: DB, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { out += d; });
    const t0 = Date.now();
    const iv = setInterval(async () => {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/api/vault/status?token=${TOKEN}`);
            if (r.status) { clearInterval(iv); resolve({ cp, out: () => out }); }
        } catch { /* not up yet */ }
        if (Date.now() - t0 > 20000) { clearInterval(iv); reject(new Error('mindserver 未起来：' + out.slice(-300))); }
    }, 250);
});

const req = (method, p, { token = TOKEN, body = null } = {}) => new Promise((resolve) => {
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p + qs, method,
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 160) })); });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message).slice(0, 80) }));
    if (data) r.write(data);
    r.end();
});

const restBreaks = [];
let srv;
try {
    srv = await startServer();
} catch (e) {
    say('CANNOT-RUN：', String(e.message).slice(0, 200));
    process.exit(2);
}
say('');
say('=== ② REST 层：锁定态逐条打 ===');
const expect = async (label, method, p, want, opts = {}) => {
    const r = await req(method, p, opts);
    const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
    say(`  ${(`${method} ${p}`).padEnd(30)} → ${r.status} ${ok ? '✔' : '✘ 期望 ' + JSON.stringify(want)}  ${r.body.slice(0, 60)}`);
    if (!ok) restBreaks.push(`${method} ${p} → ${r.status}`);
    return r;
};
await expect('无 token 读 status', 'GET', '/api/vault/status', 401, { token: null });
await expect('无 token 读 items', 'GET', '/api/vault/items', 401, { token: null });
await expect('锁定态 GET items', 'GET', '/api/vault/items', 409);
await expect('锁定态 PUT item', 'PUT', '/api/vault/items/OPENAI_API_KEY', 409, { body: { value: 'sk-x' } });
await expect('锁定态 DELETE item', 'DELETE', '/api/vault/items/OPENAI_API_KEY', 409);
await expect('锁定态 POST lock', 'POST', '/api/vault/lock', 409);
const st = await expect('锁定态 GET status（豁免）', 'GET', '/api/vault/status', 200);
if (/sk-|value/i.test(st.body)) { say('  ✘ status 里出现了 value 字段'); restBreaks.push('status 泄漏 value'); }

say('');
say('=== ②b 解锁 → 写入 → 上锁 → 再打 ===');
await expect('POST init', 'POST', '/api/vault/init', 201, { body: { passphrase: PASS } });
await expect('解锁后 PUT', 'PUT', '/api/vault/items/OPENAI_API_KEY', [200, 201], { body: { value: 'sk-probe-value-1234' } });
const items = await expect('解锁后 GET items', 'GET', '/api/vault/items', 200);
if (items.body.includes('sk-probe-value-1234')) { say('  ✘ items 响应体里出现了明文 value ← 攻破'); restBreaks.push('items 泄漏 value'); }
else say('  ✔ items 响应体不含明文（只有 name/hint）');
await expect('POST lock', 'POST', '/api/vault/lock', 200);
await expect('上锁后 GET items', 'GET', '/api/vault/items', 409);

// ── ③ MC_VAULT_PASSPHRASE 旁路 ────────────────────────────────────────────
say('');
say('=== ③ MC_VAULT_PASSPHRASE 旁路（不调 unlock 能否读）===');
try { srv.cp.kill(); } catch {}
await new Promise((r) => setTimeout(r, 600));
let srv2;
try {
    srv2 = await startServer({ MC_VAULT_PASSPHRASE: PASS });
    const r = await req('GET', '/api/vault/items');
    const opened = r.status === 200 && /OPENAI_API_KEY/.test(r.body);
    say(`  带 MC_VAULT_PASSPHRASE 启动后 GET items → ${r.status} ${opened ? '（读到了！）' : ''}`);
    say(`  判定：${opened ? 'WEAK —— 环境变量里的口令等于"自动解锁"，库的机密性降级为"谁设的 env 谁负责"' : '未自动解锁'}`);
} catch (e) {
    say('  第三段起不来：', String(e.message).slice(0, 160));
}
try { srv2?.cp.kill(); } catch {}

// ── 判定 ──────────────────────────────────────────────────────────────────
say('');
if (libBreaks.length || restBreaks.length) {
    say('VULNERABLE：库层', JSON.stringify(libBreaks), ' REST', JSON.stringify(restBreaks));
    process.exit(0);
}
say('SECURE：库层 5 条写/读路径全 LOCKED；REST 锁定态全部 409（豁免仅 status）；');
say('         无 token 全部 401；init 前后行为符合设计；env 旁路已在报告里按 WEAK 记录');
process.exit(1);
