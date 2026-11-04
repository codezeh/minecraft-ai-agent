/**
 * 策略：弄到 N 个某物品（M10，04 §6.3 `strat_obtain`）。
 *
 * ★ 策略的本质（04 §6.3 原文）：
 *   > **策略不自己做动作，只拆子单、等子单结果。**
 *   所以本文件**一行身体操作都没有**（没有 holdKey / digBlock / placeBlockAt / setControlState），
 *   它只做三件事：**建需求图 → 出子单（带 parentId + why）→ 汇总缺口**。
 *   有一条源码级用例盯着这条（`strat_no_body_op_unit`）。
 *
 * ── 来源顺序（04 §6.3 原文，前一个能满足就不往后试）────────────────────────
 *   箱子 > 合成 > 熔炼 > 采集 > 交易 > 打怪掉落
 *
 * ── 为什么不用 `ItemGoal.executeNext()``─────────────────────────────────
 *   `src/agent/npc/item_goal.js` 的 `ItemGoal` **自己会执行动作**（它内部直接
 *   `skills.moveAway` / `agent.actions.runAction` 去挖去合成）。那是"旧世界"的做法：
 *   同步、单线程、不可中断、不进任务板。
 *   B1 之后策略的正确形态是**拆成带 parentId 的子单**（任务板去调度）。
 *   而它真正的规划数据（`ItemWrapper` / `ItemNode`）**没有 export**，只有 `ItemGoal` 导出了。
 *
 *   所以这里**沿用它的需求图思路与同一批数据源**（`mcdata` 的
 *   `getItemCraftingRecipes / getItemBlockSources / getItemSmeltingIngredient / getItemAnimalSource`，
 *   也就是 item_goal.js `createChildren()` 用的那几个函数），自己建一张**有界**的需求图。
 *   这样既没有复制第二套"物品→来源"的真相（数据源同一处），又不会把动作塞进策略层。
 *
 * ── 防无限展开（04 §6.3 硬要求）────────────────────────────────────────
 *   子单返回 NO_ITEM 时把 `missing` 加回需求图。没有上限就是**无限展开**：
 *   要铁镐 → 要铁锭 → 要铁矿 → 要石镐 → 要木棍 → 要木板 → 要原木 → ……
 *   定两个硬上限（04 §6.3 的起步值）：
 *     · MAX_DEPTH = 6   —— 需求图最多展开 6 层
 *     · MAX_JOBS  = 30  —— 一轮最多产出 30 张子单
 *   撞到上限就**停下并返回缺口清单**（04 §3.3），而不是继续展开。
 *   有用例专门造"永远缺料"的链，断言停在 6 层/30 张。
 */

import * as mc from '../../utils/mcdata.js';
import { ok, fail } from './contract.js';

/** 04 §6.3 的起步值（跑起来再调）。 */
export const MAX_DEPTH = 6;
export const MAX_JOBS = 30;

/**
 * 来源优先级（04 §6.3 原文：箱子 > 合成 > 熔炼 > 采集 > 交易 > 打怪掉落）。
 * 数字越小越先试。
 */
export const SOURCE_ORDER = Object.freeze({
    container: 0,     // 箱子里拿（最省事：不用做任何东西）
    craft: 1,         // 合成
    smelt: 2,         // 熔炼
    collect: 3,       // 采集（挖/砍）
    trade: 4,         // 交易
    hunt: 5,          // 打怪掉落
});

/** 每个来源对应"该下什么子单"。 */
const SOURCE_TO_SKILL = {
    container: 'fetch',
    craft: 'craft',
    smelt: 'smelt',
    collect: 'mine',
    hunt: 'fight',
};

/**
 * 查一个物品有哪些**可行来源**（数据源与 item_goal.js 的 createChildren 同一处）。
 *
 * @param {string} itemName
 * @returns {Array<{type:string, source?:string, recipe?:object, ingredient?:string, animal?:string, cost:number}>}
 */
export function sourcesOf(itemName) {
    const out = [];
    const name = String(itemName ?? '');

    // 采集：能从方块里挖/砍出来
    try {
        for (const b of (mc.getItemBlockSources(name) ?? [])) {
            if (b === 'grass_block') continue;         // 与 item_goal 一致：草方块走泥土节点
            out.push({ type: 'collect', source: b, cost: SOURCE_ORDER.collect });
        }
    } catch { /* 查不到就没有这种来源 */ }

    // ★★★ 2026-11-04（t102）：**有熔炼来源的物品，熔炼必须排在合成前面。**

    //   真机/离线证据：`planObtain('iron_pickaxe')` 拆出
    //     craft:iron_pickaxe → craft:iron_ingot×3 → craft:iron_nugget×27 → …
    //   也就是**用 27 个铁粒合成 3 个铁锭**，而不是**烧 3 个铁矿**。
    //
    //   而 `planObtain('iron_nugget', 27)` →
    //     c:iron_nugget×27 + c:iron_ingot×3      gaps={"iron_nugget":27}
    //   铁粒要铁锭、铁锭又要铁粒 —— **是个环**，`seen` 挡住了继续展开，
    //   于是计划**只到"要 27 个铁粒"就停了，而铁粒根本弄不到**（gaps 里它自己都承认了）。
    //   → **`obtain iron_pickaxe / iron_sword / iron_axe` 永远不可能成功**，
    //     而且报错会说"缺铁粒"，把人引去挖一个挖不到的东西。
    //
    //   根因：`SOURCE_ORDER` 里 `craft(1)` 排在 `smelt(2)` 前面。
    //   对"既能合成又能熔炼"的物品（铁锭/金锭这类），**合成配方是"反向"的**
    //   （铁粒本来是从铁锭造出来的）→ 必须让 **smelt 优先**。
    //
    //   改动范围：**只对同时有两种来源的物品调整顺序**，其它物品完全不变。

    // 熔炼（先收集）
    let smeltSrc = null;
    try {
        const ing = mc.getItemSmeltingIngredient(name);
        if (ing) smeltSrc = { type: 'smelt', ingredient: ing, cost: SOURCE_ORDER.smelt };
    } catch { /* ignore */ }

    // 合成（后收集）
    const craftSrcs = [];
    try {
        for (const [recipe, meta] of (mc.getItemCraftingRecipes(name) ?? [])) {
            // ★★ t97：**必须带上 `craftedCount`（一次合成产出几个）。**
            //   原来写成 `for (const [recipe] of ...)`，把第二个元素整个丢掉 →
            //   `expand` 只能按 `per * stillNeed` 算材料，**不知道"一次产 N 个"**，
            //   于是把需求**算大**（stick: 2 木板 → 4 根，只要 2 根却按 2 次合成算 → 4 木板）。
            craftSrcs.push({ type: 'craft', recipe, craftedCount: Math.max(1, Number(meta?.craftedCount) || 1), cost: SOURCE_ORDER.craft });
        }
    } catch { /* ignore */ }

    // ★ t102：**有熔炼来源时，合成要降级**（避免"用铁粒造铁锭"这种反向配方成环）。
    //
    //   ★ 注意：这个数组最后会被 `out.sort((a,b) => a.cost - b.cost)` 重排（:131），
    //     所以**光调 push 顺序没用**（我第一版就这么写，被 sort 冲掉了）。
    //     必须改 `cost` 让排序自然把它排到后面。
    const smeltHonored = !!smeltSrc;
    if (smeltSrc) out.push(smeltSrc);
    for (const c of craftSrcs) {
        // 有熔炼来源 → craft 的 cost 抬到 smelt 之后（+10 保证严格靠后，不依赖具体数值）
        out.push(smeltHonored ? { ...c, cost: SOURCE_ORDER.smelt + 10 } : c);
    }

    // 打怪掉落
    try {
        const animal = mc.getItemAnimalSource(name);
        if (animal) out.push({ type: 'hunt', animal, cost: SOURCE_ORDER.hunt });
    } catch { /* ignore */ }

    // 按 04 §6.3 的来源顺序排
    return out.sort((a, b) => a.cost - b.cost);
}

/**
 * 一只 bot 现在身上/箱子里有多少（纯函数，注入 getter 便于测）。
 *
 * @param {object} args { item, inventory: Map|object, chests: Map|object }
 */
function haveCount(item, inventory, chests) {
    const inv = Number(inventory?.[item] ?? inventory?.get?.(item) ?? 0) || 0;
    const ch = Number(chests?.[item] ?? chests?.get?.(item) ?? 0) || 0;
    return { inv, chest: ch, total: inv + ch };
}

/**
 * 建需求图并产出子单计划（**纯函数，不下单、不动身体**）。
 *
 * @param {object} args
 *   item     要弄的物品
 *   count    要几个
 *   inventory  身上有多少（{name:count}）
 *   chests     箱子里有多少（{name:count}）
 *   deps       可选：{ sourcesOf } 注入（测试用）
 * @returns {{
 *   ok:boolean, plan:Array, gaps:object, expanded:number, hitDepth:boolean, hitJobs:boolean
 * }}
 *   plan   要下的子单（每个带 skill/args/why/depth/parentKey）
 *   gaps   缺口清单（04 §3.3）：{name: 还缺几个}
 */
export function planObtain(args = {}) {
    const item = String(args.item ?? '');
    const want = Math.max(1, Math.floor(Number(args.count) || 1));
    const getSources = args.deps?.sourcesOf ?? sourcesOf;

    const inventory = args.inventory ?? {};
    const chests = args.chests ?? {};

    // ★★ 2026-11-03（A2）：**子单预算**。
    //   有 `ctx.jobBudget` → 用**共享余额**（limit - used），跨调用真的共享；
    //   没有（直接调 `planObtain()` 的旧路径）→ 退回 per-call `MAX_JOBS=30`，**行为完全不变**。
    //   `MAX_DEPTH` 仍是 per-call 的深度闸（深度是"这次递归多深"，不是全局资源）。
    const budget = args.ctx?.jobBudget ?? null;
    const effCap = budget
        ? Math.max(0, Number(budget.limit ?? 0) - Number(budget.used ?? 0))
        : MAX_JOBS;

    const have = haveCount(item, inventory, chests);
    if (have.total >= want) {
        // 已经够了 → 一张单都不用下（04 §6.3："背包里有 count 个"就算完成）
        return { ok: true, plan: [], gaps: {}, expanded: 0, hitDepth: false, hitJobs: false, alreadyHave: have.total };
    }

    const plan = [];
    const gaps = {};
    const seen = new Set();          // 防止同一物品被反复展开（环）
    let hitDepth = false;
    let hitJobs = false;

    // ★★ 2026-11-03（t65）：**"成品 ← 材料"的边**，用来给子单补 `dependsOn`。
    //
    //   为什么不改 `expand` 的返回值：它内部有十几处裸 `return`，逐个改成返回 key 列表
    //   改动面太大、容易漏。改成**旁路记录**，最后统一后处理，风险小得多。
    //   `needsOf[成品] = [材料, ...]`
    const needsOf = new Map();

    /**
     * ★★ 2026-11-04（t85）：**同层同物品的需求必须合并成一张单。**
     *
     *   真机证据（第 30 跑）：`obtain wooden_pickaxe` 的 plan 里出现了
     *     `craft oak_planks c=4` 和 `craft oak_planks c=3` **两张单**，
     *     而原木只有 `mine oak_log c=1` 一张 → 两张都 `blocked «料不够合 oak_planks»`。
     *
     *   原因：`expand` 每遇到一次"需要木板"就 `plan.push` 一条，
     *   而 `wooden_pickaxe` 的配方里木板需求来自**两处**（自身 3 块 + 木棍 2 块），
     *   再叠上前面的 `crafting_table`（4 块）—— **同一层出现 2~3 张各需少量木板的单**。
     *   每张单单独等料、单独算量，**总需求永远对不上**。
     *
     *   修法：**同 `skill` + 同 `args.item` + 同 `depth` 的步骤合并计数**（不新增一条）。
     *   这样一层的"做木板"只有一张单：`craft oak_planks count=<所有需求之和>`。
     *
     *   `depth` 必须参与 key —— 不同深度的同名物品来自不同的父需求，不能合并
     *   （合并会打乱 dependsOn 的层级结构）。
     */
    const pushStep = (step) => {
        const same = plan.find((p) => p.depth === step.depth
            && p.skill === step.skill
            && (p.args?.item ?? p.args?.input ?? p.args?.ore) === (step.args?.item ?? step.args?.input ?? step.args?.ore));
        if (same) {
            same.args.count = Number(same.args.count ?? 0) + Number(step.args.count ?? 0);
            // why 拼起来，保留来源可读性
            if (step.why && !String(same.why ?? '').includes(step.why)) same.why = `${same.why}；${step.why}`;
            return same;
        }
        plan.push(step);
        return step;
    };

    /**
     * 递归展开（**有界**）。
     * @param {string} name 要弄的物品
     * @param {number} need 要几个
     * @param {number} depth 当前层数（根 = 1）
     * @param {string} parentKey 父单的 key（用于 why / parentId 关联）
     * @param {string} why 为什么需要它
     * @returns {string[]} 这次展开**产出的 plan key 列表**（供上层做 dependsOn）
     *
     * ★★ 2026-11-03（t65）：**返回 key 列表是为了让"材料 → 成品"能表达先后顺序**。
     *
     *   真机第 11 跑的止损点（verify 定位）：
     *     obtain crafting_table 的子单是**并排派出去的**：
     *       craft crafting_table → 先跑 → 那时还没木板 → NO_ITEM → blocked
     *       craft oak_planks     → 后跑 → 成功做出 8 块
     *     结果工作台 blocked、父单跟着 blocked，**而木板其实已经做出来了**。
     *   根因：`strat_obtain` 只写了 `parentKey`（给 why 用），**从来没写 `dependsOn`**，
     *   所以调度器看到它们全是 ready，谁先谁后看运气。
     */
    const expand = (name, need, depth, parentKey, why) => {
        if (hitJobs || hitDepth) return [];


        // ── 上限 0：子单预算（**push 之前**就要查，否则每次都会多推 1 张）──
        //
        // ★ 2026-11-03（A2 用例抓到的 off-by-one）：
        //   原来只有"push 之后判断 `plan.length >= effCap`"，而 `expand()` 一进来就先 push，
        //   于是**永远会超推 1 张**：limit=12 实测用了 13；预算已耗尽（effCap=0）时还会产出 1 张。
        //   push-then-check 只能"事后止损"，做不到"事前拦住"。
        //   这里在入口处先查一次，配合后面的 post-check 形成双保险。
        if (plan.length >= effCap) {
            hitJobs = true;
            return;
        }

        // ── 上限 1：层数 ──────────────────────────────────────────
        if (depth > MAX_DEPTH) {
            hitDepth = true;
            gaps[name] = (gaps[name] ?? 0) + need;
            return;
        }
        // 环：同一物品在一条链上再次出现 → 记缺口，不再展开
        if (seen.has(name)) {
            gaps[name] = (gaps[name] ?? 0) + need;
            return;
        }

        const h = haveCount(name, inventory, chests);
        if (h.total >= need) return;               // 已经有了，不用下子单
        const deficit = need - h.total;

        // ── 先看箱子（04 §6.3 来源顺序第一）：能从箱子补就不用做 ──
        if (h.chest >= deficit) {
            plan.push({
                skill: SOURCE_TO_SKILL.container,
                args: { item: name, count: deficit },
                why: `${why}（箱子里有）`,
                depth, parentKey, source: 'container',
            });
            if (plan.length >= effCap) { hitJobs = true; }
            return;
        }
        // 箱子只有一部分 → 缺的那部分继续找别的来源
        const fromChest = h.chest;
        if (fromChest > 0) {
            plan.push({
                skill: SOURCE_TO_SKILL.container,
                args: { item: name, count: fromChest },
                why: `${why}（箱子里有一部分）`,
                depth, parentKey, source: 'container',
            });
            if (plan.length >= effCap) { hitJobs = true; return; }
        }
        const stillNeed = deficit - Math.max(0, fromChest);
        if (stillNeed <= 0) return;

        // ── 其余来源按 04 §6.3 顺序逐个试，**第一个可行的就出单** ──
        const sources = getSources(name, { inventory, chests }) ?? [];
        if (!sources.length) {
            gaps[name] = (gaps[name] ?? 0) + stillNeed;   // 没有任何来源 → 缺口
            return;
        }

        for (const src of sources) {
            if (hitJobs) return;

            if (src.type === 'craft') {
                // ★ t65：记录"这个成品需要哪些材料"（后处理时用来补 dependsOn）
                needsOf.set(name, Object.keys(src.recipe ?? {}));
                pushStep({
                    skill: SOURCE_TO_SKILL.craft,
                    args: { item: name, count: stillNeed },
                    why,
                    depth, parentKey, source: 'craft',
                });
                if (plan.length >= effCap) { hitJobs = true; return; }
                // 合成要材料 → 把材料也展开（这才是"需求图"）
                seen.add(name);
                // ★★ t97：**按"一次产几个"折算合成次数**，而不是直接用需求数。
                //
                //   真机证据（第 40 跑，craft 隔离探针"用例 C"）：
                //     背包 `{oak_planks: 3}` + 有工作台 → `NO_ITEM «料不够合 wooden_pickaxe»`
                //   `wooden_pickaxe` 配方 = 3 木板 + 2 木棍；而 `stick` 配方是 2 木板 → **产 4 根**。
                //   只要 2 根木棍 → **只需 1 块木板**。→ 总共 3 + 1 = **4 块木板**。
                //   但 `planObtain` 派了 `craft oak_planks c=3` —— **少算 1 块**，
                //   因为 `2 木棍 × 每根 2 木板 = 4 木板`（把"一次产 4 根"当成了"一次产 1 根"）。
                //
                //   折算：合成次数 = ceil(要几个 / 一次产几个)，材料 = 次数 × 每次用量。
                const perCraft = Math.max(1, Number(src.craftedCount) || 1);
                const times = Math.ceil(stillNeed / perCraft);
                for (const [mat, per] of Object.entries(src.recipe ?? {})) {
                    expand(mat, per * times, depth + 1, name, `为了合成 ${name}`);
                    if (hitJobs || hitDepth) return;
                }
                seen.delete(name);
                return;                     // 合成能覆盖就不往后试（04 §6.3）
            }

            if (src.type === 'smelt') {
                plan.push({
                    skill: SOURCE_TO_SKILL.smelt,
                    args: { input: src.ingredient, count: stillNeed },
                    why,
                    depth, parentKey, source: 'smelt',
                });
                if (plan.length >= effCap) { hitJobs = true; return; }
                seen.add(name);
                expand(src.ingredient, stillNeed, depth + 1, name, `为了熔炼 ${name}`);
                seen.delete(name);
                return;
            }

            if (src.type === 'collect') {
                plan.push({
                    skill: SOURCE_TO_SKILL.collect,
                    args: { ore: name, count: stillNeed },
                    why: `${why}（挖 ${src.source}）`,
                    depth, parentKey, source: 'collect', block: src.source,
                });
                if (plan.length >= effCap) { hitJobs = true; }
                return;                     // 采集是终端来源，不再展开
            }

            if (src.type === 'hunt') {
                plan.push({
                    skill: SOURCE_TO_SKILL.hunt,
                    args: { target: src.animal, count: stillNeed },
                    why: `${why}（打 ${src.animal}）`,
                    depth, parentKey, source: 'hunt',
                });
                if (plan.length >= effCap) { hitJobs = true; }
                return;
            }
        }

        // 有来源但一个都出不了单（理论上到不了）→ 记缺口
        if (!plan.some((p) => p.args?.item === name || p.args?.ore === name)) {
            gaps[name] = (gaps[name] ?? 0) + stillNeed;
        }
    };

    expand(item, want, 1, null, `需要 ${want} 个 ${item}`);

    // ★★ 2026-11-03（t65）：**给每个 crafts 步骤补 `dependsOnKeys`** ——
    //   材料必须先做出来，成品才能合（真机第 11 跑：crafting_table 抢在 oak_planks 前面跑 → NO_ITEM）。
    //
    //   做法（旁路后处理，不动 `expand` 的十几处 return）：
    //     key = `<item>#<depth>`（同一物品同层只会出现一次）
    //     对每个 craft 步骤 X： dépend 于"产出 X 的材料"的那些 plan 步骤
    {
        const keyOf = (s) => `${s.args?.item ?? s.args?.ore ?? '?'}#${s.depth ?? 0}`;
        const byKey = new Map();
        for (const s of plan) byKey.set(keyOf(s), s);

        for (const s of plan) {
            if (s.skill !== SOURCE_TO_SKILL.craft) continue;
            const item = s.args?.item;
            const mats = needsOf.get(item) ?? [];
            const deps = [];
            for (const m of mats) {
                // 材料可能被展开在同一层或更深一层；两种都找
                for (let d = (s.depth ?? 1) + 1; d <= (s.depth ?? 1) + 3; d += 1) {
                    const k = `${m}#${d}`;
                    if (byKey.has(k)) { deps.push(k); break; }
                }
            }
            if (deps.length) s.dependsOnKeys = [...new Set(deps)];
        }
    }

    // ★ 不要"下了单就从缺口里扣掉"（2026-11-03 单测抓到的错）：
    //   第一版有这么一段，结果**环形依赖**（A→B→A）的缺口被自己清空了 ——
    //   明明 A 还是弄不到，却报"没缺口"。缺口清单只该装**真的没有可行来源**的东西，
    //   已经交给子单去做的不用出现在缺口里（它们不是缺口，是在办）。

    // ★ 扣共享预算 + 如实上报 hitCap（不许静默截断）
    let hitBudget = false;
    if (budget) {
        budget.used = Number(budget.used ?? 0) + plan.length;
        if (hitJobs) {                       // 本次是被 effCap 截断的
            hitBudget = true;
            budget.hitCap = true;
        }
    }

    return {
        ok: Object.keys(gaps).length === 0 && !hitDepth && !hitJobs,
        plan, gaps,
        expanded: plan.length,
        hitDepth, hitJobs,
        // ★ 预算相关信息（旧路径下恒为 false/null，行为不变）
        hitBudget,
        budget: budget ? { limit: budget.limit, used: budget.used, hitCap: budget.hitCap } : null,
    };
}

/** 策略 manifest（04 §4.1）。codes 只能写已注册的码。 */
export const manifestObtain = {
    name: 'obtain',
    level: 'strat',
    summary: '弄到 N 个某物品：按 箱子>合成>熔炼>采集>交易>打怪 拆子单，做不到就报缺口',
    params: {
        item: 'string',
        count: 'int 1..256 = 1',
    },
    needs: { items: [], near: [] },
    claims: [],
    codes: ['OK', 'NO_ITEM', 'NO_TARGET', 'NO_RECIPE', 'INTERRUPTED', 'INTERNAL', 'TIMEOUT'],
    resumable: false,
    timeoutMs: 10 * 60 * 1000,
};

/**
 * 真正跑一次 strat_obtain：建计划 → 逐张下子单（带 parentId + why）→ 汇总缺口。
 *
 * **只下单，不执行** —— 执行是任务板调度器的事（04 §6.3）。
 *
 * @param {object} agent
 * @param {string} item
 * @param {number} count
 * @param {object} deps { board, inventory, chests, planObtain }
 * @returns {Promise<ActionResult>}
 */
export async function obtain(agent, item, count = 1, deps = {}) {
    if (!item) return fail('NO_TARGET', '没说要弄什么物品');
    if (agent?.bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const board = deps.board ?? agent?.board ?? null;
    const inv = deps.inventory ?? countInventory(agent);

    // ★★ 2026-11-04（t97）：**`chestRows` 全仓无提供方 → 「箱子优先」永久失效。**
    //
    //   control 用 `deps_injection_audit` 扫出来的：
    //     `deps.chestRows` 从来没有调用方提供 → `countChestsFromBoard(undefined)`
    //     → `for (const row of (rows ?? []))` → **静默返回 `{}`**
    //     → 策略以为"一个箱子都不知道" → **每次都得合成/现采**（04 §6.3 的"先看箱子"白写）。
    //
    //   ★ 它和 A 档的那些"死分支"不同：**它没有早退分支，是静默退化成空** ——
    //     所以只按"有 if (!F) 早退"去扫**永远扫不出来**（这是 control 加 C 档的理由）。
    //
    //   修法：在 `obtain()`（async 入口）里**自己把箱子数据取来**。
    //   没有 board 就继续用 `{}`（诚实降级：确实不知道箱子里有什么）。
    let chestRows = deps.chestRows;
    if (chestRows == null && board?.sharedList) {
        try {
            const r = await board.sharedList('chest');
            if (r?.ok) {
                const list = r.data?.items ?? r.data?.rows ?? r.data ?? [];
                chestRows = Array.isArray(list) ? list : [];
            }
        } catch { /* 取不到就当不知道箱子 */ }
    }
    const chests = deps.chests ?? countChestsFromBoard(chestRows);

    const planned = (deps.planObtain ?? planObtain)({
        item, count, inventory: inv, chests,
    });

    if (planned.plan.length === 0) {
        // ★ t51：同上 —— `count` 用**背包真值**，`want` 才是请求数。
        //   "已经够了"这条路上两者相等，但统一口径，别让上层要按路径猜字段含义。
        if (planned.ok) {
            const have = inv?.[item] ?? 0;
            return ok({ item, count: have, want: Number(count), jobs: [], alreadyHave: planned.alreadyHave ?? null });
        }
        return fail('NO_ITEM', `弄不到 ${item}：没有可行来源`, { item, gaps: planned.gaps, jobs: [] });
    }

    // 没有板 → 只能把计划交回去（不执行，也不假装下了单）
    if (!board?.add) {
        // ★★ 2026-11-03（t52）：**这条也缺 `want`，而且 `count` 用了请求数** ——
        //   我上一轮（d09bfee）只修了「已经够了」和「真的下了单」两条 return，
        //   **漏了这条 noBoard 分支** → `want` 仍是 null → `finish()` 规则③
        //   `want <= 0` 成立 → `completed = true` → **仍然假完成**。
        //
        //   实测后果（verify 真 agent 跑出来的，不是我推的）：
        //     10 分钟内堆了 **105 张一模一样的 `obtain:stone_pickaxe`**，
        //     每张 `progress={"count":1,"want":null}` 立刻 done → `jobBusy` 立刻变 false
        //     → 下一拍 idle_planner 再下一张 → **无限循环**。
        //
        //   而 idle_planner 恰恰最常走这条（它下单时 ctx 里的 board.add 不保证可用），
        //   所以**漏这条比漏别的更危险**。
        //
        //   口径与另两条 return 统一：`count` = 背包真值，`want` = 请求数。
        const gotNow = countInventory(agent)[item] ?? 0;
        return ok({
            item, count: gotNow, want: Number(count), jobs: [], plan: planned.plan,
            gaps: planned.gaps, noBoard: true,
            note: '没有任务板：只返回拆单计划，没有真的下单',
        });
    }

    // 父单：一个不干活的壳（06 §9.1 的拆单形态）；子单带 parentId + why
    //
    // ★ 2026-11-03 真机抓到的 bug：原来这里写 `skill: null`，而 `board:add` 的校验
    //   要求 **skill 必须非空且在注册表里** → 父单一律被拒 → `obtain` 恒 INTERNAL、
    //   一张子单都下不出去（真机实测：ok=false code=INTERNAL 子单数=0）。
    //   离线用例没抓到，是因为我用的是**假板**（假板的 add 不校验 skill）。
    //   修法：父单的 skill 写 `obtain`（它本身就是一张 obtain 单，写它是诚实的，
    //   不是凑数）；`kind` 仍是 personal，真正的活都在子单上。
    // ★★ 2026-11-03（t62）：「外壳父单」**只在"我没在跑某张单"时才建**。
    //
    //   真机根因（verify 查库定位，我复核）：
    //     0010（first_night 的子单）**自己的子单数 = 0**，而 0002/0003 这一对更说明问题：
    //       0002 obtain blocked att=3  子单数 0     ← idle 下的那张
    //       0003 obtain blocked        子单数 5     ← 它运行时**又建出来的壳**，子单挂这
    //   也就是说 `strat_obtain` **每次运行都多建一张 obtain 壳**：
    //     外层那张（调度器正在跑的）永远 0 子单 → 被当叶子单重试 → attempts 烧到 3 → blocked
    //     真正干活的壳与子单挂在旁边，外层那张永远"没做成"
    //
    //   正确语义：这张单**自己就是** obtain 单（`ctx.jobId` 有值 = 我正被调度器执行），
    //   子单应当挂**在我名下**，不需要再套一层。只有在"没有 job 上下文"（比如离线直调、
    //   `!do obtain` 直接跑）时才建壳，因为那时确实没有承载子单的单。
    const myJobId = deps.ctx?.jobId ?? null;
    let parentId = myJobId;
    if (!myJobId) {
        const parent = await board.add({
            kind: 'personal', title: `弄到 ${count} 个 ${item}`, skill: 'obtain',
            args: { item, count }, priority: 5, source: 'self',
            assignee: agent?.name ?? null, state: 'running',
        });
        if (!parent?.ok) {
            return fail('INTERNAL', `父单没下进去：${parent?.message ?? ''}`, { item });
        }
        parentId = parent.data?.id ?? parent.data?.job?.id ?? null;
    }

    // ★ t65：先把 key → jobId 建起来，才能把 `dependsOnKeys` 换成**真实 job id**
    //   （任务板的 `dependsOn` 门控认的是 id，不是名字）。
    //   分两遍：第一遍只加不依赖别人的（通常是材料），第二遍加有依赖的 ——
    //   否则可能引用到还没建的 id。
    const keyToId = {};
    const keyOf = (s) => `${s.args?.item ?? s.args?.ore ?? '?'}#${s.depth ?? 0}`;
    const created = [];
    const pending = [];
    for (const step of planned.plan) {
        if (step.dependsOnKeys?.length) { pending.push(step); continue; }
        const r = await board.add({
            kind: 'personal',
            parentId,
            title: `${step.skill} ${JSON.stringify(step.args)}`,
            skill: step.skill,
            args: step.args,
            why: step.why,                       // ★ 06 §4 要求的字段
            priority: 5,
            source: 'self',
            assignee: agent?.name ?? null,
            state: 'ready',
        });
        if (r?.ok) {
            const id = r.data?.id ?? r.data?.job?.id ?? null;
            created.push(id);
            keyToId[keyOf(step)] = id;
        }
    }
    // ★★ 2026-11-04（t75）：**有依赖的子单必须按"深度从深到浅"建**，
    //   否则成品建的时候它的材料还没建出来 → `keyToId[k]` 取不到 → `.filter(Boolean)`
    //   把它悄悄丢掉 → `dependsOn` 变空 → 成品立刻可领 → 缺料 → `NO_ITEM` → **BLOCKED（终态）**。
    //
    //   真机证据（第 22 跑）：
    //     obtain wooden_pickaxe  blocked
    //       └ craft stick c=2        done 4/2
    //       └ craft wooden_pickaxe   blocked «料不够合 wooden_pickaxe»
    //     **它名下只有 craft stick，没有 craft oak_planks** ——
    //     而 `planObtain('wooden_pickaxe')` 实际产出 6 步：
    //       craft wooden_pickaxe d=1  deps=[oak_planks#2, stick#2]
    //       craft oak_planks     d=2  deps=[oak_log#3]
    //       craft stick          d=2  deps=[oak_planks#3]
    //       craft oak_planks     d=3  deps=[oak_log#4]
    //       mine oak_log         d=3 / d=4   （无 deps → 第一遍就建好）
    //     `plan` 的顺序是**成品在前、材料在后**，直接按 plan 顺序建 → 成品的依赖全是 undefined。
    //
    //   修法：按 `depth` **降序**建（材料先、成品后；同深度保持原顺序）。
    //   依赖边永远指向更深的层（deps 的 depth ≥ 自己的 depth+1），所以降序一定够。
    const pendingOrdered = [...pending].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
    for (const step of pendingOrdered) {
        const dependsOn = (step.dependsOnKeys ?? []).map((k) => keyToId[k]).filter(Boolean);
        const r = await board.add({
            kind: 'personal',
            parentId,
            title: `${step.skill} ${JSON.stringify(step.args)}`,
            skill: step.skill,
            args: step.args,
            why: step.why,
            dependsOn: dependsOn.length ? dependsOn : undefined,   // ★ 06 §9.1 工序门控
            priority: 5,
            source: 'self',
            assignee: agent?.name ?? null,
            state: 'ready',
        });
        if (r?.ok) {
            const id = r.data?.id ?? r.data?.job?.id ?? null;
            created.push(id);
            keyToId[keyOf(step)] = id;
        }
    }

    // ★★ 2026-11-03（t51）：**`count` 必须是"实际到手数"，不是"请求数"**。
    //
    //   原来这里写 `count: Number(count)`（= 请求的 8），而调度器 `_progressOf()` 直接读
    //   `data.count` 当进度 → **背包里一个木头都没有，进度却记成 8/8** → 上层以为做完了
    //   → 后续 craft 子单立刻 `NO_ITEM`（真机第一夜链路就是这么断的）。
    //
    //   正确语义（策略层只拆单、不干活）：
    //     count = **当前背包里真的有多少**（真值，通常是 0）
    //     want  = 请求多少
    //     jobs  = 我拆出去的子单（真正的活在那里面）
    //   于是进度显示 `0/8`，上层知道"还没到手"，不会误判完成。
    const gotNow = countInventory(agent)[item] ?? 0;
    return ok({
        item, count: gotNow, want: Number(count), parentId, jobs: created,
        gaps: planned.gaps, hitDepth: planned.hitDepth, hitJobs: planned.hitJobs,
        expanded: planned.expanded,
    });
}

/** 从 bot 背包数一遍（{name:count}）。 */
function countInventory(agent) {
    const out = {};
    try {
        for (const it of (agent?.bot?.inventory?.items?.() ?? [])) {
            if (!it?.name) continue;
            out[it.name] = (out[it.name] ?? 0) + (it.count ?? 0);
        }
    } catch { /* 读不到就当 0 */ }
    return out;
}

/** 从板上的 chest 共享数据数一遍（B4 的 shared 表）。 */
function countChestsFromBoard(rows) {
    const out = {};
    for (const row of (rows ?? [])) {
        const items = row?.value?.items ?? row?.items ?? null;
        if (!items) continue;
        for (const [n, c] of Object.entries(items)) {
            out[n] = (out[n] ?? 0) + (Number(c) || 0);
        }
    }
    return out;
}
