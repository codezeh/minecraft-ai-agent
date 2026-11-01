// 最小 RCON 客户端（tools 侧的薄包装）。
//
// ★ 2026-11-01 M1 安全改造（09 §4）：
//   原来这里写死端口 25576 + 密码 localdev —— 那个密码已经推到 GitHub。
//   现在密码和端口一律走 `src/agent/library/rcon_client.js` 的 resolveRconCreds()：
//     显式参数 → 环境变量（RCON_PASSWORD / RCON_PORT）→ <项目根>/server*/server.properties
//   按端口认领配置（25575→主服、25576→测试服），所以下面的默认端口仍是 25576（测试服），
//   但密码是从 server-test/server.properties 读的，不再有硬编码值。
//   想临时换目标：MC_SERVER_DIR=... 或 RCON_PASSWORD=... / RCON_PORT=...
import { rcon as _rcon } from '../src/agent/library/rcon_client.js';

export { resolveRconCreds } from '../src/agent/library/rcon_client.js';

/**
 * 执行一条 RCON 命令。
 * 默认连**测试服**（25576）—— tools 里的真机脚本按 09 §5.3 只在 25566 上跑。
 *
 * @param {string} command 不带斜杠
 * @param {{host?:string, port?:number, password?:string, timeout?:number}} [opts]
 */
export function rcon(command, { host = '127.0.0.1', port = Number(process.env.RCON_PORT) || 25576, timeout = 8000, ...rest } = {}) {
    return _rcon(command, { host, port, timeout, ...rest });
}

// 批量执行，逐条返回
export async function rconAll(commands, opts) {
  const out = [];
  for (const c of commands) out.push([c, await rcon(c, opts)]);
  return out;
}
