/**
 * 流程：吃到饱食度达标（M7 P0，04 §6.2 表 + §6.2 auto-eat 冲突说明）。
 *
 * 卡片：「`flow_eat` — 吃到饱食度达标」；现状 🔀 `skills.consume`。
 *
 * ★ auto-eat 冲突（04 §6.2 原文，2026-11-01 定的做法）：
 *   "auto-eat 饿了就自己吃，吃的时候会换掉手里的东西；flow_eat 同时在吃就会互相打断。
 *    做法：记下 `bot.autoEat.enabled` → `disableAuto()` → `bot.autoEat.isEating` 为真就先等它吃完
 *    → 自己吃 → `finally` 里原来开着才 `enableAuto()`。"
 *   没选"只在 auto-eat 关着时用"：auto-eat 默认开着，那样 flow_eat 基本用不上。
 *
 * 本文件只做"吃几口直到饱 / 没得吃了"，单口进食是动作 `act_items.eat`。
 */
import { ok, fail } from './contract.js';
import { eat } from './act_items.js';
import { countItem } from './query_perceive.js';
import { waitUntil } from './atom_wait.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'eat',
    level: 'flow',
    summary: '饿了就吃点东西，直到饱食度达标（会自动暂停 auto-eat 免得打架）',
    params: {
        food: 'item?',
        targetFood: 'int 1..20 = 20',
    },
    needs: { items: ['食物'], near: [] },
    claims: [],
    codes: ['NO_ITEM', 'NOT_READY', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: false,
    timeoutMs: 60 * 1000,
};

/** 等 auto-eat 把嘴里那口吃完的上限（毫秒）。超过就不等了，自己开始吃。 */
const AUTOEAT_WAIT_MS = 5000;

/**
 * 食物优先级（越高越先吃）。
 *
 * 按"回复饥饿值 / 获取难度"排：熟肉 > 面包 > 生肉/根茎 > 便宜量产（曲奇/西瓜）。
 * 与 `act_items.eat` 的 EDIBLE_RE 是两层：那边判"能不能吃"，这边判"先吃哪个"。
 */
const FOOD_PRIORITY = [
    'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod',
    'golden_carrot', 'golden_apple', 'bread',
    'baked_potato', 'beef', 'porkchop', 'mutton', 'chicken', 'salmon', 'cod',
    'carrot', 'potato', 'apple', 'beetroot',
    'cookie', 'melon_slice', 'sweet_berries', 'dried_kelp',
];

/** 从背包里挑一样该吃的：指定的优先，否则按优先级表。 */
function pickFood(bot, preferred) {
    if (preferred) return countItem(bot, preferred) > 0 ? preferred : null;
    for (const f of FOOD_PRIORITY) {
        if (countItem(bot, f) > 0) return f;
    }
    // 表里都没有：退回"背包里任何 act_items 认得的食物"
    const EDIBLE_RE = /^(bread|cooked_|apple|carrot|potato|baked_potato|beef|porkchop|chicken|mutton|rabbit|fish|salmon|cod|melon_slice|sweet_berries|glow_berries|cookie|cake|golden_apple|golden_carrot|mushroom_stew|beetroot_soup|rabbit_stew|pumpkin_pie|dried_kelp)/;
    return (bot.inventory?.items?.() ?? []).find((i) => i?.name && EDIBLE_RE.test(i.name))?.name ?? null;
}

/** 暂停 auto-eat（返还原状态，供 finally 恢复）。 */
function pauseAutoEat(bot) {
    const ae = bot?.autoEat;
    if (!ae) return { present: false, wasEnabled: false };
    const wasEnabled = ae.enabled !== false;              // 默认视为开着
    try { ae.disableAuto?.(); } catch { /* 没有这个接口就算了 */ }
    return { present: true, wasEnabled };
}

/** 恢复 auto-eat：**原来开着才恢复**（原状是什么就还什么）。 */
function restoreAutoEat(bot, state) {
    if (!state?.present || !state.wasEnabled) return;
    try { bot.autoEat?.enableAuto?.(); } catch { /* ignore */ }
}

/**
 * 吃到饱食度 >= targetFood，或没得吃了。
 *
 * @returns ActionResult
 *   ok        → data: { food, ate, foodBefore, foodAfter, want }
 *   NO_ITEM   背包里没有任何吃的 —— abort（上层去弄食物）
 *   NOT_READY 吃了但饱食度一直没涨（吃的东西可能不对 / 已经吃不下）—— 等一会再来
 *   TIMEOUT   到了时间上限还没吃饱
 */
export async function eatToFull(bot, opts = {}) {
    const targetFood = Math.max(1, Math.min(20, Math.floor(Number(opts.targetFood) || 20)));
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    const deadlineMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : (ctx.deadline - Date.now());

    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const foodBefore = Number(bot.food ?? 20);
    if (foodBefore >= targetFood) {
        // 已经够饱：不算失败（目的已达成），也不该为了"做了点什么"去浪费食物
        return ok({ food: null, ate: 0, foodBefore, foodAfter: foodBefore, want: targetFood, alreadyFull: true });
    }

    const chosen = pickFood(bot, opts.food ?? null);
    if (!chosen) {
        return fail('NO_ITEM', '背包里没有能吃的东西', { foodBefore, want: targetFood });
    }

    const autoState = pauseAutoEat(bot);
    let ate = 0;
    let notReady = false;
    try {
        // auto-eat 可能正在吃：等它吃完再自己吃（否则互相打断）
        if (bot.autoEat?.isEating) {
            await waitUntil(() => !bot.autoEat.isEating, {
                timeoutMs: Math.max(1000, Math.min(AUTOEAT_WAIT_MS, deadlineMs)),
                intervalMs: 100,
                bot,
            });
        }

        while (Number(bot.food ?? 20) < targetFood) {
            if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { food: chosen, ate, foodBefore });
            if (Date.now() - (ctx.deadline - deadlineMs) >= deadlineMs) break;   // 到时限

            const r = await eat(bot, chosen);
            if (r.ok) { ate++; continue; }

            if (r.code === 'NOT_READY') {
                // 饱食度满了 / 吃了没涨：别硬塞，交给上层判断
                notReady = true;
                break;
            }
            if (r.code === 'NO_ITEM') {
                return fail('NO_ITEM', `没有 ${chosen} 了`, { food: chosen, ate, foodBefore });
            }
            if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { food: chosen, ate, foodBefore });
            return fail('INTERNAL', r.message ?? '吃失败', { food: chosen, ate, foodBefore });
        }
    } finally {
        restoreAutoEat(bot, autoState);                   // 原状恢复（卡片要求）
    }

    const foodAfter = Number(bot.food ?? foodBefore);
    if (foodAfter >= targetFood) {
        return ok({ food: chosen, ate, foodBefore, foodAfter, want: targetFood });
    }
    if (notReady) {
        return fail('NOT_READY', `吃了但没吃饱（${foodBefore}→${foodAfter}，目标 ${targetFood}）`, {
            food: chosen, ate, foodBefore, foodAfter, want: targetFood,
        });
    }
    return fail('TIMEOUT', `吃到时间上限也没饱（${foodBefore}→${foodAfter}）`, {
        food: chosen, ate, foodBefore, foodAfter, want: targetFood,
    });
}
