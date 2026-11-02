/**
 * 控制层：谁在动身体、被打断之后**单子去哪**、死亡 / 断线怎么接。
 *
 * 对应规范：[`docs/architecture/07_control.md`](../../../docs/architecture/07_control.md)
 * （下称 07）与 [`09_crosscut.md`](../../../docs/architecture/09_crosscut.md) §2。
 *
 * 为什么单独一个文件：`action_manager` 只知道"我在跑一个函数"，它不知道
 * 被它打断的是**谁的事**。07 §4 要求"停的理由决定任务单去哪"——
 * 这条判断必须有一个能被离线测试的地方，而且不能塞进 action_manager
 * （那样它就同时管执行和调度，两件事互相拖）。
 *
 * 分工：
 *   action_manager.stop(reason)  → 记录 `actions.stop_reason`，然后调本文件的 applyStop()
 *   本文件                        → 按 reason 算出状态转移，写进**任务板**
 *   任务板（M8 的 board_client）  → 只有它写库；本文件只调它的 4 个方法
 *
 * 任务板适配器的形状（M8 实现，测试用假板）：
 *   board.list({ states })        → job[]         （不给 states = 全部）
 *   board.update(jobId, patch)    → job|void
 *   board.add(job)                → job|void
 *   board.setAutoClaim(enabled)   → void         （可选；玩家喊停时暂停自动领单）
 *
 * ★ 这个文件是**纯逻辑**：不 import mineflayer、不读文件、不起定时器。
 *   唯一的副作用是 trace_bus 和 agent.history，两者都 try 包住。
 */
import { push as trace } from './trace_bus.js';

/**
 * 停的原因（07 §4 表）。调用方必须带，不许省略 —— 省略就等于"谁都说不清是谁打断的"。
 *
 * `death` 是 07 §4 表里没有的一行：死亡不是"谁打断了动作"，而是 07 §7 单独规定的情形
 * （正在跑的单 → `paused`，`result` 记 `died`，**不算 attempts**）。放进同一个枚举，
 * 是为了让 action_manager 的死亡路径也能走同一套状态转移，不必再抄一遍。
 */
export const STOP_REASONS = Object.freeze({
    BRIEF: 'brief',        // 反射 mode / 即时命令打断：留在本 bot，完事接着做
    PREEMPT: 'preempt',    // 调度器抢占：回 ready，放掉租约和预约
    PLAYER: 'player',      // !stop / !stay：paused，并暂停自动领单
    TIMEOUT: 'timeout',    // action_manager 总超时：按 attempts 重试或 failed
    SHUTDOWN: 'shutdown',  // 进程退出：不动，靠租约过期回收
    DEATH: 'death',        // 死亡（07 §7）：paused，不算 attempts
});

const REASON_SET = new Set(Object.values(STOP_REASONS));

/** 没带原因时按"短暂打断"处理：最保守的一档（单子还在本 bot 手里，不会丢）。 */
export const DEFAULT_STOP_REASON = STOP_REASONS.BRIEF;

/** 07 §4：「超过 60 秒没结束就退回 ready」。 */
export const BRIEF_REQUEUE_MS = 60000;

/** 08 §2：同一张单 30 秒内最多往对话历史塞一行状态。 */
export const JOB_STATUS_DEDUPE_MS = 30000;

/** 07 §7：回去捡的单是 8 级，deadline 4 分钟（掉落物 5 分钟消失）。 */
export const DEATH_PICKUP_PRIORITY = 8;
export const DEATH_PICKUP_DEADLINE_MS = 4 * 60 * 1000;

/** 06 §5 / 07 §8：没有 deadline 时用 manifest 的 timeoutMs，再没有就按 action_manager 的 10 分钟。 */
export const JOB_DEFAULT_TIMEOUT_MINS = 10;
/** 已经过期（或只剩几毫秒）时不能传 0 —— 0 在 action_manager 里表示"不设超时"。 */
export const JOB_MIN_TIMEOUT_MINS = 1 / 60;

/** 06 §5：失败重试上限的默认值（任务单自己带 maxAttempts 时以它为准）。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** 任务单状态（06 §5 生命周期里本层会写到的几个）。 */
export const JOB_STATE = Object.freeze({
    READY: 'ready',
    CLAIMED: 'claimed',
    RUNNING: 'running',
    PAUSED: 'paused',
    FAILED: 'failed',
});

/** 判断一个动作 label 是不是任务单（07 §3.1：任务单跑在 `runAction('job:<skill>')` 上）。 */
export function isJobLabel(label) {
    return typeof label === 'string' && label.startsWith('job:');
}

/** `job:collect` → `collect`。 */
export function jobSkillFromLabel(label) {
    return isJobLabel(label) ? label.slice(4) : null;
}

/** 由 skill 造 label（调度器与测试共用一份，免得两边写不一样）。 */
export function jobLabel(skill) {
    return `job:${skill}`;
}

/** 不认识的 reason 一律收敛到 brief（宁可让单留在手里，也不要凭空把它判失败）。 */
export function normalizeStopReason(reason) {
    return REASON_SET.has(reason) ? reason : DEFAULT_STOP_REASON;
}

/**
 * **07 §4：停的原因决定任务单去哪。** —— 本层唯一的判据表，测试逐条对。
 *
 * 纯函数：给 reason + 当前单，返回要写进单子的 patch 与结果码；不碰任何外部状态。
 *
 * @param {{reason:string, job?:object|null, now?:number}} args
 * @returns {{
 *   reason:string, jobId:string|null, to:string|null, code:string|null,
 *   patch:object|null, pauseAutoClaim:boolean, requeueAfterMs:number|null
 * }}
 */
export function planStop({ reason, job = null, now = Date.now() } = {}) {
    const r = normalizeStopReason(reason);
    const base = {
        reason: r,
        jobId: job?.id ?? null,
        to: job?.state ?? null,
        code: null,
        patch: null,
        pauseAutoClaim: false,
        requeueAfterMs: null,
    };

    // 玩家喊停时哪怕没有单在跑，也要暂停自动领单（否则她停一秒又去领下一张，06 §7）。
    if (!job) {
        return { ...base, pauseAutoClaim: r === STOP_REASONS.PLAYER };
    }

    switch (r) {
        case STOP_REASONS.BRIEF:
            // 留在本 bot：仍是 claimed/running，租约照常心跳；打断结束接着做。
            return {
                ...base,
                to: job.state ?? JOB_STATE.CLAIMED,
                // 不写 result code：07 §4「结果码：不写」—— 流程自己报的是 INTERRUPTED，
                // 「是谁打断的」只有控制层知道，写进单子的备注字段而不是结果码。
                patch: { interrupted: { reason: r, at: now } },
                requeueAfterMs: BRIEF_REQUEUE_MS,
            };

        case STOP_REASONS.PREEMPT:
            return {
                ...base,
                to: JOB_STATE.READY,
                code: 'PREEMPTED',
                patch: {
                    state: JOB_STATE.READY,
                    lease: null,
                    reservations: [],
                    result: { code: 'PREEMPTED', at: now },
                },
            };

        case STOP_REASONS.PLAYER:
            return {
                ...base,
                to: JOB_STATE.PAUSED,
                code: 'INTERRUPTED',
                pauseAutoClaim: true,
                patch: {
                    state: JOB_STATE.PAUSED,
                    lease: null,
                    result: { code: 'INTERRUPTED', at: now },
                },
            };

        case STOP_REASONS.TIMEOUT: {
            // 06 §5：TIMEOUT **计** attempts；满上限判 failed，否则回 ready 重试。
            const attempts = (job.attempts ?? 0) + 1;
            const max = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
            const failed = attempts >= max;
            return {
                ...base,
                to: failed ? JOB_STATE.FAILED : JOB_STATE.READY,
                code: 'TIMEOUT',
                patch: {
                    state: failed ? JOB_STATE.FAILED : JOB_STATE.READY,
                    lease: null,
                    attempts,
                    result: { code: 'TIMEOUT', at: now },
                },
            };
        }

        case STOP_REASONS.SHUTDOWN:
            // 什么都不改：租约过期后由任务板自己回收（06 §6）。
            return { ...base, to: job.state ?? null, patch: null };

        case STOP_REASONS.DEATH:
            return {
                ...base,
                to: JOB_STATE.PAUSED,
                code: 'DIED',
                patch: {
                    state: JOB_STATE.PAUSED,
                    lease: null,
                    result: { code: 'DIED', at: now },
                    countAttempt: false,   // 07 §7：死了不算她的错，不算 attempts
                },
            };

        default:
            return base;
    }
}

/**
 * 从动作 label / jobId 找出被打断的那张单（找不到返回 null = 打的不是单）。
 *
 * ★ **label 优先，jobId 只在没有 label 时兜底。** 为什么：`runJobAction` 会在调
 * `runAction` **之前**就把 `actions.currentJobId` 换成**新单**，而 `_executeAction`
 * 一开工就先 `stop()` 旧动作 —— 这时候 `currentJobId` 已经是新单了，按它归因
 * 会把"被 mode 打断的旧动作"记到新单头上。被打断的是谁，只有 label 说得准。
 */
export function resolveJob({ board = null, jobId = null, label = null } = {}) {
    if (!board) return null;
    try {
        if (label) {
            const skill = jobSkillFromLabel(label);
            if (skill == null) return null;   // 被打断的是 mode / 即时命令，不是任务单
            const running = board.list?.({ states: [JOB_STATE.CLAIMED, JOB_STATE.RUNNING] }) ?? [];
            return running.find((j) => j?.skill === skill) ?? null;
        }
        if (jobId != null) return board.get?.(jobId) ?? null;
        return null;
    } catch {
        return null;
    }
}

/**
 * 把"停"的后果落到任务板上。action_manager.stop(reason) 之后调它。
 *
 * @param {{agent:object, reason:string, label?:string|null, jobId?:string|null, now?:number}} args
 * @returns {ReturnType<typeof planStop>}
 */
export function applyStop({ agent, reason, label = null, jobId = null, now = Date.now() } = {}) {
    const r = normalizeStopReason(reason);
    const board = agent?.board ?? null;
    const job = resolveJob({ board, jobId: jobId ?? agent?.actions?.currentJobId ?? null, label });
    const plan = planStop({ reason: r, job, now });

    if (board && job?.id != null && plan.patch) {
        try { board.update(job.id, plan.patch); } catch { /* 任务板写失败不该让动作停不下来 */ }
    }
    if (board && plan.pauseAutoClaim) {
        try { board.setAutoClaim?.(false); } catch { /* 同上 */ }
    }
    // 只有真的牵扯到单子（或要暂停领单）才留痕，否则每换一次动作就一条噪音。
    if (job?.id != null || plan.pauseAutoClaim) {
        try {
            trace('stop-reason', {
                reason: r,
                jobId: job?.id ?? '',
                label: String(label ?? '').slice(0, 40),
                to: plan.to ?? '',
            });
        } catch { /* trace 失败不影响控制 */ }
    }
    return plan;
}

/**
 * 07 §4：brief 打断后「超过 60 秒没结束就退回 ready」。
 *
 * 由调度器在空闲 tick 调（M8 接上）；这里给纯函数，方便离线测。
 *
 * @param {{board:object, now?:number, maxAgeMs?:number, isStillRunning?:Function}} args
 * @returns {string[]} 被退回 ready 的单 id
 */
export function requeueStaleBrief({
    board,
    now = Date.now(),
    maxAgeMs = BRIEF_REQUEUE_MS,
    isStillRunning = null,
} = {}) {
    const jobs = board?.list?.({ states: [JOB_STATE.CLAIMED, JOB_STATE.RUNNING] }) ?? [];
    const moved = [];
    for (const job of jobs) {
        const at = job?.interrupted?.at;
        if (!Number.isFinite(at) || now - at < maxAgeMs) continue;
        // 动作真的还没退出就别动它（07 §5 的"停不下来"是 bug，由 action_manager 处理）
        if (typeof isStillRunning === 'function' && isStillRunning(job)) continue;
        try {
            board.update(job.id, { state: JOB_STATE.READY, lease: null, interrupted: null });
            moved.push(job.id);
        } catch { /* 单条失败不影响其它单 */ }
    }
    return moved;
}

/**
 * 08 §2：**有任务单在跑或排队时，self_prompter 不催。**
 *
 * 「跑」= claimed / running，「排队」= ready。`paused` 不算 —— 那是玩家喊停之后
 * 等人说"继续"的状态，催模型也没用（玩家的话才是最该等的）。
 *
 * 没有任务板（M8 之前）时永远返回 false，行为与现在一致。
 */
export function jobsBusy(agent) {
    const board = agent?.board ?? null;
    if (!board?.list) return false;
    try {
        const jobs = board.list({ states: [JOB_STATE.READY, JOB_STATE.CLAIMED, JOB_STATE.RUNNING] }) ?? [];
        return jobs.length > 0;
    } catch {
        return false;
    }
}

/**
 * 07 §8：任务单的超时换算成 `runAction` 要的**分钟**。
 *
 * 不能吃 action_manager 的默认 10 分钟：30 分钟的策略会被砍成 10 分钟；
 * 也不能把 deadline 当摆设 —— 到点就该 TIMEOUT 往上报（D9 的根因是只在循环开头查）。
 *
 * @param {object} job  需要 deadline（绝对毫秒）或 manifest.timeoutMs
 * @param {number} now
 * @param {number} fallbackMins 两者都没有时用（默认 10 = action_manager 的默认）
 */
export function jobDeadlineTimeoutMinutes(job, now = Date.now(), fallbackMins = JOB_DEFAULT_TIMEOUT_MINS) {
    let deadline = Number.isFinite(job?.deadline) ? job.deadline : null;
    if (deadline == null && Number.isFinite(job?.manifest?.timeoutMs)) {
        deadline = now + job.manifest.timeoutMs;
    }
    if (deadline == null) return fallbackMins;
    const leftMins = (deadline - now) / 60000;
    if (!(leftMins > 0)) return JOB_MIN_TIMEOUT_MINS;   // 已过期：给个最短倒计时，别给 0（0 = 不设超时）
    return Math.round(leftMins * 100) / 100;
}

/**
 * 任务单的执行入口：**label 与 deadline 一起带上**（07 §3.1 / §8 / 清单第 6 条）。
 *
 * 现在还没有调度器（M8），但动作侧的口径先定下来：
 * 凡是任务单，都从这一个函数进 action_manager，label 必须是 `job:<skill>`，
 * timeout 必须由 deadline 换算 —— 这样 M8 接上时不用再动 action_manager。
 *
 * @param {object} agent
 * @param {object} job
 * @param {Function} fn 流程本身
 * @param {{now?:number, timeout?:number, stopReason?:string}} [opts]
 */
export async function runJobAction(agent, job, fn, opts = {}) {
    const { now = Date.now(), timeout = null, stopReason = DEFAULT_STOP_REASON } = opts;
    const mins = timeout ?? jobDeadlineTimeoutMinutes(job, now);
    const label = jobLabel(job?.skill ?? 'unknown');
    const actions = agent?.actions;
    const prevJobId = actions?.currentJobId ?? null;
    if (actions) actions.currentJobId = job?.id ?? null;
    try {
        return await actions.runAction(label, async () => { await fn(); }, { timeout: mins, stopReason });
    } finally {
        if (actions) actions.currentJobId = prevJobId;
    }
}

/**
 * 07 §4 第 5 步 / 08 §2：被打断的是**任务单**时，不发 AUTO MESSAGE（那条会让模型重新下命令），
 * 改给模型一行状态。同一张单 30 秒内最多一行。
 *
 * @returns {string|null} 真的写了才返回那一行（被去重/没有单时返回 null）
 */
export function noteJobInterrupted(agent, { label = null, mode = null, reason = STOP_REASONS.BRIEF, now = Date.now() } = {}) {
    const board = agent?.board ?? null;
    const job = resolveJob({ board, jobId: agent?.actions?.currentJobId ?? null, label });
    const skill = job?.skill ?? jobSkillFromLabel(label) ?? '?';
    const key = job?.id ?? `${label}#${skill}`;

    const seen = (agent._jobStatusAt ??= new Map());
    const last = seen.get(key) ?? 0;
    if (now - last < JOB_STATUS_DEDUPE_MS) return null;
    seen.set(key, now);

    const who = mode ? `被 ${mode} 打断` : '被打断';
    const line = `[单 ${job?.id ? '#' + job.id : '(未登记)'} ${skill}] ${who}（${reason}）— 调度器会接着做，不用重新下命令`;
    try { agent?.history?.add?.('system', line); } catch { /* 历史写失败不影响控制 */ }
    try { trace('job-interrupted', { jobId: job?.id ?? '', skill: String(skill).slice(0, 24), mode: String(mode ?? '').slice(0, 24) }); } catch { /* ignore */ }
    return line;
}

/**
 * 07 §7：死因从死亡消息里判断。**岩浆 / 掉出世界不回去捡** —— 东西已经没了，那里也危险。
 *
 * 判据只认英文原文（MC 服务端消息）与常见中文译名，认不出时按 `other` 处理（会去捡）。
 */
export function deathCause(message) {
    const t = String(message ?? '').toLowerCase();
    if (!t) return 'other';
    if (t.includes('lava') || t.includes('岩浆')) return 'lava';
    if (t.includes('fell out of the world') || t.includes('out of the world')
        || t.includes('the void') || t.includes('掉出了这个世界') || t.includes('掉出世界')) return 'void';
    if (t.includes('drowned') || t.includes('溺水')) return 'drown';
    if (t.includes('fell from') || t.includes('hit the ground') || t.includes('摔')) return 'fall';
    return 'other';
}

/** 07 §7：岩浆 / 掉出世界 → 不开"回去捡"的单。 */
export function shouldRecoverItems(cause) {
    return cause !== 'lava' && cause !== 'void';
}

/** 07 §7 的"回去捡"个人单：goto 死亡点 → pickup，8 级，deadline 4 分钟。 */
export function deathPickupJob({ id = null, pos, now = Date.now(), skill = 'flow_pickup' } = {}) {
    const p = pos ?? {};
    return {
        id: id ?? `death-pickup-${now}`,
        kind: 'personal',
        skill,
        // 流程侧（M7）照 args 走：先 goto 到死亡点，再在半径内捡
        args: {
            x: Number(p.x ?? 0),
            y: Number(p.y ?? 0),
            z: Number(p.z ?? 0),
            radius: 24,
            reason: 'death',
        },
        priority: DEATH_PICKUP_PRIORITY,
        state: JOB_STATE.READY,
        deadline: now + DEATH_PICKUP_DEADLINE_MS,
        manifest: { timeoutMs: DEATH_PICKUP_DEADLINE_MS },
        source: 'death',
    };
}

/**
 * 07 §7：死亡处理 —— 正在跑的单 `paused`（result 记 `died`，不算 attempts），
 * 另开一张 8 级的"回去捡"单（岩浆 / 掉出世界不开）。
 *
 * 由 `agent._handleDeath()` 调（两个触发源都已去重，这里不再管去重）。
 *
 * @param {object} agent
 * @param {{message?:string|null, pos?:object|null, cause?:string|null, now?:number}} [args]
 * @returns {{cause:string, paused:string[], pickup:object|null}}
 */
export function onDeath(agent, { message = null, pos = null, cause = null, now = Date.now() } = {}) {
    const c = cause ?? deathCause(message);
    const board = agent?.board ?? null;
    const paused = [];

    // 1) 正在跑 / 刚领到的单 → paused，结果码 DIED（不算 attempts，复活后可以续）
    const live = board?.list?.({ states: [JOB_STATE.CLAIMED, JOB_STATE.RUNNING] }) ?? [];
    for (const job of live) {
        try {
            board.update(job.id, {
                state: JOB_STATE.PAUSED,
                lease: null,
                result: { code: 'DIED', at: now },
                // 注：这里原来还有 `countAttempt: false` —— 已删（2026-11-02 t23）。
                //   `updateJob` 根本不碰 `attempts`（它只按 PATCHABLE 拼 SET），所以那个字段
                //   **从来没起过作用**，而且不在白名单/表列里，属于"写了但静默丢弃"的死字段。
                //   想让"死亡不算 attempts"成立，靠的是**这里不走 finish()**（走的是 updateJob），
                //   不是靠这个字段。留着只会让下一个人以为它在起作用。
            });
            paused.push(job.id);
        } catch { /* 单条失败不影响其它单 */ }
    }

    // 2) 回去捡：岩浆 / 虚空不开
    let pickup = null;
    if (board && pos && shouldRecoverItems(c)) {
        pickup = deathPickupJob({ pos, now });
        try { board.add(pickup); } catch { pickup = null; }
    }

    try { trace('death', { cause: c, paused: paused.length, pickup: pickup ? 1 : 0 }); } catch { /* ignore */ }
    return { cause: c, paused, pickup };
}
