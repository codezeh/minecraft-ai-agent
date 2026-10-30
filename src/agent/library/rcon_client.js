/**
 * RCON 客户端（运行时可用的最小实现）。
 *
 * 为什么需要（2026-10-24 实测确认）：
 *   bot 是**客户端**，服务端只会把跟踪范围（玩家约 48 格）内的实体位置发给它。
 *   超范围的玩家会被 entity_destroy 掉，`bot.players[name].entity` 变成 null
 *   （mineflayer/lib/plugins/entities.js:288-297）。
 *   但**服务端始终知道所有人的坐标** —— 实测 tp 到 500,500 仍能 `data get entity <name> Pos` 读到。
 *   所以要"任何距离都精确"，只能问服务端，也就是 RCON。
 *
 * 来源：原先只有 tools/rcon.mjs（测试脚本专用），这里上提为运行时模块，
 * tools/rcon.mjs 保留为薄包装，避免测试脚本全改。
 *
 * 端口约定：rconPort = serverPort + 10（25565→25575、25566→25576，与本项目一致）。
 */
import net from 'node:net';

const DEFAULT_TIMEOUT = 5000;

/**
 * 执行一条 RCON 命令。
 *
 * @param {string} command 不带斜杠，如 `data get entity deepseek Pos`
 * @param {object} opts { host, port, password, timeout }
 * @returns {Promise<string>} 服务端原始文本（含错误文案，例如 "No entity was found"）
 */
export function rcon(command, opts = {}) {
    const {
        host = '127.0.0.1',
        port = 25575,
        password = process.env.RCON_PASSWORD || 'localdev',
        timeout = DEFAULT_TIMEOUT,
    } = opts;

    return new Promise((resolve, reject) => {
        const sock = net.connect(port, host);
        let settled = false;
        const done = (fn, v) => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
            try { sock.destroy(); } catch { /* ignore */ }
            fn(v);
        };
        const t = setTimeout(() => done(reject, new Error(`rcon timeout (${port})`)), timeout);

        let buf = Buffer.alloc(0);
        let authed = false;
        const send = (id, type, body) => {
            const b = Buffer.from(body, 'utf8');
            const out = Buffer.alloc(4 + 4 + 4 + b.length + 2);
            out.writeInt32LE(4 + 4 + b.length + 2, 0);
            out.writeInt32LE(id, 4);
            out.writeInt32LE(type, 8);
            b.copy(out, 12);
            sock.write(out);
        };

        sock.on('connect', () => send(1, 3, password));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length < 4) return;
            const len = buf.readInt32LE(0);
            if (buf.length < 4 + len) return;
            const id = buf.readInt32LE(4);
            const body = buf.slice(12, 4 + len - 2).toString('utf8');
            buf = buf.slice(4 + len);

            if (!authed) {
                if (id === -1) return done(reject, new Error('rcon auth failed（密码不对？）'));
                authed = true;
                send(2, 2, command);
                return;
            }
            done(resolve, body);
        });
        sock.on('error', (e) => done(reject, e));
    });
}

/** 从 bot 连接的端口推出 RCON 端口（项目约定：+10）。 */
export function rconPortFor(serverPort) {
    if (!Number.isFinite(serverPort)) return 25575;
    return Number(serverPort) + 10;
}

/**
 * 从 bot 实例读连接信息，组装 RCON 参数。
 * bot 上没有端口字段（mineflayer 不暴露），所以用 bot._client.socket 或显式传入。
 */
export function rconOptsFromBot(bot, override = {}) {
    // mineflayer 把连接对象挂在 bot._client.socket（net.Socket）
    const sock = bot?._client?.socket;
    const remotePort = sock?.remotePort ?? sock?._peername?.port;
    return {
        host: override.host ?? sock?.remoteAddress ?? '127.0.0.1',
        port: override.port ?? rconPortFor(remotePort),
        ...override,
    };
}

/**
 * 用 RCON 查一个玩家的精确位置。
 *
 * @returns {Promise<{x,y,z}|null>} 查不到返回 null（玩家不在线 / RCON 不可用）
 */
export async function rconPlayerPos(name, opts = {}) {
    if (!name) return null;
    try {
        const raw = await rcon(`data get entity ${name} Pos`, opts);
        // 成功格式：`deepseek has the following entity data: [123.5d, 64.0d, -8.5d]`
        const m = raw.match(/\[([-\d.]+)d,\s*([-\d.]+)d,\s*([-\d.]+)d\]/);
        if (!m) return null;
        return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
    } catch {
        return null;   // RCON 不可用就当没有，由调用方退回客户端实体
    }
}

/** 用 RCON 查在线玩家列表（不含 bot 自己时由调用方过滤）。 */
export async function rconPlayerList(opts = {}) {
    try {
        const raw = await rcon('list', opts);
        // `There are 2 of a max of 10 players online: a, b`
        const idx = raw.indexOf(':');
        if (idx === -1) return [];
        return raw.slice(idx + 1).split(',').map(s => s.trim()).filter(Boolean);
    } catch {
        return null;
    }
}
