/**
 * 本机脚本连接 mindserver 的**握手 token** 获取器。
 *
 * ★★★ 2026-11-06（t145）：security 那条线加了「完整性闸」（`6c8758e` / `auth_gate.js`）之后，
 *   **所有用裸 `ioClient(...)` 连 mindserver 的本机脚本全部失效** ——
 *   报 `Error: unauthorized: mindserver 需要握手 token` / `AUTH_REQUIRED`，
 *   而且**退出码仍是 0**（socket 错误没有传递到 process.exitCode）。
 *
 *   这就是今晚反复出现的那一族：**"看起来跑了、其实没跑"**。
 *   `atom_all` 能过（它连的是游戏服 RCON），而 `board_b1~b4` 全部静默失败。
 *
 * 取 token 的优先级（与 `src/agent/mindserver_proxy.js:46` 的约定一致）：
 *   ① `process.env.MINDSERVER_TOKEN` —— mindserver spawn 子进程时写进去的
 *   ② `<repo>/.mindserver-token` —— mindserver 启动时写在自己工作目录里的
 *
 * 用法：
 *   import { connectMindserver } from './lib/ms_token.mjs';
 *   const sock = connectMindserver(ioClient, port);
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

/** mindserver 把 token 写在**仓库根**（它的 cwd）里。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * 读出当前可用的 token。
 * @returns {string} token（可能是空串 —— 那说明服务端**没开**认证，属于正常情况）
 */
export function readMindserverToken() {
    const fromEnv = String(process.env.MINDSERVER_TOKEN ?? '').trim();
    if (fromEnv) return fromEnv;
    for (const name of ['.mindserver-token', 'mindserver-token']) {
        const p = join(REPO_ROOT, name);
        try {
            if (!existsSync(p)) continue;
            const t = readFileSync(p, 'utf8').trim();
            if (t) return t;
        } catch { /* 读不到就继续找下一个 */ }
    }
    return '';
}

/**
 * 建一个**带握手 token** 的 socket.io 客户端。
 *
 * @param {Function} ioClient  `socket.io-client` 的 `io`
 * @param {number} port        mindserver 端口
 * @param {object} [opts]
 * @returns {import('socket.io-client').Socket}
 */
export function connectMindserver(ioClient, port, opts = {}) {
    const token = readMindserverToken();
    const sock = ioClient(`http://localhost:${port}`, {
        transports: ['websocket'],
        // ★ 服务端 `auth_gate` 从 `handshake.auth.token` 取（见 `tokenFromHandshake`）
        auth: (cb) => cb({ token }),
        ...opts,
    });
    // ★ 把认证失败变成**显式报错**，不要让调用方以为"连上了但没反应"
    //   （今晚的教训：`socket 错误 → 退出码 0` = 看起来跑了其实没跑）
    sock.on('connect_error', (err) => {
        if (err?.data?.code === 'AUTH_REQUIRED') {
            console.error('[ms_token] mindserver 拒绝握手：token 缺失或错误。');
            console.error('  ① 确认服务端已启动并写出了 .mindserver-token；');
            console.error('  ② 或显式传：MINDSERVER_TOKEN=<token> node tools/xxx.mjs');
            process.exitCode = 2;
        }
    });
    return sock;
}
