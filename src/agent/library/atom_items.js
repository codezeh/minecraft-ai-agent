/**
 * A5 物品：equipItem / dropItem。
 */
import { ok, fail } from './atom_contract.js';
import { countItem } from './atom_perceive.js';

export function findItem(bot, name) {
    const items = bot.inventory?.items?.() ?? [];
    return items.find(i => i.name === name) ?? null;
}

export async function equipItem(bot, name, destination = 'hand') {
    const item = findItem(bot, name);
    if (!item) return fail('NO_ITEM', `背包里没有 ${name}`);
    try {
        await bot.equip(item, destination);
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
    const held = destination === 'hand' ? bot.heldItem?.name : null;
    if (destination === 'hand' && held !== name) {
        return fail('NO_ITEM', `没换上 ${name}（手上是 ${held ?? '空'}）`);
    }
    return ok({ equippedItem: name, count: item.count });
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
