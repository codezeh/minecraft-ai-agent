/**
 * 极小的 RCON 命令行包装 —— 给 PowerShell 侧的 `scripts/e2e.ps1` 用。
 *
 * 为什么需要它：PowerShell 5.1 把一段**内联 JS**（含双引号）当参数传给 node.exe 时，
 * 引号转义是历史坑（`node -e "…"` 会被拆成多个参数），实测在起服后 RCON 探测直接失败。
 * 与其和命令行转义较劲，不如落到一个文件里：参数只有 RCON 命令本身。
 *
 * 用法：
 *     node tools/e2e_rcon.mjs "list"
 *     node tools/e2e_rcon.mjs "data get block 6000 -58 8600" --timeout=8000
 *
 * 凭据：与其它工具一致，走 `resolveRconCreds()`（RCON_PORT / RCON_PASSWORD 环境变量
 *       → 各 server 目录的 server.properties 按端口认领）。密码永不打印。
 *
 * 输出：服务器返回的原文，stdout 单行；失败时 stderr + 退出码 1。
 */
import { rcon } from './rcon.mjs';

const raw = process.argv.slice(2);
const timeoutArg = raw.find((a) => a.startsWith('--timeout='));
const timeout = timeoutArg ? Number(timeoutArg.slice('--timeout='.length)) : 8000;
const command = raw.find((a) => !a.startsWith('--'));

if (!command) {
    console.error('用法: node tools/e2e_rcon.mjs "<rcon 命令>" [--timeout=ms]');
    process.exit(2);
}

try {
    const out = await rcon(command, { timeout });
    process.stdout.write(String(out ?? ''));
} catch (e) {
    console.error(`RCON 失败(${command.slice(0, 40)}): ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(1);
}
