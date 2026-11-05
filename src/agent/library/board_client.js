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
import { ok, fail } from './contract.js';

/** socket ack 超时（06 §14：5 秒没回算失败）。 */
export const ACK_TIMEOUT_MS = 5000;

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
        this._connected = false;
        this._autoClaim = true;

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
                        return resolve(fail(
                            ackPayload?.code ?? 'INTERNAL',
                            ackPayload?.reason ?? ackPayload?.message ?? '服务端拒绝',
                            { event, ...(ackPayload ?? {}) },
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

    /** 原子领单。 */
    async claim() {
        const r = await this._call('board:claim', { bot: this.name });
        if (r.ok && r.data?.job) this._byId.set(r.data.job.id, r.data.job);
        return r;
    }

    /** 续租 + 进度。LEASE_LOST 要立刻停手（06 §6）。 */
    async heartbeat(id, progress = null) {
        const r = await this._call('board:heartbeat', { id: String(id), bot: this.name, progress });
        if (r.ok && r.data?.job) this._byId.set(r.data.job.id, r.data.job);
        return r;
    }

    /** 存断点。 */
    async checkpoint(id, checkpoint) {
        return this._call('board:checkpoint', { id: String(id), checkpoint });
    }

    /** 回报结果（完成与否由 store 判）。 */
    async finish(id, result) {
        // ★★★ T30 第4条：**带上自己的名字**。服务端要用它校验租约归属：
        //   不传 → 服务端无法判断"你还是不是这张单的主人" → 租约过期的旧持有者
        //   能把别人正在跑的单写回 ready。`LEASE_STALE` = 立刻停手（与 LEASE_LOST 同义）。
        const r = await this._call('board:finish', { id: String(id), result, bot: this.name });
        if (r.ok && r.data?.job) this._byId.set(r.data.job.id, r.data.job);
        return r;
    }

    /** 设状态（cancel / pause / resume）。 */
    async setState(id, state, reason = '') {
        const r = await this._call('board:set-state', { id: String(id), state, reason });
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
