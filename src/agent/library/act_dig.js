/**
 * A3 挖掘：digBlock。
 *
 * 单一副作用：让一个方块消失。不负责走过去、不负责捡东西——那是复合层的事。
 * 失败分类：NO_TARGET / OUT_OF_REACH / NO_TOOL / TIMEOUT / INTERRUPTED / INTERNAL。
 */
import Vec3 from 'vec3';
import { ok, fail, normalizeTarget } from './contract.js';
import { waitUntil } from './atom_wait.js';
import { blockAt, canReach, reachDistanceTo } from './query_perceive.js';
import { findItem } from './act_items.js';
import { holdDig, stopDig } from './atom_input_mouse.js';

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
            // ★ 原子层规范化（2026-10-31）：**不再按键去"蹬一下"**。
            //
            // 旧代码在这里 for 循环 3 次 `setControlState('forward')`，指望物理引擎
            // 把她抖落到地面。两个问题：
            //   1. 契约不允许原子直接按键（按键必须经原子封装，见
            //      ARCHITECTURE_REDESIGN §6.6）；换位置/落地是移动原子的事。
            //   2. 真的悬空（脚下是空气/水/岩浆）时按"前进"并不能救人，
            //      它只是把"我挖不了"这件事拖成 960ms 的副作用。
            //
            // 该走的路是老实返回 BLOCKED，让上层（executor / skill_escape）决定
            // 是挖上去、垫下去还是换目标 —— 那才是它们的信息与职责。
            return fail('BLOCKED', '现在悬空（脚下没有可站立的方块），先落地再挖', {
                block: block.name, pos: { x: v.x, y: v.y, z: v.z },
            });
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
    await stopDig(bot);

    if (process.env.DIG_DEBUG) {
        console.log(`[dig-dbg] 目标=${block.name} 位置=${block.position} 距离=${dist.toFixed(2)} 手持=${bot.heldItem?.name} digTime=${block.digTime?.(heldId)} budget=${digMs}`);
    }

    // ★ 2026-11-01（Phase A.2）：按住左键这个输入交回 `atom_input_mouse.holdDig`。
    // 原来这段自己 Promise.race(bot.dig, sleep(digMs))，两个问题：
    //   ① 等待中不查 interrupt_code（D21）—— 喊停了也要挖完/超时才回来；
    //   ② 超时 / 异常 / 中断三种结局的分类只有这一份，别处再挖就要抄一遍。
    const dig = await holdDig(bot, block, { digTimeMs: digMs });
    if (!dig.ok) {
        if (dig.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { block: block.name });
        if (dig.code === 'TIMEOUT') {
            return fail('TIMEOUT', `挖了 ${Date.now() - t0}ms 还没挖完`, { block: block.name, costMs: Date.now() - t0 });
        }
        return fail('INTERNAL', dig.message, { error: dig.data?.error ?? dig.message, block: block.name });
    }

    // 复核：方块真的消失了吗（幽灵方块会让"挖了"变成假成功）
    //
    // ★ 2026-11-01（D21）：等方块消失的循环放到 `atom_wait.waitUntil` 里，并把 bot 传进去 ——
    // 原来 waitGone 自己 while+sleep，**不查 interrupt_code**，取消后还要空等最多 1.5 秒。
    const gone = await waitUntil(() => {
        const b = blockAt(bot, v);
        if (!b || b.name === 'air' || b.name === 'cave_air') return true;
        return undefined;
    }, { timeoutMs: verifyMs, intervalMs: 80, bot });
    if (!gone.ok) {
        if (gone.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { block: block.name });
        return fail('TIMEOUT', `挖了但 ${block.name} 还在`, { block: block.name, pos: { x: v.x, y: v.y, z: v.z } });
    }

    return ok({ dugBlock: block.name, pos: { x: v.x, y: v.y, z: v.z }, costMs: Date.now() - t0 });
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
    //
    // ★ 2026-11-02 真机验收抓到的 bug：原来只取**第一把**镐 `.find()`，
    //   那把磨损了就判定"挖不动"——哪怕背包里还有 5 把全新的。
    //   实测症状：同一个 bot 名反复重启后背包里堆了 6 把镐（有的磨秃了），
    //   第一把恰好是旧的 → `canDigWithInventory` 返回 false → `flow_mine` 报
    //   NO_TOOL「没有合适的镐」→ 单子被正确判 blocked，但**其实她完全挖得动**。
    //   （这和本项目反复踩的"只看第一个"是同一类错。）
    //   改成"**任意一把**还能用就算有工具"。
    const picks = items.filter(i => /_pickaxe$/.test(i.name));
    for (const pick of picks) {
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
