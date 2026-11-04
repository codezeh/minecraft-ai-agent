/**
 * 策略：把工具升到某一档（M10，04 §6.3 `strat_tool_tier`）。
 *
 * 原文：木 → 石 → 铁，每档对**镐、斧、剑**各调一次 `strat_obtain`。
 *      "已经是该档或更高 → 直接 ok（别重复做）"；"**不能跳档**：要铁镐但只有木镐 →
 *      必须先石再铁"。
 *
 * ★ 策略的本质（04 §6.3）：**不自己做动作，只拆子单**。
 *   所以这里只产出"该对谁调用 strat_obtain"的计划，真正下单/执行交给 `strat_obtain` 与任务板。
 *   源码级用例盯着：本文件不许出现 holdKey / digBlock / placeBlockAt / setControlState。
 */

import { ok, fail } from './contract.js';

/** 档位顺序（04 §6.3：木 → 石 → 铁）。数字 = 档次。 */
export const TIERS = Object.freeze(['wooden', 'stone', 'iron']);
export const TIER_RANK = Object.freeze({ wooden: 1, stone: 2, iron: 3 });

/** 每档要对哪三件工具各做一次（04 §6.3：镐、斧、剑）。 */
export const TOOL_KINDS = Object.freeze(['pickaxe', 'axe', 'sword']);

/** 物品名 → 档位（'stone_pickaxe' → 'stone'）。认不出返回 null。 */
export function tierOfItem(itemName) {
    const n = String(itemName ?? '');
    const m = n.match(/^(wooden|stone|iron)_(pickaxe|axe|sword)$/);
    return m ? { tier: m[1], kind: m[2] } : null;
}

/**
 * 我现在的每类工具最高是哪一档（纯函数，注入 inventory）。
 *
 * @param {object} inventory {name: count}
 * @returns {{pickaxe:number, axe:number, sword:number}} 数字档次，0 = 没有
 */
export function currentTiers(inventory = {}) {
    const out = { pickaxe: 0, axe: 0, sword: 0 };
    for (const name of Object.keys(inventory)) {
        const t = tierOfItem(name);
        if (!t) continue;
        if (Number(inventory[name] ?? 0) <= 0) continue;
        const rank = TIER_RANK[t.tier] ?? 0;
        if (rank > out[t.kind]) out[t.kind] = rank;
    }
    return out;
}

/**
 * 算出"要到目标档，还差哪些 strat_obtain 调用"。
 *
 * ★ 不跳档：从**自己现在这一档的下一档**开始，一档一档往上做。
 *   例：要铁镐但只有木镐 → 先 stone_pickaxe，再 iron_pickaxe（不能直接做铁的）。
 *
 * @param {object} args
 *   target   'wooden' | 'stone' | 'iron'
 *   inventory  {name:count}
 *   kinds    要处理哪几类工具，默认镐/斧/剑
 * @returns {{ok:boolean, plan:Array<{item, tier, kind, why}>, alreadyAt:object, target:string}}
 */
export function planToolTier(args = {}) {
    const target = String(args.target ?? '');
    const targetRank = TIER_RANK[target] ?? 0;
    if (!targetRank) return { ok: false, plan: [], alreadyAt: {}, target, reason: `未知档位 ${target}` };

    const inv = args.inventory ?? {};
    const kinds = Array.isArray(args.kinds) && args.kinds.length ? args.kinds : TOOL_KINDS;
    const cur = currentTiers(inv);

    const plan = [];
    for (const kind of kinds) {
        const haveRank = cur[kind] ?? 0;
        // 已经是该档或更高 → 这一类直接跳过（04 §6.3："别重复做"）
        if (haveRank >= targetRank) continue;
        // 从"当前档的下一档"开始，一档一档往上（不跳档）
        for (let rank = haveRank + 1; rank <= targetRank; rank++) {
            const tier = TIERS[rank - 1];
            plan.push({
                item: `${tier}_${kind}`,
                tier,
                kind,
                why: haveRank === 0
                    ? `还没有${kind}，先做 ${tier} 的`
                    : `要从 ${TIERS[haveRank - 1]} 升到 ${tier}（不跳档）`,
            });
        }
    }
    return { ok: true, plan, alreadyAt: cur, target };
}

/** 策略 manifest（04 §4.1）。 */
export const manifestToolTier = {
    name: 'tool_tier',
    level: 'strat',
    summary: '把镐/斧/剑升到某一档（木→石→铁，一档一档升，不跳档）',
    params: {
        target: 'string',
        kinds: 'string?',
    },
    needs: { items: [], near: [] },
    claims: [],
    codes: ['OK', 'NO_ITEM', 'NO_TARGET', 'INTERRUPTED', 'INTERNAL'],
    resumable: false,
    timeoutMs: 10 * 60 * 1000,
};

/**
 * 跑一次 strat_tool_tier：对每一件缺的工具各调一次 `strat_obtain`（04 §6.3 原文）。
 *
 * @param {object} agent
 * @param {string} target 'wooden'|'stone'|'iron'
 * @param {object} deps { obtain, inventory, kinds }
 * @returns {Promise<ActionResult>}
 */
export async function toolTier(agent, target, deps = {}) {
    const inv = deps.inventory ?? countInv(agent);
    const planned = planToolTier({ target, inventory: inv, kinds: deps.kinds });
    if (!planned.ok) return fail('NO_TARGET', planned.reason ?? '未知档位', { target });

    if (!planned.plan.length) {
        // 已经是该档或更高 → 直接 ok（04 §6.3）
        return ok({ target, alreadyAt: planned.alreadyAt, obtained: [], note: '已经是该档或更高' });
    }

    // 没有 obtain 就只把计划交回去（不假装做了）
    const obtainFn = deps.obtain ?? null;
    if (!obtainFn) {
        return ok({ target, plan: planned.plan, alreadyAt: planned.alreadyAt, note: '没有 obtain 注入，只返回计划' });
    }

    const results = [];
    let firstFail = null;
    let firstFailData = null;                 // ★ t95：留下第一处失败的下层 data
    for (const step of planned.plan) {
        const r = await obtainFn(agent, step.item, 1);
        results.push({ item: step.item, ok: r?.ok === true, code: r?.code ?? 'OK' });
        if (!r?.ok && !firstFail) {
            firstFail = { item: step.item, code: r?.code };
            firstFailData = r?.data ?? null;
        }
    }

    if (firstFail) {
        // ★★ 2026-11-04（t95）：**必须转发下层的 `data`。**
        //
        //   fixture 扫出来的（t92 同形、且在**最上游**）：原来这里手工组装
        //   `{ target, results }`，把 `strat_obtain` 返回的 **`gaps`（缺什么来源）**
        //   和 **`jobs`（下了哪些单）全部丢掉** →
        //   **策略层失败永远不可诊断**（只能看到"有一步没成"，看不到缺什么、派了什么单）。
        const base = { target, results };
        return fail(firstFail.code === 'NO_ITEM' ? 'NO_ITEM' : (firstFail.code ?? 'INTERNAL'),
            `升到 ${target} 档时有一步没成：${firstFail.item}`,
            { ...(firstFailData ?? {}), ...base, failedItem: firstFail.item });
    }
    return ok({ target, obtained: results, alreadyAt: planned.alreadyAt });
}

function countInv(agent) {
    const out = {};
    try {
        for (const it of (agent?.bot?.inventory?.items?.() ?? [])) {
            if (it?.name) out[it.name] = (out[it.name] ?? 0) + (it.count ?? 0);
        }
    } catch { /* ignore */ }
    return out;
}
