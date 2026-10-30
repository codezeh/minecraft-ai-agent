// 只重启 mindcraft 自己的进程，绝不碰其它 node（用户有 node server.js 的酒馆进程在跑）。
// 用法: node tools/restart_bot.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';

const PS = 'powershell.exe';

/**
 * 精确定位 mindcraft：
 *   子进程命令行里一定含 mindcraft 路径（init_agent.js），
 *   父进程（main.js 的 node）命令行里没有路径，所以靠父子关系反推。
 * 绝不用「杀掉所有 node」这种蛮力方式 —— 会顺手杀掉用户的 node server.js。
 */
function listMindcraftPids() {
    const script = `
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
$agents = $procs | Where-Object {
  $_.CommandLine -like '*mindcraft*' -and
  $_.CommandLine -notlike '*restart_bot*'
}
$ids = @()
foreach ($a in $agents) {
  $ids += $a.ProcessId
  if ($a.ParentProcessId) { $ids += $a.ParentProcessId }
}
$ids = $ids | Where-Object { $_ -ne $PID -and $_ -ne ${process.pid} }
$ids | Sort-Object -Unique | ForEach-Object { "$_" }
`;
    let out = '';
    try {
        out = execFileSync(PS, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    } catch (e) {
        console.error('查询进程失败:', e.message);
        return [];
    }
    return out.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number);
}

const pids = listMindcraftPids();
console.log('mindcraft 进程:', pids.length ? pids.join(', ') : '(无)');
for (const pid of pids) {
    try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        console.log('  已结束', pid);
    } catch {
        console.log('  结束失败（可能已退出）', pid);
    }
}

await new Promise(r => setTimeout(r, 1500));

const log = 'tmp/bot_run.log';
writeFileSync(log, '');
const child = spawn('D:\\Node\\node.exe', ['main.js'], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
});
const w = createWriteStream(log, { flags: 'a' });
child.stdout.pipe(w);
child.stderr.pipe(w);
child.unref();
console.log('已启动 main.js, pid =', child.pid);
console.log('（只动 mindcraft 的进程，其它 node 一律不碰）');

// 必须主动退出：子进程 stdout/stderr 是 pipe，会一直占着事件循环，
// 脚本看起来「卡住不返回」（实测 90 秒无输出、被移到后台）。
process.exit(0);
