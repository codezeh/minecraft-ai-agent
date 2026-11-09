/**
 * t-vault-3 —— AAD 绑定（跨行挪用密文）
 *
 * 攻击：把 A 行（高危 `OPENAI_API_KEY`）的 (nonce, ciphertext, tag) **原样整行搬到** B 行
 * （`ANTHROPIC_API_KEY`）名下。如果 AAD 没绑 name，`getSecret('ANTHROPIC_API_KEY')` 会成功
 * 返回 A 的值 —— 攻击者只要拿到改库权限，就能把"便宜的 key"换成"贵的 key"而不被发现。
 * 期望：解密失败（GCM 认证失败）⇒ SECURE。
 *
 * 退出码：0 = 攻破（拿到了跨行挪用后的明文）；1 = 未攻破。
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
const DB = path.join(TMP, `vault-3-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
process.env.MC_VAULT_DB = DB;
const say = (...a) => console.log('[V3]', ...a);

const V = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);
const PASS = 'Passw0rd-Strong-1';
V.init(PASS);
V.setSecret('OPENAI_API_KEY', 'sk-EXPENSIVE-high-value-key');
V.setSecret('ANTHROPIC_API_KEY', 'sk-CHEAP-low-value-key');
say('挪动前：getSecret(ANTHROPIC) =', V.getSecret('ANTHROPIC_API_KEY'));
V.closeVault();

// 攻击：把 A 行的三件套搬到 B 行（注意 nonce 有 UNIQUE，所以同时把 A 的 nonce 挪走）
const d = new DatabaseSync(DB);
const a = d.prepare('SELECT nonce, ciphertext, tag FROM secrets WHERE name=?').get('OPENAI_API_KEY');
// ★ 分两步：`nonce` 上有 UNIQUE 约束，直接"互换"会撞约束（那本身就是一道防线）。
//   先把 A 的 nonce 换成随机值腾出位置，再把 A 的**原始**三件套搬到 B 名下。
const originalA = { nonce: Buffer.from(a.nonce), ct: Buffer.from(a.ciphertext), tag: Buffer.from(a.tag) };
d.prepare('UPDATE secrets SET nonce=? WHERE name=?').run(crypto.randomBytes(12), 'OPENAI_API_KEY');
d.prepare('UPDATE secrets SET nonce=?, ciphertext=?, tag=? WHERE name=?')
    .run(originalA.nonce, originalA.ct, originalA.tag, 'ANTHROPIC_API_KEY');
d.close();
say('已把 OPENAI_API_KEY 的 (nonce,ct,tag) 整行搬到 ANTHROPIC_API_KEY 名下');

// 重新解锁（新连接）
V.lock?.();
const V2 = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href + '?fresh=1');
try { V2.unlock(PASS); } catch (e) { say('unlock 失败：', e.code); }

let out = null, err = null;
try { out = V2.getSecret('ANTHROPIC_API_KEY'); } catch (e) { err = e; }
V2.closeVault();

if (err) {
    say(`getSecret(ANTHROPIC_API_KEY) → 抛错 code=${err.code}（AAD=name 生效）`);
    say('SECURE：跨行挪用被 GCM 认证失败拦下');
    process.exit(1);
}
say(`getSecret(ANTHROPIC_API_KEY) → 返回 ${JSON.stringify(String(out).slice(0, 50))}`);
if (String(out) === 'sk-EXPENSIVE-high-value-key') {
    say('VULNERABLE：AAD 没绑 name —— 高危 key 的值可以被挪到低危 key 名下且解密成功');
    process.exit(0);
}
say('未攻破（但返回了非预期内容，需人工看一眼）');
process.exit(1);
