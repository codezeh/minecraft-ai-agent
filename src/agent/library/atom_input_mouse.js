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
    const digging = bot.dig(block, true).catch((e) => { digErr = e; });

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
        try { bot.stopDigging?.(); } catch { /* ignore */ }
        if (interrupted) {
            return fail('INTERRUPTED', '被取消了', { dugBlock: block.name, costMs: Date.now() - t0 });
        }
        return fail('TIMEOUT', `挖了 ${Date.now() - t0}ms 还没挖完`, { dugBlock: block.name, costMs: Date.now() - t0 });
    }
    if (digErr) {
        const msg = String(digErr?.message ?? digErr);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { dugBlock: block.name });
        return fail('INTERNAL', msg, { error: msg, dugBlock: block.name });
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
