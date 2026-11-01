/**
 * A34 跳垫：跳起来，在半空中往脚下垫一块方块 —— **单次尝试**。
 *
 * 为什么单独一个原子（REFACTOR_ANALYSIS §5 Phase 2.2 P0「统一跳垫逻辑」）：
 *   这套动作原来只存在于 `executor.stepUp`（私有函数），而 `skill_escape` 里
 *   又照着抄了一份"跳跃 + 放方块"（`jumpPlace`）。两处细节已经开始不一样：
 *   一处等 0.95 格才放、另一处等 0.9；一处放完等 450ms、另一处 300ms。
 *   这就是"同一能力两套实现"的典型（改进规划 C4）。
 *
 * 分工（与契约一致，见 ARCHITECTURE_REDESIGN §6.1）：
 *   **本原子只做一次**：起跳 → 到顶点 → 垫脚下 → 落地 → 报告升高了多少。
 *   「挖开头顶空间」「失败重试 3 次」都是复合层的事，留在 `executor.stepUp`。
 *
 * 为什么这个原子可以按键：按键由 `atom_input_move.holdKey` 统一发出（01_primitives.md §3.1），
 * 而"跳"是物理动作本身，和 `atom_climb`（爬梯子）同类。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { holdKey } from './atom_input_move.js';
import { blockAt, inventory } from './atom_read.js';
import { placeAgainst } from './atom_input_mouse.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 起跳判定阈值：脚要抬过 y+0.95，脚下那格才真空出来（实测值，勿随意改）。 */
const LIFT_TARGET = 0.95;
/** 起跳后判定成功的阈值：抬过 0.7 就认为上去了（实测值）。 */
const RISE_TARGET = 0.7;
/** 等起跳的轮询：16 × 25ms = 400ms。 */
const LIFT_POLLS = 16;
const LIFT_POLL_MS = 25;

/**
 * 跳起来往脚下垫一块方块（单次尝试）。
 *
 * @param {object} bot
 * @param {object} opts
 *   item      要垫的方块名（必须已在背包里；本原子不负责准备材料）
 *   settleMs  放完之后的沉降等待，默认 450
 * @returns ActionResult
 *   ok  → data: { fromY, toY, rose, placedAt }
 *   NO_ITEM 背包里没有 item
 *   STUCK   起跳后没抬起来 / 抬起来了但垫不进去
 */
export async function pillarUpOnce(bot, opts = {}) {
    const { item, settleMs = 450 } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!item) return fail('NO_ITEM', '没说要垫什么方块');

    // 材料必须已经在背包里（准备材料是复合层的事）
    const have = inventory(bot).some(i => i?.name === item && i.count > 0);
    if (!have) return fail('NO_ITEM', `背包里没有 ${item}`);

    const y0 = bot.entity.position.y;
    const feet = {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
    };

    // ★ 2026-11-01（Phase A.1）：按键改由 `atom_input_move.holdKey` 负责。
    //
    // 为什么要这么绕：跳垫必须**全程按住 jump**（抬到顶点 → 垫块 → 落地），
    // 松早了会在垫块之前掉回去、方块放不进自己脚下那格。
    // holdKey 的判据 `until` 是"垫块做完了没有"，做完才置真 → 键在整个垫块期间按着，
    // 退出时由 finally 松开（A7）；中断也由它每 25ms 查一次（A3）。
    //
    // 起跳后的物理事实（实测，勿凭直觉改）：松开 jump 不改变**空中轨迹**，
    // 只在落地时决定要不要再跳一次。所以"按住时长"只影响 bunny-hop，不影响这一跳的高度。
    let placingDone = false;
    const holding = holdKey(bot, 'jump', {
        until: () => placingDone,
        timeout: LIFT_POLLS * LIFT_POLL_MS + 5000,
        intervalMs: LIFT_POLL_MS,
    });

    // 等接近跳跃顶点（脚要抬过 y+0.95，方块那格才真空出来）
    let lifted = false;
    for (let w = 0; w < LIFT_POLLS; w++) {
        await sleep(LIFT_POLL_MS);
        if (bot.interrupt_code) {
            placingDone = true;
            await holding;                       // 让 holdKey 走自己的松键路径
            return fail('INTERRUPTED', '起跳过程中被取消了');
        }
        if (bot.entity.position.y > y0 + LIFT_TARGET) { lifted = true; break; }
    }

    let placeResult = null;
    if (lifted) {
        // 换手（工具类原子不管这个，单次尝试也不该走两遍）
        const itemEntity = inventory(bot).find(i => i?.name === item && i.count > 0);
        try {
            if (itemEntity && bot.equip) await bot.equip(itemEntity, 'hand');
        } catch { /* 换手失败就试试放 */ }

        // 支撑面 = 脚下那一格（feet 自己就是她要站的那格，方块放这里）
        const ref = blockAt(bot, new Vec3(feet.x, feet.y - 1, feet.z));
        if (!ref) {
            placeResult = 'no-support';
        } else {
            const pr = await placeAgainst(bot, ref, new Vec3(0, 1, 0));
            placeResult = pr.ok ? 'placed' : `place-failed:${String(pr.message).slice(0, 60)}`;
        }
    }

    placingDone = true;
    const held = await holding;                  // 到这里 jump 已经松开（finally）
    if (!held.ok && held.code === 'INTERRUPTED') {
        return fail('INTERRUPTED', '垫脚过程中被取消了', { fromY: y0, toY: bot.entity.position.y });
    }
    await sleep(settleMs);

    const toY = bot.entity.position.y;
    const rose = toY - y0;

    if (rose > RISE_TARGET) {
        return ok({ fromY: y0, toY, rose, placedAt: feet, placeResult });
    }
    if (!lifted) {
        return fail('STUCK', `跳不起来（停在 y=${toY.toFixed(2)}，头顶可能没空间）`, {
            fromY: y0, toY, rose, placedAt: feet, placeResult,
        });
    }
    return fail('STUCK', `跳起来了但没垫上去（停在 y=${toY.toFixed(2)}）`, {
        fromY: y0, toY, rose, placedAt: feet, placeResult,
    });
}
