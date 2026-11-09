/**
 * t-vault-10 —— unlock 失败限流：能不能爆破？会不会被用来 DoS？
 *
 * 两个方向：
 *   ① 爆破面：连续打错口令，第 6 次起必须 429（否则拿到 token 的人可以本地无限猜，scrypt 只拖慢不挡住）。
 *   ② 可用性面：**限流期间用正确口令**是否也被 429？
 *      —— 如果被挡，那么持有 token 的攻击者只要每 60 秒故意打错一次，就能让管理员**永远**解不开库。
 *      这是可用性缺陷（WEAK），不是机密性缺陷（不泄漏任何东西）。
 *
 * 退出码：0 = 攻破（① 不限流 ⇒ 可无限爆破）；1 = 未攻破（① 有 429），② 的结果单独打印。
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
const say = (...a) => console.log('[V10]', ...a);
const PASS = 'Passw0rd-Strong-1';
const TOKEN = 'probe10-token-' + Date.now();
const PORT = 65240 + (process.pid % 40);

const DB = path.join(TMP, `vault-10-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }

const childFile = path.join(TMP, `ms10-${process.pid}.mjs`);
fs.writeFileSync(childFile, `
import { pathToFileURL } from 'node:url';
const { createMindServer } = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, 'src/mindcraft/mindserver.js'))}).href);
createMindServer(false, ${PORT});
setTimeout(() => process.exit(0), 40000);
`, 'utf8');

const cp = spawn(process.execPath, [childFile], {
    cwd: TMP,
    env: { ...process.env, MINDSERVER_TOKEN: TOKEN, MC_VAULT_DB: DB },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
cp.stdout.on('data', (d) => { out += d; });
cp.stderr.on('data', (d) => { out += d; });

const req = (method, p, body = null) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
        host: '127.0.0.1', port: PORT, path: `${p}?token=${encodeURIComponent(TOKEN)}`, method,
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', () => resolve({ status: 0, body: '' }));
    if (data) r.write(data);
    r.end();
});

// 等 server 起来
const t0 = Date.now();
let up = false;
while (Date.now() - t0 < 20000) {
    const r = await req('GET', '/api/vault/status');
    if (r.status) { up = true; break; }
    await new Promise((s) => setTimeout(s, 250));
}
if (!up) { say('CANNOT-RUN：mindserver 没起来', out.slice(-200)); cp.kill(); process.exit(2); }

// 初始化（init 即解锁）
const init = await req('POST', '/api/vault/init', { passphrase: PASS });
say('init →', init.status);
// 先上锁，才能测 unlock
const lk = await req('POST', '/api/vault/lock');
say('lock →', lk.status);

say('=== ① 连续打错口令，看第几次开始 429 ===');
const statuses = [];
for (let i = 1; i <= 8; i++) {
    const r = await req('POST', '/api/vault/unlock', { passphrase: `WrongPass-${i}xx` });
    statuses.push(r.status);
    say(`  第 ${i} 次错口令 → ${r.status} ${String(r.body).slice(0, 90)}`);
    await new Promise((s) => setTimeout(s, 30));
}
const got429 = statuses.includes(429);
const firstLimit = statuses.indexOf(429) + 1;

say('');
say('=== ② 限流窗口内用**正确**口令 ===');
const okTry = await req('POST', '/api/vault/unlock', { passphrase: PASS });
say(`  正确口令 → ${okTry.status} ${String(okTry.body).slice(0, 110)}`);
const legitBlocked = okTry.status === 429;

cp.kill();
say('');
if (!got429) {
    say('VULNERABLE：8 次错误口令都没有 429 —— 拿到 token 的人可以无限爆破（scrypt 只拖慢）');
    process.exit(0);
}
say(`SECURE（机密性）：第 ${firstLimit} 次起限流 429`);
if (legitBlocked) {
    say('WEAK（可用性）：限流窗口内**正确口令**也被 429 ⇒ 持有 token 的攻击者可周期性打错，让管理员永远解不开库'
        + '（不泄漏机密，但可长期 DoS；建议：正确口令应清零计数并放行，或按 IP 分开计数）');
} else {
    say('正确口令在限流窗口内仍被放行（计数可能已按成功清零）');
}
process.exit(1);
