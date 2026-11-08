/**
 * 任务板调度器（M8 B2，06 §7/§8，设计见 M8_实施设计.md §4）。
 *
 * agent 侧。职责：**空闲时领单、跑单、续租、回报、被抢占时让位并在之后续做**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主循环（06 §8 原文，五个步骤对应本文件的五个位置）：
 *
 *   空闲 且 未被玩家暂停:
 *     1. 有自己的 paused 单              → `_resumeOwnPaused()`      （step 1）
 *     2. 否则 board:claim                → `_claimNext()`            （step 2）
 *     3. 逐个 reserve(job.claims)        → `_reserveClaims()`        （step 3）
 *     4. runAction + 每 10 秒 heartbeat  → `_runJob()`               （step 4）
 *     5. board:finish(result) + release  → `_runJob()` 的收尾段       （step 5）
 *
 * 抢占（06 §7）：
 *     9 级抢任何 / 6–8 级抢比自己低 ≥2 级 / 3–5 级排队 / 0–2 级只在完全空闲
 *     判据是纯函数 `preempts()`，可以离线逐级验证。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三个高危点（设计 §4 的硬要求，逐条落地 + 都有对应用例）：
 *
 *   ① **抢占方与被抢占方不能同时驱动 bot**
 *      依赖 D18：`action_manager.stop()` 会**等** `executing` 变 false（等不到就判 zombie
 *      并置 `killed`）。所以 `_preempt()` 里 stop 之后必须先看 `actions.killed`：
 *      已 killed → **绝不开新动作**（旧流程还在跑，开了就是两个流程一起动身体）。
 *
 *   ② **`INTERRUPTED` 不能算失败**
 *      抢占路径把单记 `paused(reason:'preempted')`（不是 failed/ready+attempts）。
 *      attempts 只有真的 TIMEOUT/STUCK/NO_PATH 才加（B1 的 store 已保证，这里不重复加）。
 *
 *   ③ **玩家说"停"时调度器也暂停自动领单**
 *      `setAutoClaim(false)` 是**显式开关**，不靠"当前没单"推断。关掉期间：
 *      不领新单、不抢占；**正在跑的单接着跑**（06 §14："正在跑的单接着跑"）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么 `tick()` 只做**一遍**（不内部 while 循环）：
 *   "空闲时不空转"。一遍就返回，节奏由调用方的定时器决定 —— 也才有机会在两次 tick
 *   之间响应"玩家喊停 / 进程退出"。内部死循环会让中断要等很久。
 */

import {
    JOB_STATE, jobsBusy, requeueStaleBrief, STOP_REASONS,
    // ★ T31 第6条①：任务单**必须**经由它驱动（零调用方的现成实现）
    runJobAction,
} from './control.js';
import { deriveClaims } from './board_claims.js';
import { makeCtx } from './composite_registry.js';
import { getSkill } from './composite_registry.js';
import { jobDeadlineTimeoutMinutes } from './control.js';
// ★ 2026-11-02 t25：`meetsRequires` **只允许有一份实现**，真身在 board_store.js。
//   这个文件原来自己又写了一份（且行为与 store 那份相反）—— 典型"两处各叫一个名字"：
//   claimFor 用的是 store 那份（真正决定能不能领），而这里的抢占/领单判定用的是本地这份，
//   于是"没配角色的 bot 能不能领"取决于你走哪条路。已改成 import，删掉本地副本。
import { meetsRequires } from './board_store.js';
// ★ t39：`isNightFalling` **只允许有一份实现**，真身在查询层 `query_perceive.js`
//   （`strat_first_night` 只是 re-export 它）。为什么不用 strat 那份：
//   分层规矩里 `board` 只能 import `query`/`infra`（board → strat 是**新违规**，
//   preflight 的 prefix 检查会红）。放 query 则"只有一份实现 + 两边都能用"同时成立。
import { isNightFalling } from './query_perceive.js';
// ★ t73：统一走 `query_perceive.blockAt`（内部包 Vec3）——
//   直接 `bot.blockAt(裸对象)` 会抛 `point.floored is not a function`（今晚第 4 例）
import { blockAt as readBlock } from './query_perceive.js';

// ───────────────────────────────────────────────────────────────────────────
// 纯函数（不碰 I/O，好离线测）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 挑战者能否抢占正在跑的单（06 §7 表）。
 *
 * | 挑战者级别 | 能不能抢 |
 * |---|---|
 * | 9         | 抢**任何**更低级的单 |
 * | 6–8       | 抢比自己低 **≥2 级**的 |
 * | 3–5       | **不抢**，排队 |
 * | 0–2       | **不抢**，只在完全空闲时 |
 *
 * 额外一条（防抖动）：**同级或更低一律不抢**。
 * 不然两张 9 级单会互相抢来抢去，谁也做不完 —— 那不是调度，是抖。
 *
 * @param {number} challenger 挑战者的 priority
 * @param {number} running    正在跑的单的 priority
 * @returns {boolean}
 */
export function preempts(challenger, running) {
    const a = Number(challenger);
    const b = Number(running);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a <= b) return false;                       // 同级/更低：不抢（防抖动）
    if (a >= 9) return true;                        // 9 级：抢任何
    if (a >= 6) return b <= a - 2;                  // 6–8 级：抢低 ≥2 级的
    return false;                                   // 3–5 / 0–2：只排队
}

/**
 * 从候选单里挑最该做的一张：**优先级高的先，同级取近的**。
 *
 * 06 §8："个人单优先，再多人单；按 requires 过滤，按 priority、距离排序"。
 * 个人单优先已经在 `board:claim`（store 的 claimFor）里做了；这里再按 priority + 距离排，
 * 用于**抢占判定**（找出"有没有比我手上这张更该做的"）。
 *
 * @param {object[]} jobs
 * @param {{x:number,z:number}|null} pos 用于算距离；没有就只按优先级
 * @returns {object|null}
 */
export function pickBest(jobList, pos = null) {
    const list = (jobList ?? []).filter((j) => j && j.state === JOB_STATE.READY);
    if (!list.length) return null;
    const dist = (j) => {
        if (!pos || !j?.args) return 0;
        // 只对带坐标的 args 算距离；算不出来就当 0（= 不比距离）
        const t = j.args.target ?? j.args.pos ?? null;
        if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.z)) return 0;
        return Math.hypot(t.x - pos.x, t.z - pos.z);
    };
    return list.slice().sort((a, b) => {
        const dp = (Number(b.priority) || 0) - (Number(a.priority) || 0);
        if (dp !== 0) return dp;
        return dist(a) - dist(b);
    })[0] ?? null;
}

// （本地那份 meetsRequires 已删除 —— 单一真相在 board_store.js，见顶部 import 处的说明。）
//   但**保留对外导出**：已有单测（board_scheduler_unit）和外部调用按老路径从这里取，
//   给一个 re-export 而不是再写一份实现 —— 这样"只有一份实现"和"向后兼容"同时成立。
export { meetsRequires };

/**
 * 这一拍的 `idle-plan` 事件该不该发（t38：清遗留④，纯函数，好离线测）。
 *
 * ★ 为什么需要：`idle_planner.decideIdle()` 末尾是无条件兜底
 *   `return { action: 'idle-mode', reason: 'idle-mode' }`，而调度器拍子是 3 秒
 *   （`agent.js` 的 `EVERY = 3000`）—— 原来的判断只有 `action !== 'nothing'`，
 *   于是**完全空闲的 2 分钟会发 40 条 `idle-plan`，全是"我闲着"的心跳**
 *   （离线模拟：`{"think": 1, "idle-mode": 40}`）。
 *   噪声会刷满面板/trace，也会把真正的 `need:*` 埋掉。
 *
 * 规则（只在"信息变了"时播报）：
 *   · `nothing`（包括不给结论）→ **不发**，并**清掉记忆**；
 *     不清的话"空闲 → 干活 → 再空闲"时第二次空闲会被当成"和上次一样"而漏播。
 *   · 与上次播报的 `action` **和** `reason` 都相同 → 不发（重复的心跳）。
 *   · 其它 → 发。
 *
 * 为什么记忆用 `action:reason` 而不是只有 `action`：事件 payload 两者都有，
 * 只比 action 会把"两张不同的自己找的单"（`job` + 不同 `need:*`）当成重复吞掉 ——
 * 那是丢信息，不是去噪。`idle-mode` 的 reason 恒为 `'idle-mode'`，照样只播一次。
 *
 * @param {{action?:string, reason?:string}|null} verdict  decideIdle 的结论
 * @param {string|null} lastKey  上一拍播报过的 `action:reason`（没有就 null）
 * @returns {{emit:boolean, next:string|null}}  next = 下一拍该记住的值
 */
export function idlePlanEmission(verdict, lastKey = null) {
    const action = verdict?.action ?? null;
    // 不再空闲：不发，且把记忆清掉（否则下次空闲时会被误判成"重复"）
    if (!action || action === 'nothing') return { emit: false, next: null };
    const key = `${action}:${verdict?.reason ?? ''}`;
    return { emit: key !== lastKey, next: key };
}

// ─── t39：第 1 层「补短板」要的 5 个状态字段 ────────────────────────────────
//
// 背景：`idle_planner.planNeeds()` 要 `inventoryFull / hasBasicTool / nightFalling /
// nearShelter / foodCount` 五个字段，而调度器原来**只传了 availableSkills**
// → `planNeeds()` 恒返回 null → 第 1 层四条分支（store/obtain/shelter/food）全是死的。
//
// ★ 三态原则（这里最容易写错的地方）：**读不到传 null，绝不传 false**。
//   `planNeeds` 用的是严格比较（`hasBasicTool === false`、`nearShelter === false`），
//   把"读不到"写成 false 就会**误触发** —— 明明背包里有钻石镐却被派去 obtain 石镐。
// ★ 每个字段各自 try/catch：一个字段炸了不影响别的，也不许整段吞（D14 的老毛病：
//   落点检查被一整段空 catch 吞掉，加了 20 天一次都没执行过）。

/**
 * 「有基础工具」= 背包里有一把**石镐或更好**的镐（t39）。
 *
 * 为什么不复用 `strat_tool_tier.tierOfItem`：那个是**策略层的档位规划表**
 * （只认 木/石/铁 三档，用来排"先石再铁"的升级顺序），而这里只回答一个是非题
 * "够不够基础工具"。更要紧的是分层：`board` 只能 import query/infra，
 * `board → strat` 是 preflight 会报的新违规。所以这里按物品名直接列全 5 种镐，
 * 只覆盖"石及以上"这一档（木镐不算、石/铁/金/钻石/下界合金算）。
 */
const BASIC_PICKAXES = new Set([
    'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe',
]);

/** 头顶探针："这几格都是空的"才算没有遮蔽（feet+2 起 = 过了她 1.8 的身高）。 */
const SHELTER_PROBE_DY = Object.freeze([2, 3, 4, 5]);
const OPEN_SKY_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

/** 读一个字段；**单字段失败只影响它自己**（返回 null = "读不到"）。 */
function safeField(read) {
    try { return read(); } catch { return null; }
}

/**
 * 头顶有没有盖（nearShelter 的判据，**保守**）。
 *
 * 为什么只判头顶：要求是"不许阻塞调度器"——扫附近要么 `findBlocks`（重查询，禁止），
 * 要么自己写一套盒子判据（第二套真相）。所以这里只回答一个诚实的小问题：
 * **头顶 4 格里有没有非空气方块**。
 *   · 有 → true（洞里、屋里、树冠下，都算"能待着"）
 *   · 4 格全空 → false（露天）
 *   · 任一格读不到 → null（不确定，**不触发** shelter，宁可不动手也不乱搭屋子）
 *
 * 注意这**不是** `query_stand.PASSABLE`（那套判"人能不能站进去"，水算可穿过）；
 * 这里问的是"有没有东西挡在上面"，所以水/草也算盖 —— 保守方向正确。
 */
function readOverheadShelter(bot) {
    const p = bot?.entity?.position;
    if (!p || typeof bot.blockAt !== 'function') return null;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    for (const dy of SHELTER_PROBE_DY) {
        // ★★ 2026-11-04（t73）：**必须传 Vec3，不能传裸对象。**
        //
        //   mineflayer `bot.blockAt(p)` → `world.getBlock(p)` → **`p.floored()`**
        //   （`prismarine-world/src/world.js:229`）—— 裸 `{x,y,z}` 没这个方法 →
        //   `TypeError` → 被外层 `safeField` 吞成 null →
        //   **`nearShelter` 恒 null → idle_planner 的 shelter 分支永不触发**。
        //
        //   fixture 用"严格假件"（`strictPoints` 默认 true，裸坐标必抛）抓出来的：
        //   **当年 t39③ 的绿是假绿** —— 假件比真件宽松，裸对象在假件上不报错。
        //
        //   全仓 `bot.blockAt(` 共 75 处，**只有这一处**传裸对象
        //   （其余都走 `query_perceive.blockAt`，内部已包 Vec3）。
        const b = readBlock(bot, { x: fx, y: fy + dy, z: fz });
        if (!b || !b.name) return null;                     // 没加载 → 不猜
        if (!OPEN_SKY_BLOCKS.has(b.name)) return true;      // 头上有盖
    }
    return false;                                           // 露天
}

/**
 * 现算 idle_planner 第 1 层要的 5 个字段（**全是内存读**：背包 / 时间 / 头顶 4 格）。
 *
 * 每个字段的三态处理见各自注释；任何一个算炸 → 那个字段 null，其余照常。
 *
 * @param {object} agent Agent 实例（用 agent.bot）
 * @returns {{inventoryFull:boolean|null, hasBasicTool:boolean|null,
 *            nightFalling:boolean|null, nearShelter:boolean|null, foodCount:number|null}}
 */
export function readIdleState(agent) {
    const bot = agent?.bot ?? null;

    // 背包物品只读一次，给 hasBasicTool / foodCount 共用（避免一个人读两遍）
    const items = safeField(() => {
        const inv = bot?.inventory;
        if (!inv || typeof inv.items !== 'function') return null;   // 读不到
        return inv.items() ?? null;
    });
    const counts = safeField(() => {
        if (!Array.isArray(items)) return null;
        const m = {};
        for (const it of items) {
            if (!it?.name) continue;
            m[it.name] = (m[it.name] ?? 0) + Number(it.count ?? 0);
        }
        return m;
    });

    return {
        // 「满」= **一格空位都没有**（`emptySlotCount() === 0`）。
        // 留 1 格不算满：还能捡东西，为这个专门跑一趟 store 是白折腾。
        inventoryFull: safeField(() => {
            const inv = bot?.inventory;
            if (!inv || typeof inv.emptySlotCount !== 'function') return null;
            const empty = inv.emptySlotCount();
            return Number.isFinite(empty) ? empty === 0 : null;
        }),

        // 背包里有没有**石镐或更好**（三态：true / false / null=读不到）。
        // 读不到必须 null：planNeeds 判的是 `=== false`，写成 false 就会误派 obtain。
        hasBasicTool: safeField(() => {
            if (!counts) return null;
            for (const [name, n] of Object.entries(counts)) {
                if (n > 0 && BASIC_PICKAXES.has(name)) return true;
            }
            return false;
        }),

        // 复用 strat_first_night.isNightFalling（**不写第二套**）。
        // 时间读不到 → null（falsy，不触发 shelter；和 false 效果一样但语义是"不知道"）。
        nightFalling: safeField(() => {
            const n = Number(bot?.time?.timeOfDay);
            return Number.isFinite(n) ? isNightFalling(n) : null;
        }),

        // 附近有没有能待的地方（保守判据，见 readOverheadShelter）。
        nearShelter: safeField(() => readOverheadShelter(bot)),

        // 背包里的食物总数。数不清（没有 registry.foodsByName）→ null；
        // 空背包 → 0（真的没吃的，该去补）。planNeeds 里 `Number(null ?? 99) = 99` → 不触发，安全。
        foodCount: safeField(() => {
            if (!counts) return null;
            const foods = bot?.registry?.foodsByName;
            if (!foods) return null;
            let n = 0;
            for (const [name, c] of Object.entries(counts)) {
                if (foods[name]) n += Number(c ?? 0);
            }
            return n;
        }),
    };
}

// ───────────────────────────────────────────────────────────────────────────
// 调度器
// ───────────────────────────────────────────────────────────────────────────

/** 领取冲突后的退避（06 §8："退避 5 秒重领"）。 */
export const CLAIM_BACKOFF_MS = 5000;

/** 跑单期间的心跳间隔（06 §6：每 10 秒续租）。 */
export const HEARTBEAT_MS = 10000;

/**
 * ★★★ A5-8（S2，第四轮审计 §6.5「任务租约活着的僵尸单」）：**哪些停止原因仍然允许续租**。
 *
 * 病根（原文）：`setInterval` 心跳**不看**停止标志，只要 `_runJob` 还没走到 finally
 *   就每 10 秒续一次租。而 `_runJob` 卡住的最长来源是 30 分钟的模型调用 / 10 分钟动作超时
 *   ⇒ 面板上单子已经 `paused`，租约仍归自己，**别的 bot 拿不到**，直到进程被杀。
 *
 * 判据只能按 `control.STOP_REASONS` 逐档来（07 §4 那张表就是权威）：
 *   · `brief`    —— 只是被 mode / 即时命令**打断一下**，单还在我手里，租约**必须照常续**；
 *   · `preempt`  —— 让位给别人：自己已经写了 ready + 清租约，**不许再续**；
 *   · `player`   —— `!stop`：单转 paused（可恢复），**不许再续**；
 *   · `timeout`  —— 动作超时：单已按 attempts 处理，**不许再续**；
 *   · `shutdown` —— 进程退出：靠租约过期回收，**不许再续**；
 *   · `death`    —— 死亡：单转 paused，**不许再续**。
 * 换句话说：**只有 brief 允许续租**，别的一律停手。
 */
export const LEASE_RENEWABLE_STOP_REASONS = Object.freeze([STOP_REASONS.BRIEF]);

/**
 * ★ A5-8：**只有这两个状态**代表「这张单现在真的在我手里跑」。
 * 其余（paused / cancelled / ready / blocked / done / failed）都意味着租约不该续：
 *   · paused    —— 玩家按停 / 死亡：可恢复，但**此刻不是我在跑**；
 *   · cancelled —— 取消：终态，租约更不该留着；
 *   · ready / blocked —— 别人或抢占已经把它退回去了；
 *   · done / failed   —— 终态。
 * 用**白名单**而不是黑名单：以后加状态时默认停手（宁可少续一次，也不留僵尸租约）。
 */
export const LEASE_RENEWABLE_JOB_STATES = Object.freeze([JOB_STATE.CLAIMED, JOB_STATE.RUNNING]);

/**
 * 读"这张单为什么暂停"。
 *
 * ★ T31 第6条③：老写法把它当**顶层字段** `job.pausedReason`（但 `jobs` 表根本没有这一列，
 *   所以它**永远是 undefined**）；T31 起 `planStop` 把它写进 `checkpoint`。
 * 两处都读，才叫"同一个真相"。
 */
const pausedReasonOf = (j) => j?.pausedReason ?? j?.checkpoint?.pausedReason ?? null;

export class BoardScheduler {
    /**
     * @param {object} deps
     *   agent         Agent 实例（要 .board / .actions / .bot / .name）
     *   board         任务板客户端（不传则用 agent.board；为 null 时整个调度器空转）
     *   actions       ActionManager（不传则用 agent.actions）
     *   runSkill      (agent, skill, args) => ActionResult（不传则用注册表）
     *   now() / sleep(ms)  时钟与等待（测试注入假时钟用）
     *   onEvent(e)    事件（trace/日志）
     *   heartbeatMs   心跳间隔，默认 10s
     *   backoffMs     领取冲突退避，默认 5s
     */
    constructor(deps = {}) {
        this.agent = deps.agent ?? null;
        this.boardClient = deps.board ?? deps.agent?.board ?? null;
        this.actions = deps.actions ?? deps.agent?.actions ?? null;
        this.runSkillFn = deps.runSkill ?? null;
        this.now = deps.now ?? (() => Date.now());
        this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.onEvent = deps.onEvent ?? (() => { });
        this.heartbeatMs = Number.isFinite(deps.heartbeatMs) ? deps.heartbeatMs : HEARTBEAT_MS;
        this.backoffMs = Number.isFinite(deps.backoffMs) ? deps.backoffMs : CLAIM_BACKOFF_MS;

        /** ③ 自动领单开关：**显式状态**，不靠"当前没单"推断（设计 §4 高危点③）。 */
        this._autoClaim = true;
        /** 上次领取冲突的时间（退避用）。 */
        this._backoffUntil = 0;
        /** 当前正在跑的单 id（诊断/抢占用）。 */
        this.currentJobId = null;
        /** 已处理过的 stale-brief 记录（避免重复扫）。 */
        this._tickCount = 0;
        /**
         * 被抢占的那个单 id（本进程内）。
         *
         * ★ 为什么需要它：真并发抢占演练抓到过一个真 bug ——
         *   `_preempt()` 已经把单记成 `paused(preempted)`，但被打断流程的
         *   `_runJob()` 走到 finally 时又调了一次 `finish(INTERRUPTED)`，
         *   把这个状态**覆盖**掉了（变成 ready/attempts+1）。
         *   即"抢占 → paused"被自己的收尾逻辑抹掉，正是高危点②要防的事。
         *   所以：被抢占的单**只走 setState(paused)**，绝不再走 finish。
         */
        this._preemptedJobId = null;
        /**
         * ★★★ A5-8：**显式停止原因**（null = 没停）。
         *
         * 与 `_autoClaim` 的区别（06 §14 的原话是「正在跑的单接着跑」，那不是停）：
         *   · `setAutoClaim(false)` = 不领新单，**手上这张接着干、照常续租**；
         *   · `stop(reason)`        = 手上有单也停：**不再续租 + 主动放租约与预约**。
         * 原来根本没有这个字段 —— 审计 §6.5 的「活着的僵尸单」就是这么来的。
         */
        this._stopRequested = null;
        /**
         * ★ A5-8：已经被本调度器**主动放掉租约**的单 id（jobId）。
         * 作用有二：① 幂等（同一个定时器/收尾段不重复释放）；② 收尾时**不许再 finish**
         * （租约已经放掉，这时 finish 等于以「非主人」身份写别人的单）。
         */
        this._leaseDropped = new Set();
        /**
         * 上一拍**播报过**的 `idle-plan`（`action:reason`），t38。
         *
         * ★ 为什么需要：`decideIdle()` 每拍都会返回一个结论（空闲时恒为 `idle-mode`），
         *   原来每拍都发一条 `idle-plan` → 3 秒一条"我很闲"，2 分钟 40 条。
         *   记住上一次，重复的不再发；判据见纯函数 `idlePlanEmission()`。
         *   `nothing` 时会清成 null（"不再空闲"要忘掉记忆，否则下次空闲漏播）。
         */
        this._lastIdlePlan = null;
        /**
         * `_lastIdlePlan` 是哪一拍记下的（t38）。
         *
         * ★ 只用来判"连续"：中间去领单/干活时那段代码根本没跑，
         *   记忆会**过期**（`_tickCount` 对不上），这次按"没有记忆"处理 ——
         *   否则"发呆 → 干活 → 再发呆"时第二次发呆会被当成重复而不播报。
         */
        this._lastIdleTick = null;
        /**
         * 第 1 层状态读取器（t39）。默认是本文件的 `readIdleState()`；
         * 可注入只是为了**离线用例能模拟"某个字段没传"**（反向验证）+ 真机诊断。
         */
        this.readIdleState = deps.readIdleState ?? readIdleState;
        /**
         * 可用流程清单的注入点（t39）。生产不给 → 每次从 composite_registry 现取。
         * 为什么留这个口子：`planNeeds()` 会产出 `skill: 'food'`，而注册表里目前**没有**
         * `food` 这个流程（只有 `eat`）→ 食物那条分支到 `have.has('food')` 就断了。
         * 用例要能证明"接线通了"，就得能把 availableSkills 设成含 food 的样子。
         */
        this.availableSkillsOverride = Array.isArray(deps.availableSkills) ? deps.availableSkills : null;
    }

    /** 自动领单开关（③）。关掉≠停止：正在跑的单接着跑。 */
    setAutoClaim(enabled) {
        const next = !!enabled;
        if (next !== this._autoClaim) {
            this.onEvent({ type: next ? 'auto-claim-on' : 'auto-claim-off', at: this.now() });
        }
        this._autoClaim = next;
        return this._autoClaim;
    }

    get autoClaim() { return this._autoClaim; }
    get board() { return this.boardClient; }

    // ── A5-8：显式停止 / 恢复 ─────────────────────────────────────────
    /**
     * ★★★ A5-8：**显式停止**调度器（与 `setAutoClaim(false)` 不是一回事）。
     *
     * 停止之后：
     *   · `tick()` 直接返回 `reason:'stopped'`（既不领新单，也不 resume 自己的 paused 单）；
     *   · 心跳**不再续租**（`_shouldRenewLease` 的第一条判据）；
     *   · 正在跑的单：`_releaseOnStop()` **主动放掉租约与预约**，不再等 30 秒过期。
     *
     * @param {string} reason `control.STOP_REASONS` 之一（默认 `player`）
     * @returns {string} 记下的停止原因
     */
    stop(reason = STOP_REASONS.PLAYER) {
        const next = String(reason ?? STOP_REASONS.PLAYER);
        if (this._stopRequested !== next) {
            this._stopRequested = next;
            this.onEvent({ type: 'scheduler-stopped', reason: next, at: this.now() });
        }
        return this._stopRequested;
    }

    /** ★ A5-8：撤销停止（玩家说「继续」/进程不再退出）。已放掉的租约不会自动拿回。 */
    resume() {
        if (this._stopRequested != null) {
            this._stopRequested = null;
            this.onEvent({ type: 'scheduler-resumed', at: this.now() });
        }
        return null;
    }

    get stopRequested() { return this._stopRequested; }
    get stopped() { return this._stopRequested != null; }

    /**
     * 主循环跑**一遍**（不内部循环 —— "空闲时不空转"）。
     *
     * @returns {Promise<{acted:boolean, reason:string, requeued?:string[]}>}
     */
    async tick() {
        const now = this.now();
        this._tickCount++;

        const board = this.boardClient;
        if (!board) return { acted: false, reason: 'no-board' };

        // ── 空闲维护：brief 超时退回 ready（07 §4）──────────────────────
        //
        // ★ 这个必须**在 autoClaim 判断之前**做，而且开关关着也要做。
        //   理由：`requeueStaleBrief` 是把"已经被打断、悬着没人管"的单捡回 ready，
        //   属于**收拾残局**，不是"领新单"。玩家喊停时更该收拾干净 ——
        //   否则他一说"继续"，那些悬着的 brief 单永远回不来。
        // ★ 收拾残局前也要**先拉一次**。
        //
        //   真机验收抓到的第二个"镜像不一致"缺陷（与抢占那个同类）：
        //   `requeueStaleBrief()` 读的是 `board.list(...)` = **本地镜像**，
        //   而"被别的进程/上一次会话打断、悬着"的单**不在我的镜像里** →
        //   它一辈子也捡不回来。实测：库里造一张 running+过期 interrupted 的单，
        //   调度器连续 tick 20 秒都没动它。
        //   （这也说明 B2 的"镜像要靠自己 refresh"这条必须在**每个读板的地方**都记得做，
        //     不能只在抢占那一处补。）
        // ★ scope:'claimable' —— 残局回收要看到**别人/上次会话**悬着的单（共享单 assignee=null）。
        //   只 refresh({})（scope 默认 'mine'）会服务端过滤成 `assignee=我自己` → 那种单永远看不到。
        try { await this.boardClient?.refresh?.({ scope: 'claimable' }); } catch { /* 拉不到就按旧镜像判 */ }

        let requeued = [];
        try {
            requeued = requeueStaleBrief({
                board,
                now,
                isStillRunning: (job) => job?.id === this.currentJobId && this.actions?.executing === true,
            }) ?? [];
            if (requeued.length) this.onEvent({ type: 'brief-requeued', ids: requeued, at: now });
        } catch (e) {
            this.onEvent({ type: 'brief-requeue-error', error: String(e?.message ?? e) });
        }

        // ── ③ 开关关着：不领新单、不抢占；正在跑的单接着跑 ──────────────
        if (!this._autoClaim) {
            return { acted: false, reason: 'auto-claim-off', requeued };
        }

        // ── ★ A5-8：调度器被**显式停止**（玩家按停 / 进程退出 / 死亡）──────
        //   和上面那条不同：`autoClaim` 关掉只是"不领新单"，**手上这张照跑**；
        //   这里是真的停手 —— 既然停手，就绝不能再领新单，也不能把自己的 paused 单
        //   resume 回 ready（那会让"停止"只生效一拍，正是 T31 第6条③ 那个症状）。
        if (this._stopRequested != null) {
            return { acted: false, reason: 'stopped', requeued };
        }

        // ── A) 手上正有动作在跑 → 看要不要抢占 ──────────────────────────
        if (this.actions?.executing) {
            // ★ 抢占前必须**主动拉一次** ready 单的最新快照。
            //
            //   真机验收抓到的缺陷（2026-11-02）：`board_client` 的本地镜像只会因
            //   "自己发起的操作" 和 `board:changed`（它只更新**已知**的单）而变；
            //   **别人新加的单它根本不知道**。于是 `_findPreemptor()` 在镜像里翻不到
            //   那张 9 级单 → 抢占永远不触发（实测：9 级单一直停在 `可领`）。
            //   这和 B1 那个 `board:get` payload 形状 bug 是同一类"镜像/真相不一致"。
            // ★ scope:'claimable' —— 抢占目标通常是**共享单**（assignee=null）或别人的 9 级单；
            //   只 refresh({})（默认 scope='mine'）服务端会 `assignee=我自己` 一过滤 → 看不到 → 抢占永不触发。
            try { await this.boardClient?.refresh?.({ scope: 'claimable' }); } catch { /* 拉不到就按旧镜像判 */ }
            const preemptor = await this._findPreemptor();
            if (!preemptor) return { acted: false, reason: 'busy', requeued };
            const done = await this._preempt(preemptor);
            return { acted: done, reason: done ? 'preempted' : 'preempt-failed', requeued };
        }

        // ── B) 空闲 ────────────────────────────────────────────────────
        // 退避中就别急着重领（06 §8："冲突则退避 5 秒"）
        if (now < this._backoffUntil) {
            return { acted: false, reason: 'backoff', requeued };
        }

        // step 1：先续做自己的 paused 单
        const resumed = await this._resumeOwnPaused(now);
        if (resumed) return { acted: true, reason: 'resumed', requeued };

        // step 2：领新单
        const claimed = await this._claimNext();
        if (!claimed) {
            // ★ M9（08 §6.1）：**真的空闲**（没单可领、没反射、30 秒没人说话）时
            //   才让 idle_planner 自己找事做。它自己找的单 source='self'、优先级 ≤2，
            //   玩家一下命令就让路。
            try {
                const { idleTick } = await import('./idle_planner.js');
                // ★ 必须把"现在有哪些流程可用"传进去，否则 idle_planner 第 1 层
                //   永远看到空集合 → "天黑没地方待→shelter" 那条分支永远不走（死分支）。
                //   这里从注册表实时取（加流程时自动生效，不用改两处）。
                //   `deps.availableSkills` 只是**测试/诊断的注入口**，生产不给就走注册表。
                let availableSkills = this.availableSkillsOverride ?? [];
                if (!this.availableSkillsOverride) {
                    try {
                        const reg = await import('./composite_registry.js');
                        availableSkills = reg.SKILL_NAMES ?? [];
                    } catch { /* 取不到就当没有（第 1 层会跳过，退回第 2/3 层） */ }
                }
                // ★ t39：第 1 层要的 5 个状态字段，现算现传（每个字段各自容错，见 readIdleState）
                const idleState = this.readIdleState(this.agent);
                const verdict = await idleTick(this.agent, {
                    now,
                    // ★ t39：第 1 层「补短板」的 5 个状态字段原来**一个都没传**
                    //   （只有 availableSkills）→ `planNeeds()` 恒返回 null → 第 1 层是**死分支**
                    //   （4 条 store / obtain / shelter / food 一条都不会走）。
                    //   死因和之前 availableSkills 那个 bug 同一类：**传参漏了 → 分支永不走**。
                    //   现在由 readIdleState() 现算现传；每个字段各自容错，读不到传 null（三态）。
                    state: { availableSkills, ...idleState },
                    jobsBusy: () => (this.boardClient?.list?.({ states: [JOB_STATE.READY, JOB_STATE.CLAIMED, JOB_STATE.RUNNING] }) ?? []).length > 0,
                    reflectionBusy: () => !!this.actions?.executing,
                    enqueue: async (job) => {
                        await this.boardClient?.add?.({ ...job, kind: 'personal', assignee: this.agent?.name ?? null });
                    },
                });
                // ★ t38：只在"结论变了"时播报。idle_planner 每拍都会返回一个结论
                //   （空闲时恒为 idle-mode），无条件发就是 3 秒一条"我很闲"的心跳。
                //   判据是纯函数 idlePlanEmission()，用例锁在 board_scheduler_unit。
                //
                // ★ 记忆只在**连续两拍都在判空闲**时才算数：中间去领单/干活（根本没走到
                //   这段）时，`this._lastIdleTick` 就停在老值 → 这次拿 null 当记忆 →
                //   "干活回来第一次空闲"照样播报。不这么判的话，干完活回来那条会被
                //   上一次发呆的记忆吞掉（那是丢信息，不是去噪）。
                const lastKey = this._lastIdleTick === this._tickCount - 1 ? this._lastIdlePlan : null;
                const emission = idlePlanEmission(verdict, lastKey);
                this._lastIdlePlan = emission.next;
                this._lastIdleTick = this._tickCount;
                if (emission.emit) this.onEvent({ type: 'idle-plan', action: verdict.action, reason: verdict.reason });
            } catch { /* 空闲规划失败不影响调度 */ }
            return { acted: false, reason: 'idle', requeued };
        }

        // step 3–5：reserve → 跑 → finish/release
        const ran = await this._runJob(claimed, now);
        return { acted: ran, reason: ran ? 'ran' : 'run-failed', requeued };
    }

    // ── step 1：resume 自己的 paused 单 ────────────────────────────────
    async _resumeOwnPaused(now) {
        const board = this.boardClient;
        let mine = [];
        try {
            mine = board.list?.({ states: [JOB_STATE.PAUSED] }) ?? [];
        } catch { return false; }
        // 只捡"我自己的、且不是玩家按停的"（玩家停的要等他说继续）
        const candidate = mine.find((j) => j
            && (j.assignee == null || j.assignee === this.agent?.name)
            // ★★★ T31 第6条③：`pausedReason` 的**写**在 `checkpoint` 里
            //   （control.planStop 的 PLAYER 分支），这里必须两处都读 ——
            //   否则"写了也读不到"，玩家按停的单还是会被自动 resume。
            && pausedReasonOf(j) !== 'player');
        if (!candidate) return false;
        try {
            const r = await board.setState?.(candidate.id, JOB_STATE.READY, 'resume');
            if (!r?.ok) return false;
            this.onEvent({ type: 'job-resumed', id: candidate.id, at: now });
            return true;
        } catch { return false; }
    }

    // ── step 2：领单 ──────────────────────────────────────────────────
    async _claimNext() {
        const board = this.boardClient;
        try {
            // ★★★ BOARD-002：把**现读的真实背包**随领单请求报上去。
            //   原来这里只 `board.claim()`（客户端只发 bot 名字），服务端 `meetsRequires`
            //   面对"需要 stone_pickaxe"的单先按空背包拒绝 ⇒ 物品资格任务永远领不出来，
            //   而下面那次真实背包复核（job-skipped-requires）根本没机会执行。
            const r = await board.claim?.(this._who());
            if (!r?.ok || !r.data?.job) return null;
            const job = r.data.job;
            // requires 过滤：不合格就退回 ready，别占着
            if (!meetsRequires(job, this._who())) {
                try { await board.setState?.(job.id, JOB_STATE.READY, 'requires-unmet'); } catch { /* ignore */ }
                this.onEvent({ type: 'job-skipped-requires', id: job.id });
                return null;
            }
            this.onEvent({ type: 'job-claimed', id: job.id, skill: job.skill, priority: job.priority });
            return job;
        } catch (e) {
            this.onEvent({ type: 'claim-error', error: String(e?.message ?? e) });
            return null;
        }
    }

    /** 我的能力（requires 过滤用）。 */
    _who() {
        const items = (this.agent?.bot?.inventory?.items?.() ?? []).map((i) => i?.name).filter(Boolean);
        return { roles: this.agent?.roles ?? [], items };
    }

    // ── step 3：预约（冲突 → 全部释放 + 退避）────────────────────────
    async _reserveClaims(job, ctx) {
        // ★ B3：单里显式给了 claims 就用；没给就按 args **推导**（能推就推、推不出不猜）。
        //   这样采集/挖掘/存取这类单不用每个流程手写预约。
        const keys = deriveClaims(job);
        if (!keys.length) return { ok: true, reserved: [] };
        const reserved = [];
        for (const key of keys) {
            let r;
            try { r = await ctx.reserve(key); } catch (e) { r = { ok: false, code: 'INTERNAL', message: String(e?.message ?? e) }; }
            if (!r?.ok) {
                // 冲突：**把已经占到的全部放掉**（否则别的 bot 永远拿不到，死锁）
                for (const got of reserved) {
                    try { await ctx.release(got); } catch { /* ignore */ }
                }
                this.onEvent({ type: 'reserve-conflict', id: job.id, key, code: r?.code, conflicts: r?.data?.conflicts });
                // ★ 06 §9.2：冲突返回 CLAIM_CONFLICT，**流程按 onFail 换目标**。
                //   调度器这里不重试同一张单（换目标该由流程决定），而是把单退回 ready 让别人试。
                return { ok: false, code: r?.code ?? 'CLAIM_CONFLICT', conflicts: r?.data?.conflicts ?? [], reserved: [] };
            }
            reserved.push(key);
        }
        this.onEvent({ type: 'reserved', id: job.id, keys: reserved });
        return { ok: true, reserved };
    }

    // ── step 4+5：跑单、心跳、finish、release ─────────────────────────
    async _runJob(job, now) {
        const board = this.boardClient;
        // ★ 必须把板**塞进传给 makeCtx 的 agent** 上。
        //
        //   真机验收抓到的第 3 个"两处各叫一个名字"缺陷（前两个：makeCtx 读 boardClient、
        //   agent.js 存 board；interrupted 字段）。这里的情况是：调度器自己持有 `this.boardClient`，
        //   而 `makeCtx(agent, ...)` 是去 `agent.boardClient ?? agent.board` 找板的 ——
        //   调用方传进来的 agent 对象**没有 .board/.boardClient** →
        //   `ctx.reserve()` 静默走了 no-board 分支（恒成功 no-op）→
        //   **预约从来没真正写过库**（真机实测：jobs 全 done、合计 85，但 claims 表 0 行）。
        //   修法：用一份"带板的 agent 视图"构造 ctx，不改调用方的对象。
        // ★★★ T31 第6条①：这个视图除了补板，**还必须补 `actions`**。
        //   `control.runJobAction(agent, ...)` 读的是 `agent.actions`，
        //   而调度器把 ActionManager 存在自己的 `this.actions` 上 ——
        //   生产里两者是同一个对象（agent.js 构造后同时挂两处），
        //   但离线用例里未必，一不一致的表现就是 `runAction` 不存在 → 每张单 run-failed。
        //   这已经是本文件记录的**第三次**"两处各叫一个名字"（前两次：board、interrupted）。
        const agentView = {
            ...this.agent,
            ...(this.boardClient ? { board: this.boardClient, boardClient: this.boardClient } : {}),
            actions: this.actions ?? this.agent?.actions ?? null,
        };
        const ctx = makeCtx(agentView, job, getSkill(job.skill)?.manifest ?? null);

        // step 3
        const res = await this._reserveClaims(job, ctx);
        if (!res.ok) {
            // 冲突 → 退回 ready 并退避（06 §8）
            try { await board.setState?.(job.id, JOB_STATE.READY, 'claim-conflict'); } catch { /* ignore */ }
            this._backoffUntil = now + this.backoffMs;
            return false;
        }

        const reserved = res.reserved;
        this.currentJobId = job.id;
        const startedAt = now;
        let result = null;

        // 每 10 秒 heartbeat（06 §6/§8）。用真实定时器包住，但结束一定 clear。
        //
        // ★★★ A5-8（S2，第四轮审计 §6.5）：**心跳必须先看"还该不该续租"。**
        //
        //   病根：原来这里无条件 `board.heartbeat(job.id)` —— 只要 `_runJob` 还没走到
        //   finally，被 `paused`（玩家 !stop / 死亡）或者被取消的单**照样每 10 秒续租**。
        //   而 `_runJob` 卡住的最长来源正是 30 分钟的模型调用 / 10 分钟动作超时
        //   ⇒ 面板上单子已是 paused，租约仍归自己，**别的 bot 一直到进程被杀都拿不到这张单**。
        //
        //   现在分三步：
        //     ① `_shouldRenewLease()` 本地判据（显式停止 / 停止原因 / 本地镜像状态）；
        //     ② `_authoritativeStopKind()` 向服务端复核一次（镜像只在自己发起操作或
        //        `board:changed` 时更新 —— "别人把这张单暂停了"它看不到，这正是要害）；
        //     ③ 一旦判定不该续租 → `_stopHeartbeat()` + `_releaseOnStop()`：
        //        **主动放掉租约与预约**，并区分「暂停（可恢复，单留在 paused）」与
        //        「取消（终态，释放给谁都不该再跑）」。
        let hbStopped = false;
        const stopHeartbeat = () => {
            if (hbStopped) return;
            hbStopped = true;
            try { clearInterval(hb); } catch { /* ignore */ }
        };
        const startedStopReason = this.actions?.stop_reason ?? this.actions?.stopReason ?? null;
        const hb = setInterval(() => {
            if (hbStopped) return;
            void (async () => {
                try {
                    // ① 本地判据
                    if (!this._shouldRenewLease(job, startedStopReason)) {
                        stopHeartbeat();
                        const kind = await this._stopKindOf(job.id);
                        await this._releaseOnStop(job, ctx, reserved, kind);
                        return;
                    }
                    // ② 服务端复核（最坏多一个 RPC / 10 秒；换掉的是"僵尸租约"）
                    const kind = await this._authoritativeStopKind(job.id);
                    if (kind) {
                        stopHeartbeat();
                        await this._releaseOnStop(job, ctx, reserved, kind);
                        return;
                    }
                    // ③ 正常续租
                    const progress = this._progressOf();
                    const r = await board.heartbeat?.(job.id, progress);
                    // LEASE_LOST：别人已经接手，立刻停手（06 §6）
                    if (r && r.ok === false && r.code === 'LEASE_LOST') {
                        this.onEvent({ type: 'lease-lost', id: job.id });
                        stopHeartbeat();
                        this._leaseDropped.add(job.id);
                        this.actions?.stop?.(STOP_REASONS.PREEMPT);
                        return;
                    }
                    // 服务端回传的状态已经不是"我在跑"（例如别人把它 paused 了）→ 下一拍起停租
                    const st = r?.data?.job?.state ?? null;
                    if (st && !LEASE_RENEWABLE_JOB_STATES.includes(st)) {
                        this.onEvent({ type: 'lease-renew-server-state', id: job.id, state: st });
                        stopHeartbeat();
                        const kind2 = await this._stopKindOf(job.id, st);
                        await this._releaseOnStop(job, ctx, reserved, kind2);
                    }
                } catch { /* 心跳失败不该弄垮调度 */ }
            })();
        }, this.heartbeatMs);
        try { hb.unref?.(); } catch { /* ignore */ }

        try {
            const runner = this.runSkillFn ?? defaultRunSkill;
            // ★★ 2026-11-03（t63）：**必须把 `job` 传下去** ——
            //   否则 `runSkill` 里 `makeCtx(agent, null, ...)` → `ctx.jobId` 恒 null，
            //   `strat_obtain` 判不出"我正被哪张单执行" → 每次都多建一张壳 →
            //   外层那张永远 0 子单 → 被当叶子单重试到 blocked（真机第 8 跑的止损点）。
            // ★★★ T31 第6条①：**必须走 `actions.runAction`（= control.runJobAction）。**
            //
            //   原来这里是直接 `await runner(...)` —— 于是 `actions.executing` **全程 false**，
            //   而玩家 `!stop` 那条链路是 `action_manager.stop()`，第一步就是
            //   `if (!this.executing) return;` → **一次 requestInterrupt() 都不发**。
            //   现场症状正是本条标题：按 `!stop` 对板上的单**完全无效**。
            //
            //   `control.runJobAction` 是全仓**零调用方**的现成实现，它负责四件事：
            //     label = `job:<skill>`（`resolveJob` 靠它把"被打断的是谁"认出来）、
            //     把 `actions.currentJobId` 指向这张单、按 deadline 换算 timeout、
            //     并且**经由 `actions.runAction` 驱动** → `executing` 真的置位 → 中断链路才通。
            //
            //   ★★ 一个必须绕开的陷阱：`runJobAction` 内部是
            //      `runAction(label, async () => { await fn(); })` —— **它把 fn 的返回值扔了**，
            //      只回传 ActionManager 的 `{success, message, interrupted, timedout}`。
            //      而 `finish()` 要的是 `{ok, code, message, data}`。
            //      所以用闭包把内层结果**捞出来**；否则 `result.ok` 恒 undefined
            //      → 每张单都被判失败重试（那是比原 bug 更严重的新 bug）。
            let inner = null;
            await runJobAction(agentView, job, async () => {
                inner = await runner(this.agent, job.skill, argsToString(job.args), job);
            });
            result = inner ?? { ok: false, code: 'INTERNAL', message: '流程没有返回结果' };
            return true;
        } catch (e) {
            result = { ok: false, code: 'INTERNAL', message: String(e?.message ?? e) };
            return false;
        } finally {
            try { clearInterval(hb); } catch { /* ignore */ }
            this.currentJobId = null;

            // ★ 被抢占的单：**不许 finish**（否则会把 paused 覆盖成 ready/attempts+1）
            const wasPreempted = this._preemptedJobId === job.id;
            if (wasPreempted) {
                this._preemptedJobId = null;
                this.onEvent({ type: 'skip-finish-preempted', id: job.id });
            }

            // ★★★ T31 第6条①的收尾：**玩家按停（paused）的单不许再被 finish 覆盖。**
            //
            //   `applyStop()` 已经把它写成权威状态：paused + result.INTERRUPTED +
            //   checkpoint.pausedReason='player'。而 `finish(INTERRUPTED)` 按 store 的
            //   规则②（INTERRUPTED 不计 attempts）会把状态**推回 ready** ——
            //   玩家按停只生效一瞬间，然后单子又回到队列里。
            //   这跟 `_preemptedJobId` 是同一个道理的第二次出现：**who 写的状态更权威**。
            const pausedByPlayer = await this._jobPausedByPlayer(job.id);

            // ★ A5-8：租约已经主动放掉的单**一律不许 finish** ——
            //   放租约就是"我不管这张单了"，这时再 finish 等于以非主人身份写别人的单
            //   （store 会回 LEASE_STALE，即便侥幸写进去也是把新主人的进度洗掉）。
            const leaseReleased = this._leaseDropped.delete(job.id);
            if (leaseReleased) {
                this.onEvent({ type: 'skip-finish-lease-released', id: job.id });
            }

            // step 5：finish（store 按规则决定 done/ready/blocked/failed）
            if (pausedByPlayer) {
                this.onEvent({ type: 'skip-finish-paused', id: job.id, reason: STOP_REASONS.PLAYER });
            }
            // ★ A5-8：权威状态已经是 paused / cancelled / 别人拿走了 → 同样不许 finish。
            const stopKindAtEnd = await this._authoritativeStopKind(job.id);
            if (stopKindAtEnd) {
                this.onEvent({ type: 'skip-finish-stopped', id: job.id, kind: stopKindAtEnd });
            }
            if (!wasPreempted && !pausedByPlayer && !leaseReleased && !stopKindAtEnd) try {
                await board.finish?.(job.id, {
                    ok: result?.ok === true,
                    code: result?.code ?? 'OK',
                    message: result?.message ?? '',
                    progress: this._progressOf(result),
                    // ★★★ 2026-11-04（t109）：**`data` 必须一起传 —— 这是今晚第 7 次"中间层重新组装"。**
                    //
                    //   真机实证（第 42 跑，`craft oak_planks c=3` 那条）：
                    //     `act_craft:165` 明明带了 `{invBefore, invAfter, limit, matCounts}`
                    //     但库里 `result.data` 是 **`null`**。
                    //   原因：**这里重新组装了一个对象**，只挑 4 个字段 → `result.data` 被丢掉。
                    //
                    //   今天为这个 `data` 我改过 4 次（t89 `act_craft` 加 diag、t92/t95 `flow_craft`
                    //   两处转发、t105 `board_store.finish` 存 data），**每次都是"看起来最像"的那层**。
                    //   而真正的链路是四跳：
                    //     act_craft.data → flow_craft（转发）→ **scheduler（这里，丢了）**
                    //     → board_client → board_server → board_store.finish（存）
                    //   **只修中间任一层都没用，必须四跳全对。**
                    data: result?.data ?? null,
                });
                this.onEvent({ type: 'job-finished', id: job.id, code: result?.code ?? 'OK', costMs: this.now() - startedAt });
            } catch (e) {
                this.onEvent({ type: 'finish-error', id: job.id, error: String(e?.message ?? e) });
            }

            // step 5：release 预约（放在 finally：失败/被抢占也必须放，否则别人永远拿不到）
            for (const key of reserved) {
                try { await ctx.release(key); } catch { /* ignore */ }
            }
            // ★ T6：**执行期补占**的预约（`ctx.reserveNow` 占了真实箱子/炉子/工作台）
            //   不在这份 `reserved` 里（那是 `deriveClaims` 推出来的），必须单独放 ——
            //   否则只能等 TTL 30 秒自然过期，这 30 秒里别人一直拿不到那个目标。
            try { await ctx.releaseRuntimeClaims?.(); } catch { /* ignore */ }
        }
    }

    /**
     * 这张单现在是不是"被玩家按停"的（**读服务端权威状态**，不看本地镜像 ——
     * 镜像只会在自己发起操作或 board:changed 时更新，这里恰恰是"别人改的"）。
     */
    async _jobPausedByPlayer(id) {
        if (id == null) return false;
        // 快路：本地刚记下的停止原因（action_manager.stop 会写 stop_reason）
        const lastStop = this.actions?.stop_reason ?? this.actions?.stopReason ?? null;
        if (lastStop === STOP_REASONS.PLAYER) return true;
        try {
            const r = await this.boardClient?.getAsync?.(id);
            const j = r?.data?.job ?? this.boardClient?.get?.(id) ?? null;
            if (!j || j.state !== JOB_STATE.PAUSED) return false;
            return pausedReasonOf(j) === 'player';
        } catch { return false; }
    }

    // ── A5-8：续租守卫 / 主动释放（心跳与收尾共用同一套判据）────────────

    /**
     * ★★★ A5-8：**这一拍还该不该续租**（本地判据，同步、不花 RPC）。
     *
     * 三个判据，任一命中就停手：
     *   ① 调度器被**显式停止**（`stop(reason)`）；
     *   ② 代理层的**停止原因**不是 `brief` —— 07 §4 的表里只有 brief 是"打断一下接着做"，
     *      其余（player/preempt/timeout/shutdown/death）都意味着"这张单不再由我续租"。
     *      ★ 只认**本次跑单开始之后变化过**的原因：`stop_reason` 是动作层的全局字段，
     *      上一次动作留下的旧值不能拿来判新单（否则"上一张被玩家停了"会把下一张也停租）。
     *   ③ 本地镜像里这张单**已经不是 claimed/running**（paused / cancelled / ready / 终态）。
     */
    _shouldRenewLease(job, startedStopReason = null) {
        if (!job?.id) return false;
        if (this._stopRequested != null) return false;
        if (this._leaseDropped.has(job.id)) return false;
        const nowStop = this.actions?.stop_reason ?? this.actions?.stopReason ?? null;
        if (nowStop && nowStop !== startedStopReason
            && !LEASE_RENEWABLE_STOP_REASONS.includes(nowStop)) return false;
        const local = this._localJob(job.id);
        const state = local?.state ?? null;
        if (state && !LEASE_RENEWABLE_JOB_STATES.includes(state)) return false;
        return true;
    }

    /** 本地镜像里的这张单（取不到返回 null —— 不猜）。 */
    _localJob(id) {
        try { return this.boardClient?.get?.(id) ?? null; } catch { return null; }
    }

    /**
     * ★ A5-8：**向服务端复核**这张单还归不归我续租。
     *
     * 为什么必须打这一枪：本地镜像只会因"自己发起的操作"和 `board:changed` 更新，
     * 而"**别人**（另一路进程/面板）把这张单暂停或取消了"它一概不知道 ——
     * 那正是僵尸租约的现场。每 10 秒一次小 RPC 换掉一个死锁，值得。
     *
     * @returns {Promise<'paused'|'cancelled'|'lost'|null>}
     *   'paused'    暂停（可恢复）：停租 + 放预约，**单保持 paused 等玩家说继续**
     *   'cancelled' 取消（终态）：停租 + 放预约，**不再碰这张单**
     *   'lost'      已经不在我手上（ready/blocked/done/failed/别人领走）：停手
     *   null        仍归我续租（或读不到 —— 读不到时按"仍归我"处理，别自己把自己吓停）
     */
    async _authoritativeStopKind(id) {
        if (id == null) return null;
        let job = null;
        try {
            const r = await this.boardClient?.getAsync?.(id);
            if (r && r.ok === false) return null;                     // 读失败 ≠ 停手
            job = r?.data?.job ?? this._localJob(id);
        } catch { return null; }
        if (!job) return null;
        return this._stopKindFromState(job.state);
    }

    /**
     * 状态 → 停止类别（纯判据，心跳与收尾共用）。
     *
     * ★ 这里用**字面量** `'paused'` / `'cancelled'`，不用 `JOB_STATE.CANCELLED`：
     *   本文件 import 的 `JOB_STATE` 来自 `control.js`，那张表只有
     *   ready/claimed/running/paused/failed 五个（cancelled/blocked/done 在
     *   `board_store.JOB_STATE` 全表里）—— 写 `JOB_STATE.CANCELLED` 得到的是
     *   **undefined**，于是 `cancelled` 会被误判成 `'lost'`（连租约都不摘）。已踩过。
     */
    _stopKindFromState(state) {
        if (!state) return null;
        if (LEASE_RENEWABLE_JOB_STATES.includes(state)) return null;
        if (state === JOB_STATE.PAUSED || state === 'paused') return 'paused';
        if (state === 'cancelled') return 'cancelled';
        return 'lost';
    }

    /** 本地判据下的停止类别（`stateHint` 来自服务端刚回的那张单）。 */
    _stopKindOf(id, stateHint = null) {
        if (this._stopRequested != null) return 'lost';
        const state = stateHint ?? this._localJob(id)?.state ?? null;
        return this._stopKindFromState(state) ?? 'lost';
    }

    /**
     * ★★★ A5-8：**停手收尾** —— 主动放掉租约与预约，不等 30 秒过期。
     *
     * 区分两种停（审计要求的「暂停（可恢复）」与「取消（释放）」）：
     *   · `paused`    —— 单**留在 paused**：玩家说"继续"就能接着做（`_resumeOwnPaused`）；
     *                    这里只把**租约**摘掉（`lease_owner/lease_until = NULL`），
     *                    于是别的 bot 不会以为它还有主，而单本身不被判失败/重试。
     *   · `cancelled` —— 终态：同样摘租约 + 放预约，之后一次都不再碰。
     *   · `lost`      —— 已经不是我的单：只放预约，**绝不再写库**（避免把新主人的东西洗掉）。
     *
     * 幂等：同一张单只做一次（`_leaseDropped`）。重复调用直接返回。
     */
    async _releaseOnStop(job, ctx = null, reserved = [], kind = 'paused') {
        const id = job?.id;
        if (id == null) return false;
        if (this._leaseDropped.has(id)) return false;
        this._leaseDropped.add(id);
        this.onEvent({ type: 'lease-renew-stop', id, kind });

        // ① 租约：主动摘掉（paused/cancelled 才写；lost 时库里的主人已经不是我了）
        if (kind !== 'lost') {
            try {
                // ★ 用 `update` 而不是 `setState`：`setState(paused)` 在已经 paused 的
                //   单上是**非法转移**（TRANSITIONS.paused 里没有 paused），会失败；
                //   而 `lease_owner/lease_until` 在 store 的 PATCHABLE 白名单里，正好只动租约。
                await this.boardClient?.update?.(id, { lease_owner: null, lease_until: null });
            } catch { /* 放不掉也别把调度弄崩，租约最终会过期 */ }
        }
        // ② 预约：不放就是死锁（别人永远拿不到这些资源）
        for (const key of reserved ?? []) {
            try { await ctx?.release?.(key); } catch { /* ignore */ }
        }
        return true;
    }

    /** 从最近一次流程结果里取进度（卡片口径：{count, want}）。 */
    _progressOf(result = null) {
        const d = result?.data ?? null;
        if (d && Number.isFinite(d.count)) {
            return { count: Number(d.count), want: Number.isFinite(d.want) ? Number(d.want) : null };
        }
        return null;
    }

    // ── 抢占 ──────────────────────────────────────────────────────────
    /**
     * 找一个"该抢我这单"的候选（06 §7）。
     * @returns {object|null}
     */
    async _findPreemptor() {
        const runningPrio = Number(this.agent?.actions?.currentPriority ?? this._runningPriority() ?? -1);
        if (!Number.isFinite(runningPrio) || runningPrio < 0) return null;
        let ready = [];
        try {
            ready = this.boardClient?.list?.({ states: [JOB_STATE.READY] }) ?? [];
        } catch { return null; }
        const eligible = ready.filter((j) => preempts(Number(j?.priority), runningPrio)
            && meetsRequires(j, this._who()));
        return pickBest(eligible, this.agent?.bot?.entity?.position ?? null);
    }

    /** 正在跑的那张单的优先级（从本地镜像取；取不到就当最低）。 */
    _runningPriority() {
        const id = this.currentJobId ?? this.actions?.currentJobId ?? null;
        if (!id) return null;
        try { return Number(this.boardClient?.get?.(id)?.priority ?? null); } catch { return null; }
    }

    /**
     * 执行抢占：让位 → 记 paused(preempted) → 立刻去领新单。
     *
     * ★ 高危点①：`stop()` 之后**必须**先看 `actions.killed`。
     *   已 killed = 旧流程还没停（停不下来，要重启进程）→ **绝不开新动作**，
     *   否则就是"两个流程同时驱动身体"（D18 之前那个 bug）。
     *
     * @returns {Promise<boolean>} 是否真的抢到了（新单已开跑）
     */
    async _preempt(preemptor) {
        const stopReason = STOP_REASONS.PREEMPT;
        this.onEvent({ type: 'preempt-start', id: preemptor.id, priority: preemptor.priority });

        // ★★ 顺序很重要（真并发演练抓到的竞态）：
        //   `stop()` 会**等**被打断的流程退出，而流程退出的瞬间就是它的 `_runJob` finally
        //   ── 那个 finally 会调 finish() 把状态覆盖成 ready。
        //   所以"这个单是被抢占的"必须**在 stop() 之前**就登记好，
        //   否则等 stop() 返回时，finish 已经把 paused 抹掉了。
        const interruptedId = this.currentJobId ?? this.actions?.currentJobId ?? null;
        if (interruptedId) this._preemptedJobId = interruptedId;

        try { await this.actions?.stop?.(stopReason); } catch (e) {
            this.onEvent({ type: 'preempt-stop-error', error: String(e?.message ?? e) });
        }

        // ① 旧流程没停下来 → 不许开新动作（D18）
        if (this.actions?.killed) {
            this.onEvent({ type: 'preempt-aborted-killed', id: preemptor.id });
            return false;
        }

        // ② 被打断的单记 paused(preempted)：**不是失败**，attempts 不动
        if (interruptedId) {
            try {
                await this.boardClient?.setState?.(interruptedId, JOB_STATE.PAUSED, 'preempted');
                this.onEvent({ type: 'job-paused-preempted', id: interruptedId });
            } catch { /* ignore */ }
        }

        // 领新单并开跑
        const claimed = await this._claimNext();
        if (!claimed) return false;
        await this._runJob(claimed, this.now());
        return true;
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 默认实现
// ───────────────────────────────────────────────────────────────────────────

/** 默认用注册表的 runSkill（测试会注入假的）。 */
async function defaultRunSkill(agent, skill, argString, job = null) {
    const reg = await import('./composite_registry.js');
    // ★ t63：`job` 透传给 runSkill（→ makeCtx → ctx.jobId）
    return reg.runSkill(agent, skill, argString, job);
}

/** `{count:4}` → `'count=4'`（注册表 runSkill 收 key=value 串）。 */
export function argsToString(args) {
    if (args == null) return '';
    if (typeof args === 'string') return args;
    if (typeof args !== 'object') return '';
    return Object.entries(args)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
        .join(' ');
}
