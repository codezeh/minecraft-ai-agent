/**
 * t-vault-5 —— 口令与 KDF
 *
 * 攻击点：
 *   ① 错误口令是否被拒？
 *   ② 错误口令 vs "库被改坏"：错误**码**层面能不能区分（能不能当口令 oracle 用）？
 *   ③ salt 每次 init 是否随机、是否持久化（不能硬编码/复用）？
 *   ④ scrypt 参数是否弱（N < 32768 就是弱）？
 *   ⑤ 篡改库里存的 KDF 参数能否**降级**到弱参数（KDF downgrade）？
 *   ⑥ 错误口令的耗时是否明显短于正确口令（"提前返回"会给爆破方省时间）？
 *
 * 退出码：0 = 攻破（某个攻击点成立）；1 = 未攻破。
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const say = (...a) => console.log('[V5]', ...a);
const PASS = 'Passw0rd-Strong-1';

const freshDb = (tag) => {
    const db = path.join(TMP, `vault-5-${tag}-${process.pid}.db`);
    for (const p of [db, db + '-wal', db + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
    return db;
};
const loadVault = async (db) => {
    process.env.MC_VAULT_DB = db;
    return import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href + `?db=${encodeURIComponent(db)}`);
};

const problems = [];
const note = (ok, label, detail) => {
    say(`  ${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`);
    if (!ok) problems.push(label);
};

// ── ① / ② 错误口令 vs 库损坏：错误码是否可区分 ─────────────────────────────
say('=== ① 错误口令 / ② 口令错 vs 库损坏（错误码可区分性）===');
const dbA = freshDb('main');
const V = await loadVault(dbA);
V.init(PASS);
V.closeVault();

let e1 = null;
try { V.unlock('WrongPass-123'); } catch (e) { e1 = e; }
say('  错误口令 →', e1?.code, '/', String(e1?.message).slice(0, 40));
note(e1?.code === 'VAULT_BAD_PASSPHRASE', '错误口令被拒（BAD_PASSPHRASE）');

// 库损坏：把 verifier 改成随机垃圾
{
    const d = new DatabaseSync(dbA);
    d.prepare('UPDATE vault_meta SET v=? WHERE k=?').run('{"nonce":"00","ct":"00","tag":"00"}', 'verifier');
    d.close();
}
let e2 = null;
try { V.unlock(PASS); } catch (e) { e2 = e; }
say('  损坏的 verifier + 正确口令 →', e2?.code, '/', String(e2?.message).slice(0, 40));
note(e2?.code === 'VAULT_BAD_PASSPHRASE', '库损坏与口令错**同码**（不构成口令 oracle）',
    `code 相同=${e1?.code === e2?.code}`);

// 恢复：重建库
{
    const db = freshDb('timing');
    V.closeVault();
    for (const p of [dbA, dbA + '-wal', dbA + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
    const V2 = await loadVault(db);
    V2.init(PASS); V2.closeVault();
    // ⑥ 计时：正确 vs 错误（都在 scrypt 之后失败，差值不应显著）
    const t = (fn) => { const s = process.hrtime.bigint(); try { fn(); } catch {} return Number(process.hrtime.bigint() - s) / 1e6; };
    const okMs = t(() => V2.unlock(PASS));
    const badMs = t(() => V2.unlock('WrongPass-123'));
    say(`  计时：正确口令 ${okMs.toFixed(1)}ms / 错误口令 ${badMs.toFixed(1)}ms`);
    note(Math.abs(okMs - badMs) / Math.max(okMs, badMs) < 0.5, '错误口令没有"提前返回"（耗时同量级）');
    V2.closeVault();
}

// ── ③ salt 随机且持久化 ────────────────────────────────────────────────────
say('=== ③ salt 随机性 / 持久化 ===');
const salts = [];
for (const tag of ['s1', 's2']) {
    const db = freshDb(tag);
    const Vx = await loadVault(db);
    Vx.init(PASS); Vx.closeVault();
    const d = new DatabaseSync(db);
    const row = d.prepare('SELECT v FROM vault_meta WHERE k=?').get('salt');
    d.close();
    salts.push(row?.v);
    say(`  ${tag} salt = ${String(row?.v).slice(0, 16)}… (${String(row?.v).length / 2}B)`);
    const Vx2 = await loadVault(db);
    const ok = (() => { try { Vx2.unlock(PASS); return true; } catch { return false; } })();
    note(ok, `${tag} salt 被持久化（重启后能解开）`);
    Vx2.closeVault();
}
note(salts[0] && salts[1] && salts[0] !== salts[1], '两次 init 的 salt 不同（随机）');
note(String(salts[0]).length === 32, 'salt 16 字节');

// ── ④ scrypt 参数 ──────────────────────────────────────────────────────────
say('=== ④ scrypt 参数强度 ===');
const db4 = freshDb('kdf');
const V4 = await loadVault(db4);
V4.init(PASS); V4.closeVault();
const metaOf = (db) => {
    const d = new DatabaseSync(db);
    const rows = d.prepare('SELECT k, v FROM vault_meta').all();
    d.close();
    return Object.fromEntries(rows.map((r) => [r.k, r.v]));
};
const m = metaOf(db4);
say('  库内记录：', JSON.stringify({ kdf: m.kdf, N: m.n, r: m.r, p: m.p, keylen: m.keylen }));
say('  代码常量：', JSON.stringify(V4.KDF_PARAMS));
note(Number(m.n) >= 32768, `N=${m.n} ≥ 32768`);
note(String(m.kdf) === 'scrypt', 'KDF 是 scrypt（内存硬，抗 GPU）');

// ── ⑤ KDF 降级：把库里的 n 改成 1024，看 unlock 是否跟着降 ────────────────
say('=== ⑤ KDF 降级攻击（篡改库内 n/r/p）===');
{
    // 注意：改 n 会让"用新 n 派生"的 KEK 与 verifier 不匹配 ⇒ 正常实现应当**仍然解不开**
    const d = new DatabaseSync(db4);
    d.prepare('UPDATE vault_meta SET v=? WHERE k=?').run('1024', 'n');
    d.prepare('UPDATE vault_meta SET v=? WHERE k=?').run('1', 'r');
    d.prepare('UPDATE vault_meta SET v=? WHERE k=?').run('1', 'p');
    d.close();
    const V5 = await loadVault(db4);
    let res = null, err = null;
    try { res = V5.unlock(PASS); } catch (e) { err = e; }
    V5.closeVault();
    say(`  篡改后 unlock → ${err ? '抛错 ' + err.code : '成功 ' + JSON.stringify(res)}`);
    // 两种"安全"表现：a) 仍按 32768 派生（不读库内值）⇒ 成功；b) 读库内值 ⇒ 解不开（也被拒）
    // 危险的是：打印出"成功解锁"且实现盲目相信库内参数（那说明 KDF 被降级但仍能开，攻击者下次可用 1024 爆破）
    const usedStored = String(V5.KDF_PARAMS.N) === '1024';
    note(!usedStored || !!err, 'KDF 参数不可被库内值降级（代码用常量，或降级后解不开）',
        `代码常量 N=${V5.KDF_PARAMS.N}`);
}

V4.closeVault();
say('');
if (problems.length) {
    say('WEAK/VULNERABLE：', JSON.stringify(problems));
    process.exit(0);
}
say('SECURE：口令拒绝/错误码不区分/salt 随机持久化/scrypt N=32768/无 KDF 降级');
process.exit(1);
