/**
 * t17 独立验证 —— 凭据保管库（t15）三条底线
 *
 * 立场：**不采信 tools/vault_unit.mjs**（那是实现者写的），这里自己造库、自己读字节、
 * 自己篡改、自己调 API。只用产品代码（src/agent/library/secrets_vault.js）+ node 内置。
 *
 * 断言：
 *  (a) 明文不入库：把 .db 当二进制读，搜我自己写入的独特明文 → 必须 0 命中
 *  (b) 对外结构不含 value：listSecrets() 返回对象的键里没有 value/secret/plaintext；
 *      且 JSON 里搜不到明文
 *  (c) 篡改 1 字节 ct → 解密必须失败（GCM 认证）
 *  (d) 未解锁时 getSecret/listSecrets 必须抛（相当于 401/409 的库层判据）
 *  (e) name 白名单：非法字符被拒（库层）
 *  (f) hint 只泄露后 4 位 + 长度，不含完整明文
 *
 * 退出码：0 = 六条全过；1 = 有断言失败。
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.MC_VAULT_DB;
if (!DB || DB === ':memory:') {
    console.error('CANNOT-RUN：需要 MC_VAULT_DB 指向一个临时文件路径');
    process.exit(2);
}
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { if (existsSync(p)) unlinkSync(p); } catch {} }

const V = await import('file:///E:/我的世界ai/mindcraft/src/agent/library/secrets_vault.js');

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' —— ' + detail : ''}`);
};

// 我自己挑的独特明文（含随机段，保证不可能出现在代码/模板里）
const MARK = 't17vault' + Math.random().toString(36).slice(2, 10);
const PLAINTEXT = `sk-t17-${MARK}-0123456789abcdef`;
const NAME = 'T17_VERIFY_KEY';
const PASS = 't17-passphrase-very-secret';

// ── 初始化 + 写入 ───────────────────────────────────────────────
V.init(PASS);
check('init 后 isInitialized=true', V.isInitialized() === true);
check('init 后自动解锁', V.isUnlocked() === true, `isUnlocked=${V.isUnlocked()}`);

V.setSecret(NAME, PLAINTEXT);
check('setSecret 成功后可读回（证明加密可逆、真的能用）', V.getSecret(NAME) === PLAINTEXT);

// ── (a) 明文不入库 ─────────────────────────────────────────────
const raw = readFileSync(DB);
const hits = [];
for (const needle of [MARK, PLAINTEXT, PASS]) {
    if (raw.includes(Buffer.from(needle, 'utf8'))) hits.push(needle);
}
check('(a) .db 原始字节搜不到明文/标记/口令', hits.length === 0,
    `dbBytes=${raw.length}，命中=${hits.length ? JSON.stringify(hits) : '0'}`);

// ── (b) 对外结构不含 value ──────────────────────────────────────
const listed = V.listSecrets();
const keysUsed = new Set(listed.flatMap((r) => Object.keys(r)));
const forbidden = ['value', 'secret', 'plaintext', 'key', 'data', 'v'];
const leakedKeys = [...keysUsed].filter((k) => forbidden.includes(k.toLowerCase()));
const listJson = JSON.stringify(listed);
check('(b1) listSecrets 对象键里无 value/secret/plaintext', leakedKeys.length === 0,
    `键=${[...keysUsed].join(',')}`);
check('(b2) listSecrets 的 JSON 里搜不到明文', !listJson.includes(MARK) && !listJson.includes(PLAINTEXT));
check('(b3) listSecrets 只返回 name/hint/updatedAt/updatedBy', listed.length === 1 &&
    [...keysUsed].sort().join(',') === 'hint,name,updatedAt,updatedBy', `键=${[...keysUsed].join(',')}`);

// ── (f) hint 只泄露后 4 位 + 长度 ───────────────────────────────
const hint = listed[0]?.hint ?? '';
check('(f) hint 含后 4 位、含长度、不含完整明文',
    hint.includes(PLAINTEXT.slice(-4)) && /\(\d+\s*字\)/.test(hint) && !hint.includes(MARK),
    `hint=${hint}`);

// ── (c) 篡改 1 字节 ct → 解密失败 ───────────────────────────────
{
    const dbh = new DatabaseSync(DB);
    const row = dbh.prepare('SELECT name, ciphertext, nonce, tag FROM secrets WHERE name = ?').get(NAME);
    dbh.close();
    check('(c0) 库里有 ct/nonce/tag 三列且非空',
        !!row && row.ciphertext?.length > 0 && row.nonce?.length === 12 && row.tag?.length === 16,
        `ct=${row?.ct?.length}B nonce=${row?.nonce?.length}B tag=${row?.tag?.length}B`);

    // 翻转 ct 的最后一个字节
    const t = new DatabaseSync(DB);
    const ct = Buffer.from(row.ciphertext);
    ct[ct.length - 1] ^= 0x01;
    t.prepare('UPDATE secrets SET ciphertext = ? WHERE name = ?').run(ct, NAME);
    t.close();

    let failed = false; let errCode = '';
    try { V.getSecret(NAME); } catch (e) { failed = true; errCode = e?.code ?? e?.message ?? String(e); }
    check('(c) 篡改 ct 1 字节后解密必然失败（GCM 认证生效）', failed, `抛出=${failed} code=${errCode}`);

    // 反向对照：篡改 nonce 也必须失败
    const t2 = new DatabaseSync(DB);
    const row2 = t2.prepare('SELECT nonce FROM secrets WHERE name = ?').get(NAME);
    const n = Buffer.from(row2.nonce); n[0] ^= 0x01;
    t2.prepare('UPDATE secrets SET nonce = ?, ciphertext = ? WHERE name = ?').run(n, Buffer.from(row.ciphertext), NAME);
    t2.close();
    let failed2 = false;
    try { V.getSecret(NAME); } catch { failed2 = true; }
    check('(c2) 篡改 nonce 同样失败', failed2);
}

// ── (d) 未解锁时库层必须拒绝 ────────────────────────────────────
V.lock();
check('(d0) lock() 后 isUnlocked=false', V.isUnlocked() === false);
let dFailed = 0;
try { V.getSecret(NAME); } catch { dFailed++; }
try { V.listSecrets(); } catch { dFailed++; }
try { V.setSecret('T17_ANOTHER_KEY', 'x'); } catch { dFailed++; }
check('(d) 未解锁时 get/list/set 三条都抛', dFailed === 3, `抛出条数=${dFailed}/3`);

// ── (e) name 白名单 ────────────────────────────────────────────
V.unlock(PASS);
check('unlock 正确口令后恢复可用', V.isUnlocked() === true);
const badNames = ['lower_case', '1LEADING_DIGIT', 'A B', 'A-B', 'X', 'DROP TABLE', 'a'.repeat(70)];
let rejected = 0;
for (const n of badNames) {
    try { V.setSecret(n, 'v'); } catch (e) { if (e?.code) rejected++; }
}
check('(e) 7 个非法 name 全被拒', rejected === badNames.length, `拒绝=${rejected}/${badNames.length}`);

// ── 报告 ──────────────────────────────────────────────────────
const bad = results.filter((r) => !r.ok);
console.log(`\n=== 小计：PASS ${results.length - bad.length} / ${results.length}，FAIL ${bad.length} ===`);
try { V.lock(); } catch {}
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { if (existsSync(p)) unlinkSync(p); } catch {} }
process.exit(bad.length ? 1 : 0);
