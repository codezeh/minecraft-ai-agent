/**
 * 可复用的「起隔离服 → 跑一个既有 tools/*_live.mjs → 停服」脚本。
 *
 * 这就是任务要求的那份「起服→跑批→停服→重置」脚本：起服/停服/运行目录的做法
 * 与 scripts/e2e.ps1 完全一致（见 harness.mjs 头注释），只是把"跑哪个脚本"
 * 做成参数，这样 G 段的既有 live 场景不用各写一份。
 *
 * 用法：
 *   node docs/audit-r5/evidence/ingame/run_live_tool.mjs <tool 相对 mindcraft 的路径> [超时秒]
 *   node docs/audit-r5/evidence/ingame/run_live_tool.mjs tools/m9_smoke_live.mjs 300
 *
 * 产出：tmp/r5-ingame/live-<tool名>/ 下的 server.log + tool.log + 退出码
 */
import { createHarness } from './harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MIND_DIR, REPO_ROOT } from './harness.mjs';

const tool = process.argv[2];
const timeoutSec = Number(process.argv[3] || 300);
if (!tool) {
    console.error('用法: node run_live_tool.mjs <tools/xxx_live.mjs> [超时秒]');
    process.exit(2);
}
const base = path.basename(tool, '.mjs').replace(/[^a-zA-Z0-9_-]/g, '-');
const scenario = 'live-' + base;

const h = await createHarness({ scenario, levelType: 'flat' });
let exitCode = null;
try {
    const t0 = Date.now();
    await h.boot();
    console.log(`PASS 起服就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）—— ${h.logPath}`);

    const botRoot = path.join(h.runDir, 'bots');
    fs.mkdirSync(botRoot, { recursive: true });
    const toolLog = path.join(h.runDir, 'tool.log');
    const stream = fs.createWriteStream(toolLog, { flags: 'w' });

    exitCode = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(MIND_DIR, tool)], {
            cwd: MIND_DIR,
            env: {
                ...process.env,
                RCON_PORT: '25576',
                RCON_PASSWORD: h.password,
                MC_BOTS_ROOT: botRoot,
                MC_PORT: '25566',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (b) => { stream.write(b); process.stdout.write(b); });
        child.stderr.on('data', (b) => { stream.write(b); process.stdout.write(b); });
        const timer = setTimeout(() => {
            console.log(`TIMEOUT ${timeoutSec}s —— 强杀 ${tool}`);
            try { child.kill(); } catch { /* ignore */ }
        }, timeoutSec * 1000);
        child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    stream.end();
    console.log(`[run_live_tool] ${tool} 退出码 = ${exitCode}，日志 ${toolLog}`);
} catch (e) {
    console.log('CANNOT-RUN：' + String(e?.message ?? e).slice(0, 800));
} finally {
    const ok = await h.stop(120000);
    console.log(`PASS 停服（java 退出=${ok}）`);
    console.log(`EXITCODE=${exitCode}`);
    process.exit(exitCode === 0 ? 0 : 1);
}
