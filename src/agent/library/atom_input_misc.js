/**
 * 输入原子：杂项 —— 载具、聊天、**斜杠命令**。
 *
 * 规矩见 docs/architecture/01_primitives.md §2（A1）与 §3.4：
 *   `bot.chat` 发出去、以 `/` 开头的文本会被服务端当**命令**执行，而 bot 账号是 op。
 *   所以斜杠命令全系统只允许从这一个文件出去，并且**过白名单**：
 *   加一条命令 = 加一条白名单 + 写清用途，不能想发什么就发什么。
 *
 * 收拢前（2026-11-01）：`/ride` `/tp` `/setblock` `/fill` 散在 `atom_boat.js` 与
 * `skills.js` 十多处。两处都已在同日收掉（atom_boat 已删除、skills 的 9 处改调本文件），
 * 现在全仓只有这一处能发斜杠命令。
 *
 * 白名单**只有一张表**：`permissions.SLASH_COMMANDS`（每条带 cmd / level / cheat / 用途）。
 * 本文件不自建第二份清单 —— 只负责"问表 → 拼串 → 发"。
 *   ① 表里 `level` 决定谁能触发（作弊类一律 owner）；
 *   ② 调用方还必须显式传 `{ cheat: true }`：这不是权限判断（原子不做前置判断，A6），
 *      而是**让代码自己交代"我知道这是作弊命令"**，防止随手调。
 */
import { ok, fail } from './contract.js';
import { slashVerdict, slashCommandName, inspectChatText, LEVEL } from '../permissions.js';

/** 命令名规范化（去掉前导 `/`，只留第一个词）。真身是 permissions.slashCommandName。 */
export function normalizeCommand(cmd) {
    return slashCommandName(cmd);
}

/**
 * 这条命令能不能发（纯判断，方便单测与 preflight 复用）。
 *
 * ★ 2026-11-01（用户拍板）：**只问 `permissions.js` 那一张表，本文件不再自建第二份清单**。
 * 之前这里有一份 SAFE(`ride`) + 一份 CHEAT(`tp` `setblock` …)，而 M1 那边有 SLASH_WHITELIST
 * （只有 `/skin`）—— 两个真相，迟早一个放行、另一个拦下。现在两张并成一张
 * `permissions.SLASH_COMMANDS`（每条带 level / cheat / 用途），本文件只做"问表 + 拼串 + 发"。
 *
 * 两层防御（都是保留的，但**不是两份真相**）：
 *   ① 表里 `level` 决定"谁能触发"（作弊类一律 owner）；
 *   ② 调用方必须显式 `{ cheat: true }` —— 让代码自己交代"我知道这是作弊命令"，防止随手调。
 *
 * @param {string} cmd
 * @param {{cheat?:boolean, level?:'owner'|'trusted'|'other'}} opts
 * @returns {{allowed:boolean, name:string, cheat:boolean, level:string, why:string}}
 */
export function checkCommand(cmd, opts = {}) {
    const cheat = opts.cheat === true;
    const level = opts.level ?? LEVEL.OWNER;      // 默认：代码内部发起（resolveLevel 的 internal → owner）
    const v = slashVerdict(cmd, { level, cheat });
    return { allowed: v.allowed, name: v.name, cheat, level, why: v.why };
}

/**
 * 发一条斜杠命令 —— **全系统唯一能发命令的地方**。
 *
 * @param {object} bot
 * @param {string} cmd  命令名，带不带前导 `/` 都行（'tp' / '/tp'）
 * @param {Array<string|number>} [args] 参数，按顺序拼成空格分隔
 * @param {object} opts { cheat = false, level = 'owner' }
 * @returns ActionResult
 *   ok           → data: { command, name, cheat }
 *   NO_PERMISSION→ 不在白名单（data: { name, why }）
 *   INTERRUPTED  → 被取消
 *   INTERNAL     → bot.chat 抛错
 */
export async function command(bot, cmd, args = [], opts = {}) {
    const body = [normalizeCommand(cmd), ...(args ?? []).map((a) => String(a))].join(' ').trim();
    const full = `/${body}`;
    const check = checkCommand(cmd, opts);
    if (!check.allowed) {
        return fail('NO_PERMISSION', check.why, { name: check.name, why: check.why });
    }
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    try {
        bot.chat(full);
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e), command: full });
    }
    return ok({ command: full, name: check.name, cheat: check.cheat, level: check.level });
}

/**
 * 公开聊天（`bot.chat`，不带斜杠）。
 *
 * 拒绝以 `/` 开头的文本：那是命令，必须走 `command()` 过白名单。
 * （这就是 08_interface.md §5 / M1 那条"回复以 / 开头会被当命令执行"的守住方式之一。）
 *
 * @returns ActionResult ok(data:{text}) / NO_PERMISSION / INTERRUPTED / INTERNAL
 */
export async function say(bot, text) {
    const t = typeof text === 'string' ? text : String(text ?? '');
    if (!t.trim()) return fail('INTERNAL', 'say 的文本是空的');
    // 用 M1 的 inspectChatText 判：它连"多行里藏一行 /op"也拦（bot.chat 里换行 = 连发多条）。
    // 不要自己写 startsWith('/') —— 那只挡第一行，等于把后门留着。
    const verdict = inspectChatText(t);
    if (!verdict.allowed) {
        return fail('NO_PERMISSION', `聊天内容里不能有以 / 开头的行（${verdict.reason}），命令要走 command()`, { text: t });
    }
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    try {
        bot.chat(t);
        return ok({ text: t });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
}

/** 私聊（`bot.whisper`）。同样拒绝 `/` 开头的文本。 */
export async function whisper(bot, user, text) {
    const t = typeof text === 'string' ? text : String(text ?? '');
    if (!user) return fail('NO_TARGET', 'whisper 需要一个用户名');
    if (!t.trim()) return fail('INTERNAL', 'whisper 的文本是空的');
    const verdict = inspectChatText(t);
    if (!verdict.allowed) {
        return fail('NO_PERMISSION', `私聊内容里不能有以 / 开头的行（${verdict.reason}）`, { text: t, user });
    }
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    try {
        if (typeof bot.whisper === 'function') bot.whisper(user, t);
        else bot.chat(`/msg ${user} ${t}`);
        return ok({ user, text: t });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
}

/**
 * 上载具。
 *
 * Paper 1.21.8 上原生 `bot.mount` 被服务端忽略，所以走 `/ride`（白名单里的那条）。
 *
 * @returns ActionResult ok(data:{entity}) / NO_TARGET / NO_PERMISSION / INTERNAL
 */
export async function mountEntity(bot, entity) {
    if (!entity) return fail('NO_TARGET', 'mountEntity 需要一个实体');
    const id = entity.id ?? entity.entityId;
    if (id == null) return fail('NO_TARGET', '实体没有 id，骑不了');
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    const r = await command(bot, 'ride', [bot.username, 'mount', id]);
    if (!r.ok) return r;
    return ok({ entity: entity.name ?? null, id });
}

/** 下载具。 */
export async function dismount(bot) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    const r = await command(bot, 'ride', [bot.username, 'dismount']);
    if (!r.ok) return r;
    return ok({});
}

/** 死亡后重生（`bot.respawn`）。 */
export async function respawn(bot) {
    try {
        bot.respawn?.();
        return ok({});
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
}
