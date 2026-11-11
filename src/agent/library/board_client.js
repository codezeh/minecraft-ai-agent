/**
 * 任务板客户端（M8 B1，agent 侧，06 §14 / 设计 §3.3）。
 *
 * 薄封装：把 `board:*` socket 事件包成方法，全部返回 `ActionResult`。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 最关键的一条设计约束：**控制层用的是"同步读"**（2026-11-02 核对 control.js）
 *
 *   control.js:216  `board.list({ states: [...] }) ?? []`     ← 没有 await
 *   control.js:219  `board.get?.(jobId) ?? null`              ← 没有 await
 *   control.js:239  `board.update(job.id, plan.patch)`        ← 只 try，不 await
 *   control.js:242  `board.setAutoClaim?.(false)`             ← 同上
 *   control.js:454  `board.add(pickup)`                       ← 同上
 *
 *   如果 `list`/`get` 返回 Promise，`?? []` 拿到的是 Promise（真值）→
 *   `running.find(...)` 直接 TypeError，或更糟：静默拿到 undefined 让控制层
 *   以为"没有单"→ 走了降级路径，而调度器（异步）走真板 ——
 *   这正是设计 §8 警告的"两套行为"。所以：
 *
 *     · `list(filter)` / `get(id)` **同步返回本地缓存的数组/对象**（不加 await 也不会错）
 *     · `update/add/setAutoClaim` **发出去就不等**（控制层本来就只 try 不 await），
 *       同时维护本地缓存让下一次同步读是新的
 *     · 需要**确认结果**的调用方（调度器 / 命令层）用 `*Async` 版本，返回 ActionResult
 *
 *   本地缓存不是"第二份真相"：它只是**最近一次服务端答复的镜像**，写操作一律以
 *   服务端 ack 为准（失败就不改缓存），读操作有 `refresh()` 强制拉一次。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { ok, fail, CODES } from './contract.js';
// ★ BOARD-002 / BOARD-003：与**服务端同一份**纯函数（去重限长的物品名归一化、尝试序号口径）。
//   从 board_claims 取而不是各写一份：那个文件不碰 node:sqlite，agent 侧引用是安全的。
import { normalizeReportedItems, attemptSeqOfJob, normalizeClaimKeys } from './board_claims.js';

/** socket ack 超时（06 §14：5 秒没回算失败）。 */
export const ACK_TIMEOUT_MS = 5000;

/**
 * ★ A5-8：**"这一拍不续租"** 的返回码。
 *
 * 为什么不走 `fail()`：`contract.js` 的 `CODES` 是一张**封闭词汇表**（任务单结果码另有
 * `board_store.BOARD_RESULT_CODES` 一套），加一个新码要动 contract.js —— 那不属于本条
 * 的修复范围，而且会把"客户端停租"这件事混进流程结果码里（它根本不是流程结果）。
 * 所以这里给一个**自洽的**返回值：形状与 ActionResult 一致（`ok/code/message/data`），
 * 上层只看 `code === 'HEARTBEAT_SKIPPED'`，不会被误当成流程失败。
 */
export const HEARTBEAT_SKIPPED = 'HEARTBEAT_SKIPPED';

/**
 * 造一个"跳过续租"的结果。
 * ★ T6：`HEARTBEAT_SKIPPED` 已注册进 `contract.CODES`（新码必须在册，否则 gate 报
 *   "未注册的 code"），所以这里直接走 `fail()` —— 形状/冻结/校验与其它码一致。
 */
function heartbeatSkipped(message, data = {}) {
    return fail(HEARTBEAT_SKIPPED, message, data);
}

/**
 * 把 id 归一成字符串；**不合法的返回 null**（绝不 `String(对象)`）。
 *
 * ★ 2026-11-02（t20）：`String({id:'x'})` → `"[object Object]"`，服务端拿它查库永远查不到，
 *   而且**不报错**——与"任务板没连上"的症状完全一样。这类"静默两套行为"比业务 bug 难查得多。
 *   规则：字符串直接用；数字/布尔/大整数转字符串；`{id: ...}` 取 `.id`；其余 → null。
 */
function normalizeId(id) {
    if (typeof id === 'string') return id === '' ? null : id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    if (id && typeof id === 'object' && typeof id.id === 'string' && id.id !== '') return id.id;
    return null;
}

/** 给错误信息用的"你传了个啥"描述（不 toString 整个对象）。 */
function describeId(id) {
    if (id === null || id === undefined) return String(id);
    if (typeof id === 'object') return Array.isArray(id) ? 'array' : `object(keys=${Object.keys(id).join(',') || '空'})`;
    return typeof id;
}

/**
 * 造一个任务板客户端。
 *
 * @param {object} deps
 *   socket   socket.io 客户端（要有 .emit(event, payload, ack)）
 *   name     本 bot 名字（个人单按它过滤）
 *   skills   上报给服务端的注册名数组（安全①：add 时服务端校验）
 *   roles    角色（B3 才用，先透传）
 *   timeoutMs ack 超时，默认 5000
 *   now()    时钟（测试注入）
 */
export class BoardClient {
    constructor(deps = {}) {
        this.socket = deps.socket ?? null;
        this.name = String(deps.name ?? '');
        this.skills = Array.isArray(deps.skills) ? deps.skills : [];
        this.roles = deps.roles ?? [];
        this.timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : ACK_TIMEOUT_MS;
        this.now = deps.now ?? (() => Date.now());

        /** 本地镜像：服务端最近一次告诉我们的事（读缓存，不是第二份真相）。 */
        this._jobs = [];
        this._byId = new Map();
        /**
         * ★ BOARD-003：本客户端**当前尝试**的序号（jobId → attemptSeq）。
         *   来源是 store 在领单时写进 `checkpoint.attemptSeq` 的那一个数。
         *   收尾（heartbeat/finish/checkpoint）带上它，服务端才能区分
         *   "同名机器人的新尝试"和"同一次尝试重复写入"。
         */
        this._attempts = new Map();
        this._connected = false;
        this._autoClaim = true;
        /**
         * ★★★ A5-8（S2，第四轮审计 §6.5）：**整端停止原因**（null = 没停）。
         *
         * 客户端这层原来只知道 `_autoClaim`（"要不要领下一张"），**完全没有"停"这个概念**，
         * 于是 `heartbeat()`（本文件 415 行那段）无条件续租 —— 只要调度器还在跑心跳，
         * 被 paused / 被取消的单就一直续着租，别的 bot 到进程被杀都拿不到。
         */
        this._stopRequested = null;
        /**
         * ★ A5-8：**逐单**的停止簿记（jobId → `{kind, reason, at}`）。
         *
         * 三种来源都会写进这里（都在本文件内）：
         *   · `setState(id, 'paused'|'cancelled')` —— 自己发起的暂停/取消；
         *   · `update(id, {state:'paused'|'cancelled'})` —— `control.applyStop()` 走的就是这条路
         *     （`!stop` 的真实链路！），不在这里记一笔就等于完全没防到；
         *   · `heartbeat()` 看到服务端回传的状态已经不是 claimed/running（别人停的）。
         * 记录之后 `heartbeat()` 直接返回 `HEARTBEAT_SKIPPED`，一次网络都不发。
         */
        this._stoppedJobs = new Map();

        // 服务端推 `board:changed` → 刷新该单（06 §14 只推这一个事件）
        try {
            this.socket?.on?.('board:changed', (payload) => { this._onChanged(payload); });
            this.socket?.on?.('disconnect', () => { this._connected = false; });
            this.socket?.on?.('connect', () => { this._connected = true; });
        } catch { /* 假 socket 没有 on 也无所谓（测试用） */ }
    }

    // ── 底层：一次带超时的 ack 调用 ──────────────────────────────────────
    /**
     * @param {string} event
     * @param {any} payload
     * @returns {Promise<ActionResult>} ok(data=ack) / TIMEOUT / INTERNAL(retryable)
     */
    _call(event, payload) {
        return new Promise((resolve) => {
            const sock = this.socket;
            if (!sock?.emit) {
                return resolve(fail('INTERNAL', '没有 socket 连接', { retryable: true, event }));
            }
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve(fail('TIMEOUT', `${event} ${this.timeoutMs}ms 没有 ack`, { retryable: true, event }));
            }, this.timeoutMs);
            // ★★ 不要给这个定时器加 `unref()`（2026-11-02 实测踩过，别"顺手"加回来）：
            //   `unref()` 的语义是"事件循环不需要为它保活"。而这个定时器**正是**
            //   "等待 ack" 这件事本身的生命线 —— 一旦 unref，如果调用方只是 `await`
            //   （事件循环里没有别的活），Node 会判定无事可做直接退出，
            //   promise 永不 settle，表现为 "unsettled top-level await"。
            //
            //   区分标准：
            //     · **请求类定时器**（这个 ack 超时、单次重试等待）→ 不 unref，它承载一次请求的完成
            //     · **后台扫描类定时器**（board_server 的租约过期扫描、缓存清理）→ 要 unref，
            //       它们不该阻止进程正常退出

            try {
                sock.emit(event, payload, (ackPayload) => {
                    if (settled) return;
                    settled = true;
                    try { clearTimeout(timer); } catch { /* ignore */ }
                    if (!ackPayload || ackPayload.ok === false) {
                        // 服务端明确拒绝：**不可重试**（重试也是同一个回答）
                        //
                        // ★★★ BOARD-003（2026-11-06 深度检查，连带修）：**不能把服务端的码
                        //   直接喂给 `fail()`**。本仓有两套词汇表（见 board_store 的
                        //   BOARD_RESULT_CODES 注释）：任务板自己的码里 `LEASE_STALE` **不在**
                        //   contract 的 CODES 里，而 `fail()` 遇到未注册码**直接抛异常**。
                        //   抛异常发生在 ack 回调里（此时 `settled` 已经是 true）→ 异常被外层
                        //   catch 吞掉（它只防"发送失败"）→ **promise 永不 settle** →
                        //   调用方表现为 "unsettled top-level await"（离线用例实测到这里挂死）。
                        //   于是"租约失效"这个必须立刻停手的信号，反而变成了"永远等不到回答"。
                        //   修法：在 agent 侧边界做**一次**显式映射（任务板码 → contract 码），
                        //   未知码兜底 INTERNAL 而不抛；服务端的原始码留在 data.boardCode 里
                        //   供诊断（不丢信息）。
                        const rawCode = ackPayload?.code ?? null;
                        return resolve(fail(
                            contractCodeOf(rawCode),
                            ackPayload?.reason ?? ackPayload?.message ?? `服务端拒绝（code=${rawCode ?? 'null'}）`,
                            { event, ...(ackPayload ?? {}), boardCode: rawCode },
                        ));
                    }
                    this._connected = true;
                    resolve(ok(ackPayload));
                });
            } catch (e) {
                if (settled) return;
                settled = true;
                try { clearTimeout(timer); } catch { /* ignore */ }
                // 断线 / 发送失败 → INTERNAL + retryable（06 §14：断线可重试）
                resolve(fail('INTERNAL', String(e?.message ?? e), { retryable: true, event }));
            }
        });
    }

    /** `board:changed` → 只更新那一张（不做全量拉取，免得每条推送都打一次库）。 */
    _onChanged(payload) {
        const id = payload?.id;
        if (id == null) { this.refresh(); return; }
        // 推送只带 id/state/priority，字段不全 → 标脏，等下次 list/get 再拉
        this._dirty = this._dirty ?? new Set();
        this._dirty.add(id);
        const cur = this._byId.get(id);
        if (cur) {
            // 先用推送里的字段更新（够控制层判状态），完整字段靠 getAsync 补
            this._byId.set(id, { ...cur, state: payload.state ?? cur.state, priority: payload.priority ?? cur.priority });
        }
    }

    // ── 控制层契约的 5 个方法（★ list/get 必须同步！见文件头）───────────

    /**
     * 【同步】列单（控制层直接 `?? []`）。
     * @param {{states?:string[], assignee?:string}} [filter]
     * @returns {object[]} 本地镜像（可能略旧，`refresh()` 强制更新）
     */
    list(filter = {}) {
        let jobs = [...this._byId.values()];
        if (Array.isArray(filter?.states) && filter.states.length) {
            jobs = jobs.filter((j) => filter.states.includes(j?.state));
        }
        if (filter?.assignee) jobs = jobs.filter((j) => j?.assignee === filter.assignee);
        if (filter?.skill) jobs = jobs.filter((j) => j?.skill === filter.skill);
        return jobs;
    }

    /**
     * 【同步】取单（控制层直接 `?? null`）。
     *
     * ★ 2026-11-02（t20）：**不再 `String(id)` 静默转换**。
     *   原写法对对象入参产出 `"[object Object]"` —— 正是 B1 那个"board:get 永远 null"事故的同一指纹。
     *   现在：字符串/数字正常取；`{id:'x'}` 取 `.id`；其余返回 null（同步接口不能返回 fail）。
     *   宁可返回 null（控制层本来就要处理"没这张单"），也不要拿一个 `"[object Object]"` 去查库。
     */
    get(id) {
        const key = normalizeId(id);
        if (key == null) return null;
        return this._byId.get(key) ?? null;
    }

    /** 【不等】更新一张单（控制层只 try 不 await）。返回 Promise<ActionResult> 供需要的人用。 */
    update(id, patch) {
        // ★★★ A5-8：`control.applyStop()` 的 `!stop` 链路走的就是这里
        //   （`board.update(job.id, plan.patch)`，patch 里带 `state:'paused'`）。
        //   不在这里记一笔，客户端就永远不知道"这张单已经停了"→ 心跳照旧续租。
        //   ★ 先记再发：ack 慢（或失败回滚）也不能让这几拍继续续租。
        if (patch && typeof patch === 'object' && (patch.state === 'paused' || patch.state === 'cancelled')) {
            this.markJobStopped(id, patch.state, patch.checkpoint?.pausedReason ?? null);
        } else if (patch && typeof patch === 'object' && patch.state === 'ready') {
            this.markJobResumed(id);
        }
        // 乐观更新本地镜像，失败时以 ack 为准回滚（见 .then）
        const prev = this._byId.get(String(id));
        if (prev && patch && typeof patch === 'object') {
            this._byId.set(String(id), { ...prev, ...stripLease(patch) });
        }
        return this._call('board:update', { id: String(id), patch }).then((r) => {
            if (r.ok && r.data?.job) this._byId.set(String(id), r.data.job);
            else if (!r.ok && prev) this._byId.set(String(id), prev);   // 失败回滚
            return r;
        });
    }

    /** 【不等】加一张单。 */
    add(job) {
        // R6 #67：client 侧先校验 claim key 形状 —— 非法 key 在这里带日志拒掉，不送进账本
        if (job?.claims != null) {
            const norm = normalizeClaimKeys(job.claims);
            if (!norm.ok) {
                console.warn(`[board] board:add 本地被拒：claims 非法 —— ${norm.error}`);
                return Promise.resolve(fail('INTERNAL', `claims 里有非法 key：${norm.error}`));
            }
        }
        return this._call('board:add', job).then(async (r) => {
            if (r.ok && r.data?.job) { this._byId.set(r.data.job.id, r.data.job); return r; }
            // ★★ 2026-11-03（t58）：**ack 超时 ≠ 没建成** —— 超时后必须回查一次。
            //
            //   真机证据（verify 实测）：`[!do first_night] 失败 INTERNAL：父单没下进去：
            //   board:add 5000ms 没有 ack` —— **但服务端其实已经把父单建出来了**
            //   （库里 3 张 `running`，各自子单 0/0/1）。
            //
            //   客户端判失败 → `firstNight` 直接 `return fail(...)` → **子单一张都不建**
            //   → 父单永久变"孤儿 running"（没人跑它，也没人收它）。
            //
            //   根子是"超时"和"没成功"被混为一谈。回查一次很便宜：
            //   按 `skill + why + source + assignee` 找同形状的 `ready/running` 单，
            //   找到就说明**它其实建成了**，按成功返回（并标明 `recoveredFromTimeout`）。
            if (r?.code === 'TIMEOUT') {
                const found = await this._findJustAdded(job);
                if (found) {
                    this._byId.set(found.id, found);
                    return ok({ id: found.id, job: found, recoveredFromTimeout: true });
                }
            }
            return r;
        });
    }

    /**
     * ack 超时后回查："这张单其实建成了吗？"
     *
     * 判据（保守 —— 宁可漏认，不可错认）：
     *   同一 `skill` + `why` + `source` + `assignee`，状态 `ready`/`running`。
     *   有 `at` 时优先取最近 60 秒内的；找不到就返回 `null`（**不假装成功**）。
     */
    async _findJustAdded(job) {
        try {
            if (!job?.skill) return null;
            if (typeof this.refreshAsync === 'function') {
                try { await this.refreshAsync({ scope: 'mine' }); } catch { /* refresh 失败也继续用现有镜像 */ }
            }
            const list = this.list?.({ scope: 'mine' }) ?? [];
            const cand = (list ?? []).filter((j) => (
                j
                && j.skill === job.skill
                && (j.why ?? null) === (job.why ?? null)
                && (j.source ?? null) === (job.source ?? null)
                && (j.assignee ?? null) === (job.assignee ?? null)
                && ['ready', 'running'].includes(String(j.state))
            ));
            if (!cand.length) return null;
            const withAt = cand.filter((j) => Number.isFinite(Number(j.at)));
            if (withAt.length) {
                const nowSec = Date.now() / 1000;
                const recent = withAt.filter((j) => nowSec - Number(j.at) <= 60);
                return (recent.length ? recent : withAt)[0] ?? cand[0] ?? null;
            }
            return cand[0] ?? null;
        } catch { return null; }
    }

    /** 【不等】开关自动领单（玩家喊停时暂停）。 */
    setAutoClaim(enabled) {
        this._autoClaim = !!enabled;
        // 服务端目前不需要知道（B1 由调度器自己看这个开关），保留接口形状
        return Promise.resolve(ok({ autoClaim: this._autoClaim }));
    }

    /** 当前的自动领单开关（B2 的调度器要读）。 */
    get autoClaim() { return this._autoClaim; }

    // ── ★ A5-8：停止 / 暂停簿记（"停了就不许再续租"的唯一判据来源）────────

    /**
     * 整端停止（进程退出 / 玩家按停 / 自杀式重连）。
     *
     * 与 `setAutoClaim(false)` 的区别：那个只是"不再领下一张"，**手上这张照常续租**；
     * 这个是"停了"：从这一刻起 `heartbeat()` 一次都不发。
     */
    stop(reason = 'player') {
        this._stopRequested = String(reason ?? 'player');
        return this._stopRequested;
    }

    /** 撤销整端停止（"继续"）。已经停掉的单仍各自记着自己的停止簿记。 */
    resume() {
        this._stopRequested = null;
        return null;
    }

    get stopRequested() { return this._stopRequested; }
    get stopped() { return this._stopRequested != null; }

    /**
     * ★ A5-8：把一张单记成"已停"。
     * @param {string|number} id
     * @param {'paused'|'cancelled'} kind  paused=可恢复（玩家说继续还能接着做）；cancelled=终态
     * @param {string|null} reason
     */
    markJobStopped(id, kind = 'paused', reason = null) {
        const key = normalizeId(id);
        if (key == null) return null;
        const rec = { kind: kind === 'cancelled' ? 'cancelled' : 'paused', reason, at: this.now() };
        this._stoppedJobs.set(key, rec);
        return rec;
    }

    /** ★ A5-8：撤销一张单的停止簿记（resume / 重新领到这张单时）。 */
    markJobResumed(id) {
        const key = normalizeId(id);
        if (key == null) return false;
        return this._stoppedJobs.delete(key);
    }

    /** 这张单的停止簿记（没有就 null）。 */
    stoppedJob(id) {
        const key = normalizeId(id);
        if (key == null) return null;
        return this._stoppedJobs.get(key) ?? null;
    }

    /** ★ A5-8：这一拍**为什么不该续租**（null = 可以续）。 */
    heartbeatBlockedBy(id) {
        if (this._stopRequested != null) {
            return { kind: 'stopped', reason: this._stopRequested, message: `客户端已停止（${this._stopRequested}）` };
        }
        const rec = this.stoppedJob(id);
        if (rec) {
            return {
                kind: rec.kind, reason: rec.reason,
                message: rec.kind === 'cancelled' ? '这张单已取消' : '这张单已暂停（可恢复，但不再续租）',
            };
        }
        return null;
    }

    /** 服务端回传的单如果是 paused/cancelled，就地记一笔（下一拍起停租）。 */
    _noteJobState(job) {
        if (!job?.id) return;
        if (job.state === 'paused') this.markJobStopped(job.id, 'paused', job.checkpoint?.pausedReason ?? null);
        else if (job.state === 'cancelled') this.markJobStopped(job.id, 'cancelled', null);
    }

    // ── 给调度器 / 命令层用的异步版（返回 ActionResult）──────────────────

    /** 连上并登记能力（安全①：服务端据此校验 add 的 skill）。 */
    async hello() {
        const r = await this._call('board:hello', {
            bot: this.name, skills: this.skills, roles: this.roles,
        });
        if (r.ok) this._connected = true;
        return r;
    }

    /**
     * 强制从服务端拉一遍（同步 `list()` 读的就是这份）。
     *
     * ★ 2026-11-02（t23，captain 拍板）：**`scope` 是显式契约，不许靠 `??` 隐式穿透**。
     *
     *   原来的写法只发 `{mine: 自己}`，服务端 `assignee = 自己` 一过滤 →
     *   **共享单（assignee=null）和别的 bot 的单永远拿不到** → 抢占/残局回收对真实场景
     *   （别人挂的 9 级单）完全不生效，而且**不报错**。
     *
     *   scope 三档（服务端也按它显式过滤，未知 scope 会**报错**而不是默认放行）：
     *     'mine'      —— 只看指派给我的（**默认**，保持旧语义）
     *     'claimable' —— 可领的：共享单 + 指派给我的（**用于抢占判定 / 残局回收**）
     *     'all'       —— 全部（仅面板/调试）
     *
     *   为什么不用 `assignee: null` 表达"可领"：`null` 在过滤条件这一层天然有歧义
     *   （"不过滤"还是"assignee 为空那些"？），换成显式 scope 语义才没有歧义。
     *
     * @param {{scope?:'mine'|'claimable'|'all', states?:string[], limit?:number}} filter
     */
    async refresh(filter = {}) {
        const scope = filter.scope ?? 'mine';
        if (!['mine', 'claimable', 'all'].includes(scope)) {
            return fail('INTERNAL', `未知 scope「${scope}」（只能是 mine / claimable / all）`, { scope });
        }
        const payload = { scope, mine: this.name, states: filter.states ?? null };
        // ★★★ T30 第14条：`scope='claimable'` **一律带 openOnly**（服务端放进 SQL）。
        //   否则 200 张已完成的历史单把 LIMIT 窗口占满 → 新单进不了镜像 →
        //   抢占/残局回收静默失效（`jobs` 表从不删除，只是"暂时"没满）。
        if (scope === 'claimable') payload.openOnly = true;
        if (Number.isFinite(filter.limit)) payload.limit = filter.limit;
        const r = await this._call('board:list', payload);
        if (!r.ok) return r;
        const jobs = r.data?.jobs ?? [];
        for (const job of jobs) {
            if (job?.id) { this._byId.set(job.id, job); }
        }
        return r;
    }

    /**
     * 异步取单（要新鲜数据的调用方用）。
     *
     * ★ 2026-11-02（t20）：**非字符串 id 直接 fail，不静默 `String()`**。
     *   宁可当面报错，也不要发一个 `"[object Object]"` 上去让服务端恒返回 null
     *   （那会伪装成"没有这张单"，与"任务板没连上"一模一样，最难查）。
     */
    async getAsync(id) {
        const key = normalizeId(id);
        if (key == null) {
            return fail('NO_TARGET', `id 必须是字符串（收到 ${describeId(id)}）`, { idType: typeof id });
        }
        const r = await this._call('board:get', { id: key });
        if (r.ok && r.data?.job) this._byId.set(r.data.job.id, r.data.job);
        return r;
    }

    /**
     * 原子领单。
     *
     * ★★★ BOARD-002（2026-11-06 深度检查）：**必须把真实库存随领单一起报上去**。
     *
     *   缺陷原貌：这里原来只发 `{ bot: this.name }`，服务端 `payload.items ?? []` →
     *   `meetsRequires` 面对"需要 stone_pickaxe"的单**先按空背包拒绝**，而调度器
     *   领到之后那次真实背包复核**根本没机会执行** ⇒ 物品资格的任务永远领不出来。
     *   报告实测：client 发 `{bot:'worker'}` 拿到 null；同一库直接传
     *   `items:['stone_pickaxe']` 就能领到同一张单。
     *
     *   说明（照报告要求写明边界）：这是**合作机器人之间的能力判断**，
     *   不是防恶意客户端的身份保证 —— socket 外部可达，谁都能报自己带了什么。
     *   真正的防护在服务端（roles 用服务端注册的，不采信 agent 自报）。
     *
     * @param {{items?:Array<string|{name:string}>}} [who] 能力快照（调度器每次现读真实背包）
     */
    async claim(who = null) {
        const payload = { bot: this.name };
        // ★ BOARD-002（任务书第 7 条：只报最小必要字段）：**只发物品名**，并去重/限长。
        //   调度器传进来的是 `inventory.items()` 的原始条目（含 count/durability/nbt），
        //   直接透传等于"每次轮询把整个背包过一遍网络"——资格判断只需要"有没有"。
        //   归一化函数与**服务端同一份**（board_claims.normalizeReportedItems），
        //   两边不会漂移；老调用方传 undefined/非数组 → 空数组（服务端当没报，不崩）。
        if (who != null) payload.items = normalizeReportedItems(who?.items);
        const r = await this._call('board:claim', payload);
        if (r.ok && r.data?.job) {
            this._rememberAttempt(r.data.job);
            // ★ A5-8：重新领到这张单 = 之前的停止簿记作废（否则新尝试一次心跳都不发）
            this.markJobResumed(r.data.job.id);
        }
        return r;
    }

    /**
     * ★ BOARD-003：记住"这张单当前是哪一次尝试"（领单时由 store 打在 checkpoint 上）。
     * 之后 heartbeat / finish / checkpoint 都要带上它 —— 否则同名重领后，
     * 旧尝试的迟到写入会被当成新尝试的结果。
     */
    _rememberAttempt(job) {
        const id = job?.id;
        if (id == null) return;
        this._byId.set(id, job);
        // 序号口径与服务端/store 同一份实现（`attemptSeqOfJob`），不在客户端另判一遍
        const seq = attemptSeqOfJob(job);
        if (seq != null) this._attempts.set(String(id), seq);
        else this._attempts.delete(String(id));
    }

    /** 取这张单本次尝试的序号（没有就返回 undefined，服务端按老行为处理）。 */
    _attemptOf(id) {
        const seq = this._attempts.get(String(id));
        return Number.isFinite(seq) ? seq : undefined;
    }

    /**
     * 续租 + 进度。LEASE_LOST 要立刻停手（06 §6）。
     *
     * ★★★ A5-8（S2，第四轮审计 §6.5）：**停了就不许续租。**
     *
     *   原来这个方法无条件发 `board:heartbeat` —— 只要调用方还在跑心跳，被 paused
     *   或被取消的单就每 10 秒续一次租，别的 bot **一直拿不到这张单**（直到进程被杀）。
     *   审计点的正是这里（client 415-420）与调度器心跳两处。
     *
     *   现在两个前置判据（任一命中就**一次网络都不发**，直接返回 `HEARTBEAT_SKIPPED`）：
     *     ① 整端停止：`stop(reason)`；
     *     ② 逐单停止簿记：`setState/update/heartbeat` 任一看到 paused/cancelled。
     *   另外，服务端回传的状态已经不是 claimed/running 时**就地记一笔**，下一拍起停租。
     */
    async heartbeat(id, progress = null) {
        const key = String(id);
        const blocked = this.heartbeatBlockedBy(id);
        if (blocked) {
            return heartbeatSkipped(`不再续租：${blocked.message}`, {
                id: key, skipped: true, kind: blocked.kind, reason: blocked.reason,
            });
        }
        const payload = { id: key, bot: this.name, progress };
        // ★ BOARD-003：带尝试标识，同名重领后旧尝试不能再续租/写进度
        const seq = this._attemptOf(id);
        if (seq !== undefined) payload.attemptSeq = seq;
        const r = await this._call('board:heartbeat', payload);
        if (r.ok && r.data?.job) {
            this._rememberAttempt(r.data.job);
            // ★ A5-8：服务端说它已经 paused/cancelled（可能是**别人**停的）→ 记下来，下一拍停租
            this._noteJobState(r.data.job);
        }
        return r;
    }

    /** 存断点。 */
    async checkpoint(id, checkpoint) {
        const payload = { id: String(id), checkpoint };
        // ★ BOARD-003：迟到 checkpoint 不得修改新尝试字段
        const seq = this._attemptOf(id);
        if (seq !== undefined) payload.attemptSeq = seq;
        return this._call('board:checkpoint', payload);
    }

    /** 回报结果（完成与否由 store 判）。 */
    async finish(id, result) {
        // ★★★ T30 第4条：**带上自己的名字**。服务端要用它校验租约归属：
        //   不传 → 服务端无法判断"你还是不是这张单的主人" → 租约过期的旧持有者
        //   能把别人正在跑的单写回 ready。`LEASE_STALE` = 立刻停手（与 LEASE_LOST 同义）。
        //
        //   ★ BOARD-003：名字不够（同名重领分不开），再带上**本次尝试序号**。
        const payload = { id: String(id), result, bot: this.name };
        const seq = this._attemptOf(id);
        if (seq !== undefined) payload.attemptSeq = seq;
        const r = await this._call('board:finish', payload);
        if (r.ok && r.data?.job) this._rememberAttempt(r.data.job);
        else if (!r.ok) this._attempts.delete(String(id));   // 收尾失败/失效 → 忘掉，避免复用旧序号
        return r;
    }

    /** 设状态（cancel / pause / resume）。 */
    async setState(id, state, reason = '') {
        // ★ A5-8：先记簿记再发 —— paused/cancelled 之后本端**一次心跳都不许再发**；
        //   ready（resume）则撤销簿记。ack 失败也不回滚这条簿记：
        //   宁可少续一次租（单会回 ready 被别人捡走），也不要留一个僵尸租约。
        if (state === 'paused' || state === 'cancelled') this.markJobStopped(id, state, reason || null);
        else if (state === 'ready') this.markJobResumed(id);
        const payload = { id: String(id), state, reason };
        // ★ BOARD-003 补洞：带尝试标识 —— 否则同名重领后旧尝试一句 set-state(paused/ready)
        //   就能清掉新尝试的租约（`clearLease` 会把 lease_owner/until 置空）。
        const seq = this._attemptOf(id);
        if (seq !== undefined) payload.attemptSeq = seq;
        const r = await this._call('board:set-state', payload);
        if (r.ok && r.data?.job) this._byId.set(r.data.job.id, r.data.job);
        return r;
    }

    // ── B3：预约（06 §9.2）+ 断点读写（makeCtx 用）────────────────────

    /**
     * 预约一批资源。冲突时返回 `CLAIM_CONFLICT`（流程按 onFail 换目标）。
     *
     * ★ 单 bot 恒成功不是这里保证的 —— 是**store 的判据**（"有没有别的 owner"）
     *   在单 bot 时天然成立。这里不做任何特判，否则就是两条路径。
     */
    async reserve(id, keys) {
        const r = await this._call('board:reserve', { id: String(id), owner: this.name, keys });
        if (!r.ok && r.data?.code === 'CLAIM_CONFLICT') {
            // 把 conflicts 透给上层（流程要据此换目标）
            return fail('CLAIM_CONFLICT', r.message, { conflicts: r.data.conflicts ?? [], id, keys });
        }
        return r;
    }

    async release(id, keys = null) {
        return this._call('board:release', { id: String(id), owner: this.name, keys });
    }

    /**
     * ★ A5-8：**主动放掉租约**（只清 `lease_owner/lease_until`，不动状态）。
     *
     * 为什么不用 `setState(paused)`：暂停的单**已经在 paused 了**，store 的状态转移表里
     * `paused → paused` 是**非法转移**，会失败；而 store 的 `PATCHABLE` 白名单里
     * 正好有 `lease_owner/lease_until` 两个字段 —— 只摘租约、不动状态，
     * 于是"暂停（可恢复）"与"取消（终态）"两种语义都不会被改写。
     */
    releaseLease(id) {
        const key = normalizeId(id);
        if (key == null) {
            return Promise.resolve(fail('NO_TARGET', `id 必须是字符串（收到 ${describeId(id)}）`, { idType: typeof id }));
        }
        return this.update(key, { lease_owner: null, lease_until: null });
    }
    /** 这张单持有哪些预约（诊断）。 */
    async claims(id = null) {
        return this._call('board:claims', id ? { id: String(id) } : {});
    }

    /** 读断点（makeCtx 的 ctx.checkpoint）。 */
    async getCheckpoint(id, key = 'default') {
        const r = await this._call('board:get-checkpoint', { id: String(id), key });
        return r.ok ? (r.data?.checkpoint ?? null) : null;
    }

    /** 存断点（makeCtx 的 ctx.save）。 */
    async saveCheckpoint(id, key, value) {
        return this._call('board:save-checkpoint', { id: String(id), key, value });
    }

    // ── B4：共享数据（06 §9.3）地标 / 危险点 / 箱子内容 ────────────────

    async sharedPut(kind, key, value) {
        return this._call('board:shared-put', { kind, key, value, owner: this.name });
    }

    async sharedList(kind = null) {
        return this._call('board:shared-list', kind ? { kind } : {});
    }

    async sharedGet(kind, key) {
        return this._call('board:shared-get', { kind, key });
    }

    /**
     * ★★★ T31 第16条：**箱子内容按增量原子合并**（服务端一次往返做完读-改-写）。
     *
     * 别再用 `sharedGet` + 本地叠加 + `sharedPut` 去改箱子：那两次往返之间
     * 别的 bot 也能写，后写的会**整份覆盖**先写的（丢件）。
     *
     * @param {string} key `"x,y,z"`
     * @param {object} delta `{ oak_log: +5, stone: -3 }`
     * @param {{x:number,y:number,z:number}|null} [pos] 首次写入时用来种下坐标
     */
    async sharedMerge(key, delta, pos = null) {
        return this._call('board:shared-merge', { key, delta, pos, owner: this.name });
    }

    async sharedDel(kind, key) {
        return this._call('board:shared-del', { kind, key });
    }

    /** ★ B4 验收核心：不开箱就知道哪个箱子有某物品。 */
    async sharedFindItem(item, minCount = 1) {
        return this._call('board:shared-find-item', { item, minCount });
    }

    /** 是否连上过（诊断用）。 */
    get connected() { return this._connected; }
}

/**
 * 任务板结果码 → contract 的 ActionResult 码（**agent 侧唯一的转换点**）。
 *
 * ★ 为什么需要它（BOARD-003 连带修）：本仓有两套词汇表（见 board_store 的
 *   `BOARD_RESULT_CODES` 注释）—— 任务板自己的码（`LEASE_STALE` 等）**不在**
 *   `contract.CODES` 里，而 `fail()` 遇到未注册码**直接抛异常**。在 ack 回调里抛
 *   就等于"这个 promise 永远不 settle"（外层 catch 只防发送失败，且此时 settled 已 true）
 *   → 调用方看到的是"永远等不到回答"，而不是"租约失效，立刻停手"。
 *
 * 映射规则：
 *   · `LEASE_STALE` → `LEASE_LOST`：语义相同（"租约已不属于你，立刻停手、不写结果"），
 *     且 `LEASE_LOST` 是 CODES 里早就为这件事注册的码（调度器也在判它）。
 *   · 其它已注册码 → 原样保留。
 *   · 未注册码/空 → `INTERNAL`（**兜底不抛**：宁可给一个笼统的失败，也不能挂死调用方）。
 *   原始码始终留在 `data.boardCode` 里，诊断时不丢信息。
 */
const BOARD_CODE_TO_CONTRACT = Object.freeze({ LEASE_STALE: 'LEASE_LOST' });

function contractCodeOf(rawCode) {
    const code = String(rawCode ?? '').trim();
    const mapped = BOARD_CODE_TO_CONTRACT[code] ?? code;
    if (mapped && mapped !== 'OK' && CODES.includes(mapped)) return mapped;
    return 'INTERNAL';
}

/** patch 里的 `lease` 是嵌套对象，展开进本地镜像时不能直接当字段用。 */
function stripLease(patch) {
    const out = { ...patch };
    if ('lease' in out) {
        const l = out.lease;
        delete out.lease;
        out.lease = l;          // 保留原样，等 ack 回来以服务端为准
    }
    return out;
}

/**
 * 造一个"永远连不上"的空板客户端 —— 用于**无板降级**与测试。
 *
 * 它把 5 个契约方法都实现成"没有单"的安全默认值，于是控制层拿到的东西
 * 与 `board = null` 时**行为完全一致**（`list` 返回 []、`get` 返回 null、
 * `update/add/setAutoClaim` 静默 no-op）。这条是设计 §3.4 要求的
 * "不维护有板/无板两条业务路径"的落地方式。
 */
export function makeNullBoard() {
    return {
        isNullBoard: true,
        list: () => [],
        get: () => null,
        update: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        add: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        setAutoClaim: () => Promise.resolve(ok({ autoClaim: false })),
        // ★ T31 第16条：无板时合并是"尽力而为"的 no-op（记忆不是交易的成败条件）
        sharedMerge: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        hello: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        claim: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        heartbeat: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        checkpoint: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        finish: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        setState: () => Promise.resolve(fail('INTERNAL', '没有任务板', { retryable: true, noBoard: true })),
        get connected() { return false; },
        get autoClaim() { return false; },
    };
}
