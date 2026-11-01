/**
 * A3 攀爬：梯子 / 藤蔓。
 *
 * 单一副作用：让 bot 沿可攀爬方块上升或下降。不负责"走到梯子边上"——那是复合层的事。
 * 失败分类：NO_TARGET / NOT_CLIMBABLE / NO_SUPPORT / TIMEOUT / INTERRUPTED / INTERNAL。
 *
 * ★ 2026-10-28 新建。参考 miner-org/mineflayer-baritone 的 src/movement/climb.js，
 *   按本项目原子层的规矩重写（单一副作用 + ok/fail + 错误码）。
 *
 * 为什么单独一个原子（用户原话：「藤蔓这个也困扰我们很久了」）：
 *   之前的处理是"躲开"——makeMovements 里按意图把 vine 移出 climbables，
 *   只能保证"不误爬"，不能保证"需要爬时爬得上去"。
 *   而 atom_dig 里又没有攀爬能力，于是遇到竖直藤蔓/梯子只能绕路或放弃。
 *
 * 从 baritone 移植的三个关键设计：
 *   ① **藤蔓是"能置身其中"的方块，不是"能站在上面"的**（canStandOnTop = false）。
 *      所以它只能当通道，不能当落脚点 —— 这解决了"把树冠当地面"的旧错。
 *   ② **攀爬一次只上 1 格**（上一格必须也是可攀爬），但**下降可以一次到底**
 *      （一直降到不能再降）。这样下降不用逐格算，滚动窗口少很多轮。
 *   ③ **进入/离开是独立动作**，各有前置：进入要脚下实心 + 目标格可爬 + 头顶空；
 *      向上离开要当前在爬 + 目标格可站 + 头上空。
 */
import Vec3 from 'vec3';
import { ok, fail } from './atom_contract.js';
import { blockAt } from './atom_read.js';
import { holdKey, releaseAll } from './atom_input_move.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 可攀爬方块。梯子永远算；藤蔓类按需（见 isClimbable 的 allowVine）。
 *
 * 为什么梯子和藤蔓要分开：
 *   梯子是人放的、专门用来上下，不存在"路过被顶上去"的问题；
 *   藤蔓是自然生成的，路过蹭到就会被抬起来（prismarine-physics 的
 *   isOnLadder() 把 ladder 和 vine 当同一种）。所以藤蔓要按意图开关。
 */
const LADDER = new Set(['ladder', 'oak_ladder', 'spruce_ladder', 'birch_ladder', 'jungle_ladder', 'acacia_ladder', 'dark_oak_ladder', 'mangrove_ladder', 'cherry_ladder', 'bamboo_ladder', 'crimson_ladder', 'warped_ladder', 'iron_ladder', 'copper_ladder']);

const VINE = new Set([
    'vine', 'weeping_vines', 'weeping_vines_plant',
    'twisting_vines', 'twisting_vines_plant',
    'cave_vines', 'cave_vines_plant',
]);

export function isClimbableName(name, { allowVine = true } = {}) {
    /**
     * Check whether a block name is climbable (ladder / vine).
     *
     * Ladders are always climbable. Vines are climbable only when allowVine is
     * true, because naturally generated vines make the bot get lifted while
     * merely walking past them (prismarine-physics treats ladder and vine alike).
     *
     * @param {string} name block name, with or without the minecraft: prefix
     * @param {{allowVine?:boolean}} opts
     * @returns {boolean}
     **/
    if (!name) return false;
    if (LADDER.has(name)) return true;
    if (allowVine && VINE.has(name)) return true;
    return false;
}

export function isClimbable(bot, pos, opts = {}) {
    /**
     * Check whether a specific block position is climbable.
     * Returns false when the block cannot be read (prefer under-claiming:
     * never plan a climb on a block we cannot see).
     *
     * @param {object} bot
     * @param {{x,y,z}|Vec3} pos
     * @param {{allowVine?:boolean}} opts
     * @returns {boolean}
     **/
    const b = toBlock(bot, pos);
    if (!b) return false;
    return isClimbableName(b.name, opts);
}

/** 规范化坐标并读方块。 */
function toBlock(bot, pos) {
    if (!pos) return null;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return blockAt(bot, new Vec3(x, y, z));
}

const AIRISH = new Set(['air', 'cave_air', 'void_air']);

export function climbableUp(bot, pos, opts = {}) {
    /**
     * How many blocks you can climb upward starting from this position.
     * Rule (same as baritone): the current block must be climbable AND the block
     * above must also be climbable, and the head space must be clear.
     * Returns 0 when you cannot climb up at all.
     *
     * @param {object} bot
     * @param {{x,y,z}} pos
     * @param {{allowVine?:boolean}} opts
     * @returns {number}
     **/
    let cur = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    let n = 0;
    while (n < 64) {
        const self = toBlock(bot, cur);
        const up = toBlock(bot, { ...cur, y: cur.y + 1 });
        const upHead = toBlock(bot, { ...cur, y: cur.y + 2 });
        if (!isClimbableName(self?.name, opts)) break;      // 当前不是可爬的
        if (!isClimbableName(up?.name, opts)) break;        // 上一格不是可爬的 → 到顶
        if (!(upHead && AIRISH.has(upHead.name))) break;    // 头顶不空 → 卡住
        n++;
        cur = { ...cur, y: cur.y + 1 };
    }
    return n;
}

export function climbableDown(bot, pos, opts = {}) {
    /**
     * How many blocks you can climb downward from this position.
     * Descends until it either runs out of climbable blocks or hits the ground.
     * Baritone's MoveLadderDescend computes the whole descent in one go instead
     * of step by step, which keeps the rolling-horizon loop short.
     *
     * @param {object} bot
     * @param {{x,y,z}} pos
     * @param {{allowVine?:boolean}} opts
     * @returns {number}
     **/
    let cur = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    let n = 0;
    let lastValid = 0;
    while (n < 64) {
        const below = toBlock(bot, { ...cur, y: cur.y - 1 });
        const below2 = toBlock(bot, { ...cur, y: cur.y - 2 });
        if (!below) break;
        // 下方是可爬 → 继续；下方是空但再下方可爬 → 也能继续（攀爬柱常有空隙）
        const okBelow = isClimbableName(below.name, opts);
        const okBelow2 = below2 && AIRISH.has(below.name) && isClimbableName(below2.name, opts);
        if (!okBelow && !okBelow2) break;
        n++;
        lastValid = n;
        cur = { ...cur, y: cur.y - 1 };
        // 到底（下方实心非可爬）就停
        const ground = toBlock(bot, { ...cur, y: cur.y - 1 });
        if (ground && !isClimbableName(ground.name, opts) && !AIRISH.has(ground.name)) break;
    }
    return lastValid;
}

export async function climbUp(bot, opts = {}) {
    /**
     * Climb up along a ladder or vine, N blocks (default 1).
     *
     * How: hold jump. Both vines and ladders rise from the jump key alone
     * (measured; see rule R3-09 - vine climbing needs only the jump key, no need
     * to press against the block).
     *
     * Fails with NOT_CLIMBABLE when not standing on a climbable block, or
     * TIMEOUT when jump was held but the bot did not rise.
     *
     * @param {object} bot
     * @param {{steps?:number, timeout?:number, allowVine?:boolean, onEvent?:Function}} opts
     * @returns {Promise<ActionResult>} data: { fromY, toY, climbed }
     **/
    const { steps = 1, timeout = 8000, allowVine = true, onEvent = () => { } } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const p = bot.entity.position;

    // 允许"站在攀爬柱下方、头顶就是攀爬方块"的情形。
    //
    // 实测：藤蔓柱在 y=61~63，她站在 y=59（柱子下面的空气里）。
    // 严格按"当前格必须是攀爬方块"判会直接 NOT_CLIMBABLE，
    // 但实际只要按住 jump 就能升进柱子 —— 老版本 game 里藤蔓就是这么爬的。
    // 所以放宽到"当前格 或 头顶那一格"是可攀爬即可。
    const here = isClimbable(bot, p, { allowVine });
    const above = isClimbable(bot, { x: p.x, y: p.y + 1, z: p.z }, { allowVine });
    if (!here && !above) {
        return fail('NOT_CLIMBABLE', '我附近没有藤蔓/梯子，爬不了', { at: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } });
    }
    if (!here && above) onEvent({ type: 'climb-grab', note: '头顶是攀爬方块，先跳进去' });

    const fromY = p.y;
    const wantY = fromY + steps;

    // ★ 2026-11-01（Phase A.1）：按键改由 `atom_input_move.holdKey` 负责。
    //
    // 改之前这里自己 setControlState('jump', true) + waitUntil + setControlState(false)，
    // 而 waitUntil **没传 bot**（D16）：中断谓词 `if (bot.interrupt_code) return undefined`
    // 返回的是 undefined（= 继续等），所以"爬梯子时喊停"不会让循环退出 ——
    // 她会一直按住跳，直到 8 秒超时才松手。
    // holdKey 每 ~100ms 查一次 interrupt_code、并在 finally 里松键，两个问题一起没了。
    //
    // 判据保持原样（y 达标即算到位）：`>= wantY - 0.15` 是实测出来的容差，
    // 别在这里加"更聪明"的判定 —— climb-ladder 曾因"提前判到位"的宽判据回归过（4b4ac1c）。
    const held = await holdKey(bot, 'jump', {
        until: () => bot.entity.position.y >= wantY - 0.15,
        timeout,
        intervalMs: 100,
    });

    if (!held.ok && held.code === 'INTERRUPTED') {
        const toY = bot.entity.position.y;
        return fail('INTERRUPTED', '被取消了', { fromY, toY, climbed: toY - fromY });
    }
    await sleep(150);

    const toY = bot.entity.position.y;
    const climbed = toY - fromY;
    onEvent({ type: 'climb-up', fromY: +fromY.toFixed(2), toY: +toY.toFixed(2), climbed: +climbed.toFixed(2) });

    if (climbed < 0.5) {
        return fail('TIMEOUT', `爬了 ${timeout}ms 没上去（y ${fromY.toFixed(2)} → ${toY.toFixed(2)}）`,
            { fromY, toY, climbed });
    }
    return ok({ fromY, toY, climbed });
}

export async function climbDown(bot, opts = {}) {
    /**
     * Climb down along a ladder or vine, all the way (not one block at a time).
     *
     * How: hold sneak. On a ladder or vine the physics engine keeps you in place
     * when you press nothing, so sneak is what actually descends (measured).
     *
     * Fails with NOT_CLIMBABLE when not on a climbable block, or TIMEOUT when
     * sneak was held but the bot did not descend.
     *
     * @param {object} bot
     * @param {{maxSteps?:number, timeout?:number, allowVine?:boolean, onEvent?:Function}} opts
     * @returns {Promise<ActionResult>} data: { fromY, toY, dropped }
     **/
    const { maxSteps = 32, timeout = 12000, allowVine = true, onEvent = () => { } } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const p = bot.entity.position;
    if (!isClimbable(bot, p, { allowVine })) {
        return fail('NOT_CLIMBABLE', '我现在不在藤蔓/梯子上，下不去', { at: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } });
    }

    const fromY = p.y;
    const wantY = fromY - maxSteps;

    // ★ 2026-10-29 实测纠正：**下梯子要"什么都不按"，sneak 反而几乎不动**。
    //
    // 实测（同一根梯子，先爬上去再测，各 4 秒）：
    //   什么都不按  Δ-2.93  ← 最有效（自然下滑）
    //   back（后退） Δ-2.29  ← 也有效
    //   sneak       Δ-0.83  ← 几乎不动（原来用的是这个，所以一直降不下去）
    //
    // 所以这里要**清空所有按键**，让重力带她下去。
    await releaseAll(bot);

    // 同 climbUp（Phase A.1）：等待交给 holdKey —— 它每 ~100ms 查中断并在 finally 松键，
    // D16（中断谓词返回 undefined → 按到超时）在这条路径上同样没了。
    // 没有任何键要按（就是"什么都不按"），所以 keys 传空数组，只借它的等待/中断/松键。
    const held = await holdKey(bot, [], {
        until: () => {
            const now = bot.entity.position.y;
            if (now <= wantY) return true;
            // 已经脱离可攀爬方块（掉出来了）也算结束；否则继续等
            return !isClimbable(bot, bot.entity.position, { allowVine });
        },
        timeout,
        intervalMs: 100,
    });

    if (!held.ok && held.code === 'INTERRUPTED') {
        const toY = bot.entity.position.y;
        return fail('INTERRUPTED', '被取消了', { fromY, toY, dropped: fromY - toY });
    }
    await sleep(150);

    const toY = bot.entity.position.y;
    const dropped = fromY - toY;
    onEvent({ type: 'climb-down', fromY: +fromY.toFixed(2), toY: +toY.toFixed(2), dropped: +dropped.toFixed(2) });

    if (dropped < 0.5) {
        // ★ 2026-10-29：区分"已经到底了"和"降不动"。
        //
        // 实测：她站在梯子最底格（y=63），下方 y=62 是石头地面 ——
        // 本来就降不下去，但原来一律报 `TIMEOUT 降了 15000ms 没下去`，
        // 看了会以为是攀爬坏了。到底就说到底。
        const below = blockAt(bot, { x: p.x, y: Math.floor(toY) - 1, z: p.z });
        const atBottom = !!below && !isClimbable(bot, { x: p.x, y: Math.floor(toY) - 1, z: p.z }, { allowVine });
        if (atBottom) {
            return ok({ fromY, toY, dropped: 0, atBottom: true, bottomBlock: below.name });
        }
        return fail('TIMEOUT', `降了 ${timeout}ms 没下去（y ${fromY.toFixed(2)} → ${toY.toFixed(2)}）`,
            { fromY, toY, dropped });
    }
    return ok({ fromY, toY, dropped });
}
