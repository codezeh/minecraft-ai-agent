/**
 * t-vault-6 —— 注入 / 越权（名字白名单 + 参数化 SQL）
 *
 * 攻击：
 *   ① 名字注入：`../../etc/passwd`、`API KEY`（带空格）、`a'; DROP TABLE secrets;--`、
 *      64+ 超长、空串、纯小写、以数字开头、含换行的名字 ⇒ 全部必须被拒。
 *   ② 值里的 SQL 注入串必须被当成**数据**（原样存取），不能让 `secrets` 表消失。
 *   ③ 静态检查：真正的 SQL 是否都走参数化（`prepare(...).run/get/all` 带 `?`），
 *      有没有字符串拼接进 SQL。
 *
 * 退出码：0 = 攻破（有名字被接受 / 表被破坏 / 存在拼接 SQL）；1 = 未攻破。
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const DB = path.join(TMP, `vault-6-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
process.env.MC_VAULT_DB = DB;
const say = (...a) => console.log('[V6]', ...a);

const V = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);
V.init('Passw0rd-Strong-1');

const badNames = [
    '../../etc/passwd',
    'API KEY',
    "a'; DROP TABLE secrets;--",
    'A'.repeat(70),
    '',
    'openai_api_key',
    '1_STARTS_WITH_DIGIT',
    'NAME_WITH_NEWLINE\n',
    'OPENAI-KEY-DASH',
    ' A_PADDED',
];
let accepted = [];
for (const n of badNames) {
    let ok = false, code = null;
    try { V.setSecret(n, 'sk-x'); ok = true; } catch (e) { code = e.code; }
    say(`  name=${JSON.stringify(n).padEnd(32)} → ${ok ? '**接受**' : '拒绝(' + code + ')'}`);
    if (ok) accepted.push(n);
}

// ② 值里的 SQL 注入串当数据
const evilValue = "sk-'; DROP TABLE secrets; -- x";
let stored = null, readBack = null;
try { V.setSecret('EVIL_VALUE_KEY', evilValue); stored = true; readBack = V.getSecret('EVIL_VALUE_KEY'); } catch (e) { say('  存注入值失败：', e.code); }
say(`  值注入串存取：stored=${stored} roundtrip=${readBack === evilValue ? '原样返回' : '被改'}`);

// 表还在吗？
let tableAlive = true, count = 0;
try { count = V.countSecrets(); } catch { tableAlive = false; }
say(`  secrets 表存活 = ${tableAlive}，行数 = ${count}`);

// ③ 静态检查：SQL 是否参数化
const src = fs.readFileSync(path.join(ROOT, 'src/agent/library/secrets_vault.js'), 'utf8');
const prepareCalls = [...src.matchAll(/prepare\(\s*([`'"])([\s\S]*?)\1\s*\)/g)].map((m) => m[2]);
const interpolated = prepareCalls.filter((sql) => sql.includes('${'));
say(`  prepare() 语句共 ${prepareCalls.length} 条；其中含模板插值 ${interpolated.length} 条`);
if (interpolated.length) say('  插值样本：', JSON.stringify(interpolated.slice(0, 2)));
const withPlaceholder = prepareCalls.filter((sql) => sql.includes('?')).length;
say(`  带 ? 占位符的：${withPlaceholder} 条（其余是 DDL/不带参的 SELECT COUNT）`);

V.closeVault();
say('');
if (accepted.length) {
    say('VULNERABLE：以下名字被接受：', JSON.stringify(accepted));
    process.exit(0);
}
if (!tableAlive) { say('VULNERABLE：secrets 表被破坏（SQL 注入生效）'); process.exit(0); }
if (interpolated.length) { say('VULNERABLE：存在把外部输入拼进 SQL 的语句'); process.exit(0); }
say('SECURE：10 个恶意名字全被白名单拒；注入串按数据处理；SQL 全参数化');
process.exit(1);
