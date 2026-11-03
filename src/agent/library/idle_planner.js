/**
 * 空闲时自己找事做（M9，08 §6.1）。
 *
 * ★ **空闲的定义（08 §6.1 原文，逐条照抄）**：
 *   「没有任务单在跑或排队、**没有反射在跑**、**30 秒内没人跟她说话**」
 *   三条缺一不可 —— 少判一条就会出现"玩家刚说一句话，她就跑去自己找活"
 *   或"反射正在保命，她还在规划挖矿"。
 *
 * ★ **三层顺序（08 §6.1 原文，不许自己重排）**：
 *   | 层 | 做什么 | 叫不叫模型 |
 *   | 1 需要 | 按规则补短板：背包满→store；缺基础工具→obtain；天快黑且附近没地方待→shelter；食物<5→strat_food | 不叫 |
 *   | 2 想做 | 问模型"现在想干什么"（可 !addJob 一张 0–2 级单，也可什么都不做）| 叫，每 idle.thinkEveryMs 一次（默认 5 分钟）|
 *   | 3 发呆 | 现有空闲 mode（捡东西/插火把/打猎/看人）| 不叫 |
 *
 * 另外几条硬约束（08 §6.1）：
 *   · 自己找的单 `source: 'self'`，优先级只能 **0–2**（玩家一下命令就让路）
 *   · 不许 `!attack` / `!attackPlayer` / `!discard` / `!givePlayer`
 *   · 只动记成她自己的箱子（chests.json 的 `mine: true`），别人的箱子不碰
 *   · 活动范围 ≤ `idle.radius`（默认 100）：主人在线以主人为圆心，否则 home，都没有就以当前位置
 *   · `!stay` / `!stop` 之后不再自己找事，直到玩家下一条命令
 *   · 有 `!goal` 时第 2 层交给 self_prompter，第 1 层照跑
 */

/** 08 §6.1 的默认值（全部具名，别散魔数）。 */
export const IDLE = Object.freeze({
    QUIET_MS: 30000,          // 30 秒内没人说话才算空闲
    THINK_EVERY_MS: 300000,   // 第 2 层问模型的间隔（5 分钟）
    RADIUS: 100,              // 活动半径
    FOOD_MIN: 5,              // 食物少于这个数就补
    SELF_PRIORITY_MAX: 2,     // 自己找的单最高 2 级

    /**
     * ★★ 2026-11-03（t57）：**同一个"需要"下过单之后，多久之内不许再下**。
     *
     * 为什么必须有（真机 138 张单的风暴，verify 实测）：
     *   第 1 层的判据是"缺石镐 → 下一张 `obtain:stone_pickaxe`"。
     *   而那张单会 `blocked`（要石镐→需木镐→需木头→弄不到）。
     *   `blocked` 之后 `jobBusy` 立刻变 false → **下一拍（3 秒后）又下同一张**。
     *   实测：约 45 秒一张，10 分钟堆 **138 张一模一样的单**，
     *   把任务板压垮（连 `board:add` 都开始 ack 超时 → 又引出孤儿父单）。
     *
     * 判据：**"缺什么"是一个持续状态，不是一个可以反复触发的事件。**
     *   同一个 `why` 下过单之后要冷却；冷却期内照常判第 2/3 层，只是不重复下同一张。
     *
     * 取 5 分钟：与 `THINK_EVERY_MS` 同量级 —— 足够让她真去弄一次，
     *   又不至于让"补短板"停摆太久。
     */
    NEED_RETRY_MS: 300000,
});

/**
 * 判断"现在算不算空闲"。**纯函数**，三条一起判。
 *
 * @param {object} s
 *   jobBusy        有任务单在跑/排队（control.jobsBusy）
 *   reflectionBusy 有反射正在跑（任何 mode 的 active）
 *   lastTalkAt     玩家最后一次跟她说话的时间
 *   paused         玩家 !stay / !stop 之后为 true
 *   now
 * @returns {{idle:boolean, reason:string}}
 */
export function isIdle(s = {}) {
    const now = Number(s.now ?? 0);
    if (s.paused) return { idle: false, reason: 'player-paused' };
    if (s.jobBusy) return { idle: false, reason: 'job-busy' };
    if (s.reflectionBusy) return { idle: false, reason: 'reflection-busy' };
    const last = Number(s.lastTalkAt ?? 0);
    if (last && now - last < IDLE.QUIET_MS) return { idle: false, reason: 'recently-talked' };
    return { idle: true, reason: 'idle' };
}

/**
 * 第 1 层"需要"：按**固定顺序**补短板（08 §6.1 表里那一行的顺序）。
 *
 * 每一条都是"某个流程写好了才做"，没写好的**跳过**（08 §6.1 明说）。
 * 返回要下的单描述，或者 null。
 *
 * @param {object} s
 *   inventoryFull 背包是否满
 *   hasBasicTool  有没有基础工具（镐/斧之一）
 *   foodCount     身上食物数量
 *   nearShelter   附近有没有能待的地方
 *   nightFalling  天快黑了
 * @returns {{skill:string, args:object, why:string}|null}
 */
export function planNeeds(s = {}) {
    if (s.inventoryFull) return { skill: 'store', args: {}, why: 'inventory-full' };
    if (s.hasBasicTool === false) return { skill: 'obtain', args: { item: 'stone_pickaxe' }, why: 'no-basic-tool' };
    if (s.nightFalling && s.nearShelter === false) return { skill: 'shelter', args: {}, why: 'night-no-shelter' };
    // ★★ 2026-11-03（t59）：**注册名是 `eat`，不是 `food`** —— 原来这里写 'food'，
    //   而 `SKILL_NAMES` 里根本没有 `food` → `decideIdle` 的 `have.has(need.skill)` 恒 false
    //   → **"缺吃的"这条分支从上线起就是死的**（永远落不到第 1 层）。
    //   是 t57 写冷却用例时用 `foodCount: 1` 才被发现的（用例⑨ 变红）。
    if (Number(s.foodCount ?? 99) < IDLE.FOOD_MIN) return { skill: 'eat', args: {}, why: 'food-low' };
    return null;
}

/**
 * 这一轮空闲 tick 该做什么。
 *
 * @param {object} s 见 isIdle + planNeeds + { lastThinkAt, hasGoal, availableSkills }
 * @returns {{action:'job'|'think'|'idle-mode'|'nothing', job?:object, reason:string}}
 */
export function decideIdle(s = {}) {
    const now = Number(s.now ?? 0);
    const idleVerdict = isIdle(s);
    if (!idleVerdict.idle) return { action: 'nothing', reason: idleVerdict.reason };

    // ── 第 1 层：需要（不叫模型）──────────────────────────────────
    const need = planNeeds(s);
    if (need) {
        // 08 §6.1："哪个写好了用哪个，没写好的先跳过"
        const have = new Set(s.availableSkills ?? []);
        // ★★ t57：**同一个"需要"下过单之后要冷却** —— 见 IDLE.NEED_RETRY_MS 的注释。
        //   不加这条会 10 分钟堆 138 张一模一样的单（真机实测）。
        const lastAt = Number(s.recentNeeds?.[need.why] ?? 0);
        const coolingDown = now - lastAt < IDLE.NEED_RETRY_MS;
        if (have.has(need.skill) && !coolingDown) {
            return {
                action: 'job',
                reason: `need:${need.why}`,
                job: {
                    skill: need.skill,
                    args: need.args ?? {},
                    priority: 1,                 // 自己找的单只能 0–2
                    source: 'self',
                    why: `idle-need:${need.why}`,
                },
            };
        }
        // 没写好、或还在冷却 → 落到第 2/3 层（跳过，不硬塞）
    }

    // ── 第 2 层：想做（问模型，按 thinkEveryMs 节流）────────────────
    const lastThink = Number(s.lastThinkAt ?? 0);
    if (!s.hasGoal && now - lastThink >= IDLE.THINK_EVERY_MS) {
        return { action: 'think', reason: 'idle-think' };
    }

    // ── 第 3 层：发呆（现有空闲 mode）──────────────────────────────
    return { action: 'idle-mode', reason: 'idle-mode' };
}

/**
 * 挂在调度器上的入口：由 BoardScheduler 的空闲 tick 调用。
 *
 * @param {object} agent
 * @param {object} deps { jobsBusy, reflectionBusy, now, enqueue(job), askModel() }
 * @returns {Promise<object>} decideIdle 的结论
 */
export async function idleTick(agent, deps = {}) {
    const now = deps.now ?? Date.now();
    const verdict = decideIdle({
        now,
        paused: agent?._idlePaused === true,
        jobBusy: deps.jobsBusy?.() ?? false,
        reflectionBusy: deps.reflectionBusy?.() ?? false,
        lastTalkAt: agent?._lastTalkAt ?? 0,
        lastThinkAt: agent?._lastIdleThinkAt ?? 0,
        hasGoal: !!agent?.goal,
        // ★ t57：把"各类需要上次下单的时间"喂给纯函数（记忆本身挂在 agent 上，
        //   因为 decideIdle 是纯函数，不许自己存状态）。
        recentNeeds: agent?._idleNeedAt ?? {},
        ...(deps.state ?? {}),
    });

    if (verdict.action === 'job' && deps.enqueue) {
        try {
            await deps.enqueue(verdict.job);
            // ★ t57：**下单成功才记时间**（失败不记，否则"下不进去"会变成永久冷却）。
            //   key 用 `need:<why>` 的 why 部分，与 decideIdle 里查的同一口径。
            const why = String(verdict.reason ?? '').replace(/^need:/, '');
            if (why) {
                if (!agent._idleNeedAt) agent._idleNeedAt = {};
                agent._idleNeedAt[why] = now;
            }
        } catch { /* 下不进去就下一轮再说（不记冷却，允许重试） */ }
    } else if (verdict.action === 'think' && deps.askModel) {
        agent._lastIdleThinkAt = now;
        try { await deps.askModel(); } catch { /* ignore */ }
    }
    return verdict;
}
