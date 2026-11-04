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
    const diag = (extra = {}) => ({ item: itemName, want, inv: snapInv(), ...extra });

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
            return fail('NO_ITEM', `料不够合 ${itemName}（工作台旁也合不出）`, diag({ usedTable: !!tableBlock }));
        }
    }

    // 3) 合（按"料的限制"和 want 取小）
    const recipe = recipes[0];
    const before = countItem(bot, itemName);
    // ★ t89：合成**前**的完整背包快照（必须在 bot.craft 之前抓，否则没意义）
    //   `snapInv` 已在函数开头定义（t91 统一诊断用），这里直接调。
    const invBefore = snapInv();
    let limit = want;
    try {
        const inv = (bot.inventory?.items?.() ?? []).reduce((m, it) => {
            if (it?.name) m[it.name] = (m[it.name] ?? 0) + (it.count ?? 0);
            return m;
        }, {});
        const required = typeof mc.ingredientsFromPrismarineRecipe === 'function'
            ? mc.ingredientsFromPrismarineRecipe(recipe)
            : null;
        const cap = typeof mc.calculateLimitingResource === 'function'
            ? mc.calculateLimitingResource(inv, required)
            : null;
        if (cap && Number.isFinite(cap.num)) limit = Math.min(want, cap.num);
    } catch { /* 算不出限制就按 want 试，让 bot.craft 自己报错 */ }

    if (limit <= 0) {
        return fail('NO_ITEM', `料不够合 ${itemName}`, diag({ got: 0, limit }));
    }

    try {
        await bot.craft(recipe, limit, tableBlock ?? undefined);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { item: itemName });
        return fail('INTERNAL', msg, diag({ error: msg, limit }));
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
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { item: itemName });
        await new Promise((r) => setTimeout(r, 120));
        after = countItem(bot, itemName);
    }
    const produced = after - before;
    if (produced <= 0) {
        return fail('NO_ITEM', `合成了但 ${itemName} 没增加（料可能刚好不够）`, {
            item: itemName, want, got: 0, produced: 0, costMs: Date.now() - t0,
            // 诊断三件套（verify 要求）：合成前后的完整背包 + 限流算出多少
            invBefore, invAfter: snapInv(), limit,
            matCounts: { [itemName]: after },
        });
    }
    return ok({
        craftedItem: itemName,
        want,
        got: limit,
        produced,
        usedTable: !!tableBlock,
        costMs: Date.now() - t0,
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
 * 往熔炉放一次料（上格放 input，下格放 fuel）。**不等烧完**。
 *
 * @returns ActionResult
 *   ok           → data: { input, inputCount, fuel, costMs }
 *   NO_ITEM      料或燃料不够
 *   OUT_OF_REACH 熔炉太远 —— 走近就能解决，所以不是 NO_WORKSTATION（那是"根本没有熔炉"）
 *   OCCUPIED     熔炉里正在炼别的东西 —— 不抢，上层换一个熔炉（"那格本身有东西"正是这个码的语义）
 */
export async function furnaceLoad(bot, furnace, input, fuel) {
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

        await win.putInput(mc.getItemId(input), null, Math.min(have, 64));
        await win.putFuel(mc.getItemId(fuelItem), null, 1);
    } catch (e) {
        const msg = String(e?.message ?? e);
        try { win?.close?.(); } catch { /* ignore */ }
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { input });
        return fail('INTERNAL', msg, { error: msg, input });
    }
    try { win.close?.(); } catch { /* 关不上不影响结果 */ }

    return ok({ input, inputCount: Math.min(have, 64), fuel: fuelItem, costMs: Date.now() - t0 });
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
