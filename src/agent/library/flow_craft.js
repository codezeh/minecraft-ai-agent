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
import { Vec3 } from 'vec3';
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

/** 附近有没有现成的工作台（够得着的优先）。
 *
 *  ★★★ 2026-11-05（t133）：**先看"我记得自己放过的那个位置"。**
 *
 *    真机证据（第 54 跑）：`craft crafting_table` 做出表 → 某次 `craft` 把表放下去了
 *    （`table: 1 → null`）→ 下一张 `craft wooden_pickaxe` 找不到表 → 3x3 查不到配方 → blocked。
 *
 *    为什么 `findBlock` 找不到：可能是放的位置超出 `maxDistance`、或区块未加载、
 *    或放置后没等方块同步。**但"我放的"这件事是确定知道的** —— 记住坐标比反复搜更可靠。
 *    → 先查记忆位置；读不到再退回 `findBlock` 搜索。
 */
function nearbyTable(bot, maxDistance = 16) {
    const id = mc.getItemId('crafting_table');
    // ① 先看记忆位置
    try {
        const p = bot.__placedTablePos;
        if (p) {
            const b = bot.blockAt?.(new Vec3(p.x, p.y, p.z), false);
            if (b?.name === 'crafting_table') return b;
            // 记忆位置已经不是工作台 → 清掉（被别人挖了/根本没放成功）
            bot.__placedTablePos = null;
        }
    } catch { /* ignore */ }
    // ② 再搜附近
    try {
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
        // ★★★ 2026-11-05（t132）：**这里不再做"料够不够"的预检 —— 判断权交给 `act_craft`。**
        //
        //   真机决定性证据（第 53 跑，两轮完全同构）：
        //     22913 craft oak_planks → done，`invAfter.oak_planks = 6`（木镐只要 3）
        //     22915 craft wooden_pickaxe → blocked，`inv.oak_planks = 2`、`missing = {oak_planks:1}`
        //   **6 → 2 之间没有任何 craft 单，也没有 2ms 内吃掉 4 块板的操作。**
        //   → **木板从来没少过；那个 `inv`/`missing` 是过期快照。**
        //
        //   为什么过期：这里在**预检时刻**调 `recipesFor` 算一次，
        //   而真正执行时库存可能已被同一棵树的其它子单补足了
        //   （本轮正是：它自己派的 `craft oak_planks c1` 后来把板做到了 6）。
        //   **同一份判断写两处（这里 + `act_craft`），前一处必然更容易过期。**
        //
        //   t123 已删掉下面第二道预检（`:225`），`t126` 又把第一道补了诊断 ——
        //   **但补诊断不治本**。fixture 早就提醒过"`flow_craft` 有两道同形状的预检"。
        //   本轮**两道一起删**：`act_craft` 成为"能不能合"的**唯一 owner**，
        //   它在**执行那一刻**重新 `recipesFor`，拿到的永远是最新库存。
        //
        //   行为变化：料真不够时，不再在这里早停，而是多走一次 `craftOnce`
        //   → `act_craft` 用完整 `diag()`（`inv`/`limit`/`invBefore`/`invAfter`/`precheck`）失败。
        //   **代价**：多一次寻表/空转（毫秒级）；**收益**：诊断准确 + 不再有"过期快照"这类假失败。
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
                    // ★★ t95：**转发 `made.data`** —— 这是 t92 漏掉的另一处（fixture 扫出来的）。
                    //   t92 只改了下面 `:255` 那一处，这里仍然重新组装 → `craftOnce` 的
                    //   `inv`/`limit`/`got` 全丢，失败原因永远查不出来。
                    return fail(made.code === 'NO_ITEM' ? 'NO_ITEM' : 'NO_WORKSTATION',
                        `需要工作台，但背包里没有、也合不出来（${made.message ?? ''}）`,
                        { ...(made.data ?? {}), item: itemName, missing: missingFor(bot, 'crafting_table') });
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
            // ★★★ 2026-11-05（t133）：**记住"我把表放哪了"。**
            //
            //   真机证据（第 54 跑轮 1）：`craft crafting_table` 做出表（`table:1`）→
            //   几十秒后 `craft stick` 结束时报 `table:null` → 紧接着 `wooden_pickaxe`
            //   失败，`inv` 里没有工作台。
            //   **不管是谁放的，后果一样：表在世界上，但下一张单找不到它。**
            //
            //   `invAfter` 是**那一刻的快照**，不一定是"这个单的效果"（并发下会串味）。
            //   所以不要靠归因，**直接记住位置** —— 后面任何单都能用。
            if (spot) { try { bot.__placedTablePos = { x: spot.x, y: spot.y, z: spot.z }; } catch { /* ignore */ } }
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

        // ★★★ 2026-11-04（t123）：**删掉这个前置检查 —— 它让 `act_craft` 的守卫永远不执行。**
        //
        //   真机证据（第 50 跑，我要求贴【完整不截断】data 之后）：
        //     `data` 的键并集只有 `{item, want, got, missing}`  —— **4 个键**
        //     `requiresTable` / `tableBlockUsed` / `recipesWithTable` / `heldItem` **一个都没有**
        //   → 证明失败**根本没进 `act_craft`**，而是死在这里。
        //
        //   ★ 这就是今晚「**防护装了但没生效**」这一族的又一例：
        //     我今天在 `act_craft` 加的 t121（3x3 无表必败）和 t122（requiresTable 诊断）
        //     **在这条路径上是死代码** —— 因为这里先 return 了。
        //
        //   而且这个检查本身是**劣质的**：
        //     · `missingFor` 只看 `all[0][0]`（第一条配方、1 次的量）
        //     · 报错只有 `{item,want,got,missing}` —— 没有 `inv`/`limit`/`windowOpen`
        //     · 和 `act_craft` 各自判断"料够不够"，**两个地方各自算同一件事**
        //
        //   修法：**把"能不能合"完全交给 `act_craft`**（它知道工作台、知道 limit、知道 stale 表），
        //   这里不再预判。真合不了时 `act_craft` 会带着完整的 `diag()` 失败。
        recipes = bot.recipesFor?.(id, null, want, table) ?? [];
        if (!recipes.length) {
            // 只记一条可观测事件，**不 return** —— 继续走 craftOnce，让 act_craft 给出精确原因
            try {
                bot.__craftPrecheckMiss = { item: itemName, want, missing: missingFor(bot, itemName), at: Date.now() };
            } catch { /* ignore */ }
        }
    }

    // ── plan 第 5 步：craftOnce 到够数（可能一轮就够，也可能要几轮）──
    let got = 0;
    let rounds = 0;
    let lastData = null;                             // ★ t128：最后一轮 craftOnce 的 data（转发用）
    const MAX_ROUNDS = 8;
    while (countItem(bot, itemName) - before < want && rounds++ < MAX_ROUNDS) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { craftedItem: itemName, got });
        // ★ t90：**必须把找到/放好的工作台传进去** —— 原来这里只传 3 个参数，
        //   整段"找表/合表/放表/走表"全白做，而 craftOnce 自己按 4 格又找不到 → NO_WORKSTATION。
        // ★★★ 2026-11-05（t136）：**每一轮 craftOnce 之前都确认离表够近。**
        //
        //   真机证据（第 56 跑）：`heldItem:null`、`tableStillThere:"crafting_table"`、
        //   `recipesWithTable:1`，但 `windowOpen:null`、`invBefore==invAfter`、`costMs=1543`。
        //   同一轮里另一次 `wooden_pickaxe done prod=1` —— **站得近就成，走开了就败。**
        //
        //   机制：`bot.activateBlock` 只是个右键包，**服务端按距离校验**；
        //   超出约 4.5 格就既不报错也不开窗 → `once('windowOpen')` 等不到。
        //
        //   为什么放在循环里而不是外面：外面那段 goTo 只在"首次找表/放表"时跑，
        //   而**多轮 craft 之间**她可能被别的动作带走了（捡掉落物、被怪推）。
        if (table?.position && bot.entity?.position) {
            const tp = table.position, sp = bot.entity.position;
            const d = Math.hypot(tp.x + 0.5 - sp.x, tp.y + 0.5 - sp.y, tp.z + 0.5 - sp.z);
            if (d > 3.5) {
                const near = await goTo(bot, { kind: 'point', pos: { x: tp.x, y: tp.y, z: tp.z } }, {
                    mapDir: mapDirOf(bot),
                    deadlineMs: Math.max(4000, Date.now() + 30000),
                    arriveTol: 2,
                });
                if (!near.ok) {
                    if (near.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
                    return fail('OUT_OF_REACH', `走不到工作台（${near.code}，相距 ${d.toFixed(1)} 格）`,
                        { item: itemName, dist: d });
                }
            }
        }

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
        lastData = r.data ?? null;                   // ★ t128：留住最后一轮的诊断（含 invAfter）
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

    // ★ t128：**转发每一轮的 `data`（尤其 `invAfter`），不要只挑几个字段重建。**
    //   今晚这个坑已经踩了 6 次（t92/t95/t105/t109/t126/…），这次提前做对：
    //   `lastData` 是最后一轮 `craftOnce` 的 data，里面已经有 `invBefore`/`invAfter`。
    return ok({
        craftedItem: itemName,
        count: produced,
        want,
        got: produced,
        usedTable: !!table,
        placedTable,
        costMs: Date.now() - t0,
        ...(lastData ?? {}),           // ★ 保留底层诊断（invAfter / limitUsed / tableBlockUsed …）
        count: produced,               // 但本层的 count 语义（产出数）要压在最后，别被覆盖
    });
}
