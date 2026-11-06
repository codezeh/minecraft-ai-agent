/**
 * F-EXEC-101 / F-EXEC-204（2026-11-06）：任务脚本里斜杠命令的**唯一闸**。
 *
 * 背景：`src/agent/tasks/**` 下有 37 处裸 `bot.chat('/…')`（cooking 27 + tasks 10），
 * 直接绕过 `atom_input_misc.command()` 的**白名单 + 等级**判定。其中最重的：
 *   · 8 条 `/fill`（合计清 100×100×10，不可撤销）
 *   · `/kill @e[type=…,distance=..200]`（200 格内该类实体全清）
 *   · `/clear <bot>` / `/clear <玩家名>`
 *
 * 为什么不是"在调用方跳段"（上一版的 `ALLOW_TASK_CHEATS`）：
 *   那只挡住了**已知的那几段**，绕过 `command()` 白名单的**本质没变** —— 新增一处
 *   `bot.chat('/op 某人')` 照样静默生效。
 *
 * 所以这里把校验**下沉到 sink**：把 `bot.chat` 包一层，任何以 `/` 开头的字符串
 * 都必须过**同一张白名单**（`permissions.slashVerdict`）。这样：
 *   ✅ 新增调用点**不会**静默绕过 —— 因为无论谁调用，最终都得走被包过的 `bot.chat`
 *   ✅ 白名单只有一份（复用 `SLASH_COMMANDS`），不新增第二真相源
 *   ✅ 作弊类命令还需要显式运行期开关（`ALLOW_TASK_CHEATS=1`）
 *
 * 作用域：guard 只在**任务流程**里安装（见 `initBotTask()` 与 `CookingTaskInitiator` 构造器）。
 * 不在全局安装的原因：`atom_input_misc` 会发 `/msg`（悄悄话），那是聊天能力而不是作弊命令；
 * 全局安装会误伤它。（`/msg` 的登记者见 permissions.js 的 SLASH_COMMANDS。）
 *
 * 本文件放在 `tasks/` 而不是 `library/`：`library/` 是自研游戏能力模块目录，需要写《自研申报》，
 * 这个闸不属于那一类（captain 2026-11-06 明确要求）。
 */
import { slashVerdict, LEVEL } from '../permissions.js';

/** 运行期开关：允许任务脚本发**作弊类**斜杠命令（默认关）。 */
export function taskCheatsAllowed() {
    return process.env.ALLOW_TASK_CHEATS === '1';
}

/**
 * 判定一条任务脚本要发的文本能不能出去。纯函数，便于单测。
 *
 * @param {string} text
 * @param {{allowCheats?: boolean}} [opts] 默认取 `taskCheatsAllowed()`
 * @returns {{ok:boolean, command:string|null, cheat:boolean, reason:string}}
 */
export function classifyTaskChat(text, opts = {}) {
    const s = String(text ?? '');
    const allowCheats = opts.allowCheats ?? taskCheatsAllowed();

    if (!s.trimStart().startsWith('/')) {
        return { ok: true, command: null, cheat: false, reason: '普通聊天（非斜杠），不归本闸管' };
    }

    // 复用**同一张**白名单（cheat:true 表示"调用方知道这是作弊命令"，仍要过 entry.cheat 判定）
    const v = slashVerdict(s, { level: LEVEL.OWNER, cheat: true });
    if (!v.allowed) {
        return { ok: false, command: v.name, cheat: true, reason: v.why };
    }
    const isCheat = v.entry?.cheat === true;
    if (isCheat && !allowCheats) {
        return {
            ok: false, command: v.name, cheat: true,
            reason: `${v.name} 是作弊命令，任务脚本需要 ALLOW_TASK_CHEATS=1 才允许`,
        };
    }
    return { ok: true, command: v.name, cheat: isCheat, reason: v.why };
}

const GUARD_KEY = Symbol.for('mindcraft.taskChatGuard');

/** 这个 bot 上装了闸吗。 */
export function isTaskChatGuardInstalled(bot) {
    return !!(bot && bot[GUARD_KEY]);
}

/**
 * 在 bot 上装 sink 级闸（幂等：重复调用不会套两层）。
 * @returns {boolean} true = 本次真的装上了
 */
export function installTaskChatGuard(bot, { onBlocked } = {}) {
    if (!bot || typeof bot.chat !== 'function') return false;
    if (bot[GUARD_KEY]) return false;

    const original = bot.chat.bind(bot);
    const wrapped = (message, ...rest) => {
        const verdict = classifyTaskChat(message);
        if (!verdict.ok) {
            const detail = `[F-EXEC-101] 拦住任务脚本的斜杠命令：${verdict.reason}`;
            console.error(detail);
            try { onBlocked?.(verdict, message); } catch { /* 记录失败不能挡住主流程 */ }
            return;   // **不发出去**
        }
        return original(message, ...rest);
    };
    bot[GUARD_KEY] = { original };
    bot.chat = wrapped;
    return true;
}

/** 撤掉闸（恢复原 bot.chat）。任务流程结束时调用。 */
export function uninstallTaskChatGuard(bot) {
    if (!bot || !bot[GUARD_KEY]) return false;
    bot.chat = bot[GUARD_KEY].original;
    delete bot[GUARD_KEY];
    return true;
}
