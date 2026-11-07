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

/**
 * 等 socket 真正连上；连不上就**明确失败**（返回 false + 置退出码）。
 *
 * 为什么单独有这一条（t23，2026-11-08）：
 *   握手 token 门上线后，直连 socket 的脚本如果只写 `io(url, {transports})`，
 *   会拿到 `connect_error: unauthorized`，但**很多脚本并不检查它** ——
 *   后面的 `await board.hello()` / `emit` 全部无声失败，脚本照样 exit 0。
 *   于是同一族故障反复出现："断言数变少 / 全是 0 条 / 看着绿其实什么都没跑"。
 *
 * 用法：
 *   const sock = connectMindserver(io, MS_PORT);
 *   if (!await awaitConnect(sock, { label: 't37 claims' })) process.exit(1);
 *
 * @param {import('socket.io-client').Socket} sock
 * @param {{label?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>} 是否连上
 */
export function awaitConnect(sock, { label = '', timeoutMs = 15000 } = {}) {
    const who = label ? `[${label}] ` : '';
    if (sock?.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
        const done = (ok, why) => {
            clearTimeout(timer);
            try { sock.off?.('connect', onConnect); sock.off?.('connect_error', onError); } catch { /* 老版本没有 off */ }
            if (!ok) {
                console.error(`${who}连接 mindserver 失败：${why}`);
                console.error(`${who}⇒ 本脚本的后续断言不会执行，按失败退出（不再"看起来跑了其实没跑"）`);
                process.exitCode = 1;
            }
            resolve(ok);
        };
        const onConnect = () => done(true);
        const onError = (err) => {
            const code = err?.data?.code || err?.message || 'connect_error';
            const hint = code === 'AUTH_REQUIRED'
                ? '（token 门拒绝：缺 token 或 token 不对；服务端没起来时也会走到这里）'
                : '';
            done(false, `${code}${hint}`);
        };
        const timer = setTimeout(() => done(false, `${timeoutMs}ms 内没有连上`), timeoutMs);
        sock.once('connect', onConnect);
        sock.once('connect_error', onError);
    });
}
