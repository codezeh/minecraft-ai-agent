/**
 * A3 挖掘：digBlock。
 *
 * 单一副作用：让一个方块消失。不负责走过去、不负责捡东西——那是复合层的事。
 * 失败分类：NO_TARGET / OUT_OF_REACH / NO_TOOL / TIMEOUT / INTERRUPTED / INTERNAL。
 */
import Vec3 from 'vec3';
import { ok, fail, normalizeTarget } from './atom_contract.js';
import { waitUntil } from './atom_wait.js';
import { blockAt, canReach, reachDistanceTo } from './atom_perceive.js';
import { findItem } from './atom_items.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UNDIGGABLE = new Set(['bedrock', 'water', 'lava', 'air', 'cave_air', 'void_air']);

/** 挖不动的方块直接判 NO_TARGET，不要让她在基岩上耗时间。 */
export function isDiggable(block) {
    if (!block) return false;
    if (UNDIGGABLE.has(block.name)) return false;
    if (block.name.endsWith('_water') || block.name.endsWith('_lava')) return false;
    return block.diggable !== false;
}

/**
 * 挖掉 pos 处的方块。
 * @returns ActionResult，data: { block, pos, costMs }
 */
export async function digBlock(bot, pos, opts = {}) {
    // 5.1 的依据（2026-10-24 实测定论）：
    //   ① Paper 服务端基本不校验距离 —— 实测 6.11 格也能挖成功
    //   ② mineflayer 的 canDigBlock 用 5.1，但 bot.dig() 根本不调用它
    //   ③ pathfinder 的 GoalLookAtBlock 默认 4.5，且要求射线命中
    // 所以客户端侧唯一有意义的阈值是 5.1（比服务端保守一点也够用）。
    const { maxReach = 5.1, verifyMs = 1500 } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');
    // 归一化必须在构造 Vec3 之前：否则 v 拿到的是 {kind,pos} 对象
    const _t = normalizeTarget(pos);
    if (!_t || !_t.pos) return fail('NO_TARGET', '目标位置无效');
    pos = _t.pos;
    const v = new Vec3(pos.x, pos.y, pos.z);

    const block = blockAt(bot, v);
    if (!block) return fail('NO_TARGET', '那个位置没有方块');
    if (!isDiggable(block)) return fail('NO_TARGET', `${block.name} 挖不掉`);

    // 前置：必须站稳。
    // 实测（tools/_dbg_dig4 对照）：同样的方块、同样的距离，
    // 站在地上 512ms 挖完；onGround=false 时 bot.dig 永远不会触发（它一直在等落地），
    // 表现成模糊的「挖了 1.5 秒还没挖完」，很难定位。
    //
    // 为什么会 onGround=false：外部瞬移（RCON tp）后客户端认为自己悬空，
    // 速度为 0 时物理引擎不会自己纠正。这里直接按【脚下的方块】判定，
    // 而不是信 onGround 标志——脚下有实心方块就是站着的，这比标志可靠。
    if (bot.entity?.onGround !== true) {
        const below = bot.blockAt?.(new Vec3(
            Math.floor(bot.entity.position.x),
            Math.floor(bot.entity.position.y) - 1,
            Math.floor(bot.entity.position.z),
        ));
        const supported = below && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(below.name);
        if (supported) {
            bot.entity.onGround = true;   // 修正标志，让 bot.dig 能开始
        } else {
            // 真的悬空：蹬一下触发落地，再判一次
            let grounded = false;
            for (let attempt = 0; attempt < 3 && !grounded; attempt++) {
                try {
                    bot.setControlState('forward', true);
                    await sleep(120);
                    bot.setControlState('forward', false);
                    await sleep(200);
                } catch { /* ignore */ }
                grounded = bot.entity?.onGround === true;
            }
            if (!grounded) {
                return fail('BLOCKED', '现在悬空，先落地再挖', {
                    block: block.name, pos: { x: v.x, y: v.y, z: v.z },
                });
            }
        }
    }

    const dist = reachDistanceTo(bot, v);
    // 可达判据【只看距离，不查视线】—— 这是实测结论，不是推测：
    //   目标原木在 3 格外、中间挡一层 oak_leaves 时，
    //   world.raycast 命中的是树叶（不是原木），但 bot.dig 照样把原木挖掉了。
    // 因为服务端不校验视线。若加视线检查，整片丛林树都会被误判成"够不着"。
    if (dist > maxReach) {
        return fail('OUT_OF_REACH', `够不着，眼睛到方块 ${dist.toFixed(1)} 格`, { distEyeToBlock: dist, block: block.name });
    }

    // 选工具：能用手就用手，需要更好的工具而背包没有就如实报
    const tool = bot.pathfinder?.bestHarvestTool?.(block) ?? null;
    if (tool) {
        try { await bot.equip(tool, 'hand'); } catch { /* 装备失败就用手试试 */ }
    }
    const heldId = bot.heldItem ? bot.heldItem.type : null;
    if (!block.canHarvest(heldId)) {
        return fail('NO_TOOL', `${block.name} 需要更好的工具`, { block: block.name });
    }

    const t0 = Date.now();
    const digMs = Math.max(1200, (block.digTime?.(heldId) ?? 500) * 2 + 500);

    // 挖之前先停寻路：如果 pathfinder 还有目标在跑，它会和 bot.dig 抢控制，
    // 表现为"挖了 1.5 秒还没挖完"（实测：单独调用 517ms 成功，
    // 但前一个动作留下 pathfinder 目标后就超时）。
    // 原子要保证单一副作用，不能和别的动作并存。
    try { bot.pathfinder?.stop?.(); } catch { /* ignore */ }
    try { bot.stopDigging?.(); } catch { /* ignore */ }

    let digErr = null;
    if (process.env.DIG_DEBUG) {
        console.log(`[dig-dbg] 目标=${block.name} 位置=${block.position} 距离=${dist.toFixed(2)} 手持=${bot.heldItem?.name} digTime=${block.digTime?.(heldId)} budget=${digMs}`);
    }
    const digging = bot.dig(block, true).catch((e) => {
        digErr = e;
        if (process.env.DIG_DEBUG) console.log('[dig-dbg] bot.dig 抛错:', e.message);
    });
    const timedOut = await Promise.race([
        digging.then(() => false),
        sleep(digMs).then(() => true),
    ]);

    if (timedOut) {
        try { bot.stopDigging(); } catch { /* ignore */ }
        return fail('TIMEOUT', `挖了 ${Date.now() - t0}ms 还没挖完`, { block: block.name, costMs: Date.now() - t0 });
    }
    if (digErr) {
        const msg = String(digErr?.message ?? digErr);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了');
        return fail('INTERNAL', msg, { error: msg, block: block.name });
    }

    // 复核：方块真的消失了吗（幽灵方块会让"挖了"变成假成功）
    const gone = await waitGone(bot, v, verifyMs);
    if (!gone) {
        return fail('TIMEOUT', `挖了但 ${block.name} 还在`, { block: block.name, pos: { x: v.x, y: v.y, z: v.z } });
    }

    return ok({ dugBlock: block.name, pos: { x: v.x, y: v.y, z: v.z }, costMs: Date.now() - t0 });
}

async function waitGone(bot, v, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const b = blockAt(bot, v);
        if (!b || b.name === 'air' || b.name === 'cave_air') return true;
        await sleep(80);
    }
    return false;
}

/**
 * Can she actually dig this block **with what she is carrying**?
 *
 * @param {object} bot
 * @param {object} block, a block from bot.blockAt()
 * @returns {boolean} false when the block is diggable in principle but she has
 *   no tool that can harvest it (or the tool is about to break).
 *
 * Why this exists (2026-10-29):
 *   `isDiggable` only answers "is this block diggable at all", which is a
 *   property of the block, not of the bot. The planner used it to decide whether
 *   to route through a wall, so with an empty inventory it kept ordering
 *   "dig down through andesite" and the executor failed every round:
 *     步1 down(-122,55,-222) 失败: NO_TOOL 向下挖 andesite 失败   (x4 rounds)
 *   then gave up with NO_REACH. The route was never physically possible.
 *
 *   This function is the missing link: the planner can ask it before emitting a
 *   dig edge, so "no pickaxe" becomes "go around" instead of "fail four times".
 */
export function canDigWithInventory(bot, block) {
    if (!block) return false;
    if (!isDiggable(block)) return false;

    // Blocks she can dig bare-handed (no tool required in vanilla).
    const name = String(block.name || '');
    if (/dirt|sand|gravel|grass|clay|leaves|wool|snow|soul_/.test(name)) return true;

    const items = bot.inventory?.items?.() ?? [];
    // Pickaxe covers stone-family blocks (the common case when digging down).
    const pick = items.find(i => /_pickaxe$/.test(i.name));
    if (pick) {
        // A pickaxe with almost no durability left is as good as none.
        const max = pick.maxDurability ?? 0;
        const used = pick.durabilityUsed ?? 0;
        if (!max || max - used > 2) return true;
    }
    // Shovel covers dirt/sand; axe covers wood. Accept either as a fallback so we
    // do not refuse a route the bot could actually dig.
    const shovel = items.find(i => /_shovel$/.test(i.name));
    const axe = items.find(i => /_axe$/.test(i.name));
    if (shovel || axe) return true;

    return false;
}
