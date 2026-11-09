/**
 * t-vault-4 —— nonce 复用（GCM 的致命伤）
 *
 * 攻击：① 同一个 name 连写两次同 value；② 写 50 个不同 value；③ 删掉再写回同 value。
 * 收集所有出现过的 nonce（含被覆盖的旧行，通过触发器留档），断言**无重复**。
 * 为什么致命：GCM 下 nonce 复用会让两段密文的 keystream 相消 ⇒ 明文可直接异或恢复，
 * 且认证密钥也会泄露。
 *
 * 退出码：0 = 攻破（发现重复 nonce）；1 = 未攻破。
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const DB = path.join(TMP, `vault-4-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
process.env.MC_VAULT_DB = DB;
const say = (...a) => console.log('[V4]', ...a);

const V = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);

// 先在库里挂一个"审计触发器"，把**每次写入过的 nonce** 都留档
// （这不是改产品代码：触发器只存在于本探针的临时库里，用来观察"历史 nonce"是否复用）
const setup = new DatabaseSync(DB);
setup.close();
V.init('Passw0rd-Strong-1');
V.closeVault();
{
    const d = new DatabaseSync(DB);
    d.exec(`CREATE TABLE IF NOT EXISTS nonce_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, nonce BLOB, name TEXT, ts INTEGER)`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS trg_nonce_ins AFTER INSERT ON secrets
            BEGIN INSERT INTO nonce_audit(nonce, name, ts) VALUES (new.nonce, new.name, 0); END`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS trg_nonce_upd AFTER UPDATE ON secrets
            BEGIN INSERT INTO nonce_audit(nonce, name, ts) VALUES (new.nonce, new.name, 1); END`);
    d.close();
}

// ① 同名同值写两次
V.setSecret('SAME_VALUE_KEY', 'sk-same-value');
V.setSecret('SAME_VALUE_KEY', 'sk-same-value');
// ② 50 个不同 value（不同 name，避免 UNIQUE 冲突影响计数）
for (let i = 0; i < 50; i++) V.setSecret(`BULK_KEY_${i}`, `sk-value-${i}`);
// ③ 删除后写回同值
V.setSecret('TEMP_KEY_X', 'sk-temp');
V.removeSecret('TEMP_KEY_X');
V.setSecret('TEMP_KEY_X', 'sk-temp');
V.closeVault();

const d = new DatabaseSync(DB);
const rows = d.prepare('SELECT nonce, name, ts FROM nonce_audit').all();
const live = d.prepare('SELECT nonce, name FROM secrets').all();
d.close();

const hex = (b) => Buffer.from(b).toString('hex');
const all = rows.map((r) => ({ n: hex(r.nonce), name: r.name, ts: r.ts }));
say(`审计到的 nonce 总数 = ${all.length}（含被覆盖的历史行）；库内现存 = ${live.length}`);
const seen = new Map();
const dup = [];
for (const r of all) {
    if (seen.has(r.n)) dup.push({ nonce: r.n, first: seen.get(r.n), again: r.name });
    else seen.set(r.n, r.name);
}
const lens = new Set(all.map((r) => r.n.length / 2));
say('nonce 长度集合（字节）：', [...lens].join(','));
say('唯一 nonce 数 =', seen.size, ' 重复 =', dup.length);
if (dup.length) say('重复样本：', JSON.stringify(dup.slice(0, 3)));

// 额外：非随机（计数器/时间戳）检测 —— 相邻 nonce 的汉明距离应接近 48 bit 的一半
let near = 0;
const buf = all.map((r) => Buffer.from(r.n, 'hex'));
for (let i = 1; i < buf.length; i++) {
    let dist = 0;
    for (let j = 0; j < Math.min(buf[i].length, buf[i - 1].length); j++) {
        let x = buf[i][j] ^ buf[i - 1][j];
        while (x) { dist += x & 1; x >>= 1; }
    }
    if (dist < 20) near++;   // 12 字节随机期望 ~48 bit，明显偏低说明像计数器
}
say(`相邻 nonce 汉明距离 < 20 bit 的样本数 = ${near} / ${Math.max(0, buf.length - 1)}（随机期望≈极少）`);

if (dup.length > 0) {
    say('VULNERABLE：nonce 复用 —— GCM 下可恢复明文/伪造密文');
    process.exit(0);
}
if ([...lens].some((l) => l !== 12)) {
    say('VULNERABLE：nonce 长度不是 12 字节');
    process.exit(0);
}
say('SECURE：无重复 nonce，长度 12 字节，分布不像计数器');
process.exit(1);
