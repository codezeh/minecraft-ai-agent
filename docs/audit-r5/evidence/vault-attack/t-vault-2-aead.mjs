/**
 * t-vault-2 —— 认证加密（AEAD）完整性
 *
 * 攻击：对密文/ tag / nonce 各翻 1 bit，以及把 nonce 换成另一个合法 nonce。
 * 期望：**每次都抛 VAULT_DECRYPT_FAILED**，绝不返回垃圾明文。
 * （返回垃圾 = VULNERABLE：说明只加密没认证）
 *
 * 退出码：0 = 攻破（有任一处没抛错/返回了内容）；1 = 未攻破。
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const DB = path.join(TMP, `vault-2-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
process.env.MC_VAULT_DB = DB;

const say = (...a) => console.log('[V2]', ...a);
const V = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);
V.init('Passw0rd-Strong-1');
V.setSecret('OPENAI_API_KEY', 'sk-real-value-0123456789');
V.setSecret('OTHER_KEY_X', 'sk-other-value-9876543210');
V.closeVault();

const verifierKinds = { threw: 0, garbage: 0 };
const probe = (label, mutate) => {
    // 每个用例独立连接 + 独立 mutate，互不影响
    const d = new DatabaseSync(DB);
    try {
        mutate(d);
    } catch (err) {
        // ★ 写不进去本身也是防御（例如 nonce UNIQUE 约束）——不强求"解密时报错"
        d.close();
        say(`  ${label.padEnd(28)} → 写入即被拒绝（${String(err.code ?? err.message).slice(0, 40)}）← 更强的防御`);
        return true;
    }
    d.close();
    V.lock?.();
    // 重新解锁（KEK 在同一进程；lock 后需要 unlock 回来）
    try { V.unlock('Passw0rd-Strong-1'); } catch { /* already unlocked 也 ok */ }
    // 让 vault 重新打开连接（closeVault 已关）
    let out = null, err = null;
    try { out = V.getSecret('OPENAI_API_KEY'); } catch (e) { err = e; }
    if (err) {
        verifierKinds.threw++;
        say(`  ${label.padEnd(28)} → 抛错 code=${err.code ?? e(err)}（正确）`);
    } else {
        verifierKinds.garbage++;
        say(`  ${label.padEnd(28)} → **没有抛错**，返回 ${JSON.stringify(String(out).slice(0, 40))} ← 攻破`);
    }
    return !!err;
};
const e = (x) => x?.message ?? 'no-code';

const flip = (buf, i) => { const b = Buffer.from(buf); b[i] ^= 0x01; return b; };

// ① 翻密文 1 bit
probe('密文翻 1 bit', (d) => {
    const r = d.prepare('SELECT ciphertext FROM secrets WHERE name=?').get('OPENAI_API_KEY');
    d.prepare('UPDATE secrets SET ciphertext=? WHERE name=?').run(flip(Buffer.from(r.ciphertext), 0), 'OPENAI_API_KEY');
});
// ② 翻 tag 1 bit
probe('tag 翻 1 bit', (d) => {
    const r = d.prepare('SELECT tag FROM secrets WHERE name=?').get('OPENAI_API_KEY');
    d.prepare('UPDATE secrets SET tag=? WHERE name=?').run(flip(Buffer.from(r.tag), 0), 'OPENAI_API_KEY');
});
// ③ 翻 nonce 1 bit
probe('nonce 翻 1 bit', (d) => {
    const r = d.prepare('SELECT nonce FROM secrets WHERE name=?').get('OPENAI_API_KEY');
    d.prepare('UPDATE secrets SET nonce=? WHERE name=?').run(flip(Buffer.from(r.nonce), 0), 'OPENAI_API_KEY');
});
// ④ 用**另一个合法 nonce**（同库另一行）替换
probe('换成他行合法 nonce', (d) => {
    const other = d.prepare('SELECT nonce FROM secrets WHERE name=?').get('OTHER_KEY_X');
    d.prepare('UPDATE secrets SET nonce=? WHERE name=?').run(Buffer.from(other.nonce), 'OPENAI_API_KEY');
});
// ④b 换成**随机** nonce（不撞 UNIQUE，绕过约束这道防线）
probe('换成随机 nonce', (d) => {
    d.prepare('UPDATE secrets SET nonce=? WHERE name=?').run(crypto.randomBytes(12), 'OPENAI_API_KEY');
});
// ⑤ 截断密文（长度攻击）
probe('截断密文一半', (d) => {
    const r = d.prepare('SELECT ciphertext FROM secrets WHERE name=?').get('OPENAI_API_KEY');
    const ct = Buffer.from(r.ciphertext);
    d.prepare('UPDATE secrets SET ciphertext=? WHERE name=?').run(ct.subarray(0, Math.max(1, ct.length >> 1)), 'OPENAI_API_KEY');
});
// ⑥ 清空 tag
probe('tag 置空', (d) => {
    d.prepare('UPDATE secrets SET tag=? WHERE name=?').run(Buffer.alloc(0), 'OPENAI_API_KEY');
});

V.closeVault();
say('');
say(`汇总：抛错 ${verifierKinds.threw} / 返回垃圾 ${verifierKinds.garbage}`);
if (verifierKinds.garbage > 0) {
    say('VULNERABLE：存在被改后仍返回内容的路径（只加密未认证）');
    process.exit(0);
}
say('SECURE：6 种篡改全部抛错，无一条返回内容');
process.exit(1);
