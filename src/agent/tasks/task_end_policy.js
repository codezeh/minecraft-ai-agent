/**
 * 任务结束该怎么收场 —— **可注入、可离线钉死**的纯判定（★ R6 ADR §10.2-3）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 病根（ADR-0001 §10.2 第 3 条 / 比 R6 #17 更长的一条路径）
 *
 *   `tasks.js:isDone()` 在"任务进行中"发现同伙不齐时，返回一个**看起来像正常结束**
 *   的结果（`{message:'No other agents found', score:0}`）；而 `agent.checkTaskDone()`
 *   只看 `if (res)` ⇒ 一律 `this.killAll()` ⇒ `mindserver_proxy.shutdown()` ⇒
 *   `socket.emit('shutdown')` ⇒ **整套服务退出**（其它 bot / 面板 / 任务板数据库一起没）。
 *
 *   一期（#17）只堵了**开工阶段**的两处（initBotTask / teleportBots），
 *   进行中的这条 `isDone → checkTaskDone → killAll` 一直留着 ——
 *   一只 bot 因为同伙掉线而判"任务不成功"，就能把整台机器关掉。
 *
 * 现在：
 *   ① `isDone()` 的成功/失败不再只用 `res` 的真假表示，而是带 `endReason`：
 *      `success` / `teammates_missing` / `timeout`；
 *   ② 这里把它翻成**动作**：只有「任务成功」才允许关整机（那是既有正常路径：
 *      一队人跑完任务 ⇒ 整套退出）；**任何失败/缺同伙都只是这只 bot 自己的事**
 *      ⇒ `cleanKill(msg, 4)`（退出码 > 1，`planExit()` 走 unregister：只摘掉这一个
 *      agent，其它进程照常）。
 *   ③ 判定与副作用都放在这个**零依赖**文件里 ⇒ 用例能用假 agent 直接钉住
 *      "缺同伙时 killAll 一次都不许被调用"（这是禁掉就会红的硬断言）。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 任务为什么结束。字符串值进日志，别随手改（用例与文档都按字面引用）。 */
export const TASK_END = Object.freeze({
    SUCCESS: 'success',
    TEAMMATES_MISSING: 'teammates_missing',
    TIMEOUT: 'timeout',
});

/** 收场动作。**只有 SUCCESS 会关整机**。 */
export const TASK_END_ACTION = Object.freeze({
    CONTINUE: 'continue',
    SHUTDOWN_ALL: 'shutdown_all',
    DETACH_SELF: 'detach_self',
});

/** 「只摘自己」的退出码 —— 与 `wait_for_teammates.js` / `tasks.js:detachSelf` 同一档。 */
export const SELF_DETACH_EXIT_CODE = 4;

/**
 * 从 `isDone()` 的返回值判「该怎么收场」。
 *
 * 规则（**失败一律局部**）：
 *   · `null/false/undefined`            → CONTINUE（还没结束，继续跑）
 *   · `endReason === 'success'`         → SHUTDOWN_ALL（既有正常路径：一队人跑完 ⇒ 整套退出）
 *   · `endReason === 'teammates_missing'` → DETACH_SELF（缺同伙：只摘自己）
 *   · `endReason === 'timeout'`         → DETACH_SELF（一张单超时不该拖死别的 bot）
 *   · 其它任何真值（老调用方没带 endReason，例如校验器直接返回 `{message,score}`）
 *                                       → DETACH_SELF（**默认局部失败**：宁可这只 bot 退场，
 *                                          也不许因为一条没标清的结束去关整机）
 *
 * @param {{message?:string, score?:number, endReason?:string}|null|false|undefined} result
 * @returns {{action:string, reason:string, message:string}}
 */
export function decideTaskEnd(result) {
    if (!result) {
        return { action: TASK_END_ACTION.CONTINUE, reason: 'running', message: '' };
    }
    const reason = String(result.endReason ?? '').trim().toLowerCase();
    const message = String(result.message ?? '任务结束');
    if (reason === TASK_END.SUCCESS) {
        return { action: TASK_END_ACTION.SHUTDOWN_ALL, reason: TASK_END.SUCCESS, message };
    }
    const known = reason === TASK_END.TEAMMATES_MISSING || reason === TASK_END.TIMEOUT;
    return {
        action: TASK_END_ACTION.DETACH_SELF,
        reason: known ? reason : 'unsuccessful',
        message,
    };
}

/**
 * 按判定执行收场。**这是唯一允许碰 `killAll` / `cleanKill` 的地方。**
 *
 * 副作用边界（刻意做窄，便于用例用假 agent 断言）：
 *   · SHUTDOWN_ALL → `agent.killAll()`（既有正常路径，只给"任务成功"）
 *   · DETACH_SELF  → `agent.cleanKill(msg, 4)`；`cleanKill` 缺失/抛错都兜住，
 *                    只记日志（任务初始化阶段 agent 可能半坏 —— 同 tasks.js:detachSelf 的口径）
 *   · CONTINUE     → 什么都不做
 *
 * @param {object} agent 需要 `killAll()` / `cleanKill(msg, code)`（假 agent 给 spy 即可）
 * @param {{message?:string, score?:number, endReason?:string}|null|false} result
 * @param {{onAction?:Function}} [opts] 观测钩子（用例/日志用；抛错也兜住）
 * @returns {{action:string, reason:string, message:string, detached:boolean}}
 */
export function applyTaskEnd(agent, result, opts = {}) {
    const decision = decideTaskEnd(result);
    let detached = false;

    if (decision.action === TASK_END_ACTION.SHUTDOWN_ALL) {
        try { agent?.killAll?.(); } catch (e) {
            console.error(`[task] 关整机时异常（已兜住）: ${e?.message ?? e}`);
        }
    } else if (decision.action === TASK_END_ACTION.DETACH_SELF) {
        const msg = `任务未成功（${decision.reason}）：${decision.message}`
            + ' —— 只摘掉自己，不关整机（其它 bot / 面板 / 任务板照常）';
        console.error(`[task] ${msg}`);
        try {
            if (typeof agent?.cleanKill !== 'function') throw new Error('agent.cleanKill 不可用');
            agent.cleanKill(msg, SELF_DETACH_EXIT_CODE);
            detached = true;
        } catch (e) {
            console.error(`[task] 摘除自身时异常（已兜住）: ${e?.message ?? e}`);
        }
    }

    try { opts?.onAction?.(decision); } catch { /* 观测钩子不许影响收场 */ }
    return { ...decision, detached };
}

/** 进行中"人数够不够"的三态判定结果。 */
export const TEAMMATE_STATE = Object.freeze({
    PRESENT: 'present',   // 人数够（可以继续跑）
    WAITING: 'waiting',   // 不齐但在宽限内（继续等，**不判失败**）
    MISSING: 'missing',   // 宽限也用完了（才判失败）
});

/**
 * 「进行中缺同伙」的纯判定（★ ADR §10.2-3 的"能等/重试"那一半）。
 *
 * 抽出来的理由：`isDone()` 在 `tasks.js` 里，而那个文件顶层 import 了
 * `commands/index.js` → mineflayer 一整条链，离线用例导入它又慢又容易连带崩。
 * 把"什么时候算缺、等多久"做成纯函数后，用例能在毫秒级钉住整张矩阵。
 *
 * @param {{now:number, elapsedSec:number, present:number, required:number,
 *          missingSince:number|null, graceMs:number, minElapsedSec?:number}} p
 * @returns {{state:string, missingSince:number|null}}
 */
export function teammateState({ now, elapsedSec = 0, present = 0, required = 1,
    missingSince = null, graceMs = 0, minElapsedSec = 30 } = {}) {
    const need = Math.max(1, Math.floor(Number(required) || 1));
    const got = Math.max(0, Math.floor(Number(present) || 0));
    if (got >= need) return { state: TEAMMATE_STATE.PRESENT, missingSince: null };
    // 任务刚开始的 minElapsedSec 内不判缺（给开局签到留时间）
    if (Number(elapsedSec) < Number(minElapsedSec)) {
        return { state: TEAMMATE_STATE.WAITING, missingSince: null };
    }
    const since = missingSince == null ? Number(now) : Number(missingSince);
    if (Number(now) - since < Math.max(0, Number(graceMs) || 0)) {
        return { state: TEAMMATE_STATE.WAITING, missingSince: since };
    }
    return { state: TEAMMATE_STATE.MISSING, missingSince: since };
}
