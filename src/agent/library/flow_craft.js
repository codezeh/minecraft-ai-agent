/**
 * 流程：合成 N 个（M7 P0，04 §6.1 卡片 `flow_craft`）。
 *
 * 卡片原文的 plan：
 *   `bot.recipesAll` 为空 → `NO_RECIPE`
 *   有配方但 `recipesFor` 为空 → 缺料 `NO_ITEM`（`data.missing` 列清缺什么，交给 `strat_obtain`）
 *   要 3×3 就找附近工作台，没有就放一个（背包没有先合一个，4 木板）→ `goTo` 工作台 → `craftOnce` 到够数
 * 卡片原文的 onFail：`NO_ITEM` → abort；`NO_WORKSTATION` / `OUT_OF_REACH` → restep
 * 完成：产物增量 ≥ count
 *
 * 分工（与本项目一贯的规矩）：
 *   本文件只管 **前置判断 + 工作台准备 + 何时算完成**；真正的"合成一次"是动作
 *   `act_craft.craftOnce`（它带配方/料/工作台的判断与错误码）。
 *   流程**不拼按键、不裸调 mineflayer 合成**。
 *
 * 为什么"放工作台"在流程而不是动作：02 §3 明写 `craftOnce` 不走到工作台、不放工作台，
 * "附近没有就放一个"就是流程（`flow_craft`）的事。
 */
import * as mc from '../../utils/mcdata.js';
import { ok, fail } from './contract.js';
import { craftOnce } from './act_craft.js';
import { placeBlockAt } from './act_place.js';
import { findItem } from './act_items.js';
import { countItem, blockAt } from './query_perceive.js';
import { waitUntil } from './atom_wait.js';
import { mapDirOf } from './bot_paths.js';
import { goTo } from './nav_core.js';

/** 复合技能 manifest（04 §4.1）。codes 只用已注册的码。 */
export const manifest = {
    name: 'craft',
    level: 'flow',
    summary: '合成 N 个某物品（料够、需要工作台时会找或放一个）',
    params: {
        item: 'item',
        count: 'int 1..64 = 1',
    },
    needs: { items: ['<item> 的材料'], near: [] },
    claims: [],
    codes: ['NO_RECIPE', 'NO_ITEM', 'NO_WORKSTATION', 'OUT_OF_REACH', 'OCCUPIED', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: false,
    timeoutMs: 5 * 60 * 1000,
};

/** 放工作台要找的位置：脚下前方一格（不往自己身上放、也不放到头顶）。 */
/**
 * ★★ 2026-11-04（t88）：**放工作台要试多个位置，不能只试一个。**
 *
 *   真机证据（第 33 跑）：
 *     `craft wooden_pickaxe → failed «放不下工作台：INTERNAL
 *      Server refused to place crafting table»`
 *
 *   `tableSpotFor` 只给"面前那一格"。而服务端会拒绝非法放置：
 *     · 那格不是空气（脚下有方块/掉落物实体）
 *     · 那格没有可依附的实心面
 *     · 玩家正站在那格里
 *   一旦第一个位置被拒，整条链路就 `NO_WORKSTATION` 失败 —— 而**旁边一格往往就能放**。
 *
 *   所以这里给出**按优先级排序的候选列表**：面前 → 四个侧邻 → 脚下的旁边，
 *   逐个试，直到放上去一个。
 */
function tableSpotsFor(bot) {
    const p = bot.entity?.position;
    if (!p) return [];
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const yaw = Number(bot.entity?.yaw ?? 0);
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    const out = [];
    const push = (x, y, z) => {
        if (!out.some((c) => c.x === x && c.y === y && c.z === z)) out.push({ x, y, z });
    };
    // ① 面前那格（原行为，优先）
    push(fx + (dx || 1), fy, fz + dz);
    // ② 四个侧邻
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) push(fx + ax, fy, fz + az);
    // ③ 侧邻再往下一格（面前那格脚下是空的时候）
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) push(fx + ax, fy - 1, fz + az);
    return out;
}

/** 附近有没有现成的工作台（够得着的优先）。 */
function nearbyTable(bot, maxDistance = 16) {
    try {
        const id = mc.getItemId('crafting_table');
        return bot.findBlock?.({ matching: id, maxDistance }) ?? null;
    } catch {
        return null;
    }
}

/** 缺什么料（给 strat_obtain 用）。读不准就返回 null，不编造。 */
function missingFor(bot, itemName) {
    try {
        const all = mc.getItemCraftingRecipes?.(itemName);
        if (!all || !all.length) return null;
        const need = all[0][0];                       // 第一条配方：{ 材料名: 数量 }
        const inv = (bot.inventory?.items?.() ?? []).reduce((m, it) => {
            if (it?.name) m[it.name] = (m[it.name] ?? 0) + (it.count ?? 0);
            return m;
        }, {});
        const missing = {};
        for (const [name, n] of Object.entries(need)) {
            const have = inv[name] ?? 0;
            if (have < n) missing[name] = n - have;
        }
        return Object.keys(missing).length ? missing : null;
    } catch {
        return null;
    }
}

/**
 * 合成 count 个 item。
 *
 * @returns ActionResult
 *   ok        → data: { craftedItem, count, want, got, usedTable, placedTable }
 *   NO_RECIPE 没有这个配方 —— 永不可达，abort
 *   NO_ITEM   缺料，`data.missing` 列出缺什么 —— abort（交给 strat_obtain）
 *   NO_WORKSTATION 需要工作台但身边没有、也没法放（背包里没有工作台也合不出来）
 *   OUT_OF_REACH 工作台够不着（restep：走近再试）
 *   INVENTORY_FULL / OCCUPIED 放工作台失败
 */
export async function craft(bot, itemName, count = 1) {
    const want = Math.max(1, Math.floor(Number(count) || 1));
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!itemName) return fail('NO_TARGET', '没说要合成什么');

    // ── plan 第 1 步：有没有这个配方（牌子上写的是 recipesAll 为空 → NO_RECIPE）──
    const all = (() => {
        try { return mc.getItemCraftingRecipes?.(itemName) ?? []; } catch { return []; }
    })();
    if (!all.length) {
        return fail('NO_RECIPE', `${itemName} 没有合成配方（或不是物品）`, { item: itemName });
    }

    const before = countItem(bot, itemName);

    // ── plan 第 2 步：现在能合吗？不能就是缺料 ──
    const id = mc.getItemId(itemName);
    let recipes = bot.recipesFor?.(id, null, want, null) ?? [];
    let needTable = false;
    if (!recipes.length) {
        const withTable = bot.recipesFor?.(id, null, want, true) ?? [];
        if (!withTable.length) {
            // 连"有工作台就能合"都不成立 = 缺料（卡片的 NO_ITEM）
            const missing = missingFor(bot, itemName);
            return fail('NO_ITEM', `料不够合 ${itemName}`, { item: itemName, want, got: 0, missing });
        }
        needTable = true;
    }

    let table = null;
    let placedTable = false;

    if (needTable) {
        // ── plan 第 3 步：要 3×3 就找附近工作台，没有就放一个 ──
        table = nearbyTable(bot);

        if (!table) {
            // 背包里没有工作台就先合一个（工作台本身是 2×2 配方，不需要工作台）
            if (countItem(bot, 'crafting_table') === 0) {
                const made = await craftOnce(bot, 'crafting_table', 1);
                if (!made.ok) {
                    // 合不出工作台：多半是木板不够
                    return fail(made.code === 'NO_ITEM' ? 'NO_ITEM' : 'NO_WORKSTATION',
                        `需要工作台，但背包里没有、也合不出来（${made.message ?? ''}）`,
                        { item: itemName, missing: missingFor(bot, 'crafting_table') });
                }
            }

            // 放到附近一格（**多候选重试**，见 tableSpotsFor 的注释）
            const spots = tableSpotsFor(bot);
            const itemStack = findItem(bot, 'crafting_table');
            if (!spots.length || !itemStack) {
                return fail('NO_WORKSTATION', `需要工作台，但没有可放置的位置/物品`, { item: itemName });
            }
            try {
                if (bot.heldItem?.name !== 'crafting_table') await bot.equip(itemStack, 'hand');
            } catch { /* 换手失败就让 placeBlockAt 自己报 */ }

            let spot = null;
            let lastPlaced = null;
            for (const cand of spots) {
                const placed = await placeBlockAt(bot, { kind: 'block', pos: cand }, 'crafting_table', {});
                if (placed.ok) { spot = cand; lastPlaced = placed; break; }
                lastPlaced = placed;
                if (placed.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
                // 其它失败（服务端拒绝 / 被占 / 未加载）→ 换下一个候选继续试
            }
            if (!spot) {
                return fail(lastPlaced?.code === 'OCCUPIED' ? 'OCCUPIED' : 'NO_WORKSTATION',
                    `放不下工作台（试了 ${spots.length} 个位置）：${lastPlaced?.code} ${lastPlaced?.message ?? ''}`,
                    { item: itemName, tried: spots });
            }
            placedTable = true;
            // ★ t90：放置成功后**等方块同步**再读（第 34 跑 `act_craft` 已踩过同类：
            //   "动作 resolve ≠ 服务端状态已同步到本地"）。轮询到读出来或 1.2s。
            table = blockAt(bot, spot);
            const tB = Date.now();
            while (!table && Date.now() - tB < 1200) {
                await new Promise((r) => setTimeout(r, 100));
                table = blockAt(bot, spot);
            }
        }

        if (!table) return fail('NO_WORKSTATION', '找不到工作台', { item: itemName });

        // ── plan 第 4 步：goTo 工作台（够不着才走）──
        const tp = table.position;
        const dist = Math.hypot(tp.x + 0.5 - bot.entity.position.x, tp.z + 0.5 - bot.entity.position.z);
        if (dist > 3) {
            const moved = await goTo(bot, { kind: 'point', pos: { x: tp.x, y: tp.y, z: tp.z } }, {
                mapDir: mapDirOf(bot),
                deadlineMs: Math.max(4000, (Date.now() + 60000)),
                arriveTol: 2,
            });
            if (!moved.ok) {
                if (moved.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
                return fail('OUT_OF_REACH', `走不到工作台（${moved.code}）`, { item: itemName, dist });
            }
        }

        recipes = bot.recipesFor?.(id, null, want, table) ?? [];
        if (!recipes.length) {
            const missing = missingFor(bot, itemName);
            return fail('NO_ITEM', `料不够合 ${itemName}（在工作台旁也合不出）`, { item: itemName, want, got: 0, missing });
        }
    }

    // ── plan 第 5 步：craftOnce 到够数（可能一轮就够，也可能要几轮）──
    let got = 0;
    let rounds = 0;
    const MAX_ROUNDS = 8;
    while (countItem(bot, itemName) - before < want && rounds++ < MAX_ROUNDS) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { craftedItem: itemName, got });
        // ★ t90：**必须把找到/放好的工作台传进去** —— 原来这里只传 3 个参数，
        //   整段"找表/合表/放表/走表"全白做，而 craftOnce 自己按 4 格又找不到 → NO_WORKSTATION。
        const r = await craftOnce(bot, itemName, want - got, table);
        if (!r.ok) {
            // ★★ 2026-11-04（t92）：**必须把底层 `r.data` 一起转发，不能重新组装一份。**
            //
            //   真机证据（verify 第 36/37 跑，报了**两次**）：
            //     `craft oak_planks → blocked`，而 `data = {}` 是空的 ——
            //     `act_craft` 明明加了 `diag()`（inv / want / limit），可作业单上看不到。
            //
            //   原因就在这几行：这里**重新写了一个对象**，只挑 `got/want/missing` 三个字段，
            //   **`r.data` 里的 `inv` / `limit` / `knownTable` 全被丢掉**。
            //   → 两处各自组装同一份 data，后者覆盖前者（和 t90 的"工作台没传"同族）。
            //
            //   改成 `...r.data` 展开在前，本层要补充/覆盖的字段写在后面。
            const base = { item: itemName, count: r.data?.got ?? got, want, got };
            if (r.code === 'NO_ITEM') base.missing = missingFor(bot, itemName);
            return fail(r.code, r.message ?? `合成 ${itemName} 失败`, { ...(r.data ?? {}), ...base });
        }
        got += Number(r.data?.produced ?? r.data?.got ?? 0);
        if (r.data?.produced === 0) break;           // 没产出，别空转
    }

    const produced = countItem(bot, itemName) - before;
    if (produced < want) {
        // 完成判据没达到：卡片说"完成 = 产物增量 ≥ count"
        return fail('NO_ITEM', `只合出 ${produced}/${want} 个 ${itemName}`, {
            item: itemName, count: produced, want, got: produced, missing: missingFor(bot, itemName),
        });
    }

    return ok({
        craftedItem: itemName,
        count: produced,
        want,
        got: produced,
        usedTable: !!table,
        placedTable,
        costMs: Date.now() - t0,
    });
}
