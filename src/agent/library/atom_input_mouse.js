/**
 * 输入原子：视角与鼠标 —— **全系统唯一允许转头、挖、放、右键、挥拳的地方**。
 *
 * 规矩见 docs/architecture/01_primitives.md §2 / §3.2。
 * 为什么收拢（A1）：`bot.dig` / `bot.placeBlock` / `bot.activate*` / `bot.attack` /
 * `bot.look*` 之前散在 atom_dig / atom_place / atom_use / atom_attack / skills / executor /
 * modes 里，"谁在挖、谁在放、卡住了谁该负责收尾"只能靠读代码猜。
 *
 * 分工：本文件**只发一次输入**，不判断该不该发（A6）、不重试（A5）；
 * "挖完那格变空气了吗""放了但没变成方块吗"是动作层的后置复核。
 *
 * 这里**不重复实现**已有的原子：`lookAt` 直接转给 `atom_look`（它本来就是原子，
 * 有后置校验）；本文件只补 `atom_look` 没有的那几个一次性输入。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { lookAt as _lookAt } from './atom_look.js';

const _Vec3 = Vec3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 等中断的轮询间隔（A3：~100ms 一次）。 */
export const INTERRUPT_POLL_MS = 100;

/**
 * 挖方块的默认上限。
 *
 * 只在调用方没给 timeout 时兜底（atom_dig 会按方块硬度自己算一个传进来）。
 * 取 10 秒：比任何原版方块的手挖时间都长，够不着时也能收尾而不是挂死。
 */
export const DEFAULT_DIG_TIMEOUT = 10000;

/**
 * 看向某个目标（转给 `atom_look.lookAt`，含后置 yaw/pitch 校验）。
 */
export async function lookAt(bot, target, opts = {}) {
    return _lookAt(bot, target, opts);
}

/**
 * 看向一个**世界坐标**（`bot.lookAt` 一次，不做后置校验）。
 *
 * 为什么要和 `lookAt` 分开：`lookAt` 是"看过去并且确认真的转过去了"（有 600ms
 * 校验循环，适合"看着玩家说话"）；而放置方块前的转向只是"把准星对到支撑面"，
 * 后面紧跟一次 `placeBlock`，**放置结果本身就是校验**。
 * 在热路径上用带校验的版本会多等一个循环，且转不过去时反而把原本能放成的放下搞失败
 * （服务端根本不校验视角，实测见 atom_place 的注释）。
 *
 * @param {{x:number,y:number,z:number}} point 已带 +0.5 的世界坐标
 */
export async function lookAtPoint(bot, point, opts = {}) {
    const { force = true } = opts;
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
        return fail('NO_TARGET', 'lookAtPoint 需要一个有效坐标');
    }
    try {
        await bot.lookAt(_Vec3(point.x, point.y, point.z), force);
        return ok({ point: { x: point.x, y: point.y, z: point.z } });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
}

/** 直接设置朝向（`bot.look`），不做后置校验——要校验请用 lookAt。 */
export async function setLook(bot, yaw, pitch, opts = {}) {
    const { force = true } = opts;
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    try {
        await bot.look(yaw, pitch, force);
        return ok({ yaw, pitch });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { yaw, pitch });
    }
}

/** 挥一下手臂（`bot.swingArm`），纯表现，不改世界。 */
export async function swing(bot, hand = 'right') {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    try {
        bot.swingArm?.(hand);
        return ok({ hand });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { hand });
    }
}

/**
 * 对准方块按住左键，直到它碎（= `bot.dig` 一次），或被取消 / 超时。
 *
 * 为什么超时在这里而不是在外面包 `Promise.race`：外面包分不清"超时"和"异常"，
 * 这句注释在 atom_wait / atom_dig 里都写过一遍，统一收到这儿。
 *
 * @param {object} bot
 * @param {object} block 已经读到的方块对象（不负责去找）
 * @param {object} opts
 *   timeout    毫秒；不给按方块硬度估（DEFAULT_DIG_TIMEOUT 兜底）
 *   digTimeMs  调用方已经算好的预算（atom_dig 走这条，行为与改前完全一致）
 * @returns ActionResult
 *   ok          → data: { block, costMs }
 *   TIMEOUT     → 到时还没碎（已 stopDigging）
 *   INTERRUPTED → 挖的中途被取消（已 stopDigging）
 *   INTERNAL    → bot.dig 抛了别的错（data.error）
 *   NO_TARGET   → 没给方块
 */
export async function holdDig(bot, block, opts = {}) {
    const { timeout = null, digTimeMs = null } = opts;

    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!block || !block.position) return fail('NO_TARGET', 'holdDig 需要一个方块对象');

    // ★★ 2026-11-04（t91）：**挖之前先确认"那块还在" —— 幽灵方块会制造 abort 风暴。**
    //
    //   真机证据（第 36 跑，3 轮**全部未重建树**）：
    //     轮1 abort 0（全新场地）｜ 轮2 abort 2556 ｜ 轮3 abort 2570（同一片被挖过的场地）
    //   而 `digOK` 与 `abort` **同时变高** → "在挖，但每条命令被打断很多次"。
    //
    //   机制（读 mineflayer 源码 `plugins/digging.js`）：
    //     `dig()` 开头：`if (bot.targetDigBlock) bot.stopDigging()`
    //     而 `stopDigging()` → `diggingTask.cancel(new Error('Digging aborted'))`
    //   → **上一次 dig 没干净收尾（targetDigBlock 留着），下一次 dig 就把它 cancel 掉**，
    //     报的正是 `Digging aborted`。
    //   而被挖过的场地里，`findBlocks` 可能仍返回**已经变成空气的坐标**（幽灵方块）：
    //     对这种坐标 `bot.dig` 会一直等到 `waitTime` 超时 → 状态没清干净 → 下一块撞上 abort。
    //
    //   修法：**挖前用新鲜读取确认方块还在、还能挖**；不在就报 `NO_TARGET`（可跳过该候选），
    //   而不是把 stale 对象丢给 `bot.dig` 制造一次超时 + 一次 abort。
    try {
        const fresh = bot.blockAt?.(new Vec3(Math.floor(block.position.x),
            Math.floor(block.position.y), Math.floor(block.position.z)), false);
        if (!fresh || fresh.name !== block.name || fresh.diggable === false) {
            return fail('NO_TARGET', `那块已经不是 ${block.name} 了（现在是 ${fresh?.name ?? '未加载'}），跳过`, {
                expected: block.name, actual: fresh?.name ?? null, reason: 'stale-block',
            });
        }
    } catch { /* 读不到就按原样往下走，不因诊断失败而拒绝挖 */ }

    // ★★ 2026-11-04（t80）：**挖之前必须让导航静默 —— 这是挖矿的前提，由这里保证。**
    //
    //   真机证据（第 26 跑，`[MINE] dig` 的 err= 分布）：
    //     `Digging aborted` × **1622**（99.9%），成功仅 2 次
    //     且 `d= 1.2`（她就在方块边上）也 abort → **只能是 dig 开始后被外部中止**
    //   同一跑 `goTo` 的失败全是 `INTERNAL` —— **同一个底层原因：运动被并发打断**。
    //
    //   来源：t72 把 `collectDrops` 改成"每挖一块就跑一次"，而它用 `moveTo`（pathfinder）。
    //   `withNav` 只保证了**不并发**，但 `collectDrops` 返回后 **pathfinder 的 goal 还挂着**，
    //   于是下一块 `bot.dig` 一开始就被"还有移动目标"打断 → `Digging aborted`。
    //
    //   **修法不放在调用方**（那样每个流都要记得清，今晚这类"传参漏了"已 4 例），
    //   而是放在这里：**任何 dig 之前都强制静默**。这是挖矿的固有前提，
    //   不是某个 flow 的责任。
    //
    //   ★★★ t84：**回退 t82 的"无条件静默" —— 它是回归，不是修复。**
    //
    //     三跑实测（唯一可信的判据）：
    //       t80 条件静默          → `Digging aborted` **1622 → 0**，dig OK 5
    //       t80 + t81（先 dig）   → aborted **1277**，dig OK **29**   ← t81 用 1277 换 24 块
    //       t80+t81+t82（无条件） → aborted **2867**，dig OK **5**    ← 净亏
    //
    //     t82 的 `setGoal(null) + stop() + setImmediate` **每次挖之前都跑**
    //     （t81 之后每块都先 dig），而 `stop()` 会触发 pathfinder 自己的中断事件
    //     → abort 正在进行的 dig。执行次数被放大数倍 → abort 反而更多。
    //
    //   → 回到 t80 的**条件版**：只在"确实有 goal / 有键按着"时才清。
    if (bot.pathfinder) {
        try {
            const hasGoal = !!bot.pathfinder.goal;
            const keysDown = Object.keys(bot.controlState ?? {}).some((k) => bot.controlState[k]);
            if (hasGoal) { bot.pathfinder.setGoal(null); bot.pathfinder.stop?.(); }
            if (keysDown) {
                bot.__silencingForDig = true;
                try { bot.clearControlStates?.(); } catch { /* ignore */ } finally { bot.__silencingForDig = false; }
            }
        } catch { /* ignore */ }
    }

    const heldId = bot?.heldItem ? bot.heldItem.type : null;
    const budget = Number.isFinite(digTimeMs)
        ? digTimeMs
        : (Number.isFinite(timeout)
            ? timeout
            : Math.max(DEFAULT_DIG_TIMEOUT, (block.digTime?.(heldId) ?? 500) * 2 + 2000));

    const t0 = Date.now();
    let digErr = null;
    // ★★ t87：**并发 dig 探测器。**
    //
    //   隔离实验（verify 第 32 跑）证明：**裸调 `bot.dig` 40 次，abort 率 0%**；
    //   而真实跑 `Digging aborted` ~2554-3354、`dig OK` 只有 3-25。
    //   → `bot.dig` 本身无罪，**责任在调用方**。
    //
    //   mineflayer 的 `dig()` 开头有 `if (bot.targetDigBlock) bot.stopDigging()`
    //   —— **并发 dig 会互相 cancel**，报的就是 `Digging aborted`。
    //
    //   这行打点就是判据：**如果进入时 `targetDigBlock` 已经非 null，
    //   说明有另一个 dig 在跑，我们正要把它 cancel 掉。**
    // ★★ 2026-11-04（t93）：**并发 dig 的硬证据：in-flight 标志 + 序号。**
    //
    //   第 38 跑已排除：`self-stop=0`、`interrupted=false`、`timedOut=false`、`stale-block=0`。
    //   而 mineflayer 里 `Digging aborted` **只有一个来源**：
    //     `digging.js:127  if (bot.targetDigBlock) bot.stopDigging()   // 在 dig() 开头`
    //   → **必然是"第二个 `bot.dig()` 在第一个还在飞的时候进来了"**。
    //
    //   但 `[DIG] enter` 看到 `targetDigBlock=null`（1294/1294）—— 与上面矛盾。
    //   解释只有一个：**`stopDigging()` 把 `targetDigBlock` 清成 null 之后，第二个才进来**，
    //   所以"进入时非 null"永远观测不到。
    //
    //   所以换一个不会被清掉的量：**我们自己维护的 in-flight 计数**。
    //   进入时若 `__digInFlight > 0` → **铁证：上一个 dig 还没结束**。
    // ★★★ 2026-11-04（t94）：**上一个 dig 泄漏了就主动清理，别在它身上叠新的。**
    //
    //   铁证（verify 第 39 跑，in-flight 计数）：
    //     seq 1~5  CONCURRENT=no      ← 正常
    //     seq 5    heldMs= **3007**   ← 这一挖挂了 3 秒
    //     seq 6~∞  CONCURRENT= **YES(1)** 永久，再也没有 no
    //   完整因果链：
    //     ① 一次慢 dig（3007ms）没有正常收尾，`__digInFlight` 停在 1
    //     ② 每个新 dig 一进来，mineflayer 的 `dig()` 就 `if (targetDigBlock) stopDigging()`
    //        → **cancel 掉上一个** → 上一个报 `Digging aborted`
    //     ③ 而**新的那个又被下一个 cancel** → 永久 abort 链（heldMs 全是 0~1ms）
    //
    //   所以：**检测到"上一个还没结束"时，先 stopDigging + 等它真的 settle，再开始新的。**
    //   这一步是打破自锁的关键 —— 光靠"每个新 dig 都 cancel 旧的"永远解不开。
    const seq = (bot.__digSeq = (bot.__digSeq ?? 0) + 1);
    let inFlightAtEntry = bot.__digInFlight ?? 0;
    if (inFlightAtEntry > 0) {
        // 有泄漏：先让旧的彻底停掉，再等它 settle
        try { bot.stopDigging?.(); } catch { /* ignore */ }
        for (let i = 0; i < 10 && (bot.__digInFlight ?? 0) > 0; i += 1) {
            await new Promise((r) => setTimeout(r, 60));
        }
        // 等不到就强制归零（宁可漏计一次，也不能让它永久卡住整条挖矿链）
        if ((bot.__digInFlight ?? 0) > 0) bot.__digInFlight = 0;
        inFlightAtEntry = 0;
        if (process.env.TRACE) console.log('[DIG] broke-stale-lock seq=', seq);
    }
    bot.__digInFlight = inFlightAtEntry + 1;
    if (process.env.TRACE) {
        const busy = bot.targetDigBlock?.name ?? null;
        const keys = Object.keys(bot.controlState ?? {}).filter((k) => bot.controlState[k]);
        const goal = bot.pathfinder?.goal ? 'yes' : 'no';
        console.log('[DIG] enter seq=', seq, 'block=', block.name,
            'CONCURRENT=', inFlightAtEntry > 0 ? 'YES(' + inFlightAtEntry + ')' : 'no',
            'targetDigBlock=', busy,
            'keys=', JSON.stringify(keys), 'goal=', goal, 'caller=', bot.__digCaller ?? '?');
    }
    let digPromise;
    try {
        digPromise = bot.dig(block, true);
    } catch (e) {
        // ★ 同步抛错也要把计数减回来（否则和"慢 dig 泄漏"一样会永久卡住）
        bot.__digInFlight = Math.max(0, (bot.__digInFlight ?? 1) - 1);
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e), dugBlock: block.name });
    }
    const digging = digPromise.catch((e) => { digErr = e; }).finally(() => {
        bot.__digInFlight = Math.max(0, (bot.__digInFlight ?? 1) - 1);
    });

    // 中断 / 超时二选一先到者：都要 stopDigging，否则客户端会一直举着手
    let interrupted = false;
    let timedOut = false;
    while (true) {
        const done = await Promise.race([
            digging.then(() => 'done'),
            sleep(Math.min(INTERRUPT_POLL_MS, Math.max(1, budget - (Date.now() - t0)))).then(() => 'tick'),
        ]);
        if (done === 'done') break;
        if (bot?.interrupt_code) { interrupted = true; break; }
        if (Date.now() - t0 >= budget) { timedOut = true; break; }
    }

    if (interrupted || timedOut) {
        if (process.env.TRACE) {
            console.log('[DIG] self-stop', interrupted ? 'interrupted' : 'timeout',
                '| heldMs=', Date.now() - t0, 'budget=', budget,
                '| targetDigBlock=', bot.targetDigBlock?.name ?? null);
        }
        try { bot.stopDigging?.(); } catch { /* ignore */ }
        if (interrupted) {
            return fail('INTERRUPTED', '被取消了', { dugBlock: block.name, costMs: Date.now() - t0 });
        }
        return fail('TIMEOUT', `挖了 ${Date.now() - t0}ms 还没挖完`, { dugBlock: block.name, costMs: Date.now() - t0 });
    }
    if (digErr) {
        const msg = String(digErr?.message ?? digErr);
        // ★★ t92：**abort 归因打点** —— verify 第 37 跑指出 `abort:digOK ≈ 100:1`
        //   是"紧凑重试死循环"，需要看 heldMs / budget / 是不是我们自己的 stopDigging。
        if (process.env.TRACE) {
            console.log('[DIG] err seq=', seq, 'reason=', msg,
                '| heldMs=', Date.now() - t0, 'budget=', budget,
                '| interrupted=', interrupted, 'timedOut=', timedOut,
                '| inFlight=', bot.__digInFlight ?? 0,
                '| targetDigBlock=', bot.targetDigBlock?.name ?? null);
        }
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { dugBlock: block.name });
        return fail('INTERNAL', msg, { error: msg, dugBlock: block.name, heldMs: Date.now() - t0, budget });
    }
    return ok({ dugBlock: block.name, costMs: Date.now() - t0 });
}

/** 停止挖掘（`bot.stopDigging`）。不给目标也安全。 */
export async function stopDig(bot) {
    try { bot?.stopDigging?.(); } catch { /* ignore */ }
    return ok({});
}

/**
 * 对着某个面放方块（`bot.placeBlock`）—— 一次输入，不判断该不该放。
 *
 * 错误**不吞、也不改写**：`data.error` 原样带回 `message`，让动作层按它分类
 * （`blockUpdate` 超时 ≠ 有实体挡着 ≠ 其它，atom_place 现在就是这么分的）。
 *
 * @param {object} bot
 * @param {object} ref   依附的方块对象
 * @param {Vec3}   face  法线方向
 * @param {object} opts  timeout（毫秒；不给就不加外层 race，交给 mineflayer 自己超时）
 * @returns ActionResult
 *   ok      → data: {}
 *   TIMEOUT → 外层超时（`data.blockUpdateMissed` 标记"可能只是包丢了"）
 *   INTERNAL→ 原样带回 message / data.error
 */
export async function placeAgainst(bot, ref, face, opts = {}) {
    const { timeout = null } = opts;

    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!ref) return fail('NO_TARGET', 'placeAgainst 需要一个依附方块');

    let err = null;
    try {
        if (Number.isFinite(timeout)) {
            await Promise.race([
                bot.placeBlock(ref, face),
                sleep(timeout).then(() => { throw new Error('place-timeout'); }),
            ]);
        } else {
            await bot.placeBlock(ref, face);
        }
    } catch (e) {
        err = e;
    }
    if (!err) return ok({});

    const msg = String(err?.message ?? err);
    // 客户端等 blockUpdate 超时：可能真没放上，也可能只是这个包丢了（已知竞态）。
    // 单独标出来，动作层据此"再读一次方块"而不是直接判失败。
    if (/blockUpdate|did not fire within timeout|place-timeout/i.test(msg)) {
        return fail('TIMEOUT', msg, { error: msg, blockUpdateMissed: !/place-timeout/i.test(msg) });
    }
    return fail('INTERNAL', msg, { error: msg });
}

/**
 * 右键方块（`bot.activateBlock`）—— 开门 / 上床 / 开工作台都是这一下。
 *
 * @param {object} opts timeout（毫秒，默认 3000；到点报 TIMEOUT）
 */
export async function useOnBlock(bot, block, opts = {}) {
    const { timeout = 3000 } = opts;
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!block) return fail('NO_TARGET', 'useOnBlock 需要一个方块');
    try {
        await Promise.race([
            bot.activateBlock(block),
            sleep(timeout).then(() => { throw new Error('activate-timeout'); }),
        ]);
        return ok({ activatedBlock: block.name });
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/timeout/.test(msg)) return fail('TIMEOUT', msg, { error: msg, activatedBlock: block.name });
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { activatedBlock: block.name });
        return fail('INTERNAL', msg, { error: msg, activatedBlock: block.name });
    }
}

/** 右键实体（`bot.activateEntity`）：村民、马、拴绳都是它。 */
export async function useOnEntity(bot, entity) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!entity) return fail('NO_TARGET', 'useOnEntity 需要一个实体');
    try {
        await bot.activateEntity(entity);
        return ok({ entity: entity.name ?? null });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
}

/** 使用手上的物品（`bot.activateItem`）：吃东西、拉弓、放桶。 */
export async function useHeld(bot) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    try {
        bot.activateItem?.();
        return ok({ usedItem: bot.heldItem?.name ?? null });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
}

/** 松开手上的物品（`bot.deactivateItem`）。 */
export async function releaseUse(bot) {
    try { bot.deactivateItem?.(); } catch { /* ignore */ }
    return ok({});
}

/**
 * 朝实体挥一拳（`bot.attack`）—— **一次**，不管死没死。
 *
 * 与 `atom_attack.attackEntity`（打到死 + 后置校验）分工不同：
 * 那个是动作层，本原子是它的最底层输入。
 */
export async function attackOnce(bot, entity) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!entity) return fail('NO_TARGET', 'attackOnce 需要一个实体');
    try {
        bot.attack(entity);
        return ok({ entity: entity.name ?? null });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
}
