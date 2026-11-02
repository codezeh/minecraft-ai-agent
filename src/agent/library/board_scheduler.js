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

import { JOB_STATE, jobsBusy, requeueStaleBrief, STOP_REASONS } from './control.js';
import { deriveClaims } from './board_claims.js';
import { makeCtx } from './composite_registry.js';
import { getSkill } from './composite_registry.js';
import { jobDeadlineTimeoutMinutes } from './control.js';
// ★ 2026-11-02 t25：`meetsRequires` **只允许有一份实现**，真身在 board_store.js。
//   这个文件原来自己又写了一份（且行为与 store 那份相反）—— 典型"两处各叫一个名字"：
//   claimFor 用的是 store 那份（真正决定能不能领），而这里的抢占/领单判定用的是本地这份，
//   于是"没配角色的 bot 能不能领"取决于你走哪条路。已改成 import，删掉本地副本。
import { meetsRequires } from './board_store.js';

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

// ───────────────────────────────────────────────────────────────────────────
// 调度器
// ───────────────────────────────────────────────────────────────────────────

/** 领取冲突后的退避（06 §8："退避 5 秒重领"）。 */
export const CLAIM_BACKOFF_MS = 5000;

/** 跑单期间的心跳间隔（06 §6：每 10 秒续租）。 */
export const HEARTBEAT_MS = 10000;

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
        if (!claimed) return { acted: false, reason: 'idle', requeued };

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
            && j.pausedReason !== 'player');
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
            const r = await board.claim?.();
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
        const agentView = this.boardClient
            ? { ...this.agent, board: this.boardClient, boardClient: this.boardClient }
            : this.agent;
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
        const hb = setInterval(() => {
            try {
                const progress = this._progressOf();
                board.heartbeat?.(job.id, progress)?.then?.((r) => {
                    // LEASE_LOST：别人已经接手，立刻停手（06 §6）
                    if (r && r.ok === false && r.code === 'LEASE_LOST') {
                        this.onEvent({ type: 'lease-lost', id: job.id });
                        this.actions?.stop?.(STOP_REASONS.PREEMPT);
                    }
                })?.catch?.(() => { });
            } catch { /* 心跳失败不该弄垮调度 */ }
        }, this.heartbeatMs);
        try { hb.unref?.(); } catch { /* ignore */ }

        try {
            const runner = this.runSkillFn ?? defaultRunSkill;
            result = await runner(this.agent, job.skill, argsToString(job.args));
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

            // step 5：finish（store 按规则决定 done/ready/blocked/failed）
            if (!wasPreempted) try {
                await board.finish?.(job.id, {
                    ok: result?.ok === true,
                    code: result?.code ?? 'OK',
                    message: result?.message ?? '',
                    progress: this._progressOf(result),
                });
                this.onEvent({ type: 'job-finished', id: job.id, code: result?.code ?? 'OK', costMs: this.now() - startedAt });
            } catch (e) {
                this.onEvent({ type: 'finish-error', id: job.id, error: String(e?.message ?? e) });
            }

            // step 5：release 预约（放在 finally：失败/被抢占也必须放，否则别人永远拿不到）
            for (const key of reserved) {
                try { await ctx.release(key); } catch { /* ignore */ }
            }
        }
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
async function defaultRunSkill(agent, skill, argString) {
    const reg = await import('./composite_registry.js');
    return reg.runSkill(agent, skill, argString);
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
