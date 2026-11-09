/**
 * t-vault-8 —— 进程边界：明文怎么交给 agent 子进程？有没有落盘 / 打日志？
 *
 * 攻击面（历史上同类项目最容易漏的地方）：
 *   ① 是不是走"写临时文件再读"（那等于明文又落一次盘）？
 *   ② 子进程到底能不能拿到明文（拿不到 = 功能坏；拿到 = 设计如此，但要看**怎么拿的**）？
 *   ③ spawn 处有没有把键打进日志 / 命令行参数（`ps` 可见）/ 异常信息里？
 *   ④ mindserver 的日志里有没有 env dump（`JSON.stringify(process.env)` 之类）？
 *
 * 判定：只要出现"明文进 argv / 进日志 / 进临时文件"⇒ VULNERABLE（退出码 0）。
 *       "明文进子进程 env"本身是**设计如此**，不算攻破（但它意味着同机同账户可读）。
 *
 * 退出码：0 = 攻破；1 = 未攻破。
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const say = (...a) => console.log('[V8]', ...a);

const DB = path.join(TMP, `vault-8-${process.pid}.db`);
for (const p of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(p, { force: true }); } catch {} }
process.env.MC_VAULT_DB = DB;
delete process.env.MC_VAULT_PASSPHRASE;

const CANARY = 'sk-CANARY-' + crypto.randomBytes(10).toString('hex');
const KEYNAME = 'PROBE8_API_KEY';
const V = await import(pathToFileURL(path.join(ROOT, 'src/agent/library/secrets_vault.js')).href);
V.init('Passw0rd-Strong-1');
V.setSecret(KEYNAME, CANARY);

// ── ① 注入前后：仓库里有没有新文件出现（写临时文件 = 明文落盘）──────────
const snapshot = () => {
    const out = new Set();
    const walk = (dir, depth = 0) => {
        if (depth > 3 || !fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) walk(fp, depth + 1); else out.add(fp);
        }
    };
    for (const d of ['tmp', 'bots', 'logs']) walk(path.join(ROOT, d));
    return out;
};
const before = snapshot();
const inj = V.injectEnvFromVault({ log: () => {} });
const after = snapshot();
const created = [...after].filter((f) => !before.has(f));
say('=== ① 注入环境变量是否落盘 ===');
say(`  注入 ${inj.injected} 项；tmp/ bots/ logs/ 新文件数 = ${created.length}`, created.length ? JSON.stringify(created.slice(0, 5)) : '');

// ── ② 子进程能否继承（不打印值）───────────────────────────────────────────
say('=== ② 子进程继承（只打印长度，不打印值）===');
const child = spawnSync(process.execPath, ['-e', `
const k = process.env['${KEYNAME}'] || '';
process.stdout.write(String(k.length) + '|' + (k.slice(0,3)) + '|' + String(process.argv.length));
`], { env: process.env, encoding: 'utf8' });
say(`  子进程看到的环境变量：长度|前3位|argv 项数 = ${String(child.stdout).trim()}`);
const inherited = String(child.stdout).startsWith(String(CANARY.length) + '|sk-');
say(`  子进程确实通过 env 拿到明文（设计如此）：${inherited}`);

// ── ③ spawn 处：明文有没有进 argv / 日志 ─────────────────────────────────
say('=== ③ spawn 参数与日志面 ===');
const ap = fs.readFileSync(path.join(ROOT, 'src/process/agent_process.js'), 'utf8');
const spawnBlock = ap.slice(ap.indexOf('args.push('), ap.indexOf("agentProcess.on('exit'"));
const argvHasSecret = /process\.env\[[^\]]+\]|CANARY|value/i.test(spawnBlock) && /args\.push\([^)]*env/i.test(spawnBlock);
say(`  AgentProcess spawn 的 args 里是否拼过 env 值：${argvHasSecret ? '**是**' : '否'}`);
say('  spawn 的 args 构造（截断）：', spawnBlock.split('\n').filter((l) => l.includes('args.push')).map((l) => l.trim()).join(' ').slice(0, 200));

// env 是整块继承 + 只补 MINDSERVER_PID
const envLine = (ap.match(/env:\s*\{[^}]*\}/s) || ['(未找到)'])[0];
say('  spawn env 表达式：', envLine.replace(/\s+/g, ' ').slice(0, 120));

// 静态扫：有没有"把 env / 值打到日志"
const suspects = [
    ['src/process/agent_process.js', ap],
    ['src/mindcraft/mindserver.js', fs.readFileSync(path.join(ROOT, 'src/mindcraft/mindserver.js'), 'utf8')],
    ['src/agent/library/secrets_vault.js', fs.readFileSync(path.join(ROOT, 'src/agent/library/secrets_vault.js'), 'utf8')],
];
const badPatterns = [
    /console\.(log|warn|error)\s*\([^)]*JSON\.stringify\s*\(\s*process\.env/,
    /console\.(log|warn|error)\s*\([^)]*process\.env\s*\)/,
    /console\.(log|warn|error)\s*\([^)]*\bvalue\b\s*\)\s*;?\s*\/\/.*secret/i,
    /console\.(log|warn|error)\s*\([^)]*(getSecret|tryGetSecret)\s*\(/,
];
const leaks = [];
for (const [f, text] of suspects) {
    for (const re of badPatterns) {
        const m = text.match(re);
        if (m) leaks.push(`${f}: ${m[0].slice(0, 80)}`);
    }
}
say(`  静态扫描（4 类"把 env/明文打进日志"模式）：命中 ${leaks.length} 处`, leaks.length ? JSON.stringify(leaks) : '');

// secrets_vault 里的日志是否只打名字/条数
const vaultLogs = [...suspects[2][1].matchAll(/console\.(log|warn|error)\(([^\n]{0,90})/g)].map((m) => m[2].trim());
say('  secrets_vault.js 的日志语句（前 6 条）：');
for (const l of vaultLogs.slice(0, 6)) say('    ·', l.slice(0, 90));

// ── ④ 库里/对外结构里有没有明文（复核点，probe 1 已全盘扫）──────────────
const listed = JSON.stringify(V.listSecrets());
const exportMap = V.exportAllSecrets();
say('=== ④ 复核 ===');
say(`  listSecrets 含明文：${listed.includes(CANARY)}（应为 false）`);
say(`  exportAllSecrets 是唯一明文出口：${exportMap.get(KEYNAME) === CANARY}（设计如此）`);
V.lock(); V.clearInjectedEnv(); V.closeVault();

say('');
const broken = leaks.length > 0 || created.length > 0 || argvHasSecret || listed.includes(CANARY);
if (broken) {
    say('VULNERABLE：明文出现在了日志 / argv / 新落盘文件 / 对外结构里');
    process.exit(0);
}
say('SECURE：明文只走"进程环境变量"这一条通道（设计如此），无落盘、无 argv、无日志泄漏');
process.exit(1);
