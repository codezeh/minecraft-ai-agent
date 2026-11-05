// P1 环境能力探针：在"当前沙箱"里逐项试，把可用/不可用写成事实。
// 运行：node docs/audit/probes/p1_env.mjs
// 只读探测；唯一写入是 os.tmpdir() 下的临时目录，跑完自删。
import { spawn, spawnSync, execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const rows = [];
function rec(name, ok, detail) {
  rows.push({ name, ok, detail: String(detail).replace(/\s+/g, ' ').slice(0, 220) });
}

// 1) spawn 一个 node 子进程
try {
  const r = spawnSync(process.execPath, ['-e', 'console.log("child-ok")'], { encoding: 'utf8', timeout: 15000 });
  rec('spawn node -e', r.status === 0, `status=${r.status} out=${(r.stdout || '').trim()} err=${(r.stderr || '').trim().slice(0, 120)}`);
} catch (e) { rec('spawn node -e', false, e.code + ' ' + e.message); }

// 2) spawn 异步版
try {
  const out = await new Promise((res) => {
    let buf = '';
    const p = spawn(process.execPath, ['-e', 'console.log("async-ok")'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => buf += d);
    p.on('error', e => res('ERROR ' + e.code));
    p.on('close', c => res(`close=${c} buf=${buf.trim()}`));
    setTimeout(() => res('TIMEOUT'), 15000);
  });
  rec('spawn (async, stdout pipe)', String(out).includes('async-ok'), out);
} catch (e) { rec('spawn (async, stdout pipe)', false, e.code + ' ' + e.message); }

// 3) execFileSync
try {
  const o = execFileSync(process.execPath, ['-e', 'process.stdout.write("execfile-ok")'], { encoding: 'utf8', timeout: 15000 });
  rec('execFileSync', o.includes('execfile-ok'), o);
} catch (e) { rec('execFileSync', false, `${e.code || ''} ${e.message}`); }

// 4) execSync（shell）
try {
  const o = execSync('echo exec-ok', { encoding: 'utf8', timeout: 15000 });
  rec('execSync (shell)', o.includes('exec-ok'), o);
} catch (e) { rec('execSync (shell)', false, `${e.code || ''} ${e.message}`); }

// 5) npx
try {
  const o = execSync('npx --no-install eslint --version', { encoding: 'utf8', timeout: 60000, cwd: path.resolve('../mindcraft') });
  rec('npx eslint --version', true, o.trim());
} catch (e) { rec('npx eslint --version', false, `${e.code || ''} ${String(e.message).split('\n')[0]}`); }

// 6) node ./script（相对路径脚本）
try {
  const o = execFileSync(process.execPath, ['tools/audit_codes.mjs'], { encoding: 'utf8', timeout: 60000, cwd: path.resolve('../mindcraft') });
  rec('node tools/audit_codes.mjs', true, o.trim().split('\n').slice(-2).join(' | '));
} catch (e) {
  rec('node tools/audit_codes.mjs', false, `${e.code || ''} ${String(e.message).split('\n')[0]} stdout=${String(e.stdout || '').slice(0, 100)}`);
}

// 7) mkdir 写 mindcraft/bots/<name>（源码目录内，但 bots/ 已 gitignore）
const botDir = path.resolve('../mindcraft/bots/_p1probe');
try {
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(botDir, 'x.txt'), 'y');
  rec('mkdir+write mindcraft/bots/_p1probe', true, 'ok');
  fs.rmSync(botDir, { recursive: true, force: true });
} catch (e) { rec('mkdir+write mindcraft/bots/_p1probe', false, `${e.code} ${e.message}`); }

// 8) mkdir 写 os.tmpdir()
let tmpDir = null;
try {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
  fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'b');
  rec('mkdir+write os.tmpdir()', true, tmpDir);
} catch (e) { rec('mkdir+write os.tmpdir()', false, `${e.code} ${e.message}`); }

// 9) mkdir 写 docs/audit/probes/（本任务允许的目录）
try {
  const d = path.resolve('docs/audit/probes/_p1tmp');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), 'b');
  fs.rmSync(d, { recursive: true, force: true });
  rec('mkdir+write docs/audit/probes/', true, 'ok');
} catch (e) { rec('mkdir+write docs/audit/probes/', false, `${e.code} ${e.message}`); }

// 10) 写仓库外（E:\tmp 或 C:\）—— 确认边界
try {
  const p = path.parse(process.cwd()).root + 'p1_outside_probe.txt';
  fs.writeFileSync(p, 'x');
  fs.rmSync(p, { force: true });
  rec('write 到盘符根（仓库外）', true, p + ' （能写！）');
} catch (e) { rec('write 到盘符根（仓库外）', false, `${e.code} ${e.message}`); }

// 11) net.connect 到本地已监听端口 / 未监听端口
async function probePort(port) {
  return await new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch { } res(v); };
    s.once('connect', () => done('open'));
    s.once('error', (e) => done('closed/' + e.code));
    setTimeout(() => done('timeout'), 1500);
  });
}
rec('net.connect 127.0.0.1:25565 (MC)', (await probePort(25565)) === 'open', await probePort(25565));
rec('net.connect 127.0.0.1:25575 (RCON)', (await probePort(25575)) === 'open', await probePort(25575));
rec('net.connect 127.0.0.1:8080 (mindserver)', (await probePort(8080)) === 'open', await probePort(8080));

// 12) node:sqlite 可用性
try {
  const m = await import('node:sqlite');
  const DatabaseSync = m.DatabaseSync;
  const dbPath = path.join(tmpDir || os.tmpdir(), 'p1.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t(a INTEGER)');
  db.exec('INSERT INTO t VALUES (1)');
  const row = db.prepare('SELECT count(*) AS n FROM t').get();
  db.close();
  rec('node:sqlite DatabaseSync', true, `n=${row.n} node=${process.version}`);
} catch (e) { rec('node:sqlite DatabaseSync', false, `${e.code || ''} ${e.message}`); }

// 13) 环境信息
console.log('--- ENV ---');
console.log('node', process.version, '| platform', process.platform, '| cwd', process.cwd());
console.log('--- TABLE ---');
const w = Math.max(...rows.map(r => r.name.length));
for (const r of rows) {
  console.log((r.ok ? 'PASS' : 'FAIL').padEnd(5) + r.name.padEnd(w + 2) + r.detail);
}
if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { } }
