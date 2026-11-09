/**
 * t-vault-9 —— 库文件权限（ACL）是否真的收紧了
 *
 * 背景：实现自称"NTFS 上 chmod 600 是空操作，所以用 icacls 收紧到 只当前用户+SYSTEM+Administrators"。
 * 这条必须**实测**：读 icacls 的真实输出，看继承来的 `Authenticated Users` / `Everyone` 还在不在。
 * 为什么重要：库里有全部 API key 的密文 + salt + verifier = 离线爆破的全套材料。
 *
 * 判定：若出现 Authenticated Users / Everyone / Users / INTERACTIVE 可写或可读 ⇒ VULNERABLE。
 *
 * 退出码：0 = 攻破（ACL 没收紧）；1 = 未攻破。
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const say = (...a) => console.log('[V9]', ...a);

const DB = path.join(TMP, `vault-9-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
process.env.MC_VAULT_DB = DB;

const V = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);
V.init('Passw0rd-Strong-1');
V.setSecret('OPENAI_API_KEY', 'sk-acl-probe');
V.closeVault();

const exists = fs.existsSync(DB);
say('库文件：', DB, ' 存在 =', exists, ' 大小 =', exists ? fs.statSync(DB).size : 0);

let aclText = '';
try {
    aclText = process.platform === 'win32'
        ? execFileSync('icacls', [DB], { encoding: 'utf8' })
        : execFileSync('stat', ['-c', '%A %U:%G', DB], { encoding: 'utf8' });
} catch (e) {
    say('CANNOT-RUN：读 ACL 失败：', String(e.message).slice(0, 120));
    process.exit(2);
}
say('=== icacls 原始输出 ===');
for (const line of String(aclText).trim().split('\n')) say('  ' + line.trim());

const risky = ['Authenticated Users', 'Everyone', 'BUILTIN\\Users', 'INTERACTIVE', 'ANONYMOUS'];
const found = risky.filter((g) => String(aclText).includes(g));
say('');
say('可疑主体命中：', found.length ? JSON.stringify(found) : '无');

// 继承位（(I)）不该还在（继承意味着父目录的授权会继续生效）
const inherited = /\(I\)\(/.test(aclText) || /\(I\)/.test(aclText);
const inheritsMention = inherited ? String(aclText).split('\n').filter((l) => l.includes('(I)')).map((l) => l.trim()) : [];
say('仍带继承标记 (I) 的条目：', inheritsMention.length, inheritsMention.length ? JSON.stringify(inheritsMention) : '');

V.closeVault();
if (found.length) {
    say('VULNERABLE：库文件对', JSON.stringify(found), '可见 —— 同机其他账户可读取密文+salt+verifier（离线爆破素材）');
    process.exit(0);
}
say(`SECURE：库文件只授 当前用户/SYSTEM/Administrators（继承已断：${!inherited || inheritsMention.every((l) => /NW|Low Mandatory/.test(l))}）`);
process.exit(1);
