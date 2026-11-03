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

    // 合成
    try {
        for (const [recipe] of (mc.getItemCraftingRecipes(name) ?? [])) {
            out.push({ type: 'craft', recipe, cost: SOURCE_ORDER.craft });
        }
    } catch { /* ignore */ }

    // 熔炼
    try {
        const ing = mc.getItemSmeltingIngredient(name);
        if (ing) out.push({ type: 'smelt', ingredient: ing, cost: SOURCE_ORDER.smelt });
    } catch { /* ignore */ }

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

    /**
     * 递归展开（**有界**）。
     * @param {string} name 要弄的物品
     * @param {number} need 要几个
     * @param {number} depth 当前层数（根 = 1）
     * @param {string} parentKey 父单的 key（用于 why / parentId 关联）
     * @param {string} why 为什么需要它
     */
    const expand = (name, need, depth, parentKey, why) => {
        if (hitJobs || hitDepth) return;

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
                plan.push({
                    skill: SOURCE_TO_SKILL.craft,
                    args: { item: name, count: stillNeed },
                    why,
                    depth, parentKey, source: 'craft',
                });
                if (plan.length >= effCap) { hitJobs = true; return; }
                // 合成要材料 → 把材料也展开（这才是"需求图"）
                seen.add(name);
                for (const [mat, per] of Object.entries(src.recipe ?? {})) {
                    expand(mat, per * stillNeed, depth + 1, name, `为了合成 ${name}`);
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
    const chests = deps.chests ?? countChestsFromBoard(deps.chestRows);

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
    const parent = await board.add({
        kind: 'personal', title: `弄到 ${count} 个 ${item}`, skill: 'obtain',
        args: { item, count }, priority: 5, source: 'self',
        assignee: agent?.name ?? null, state: 'running',
    });
    if (!parent?.ok) {
        return fail('INTERNAL', `父单没下进去：${parent?.message ?? ''}`, { item });
    }

    const parentId = parent.data?.id ?? parent.data?.job?.id ?? null;
    const created = [];
    for (const step of planned.plan) {
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
        if (r?.ok) created.push(r.data?.id ?? r.data?.job?.id ?? null);
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
