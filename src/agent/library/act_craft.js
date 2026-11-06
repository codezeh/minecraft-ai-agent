/**
 * 动作：合成与熔炼（M6 P0，02 §3）。
 *
 *   craftOnce(item, n)            有配方、料够 → bot.craft → 产物 +n
 *   furnaceLoad(furnace, input, fuel)  放料 + 放燃料（一次），不负责等烧完
 *   furnaceCollect(furnace)       取产物（没烧完就 NOT_READY）
 *
 * 三条设计约束：
 *   1) 只做**一次**动作。`craftOnce` 不负责"没工作台就放一个"（那是 flow_craft 的事），
 *      也不负责循环到凑够数量。
 *   2) 返回 ActionResult，**不返回 boolean** —— 旧 `skills.craftRecipe` / `smeltItem`
 *      都是 boolean，调用方分不清"没配方"和"料不够"，这正是要收掉的。
 *   3) 不自己拼 map 路径（要路径就用 bot_paths.mapDirOf），也不调别的 act_*。
 *
 * 为什么熔炉要拆成 load / collect 两个动作：
 *   烧炼是**要等**的（一个物品 10 秒）。如果做成一个 `smeltItem` 把所有事串起来，
 *   它必然变成一个带 sleep 循环的复合操作 —— 那正是旧 `skills.smeltItem` 的样子，
 *   也是 02 §2 说的"动作只管一次玩家操作"。等和重试属于流程（flow_smelt）。
 */
import * as mc from '../../utils/mcdata.js';
import { ok, fail } from './contract.js';
import { countItem } from './query_perceive.js';
import { GOAL_LOOK_AT_DEFAULT_REACH as REACH } from '../rules/rules.runtime.js';

/**
 * 合成 n 个 item（**一次** bot.craft 调用；料不够就按能合的量合）。
 *
 * @returns ActionResult
 *   ok        → data: { craftedItem, want, got, produced, costMs }
 *   NO_RECIPE 没有这个配方（或名字根本不是物品）—— 与 NO_ITEM 的区别：这个永远合不出来
 *   NO_ITEM   有配方但料不够 —— 补料还能继续
 *   NO_WORKSTATION 需要工作台但够不着 —— 与 OUT_OF_REACH 的区别：那是"走近一点"，这是"根本没有"
 */
export async function craftOnce(bot, itemName, n = 1, knownTable = null) {
    const t0 = Date.now();
    const want = Math.max(1, Math.floor(Number(n) || 1));

    // ★★ 2026-11-04（t91）：**所有失败分支都要带诊断数字。**
    //
    //   真机证据（第 36 跑）：`craft wooden_pickaxe` 两轮失败，`data={}` ——
    //   只有一句消息、没有任何数字，所以判断不了"料不够"还是"读太早"。
    //   t89 只在 `oak_planks` 那条路径加了快照，覆盖不全。
    //
    //   这里统一：**每个 `fail(...)` 都带 `inv`（当前背包）+ `want` + `limit`（若已算出）**。
    const snapInv = () => {
        const out = {};
        try {
            for (const it of (bot.inventory?.items?.() ?? [])) {
                if (it?.name) out[it.name] = (out[it.name] ?? 0) + (it.count ?? 0);
            }
        } catch { /* 读不到就空 */ }
        return out;
    };
    // ★ t123：把 `flow_craft` 的前置检查结果也带上（它现在不 return 了，只记事件）。
    //   这样一次失败里既有"上游怎么看料"也有"act_craft 怎么算 limit / 表 / 窗口"。
    // ★ t142：**读完即清**。这个标记由 `flow_craft` 写、`act_craft` 读，
    //   原来只写不清 → **上一张单的 precheck 会永久挂进后面所有 craft 的 diag**
    //   （和 `matCounts`/`recipesForCount` 同一族：诊断字段把旧信息冒充成当前信息）。
    //   同时加 60 秒时效：即使清理漏了，也不会把很久以前的一次 miss 当成这次的。
    const precheck = (() => {
        try {
            const pc = bot?.__craftPrecheckMiss ?? null;
            if (!pc) return null;
            try { delete bot.__craftPrecheckMiss; } catch { /* ignore */ }
            const at = Number(pc.at) || 0;
            if (at && Date.now() - at > 60_000) return null;      // 太旧 → 不算这次的
            return pc;
        } catch { return null; }
    })();
    const diag = (extra = {}) => ({ item: itemName, want, inv: snapInv(), precheck, ...extra });

    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!itemName) return fail('NO_TARGET', '没说要合成什么');

    // 1) 有没有这个配方（getItemCraftingRecipes 对不存在的物品返回 null，直接 .length 会炸）
    const known = typeof mc.getItemCraftingRecipes === 'function' ? mc.getItemCraftingRecipes(itemName) : null;
    if (!known || known.length === 0) {
        return fail('NO_RECIPE', `${itemName} 没有合成配方（或不是物品）`, diag());
    }

    // 2) **先看料够不够，再要工作台**（顺序有讲究）。
    //
    //    02 §3 的措辞是"有配方、料够；3×3 时工作台在 maxReach 内"—— 料在前。
    //    反过来的话，背包空空时会先报 NO_WORKSTATION（"附近没有工作台"），
    //    而真正的阻塞是"一样材料都没有"，上层会白跑一趟去找工作台。
    //
    //    `recipesFor(id, null, 1, null)` 拿的是"不用工作台就能合"的配方：
    //    空数组 + `recipesFor(..., true)` 有货 = 料够但需要工作台。
    const id = mc.getItemId(itemName);
    let recipes = bot.recipesFor?.(id, null, 1, null) ?? [];
    let tableBlock = null;
    let table = false;

    if (recipes.length === 0) {
        const withTable = bot.recipesFor?.(id, null, 1, true) ?? [];
        if (withTable.length === 0) {
            // 连"有工作台就能合"的配方都没有 → 料不够（02 §3 的 NO_ITEM）
            return fail('NO_ITEM', `料不够合 ${itemName}`, diag());
        }
        table = true;
        // 需要工作台：只找**手上这把**，不放工作台（放工作台是流程的事）
        // ★★ 2026-11-04（t90）：**优先用调用方给的工作台。**
        //
        //   真机证据（第 35 跑）：
        //     `craft wooden_pickaxe → failed «需要工作台，4 格内没有»`
        //   而 `flow_craft` 前面明明**找到了/放下了**工作台 —— 但它调的是
        //     `craftOnce(bot, itemName, want - got)`，**第四个参数根本没传**（签名里也没有）。
        //
        //   → `flow_craft` 整套"找表 / 合表 / 放表 / 走表"的逻辑**全部白做**，
        //     而 `act_craft` 又自己按 `maxDistance: 4` 找一遍 —— 她离得稍远就找不到。
        //
        //   修法：加第 4 个参数 `knownTable`，调用方知道表在哪就传进来，这里优先用。
        //   仍然保留自找的兜底（`!knownTable` 时按 4 格找）—— 不破坏单独调用 `craftOnce` 的场景。
        tableBlock = knownTable ?? bot.findBlock?.({
            matching: mc.getItemId('crafting_table'),
            maxDistance: 4,                     // maxReach
        }) ?? null;
        if (!tableBlock) {
            return fail('NO_WORKSTATION', `合成 ${itemName} 需要工作台，4 格内没有`, diag({ knownTable: !!knownTable }));
        }
        recipes = bot.recipesFor?.(id, null, 1, tableBlock) ?? [];
        if (recipes.length === 0) {
            // ★★★ 2026-11-05（t133，verify 的建议）：**这里必须能看出"是料不够还是表没拿到"。**
            //
            //   真机证据（第 54 跑）：失败 `data` 只有 5 键，**没有 `limit`/`invBefore`** ——
            //   说明死在这条早退。而 `inv` 里没有 `crafting_table`，
            //   所以真正的原因是"**工作台不在手边**"，不是"料不够"。
            //   但这条 `fail` 的文字写的是"料不够合 X（在工作台旁也合不出）" —— **误导**。
            return fail('NO_ITEM', `${itemName}：有工作台也算不出配方（料可能不够，或工作台不是合成台）`, diag({
                usedTable: !!tableBlock,
                // ★ 区分"表的问题"和"料的问题"所需的三个数
                recipesInInventory: (() => { try { return (bot.recipesFor?.(id, null, 1, null) ?? []).length; } catch { return null; } })(),
                recipesWithTable: (() => { try { return (bot.recipesFor?.(id, null, 1, true) ?? []).length; } catch { return null; } })(),
                tableInInventory: (() => { try { return (bot.inventory?.items?.() ?? []).filter((i) => i?.name === 'crafting_table').reduce((a, i) => a + (i.count ?? 0), 0); } catch { return null; } })(),
                tableBlockUsed: tableBlock?.position ? { x: tableBlock.position.x, y: tableBlock.position.y, z: tableBlock.position.z } : null,
                reason: tableBlock ? 'with-table-no-recipe' : 'needs-table-but-none',
            }));
        }
    }

    // 3) 合（按"料的限制"和 want 取小）
    // ★★★ 2026-11-04（t113）：**必须按"产出物 == 目标物品"精确挑 recipe，不能用 `recipes[0]`。**
    //
    //   真机决定性证据（第 44 跑）：
    //     轮2: invBefore {oak_log:6, oak_planks:1, stick:4}
    //          invAfter  {oak_button:1, oak_planks:1, stick:4}
    //     **6 个原木全没了，凭空出现 `oak_button`（木按钮）** ——
    //     她"合成了"，但合出来的是**木按钮**，不是木板。
    //
    //   `oak_button` 的配方是「1 木板 → 1 按钮」。而我们要的是「1 原木 → 4 木板」。
    //   → `bot.recipesFor(id, ...)` 返回的列表里，**`recipes[0]` 不是我们要的那条**。
    //     （`recipesFor` 的语义是"能产出这个 itemType 的配方"，但 mineflayer 的返回里
    //       可能混入 result 不匹配的条目 —— 本轮实测 `recipesInInventory: 1` 说明它确实返回了东西。）
    //
    //   修法：**按 `recipe.result.id === 目标 id` 过滤**，取第一条匹配的。
    //   如果一条都不匹配，如实报（不要退回 `[0]` —— 那正是这个 bug 的来源）。
    const wantId = mc.getItemId(itemName);
    const resultId = (r) => (r?.result?.id ?? r?.result?.itemId ?? null);
    const exact = recipes.filter((r) => resultId(r) === wantId);
    if (!exact.length) {
        return fail('NO_RECIPE', `${itemName} 的配方里没有「产出 ${itemName}」的那条（拿到 ${recipes.length} 条，产出都不匹配）`, diag({
            gotResults: recipes.slice(0, 5).map((r) => ({ id: resultId(r), name: (() => { try { return mc.getItemName(resultId(r)); } catch { return null; } })() })),
        }));
    }
    const recipe = exact[0];
    const before = countItem(bot, itemName);
    // ★ t89：合成**前**的完整背包快照（必须在 bot.craft 之前抓，否则没意义）
    //   `snapInv` 已在函数开头定义（t91 统一诊断用），这里直接调。
    const invBefore = snapInv();
    // ★★★ 2026-11-04（t115）：**`limit` 是"合成次数"不是"件数" —— 单位混用让需求放大 2.75 倍。**
    //
    //   真根因（control 核账 + 读码确认）：
    //     `want`     = 要几**件**（3 块木板）
    //     `cap.num`  = 能合几**次**（`calculateLimitingResource` = 可用量 ÷ 每次用量，floor）
    //     `bot.craft(recipe, count, table)` 的 `count` 是**次数**！
    //   于是 `limit = Math.min(want, cap.num)` 把"3 件"当成"3 次" → **3 个原木、12 块板**。
    //
    //   全链实测影响（权威配方）：
    //     按件数（正确）：crafting_table 1 + wooden_pickaxe 1 + stick 1 + stone_pickaxe 1 = **4 原木**
    //     按次数（修前）：4 + 3 + 2 + 2 = **11 原木**
    //   → `WOOD_TARGET=8` 不够 → "挖了 8 个只剩 1 个"。**需求被放大 2.75 倍。**
    //
    //   修法：**先把"件数"折成"次数"**（`ceil(want / 每次产出几件)`），再和 `cap.num`（次数）取小。
    const perCraft = Math.max(1, Number(recipe?.result?.count) || 1);
    let limit = Math.ceil(want / perCraft);            // ← 次数（不是件数）
    let _requiredForDiag = null;                        // ★ t111：算 limit 用的原料表（诊断）
    // ★★★ t116：**这两个数必须在 craft 之前抓。**
    //   原来是在**失败时**才调 `bot.recipesFor` —— 那时料已经被 craft 消耗掉了，
    //   所以永远读到 0（verify 第 46 跑看到 `recipesInInventory:0 / recipesWithTable:0`，
    //   而"3 个原木消失"正说明 craft 真的跑了）。**又一个"测量时点错"**。
    const _preDiag = (() => {
        try {
            return {
                recipesInInventory: (bot.recipesFor?.(mc.getItemId(itemName), null, 1, null) ?? []).length,
                recipesWithTable: (bot.recipesFor?.(mc.getItemId(itemName), null, 1, true) ?? []).length,
            };
        } catch { return { recipesInInventory: null, recipesWithTable: null }; }
    })();
    try {
        const inv = (bot.inventory?.items?.() ?? []).reduce((m, it) => {
            if (it?.name) m[it.name] = (m[it.name] ?? 0) + (it.count ?? 0);
            return m;
        }, {});
        const required = typeof mc.ingredientsFromPrismarineRecipe === 'function'
            ? mc.ingredientsFromPrismarineRecipe(recipe)
            : null;
        _requiredForDiag = required;                    // ★ t111：失败时要能带出来
        const cap = typeof mc.calculateLimitingResource === 'function'
            ? mc.calculateLimitingResource(inv, required)
            : null;
        if (cap && Number.isFinite(cap.num)) limit = Math.min(limit, cap.num);   // ★ t115：两边都必须是"次数"
    } catch { /* 算不出限制就按 want 试，让 bot.craft 自己报错 */ }

    if (limit <= 0) {
        return fail('NO_ITEM', `料不够合 ${itemName}`, diag({ got: 0, limit }));
    }

    // ★★★ 2026-11-04（t110）：**开着的窗口会让 `bot.craft` 静默失败。**
    //
    //   真机实证（第 42 跑，`craft oak_planks c=2`）：
    //     invBefore = {oak_planks:1, crafting_table:1, **oak_log:3**, stick:4}
    //     invAfter  = 完全相同          ← 木材充足，但**一块都没产出**
    //     limit=2, produced=0, costMs=1536（轮询 1.5s 超时）
    //   `bot.craft` **没抛错**，背包也**没变** —— 典型的"窗口状态不对"。
    //
    //   来源：`flow_store`/`flow_fetch`/`deposit`/`withdraw` 会打开容器窗口。
    //   如果它们异常退出而没关窗，`bot.currentWindow` 就一直是那个容器 →
    //   `bot.craft` 往一个**不是合成台**的窗口里塞配方 → 服务端忽略 → 客户端 resolve。
    //
    //   修法：**craft 之前先确保没有别的窗口开着。**
    //   （`tableBlock` 是真工作台时 mineflayer 会自己开窗，所以这里只关"别人的窗口"。）
    try {
        if (bot.currentWindow && !bot.currentWindow.type?.includes('crafting')) {
            await bot.closeWindow?.(bot.currentWindow);
        }
    } catch { /* 关不掉就照常试，让下面如实报 */ }

    // ★★★ 2026-11-04（t112）：**`tableBlock` 可能是 stale 对象 —— 重新读一次确认它还在。**
    //
    //   真机证据（第 43 跑，`craft wooden_pickaxe`）：
    //     材料完全够（oak_planks:5 需 3、stick:4 需 2）、`limit=1`
    //     `bot.craft` **没抛错**、`produced=0`
    //     `windowOpen=null`、`heldItem='crafting_table'`（工作台还在**手上/背包**里没消耗）
    //
    //   如果 `tableBlock` 是"放置前拿到的旧对象"（坐标对、但那次放置其实没成功，
    //   或者被后续动作挪走），`bot.craft` 拿它开窗口会**静默失败** ——
    //   和 t91 的"幽灵方块"是同一族（**stale 数据当权威输入**）。
    //
    //   注意：这里**不能**因为读不到就 fail —— 假 bot / 区块未加载都会读不到。
    //   只记诊断，让 `produced=0` 时能看出"表当时是否还在"。
    // ★★★ 2026-11-04（t121）：**3x3 配方但没拿到工作台 → 必须失败，不能静默走 2x2。**
    //
    //   真机证据（第 49 跑，逐条排除到最后）：
    //     invBefore {oak_planks:6, stick:4}（需 3+2，远超）｜recipesWithTable: 1
    //     produced=0 ｜ costMs=1628（**1.6 秒就返回**）｜windowOpen:null ｜ heldItem='crafting_table'
    //
    //   mineflayer `craftOnce` 的分支只有两条：
    //     if (craftingTable) { activateBlock + await once('windowOpen') /* 20s 超时 */ }
    //     else                { startClicking(bot.inventory, 2, 2) }        ← **只用 2x2**
    //   而 `wooden_pickaxe` 是 **3x3** 配方。若 `tableBlock` 为 null → 走 2x2 →
    //   **摆不下 3x3 → 一枚也不产出，而且不抛错、1~2 秒就返回**（完全符合 1628ms + produced=0）。
    //
    //   （若是"开了窗口但被拒"，会等满 20s 才抛 —— 与 1.6s 不符，故排除。）
    //
    //   修法：**配方需要工作台而 `tableBlock` 为空时直接 fail**，不让它静默降级到 2x2。
    const requiresTable = !!recipe?.requiresTable;
    if (requiresTable && !tableBlock) {
        return fail('NO_WORKSTATION', `合成 ${itemName} 需要 3x3 工作台，但这次没拿到工作台（不能退化成 2x2）`, diag({
            requiresTable, tableBlockUsed: null, reason: 'needs-table-but-none',
        }));
    }

    let tableStillThere = null;
    if (tableBlock?.position) {
        try {
            const b = bot.blockAt?.(tableBlock.position, false);
            tableStillThere = b?.name ?? null;
        } catch { /* ignore */ }
    }
    // ★★★ 2026-11-05（t135，verify 的 24 键诊断逐条排除后的唯一异常）：
    //   **`heldItem` 是方块/材料时，`bot.activateBlock` 打不开工作台 GUI。**
    //
    //   真机证据（第 55 跑，同一张 obtain 里一次成功一次失败）：
    //     成功那张：`prod=1`、`windowOpen` 正常
    //     失败那张：`windowOpen: **null**`、`heldItem: **"oak_planks"**`
    //     而 `tableBlockUsed:{6201,-58,8801}` + `tableStillThere:"crafting_table"` + `recipesWithTable:1`
    //     → **表找到了、配方有、limit 也算了，就是窗口没打开。**
    //
    //   机制：mineflayer 的 `activateBlock` 会把 `heldItem` 一起写进 `block_place` 包。
    //   **手里拿着一块可放置的方块右键时，服务端优先"放置方块"而不是"打开 GUI"**
    //   → `once(bot,'windowOpen')` 等不到窗口。
    //
    //   第 49 跑那次是 `heldItem:"crafting_table"`（同样是方块）—— **同一个原因**。
    //
    //   修法：**合成前把主手清空。** 和 `holdDig` 的"挖矿前静默导航"同一模式：
    //   **动作前先把状态清干净，别指望下游容忍我的残留状态。**
    try {
        if (bot.heldItem && typeof bot.unequip === 'function') {
            await bot.unequip('hand');
        }
    } catch { /* 卸不下来就照常试，让下面如实报 */ }

    // ★★★ t113（control 建议）：**从"仅诊断"升级为"前置阻断"。**
    //
    //   原因（它的源码研究）：mineflayer 的 `requirementsMetForRecipe` 对第 4 参只做**真值判断**：
    //     `if (recipe.requiresTable && !craftingTable) return false`
    //   → **传一个 stale Block 也照样返回 3x3 配方**（"recipesFor 返回非空 ≠ 能合成"）。
    //   而 `bot.craft` **不校验 recipe 与背包匹配** → 服务端忽略 → **resolve 且零产出**。
    //   这正是第 44 跑"快、无错、produced=0"的机制。
    //
    //   所以：**读到表不在就立刻停**，别把 stale Block 交给 bot.craft。
    //   ★ 只在"确实读到了方块对象、且它不是 crafting_table"时阻断 ——
    //     `blockAt` 返回 null（区块未加载 / 假 bot）时**不阻断**，否则会造成假红。
    if (tableBlock?.position && tableStillThere !== null && tableStillThere !== 'crafting_table') {
        return fail('NO_WORKSTATION', `工作台不在了（那个位置现在是 ${tableStillThere}）`, diag({
            tableBlockUsed: { x: tableBlock.position.x, y: tableBlock.position.y, z: tableBlock.position.z },
            tableStillThere,
            reason: 'stale-table-block',
        }));
    }

    // ★★★ 2026-11-05（t136，verify 第 56 跑的排除法推进到只剩 `windowOpen`）：
    //   **`activateBlock` 对超出交互距离的方块会静默失败 → 等不到 `windowOpen`。**
    //
    //   真机证据（第 56 跑，`heldItem` 已排除）：
    //     `heldItem:null`（t135 生效）｜`tableStillThere:"crafting_table"`｜`recipesWithTable:1`
    //     `tableBlockUsed:{6201,-58,8801}`｜`windowOpen:null`｜`costMs=1543`｜`invBefore==invAfter`
    //   → **表在、配方有、手是空的，就是窗口不开。**
    //   而同一轮里另一次 `wooden_pickaxe done prod=1` —— **站得近就成，走开了就败。**
    //
    //   机制：`bot.activateBlock` 是"发一个右键包"，**服务端按距离校验**；
    //   超出 `maxReach`（约 4~5 格）就既不报错也不开窗。
    //
    //   修法：**craft 前先量距离，太远就走到表旁。**
    //   （`flow_craft` 里也有一段 goTo，但它量的是"到表"的距离，那时还没 `tableBlock`；
    //     而且它只在放置后立刻走，`act_craft` 里这次可能又走开了。）
    let distToTable = null;
    if (tableBlock?.position && bot.entity?.position) {
        const tp = tableBlock.position; const sp = bot.entity.position;
        distToTable = Math.hypot(tp.x + 0.5 - sp.x, tp.y + 0.5 - sp.y, tp.z + 0.5 - sp.z);
    }
    // ★ t136 修正：**act 层不判死距离，只记诊断** —— 导航是 flow 层的职责（02 §5 分层）。
    //   在 act 层 `fail('OUT_OF_REACH')` 会让"本来走两步就能成"变成失败，
    //   而且 `flow_craft` 已经有一段 goTo 表旁（它才是该负责这个的地方）。
    //   → 这里只把 `distToTable` 记进 diag，让失败时一眼能看出"是不是够不着"。
    const tableTooFar = (distToTable !== null && distToTable > 4.5);

    try {
        await bot.craft(recipe, limit, tableBlock ?? undefined);
    } catch (e) {
        const msg = String(e?.message ?? e);
        // ★★★ 第15条（R1 收尾）：**合成抛错也要如实报"这一次真做出来几个"。**
        //
        //   `bot.craft(recipe, limit)` 内部是按次数循环的：被中断时**可能已经合出若干件**
        //   （材料已经真扣了）。原来这两条 `fail` 只带 `{item}` —— 产出是 0 还是 N
        //   没人知道，于是 `board_store` 的产出账（`checkpoint.producedTotal`）记成 0，
        //   下一轮重试**再从零做一遍** → 材料被扣第二次（第15条的病灶）。
        //   → 报出真实差值；拿不准（读不到背包）就报 0，不猜。
        const madeInCatch = Math.max(0, (() => { try { return countItem(bot, itemName) - before; } catch { return 0; } })());
        if (/interrupt/i.test(msg)) {
            return fail('INTERRUPTED', '被取消了', {
                item: itemName, want, produced: madeInCatch, producedTotal: madeInCatch, invAfter: snapInv(),
            });
        }
        return fail('INTERNAL', msg, diag({ error: msg, limit, produced: madeInCatch, producedTotal: madeInCatch }));
    }

    // ★★ 2026-11-04（t89）：**合成后立刻读背包会读到旧值 —— 要等一下再判。**
    //
    //   真机证据（第 34 跑）：
    //     `craft oak_planks c=3 → blocked «合成了但 oak_planks 没增加（料可能刚好不够）»`
    //   消息本身是诚实的（`bot.craft` 没抛错 = 合成了），但**紧接着 `countItem` 没看到增加**。
    //
    //   两个可能：
    //     ① 服务端**槽位同步有延迟** —— `bot.craft` resolve 时本地 `bot.inventory` 还没更新
    //     ② 真的没产出（料不足）—— 但我们前面已经用 `calculateLimitingResource` 限过 `limit`
    //
    //   ① 完全可以通过"等一小会儿再读"区分开：**这次改成轮询到计数变化或超时**，
    //   并在失败时把 `before/after` 的**完整背包快照**放进 data（verify 要的诊断）。
    let after = countItem(bot, itemName);
    const tWait = Date.now();
    while (after - before <= 0 && Date.now() - tWait < 1500) {
        if (bot?.interrupt_code) {
            // ★★★ 第15条：**中断也要把已经产出的数量报出去**（原来只报 `{item}`）。
            //   这一支最容易被漏：`bot.craft` 已经 resolve（材料真扣了、产物可能已经进背包），
            //   紧接着收到中断 → 报 produced=0 → 产出账记 0 → 重试再做一遍 → 扣第二次料。
            const madeNow = Math.max(0, (() => { try { return countItem(bot, itemName) - before; } catch { return 0; } })());
            return fail('INTERRUPTED', '被取消了', {
                item: itemName, want, produced: madeNow, producedTotal: madeNow, invAfter: snapInv(),
            });
        }
        await new Promise((r) => setTimeout(r, 120));
        after = countItem(bot, itemName);
    }
    const produced = after - before;
    if (produced <= 0) {
        return fail('NO_ITEM', `合成了但 ${itemName} 没增加（料可能刚好不够）`, {
            item: itemName, want, got: 0, produced: 0, costMs: Date.now() - t0,
            // 诊断三件套（verify 要求）：合成前后的完整背包 + 限流算出多少
            invBefore, invAfter: snapInv(), limit,
            // ★★★ t111：**改掉会误导人的字段名。**
            //   原名 `matCounts: {[itemName]: after}` 听起来像"材料数量"，
            //   实际是"**产出物现在有几个**" → verify 把它读成"限制材料取错项"，
            //   于是我按"取错原料"的方向查了一轮（错方向）。
            //   **字段名必须让人读对，否则诊断越详细越误导。**
            craftedItemCount: { [itemName]: after },
            // 真正算 `limit` 用的原料表（`ingredientsFromPrismarineRecipe` 的输出）
            requiredMaterials: _requiredForDiag ?? null,
            // "合成成功但背包没变"的诊断（真机第 42 跑的现象）
            windowOpen: bot.currentWindow?.type ?? null,
            heldItem: bot.heldItem?.name ?? null,
            // ★★★ t112：**`recipesForCount` 用的是 `table=null`（= 只看背包 2x2）** ——
            //   对 3x3 物品（木镐/石镐/工作台…）它**必然是 0**，因为背包合不了 3x3。
            //   verify 把它读成"新根因：查配方拿到 0 条"，**又是我字段名/语义没写清造成的误读**
            //   （第 2 次：上一次是 `matCounts`）。
            //   → 改成两个语义明确的名字，并把"到底用哪张工作台"也带出来。
            // ★ t116：用 **craft 之前**抓的值（craft 之后再查会因料被消耗而恒为 0）
            recipesInInventory: _preDiag.recipesInInventory,
            recipesWithTable: _preDiag.recipesWithTable,
            limitUsed: limit,                                  // ★ t116：这次实际合几次（诊断单位混用）
            distToTable: distToTable ?? null,                  // ★ t136：离表多远（>4.5 = activateBlock 可能静默失败）
            tableTooFar,                                       // ★ t136：够不够得着（诊断，不判死）
            tableBlockUsed: tableBlock?.position ? { x: tableBlock.position.x, y: tableBlock.position.y, z: tableBlock.position.z } : null,
            // ★ t122：**`requiresTable` 是决定性字段** ——
            //   `true` + `tableBlockUsed:null` = 走了 2x2（一枚不产出、不报错、1~2 秒返回）
            //   `true` + `tableBlockUsed` 有值 = 表拿到了，问题在开窗/摆料/取产物
            requiresTable: !!recipe?.requiresTable,
            recipeResultCount: Number(recipe?.result?.count) || null,
            tableStillThere: tableStillThere ?? 'unknown',
            tableInInventory: (() => { try { return (bot.inventory?.items?.() ?? []).filter((i) => i?.name === 'crafting_table').reduce((a, i) => a + (i.count ?? 0), 0); } catch { return null; } })(),
        });
    }
    return ok({
        craftedItem: itemName,
        want,
        got: limit,
        produced,
        // ★★★ 第15条（R1 收尾）：产出账的口径统一在这里说明白。
        //   · `produced`       = **本次调用**的真实产出（`after - before`，单位"件"）
        //   · `producedTotal`  = 与它同值；`board_store.finish` 认这个名字，用来把
        //                        "这张单已经产出过多少"累进 `checkpoint.producedTotal`。
        //     **跨尝试的累计不在这里做**：`act_craft` 拿不到 jobId（`composite_registry:109`
        //     的 `runCraft` 没把 `ctx` 传下来，见 deep-executor E6），也就没有"哪张单"的概念。
        //     硬在这里攒一个 bot 级计数器 = 把"别的单/上半场"的产出算到这张单头上
        //     （账报大 → 单子提前 done → 少做活），比不记更危险。
        producedTotal: produced,
        usedTable: !!tableBlock,
        costMs: Date.now() - t0,
        // ★★★ 2026-11-05（t128）：**成功也要留背包快照。**
        //
        //   真机（第 52 跑）现象：`craft oak_planks` 两张都报 `done`（`count/produced=4`），
        //   但 `craft wooden_pickaxe` 失败时 `inv={oak_planks:2}`。
        //   **8 块板产出了，可是失败时只剩 2 块 —— 中间谁吃了 6 块，查不出来。**
        //   因为「成功」的记录里**只有 produced，没有产出后的背包**。
        //
        //   → 让每次成功都带上 `invAfter`。这样下一次可以按时间把
        //     「谁产出多少 → 谁消耗多少」整条链重建出来，不用再靠猜。
        invAfter: snapInv(),
    });
}

/** 熔炉够不够得着（够不着就不动作；走近是流程的事）。 */
function furnaceInReach(bot, furnace, maxReach = REACH) {
    const p = furnace?.position;
    const self = bot?.entity?.position;
    if (!p || !self) return { ok: false, dist: null };
    const d = Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z);
    return { ok: d <= maxReach, dist: d };
}

/**
 * 熔炉里是不是在炼"别的东西"？
 *
 * mineflayer 的 FurnaceWindow 暴露 `inputItem()` / `fuelItem()` / `outputItem()`，
 * 拿不到时退回去读 `slots`（输入槽一般是 0，输出 2，燃料 1；不同版本可能不同，
 * 所以两个来源都试）。
 *
 * @returns {{name:string,count:number}|null} 有别人的料就返回它，否则 null
 */
function furnaceBusyWith(win, myInput) {
    const peek = (fn, fallbackIdx) => {
        try {
            if (typeof fn === 'function') {
                const it = fn();
                if (it && it.name) return it;
            }
            const slots = win?.slots;
            if (Array.isArray(slots) && typeof fallbackIdx === 'number') {
                const it = slots[fallbackIdx];
                if (it && it.name && it.count > 0) return it;
            }
        } catch { /* 读不到就当没有 */ }
        return null;
    };

    const input = peek(win?.inputItem?.bind(win), 0);
    if (input && input.name !== myInput) {
        return { name: input.name, count: input.count ?? 0 };
    }
    return null;
}

/**
 * 一份燃料能烧几个物品（原版燃烧时长 ÷ 每个 10 秒）。
 *
 * ★★ BOT-003（2026-11-06 深度检查）：这张表原来**不存在**。
 *   `furnaceLoad` 固定 `putFuel(..., 1)`，`putInput` 又总是塞满最多 64 个 ——
 *   于是「16 份原料 + 64 煤」只烧出 8 个（1 煤 = 8 个），剩下 8 份原料在炉里干等，
 *   流程空转到 10 分钟 deadline 才报"只炼出 8/16"；只要求 1 个时也会把 64 份料塞进炉子。
 *   报告验证：只加 1 煤，产 8/16，虚拟 costMs=600000，剩 8 原料/63 煤。
 *
 *   修法（报告给的最小修复）：按燃烧时长算燃料数量 —— 表只覆盖 `flow_smelt`
 *   会挑的那几样（`FUEL_ORDER`）+ 常见几种，其余按原版默认 15 秒 = 1.5 个。
 */
const FUEL_BURN = {
    coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, dried_kelp_block: 20,
    lava_bucket: 100, stick: 0.5, bamboo: 0.25,
};

/** 一份燃料能烧几个（见上面 BOT-003 的说明）。 */
export function fuelBurnOf(fuel) {
    const name = String(fuel ?? '');
    const hit = FUEL_BURN[name];
    if (Number.isFinite(hit)) return hit;
    // 任意木板 / 原木 / 木头（oak_planks / oak_log / stripped_oak_log / crimson_stem …）
    if (/(_planks|_log|_wood|_stem|_hyphae|_fence|_slab|_stairs)$/.test(name)) return 1.5;
    return 1.5;                                  // 原版默认 15 秒
}

/** 烧 n 个物品需要几份燃料（向上取整；至少 1 份）。 */
export function fuelNeededFor(fuel, n) {
    const want = Math.max(0, Math.floor(Number(n) || 0));
    const burn = fuelBurnOf(fuel);
    if (!(burn > 0)) return Math.max(1, want);
    return Math.max(1, Math.ceil(want / burn));
}

/**
 * 往熔炉放一次料（上格放 input，下格放 fuel）。**不等烧完**。
 *
 * ★ BOT-003：加了 `opts.count` —— **只放本次任务要炼的数量**（原来塞满最多 64），
 *   燃料也按燃烧时长配足（原来固定 1 份，烧完 8 个就断火）。
 *
 * @param {{count?:number}} [opts] count = 这次要炼几个（不传 = 有多少放多少，保持老行为）
 * @returns ActionResult
 *   ok           → data: { input, inputCount, fuel, fuelCount, costMs }
 *   NO_ITEM      料或燃料不够
 *   OUT_OF_REACH 熔炉太远 —— 走近就能解决，所以不是 NO_WORKSTATION（那是"根本没有熔炉"）
 *   OCCUPIED     熔炉里正在炼别的东西 —— 不抢，上层换一个熔炉（"那格本身有东西"正是这个码的语义）
 */
export async function furnaceLoad(bot, furnace, input, fuel, opts = {}) {
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!furnace || !furnace.position) return fail('NO_TARGET', '没给熔炉');
    if (!input) return fail('NO_TARGET', '没说要烧什么');

    const reach = furnaceInReach(bot, furnace);
    if (!reach.ok) {
        return fail('OUT_OF_REACH', `熔炉离 ${reach.dist?.toFixed?.(1) ?? '?'} 格，够不着`, { dist: reach.dist });
    }

    const have = countItem(bot, input);
    if (have <= 0) return fail('NO_ITEM', `背包里没有 ${input}`, { input });

    let fuelItem = fuel;
    if (!fuelItem) {
        // 没指定燃料就用常见的那几种（and 只报"没有燃料"，不猜太多）
        fuelItem = ['coal', 'charcoal', 'oak_planks', 'oak_log'].find((f) => countItem(bot, f) > 0) ?? null;
    }
    if (!fuelItem || countItem(bot, fuelItem) <= 0) {
        return fail('NO_ITEM', '没有燃料', { input, fuel: fuelItem });
    }

    // ★ BOT-003：装料量 = min(背包里有的, 本次要炼的, 炉子一格的上限)。
    //   老行为是 `Math.min(have, 64)` —— 只要 1 个也会把 64 份原料塞进炉子。
    const wantLoad = Number(opts?.count);
    const putCount = Math.min(have, Number.isFinite(wantLoad) && wantLoad > 0 ? Math.floor(wantLoad) : have, 64);
    // ★ BOT-003：燃料按"要烧几个"配足（1 煤 = 8 个），不再固定 1 份。
    const fuelHave = countItem(bot, fuelItem);
    const fuelPut = Math.min(fuelHave, fuelNeededFor(fuelItem, putCount));

    let win = null;
    try {
        win = await bot.openFurnace(furnace);

        // ★ 不抢别人的熔炼（2026-11-02 captain 抓到的 bug）。
        //
        // 原 `skills.smeltItem` 开窗后会先读一次窗口状态，如果里面在炼**别的**东西就退出，
        // 不抢别人的熔炼位。这条保护一度被我丢了（furnaceLoad 不看里面有什么）——
        // 后果是她会往别人正在烧的熔炉里塞自己的料。
        //
        // 既然开窗是这一步的必需动作，读一次 slots 几乎零成本：
        //   输入槽有货且**不是本次要放的东西** → OCCUPIED（"那格本身有东西"，上层换个熔炉）
        //   输入槽空，或已经是同种物品 → 正常放（同种就是续料，合理）
        const busy = furnaceBusyWith(win, input);
        if (busy) {
            try { win.close?.(); } catch { /* ignore */ }
            return fail('OCCUPIED', `熔炉里正在炼 ${busy.name}（${busy.count} 个），不抢`, {
                input, occupantNow: busy.name, occupantCount: busy.count,
            });
        }

        await win.putInput(mc.getItemId(input), null, putCount);
        await win.putFuel(mc.getItemId(fuelItem), null, fuelPut);
    } catch (e) {
        const msg = String(e?.message ?? e);
        try { win?.close?.(); } catch { /* ignore */ }
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { input });
        return fail('INTERNAL', msg, { error: msg, input });
    }
    try { win.close?.(); } catch { /* 关不上不影响结果 */ }

    return ok({ input, inputCount: putCount, fuel: fuelItem, fuelCount: fuelPut, costMs: Date.now() - t0 });
}

/**
 * 从熔炉取产物。**没烧完就报 NOT_READY**（不是 TIMEOUT：还在烧不是错误，等一会再来）。
 *
 * @returns ActionResult
 *   ok            → data: { taken, costMs }
 *   NOT_READY     产物格是空的（还没烧完 / 没放料）
 *   INVENTORY_FULL 背包满 —— 拿走也没地方放
 *   OUT_OF_REACH  熔炉太远
 */
export async function furnaceCollect(bot, furnace) {
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!furnace || !furnace.position) return fail('NO_TARGET', '没给熔炉');

    const reach = furnaceInReach(bot, furnace);
    if (!reach.ok) {
        return fail('OUT_OF_REACH', `熔炉离 ${reach.dist?.toFixed?.(1) ?? '?'} 格，够不着`, { dist: reach.dist });
    }
    if (bot.inventory?.emptySlotCount?.() === 0 && (bot.inventory?.items?.() ?? []).length >= 36) {
        return fail('INVENTORY_FULL', '背包满了，取出来没地方放', {});
    }

    let win = null;
    let taken = null;
    try {
        win = await bot.openFurnace(furnace);
        const out = win.outputItem?.();
        if (!out || !out.count) {
            try { win.close?.(); } catch { /* ignore */ }
            return fail('NOT_READY', '产物格是空的（还没烧完或没放料）', { costMs: Date.now() - t0 });
        }
        taken = await win.takeOutput();
    } catch (e) {
        const msg = String(e?.message ?? e);
        try { win?.close?.(); } catch { /* ignore */ }
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了');
        return fail('INTERNAL', msg, { error: msg });
    }
    try { win.close?.(); } catch { /* ignore */ }

    return ok({ taken: taken?.name ?? null, count: taken?.count ?? 0, costMs: Date.now() - t0 });
}
