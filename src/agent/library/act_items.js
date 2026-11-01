/**
 * A5 物品：equip / equipItem（等价旧名）/ eat / dropItem。
 *
 * M6（2026-11-02）补了两处：
 *   · `equip(item, slot)` 增加**护甲槽校验**（原来只校验了 hand，戴没戴上头盔看不出来）；
 *   · `eat(food?)` 从 `skills.consume` 收上来，并补了"饱食度已经满了就不吃"的前置。
 *     旧 `consume` 返回 boolean，且**不看饱食度**（吃饱了也硬吃，白浪费食物）。
 */
import { ok, fail } from './contract.js';
import { countItem } from './query_perceive.js';

export function findItem(bot, name) {
    const items = bot.inventory?.items?.() ?? [];
    return items.find(i => i.name === name) ?? null;
}

/** mineflayer 的装备槽名。hand 之外的就是护甲槽。 */
const EQUIP_SLOTS = ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'];

/** 读某个槽当前装的是什么（读不到返回 undefined —— 表示"没法验证"，不是"空的"）。 */
function readSlot(bot, slot) {
    if (slot === 'hand') return bot.heldItem?.name ?? null;
    // 护甲：mineflayer 的 inventory.slots 里 5=头 6=胸 7=腿 8=脚（1.9+ 协议）；
    // 有的实现挂在 entity.equipment 上。两种都试，都没有就返回 undefined。
    const idx = { head: 5, torso: 6, legs: 7, feet: 8 }[slot];
    const slots = bot.inventory?.slots;
    if (idx != null && Array.isArray(slots) && slots.length > idx) {
        return slots[idx]?.name ?? null;
    }
    const eq = bot.entity?.equipment;
    if (Array.isArray(eq)) {
        const i = { head: 4, torso: 3, legs: 2, feet: 1 }[slot];
        if (i != null) return eq[i]?.name ?? null;
    }
    return undefined;
}

/**
 * 把背包里的 item 装到某个槽（默认手上）。
 *
 * @param {string} slot hand | head | torso | legs | feet | off-hand
 * @returns ActionResult
 *   ok        → data: { equippedItem, slot, verified, count }
 *   NO_ITEM   背包里没有这件东西
 *   NO_TARGET 槽名不认识
 *
 * verified=false：这个 bot 实现读不到那个槽的状态，所以"装上了"只能报"没法验证"。
 * 不假装成功 —— 但也别 fail，因为装备调用本身没报错。
 */
export async function equip(bot, name, slot = 'hand') {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!EQUIP_SLOTS.includes(slot)) {
        return fail('NO_TARGET', `不认识的装备槽 ${slot}（可用：${EQUIP_SLOTS.join('/')}）`);
    }
    const item = findItem(bot, name);
    if (!item) return fail('NO_ITEM', `背包里没有 ${name}`);

    try {
        await bot.equip(item, slot);
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e), slot });
    }

    const got = readSlot(bot, slot);
    if (got === undefined) {
        // 读不到槽 → 无法验证，但也不能声称成功
        return ok({ equippedItem: name, slot, verified: false, count: item.count });
    }
    if (got !== name) {
        return fail('NO_ITEM', `没换上 ${name}（${slot} 现在是 ${got ?? '空'}）`, { slot, got });
    }
    return ok({ equippedItem: name, slot, verified: true, count: item.count });
}

/** 旧名保留（上游与既有测试都在调它）；等价于 equip(bot, name, destination)。 */
export async function equipItem(bot, name, destination = 'hand') {
    return equip(bot, name, destination);
}

/**
 * 吃/喝一样东西。
 *
 * 前置：饱食度没满（满了就别浪费）、背包里有这样东西。
 *
 * @param {string} [food] 吃指定的东西；不给就从背包里挑一样能吃的
 * @returns ActionResult
 *   ok        → data: { ate, food, foodBefore, foodAfter }
 *   NO_ITEM   没有能吃的东西
 *   NOT_READY 饱食度已经满了 —— 与 BLOCKED 的区别：BLOCKED 是"现在做不了、要换个法子"，
 *             NOT_READY 是"时机不对，等饿了再来"（02 §4 的错误码注释原话）
 */
export async function eat(bot, food = null) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const foodBefore = Number(bot.food ?? 20);
    if (foodBefore >= 20) {
        return fail('NOT_READY', '不饿（饱食度已经满了）', { food: foodBefore });
    }

    let stack = null;
    if (food) {
        stack = findItem(bot, food);
        if (!stack) return fail('NO_ITEM', `背包里没有 ${food}`, { food });
    } else {
        // 挑一样能吃的：优先名字像食物的（不含桶/种子这类误判项）
        const EDIBLE_RE = /^(bread|cooked_|apple|carrot|potato|baked_potato|beef|porkchop|chicken|mutton|rabbit|fish|salmon|cod|melon_slice|sweet_berries|glow_berries|cookie|cake|golden_apple|golden_carrot|mushroom_stew|beetroot_soup|rabbit_stew|pumpkin_pie|dried_kelp)/;
        stack = (bot.inventory?.items?.() ?? []).find((i) => i?.name && EDIBLE_RE.test(i.name) && (i.count ?? 0) > 0) ?? null;
        if (!stack) return fail('NO_ITEM', '背包里没有能吃的东西', {});
    }

    try {
        if (bot.heldItem?.name !== stack.name) await bot.equip(stack, 'hand');
        await bot.consume();
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { food: stack.name });
        return fail('INTERNAL', msg, { error: msg, food: stack.name });
    }

    const foodAfter = Number(bot.food ?? foodBefore);
    if (!(foodAfter > foodBefore)) {
        // 吃了但饱食度没涨：可能是不饿到头（saturation）或这东西其实不能吃
        return fail('NOT_READY', `吃了 ${stack.name} 但饱食度没涨（${foodBefore}→${foodAfter}）`, {
            food: stack.name, foodBefore, foodAfter,
        });
    }
    return ok({ ate: stack.name, food: stack.name, foodBefore, foodAfter });
}

export async function dropItem(bot, name, count = 1) {
    const item = findItem(bot, name);
    if (!item) return fail('NO_ITEM', `背包里没有 ${name}`);
    const n = Math.min(count, item.count);
    try {
        await bot.toss(item.type, null, n);
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e));
    }
    return ok({ droppedItem: name, dropped: n, left: countItem(bot, name) });
}
