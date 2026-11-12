/**
 * 白名单闸门（ADR 阶段 2 / D5）：`!invite` / `!revoke` 的**执行**这一层。
 *
 * 为什么走 RCON 而不是改 `server/whitelist.json`：
 *   那个文件是 Minecraft **服务端自己**写的（运行期由它维护）。外面直接改文件 = 两套真相，
 *   服务端下次落盘就把它认为的写回去，我们的改动静默丢失（R6 #50 的教训同型）。
 *   所以唯一正确入口是让服务端自己执行 `whitelist add/remove`。
 *
 * 依赖：服务端开着 enable-rcon + rcon.password（本仓 provision 会生成随机口令）。
 * 拿不到就让调用方**明确失败**，绝不假装成功。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { botsRootOf } from './bot_paths.js';
import { rcon as rconSend } from '../../mindcraft/proc_control.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 服务端目录：优先 MC_SERVER_DIR 覆盖，否则 `<仓库根>/server`。 */
export function serverDirOf() {
    const override = process.env.MC_SERVER_DIR;
    if (typeof override === 'string' && override.trim()) return override.trim();
    return resolve(PKG_ROOT, '..', 'server').replace(/\\/g, '/');
}

/** 读 server.properties 里的 rcon 配置（读不到就报原因，不猜默认口令）。 */
export function readRconConfig(dir = serverDirOf()) {
    const file = resolve(dir, 'server.properties');
    if (!existsSync(file)) return { ok: false, reason: `没有 server.properties：${file}` };
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: `读不到 server.properties：${e?.message ?? e}` }; }
    const get = (k) => {
        const m = text.match(new RegExp(`^${k}=(.*)$`, 'm'));
        return m ? m[1].trim() : null;
    };
    const enabled = get('enable-rcon');
    const password = get('rcon.password');
    const port = Number(get('rcon.port') || 25575);
    if (enabled !== 'true') return { ok: false, reason: 'enable-rcon 不是 true（服务端没开 RCON）' };
    if (!password) return { ok: false, reason: 'rcon.password 为空（服务端没配口令）' };
    return { ok: true, port, password };
}

/**
 * 让服务端执行一条 whitelist 命令。
 * @param {'add'|'remove'} op
 * @param {string} name
 * @returns {Promise<{ok:boolean, reply?:string, reason?:string}>}
 */
export async function applyWhitelist(op, name, opts = {}) {
    const clean = String(name ?? '').trim();
    if (!clean) return { ok: false, reason: '名字为空' };
    if (op !== 'add' && op !== 'remove') return { ok: false, reason: `未知操作：${op}` };
    const cfg = readRconConfig(opts.serverDir);
    if (!cfg.ok) return { ok: false, reason: cfg.reason };
    let reply = '';
    try {
        reply = await rconSend(`whitelist ${op} ${clean}`, { port: cfg.port, password: cfg.password, timeout: opts.timeout ?? 8000 });
    } catch (e) {
        return { ok: false, reason: `RCON 失败：${e?.message ?? e}` };
    }
    const text = String(reply ?? '').trim();
    return { ...classifyWhitelistReply(op, text), reply: text };
}

/**
 * 把服务端回执翻成成败（纯函数，便于单测覆盖全部已知文案）。
 *
 * 服务端文案（Vanilla/Paper）：
 *   成功   "Added X to the whitelist" / "Removed X from the whitelist"
 *   幂等   "Player X is already whitelisted" / "Player X is not whitelisted"
 *   失败   "Player does not exist" / "That player does not exist"
 * **认不出的一律算失败**（宁可让玩家看到原因，也不要假成功）。
 */
export function classifyWhitelistReply(op, text) {
    const lower = String(text ?? '').trim().toLowerCase();
    if (!lower) return { ok: false, reason: '服务端没有回执（RCON 通但命令无输出）' };
    if (lower.includes('does not exist')) {
        return { ok: false, reason: '服务端说没有这个玩家（名字拼写错，或该玩家从未进过服）' };
    }
    if (op === 'add' && lower.includes('already whitelisted')) return { ok: true, idempotent: true };
    if (op === 'remove' && lower.includes('not whitelisted')) return { ok: true, idempotent: true };
    if (lower.includes('added') || lower.includes('removed')) return { ok: true };
    return { ok: false, reason: `服务端回执无法判定成败：${text}` };
}

export { rconSend };
