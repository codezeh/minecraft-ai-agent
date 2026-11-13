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
    expireLeases, JOB_STATE, isTerminal,
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
    // ★ T31 第16条：箱子内容的**原子合并**（读-改-写在服务端一次做完）
    mergeSharedChest, SHARED_CHEST_KIND,
    // ★ R6 #16：`list` 的 limit 上限 + 未终结单计数（限流/上限判据）
    LIST_LIMIT_MAX, countOpenJobs,
    // ADR 阶段 3 / D13：队伍三张表（team / team_member / team_chest）
    createTeam, joinTeam, leaveTeam, listTeams, addTeamChest, listTeamChest,
} from './board_store.js';
// ADR 阶段 3 / D7：共享库存（预占 / 结算 / 对账 / 缓存）
import {
    refreshContainerCache, markContainerDirty, reserveStock, settleTake, stockIn, releaseReservation,
    reconcileContainers, inventorySnapshot, inventoryLedger, expireReservations,
} from './board_inventory.js';
// ★ BOARD-002：归一化 agent 随 claim 上报的"我身上有什么"（跨 client/server 共用的纯函数）
import { normalizeReportedItems, normalizeClaimKeys } from './board_claims.js';
// ★ t2（2026-11-13）：team.*/inventory.* 结算写 events（**旁路审计索引**，events.md §11-2/3）。
//   `recordEvent` 是全仓唯一事件写入口（global_store.js 是表结构的唯一拥有者），这里只转调。
//   ⚠ 静态 import 是安全的：`openGlobalDb()` 是惰性的，没有业务动作就不会建库/写盘。
import { recordEvent } from '../../mindcraft/global_store.js';

/**
 * 箱子键（`x,y,z`）：events 里"哪一格"的粗粒度索引，与 inventory 的容器坐标同口径。
 * 接受两种形状：容器对象 `{x,y,z}`，或已经是键字符串 `"x,y,z"`（`inventory:store` 的 `chestKey` 就是后者）。
 * 坐标不合法 ⇒ null（事件里就只留 item/qty，不编一个 0,0,0 假装知道位置）。
 */
export function chestKeyOf(container) {
    if (typeof container === 'string') {
        const s = container.trim();
        return /^-?\d+,-?\d+,-?\d+$/.test(s) ? s : null;
    }
    const c = container && typeof container === 'object' ? container : null;
    if (!c) return null;
    const p = [c.x, c.y, c.z].map((v) => Number(v));
    if (p.some((v) => !Number.isFinite(v))) return null;
    return p.map((v) => Math.trunc(v)).join(',');
}

/**
 * ★ t2：事件写入口（**本文件唯一**，`tools/wiring_board_events_unit.mjs` 直接扫源码钉住调用条数）。
 *
 * events 只是"发生过什么"的**旁路审计索引**，不是业务事实的来源。三条硬口径：
 *   ① **返回值不参与业务判断**：写失败/抛错只进日志，调用点一律 `void ev(...)`；
 *   ② **worldId 拿不到就不写**：绝不填 'default'/'unknown'/当前世界之类的兜底 ——
 *      假 worldId 会让复盘把事件归错档，**比没有事件更糟**（events.md §2）；
 *   ③ 单测注入点：`attachBoardServer({ recordEvent })`，用来证明"写失败不影响业务"。
 *
 * ★ 参数名用 `evCtx` 而**不是** `ctx`：`ctx` 在 `deps_injection_audit.mjs` 里专指
 *   `composite_registry.makeCtx()` 返回的那个对象（审计 B 档按 `ctx.` 前缀识别"单测注入、
 *   生产不注入"的死分支）。这里传的是**每次调用的旁路元数据**（worldId/avatarId/sourceIp），
 *   跟 makeCtx 无关；叫 ctx 会让审计把它当死分支误报（实测过一次），也会让下一个人误以为
 *   有一条 ctx 注入链。见 docs/audit-r6/fixes4/wiring-board.md §2 注。
 *
 * @param {(kind:string, payload:object, evCtx:object)=>any} recorder  recordEvent 或测试假实现
 * @returns {{ok:boolean, reason?:string, kind:string, id?:string|null}} 仅供日志/测试，**不许**拿来做分支
 */
export function recordBoardEvent(recorder, kind, payload, evCtx = {}) {
    const head = { kind: kind == null ? String(kind) : String(kind) };
    if (typeof recorder !== 'function') {
        // 没有记录器 = 这个部署不接 events：静默跳过，不炸业务
        return { ok: false, reason: 'no-recorder', ...head };
    }
    const worldId = evCtx?.worldId == null ? '' : String(evCtx.worldId).trim();
    if (!worldId) {
        // 没有存档维度 = 不知道该记到哪个档 ⇒ 不写（**绝不**兜底成 'default'）
        return { ok: false, reason: 'no-world-id', ...head };
    }
    try {
        const r = recorder(kind, payload == null ? {} : payload, { ...evCtx, worldId });
        if (r?.ok === true) return { ok: true, id: r.id ?? null, ...head };
        try { console.warn(`[board] 事件未落库 kind=${kind} world=${worldId}：${r?.reason ?? 'unknown'}`); } catch { /* 日志崩了就算了 */ }
        return { ok: false, reason: r?.reason ?? 'unknown', ...head };
    } catch (e) {
        try { console.warn(`[board] 事件写入异常 kind=${kind} world=${worldId}：${String(e?.message ?? e)}`); } catch { /* 同上 */ }
        return { ok: false, reason: 'threw', ...head };
    }
}

/** 单个 bot 上报的能力（`board:hello` 记下来，用于校验 add 的 skill）。 */
// bot -> { skills:Set, roles:[], rolesSource, at, socketId }
// ★ R6 #24：有上限（满则拒绝）；连接断开即摘掉（见 disconnect）。
//   `roles` 是 **hello 自报的提示**，不是授权依据（board.md #24 写清了残留）。
const botRegistry = new Map();
export const MAX_REGISTERED_BOTS = 64;

/** 心跳/租约扫描间隔（06 §6：租约 30 秒，每 10 秒续租；这里 5 秒扫一次过期）。 */
const SCAN_MS = 5000;

/** `board:add` 允许客户端指定的状态（现有合法调用只用到这三种，R6 #20）。 */
export const ADD_ALLOWED_STATES = Object.freeze(['pending', 'ready', 'running']);
export const ADD_MAX_ATTEMPTS_MAX = 10;

/** `board:add` 字段校验（R6 #20）：归一化合法字段，非法即拒。 */
export function validateAddFields(job) {
    const out = {};
    if (job.state != null) {
        const st = String(job.state);
        if (!ADD_ALLOWED_STATES.includes(st)) {
            return { ok: false, reason: `board:add 不接受 state="${st}"（只能是 ${ADD_ALLOWED_STATES.join('/')}）` };
        }
        out.state = st;
    }
    if (job.maxAttempts != null) {
        const n = Number(job.maxAttempts);
        if (!Number.isInteger(n) || n < 1 || n > ADD_MAX_ATTEMPTS_MAX) {
            return { ok: false, reason: `maxAttempts 必须是 1-${ADD_MAX_ATTEMPTS_MAX} 的整数（现在 ${job.maxAttempts}）` };
        }
        out.maxAttempts = n;
    }
    if (job.parentId != null) {
        const p = String(job.parentId).trim();
        if (!p) return { ok: false, reason: 'parentId 不能是空字符串' };
        out.parentId = p;
    }
    if (job.assignee != null) {
        const a = String(job.assignee).trim();
        if (!a || a.length > 64 || /[\s\u0000-\u001f]/.test(a)) {
            return { ok: false, reason: `assignee 不合法（收到 ${JSON.stringify(job.assignee)}）` };
        }
        out.assignee = a;
    }
    if (job.claims != null) {
        const norm = normalizeClaimKeys(job.claims);
        if (!norm.ok) return { ok: false, reason: `claims 里有非法 key：${norm.error}` };
        out.claims = norm.keys;
    }
    if (out.state === 'running' && out.assignee == null) {
        return { ok: false, reason: "state='running' 必须同时给 assignee（无主的 running 单没人敢收）" };
    }
    return { ok: true, fields: out };
}

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
    // ② R6 #20：state/parentId/assignee/maxAttempts/claims 不再放行
    const fields = validateAddFields(job);
    if (!fields.ok) return { ok: false, reason: fields.reason };
    return { ok: true, job: { ...job, ...fields.fields, skill, priority, kind: job.kind ?? 'personal' } };
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

    /**
     * 这块板库属于哪个存档（ADR D6）：反解实现**只在 world_store 一处**，这里只转调。
     * ★ 用 `worldIdOfBoardDb(库路径)` 而不是 `currentWorldId()`：队伍表就在**这块库**里，
     *   问"当前世界是谁"会把 A 存档的库当成 B 世界；而且 currentWorldId 会顺手建 sidecar（写副作用）。
     * ★ 拿不到就抛（调用方翻成 NO_BOARD），**不许**给 'default' 之类兜底：那会把队伍安静地记到
     *   "单库单世界"上，等分存档那天才爆 —— 见 docs/audit-r6/fixes4/team.md。
     * ★ `deps.worldIdOf` 是给单测的注入点（同步/异步都接受）。
     */
    const boardFilePathOf = () => {
        try {
            const main = db.prepare('PRAGMA database_list').all().find((r) => String(r.name) === 'main');
            return main?.file ? String(main.file) : null;
        } catch { return null; }
    };

    const worldIdResolver = typeof deps.worldIdOf === 'function'
        ? deps.worldIdOf
        : async () => {
            const mod = await import('../../mindcraft/world_store.js');
            const fn = mod.worldIdOfBoardDb;
            if (typeof fn !== 'function') throw new Error('world_store 没有导出 worldIdOfBoardDb()');
            const file = boardFilePathOf();
            if (!file) throw new Error('拿不到板库文件路径（内存库/尚未落盘）：无法判断这块库属于哪个存档');
            return fn(file);            // 解析不出会抛 WORLD_ID_UNRESOLVABLE，上层翻成 NO_BOARD
        };

    /**
     * 这条连接是不是"访客"（ADR D7-6）。**只认服务端注入的判定**，绝不读 payload.visitor
     * —— 客户端自己说"我是访客"就等于自己给自己免账。
     * ★ 阶段 4 接访问凭证后由 mindserver 注入；在此之前默认 false（没有连接会被判成访客）。
     */
    const isVisitor = async (socket, bot, worldId) => {
        if (typeof deps.isVisitor !== 'function') return false;
        try {
            // await 是必需的：注入方（阶段 4 的凭证判定）可能是异步查库
            return (await deps.isVisitor({ socket, bot, worldId })) === true;
        } catch { return false; }
    };

    /**
     * ★ t2：事件写入口（旁路）。`deps.recordEvent` 只给单测注入，默认就是 global_store 的 recordEvent。
     * 调用点一律 `void ev(...)`：返回值**不读**，写失败只进日志（events.md §11 硬约束 1）。
     */
    const ev = (kind, payload, evCtx) => recordBoardEvent(
        typeof deps.recordEvent === 'function' ? deps.recordEvent : recordEvent, kind, payload, evCtx,
    );

    /** 统一的 ack 包装：把内部 {ok,code} 转成 ack 形状，并保证**永远**回 ack（不许卡死客户端）。 */
    const ack = (cb, payload) => {
        try { cb?.(payload); } catch { /* ack 抛错不影响服务端 */ }
    };

    /** 单子变了就推一条 `board:changed`（06 §14：mindserver → agent 只推这一个）。 */
    const changed = (job, reason = '') => {
        if (job) broadcast('board:changed', { id: job.id, state: job.state, priority: job.priority, reason });
    };

    // ══════════════════════════════════════════════════════════════════════
    // R6 #3：**服务端可验证的身份**（不是"检查有没有发 token"）
    //
    // 病根：原来每个事件都直接信 `payload.bot` / `payload.owner` ——
    //   任何连上来的 socket 都能自称是任意 bot，A 可以替 B 领单、结单、放预约、删共享数据。
    //   而 board_store 里那些归属校验（lease.owner / attemptSeq）**挡不住冒充**：
    //   它们校验的是"你报的名字是不是持有者"，不是"你真的是不是你报的名字"。
    //
    // 现在分两层，**哪一层能做多少就写多少**：
    //   ① **绑定（真实、但这层依赖握手）**：连接在 `board:hello` 里声明自己代表哪只 bot，
    //      之后所有事件只能以**声明过的** bot 身份行动。agent 连接（`socket.data.role ===
    //      'agent'`，由握手门写入，见 mindserver/auth_gate）**只允许绑定一只 bot 且绑定后
    //      不可更改** —— 这是"一个 agent 子进程 = 一只 bot"的拓扑。
    //   ② **归属（不依赖传输层，任何人可验）**：改一张正被租用的单，必须就是那个租约持有者。
    //      这层即使身份被冒充也仍然有效（冒充者还是得先拿租约）。
    //
    // ★ 这个缺口**已经补上了**（2026-11-13 复核发现该注释过期，在此更正）：
    //   `board:hello` 曾经没有密码学凭据来证明"我真的是 alpha"——那时一个能连上 mindserver
    //   的客户端可以 hello 成别人的名字。现在有两层：
    //     ① **传输层**：mindserver 给每只 agent 发**独立凭据**（`registerCredential`），
    //        握手时 `makeHandshakeGate` 定角色，`claimAgentChannel` 校验"这份凭据属于这个名字"；
    //     ② **本文件**：`bindBot` 强制 `socket.data.agentName` 与 hello 的名字**对账**（:363 起），
    //        且拒换绑。
    //   ⚠ 但**在线下模式（online-mode=false）仍不能防冒名**：名字是客户端自报的、uuid 由名字派生，
    //     任何人用成员名字登录就成为该成员。这条是 D9 的已知边界，别把本文件的校验当成身份隔离。
    //   职责分工：**传输层认证 = mindserver；本文件的归属校验 + 身份绑定 = 本文件**。
    // ══════════════════════════════════════════════════════════════════════

    const ROLE_AGENT = 'agent';
    // ★ ADR 阶段 1：与 auth_gate.js 的 ROLE_PANEL 同值。本文件刻意**不 import**
    //   那两个常量（避免把 auth_gate 的运行时依赖拖进任务板层），只用字面量对齐。
    const ROLE_PANEL = 'panel';

    // ── 错误码口径（为什么只有 NO_PERMISSION / TOO_MUCH 两个）─────────────
    //   `contract.js` 的 `CODES` 是**全仓唯一**的错误码表，未注册的码会让
    //   `fail()` 抛异常、也会被启动自检判红。本文件只允许产出**已注册**的码，
    //   所以这三类拒绝都折到两个已注册码上，**具体原因靠 `reason` 说清**：
    //     · 身份不符 / 没 hello / 不是自己的共享数据 → `NO_PERMISSION`（处置：停手，别重试）
    //     · 下单过快 / 未终结单满 / limit 越界           → `TOO_MUCH`（处置：退避或改参数）
    //   想要更细的码（RATE_LIMITED / IDENTITY_MISMATCH / BAD_LIMIT…）必须
    //   **同时**做三件事：注册进 contract.js 的 CODES、在 board_client 的
    //   `contractCodeOf` 里映射、更新错误码审计 —— 那是另一条任务（t1/t4 的接口范畴），
    //   不在本条的写作用域里。**不要**为了"码好看"在这里造未注册码。

    /** R6 #24：登记表准入 —— 满了就淘汰最久没 hello 的，仍满则拒绝（不无限增长）。 */
    const registryAdmit = (bot) => {
        if (botRegistry.has(bot) || botRegistry.size < MAX_REGISTERED_BOTS) return { ok: true };
        // 先收掉没有连接挂着的残留（正常情况下 disconnect 已经清过）
        for (const [name, reg] of botRegistry) {
            if (reg.socketId == null) botRegistry.delete(name);
        }
        if (botRegistry.size < MAX_REGISTERED_BOTS) return { ok: true };
        try { console.warn(`[board] 登记表已满（${MAX_REGISTERED_BOTS}），拒绝新的 hello（R6 #24）`); } catch { /* ignore */ }
        return { ok: false, reason: 'registry-full' };
    };

    /** 拿（必要时创建）socket 上的身份状态。 */
    const identityOf = (socket) => {
        if (!socket) return { role: '', bots: new Set() };
        if (!socket.data || typeof socket.data !== 'object') socket.data = {};
        if (!(socket.data.boardBots instanceof Set)) socket.data.boardBots = new Set();
        return { role: String(socket.data.role ?? '').toLowerCase(), bots: socket.data.boardBots };
    };

    /**
     * `board:hello` 的绑定步骤（见上面 ① ）。
     * @returns {{ok:true, role:string} | {ok:false, code:string, reason:string}}
     */
    const bindBot = (socket, bot) => {
        const { role, bots } = identityOf(socket);
        if (role === ROLE_AGENT) {
            // ★★ R6 #3（2026-11-10，t1 的握手门落地后）：**名字的来源换成服务端裁决的戳**。
            //   `socket.data.agentName` 由 `bindAgentChannel()` 在 `login-agent` /
            //   `connect-agent-process` 成功后写入 —— 它已经过 `claimAgentChannel` 的
            //   **唯一占用裁决 + 接管限速**，是**服务端判定**的结果，不是 payload 自述。
            //   所以这里不再"信 payload 里的 bot"，而是拿它跟戳**对账**：
            //     · 不一致 → 拒（这正是"一个 agent 进程冒充另一只 bot"的那一步）
            //     · 戳为空 → 拒（还没 login-agent，就没有可信名字；宁可报错让人先握手）
            //   ★ ADR 阶段 1（2026-11-11）：**per-agent 凭据已经落地**。
            //     每只 bot 一条独立凭据并在 auth_gate 里登记归属；`claimAgentChannel`
            //     会把"凭据属于谁"与"申请占用谁的名字"对账，不一致就 `identity-mismatch` 拒。
            //     所以 `socket.data.agentName` 现在背后有**两重**服务端依据：
            //     ① 凭据归属（这份凭据是不是它的）② 唯一占用裁决（这一刻有没有别人占着）。
            //     这里保留"对账 payload 与戳"是因为客户端仍可能拼错名字，属于输入校验。
            const stamped = String(socket.data?.agentName ?? '').trim();
            if (!stamped) {
                return {
                    ok: false, code: 'NO_PERMISSION',
                    reason: '这条 agent 连接还没完成 agent 握手（socket.data.agentName 为空）：先 login-agent 再来 board:hello',
                };
            }
            if (stamped !== bot) {
                return {
                    ok: false, code: 'NO_PERMISSION',
                    reason: `服务端裁决的 agent 名是「${stamped}」，不能声明成「${bot}」`,
                };
            }
            // 一个 agent 连接只能代表一只 bot：绑定后不可换人（防"先 hello 成 alpha，再改成 beta"）
            const bound = [...bots][0] ?? null;
            if (bound && bound !== bot) {
                return {
                    ok: false, code: 'NO_PERMISSION',
                    reason: `这条 agent 连接已绑定「${bound}」，不能再次声明成「${bot}」`,
                };
            }
            bots.clear();
            bots.add(bot);
            return { ok: true, role };
        }
        // 面板/控制层（以及夹具）：一条连接可以替多只 bot 声明，但只能用它声明过的名字行动
        bots.add(bot);
        return { ok: true, role };
    };

    /**
     * 解析"这条连接此刻以哪只 bot 的身份说话"，并校验它**声明过**这个名字。
     *
     * 顺序：`payload.bot` → `payload.owner`（不同事件用不同字段名）。
     * agent 连接没发过 hello、或声明里没有这个名字 → 直接拒。
     *
     * @returns {{ok:true, bot:string, role:string} | {ok:false, code:string, reason:string}}
     */
    const actingBot = (socket, payload, field = null) => {
        const { role, bots } = identityOf(socket);
        const raw = field ? payload?.[field] : (payload?.bot ?? payload?.owner);
        const claimed = String(raw ?? '').trim();
        if (role === ROLE_AGENT) {
            if (!claimed) {
                // agent 连接只有一只 bot 时可以不写（省得每个事件都带名字），但必须已 hello 过
                if (bots.size === 1) return { ok: true, bot: [...bots][0], role };
                return { ok: false, code: 'NO_PERMISSION', reason: '这条 agent 连接还没发 board:hello，无法确定身份' };
            }
            if (!bots.size) {
                return { ok: false, code: 'NO_PERMISSION', reason: '这条 agent 连接还没发 board:hello，无法确定身份' };
            }
            if (!bots.has(claimed)) {
                return {
                    ok: false, code: 'NO_PERMISSION',
                    reason: `这条连接代表「${[...bots].join('/')}」，不能以「${claimed}」的身份行动`,
                };
            }
            return { ok: true, bot: claimed, role };
        }
        // ★ ADR 阶段 1：把「未知角色」从"等同面板"里摘出来。
        //   生产路径上每个 socket 都过 makeHandshakeGate，`!role` 会被直接 reject，
        //   所以 null 只可能来自单测桩。但"桩恰好能写生产数据"是危险的默认值，
        //   这里显式拒绝：写事件必须有明确角色（agent 或 panel），未知一律 NO_PERMISSION。
        if (role !== ROLE_PANEL) {
            return {
                ok: false, code: 'NO_PERMISSION',
                reason: `这条连接没有明确角色（role=${role === null ? 'null' : String(role)}）：写事件只接受 agent 或 panel`,
            };
        }
        // 面板 / 控制层：
        //   · 报了名字 → 必须是它 hello 过的（防一条连接在中途换名字）
        //   · 没报名字 → 放行（`!cancelJob` 这种控制层命令本来就不带 bot）
        if (claimed && bots.size && !bots.has(claimed)) {
            return {
                ok: false, code: 'NO_PERMISSION',
                reason: `这条连接还没为「${claimed}」发过 board:hello`,
            };
        }
        return { ok: true, bot: claimed || null, role };
    };

    /**
     * 第二层：**归属校验**（不依赖传输层身份）。
     *
     * 判据：这张单**正被一条未过期的租约持有**，且持有者不是 `bot` → 拒绝。
     * 反过来三种情形放行：无租约（ready/paused/终态）、就是自己、租约已过期（残局清理必须能做）。
     *
     * ★ 只对 agent 连接生效：面板/控制层要能取消、暂停、改任意单（那是功能，不是漏洞；
     *   面板侧的鉴权在 t1 的握手门里）。未知角色（离线夹具/老接线）保持旧行为，
     *   这样"没接上握手门"的部署不会突然全红 —— 但也意味着**这层不是万能的**。
     */
    const assertJobOwner = (socket, bot, jobId) => {
        const { role } = identityOf(socket);
        if (role !== ROLE_AGENT) return { ok: true };
        const id = String(jobId ?? '');
        if (!id) return { ok: true };                       // 让下游按原逻辑报"缺 id"
        let job = null;
        try { job = getJob(db, id); } catch { return { ok: true }; }
        if (!job) return { ok: true };                      // 没这张单 → 下游按原逻辑报错
        const owner = job.lease?.owner ?? null;
        if (!owner || String(owner) === String(bot)) return { ok: true };
        const until = Number(job.lease?.until ?? 0);
        if (until && until <= now()) return { ok: true };    // 过期租约 = 残局，允许清理
        return {
            ok: false, code: 'LEASE_LOST',
            reason: `「${id}」现在由「${owner}」持有（租约未过期），不能由「${bot}」修改`,
        };
    };

    // ── R6 #16：`board:add` 的限流（令牌桶，**按真实来源分桶**）────────────
    //
    // 病根：`board:add` 零限流 —— 一条连接可以在一秒内灌进上千张单，
    //   把调度器视野（LIMIT 200）和历史表一起淹掉，且没有任何人能看出是谁干的。
    // 分桶键：agent 连接 → `bot:<名字>`（同一台机上两只 agent 各算各的）；
    //   其余（面板/控制层）→ 握手地址；都没有 → socket.id。**不再全机共用一个桶**
    //   （共用一个桶 = 一个人刷爆就把所有人打死，限流本身变成攻击面）。
    const ADD_RATE = Object.freeze({ max: 30, windowMs: 60_000 });
    const addBuckets = new Map();          // key -> { tokens, at }
    const ADD_BUCKETS_MAX = 512;           // 防止桶表本身成为内存增长点

    const bucketKeyOf = (socket, bot) => {
        const { role } = identityOf(socket);
        if (role === ROLE_AGENT && bot) return `bot:${bot}`;
        const addr = socket?.handshake?.address;
        if (addr) return `addr:${addr}`;
        return `sock:${socket?.id ?? 'unknown'}`;
    };

    /** 取一个令牌；拿不到就返回还要等多久（毫秒）。 */
    const takeAddToken = (key) => {
        const t = now();
        let b = addBuckets.get(key);
        if (!b) {
            if (addBuckets.size >= ADD_BUCKETS_MAX) {
                // 简单清理：丢掉已经回满的桶（它们等价于"没出现过"）
                for (const [k, v] of addBuckets) {
                    if (t - v.at >= ADD_RATE.windowMs) addBuckets.delete(k);
                }
                if (addBuckets.size >= ADD_BUCKETS_MAX) addBuckets.delete(addBuckets.keys().next().value);
            }
            b = { tokens: ADD_RATE.max, at: t };
            addBuckets.set(key, b);
        }
        const elapsed = Math.max(0, t - b.at);
        b.tokens = Math.min(ADD_RATE.max, b.tokens + (elapsed * ADD_RATE.max) / ADD_RATE.windowMs);
        b.at = t;
        if (b.tokens < 1) {
            const need = (1 - b.tokens) * (ADD_RATE.windowMs / ADD_RATE.max);
            return { ok: false, retryAfterMs: Math.max(1, Math.ceil(need)) };
        }
        b.tokens -= 1;
        return { ok: true, tokens: Math.floor(b.tokens) };
    };

    /** 未终结单上限（R6 #16）：防止"只加不结"把板和调度器一起淹掉。 */
    const MAX_OPEN_JOBS = 500;

    /**
     * `board:list` 的 limit 校验（R6 #16）：负数/超大/非数字一律拒，不静默夹。
     * 错误码用已注册的 `TOO_MUCH`，具体原因在 `reason`（见上方"错误码口径"）。
     */
    const BAD_LIMIT = (raw) => ({
        ok: false, code: 'TOO_MUCH',
        reason: `limit 必须是 1..${LIST_LIMIT_MAX} 的整数（收到 ${JSON.stringify(raw)}）`,
    });
    const checkListLimit = (raw) => {
        if (raw === undefined || raw === null) return { ok: true, limit: undefined };
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > LIST_LIMIT_MAX) return BAD_LIMIT(raw);
        return { ok: true, limit: n };
    };

    io.on('connection', (socket) => {
        // R6 #24：连接断开就摘掉这条连接登记的 bot（原来永不清理，表只增不减）
        socket.on('disconnect', () => {
            for (const [bot, reg] of botRegistry) {
                if (reg.socketId != null && reg.socketId === socket.id) botRegistry.delete(bot);
            }
        });

        // ── hello：记下这只 bot 能干什么（同时**绑定身份**，R6 #3）────────
        socket.on('board:hello', (payload, cb) => {
            const bot = String(payload?.bot ?? '').trim();
            const skills = Array.isArray(payload?.skills) ? payload.skills : [];
            if (!bot) return ack(cb, { ok: false, reason: '缺少 bot' });
            // ★ R6 #3：绑定失败（agent 连接想换人）→ 直接拒，不登记能力
            const bound = bindBot(socket, bot);
            if (!bound.ok) return ack(cb, { ok: false, code: bound.code, reason: bound.reason });
            // R6 #24：先过准入（满 → 淘汰/拒绝），并记下这条登记属于哪个连接（断开时摘掉）
            const admit = registryAdmit(bot);
            if (!admit.ok) {
                return ack(cb, { ok: false, code: 'TOO_MUCH', reason: `已登记 ${botRegistry.size} 只 bot（上限 ${MAX_REGISTERED_BOTS}），拒绝新的 hello` });
            }
            botRegistry.set(bot, {
                skills: new Set(skills),
                roles: payload?.roles ?? [],
                rolesSource: 'hello-self-reported',   // ★ 提示，不是授权依据（R6 #24）
                at: now(),
                socketId: socket.id ?? null,
            });
            ack(cb, { ok: true, jobs: listJobs(db, { assignee: bot }).length, role: bound.role || null });
        });

        // ── add：校验 → 入库 → 推 changed（R6 #16：限流 + 未终结单上限）────
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

                // ② R6 #3：agent 连接只能替**自己**下单（面板块 = 控制层，可以替任意 bot 建单）
                const who = actingBot(socket, job, 'bot');
                const role = identityOf(socket).role;
                if (role === ROLE_AGENT) {
                    if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                    if (assignee && String(assignee) !== who.bot) {
                        return ack(cb, {
                            ok: false, code: 'NO_PERMISSION',
                            reason: `这条连接代表「${who.bot}」，不能把单指派给「${assignee}」`,
                        });
                    }
                }

                // ③ R6 #20：parentId 必须指向存在的、未终结的单；agent 只能挂自己名下的
                if (v.job.parentId) {
                    const parent = getJob(db, String(v.job.parentId));
                    if (!parent) {
                        return ack(cb, { ok: false, code: 'NO_TARGET', reason: `parentId「${v.job.parentId}」不存在` });
                    }
                    if (isTerminal(parent.state)) {
                        return ack(cb, { ok: false, code: 'NO_TARGET', reason: `父单「${parent.id}」已是终态 ${parent.state}，不能再挂子单` });
                    }
                    if (role === ROLE_AGENT && parent.assignee && String(parent.assignee) !== String(who.bot)) {
                        return ack(cb, { ok: false, code: 'NO_PERMISSION', reason: `父单「${parent.id}」属于「${parent.assignee}」` });
                    }
                }
                // ③b R6 #20：agent 只能把单派给已 hello 的 bot（面板是控制层，允许提前指派）
                if (role === ROLE_AGENT && assignee && !botRegistry.has(String(assignee))) {
                    return ack(cb, { ok: false, code: 'NO_PERMISSION', reason: `「${assignee}」没 hello 过，不能把单派给它` });
                }

                // ③ R6 #16：限流（按真实来源分桶）
                const bucket = bucketKeyOf(socket, assignee ?? (who.ok ? who.bot : null));
                const limit = takeAddToken(bucket);
                if (!limit.ok) {
                    return ack(cb, {
                        ok: false, code: 'TOO_MUCH',
                        reason: `下单太频繁（${ADD_RATE.max} 张/${ADD_RATE.windowMs / 1000} 秒），请 ${Math.ceil(limit.retryAfterMs / 1000)} 秒后再试`,
                    });
                }

                // ④ R6 #16：未终结单上限（只加不结会把调度器视野和历史表一起淹掉）
                const open = countOpenJobs(db);
                if (open >= MAX_OPEN_JOBS) {
                    return ack(cb, {
                        ok: false, code: 'TOO_MUCH',
                        reason: `未终结单已达上限 ${MAX_OPEN_JOBS}（现在 ${open} 张）：先结单/取消再下单`,
                    });
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
                // ★ R6 #16：`limit` 先**校验**（负数/超大/非数字一律拒，不静默夹成无上限）。
                //   以前 `limit: f.limit` 直通 store，而 store 里 `Number.isFinite(-1) === true`
                //   ⇒ `LIMIT -1` = **无上限**：一次 list 就能把整张历史表灌进 socket。
                const lim = checkListLimit(f.limit);
                if (!lim.ok) return ack(cb, { ok: false, code: lim.code, reason: lim.reason });
                const jobs = listJobs(db, {
                    states,
                    ...listFilter,
                    skill: f.skill ?? null,
                    openOnly: f.openOnly === true || scope === 'claimable',
                    limit: lim.limit,
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
                // ★ R6 #3：bot 只认**这条连接声明过的**身份（不再直接信 payload.bot）
                const who = actingBot(socket, payload, 'bot');
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const bot = who.bot;
                // 面板/控制层没绑定身份时，「领单」没有对象可领 —— 明确报错，别拿空名字去查
                if (!bot) return ack(cb, { ok: false, code: 'NO_PERMISSION', reason: '缺少 bot' });
                // ★ B3（06 §9.4）：用**服务端记下的** roles 做资格判断，
                //   不信任 agent 传来的 roles（socket 外部可达，可以自己说自己是 miner）。
                const reg = botRegistry.get(bot);
                const job = claimFor(db, bot, {
                    now: now(),
                    roles: reg?.roles ?? [],
                    // ★ BOARD-002：agent 现在会随 claim 上报"我身上有什么"（只报物品名）。
                    //   归一化放在这里：非数组/非字符串/重复/超长一律安静丢弃，
                    //   老客户端不带这个字段时退化成空数组（不崩）。
                    items: normalizeReportedItems(payload?.items),
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
                // ★ R6 #3：身份来自绑定，不信 payload（原来直接 String(payload?.bot ?? '')）
                const who = actingBot(socket, payload, 'bot');
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const r = heartbeat(db, String(payload?.id ?? ''), who.bot ?? '', {
                    now: now(), progress: payload?.progress ?? null,
                    // ★ BOARD-003：带着尝试标识续租，同名重领后旧尝试的心跳必须失效
                    attemptSeq: payload?.attemptSeq ?? null,
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code ?? 'LEASE_LOST' });
                // ★ B3：心跳同时也是**预约续期**的时刻（06 §9.2 "跟着 heartbeat 续期"）
                // ★ T6：必须带上 **owner** —— 不带就等于"谁都能替别人续预约"
                //   （单 id 共享可见）。给了 owner 后 store 会校验租约归属与状态。
                try {
                    renewClaims(db, String(payload?.id ?? ''), { now: now(), owner: who.bot ?? '' });
                } catch { /* 续不上不影响心跳 */ }
                ack(cb, { ok: true, job: r.job });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });

        // ── checkpoint：存断点（不动状态）─────────────────────────────
        socket.on('board:checkpoint', (payload, cb) => {
            try {
                // ★ R6 #3：写别人的单前先过归属校验（租约持有者才行）
                const who = actingBot(socket, payload);
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const own = assertJobOwner(socket, who.bot, payload?.id);
                if (!own.ok) return ack(cb, { ok: false, code: own.code, reason: own.reason });
                const r = updateJob(db, String(payload?.id ?? ''), { checkpoint: payload?.checkpoint ?? null }, {
                    now: now(),
                    // ★ BOARD-003：迟到的 checkpoint 不得写进新尝试
                    attemptSeq: payload?.attemptSeq ?? null,
                });
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
                // ★ R6 #3：bot 取自**连接声明过的身份**，不取 payload（原来任何人填别人的名字即可）。
                const who = actingBot(socket, payload, 'bot');
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const r = finish(db, String(payload?.id ?? ''), payload?.result ?? {}, {
                    now: now(), bot: who.bot,
                    // ★ BOARD-003：带上尝试标识 —— 租约只看名字时，"同名重领"之后
                    //   旧尝试的迟到 finish 会被当成当前尝试的结果接受（报告实测的 staleAccepted）。
                    attemptSeq: payload?.attemptSeq ?? null,
                });
                // ★★★ BOARD-003：**把稳定码带回给调用方**（不能只回 reason）。
                //   原来只回 `{ok:false, reason}` → `BoardClient._call` 拿不到 code，统一折成
                //   `INTERNAL` → agent 侧分不清"租约/尝试已失效（必须立刻停手）"和"内部错误
                //   （可以重试）"。报告要求"旧请求返回**稳定的租约失效结果**"指的就是这个码
                //   要一路传到 agent 侧（离线用例 board003 ⑧ 断言的就是它）。
                if (!r.ok) {
                    return ack(cb, { ok: false, code: r.code ?? 'INTERNAL', reason: r.message ?? r.code });
                }
                changed(r.job, `finish:${r.next}`);
                // ★ B3：单结束了就放掉它的预约（失败/完成都不该再占着资源）
                try { release(db, r.job.id, r.job.lease?.owner ?? who.bot, null); } catch { /* ignore */ }
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
                // ★ R6 #3：身份 + 归属（agent 不能取消/暂停别人正在跑的单；面板可以）
                const who = actingBot(socket, payload);
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const own = assertJobOwner(socket, who.bot, payload?.id);
                if (!own.ok) return ack(cb, { ok: false, code: own.code, reason: own.reason });
                const r = setState(db, String(payload?.id ?? ''), String(payload?.state ?? ''), {
                    now: now(),
                    // ★ BOARD-003 补洞：带尝试标识，旧尝试不能把新尝试的单置 ready/paused（会清掉新租约）
                    attemptSeq: payload?.attemptSeq ?? null,
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message ?? r.code });
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
                // ★ R6 #3：owner 只取**连接声明过的身份**（原来直接信 payload.owner ⇒ 可以替别人占资源）
                const who = actingBot(socket, payload, 'owner');
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const owner = who.bot;
                if (!id || !owner) return ack(cb, { ok: false, reason: '缺少 id/owner' });
                // ★ R6 #3：别人的单正被租着时，不许拿它的 id 去占资源
                const own = assertJobOwner(socket, owner, id);
                if (!own.ok) return ack(cb, { ok: false, code: own.code, reason: own.reason });
                const r = reserve(db, id, owner, payload?.keys ?? [], { now: now() });
                ack(cb, r.ok
                    ? { ok: true, reserved: r.reserved, until: r.until }
                    : { ok: false, code: r.code, conflicts: r.conflicts, reason: r.message });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        socket.on('board:release', (payload, cb) => {
            try {
                const id = String(payload?.id ?? '');
                // ★ R6 #3：同理，owner 只取绑定值（store 里还会校验租约归属）
                const who = actingBot(socket, payload, 'owner');
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const owner = who.bot;
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
                // ★ R6 #3：断点也是"改别人的单" —— 必须有身份 + 归属
                const who = actingBot(socket, payload);
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const own = assertJobOwner(socket, who.bot, id);
                if (!own.ok) return ack(cb, { ok: false, code: own.code, reason: own.reason });
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
                // ★ R6 #3：owner 只取绑定身份 —— 以前 `payload.owner` 直通，谁都能把一条
                //   共享数据记成别人的名字（事后追责全指向错的人）。
                const { role } = identityOf(socket);
                let owner = payload?.owner ?? null;
                if (role === ROLE_AGENT) {
                    const who = actingBot(socket, payload, 'owner');
                    if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                    owner = who.bot;
                }
                const r = putShared(db, String(payload?.kind ?? ''), payload?.key, payload?.value, {
                    now: now(), owner,
                });
                ack(cb, r.ok ? { ok: true } : { ok: false, reason: r.message ?? r.code });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ── ★★★ T31 第16条：`board:shared-merge` ──────────────────────
        //
        // 为什么要有它：箱子内容原来是客户端「读 → 本地叠加 → 写」，
        // **两次往返之间**别的 bot 也能写 → 后写的整份覆盖先写的（丢件，且不报错）。
        // 现在把"读-改-写"收进 store 的一个事务里，客户端只发**增量**。
        socket.on('board:shared-merge', (payload, cb) => {
            try {
                // ★ R6 #3：同 shared-put —— agent 连接只能以自己的名字合并
                const { role } = identityOf(socket);
                let owner = payload?.owner ?? null;
                if (role === ROLE_AGENT) {
                    const who = actingBot(socket, payload, 'owner');
                    if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                    owner = who.bot;
                }
                const r = mergeSharedChest(
                    db, payload?.key, payload?.delta,
                    owner,
                    { now: now(), pos: payload?.pos ?? null },
                );
                ack(cb, r.ok
                    ? { ok: true, item: { kind: SHARED_CHEST_KIND, key: r.key, value: r.value } }
                    // ★ R6 #4：`BOARD_BUSY`（抢不到写锁）必须**如实回给调用方**，不能吞成成功
                    : { ok: false, code: r.code, reason: r.message ?? r.code });
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
            try {
                const kind = String(payload?.kind ?? '');
                const key = payload?.key;
                // ★ R6 #3：删除是**破坏性**动作。面板/控制层可以删任意条；
                //   agent 连接只能删**自己名下**的那条（`shared.owner` 是库里的真实字段，
                //   可查、可验 —— 不是"payload 里自称是谁"）。
                const { role } = identityOf(socket);
                if (role === ROLE_AGENT) {
                    const who = actingBot(socket, payload, 'owner');
                    if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                    const row = getShared(db, kind, key);
                    const rowOwner = row?.owner ?? null;
                    if (rowOwner && String(rowOwner) !== who.bot) {
                        return ack(cb, {
                            ok: false, code: 'NO_PERMISSION',
                            reason: `「${kind}/${key}」是「${rowOwner}」记的，不能由「${who.bot}」删除`,
                        });
                    }
                }
                ack(cb, { ok: true, deleted: delShared(db, kind, key).deleted });
            } catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ★ B4 验收用的那条查询：**不开箱**就知道哪个箱子有这个物品
        socket.on('board:shared-find-item', (payload, cb) => {
            try { ack(cb, { ok: true, hits: findItemInSharedChests(db, payload?.item, { minCount: payload?.minCount }) }); }
            catch (e) { ack(cb, { ok: false, reason: String(e?.message ?? e) }); }
        });

        // ── update：控制层契约里的 update(id, patch) ────────────────────
        socket.on('board:update', (payload, cb) => {
            try {
                // ★ R6 #3：update 能改 assignee/priority/lease 等字段 —— 必须过身份 + 归属
                const who = actingBot(socket, payload);
                if (!who.ok) return ack(cb, { ok: false, code: who.code, reason: who.reason });
                const own = assertJobOwner(socket, who.bot, payload?.id);
                if (!own.ok) return ack(cb, { ok: false, code: own.code, reason: own.reason });
                const r = updateJob(db, String(payload?.id ?? ''), payload?.patch ?? {}, { now: now() });
                if (!r.ok) return ack(cb, { ok: false, reason: r.message ?? r.code });
                changed(r.job, 'updated');
                ack(cb, { ok: true, job: r.job });
            } catch (e) {
                ack(cb, { ok: false, reason: String(e?.message ?? e) });
            }
        });
        // ── 队伍（ADR 阶段 3 / D13）─────────────────────────────────────
        //
        // ★ avatar **只取服务端裁决的身份**（`actingBot` → socket.data.agentName 与
        //   board:hello 绑定对账过），**绝不读 `payload.avatar`**：否则客户端自己说"我是谁"。
        // ★ 诚实边界（别让下一个人以为这里已经鉴权了）：`online-mode=false` 下名字是客户端
        //   自报的 ⇒ 下面这些校验只挡"诚实客户端手滑"，**挡不住冒名**。见 team.md。
        /** 取这条连接此刻的身份；失败直接给出 ack 形状。 */
        const teamActor = (socket, payload) => {
            const who = actingBot(socket, payload);
            if (!who.ok) return { ok: false, ack: { ok: false, code: who.code, reason: who.reason } };
            if (!who.bot) {
                return {
                    ok: false,
                    ack: { ok: false, code: 'NO_PERMISSION', reason: '队伍操作必须说明你是哪只分身（这条连接没发过 board:hello）' },
                };
            }
            return { ok: true, bot: who.bot };
        };

        /** 队伍表只能落在"按存档"的库上：解析不出存档 id ⇒ 拒，绝不退化。 */
        const teamWorld = async () => {
            try {
                const id = String(await worldIdResolver() ?? '').trim();
                if (id) return { ok: true, worldId: id };
                return {
                    ok: false,
                    ack: { ok: false, code: 'NO_BOARD', reason: '当前板库没有存档维度（world_id 为空）：队伍操作已拒绝，避免记到错误的存档上' },
                };
            } catch (e) {
                return {
                    ok: false,
                    ack: { ok: false, code: 'NO_BOARD', reason: `当前板库拿不到存档维度，队伍操作已拒绝：${String(e?.message ?? e)}` },
                };
            }
        };

        /** 六个队伍事件的共同前半段：身份 → 存档。 */
        const teamPre = async (socket, payload) => {
            const who = teamActor(socket, payload);
            if (!who.ok) return { ok: false, ack: who.ack };
            const world = await teamWorld();
            if (!world.ok) return { ok: false, ack: world.ack };
            return { ok: true, bot: who.bot, worldId: world.worldId };
        };

        socket.on('team:create', async (payload, cb) => {
            try {
                const pre = await teamPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = createTeam(db, { worldId: pre.worldId, name: payload?.name, avatar: pre.bot, now: now() });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, team: r.team, role: r.role, worldId: pre.worldId });
                // t2 事件（旁路）：队伍是**按存档**的，worldId 必须来自 teamPre（拿不到就不写）
                void ev('team.create', {
                    teamId: r.team?.id ?? null, name: r.team?.name ?? null, role: r.role ?? null,
                    avatarId: pre.bot, by: pre.bot, avatar: pre.bot,
                }, { worldId: pre.worldId, avatarId: pre.bot });
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        socket.on('team:join', async (payload, cb) => {
            try {
                const pre = await teamPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = joinTeam(db, {
                    worldId: pre.worldId, teamId: payload?.teamId, name: payload?.name,
                    avatar: pre.bot, now: now(),
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, team: r.team, role: r.role, already: r.already === true });
                // t2 事件（旁路）：already=true 是自助加入的幂等重入（行列早已存在）⇒ 不重复记
                if (r.already !== true) {
                    void ev('team.join', {
                        teamId: r.team?.id ?? null, role: r.role ?? null,
                        avatarId: pre.bot, by: pre.bot, avatar: pre.bot,
                    }, { worldId: pre.worldId, avatarId: pre.bot });
                }
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        socket.on('team:leave', async (payload, cb) => {
            try {
                const who = teamActor(socket, payload);
                if (!who.ok) return ack(cb, who.ack);
                const r = leaveTeam(db, { avatar: who.bot, now: now() });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                // ★ t2 顺序：**先回 ack，再解析存档、再写事件** —— 用户等的是回执，审计是旁路；
                //   解析存档要走 worldIdResolver（可能碰文件系统），不能让它把回执扣在这里当人质。
                ack(cb, { ok: true, team: r.team, disbanded: r.disbanded === true, promoted: r.promoted ?? null });
                const world = await teamWorld();
                if (!world.ok) return;
                void ev('team.leave', {
                    teamId: r.team?.id ?? null, avatarId: who.bot, by: who.bot, avatar: who.bot,
                    disbanded: r.disbanded === true, promoted: r.promoted ?? null,
                }, { worldId: world.worldId, avatarId: who.bot });
                if (r.disbanded === true) {
                    // 最后一人离队 = 队伍被解散（没有独立的 `team:disband` 事件，语义在这里收口）
                    void ev('team.disband', {
                        teamId: r.team?.id ?? null, avatarId: who.bot, by: who.bot, avatar: who.bot,
                    }, { worldId: world.worldId, avatarId: who.bot });
                }
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        socket.on('team:list', async (payload, cb) => {
            try {
                const world = await teamWorld();
                if (!world.ok) return ack(cb, world.ack);
                const r = listTeams(db, { worldId: world.worldId });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, teams: r.teams, worldId: world.worldId });
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        socket.on('team:chest-add', async (payload, cb) => {
            try {
                const pre = await teamPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = addTeamChest(db, {
                    worldId: pre.worldId, teamId: payload?.teamId, avatar: pre.bot,
                    x: payload?.x, y: payload?.y, z: payload?.z, now: now(),
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, team: r.team, chest: r.chest });
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        socket.on('team:chest-list', async (payload, cb) => {
            try {
                const pre = await teamPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = listTeamChest(db, {
                    worldId: pre.worldId, teamId: payload?.teamId, avatar: pre.bot,
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, team: r.team, chests: r.chests });
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        // ── 共享库存（ADR 阶段 3 / D7）─────────────────────────────────
        //
        // ★ 与队伍同一口径：身份只认 `actingBot`（服务端裁决），存档只认 `teamWorld()`，
        //   解析不出存档 id ⇒ NO_BOARD，绝不给兜底值。
        // ★ "访客"也**不由客户端自报**：只认 `deps.isVisitor` 注入的判定
        //   （阶段 4 用访问凭证接上；在此之前没有任何连接会被判成访客 —— 默认为否）。
        const inventoryPre = async (socket, payload) => {
            const pre = await teamPre(socket, payload);
            if (!pre.ok) return pre;
            return { ...pre, visitor: await isVisitor(socket, pre.bot, pre.worldId) };
        };

        socket.on('inventory:reserve', async (payload, cb) => {
            try {
                const pre = await inventoryPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = reserveStock(db, {
                    worldId: pre.worldId, item: payload?.item, qty: payload?.qty,
                    holder: pre.bot, ttlMs: payload?.ttlMs, containers: payload?.containers,
                    visitor: pre.visitor, now: now(),
                });
                if (!r.ok) {
                    return ack(cb, {
                        ok: false, code: r.code, reason: r.message,
                        known: r.known, reserved: r.reserved, available: r.available, requested: r.requested,
                    });
                }
                ack(cb, { ok: true, reservation: r, visitor: r.visitor === true });
                // t2 事件（旁路）：只有**真的落下一条预占**才写；访客被分流（不占本机额度、只留
                //   inventory_audit）没有预占行 ⇒ 不写 inventory.reserve，免得"按 kind 统计"把
                //   一次免账的查询算成一次真实占用（缺口表见 wiring-board.md）
                if (r.visitor !== true) {
                    void ev('inventory.reserve', {
                        reservationId: r.id ?? null, item: r.item ?? null, qty: r.qty ?? null,
                        holder: pre.bot, known: r.known ?? null, reserved: r.reserved ?? null,
                        available: r.available ?? null, expiresAt: r.expiresAt ?? null,
                        chestKey: chestKeyOf(Array.isArray(payload?.containers) ? payload.containers[0] : null),
                    }, { worldId: pre.worldId, avatarId: pre.bot });
                }
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        socket.on('inventory:settle', async (payload, cb) => {
            try {
                const pre = await inventoryPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = settleTake(db, {
                    worldId: pre.worldId, reservationId: payload?.reservationId, qty: payload?.qty,
                    holder: pre.bot, container: payload?.container, visitor: pre.visitor, now: now(),
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message, reservation: r.reservation });
                ack(cb, {
                    ok: true, already: r.already === true, reservation: r.reservation,
                    ledger: r.ledger, cache: r.cache ?? null, visitor: r.visitor === true,
                });
                // t2 事件（旁路）：`inventory.settle` 是"账实对不上"时唯一的第三方证据（events.md §11-3）
                //   · already=true = 幂等重放（账本行早写过）⇒ 不重复记
                //   · 访客不写本机账本（settleTake 已分流）⇒ 也不写结算事件
                if (r.visitor !== true && r.already !== true && r.ledger) {
                    void ev('inventory.settle', {
                        reservationId: r.reservation?.id ?? null,
                        item: r.ledger.item ?? null, delta: r.ledger.delta ?? null,
                        holder: pre.bot, chestKey: chestKeyOf(payload?.container),
                        container: payload?.container ?? null,
                    }, { worldId: pre.worldId, avatarId: pre.bot });
                }
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        // 释放预占（取不到就还券）：额度立即回池，不等 TTL；只能释放自己持有的券（服务端裁决 holder）
        socket.on('inventory:release', async (payload, cb) => {
            try {
                const pre = await inventoryPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = releaseReservation(db, {
                    worldId: pre.worldId, id: payload?.reservationId, holder: pre.bot,
                    reason: payload?.reason, now: now(),
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message, reservation: r.reservation });
                ack(cb, {
                    ok: true, already: r.already === true, changes: r.changes ?? 0,
                    closed: r.closed ?? null, reservation: r.reservation, ledger: r.ledger,
                });
                // t2 事件（旁路）：`inventory.rollback` = 一次预占的回滚（券回池）。
                //   放在 handler 侧而不是 t4 的调用方：调用方只知道"我这次取用失败了"，
                //   不知道"券有没有回滚成功"（already/changes 只有这里看得见）。
                //   already=true / changes=0 = 幂等重放或券早已回池 ⇒ 不重复记。
                if (r.already !== true && (r.changes ?? 0) > 0) {
                    void ev('inventory.rollback', {
                        reservationId: r.reservation?.id ?? null, item: r.reservation?.item ?? null,
                        qty: r.reservation?.qty ?? null, holder: pre.bot, reason: r.reason ?? null,
                    }, { worldId: pre.worldId, avatarId: pre.bot });
                }
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        // 存入记账（D7-3 的存入侧，`settle` 的对偶）：账本 reason='store'；缓存只按观测强刷（D7-1）
        //   ★ 不写 events：`inventory.store` 不在 kind 白名单里（口径见 docs/audit-r6/fixes4/wiring-board.md 的缺口表）
        socket.on('inventory:store', async (payload, cb) => {
            try {
                const pre = await inventoryPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = stockIn(db, {
                    worldId: pre.worldId, item: payload?.item, qty: payload?.qty, holder: pre.bot,
                    chestKey: payload?.chestKey ?? null, observed: payload?.observed ?? null,
                    visitor: pre.visitor, now: now(),
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, ledger: r.ledger, cache: r.cache ?? null, visitor: r.visitor === true });
                // t2 事件（旁路）：存入 = 账本**正** delta（`qty` 取 `ledger.delta`，即 +qty），
                //   与 `inventory.settle` 的负 delta 对称；缺了它"存进去"这段账在复盘里看不见。
                //   · **先 ack 再写**（旁路不能影响延迟，见 wiring-board.md §1 通用规则）
                //   · **访客不写**：`stockIn` 已 `skipped`（只留 inventory_audit），别硬写一条空事件
                if (r.visitor !== true) {
                    void ev('inventory.store', {
                        item: r.ledger?.item ?? null, qty: r.ledger?.delta ?? null,
                        chestKey: chestKeyOf(payload?.chestKey), holder: pre.bot,
                        avatarId: pre.bot, by: pre.bot,
                    }, { worldId: pre.worldId, avatarId: pre.bot });
                }
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        // 开箱强刷缓存（D7-1）：调用方给的 items 必须来自**刚打开的窗口**，不是本地快照
        socket.on('inventory:cache-refresh', async (payload, cb) => {
            try {
                const pre = await inventoryPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = refreshContainerCache(db, {
                    worldId: pre.worldId, x: payload?.x, y: payload?.y, z: payload?.z,
                    items: payload?.items, holder: pre.bot, now: now(),
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, ...r });
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        // 取用失败 ⇒ 标脏（D7-1）：内容不确定，下一次开箱强刷回来
        socket.on('inventory:mark-dirty', async (payload, cb) => {
            try {
                const pre = await inventoryPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = markContainerDirty(db, {
                    worldId: pre.worldId, x: payload?.x, y: payload?.y, z: payload?.z,
                    reason: payload?.reason, now: now(),
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, ...r });
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        // ★ 对账的"真实内容"只能由客户端上报（服务端不自己开箱），所以**必须可归因**：
        //   holder 只取服务端裁决的身份（payload.holder 忽略），谁报的账写进账本。
        socket.on('inventory:reconcile', async (payload, cb) => {
            try {
                const pre = await inventoryPre(socket, payload);
                if (!pre.ok) return ack(cb, pre.ack);
                const r = reconcileContainers(db, {
                    worldId: pre.worldId, observations: payload?.observations,
                    holder: pre.bot, dryRun: payload?.dryRun === true, now: now(),
                });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, {
                    ok: true, checked: r.checked, changed: r.changed, written: r.written,
                    diffs: r.diffs, warnings: r.warnings, lines: r.lines, summary: r.summary,
                    dryRun: r.dry_run,
                });
                // t2 事件（旁路）：只记**真的改了账本**的对账 —— dryRun 与"账实一致"都不写，
                //   否则每次巡检都会灌一大批"什么都没改"的事件，把真正要看的淹没。
                if (r.dryRun !== true && Number(r.written) > 0) {
                    const diffs = Array.isArray(r.diffs) ? r.diffs : [];
                    void ev('inventory.reconcile', {
                        checked: r.checked, changed: r.changed, written: r.written,
                        diffs: diffs.slice(0, 20), diffsTotal: diffs.length, holder: pre.bot,
                    }, { worldId: pre.worldId, avatarId: pre.bot });
                }
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        socket.on('inventory:snapshot', async (payload, cb) => {
            try {
                const world = await teamWorld();
                if (!world.ok) return ack(cb, world.ack);
                const r = inventorySnapshot(db, { worldId: world.worldId, item: payload?.item ?? null, now: now() });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, worldId: world.worldId, items: r.items, containers: r.containers, reservations: r.reservations, expired: r.expired, expiredCount: r.expiredCount });
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        socket.on('inventory:ledger', async (payload, cb) => {
            try {
                const world = await teamWorld();
                if (!world.ok) return ack(cb, world.ack);
                const r = inventoryLedger(db, { worldId: world.worldId, item: payload?.item ?? null, limit: payload?.limit });
                if (!r.ok) return ack(cb, { ok: false, code: r.code, reason: r.message });
                ack(cb, { ok: true, worldId: world.worldId, entries: r.entries });
            } catch (e) {
                ack(cb, { ok: false, code: 'INTERNAL', reason: String(e?.message ?? e) });
            }
        });

        // ══════════════════════════════════════════════════════════════════
        // t2 位置说明（**位置：`inventory:ledger` 之后**；复核按这个查）
        //
        // 库存侧的事件**调用点**在各自 handler 的成功路径里，各 1 行（reserve / settle /
        // reconcile / release），没有新增 handler、没有改 ack 形状、没有重排顺序。
        // 为什么不能全搬到这个区块：
        //   事件的 `worldId` **只有 handler 手里的 `pre.worldId` 才有**（ack 回执里没有
        //   worldId）。若改到区块里靠"嗅探 ack"反推，就得给 worldId 兜底成 'default'，
        //   违反硬口径 ②（假 worldId 比没有事件更糟）；而且 ack 一改事件会静默消失。
        // 与 wire-flow 的分工：`inventory:release` 这个 handler 由 t4 插入
        //   （位置：`inventory:settle` 与 `inventory:cache-refresh` 之间），
        //   里面那 1 行 `inventory.rollback` 事件归 t2 写（captain 2026-11-13 裁决 2）。
        // ══════════════════════════════════════════════════════════════════
    });

    /** 过期预占清理：异步解析存档 id（失败就跳过，不影响主扫描）。 */
    const sweepInventoryReservations = async () => {
        try {
            const id = String(await worldIdResolver() ?? '').trim();
            if (!id) return;
            expireReservations(db, { worldId: id, now: now() });
        } catch { /* 没有存档维度/库忙：下一轮再试，扫描本身不该崩 */ }
    };

    // ── 租约过期扫描（06 §6：掉线的 bot 30 秒后单子自动回 ready）───────
    const scanTimer = setInterval(() => {
        try {
            const recovered = expireLeases(db, now());
            for (const id of recovered) changed(getJob(db, id), 'lease-expired');
            // ★ B3：顺带清过期预约（bot 掉线后它的预约要自动释放，06 §9.2）
            try { expireClaims(db, now()); } catch { /* ignore */ }
            // ★ D7：过期预占自动作废（没有存档维度就跳过；内部先做零行快查，不白开写事务）
            void sweepInventoryReservations();
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
