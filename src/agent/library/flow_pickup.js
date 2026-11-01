/**
 * 复合层：定点回收掉落物（原来的 atom_drops.collectDrops）。
 *
 * ★ 原子层规范化（2026-10-31）—— 从原子层搬到这里：
 *
 * 它原来叫 atom_drops.js，但它做的事情是**一段决策 + 多步动作**：
 *   1. 原地静止等一会儿（服务端 tick 才拾取）
 *   2. 有掉落物实体就逐个走过去（最多 2 轮）
 *   3. 回到挖掘点附近踩一脚，捡不到就**逐层往下试**（最多 8 格）
 *   4. 最后按距离给一次额外等待
 * 里面有 3 处循环、多次 moveTo，还有"先试哪、失败再怎么试"的策略 ——
 * 这是复合层的职责，不是原子的（契约：原子单次尝试、无循环找目标、无重试，
 * 见 ARCHITECTURE_REDESIGN §6.1 / 原子动作规格 §0.3-0.4）。
 *
 * 原子层现在只保留**纯查询**部分：
 *   atom_find_drops.findDrops   → 附近有哪些掉落物、最近的在哪
 *   atom_wait_item             → 等背包数量变化
 *   atom_stand.findStandSpot   → 哪一格能站
 * 本模块只负责编排它们。
 *
 * 判据仍然是【背包增量】而不是【实体消失】（原注释的理由仍然成立，保留在下面）。
 */
import { ok, fail } from './contract.js';
import { findStandSpot } from './query_stand.js';
import { moveTo } from './nav_pathfinder.js';
import { waitUntil } from './atom_wait.js';
import { findDrops } from './query_drops.js';
import { EYE_HEIGHT } from '../rules/rules.runtime.js';
import Vec3 from 'vec3';

/** 复合技能 manifest（04 §4.1）：捡附近的掉落物。 */
export const manifest = {
    name: 'pickup',
    level: 'flow',
    summary: '把某处附近的掉落物捡进背包',
    params: {
        at: 'pos?',
        radius: 'int 1..32 = 8',
    },
    needs: { items: [], near: [] },
    claims: [],
    codes: ['NO_TARGET', 'NO_PATH', 'TIMEOUT', 'INTERRUPTED'],
    resumable: false,
    timeoutMs: 3 * 60 * 1000,
};


/**
 * 回收 origin 附近的掉落物。
 *
 * @param {object} bot
 * @param {{x,y,z}} origin 挖掘点（掉落物通常在这附近）
 * @param {object} opts
 *   countFn       () => number，返回"已获得的合计数量"，默认统计背包（需自己传）
 *   baseCount     起始数量，判据是 countFn() - baseCount > 0
 *   radius        掉落物搜索半径，默认 8
 *   deadlineMs    总时限，默认 8000
 *   onStep        每步回调（给上层做时间线）
 *
 * @returns ActionResult
 *   ok  → data: { gained, waitedMs, steps }
 *   TIMEOUT → 没捡到（data 同样带steps，便于定位在哪一步失败）
 */
export async function collectDrops(bot, origin, opts = {}) {
    const {
        countFn = () => 0,
        radius = 8,
        deadlineMs = 8000,
        onStep = () => { },
    } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    if (!origin || !Number.isFinite(origin.x)) {
        return fail('NO_TARGET', '要给挖掘点坐标');
    }

    const t0 = Date.now();
    const steps = [];

    // 判据基准：**这次调用开始前**的数量。
    //
    // 原来是调用方传 baseCount（任务开始时的数量），于是：
    // 任务一开始捡到过 1 个之后，`countFn() - baseCount > 0` 就恒为真，
    // 后续每次 collectDrops 都立刻"判定成功"、直接返回 —— 后面挖的全都捡不到。
    // 实测（2026-10-24 主服基线）：拿到 4 个之后就再也涨不上去。
    //
    // 现在默认在调用开场自己快照一次；调用方仍可显式传 baseCount（少数场景需要）。
    let base;
    if (Number.isFinite(opts.baseCount)) {
        base = opts.baseCount;
    } else {
        try { base = countFn(); } catch { base = 0; }
    }

    // countFn 是调用方给的，可能抛错（比如背包还没就绪）。
    // 它抛错不该让整个原子崩掉——降级成"拿不到增量"，让超时逻辑正常走完。
    let countErr = null;
    const gained = () => {
        try { return countFn() - base; } catch (e) { countErr = e; return 0; }
    };
    const step = (name, extra = {}) => {
        steps.push({ step: name, at: Date.now() - t0, gained: gained(), ...extra });
        onStep({ type: name, ...extra });
    };

    const waitGain = async (ms) => {
        const r = await waitUntil(
            () => (gained() > 0 ? true : undefined),
            { timeoutMs: ms, intervalMs: 150, bot },
        );
        return r.ok === true;
    };

    // 1) 挖完先【原地静止】一小会儿再动。
    // 服务端拾取是「玩家靠近 + 服务端 tick 处理」，挖完立刻走开可能还没 tick 到。
    try { bot.clearControlStates(); } catch { /* ignore */ }
    if (await waitGain(400)) { step('wait-short'); return okResult(); }
    if (await waitGain(1200)) { step('wait-long'); return okResult(); }
    step('wait-failed');

    // 2) 附近有掉落物实体就逐个走过去（实体位置比"方块原坐标"准）
    //
    // 注意（2026-10-25 修复）：这里原来写 `e.type === 'item'`，是**错的**。
    // 实测 mineflayer 4.39 + MC 1.21.8 下掉落物的 `type` 是 `'other'`，
    // `name` 才是 `'item'` —— 所以"走过去捡"这条分支从来没执行过，
    // 一直只靠原地等自动吸附。改走 findDrops 原子（它已按 name 判，并带回归测试）。
    for (let round = 0; round < 2; round++) {
        if (Date.now() - t0 > deadlineMs) break;
        if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了', { gained: gained(), steps });

        const found = findDrops(bot, { near: origin, radius });
        if (!found.ok || !found.data?.count) {
            step('no-drop-entity', { seenInWorld: found.data?.seenInWorld ?? 0, radius });
            break;
        }

        const target = found.data.items[0];
        step('walk-to-drop', { dist: target.dist, count: found.data.count });
        // 用实体的精确坐标——地板化会把落点挪到方块中心，常差半格导致吸不到
        const dest = target.exactPos ?? target.pos;
        await moveTo(bot, { kind: 'point', pos: { x: Math.floor(dest.x), y: Math.floor(dest.y), z: Math.floor(dest.z) } },
            { tol: 0, timeout: 6000 });
        if (await waitGain(1200)) return okResult();
    }

    // 3) 回到挖掘点附近踩一脚。
    // 不能直接 moveTo(origin)：方块已挖掉，原位是空气，站不进去，寻路必然失败。
    // 站到挖掘点旁边最近的可站格，让掉落物进入拾取半径。
    //
    // 关键补强（2026-10-24 主服实测）：在高处作业（树冠 y≈69、地面 y≈64）时，
    // 掉落物会掉到地面。而柱顶/树冠上**往往有站位**（本站得住的格子），
    // 所以"找不到站位才往下找"这个条件永远不会触发 —— 实测 stepped on origin
    // 但 gained 仍然 0（tools/verify_drops_from_height.mjs）。
    //
    // 正确逻辑：**先试 origin 附近，捡不到再逐层往下试**（最多 8 格）。
    // 掉落物受重力，一定在下方，所以往下找是对的方向。
    let picked = false;
    for (let dy = 0; dy >= -8 && !picked; dy--) {
        const probe = { x: origin.x, y: origin.y + dy, z: origin.z };
        const spot = findStandSpot(bot, probe, { maxReach: 3.0 });
        if (!spot.ok) {
            if (dy === -8) step('no-stand-spot', { code: spot.code });
            continue;
        }
        step(dy === 0 ? 'step-on-origin' : 'step-below', {
            dy,
            ephemeral: spot.data.supportEphemeral,
        });
        const mv = await moveTo(bot, { kind: 'point', pos: spot.data.pos }, { tol: 0, timeout: 5000 });
        if (await waitGain(1200)) { picked = true; break; }

        // 用 moveTo 现在会报告的落脚状态判断（2026-10-25 契约补强）：
        //   原来的做法是读 bot.entity.onGround —— 但那个标志会卡住不可信
        //   （交接文档记过：外部瞬移后 onGround 会一直 false）。
        //   现在 moveTo 直接给 standable / groundBlock / landedAt，按脚下方块判定。
        //
        // 只记录，不强行修正：修正站位属于调用方的事，原子不偷偷改变世界。
        const landed = mv.data?.landedAt ?? null;
        const grounded = mv.data?.standable === true;
        const onLeaf = /_leaves$/.test(mv.data?.groundBlock ?? '');
        if (mv.code !== 'OK' || !grounded || onLeaf) {
            step('move-not-grounded', {
                code: mv.code,
                standable: mv.data?.standable,
                groundBlock: mv.data?.groundBlock,
                onLeaf,
                landedAt: landed,
            });
        }
    }

    // 收尾等待（2026-10-25 实测补强）：
    //   循环结束时如果"已经走到挖掘点附近"，物品往往正在飞过来，
    //   但此时立刻返回 TIMEOUT 就会漏掉它——
    //   实测现象：check「回收成功」报 TIMEOUT，可下一条「背包真的 +1」却是 PASS。
    //   所以按当前离 origin 的距离给一次额外等待：越近等越久。
    if (!picked) {
        const d = Math.hypot(
            bot.entity.position.x - (origin.x + 0.5),
            bot.entity.position.z - (origin.z + 0.5),
        );
        if (d <= 6) {
            // 用「还剩多少时间」而不是固定值：
            // 实测物品常在最后一步走完后 1~3 秒才飞进背包，
            // 固定 1200ms 会漏掉，导致「报 TIMEOUT 但背包其实 +1」。
            const left = Math.max(0, deadlineMs - (Date.now() - t0));
            const extra = Math.min(3000, Math.max(1200, left));
            step('final-wait', { dist: Number(d.toFixed(2)), waitMs: extra });
            if (await waitGain(extra)) picked = true;
        }
    }

    // 如果 countFn 一直抛错，说明"判据本身不可用"，这比"没捡到"更值得上层注意
    if (countErr) {
        return fail('INTERNAL', `countFn 一直抛错，无法判断是否捡到：${String(countErr?.message ?? countErr)}`, {
            gained: 0, waitedMs: Date.now() - t0, steps,
        });
    }

    return fail('TIMEOUT', `等了 ${Date.now() - t0}ms 掉落物没进背包`, {
        gained: gained(),
        waitedMs: Date.now() - t0,
        steps,
    });

    function okResult() {
        return ok({
            gained: gained(),
            waitedMs: Date.now() - t0,
            steps,
        });
    }
}
