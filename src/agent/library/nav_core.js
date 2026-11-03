/**
 * 导航唯一入口：goTo。
 *
 * 为什么要有这一层（REFACTOR_ANALYSIS §5 Phase 3 / §3.2「移动引擎两套」）：
 *   现在"走到某处"至少有三条路，调用方得自己挑：
 *     executor.walkTo      —— 3D 体素 A*（要有 mapDir / terrain3d 库），能爬台阶、挖穿、垫方块
 *     atom_move.moveTo     —— 原生 pathfinder，2D 思路，爬不上高差、不会垫
 *     atom_move.moveToXZ   —— 只要 x/z，高度自己找
 *     path_short.moveToXZEx—— 更旧的短途实现（已列进删除清单）
 *   谁该用哪条、什么时候回退，全靠调用方记。换一次引擎就要全仓库跟着改。
 *
 * 这一层的职责就一句话：**按输入选引擎，把选择集中在一个地方**。
 * 它自己不做任何移动动作、不解析路径、不碰方块。
 *
 * 典型用法：
 *   await goTo(bot, { x, z }, { mapDir, deadlineMs })          // 有 3D 库 → 走 walkTo
 *   await goTo(bot, { kind: 'point', pos: { x, y, z } })       // 没 3D 库 → 走原生 pathfinder
 *
 * 引擎选择（顺序即优先级）：
 *   1. 给了 mapDir（有 3D 库）        → executor.walkTo      （唯一能爬台阶/挖穿/垫方块的）
 *   2. 没给 mapDir 但给了具体 y       → atom_move.moveTo     （原生 pathfinder）
 *   3. 没给 mapDir，只给了 x/z        → atom_move.moveToXZ   （高度让它自己找）
 *
 * 注意：**实体跟随（GoalFollow / followEntity）不在这里**。
 * 它有自己的目标失效、重定位、丢失重找逻辑，硬塞进 goTo 会让两个语义搅在一起。
 * 跟随仍然走 task_follow。
 */
import { ok, fail } from './contract.js';
import { walkTo } from './executor.js';
import { moveTo, moveToXZ } from './nav_pathfinder.js';
import { ensureTraced } from './trace_bus.js';

/**
 * ★★ 2026-11-04（t76）：**在"导航驱动权"内跑一段自己的移动代码。**
 *
 * 为什么需要：`flow_pickup.collectDrops` 直接用 `moveTo`（原生 pathfinder），
 * **绕过了 `goTo` 的单一驱动者闸**。t72 之后它变成"每挖一块就调一次"，
 * 频率从"末尾 1 次"变成"每块 1 次" → 第 23 跑立刻和挖矿抢 pathfinder：
 *   `goTo false NO_REACH ×579`（上轮 0）、`dig = 0`、最后原因 `INTERNAL`（goal 被换）/ `NO_MOVE`
 *
 * 语义与 `goTo` 一致：**同 owner 可重入**（挖矿流程内部本来就在持锁），
 * 所以拿不到锁只可能是"**别的任务**正在用导航" → 这时返回 null 交给调用方决定
 * —— **绝不硬抢**。
 *
 * @param {object} bot
 * @param {Function} fn 在这段时间里可以自由用 pathfinder
 * @returns {Promise<any|null>} fn 的返回值；拿不到锁返回 null
 */
export async function withNav(bot, fn, waitMs = 3000) {
    const owner = String(bot?.__navJobId ?? 'adhoc');
    const lock = await acquireNav(owner, waitMs);
    if (!lock) return null;
    try { return await fn(); } finally { lock.release(); }
}

/** 目标坐标是否可用。 */
function finiteXZ(t) {
    return !!t && Number.isFinite(t.x) && Number.isFinite(t.z);
}

// ───────────────────────────────────────────────────────────────────────────
// ★★ 2026-11-03（t66）：**同一时刻只允许一个"驱动者"用 pathfinder**。
//
//   真机证据（verify 第 13 跑，全量日志）：
//     [MINE] dig false INTERNAL      × 1590     ← 底层是 "The goal was changed"
//     [MINE] dig false OUT_OF_REACH  ×  320
//     [MINE] dig true  OK            ×    1     ← 只成功 1 次
//     [walkTo] 失败: INTERNAL The goal was changed before it could be completed!
//
//   `[MINE] round` 行揭示了并发源：**两条流在抢同一个 pathfinder**
//     round 0  ore=cobblestone feetY=8 → -23 → -51   （idle 的 obtain stone_pickaxe 在下潜）
//     round 38 ore=oak_log   feetY=-56 candidates=29 （first_night 的 obtain oak_log 到了树区）
//   一个在 goTo 下潜点、另一个在 goTo 树下 → **每次都被对方改掉 goal** → dig 全部 INTERNAL。
//
//   为什么前几轮偶尔能成（8/8、34/8）：那时另一条流没恰好撞上。
//
//   这和 M2 的 D18「两个流程同时驱动身体」是**同一类问题，只是发生在导航层**。
//   控制层当年靠"只有一个动作在跑"解决；导航层一直没这道闸。
//
// 语义：
//   · `owner` 缺省用 `'adhoc'`（没有任务单的调用）。
//   · **可重入**：同一个 owner 再次进来直接放行（流程内部可能连调 goTo）。
//   · 不同 owner → **排队等**，等到 `NAV_LOCK_WAIT_MS`；等不到就 `BLOCKED`（明确码，不假装成功）。
// ───────────────────────────────────────────────────────────────────────────
const NAV_LOCK_WAIT_MS = 20000;
/** 仅供单测：当前驱动者（正常代码不该读它）。 */
export const navLockOwner = () => _navOwner;
let _navOwner = null;
let _navDepth = 0;

/**
 * 拿"导航驱动权"。
 * @param {string|number} owner 驱动者标识（一般用 ctx.jobId；没有就用 'adhoc'）
 * @returns {{release:Function}|null} null = 等超时
 */
// ★ t66：导出给单测用 —— "同一时刻只有一个驱动者"是承重行为，必须能直接验
//   （通过 goTo 验要搭真 bot，太重；闸本身是纯逻辑，直接测最准）。
export async function acquireNav(owner, waitMs = NAV_LOCK_WAIT_MS) {
    const t0 = Date.now();
    while (true) {
        if (_navOwner === null || _navOwner === owner) {
            _navOwner = owner;
            _navDepth += 1;
            return {
                release() {
                    _navDepth -= 1;
                    if (_navDepth <= 0) { _navDepth = 0; _navOwner = null; }
                },
            };
        }
        if (Date.now() - t0 >= waitMs) return null;
        await new Promise((r) => setTimeout(r, 100));
    }
}

/**
 * 目标归一化：接受 {x,z} / {x,y,z} / {kind:'point', pos:{...}} 三种写法。
 *
 * 为什么容忍三种：调用方一半传裸 {x,z}（老代码），一半传描述对象（原子契约）。
 * 这里做一次归一是**唯一**该容忍的地方——原子层不再接受裸坐标（§6.4）。
 *
 * @returns {{x:number, y:number|null, z:number}|null}
 */
export function normalizeDest(target) {
    if (!target || typeof target !== 'object') return null;
    // {kind:'point', pos:{x,y,z}} / {kind:'point', posXZ:{x,z}}
    if (target.kind === 'point') {
        const p = target.pos ?? target.posXZ ?? null;
        if (!finiteXZ(p)) return null;
        return { x: p.x, y: Number.isFinite(p.y) ? p.y : null, z: p.z };
    }
    // 裸坐标
    if (!finiteXZ(target)) return null;
    return { x: target.x, y: Number.isFinite(target.y) ? target.y : null, z: target.z };
}

/**
 * 走到目标 —— **导航唯一入口**。
 *
 * @param {object} bot
 * @param {object} target {x,z} / {x,y,z} / {kind:'point', pos:{x,y,z}}
 * @param {object} opts
 *   mapDir     有 3D 库就传（决定是否走 walkTo）
 *   deadlineMs 总时限（毫秒）
 *   arriveTol  到达容差（格），默认 5（walkTo）/ 1（pathfinder）
 *   onEvent    时间线回调
 *   rescan     walkTo 每轮是否重扫地形，默认 true
 * @returns ActionResult
 *   ok → data: { engine, distRemaining?, costMs, ...引擎透传 }
 *   fail → code ∈ NO_TARGET / INTERRUPTED / INTERNAL / 引擎透传（NO_PATH / STUCK / NO_REACH …）
 */
export async function goTo(bot, target, opts = {}) {
    const {
        mapDir = null,
        deadlineMs = 300000,
        arriveTol = null,
        onEvent = () => { },
        rescan = true,
        // ★ t66：驱动者标识。有任务单时 `makeCtx` 会把 jobId 写到 `bot.__navJobId`，
        //   所以所有 flow 的 goTo 都自动带上 owner，不用逐个改调用点。
        //   没有任务单（`!do` 直调 / 反射 / 离线）就 'adhoc'。
        owner = bot?.__navJobId ?? 'adhoc',
    } = opts;

    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    // ★★ t66：**同一时刻只允许一个驱动者用 pathfinder**（否则两条流互相改 goal
    //   → `The goal was changed` → dig 全部 INTERNAL，真机实测 1590 次）。
    const lock = await acquireNav(String(owner), Math.min(NAV_LOCK_WAIT_MS, Math.max(1000, deadlineMs)));
    if (!lock) {
        return fail('BLOCKED', '导航被别的任务占用（pathfinder 同一时刻只允许一个驱动者）', {
            owner, retryable: true,
        });
    }
    try {
        return await _goToLocked(bot, target, { mapDir, deadlineMs, arriveTol, onEvent, rescan, owner });
    } finally {
        lock.release();
    }
}

async function _goToLocked(bot, target, { mapDir, deadlineMs, arriveTol, onEvent, rescan }) {

    const dest = normalizeDest(target);
    if (!dest) return fail('NO_TARGET', '目标坐标无效（需要 {x,z} 或 {kind:"point",pos:{x,y,z}}）');

    // ★ 09 §2 / D10：没有任务单时，**nav_core 就是最外层**，由它写 trace_bus —— walkTo
    // 和 execStep 都不再各包一层（那样 execStep 的事件会被记两次）。
    // 有任务单时最外层是 `ctx.onEvent`（M5），传进来的函数已带记号，ensureTraced 原样返回。
    const tracedOnEvent = ensureTraced(onEvent);

    // ---- 引擎 1：有 3D 库 → walkTo（唯一能爬台阶 / 挖穿 / 垫方块的）----
    if (mapDir) {
        const r = await walkTo(bot, { x: dest.x, z: dest.z }, {
            mapDir,
            onEvent: tracedOnEvent,
            deadlineMs,
            arriveTol: arriveTol ?? 5,
            rescan,
        });
        return withEngine(r, 'walk3d');
    }

    // ---- 引擎 2/3：没有 3D 库 → 原生 pathfinder ----
    // 给了 y 就用 moveTo（精确点），否则 moveToXZ（高度自己找）
    if (dest.y != null) {
        const r = await moveTo(bot, { kind: 'point', pos: { x: dest.x, y: dest.y, z: dest.z } }, {
            tol: arriveTol ?? 1,
            timeout: deadlineMs,
        });
        return withEngine(r, 'pathfinder3');
    }
    const r = await moveToXZ(bot, { kind: 'point', posXZ: { x: dest.x, z: dest.z } }, {
        tol: arriveTol ?? 2,
        timeout: deadlineMs,
    });
    return withEngine(r, 'pathfinder2');
}

/**
 * 在结果里补上"用的哪个引擎"，方便诊断与基线对比。
 * 只加字段、不改 ok/code/message —— 引擎的选择不该影响上层判断。
 */
function withEngine(r, engine) {
    if (!r || typeof r !== 'object') return r;
    return { ...r, data: { ...(r.data ?? {}), engine } };
}
