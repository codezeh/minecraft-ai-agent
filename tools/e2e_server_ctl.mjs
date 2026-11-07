/**
 * E2E 用的服务端守护器 —— 只做一件事：**把 java 的 stdin 一直开着**。
 *
 * 为什么需要它（实测，2026-11-08）：
 *   用 `Start-Process ... -RedirectStandardOutput` 起 Paper 时，java 的 stdin 是关闭/立即 EOF 的。
 *   短场景（重启恢复，几十秒）碰巧没事；claims 场景要跑几分钟，服务端读到 stdin EOF 就**自己退了**
 *   —— 表现为"场景跑到一半 RCON 突然 ECONNREFUSED / 日志停在 Done 之后"，极难从现象反推原因。
 *   所以改由这个 node 进程 spawn java，stdin 用一个**永不写入、也不关闭**的管道，
 *   生命周期：java 退出 → 本进程退出；有人发 SIGTERM → 主动 kill java。
 *
 * 用法（由 scripts/e2e.ps1 调用，一般不手工跑）：
 *   node tools/e2e_server_ctl.mjs --run-dir <dir> --java <java.exe> --jar <server.jar> \
 *        --log <server.log> --err <server.err.log>
 *
 * 产出：<run-dir>/server.pid 里是 java 的 PID（给外层做兜底清理用）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const runDir = arg('--run-dir');
const javaExe = arg('--java');
const jar = arg('--jar');
const logPath = arg('--log');
const errPath = arg('--err');

if (!runDir || !javaExe || !jar || !logPath) {
    console.error('用法: node e2e_server_ctl.mjs --run-dir <dir> --java <java> --jar <jar> --log <file> [--err <file>]');
    process.exit(2);
}

const out = fs.createWriteStream(logPath, { flags: 'w' });
const err = fs.createWriteStream(errPath || (logPath + '.err'), { flags: 'w' });

// stdio[0] = 'pipe' 且**永不写入**：java 的 System.in 不会 EOF，控制台线程不会因读空而停服。
const child = spawn(javaExe, ['-Xms512M', '-Xmx1024M', '-XX:+UseG1GC', '-jar', jar, 'nogui'], {
    cwd: runDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
});

fs.writeFileSync(path.join(runDir, 'server.pid'), String(child.pid ?? ''), 'utf8');

child.stdout.pipe(out);
child.stderr.pipe(err);

let stopping = false;
const shutdown = (why) => {
    if (stopping) return;
    stopping = true;
    try { child.stdin.write('stop\n'); } catch { }
    setTimeout(() => { try { child.kill(); } catch { } }, 15000).unref?.();
    if (why) console.log(`[server-ctl] ${why} → 请求停服`);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

child.on('exit', (code, signal) => {
    try { out.end(); err.end(); } catch { }
    console.log(`[server-ctl] java 退出 code=${code} signal=${signal}`);
    process.exit(0);
});

child.on('error', (e) => {
    console.error('[server-ctl] 启动 java 失败: ' + String(e?.message ?? e));
    process.exit(1);
});
