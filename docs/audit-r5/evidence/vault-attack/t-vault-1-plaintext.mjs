/**
 * t-vault-1 —— 明文泄漏（canary 全盘搜索）
 *
 * 攻击：写一个特征串 `sk-CANARY-<random>`，然后在这些位置搜它，**命中即攻破**：
 *   ① `.secrets.db` 原始字节
 *   ② sqlite 边车文件（`-wal` / `-shm` / `-journal`）—— 任务书点名要查的
 *   ③ 仓库里的 `*.log` / `tmp/` / `bots/`（落盘残留）
 *   ④ `listSecrets()` 的对外结构（= `GET /api/vault/items` 的响应体）
 * 不计入攻破的（设计如此，会单独打印）：进程环境变量（agent 子进程就是要靠它拿明文）。
 *
 * 退出码：0 = 攻破（canary 出现在不该出现的地方）；1 = 未攻破。
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const DB = path.join(TMP, `vault-1-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm', DB + '-journal']) { try { fs.rmSync(p, { force: true }); } catch {} }
process.env.MC_VAULT_DB = DB;

const say = (...a) => console.log('[V1]', ...a);
const CANARY = 'sk-CANARY-' + crypto.randomBytes(12).toString('hex');
const PASS = 'Passw0rd-Strong-1';

const V = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);
V.init(PASS);
const rec = V.setSecret('OPENAI_API_KEY', CANARY, { updatedBy: 'probe' });
// ⚠ 只打前缀：完整 canary 一旦被打进 stdout，而探针又要递归扫自己的目录，
//   就会"自己命中自己"（本轮真踩过：日志里出现完整 canary ⇒ 误报 VULNERABLE）。
say('已写入 canary：', CANARY.slice(0, 14) + '…', '（完整值只留在本进程内存里） hint=', rec.hint);
// 让"注入环境变量"这条路径也跑一遍（agent 子进程就是这么拿键的）
const inj = V.injectEnvFromVault({ log: () => {} });
say('注入环境变量条数：', inj.injected, '（值不打印）');

// 查真实的 journal 模式（WAL 会额外落 -wal/-shm；任务书点名要查这里）
let journalMode = 'unknown';
try {
    const { DatabaseSync } = await import('node:sqlite');
    const probeDb = new DatabaseSync(DB);
    journalMode = String(probeDb.prepare('PRAGMA journal_mode').get()?.journal_mode ?? 'unknown');
    probeDb.close();
} catch (e) { journalMode = 'query-failed:' + String(e.message).slice(0, 40); }
const sidecarsAtClose = [DB + '-wal', DB + '-shm', DB + '-journal'].map((f) => [path.basename(f), fs.existsSync(f)]);
say('journal_mode =', journalMode, ' 边车文件（关库前）：', JSON.stringify(sidecarsAtClose));
// 关库，确保数据落盘、边车文件状态确定
V.closeVault();

const hits = [];
const scanBuffer = (label, buf) => {
    const n = buf.includes(Buffer.from(CANARY, 'utf8')) ? 1 : 0;
    say(`  ${label.padEnd(46)} 命中=${n}`);
    if (n) hits.push(label);
    return n;
};
const scanFile = (label, fp) => {
    if (!fs.existsSync(fp)) { say(`  ${label.padEnd(46)} （不存在）`); return 0; }
    return scanBuffer(`${label} [${fs.statSync(fp).size}B]`, fs.readFileSync(fp));
};

say('');
say('=== ① 库本体 + 边车文件 ===');
scanFile('.secrets.db', DB);
for (const sfx of ['-wal', '-shm', '-journal']) scanFile('.secrets.db' + sfx, DB + sfx);
say('  journal_mode（查询）：', journalMode, '（WAL 会额外落 -wal/-shm）');

say('');
say('=== ② 落盘残留：*.log / tmp/ / bots/ ===');
const walk = (dir, pred, out = [], depth = 0) => {
    if (depth > 4 || !fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.name === 'node_modules' || e.name === '.git') continue;
        if (e.isDirectory()) walk(fp, pred, out, depth + 1);
        else if (pred(fp, e.name)) out.push(fp);
    }
    return out;
};
const logFiles = walk(ROOT, (fp, n) => n.endsWith('.log')).slice(0, 200);
say(`  扫描 *.log 文件 ${logFiles.length} 个`);
let logHits = 0;
for (const f of logFiles) { try { if (fs.readFileSync(f).includes(Buffer.from(CANARY, 'utf8'))) { logHits++; hits.push('log:' + f); } } catch {} }
say('  *.log 命中总数：', logHits);

for (const sub of ['tmp', 'bots']) {
    const dir = path.join(ROOT, sub);
    const files = walk(dir, () => true).slice(0, 400);
    let n = 0;
    for (const f of files) { try { if (fs.readFileSync(f).includes(Buffer.from(CANARY, 'utf8'))) { n++; hits.push(sub + ':' + f); } } catch {} }
    say(`  ${sub}/ 扫描 ${files.length} 个文件，命中 ${n}`);
}
// 探针自己的目录（排除 logs/ 与 tmp/：后者本来就是库文件与运行产物；
// logs/ 里是探针自己的 stdout，包含 canary 前缀——扫它等于自证）
const ownFiles = walk(HERE, () => true).filter((f) => {
    const rel = path.relative(HERE, f).split(path.sep)[0];
    return rel !== 'logs' && rel !== 'tmp';
});
let ownHits = 0;
for (const f of ownFiles) { try { if (fs.readFileSync(f).includes(Buffer.from(CANARY, 'utf8'))) { ownHits++; hits.push('deferred:' + f); } } catch {} }
say(`  evidence/vault-attack/（排除 logs/、tmp/）扫描 ${ownFiles.length} 个文件，命中：`, ownHits);

say('');
say('=== ③ 对外结构（GET /api/vault/items 的响应体来源）===');
const V2 = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);
V2.unlock(PASS);
const listed = JSON.stringify(V2.listSecrets());
say('  listSecrets() =', listed.slice(0, 160));
const apiHit = listed.includes(CANARY) ? 1 : 0;
say('  响应体命中 canary =', apiHit, apiHit ? ' ← 攻破！' : '（安全：只给 name/hint/updated*）');
if (apiHit) hits.push('api:GET /api/vault/items');
const statusStr = JSON.stringify(V2.status());
say('  status() =', statusStr);
if (statusStr.includes(CANARY)) hits.push('api:GET /api/vault/status');

say('');
say('=== ④ 设计如此（不计入攻破）===');
say('  进程环境变量里的明文：', process.env.OPENAI_API_KEY === CANARY ? '在（这就是给子进程继承的通道）' : '不在');
V2.lock(); V2.clearInjectedEnv(); V2.closeVault();

say('');
if (hits.length) {
    say('VULNERABLE：canary 出现在不该出现的位置：', JSON.stringify(hits));
    process.exit(0);
}
say('SECURE：库本体/边车/日志/tmp/bots/对外结构 全部 0 命中');
process.exit(1);
