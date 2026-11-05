/**
 * 任务板 socket 事件（M8 B1，06 §14，设计见 M8_实施设计.md §3.2）。
 *
 * **只做三件事：校验参数 → 调 board_store → 回 ack。**
 * 业务逻辑（状态机、attempts 计数、完成判据）一律在 `board_store.js`，
 * 这里只做"翻译 + 安检"。这条边界很重要：如果 socket 层开始判状态机，
 * 就会出现"库里一套、socket 又一套"，而两套迟早对不上。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全三条（06 §10 原文，逐条落地）：
 *   ① `skill` 只能是该 bot **自己报上来的注册名**（`board:hello` 里的 skills），
 *      不能是任意函数名 —— 否则等于把整个模块命名空间暴露给命令层。
 *   ② `args` 按该技能的 `manifest.params` 校验，不合格**直接拒、不进库**。
 *   ③ 参数在服务端**再校验一遍**（不信任 agent 传来的东西）：
 *      agent 侧的 board_client 已经校验过一次，这里仍要独立校验 ——
 *      因为 socket 是外部可达的，别人可以绕过 client 直接发事件。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 事件名与 ack 形状严格按 06 §14；ack 5 秒没回由 **client 侧**超时（服务端不主动超时）。
 */
import {
    addJob, getJob, listJobs, claimFor, heartbeat, finish, setState, updateJob,
    expireLeases, JOB_STATE,
    // B3：预约（06 §9.2）+ 父子收敛（06 §9.1）
    reserve, release, renewClaims, expireClaims, listClaims, rollupParent,
    reopenBlockedWithSatisfiedDeps,
    // ★ t140：兜底收敛（子单全终态但父单还挂着）
    convergeOrphanParents,
    reopenOrphanBlocked,
    // ★ T30：第5条（依赖已死 → DEP_DEAD）、第17条（幽灵父单 → ORPHAN_PARENT）
    sweepDeadDepJobs, blockOrphanParents,
    // B4：共享数据（06 §9.3）
    putShared, getShared, listShared, delShared, findItemInSharedChests,
} from './board_store.js';

/** 单个 bot 上报的能力（`board:hello` 记下来，用于校验 add 的 skill）。 */
const botRegistry = new Map();   // bot -> { skills:Set, roles:[], at }

/** 心跳/租约扫描间隔（06 §6：租约 30 秒，每 10 秒续租；这里 5 秒扫一次过期）。 */
const SCAN_MS = 5000;

/**
 * 校验一张要入库的单（安全 ①②③）。
 *
 * @param {object} db
 * @param {object} job      agent 传来的任务单
 * @param {object} opts     { registry, validateArgs }
 *   registry      技能名 → manifest（来自 composite_registry 的注册表）
 *   validateArgs  (manifest, argsString|object) → {ok, args|error}
 * @returns {{ok:true, job:object} | {ok:false, reason:string}}
 */
export function validateIncomingJob(job, opts = {}) {
    if (!job || typeof job !== 'object') return { ok: false, reason: '任务单必须是对象' };

    // ① skill 必须是注册名
    const skill = String(job.skill ?? '').trim();
    if (!skill) return { ok: false, reason: '缺少 skill' };
    const registry = opts.registry ?? null;
    if (registry && !registry.has(skill)) {
        return { ok: false, reason: `skill「${skill}」不在注册表里（可用：${[...registry.keys()].join(' ')}）` };
    }

    // ③ 参数独立校验（不信任 agent 传来的 args）
    if (opts.validateArgs) {
        const v = opts.validateArgs(skill, job.args);
        if (!v.ok) return { ok: false, reason: `参数不合格：${v.error}` };
        job = { ...job, args: v.args };
    }

    // 数值字段的边界（也是 ③：别人可以塞 priority=999）
    const priority = Number(job.priority ?? 5);
    if (!Number.isFinite(priority) || priority < 0 || priority > 9) {
        return { ok: false, reason: `priority 必须是 0-9（现在 ${job.priority}）` };
    }
    return { ok: true, job: { ...job, skill, priority, kind: job.kind ?? 'personal' } };
}

/**
 * 把 `board:*` 事件挂到一个 socket.io 实例上。
 *
 * @param {object} deps
 *   io          socket.io 实例（mindserver 的 getIO()）
 *   db          已打开的 board_store 库
 *   registry    Map<skill, manifest>
 *   validateArgs (skill, args) → {ok, args|error}
 *   now         () => number（测试可注入假时钟）
 *   broadcast   (event, payload) => void（默认用 io.emit；测试可换成收集器）
 * @returns {{stop:Function}} 停掉租约扫描
 */
export function attachBoardServer(deps = {}) {
    const {
        io,
        db,
        registry = null,
        validateArgs = null,
        now = () => Date.now(),
        broadcast = (event, payload) => { try { io?.emit?.(event, payload); } catch { /* 没人听就算了 */ } },
    } = deps;

    if (!io || !db) throw new Error('attachBoardServer 需要 io 和 db');

    /** 统一的 ack 包装：把内部 {ok,code} 转成 ack 形状，并保证**永远**回 ack（不许卡死客户端）。 */
    const ack = (cb, payload) => {
        try { cb?.(payload); } catch { /* ack 抛错不影响服务端 */ }
    };

    /** 单子变了就推一条 `board:changed`（06 §14：mindserver → agent 只推这一个）。 */
    const changed = (job, reason = '') => {
        if (job) broadcast('board:changed', { id: job.id, state: job.state, priority: job.priority, reason });
    };

    io.on('connection', (socket) => {
        // ── hello：记下这只 bot 能干什么 ────────────────────────────────
        socket.on('board:hello', (payload, cb) => {
            const bot = String(payload?.bot ?? '').trim();
            const skills = Array.isArray(payload?.skills) ? payload.skills : [];
            if (!bot) return ack(cb, { ok: false, reason: '缺少 bot' });
            botRegistry.set(bot, { skills: new Set(skills), roles: payload?.roles ?? [], at: now() });
            ack(cb, { ok: true, jobs: listJobs(db, { assignee: bot }).length });
        });

        // ── add：校验 → 入库 → 推 changed ───────────────────────────────
        socket.on('board:add', (job, cb) => {
            try {
                // ① 先问"这个技能在注册表里存在吗"（全局第一道）
                const v = validateIncomingJob(job, { registry, validateArgs });
                if (!v.ok) return ack(cb, { ok: false, reason: v.reason });

                // ①b 再问"这只 bot 上报过它吗"（第二道，按 bot 的能力）
                //   顺序有讲究：先说"没这个技能"，再说"你的 bot 不会这个"——
                //   反过来的话，一个根本不存在的技能名会报成"你的 bot 没上报过它"，
                //   排查方向就错了（去找 bot 的能力表，而实际是名字写错了）。
                const assignee = v.job.assignee ?? null;
                if (assignee && botRegistry.has(assignee)) {
                    const reg = botRegistry.get(assignee);
                    if (!reg.skills.has(String(v.job.skill))) {
                        return ack(cb, { ok: false, reason: `「${assignee}」没上报过技能「${v.job.skill}」` });
                    }
                }

                const created = addJob(db, v.job, { now: now() });
                changed(created, 'added');
                ack(cb, { ok: true, id: created.id, job: created });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ── list ────────────────────────────────────────────────────────
        socket.on('board:list', (filter, cb) => {
            try {
                const f = filter ?? {};
                const states = f.state ? [f.state] : (Array.isArray(f.states) ? f.states : null);

                // ★ 2026-11-02（t23，captain 拍板）：`scope` 是**显式契约**，不许靠隐式过滤穿透。
                //
                //   为什么要有它：客户端原来只会发 `{mine: 自己}`，服务端 `assignee = 自己` 一过滤，
                //   **共享单（assignee=null）与别的 bot 的单永远拿不到** → 抢占/残局回收对
                //   真实场景（别人挂的 9 级单）完全不生效，而且**不报错**。
                //   （"验证场景选错 → 缺陷被绿灯放过"：它只验了"我自己的两张单"。）
                //
                //   语义（三档，**未知 scope 必须报错**，不许默默当成 mine 或 all）：
                //     mine      —— 只看指派给我的（默认，保持旧语义）
                //     claimable —— 可领的：**共享单（assignee 为空）+ 指派给我的**（与 claimFor 候选一致）
                //     all       —— 全部（仅面板/调试用）
                const scope = f.scope ?? 'mine';
                let listFilter;
                if (scope === 'mine') {
                    listFilter = { assignee: f.mine ?? null };
                } else if (scope === 'claimable') {
                    listFilter = { claimableFor: f.mine ?? null };
                    if (!listFilter.claimableFor) return ack(cb, { ok: false, reason: "scope='claimable' 需要 mine（bot 名）" });
                } else if (scope === 'all') {
                    listFilter = {};
                } else {
                    return ack(cb, { ok: false, reason: `未知 scope「${scope}」（只能是 mine / claimable / all）` });
                }

                // ★★★ T30 第14条：**`openOnly` 必须在 SQL 里过滤**。
                //   `scope='claimable'` 的用途是"抢占判定 / 残局回收"，它绝不能
                //   被 200 张已完成的历史单挤出窗口（`jobs` 表从不删除，
                //   `LIMIT 200` + "同级取最老" ⇒ 新单永远进不了视野，且不报错）。
                const jobs = listJobs(db, {
                    states,
                    ...listFilter,
                    skill: f.skill ?? null,
                    openOnly: f.openOnly === true || scope === 'claimable',
                    limit: f.limit,
                });
                ack(cb, { ok: true, jobs, scope });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ── get（控制层契约里有它）───────────────────────────────────────
        //
        // ★ 2026-11-02 真机验收抓到的 bug：这里原来写 `(id, cb)`，即要求 payload 是**裸 id**，
        //   而 client 发的是 `{ id }`（和其余所有事件一致）→ `String({id})` 变成
        //   "[object Object]" → getJob 恒返回 null。
        //   症状很隐蔽：`board.get()` 永远拿到 null，控制层的 `resolveJob` 就恒走降级 ——
        //   与"没有板"看起来一模一样，但板是好的。
        //   现在两种形状都认（裸 id 也兼容），免得以后有人按旧形状调用。
        socket.on('board:get', (payload, cb) => {
            try {
                const id = (payload && typeof payload === 'object') ? payload.id : payload;
                ack(cb, { ok: true, job: getJob(db, String(id ?? '')) });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ── claim：原子领单 ─────────────────────────────────────────────
        socket.on('board:claim', (payload, cb) => {
            try {
                const bot = String(payload?.bot ?? '').trim();
                if (!bot) return ack(cb, { ok: false, reason: '缺少 bot' });
                // ★ B3（06 §9.4）：用**服务端记下的** roles 做资格判断，
                //   不信任 agent 传来的 roles（socket 外部可达，可以自己说自己是 miner）。
                const reg = botRegistry.get(bot);
                const job = claimFor(db, bot, {
                    now: now(),
                    roles: reg?.roles ?? [],
                    items: Array.isArray(payload?.items) ? payload.items : [],
                });
                if (job) changed(job, 'claimed');
                ack(cb, { ok: true, job });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ── heartbeat：续租 + 进度 ──────────────────────────────────────
        socket.on('board:heartbeat', (payload, cb) => {
            try {
                const r = heartbeat(db, String(payload?.id ?? ''), String(payload?.bot ?? ''), {
                    now: now(), progress: payload?.progress ?? null,
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code ?? 'LEASE_LOST' });
                // ★ B3：心跳同时也是**预约续期**的时刻（06 §9.2 "跟着 heartbeat 续期"）
                try { renewClaims(db, String(payload?.id ?? ''), { now: now() }); } catch { /* 续不上不影响心跳 */ }
                ack(cb, { ok: true, job: r.job });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ── checkpoint：存断点（不动状态）─────────────────────────────
        socket.on('board:checkpoint', (payload, cb) => {
            try {
                const r = updateJob(db, String(payload?.id ?? ''), { checkpoint: payload?.checkpoint ?? null }, { now: now() });
                ack(cb, r.ok ? { ok: true } : { ok: false, reason: r.message ?? r.code });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ── finish：按结果决定去哪（规则②③在 store 里）──────────────────
        socket.on('board:finish', (payload, cb) => {
            try {
                // ★★★ T30 第4条：**必须把 bot 传下去** —— `finish()` 要用它做租约归属校验。
                //   不传就等于"谁都能改任何单的状态"：租约过期的旧持有者能把别人
                //   正在跑的单写回 ready（两个 bot 抢同一张单）。
                const r = finish(db, String(payload?.id ?? ''), payload?.result ?? {}, {
                    now: now(), bot: payload?.bot ?? null,
                });
                if (!r.ok) return ack(cb, { ok: false, reason: r.message ?? r.code });
                changed(r.job, `finish:${r.next}`);
                // ★ B3：单结束了就放掉它的预约（失败/完成都不该再占着资源）
                try { release(db, r.job.id, r.job.lease?.owner ?? String(payload?.bot ?? ''), null); } catch { /* ignore */ }
                // ★ B3：父子收敛（06 §9.1）—— 有 parentId 就顺手推进父单
                if (r.job.parentId) {
                    // ★ t83：**先**把"材料已到、之前被 NO_ITEM 卡住的兄弟"放回 ready，
                    //   再 rollup —— 否则它们永远是终态 blocked，父单跟着 blocked
                    //   （第 28 跑：crafting_table 的依赖已 done 却仍 blocked）
                    try {
                        const reopened = reopenBlockedWithSatisfiedDeps(db, r.job.parentId, { now: now() });
                        for (const j of reopened) changed(j, 'reopened:deps-satisfied');
                    } catch { /* ignore */ }
                    try {
                        const up = rollupParent(db, r.job.parentId, { now: now() });
                        if (up.changed) changed(up.parent, `rollup:${up.reason}`);
                    } catch { /* ignore */ }
                }
                ack(cb, { ok: true, job: r.job, next: r.next, counted: r.counted });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ── set-state：cancel / pause / resume / 被抢占退回 ─────────────
        socket.on('board:set-state', (payload, cb) => {
            try {
                const r = setState(db, String(payload?.id ?? ''), String(payload?.state ?? ''), { now: now() });
                if (!r.ok) return ack(cb, { ok: false, reason: r.message ?? r.code });
                changed(r.job, payload?.reason ?? 'set-state');
                ack(cb, { ok: true, job: r.job });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ── reserve / release：预约（B3，06 §9.2）──────────────────────
        //
        // ack 形状与 06 §14 对齐：ok 时 `{ok:true, reserved|released, until}`；
        // 冲突时 `{ok:false, code:'CLAIM_CONFLICT', conflicts:[...]}` —— 流程按 onFail 换目标。
        socket.on('board:reserve', (payload, cb) => {
            try {
                const id = String(payload?.id ?? '');
                const owner = String(payload?.owner ?? '').trim();
                if (!id || !owner) return ack(cb, { ok: false, reason: '缺少 id/owner' });
                const r = reserve(db, id, owner, payload?.keys ?? [], { now: now() });
                ack(cb, r.ok
                    ? { ok: true, reserved: r.reserved, until: r.until }
                    : { ok: false, code: r.code, conflicts: r.conflicts, reason: r.message });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        socket.on('board:release', (payload, cb) => {
            try {
                const id = String(payload?.id ?? '');
                const owner = String(payload?.owner ?? '').trim();
                if (!id || !owner) return ack(cb, { ok: false, reason: '缺少 id/owner' });
                const r = release(db, id, owner, payload?.keys ?? null);
                ack(cb, { ok: true, released: r.released });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ── checkpoint 读写（makeCtx 的 ctx.checkpoint/save 走这两个）──────
        socket.on('board:get-checkpoint', (payload, cb) => {
            try {
                const job = getJob(db, String(payload?.id ?? ''));
                if (!job) return ack(cb, { ok: false, reason: '没有这张单' });
                const key = String(payload?.key ?? 'default');
                const cp = job.checkpoint ?? null;
                ack(cb, { ok: true, checkpoint: (cp && typeof cp === 'object') ? (cp[key] ?? null) : cp });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        socket.on('board:save-checkpoint', (payload, cb) => {
            try {
                const id = String(payload?.id ?? '');
                const job = getJob(db, id);
                if (!job) return ack(cb, { ok: false, reason: '没有这张单' });
                const key = String(payload?.key ?? 'default');
                const cur = (job.checkpoint && typeof job.checkpoint === 'object') ? job.checkpoint : {};
                const r = updateJob(db, id, { checkpoint: { ...cur, [key]: payload?.value ?? null } }, { now: now() });
                ack(cb, r.ok ? { ok: true } : { ok: false, reason: r.message ?? r.code });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ── 诊断：这张单持有哪些预约 ──────────────────────────────────
        socket.on('board:claims', (payload, cb) => {
            try { ack(cb, { ok: true, claims: listClaims(db, payload?.id ? String(payload.id) : null) }); }
            catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ── 共享数据（B4，06 §9.3）：地标 / 危险点 / 箱子内容 ────────────
        //
        // 只有 mindserver 写库（与任务单同一原则）。agent 一律经这里读写，
        // **不许绕过板库直接读 bots/<name>/memory/*.json**（否则又是两条路径）。
        socket.on('board:shared-put', (payload, cb) => {
            try {
                const r = putShared(db, String(payload?.kind ?? ''), payload?.key, payload?.value, {
                    now: now(), owner: payload?.owner ?? null,
                });
                ack(cb, r.ok ? { ok: true } : { ok: false, reason: r.message ?? r.code });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        socket.on('board:shared-list', (payload, cb) => {
            try { ack(cb, { ok: true, items: listShared(db, payload?.kind ? String(payload.kind) : null) }); }
            catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        socket.on('board:shared-get', (payload, cb) => {
            try { ack(cb, { ok: true, item: getShared(db, String(payload?.kind ?? ''), payload?.key) }); }
            catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        socket.on('board:shared-del', (payload, cb) => {
            try { ack(cb, { ok: true, deleted: delShared(db, String(payload?.kind ?? ''), payload?.key).deleted }); }
            catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ★ B4 验收用的那条查询：**不开箱**就知道哪个箱子有这个物品
        socket.on('board:shared-find-item', (payload, cb) => {
            try { ack(cb, { ok: true, hits: findItemInSharedChests(db, payload?.item, { minCount: payload?.minCount }) }); }
            catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ── update：控制层契约里的 update(id, patch) ────────────────────
        socket.on('board:update', (payload, cb) => {
            try {
                const r = updateJob(db, String(payload?.id ?? ''), payload?.patch ?? {}, { now: now() });
                if (!r.ok) return ack(cb, { ok: false, reason: r.message ?? r.code });
                changed(r.job, 'updated');
                ack(cb, { ok: true, job: r.job });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });
    });

    // ── 租约过期扫描（06 §6：掉线的 bot 30 秒后单子自动回 ready）───────
    const scanTimer = setInterval(() => {
        try {
            const recovered = expireLeases(db, now());
            for (const id of recovered) changed(getJob(db, id), 'lease-expired');
            // ★ B3：顺带清过期预约（bot 掉线后它的预约要自动释放，06 §9.2）
            try { expireClaims(db, now()); } catch { /* ignore */ }
            // ★★★ t140：**父单兜底收敛** —— 见 `convergeOrphanParents` 的注释。
            //   真机第 59 跑：第一夜 5 张子单全 done，父单却永远 running（就差这一步闭环）。
            //   事件驱动的 rollup 只要漏一次时间窗，就再也没人重试 → 必须定期扫。
            try {
                for (const p of convergeOrphanParents(db, { now: now() })) {
                    changed(p, 'rollup:sweep-orphan-parent');
                }
            } catch { /* 兜底失败不该让进程崩 */ }
            // ★★★ t142：**blocked 单兜底重开** —— 同 `convergeOrphanParents` 的理由：
            //   `reopenBlockedWithSatisfiedDeps` 只挂在 `board:finish` 上（纯事件驱动），
            //   事件漏一次，"依赖已满足的 blocked 单"就永远不重开且不报错。
            try {
                for (const j of reopenOrphanBlocked(db, { now: now() })) {
                    changed(j, 'reopen:sweep-orphan-blocked');
                }
            } catch { /* 兜底失败不该让进程崩 */ }
            // ★★★ T30 第5条：**依赖已死** → blocked + DEP_DEAD。
            //   现场：依赖死掉的单永久 ready、父单永久 running（最长卡 166 分钟）。
            //   `dependsSatisfied` 只认 done，"永远好不了"和"还没好"在库里长得一样，
            //   所以必须有这条主动扫描，否则没有任何路径会再碰它。
            try {
                for (const j of sweepDeadDepJobs(db, { now: now() })) {
                    changed(j, 'blocked:dep-dead');
                }
            } catch { /* 兜底失败不该让进程崩 */ }
            // ★★★ T30 第17条：**幽灵父单**（拆单中途崩溃 → 永久 running 且无子单）。
            //   `convergeOrphanParents` 明确跳过无子单的父单，所以这种壳单没人管；
            //   落成 blocked + ORPHAN_PARENT 让它在面板上"显形"，而不是永远"正在跑"。
            try {
                for (const j of blockOrphanParents(db, { now: now() })) {
                    changed(j, 'blocked:orphan-parent');
                }
            } catch { /* 兜底失败不该让进程崩 */ }
        } catch { /* 扫描失败不该让进程崩 */ }
    }, SCAN_MS);
    try { scanTimer.unref?.(); } catch { /* 不让定时器阻止进程退出 */ }

    return {
        stop() { try { clearInterval(scanTimer); } catch { /* ignore */ } },
        /** 诊断：谁上报了什么能力。 */
        registrySnapshot() { return new Map(botRegistry); },
    };
}

/** 状态常量再导出（服务端与 client 共用同一份，避免字符串两处写）。 */
export { JOB_STATE };
