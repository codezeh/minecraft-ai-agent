/**
 * 动作：农业（M6 P0，02 §3）。
 *
 *   harvestCrop(target)    作物成熟 → holdDig → 那格空了
 *   plantSeed(target, seed) 耕地上方是空气、有种子 → 放下 → 出现作物
 *   tillSoil(target)       手上是锄、目标是泥土/草方块 → 右键 → 变耕地
 *
 * 从 `act_use` 里拆出来的：原来 `useBlock` 按方块名分派到"门/床/工作站/作物"四类，
 * 其中作物那一支（成熟判断 + 收）根本不是“右键一下”，而是一个独立动作；
 * 和"上床""开门"塞在一个函数里，错误码只能混着用（分不清"没熟"和"门锁了"）。
 *
 * 农业三件事都**只做一次**：不收多块、不补种一圈、不等作物长大（那是 flow_farm 的事）。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { countItem } from './query_perceive.js';
import { holdDig, useOnBlock } from './atom_input_mouse.js';

/** 各作物的成熟 age（minecraft-data 里也是这几个数，写死是为了给出明确错误信息）。 */
const MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };

/** 坐标归一化成 Vec3（整数格）。 */
function vec(pos) {
    if (!pos) return null;
    if (pos instanceof Vec3) return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;
    return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
}

/**
 * 收一个成熟的作物。
 *
 * @returns ActionResult
 *   ok         → data: { crop, pos, harvested, costMs }
 *   NOT_READY  还没熟 —— 与 BLOCKED 的区别：BLOCKED 是"够不着/有东西挡"，NOT_READY 是"等它长"
 *   NO_TARGET  那格没有作物
 *   TIMEOUT    挖了但方块还在
 */
export async function harvestCrop(bot, target) {
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const v = vec(target?.pos ?? target);
    if (!v) return fail('NO_TARGET', '目标位置无效');
    const block = bot.blockAt?.(v, false);
    // ★ t36（2026-11-03）码纠正：读不到 = 未加载 → NO_DATA（不是"位置不对"）
    if (!block) return fail('NO_DATA', '那格读不到方块（未加载？）');

    const max = MAX_AGE[block.name];
    if (max == null) return fail('NO_TARGET', `那不是能收的作物（${block.name}）`, { block: block.name });

    const age = Number(block.getProperties?.()?.age ?? -1);
    if (!(age >= max)) {
        return fail('NOT_READY', `${block.name} 还没熟（age ${age}/${max}）`, { crop: block.name, age, maxAge: max });
    }

    const dig = await holdDig(bot, block, { timeout: 8000 });
    if (!dig.ok) {
        if (dig.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { crop: block.name });
        if (dig.code === 'TIMEOUT') return fail('TIMEOUT', `收 ${block.name} 超时（方块还在）`, { crop: block.name });
        return fail(dig.code === 'NO_TARGET' ? 'NO_TARGET' : 'INTERNAL', dig.message, { crop: block.name });
    }

    // 后置：那格应该真的空了
    const after = bot.blockAt?.(v, false);
    const gone = !after || after.name === 'air' || after.name === 'cave_air';
    if (!gone) return fail('DIG_FAIL', `收了但 ${block.name} 还在（挖不动，不是超时）`, { crop: block.name });

    return ok({ crop: block.name, pos: { x: v.x, y: v.y, z: v.z }, harvested: 1, costMs: Date.now() - t0 });
}

/**
 * 在耕地上种一颗种子。
 *
 * 前置（02 §3）：**目标格是耕地**、**它上面那格是空气**、**手上有种子**。
 * 这里不做"先耕地""先走过去"—— 那是调用方（flow_farm）的事。
 *
 * @returns ActionResult
 *   ok        → data: { seed, pos, crop }
 *   NO_ITEM   没有这种子
 *   OCCUPIED  目标格上方不是空气（已经有东西了）—— 与 BLOCKED 的区别：那是"放不进去的阻挡"，
 *             这里是"那格被人占了"，换个地方就行
 *   NO_TARGET 目标格不是耕地
 */
export async function plantSeed(bot, target, seed) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!seed) return fail('NO_TARGET', '没说要种什么种子');

    const soil = vec(target?.pos ?? target);
    if (!soil) return fail('NO_TARGET', '目标位置无效');

    const below = bot.blockAt?.(soil, false);
    // ★ t36（2026-11-03）码纠正：读不到 = 未加载 → NO_DATA
    if (!below) return fail('NO_DATA', '那格读不到方块（未加载？）');
    if (below.name !== 'farmland') {
        return fail('NO_TARGET', `那不是耕地（${below.name}），先 tillSoil`, { block: below.name });
    }

    const abovePos = new Vec3(soil.x, soil.y + 1, soil.z);
    const above = bot.blockAt?.(abovePos, false);
    const airish = !above || ['air', 'cave_air', 'void_air'].includes(above.name);
    if (!airish) {
        return fail('OCCUPIED', `耕地上方已经有 ${above.name} 了`, { occupantNow: above.name });
    }

    const stack = (bot.inventory?.items?.() ?? []).find((i) => i?.name === seed && (i.count ?? 0) > 0);
    if (!stack) return fail('NO_ITEM', `背包里没有 ${seed}`, { seed });

    // 种子必须拿在手上才能种
    try {
        if (bot.heldItem?.name !== seed) await bot.equip(stack, 'hand');
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }

    try {
        await bot.plant?.(below, mcSeedId(bot, seed));
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了');
        return fail('INTERNAL', msg, { error: msg, seed });
    }

    // 后置：耕地上方应该出现了作物
    const planted = bot.blockAt?.(abovePos, false);
    const cropName = planted?.name ?? null;
    const becameCrop = cropName && /wheat|carrots|potatoes|beetroots/.test(cropName);
    if (!becameCrop) {
        return fail('BLOCKED', `种下去了但上方没出现作物（现在是 ${cropName ?? '空'}）`, { seed, got: cropName });
    }

    return ok({ seed, pos: { x: soil.x, y: soil.y, z: soil.z }, crop: cropName });
}

/** 种子名 → 物品 id（拿不到就给 undefined，让 mineflayer 自己按手持物品判断）。 */
function mcSeedId(bot, seed) {
    const def = bot.registry?.itemsByName?.[seed];
    return def?.id;
}

/**
 * 把泥土/草方块变成耕地。
 *
 * @returns ActionResult
 *   ok        → data: { pos, before, after }
 *   NO_TOOL   手上没有锄 —— 与 NO_ITEM 的区别：NO_ITEM 是"背包里没有"，NO_TOOL 是
 *             "这类操作需要特定工具"，提示方向不同（去弄锄 vs 去弄材料）
 *   NO_TARGET 目标格不是泥土/草
 *   BLOCKED   右键了但没变成耕地（上方有东西挡住/被保护）
 */
export async function tillSoil(bot, target, opts = {}) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const v = vec(target?.pos ?? target);
    if (!v) return fail('NO_TARGET', '目标位置无效');
    const block = bot.blockAt?.(v, false);
    // ★ t36（2026-11-03）码纠正：读不到 = 未加载 → NO_DATA（不是"位置不对"）
    if (!block) return fail('NO_DATA', '那格读不到方块（未加载？）');

    const TILLABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'dirt_path']);
    if (!TILLABLE.has(block.name)) {
        return fail('NO_TARGET', `${block.name} 不能耕（要泥土/草方块）`, { block: block.name });
    }

    const hoe = (bot.inventory?.items?.() ?? []).find((i) => /_hoe$/.test(i?.name ?? ''));
    if (!hoe) return fail('NO_TOOL', '没有锄，耕不了地', { block: block.name });

    try {
        if (bot.heldItem?.name !== hoe.name) await bot.equip(hoe, 'hand');
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }

    const used = await useOnBlock(bot, block, { timeout: opts.timeout ?? 3000 });
    if (!used.ok) {
        if (used.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
        if (used.code === 'TIMEOUT') return fail('BLOCKED', `右键 ${block.name} 没反应`, { block: block.name });
        return fail('INTERNAL', used.message, { error: used.data?.error ?? used.message });
    }

    const after = bot.blockAt?.(v, false);
    if (after?.name !== 'farmland') {
        return fail('BLOCKED', `耕了但还是 ${after?.name ?? '空'}（上方可能有东西挡着）`, { before: block.name, after: after?.name ?? null });
    }
    return ok({ pos: { x: v.x, y: v.y, z: v.z }, before: block.name, after: 'farmland' });
}
