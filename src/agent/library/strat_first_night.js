/**
 * 策略：第一夜活下来（M10，04 §6.3 `strat_first_night`）。
 *
 * 04 §6.3 原文：
 *   > `strat_first_night` — 第一夜：撸木头 → 工作台 + 木镐 → 石器 →
 *   > `flow_shelter` 或 `flow_sleep` → 吃饱
 *
 * ★ 策略的本质（04 §6.3）：**不自己做动作，只拆子单、等子单结果。**
 *   所以本文件**一行身体操作都没有**（无 holdKey / digBlock / placeBlockAt / setControlState），
 *   它只做：判断哪些步骤"已经满足"→ 跳掉 → 剩下的拆成带 `parentId`/`why`/`dependsOn` 的子单。
 *   源码级用例盯着这条（`tools/strat_first_night_unit.mjs` 的第 6 条）。
 *
 * ── 策略和"照单执行"的区别（04 §6.3 的核心价值）────────────────────────
 *   **已经满足的步骤要跳过。** 手上已有石镐 → 前面撸木头/工作台/木镐/石镐全跳过；
 *   天还亮着 → 不急着 shelter。判据见 `planFirstNight()` 的 `skip` 分支，
 *   每条都写明"为什么跳过"（`why` 里带 skip 原因，便于上层/用户看懂）。
 *
 * ── 天黑判定必须可注入 ───────────────────────────────────────────
 *   `bot.time.timeOfDay` 是 0–24000 的 Minecraft 时间，夜 ≈ 13000–23000。
 *   真机若只能等天黑，测试就没法做 → 所以 `timeOfDay` 从参数注入，
 *   离线用例可以随便设成 1000（白天）/ 14000（夜里）。
 *   （和 `idle_planner.THINK_EVERY_MS` 可注入是同一个原则。）
 */

import { ok, fail } from './contract.js';
// ★ t39：天黑判据的真身已挪到查询层（`query_perceive.NIGHT / isNightFalling`）。
//   原因：`board_scheduler` 的空闲第 1 层也要用；分层规矩不准 board → strat，
//   但 strat → query 合法 → 放 query 才能"只有一份实现"且两边都能用。
import { NIGHT, isNightFalling } from './query_perceive.js';

/** 04 §6.3 的起步值（全部具名，不散魔数）。 */
export const FIRST_NIGHT = Object.freeze({
    NIGHT_START: NIGHT.START,   // MC 时间：入夜（真身在 query_perceive.NIGHT）
    NIGHT_END: NIGHT.END,       // MC 时间：天亮前
    DUSK_LEAD: NIGHT.DUSK_LEAD, // 提前量：12000 起就该准备遮蔽了
    WOOD_TARGET: 8,          // 够做 工作台(4木板) + 木镐(3木板+2棍) + 余量
    FOOD_MIN: 6,             // 食物少于这个数就吃/补
    // ★★ 为什么需要这道全局闸（2026-11-03 用户要求写明）：
    //   `strat_obtain` 的闸（MAX_DEPTH=6 / MAX_JOBS=30）是 **per-call 的** ——
    //   `plan`/`hitDepth`/`hitJobs`/`seen` 全是 `planObtain` 的**局部变量**，
    //   每次调用各自算一份，**不存在跨调用的共享预算**。
    //   所以本策略里 4 个 `obtain` 步骤理论上可各展开 30 张 = **120 张子单**。
    //   台账已记：**任何"调多次 obtain"的策略都必须自己加全局总闸**，
    //   `strat_obtain` 不提供（也不该它提供 —— 那需要跨调用共享状态，是设计变更）。
    // ★ 2026-11-03（A2）：这个数现在是**没有 ctx 时的兜底默认**。
    //   走正常路径时，上限来自 `manifest.jobBudget: 12` → `ctx.jobBudget.limit`，
    //   和 `strat_obtain` **共享同一份预算**（跨调用真的共享）。
    //   两个数是同一个值（12），这是刻意的——改机制不该改行为。
    MAX_TOTAL_JOBS: 12,
});

/**
 * 现在是不是"该准备过夜了"（纯函数，`t` 可注入）。
 *
 * ★ t39：**真身在 `query_perceive.js`**，这里只 re-export（对外 API 不变，
 *   `strat_first_night_unit` 等既有调用方照旧从这里取）。为什么搬走见那边的注释：
 *   board_scheduler 也要用，而 board → strat 属于违规 import（board → query 合法）。
 */
export { isNightFalling };

/** 现在是不是已经入夜（更严格的判据，用于"必须进屋了"）。 */
export function isNight(t) {
    const n = Number(t);
    if (!Number.isFinite(n)) return false;
    return n >= FIRST_NIGHT.NIGHT_START && n <= FIRST_NIGHT.NIGHT_END;
}

/** 工具档位：'wooden'|'stone'|'iron' → 数字，没有 = 0。 */
const TIER_RANK = { wooden: 1, stone: 2, iron: 3 };
function bestToolRank(inv, kind) {
    let best = 0;
    for (const name of Object.keys(inv ?? {})) {
        if (Number(inv[name] ?? 0) <= 0) continue;
        const m = name.match(/^(wooden|stone|iron)_(pickaxe|axe|sword)$/);
        if (!m || m[2] !== kind) continue;
        best = Math.max(best, TIER_RANK[m[1]] ?? 0);
    }
    return best;
}

/**
 * ★ 核心：算出第一夜要做哪些**步骤**（纯函数，不动身体、不下单）。
 *
 * 每一步要么被 `skip`（已满足/不需要），要么产出一个 step 描述。
 *
 * @param {object} s
 *   inventory     {name:count}                  手上有什么
 *   timeOfDay     MC 时间（可注入）
 *   hasShelter    附近已有能待的地方
 *   hasBed        有床（决定 shelter 还是 sleep）
 *   foodCount     身上食物数
 *   placedTable   附近有没有工作台
 *   maxJobs       全局子单上限（默认 FIRST_NIGHT.MAX_TOTAL_JOBS）
 * @returns {{steps:Array, skipped:Array, hitJobCap:boolean}}
 */
export function planFirstNight(s = {}) {
    const inv = s.inventory ?? {};
    const t = Number(s.timeOfDay ?? 0);
    // ★ 优先用共享预算的**余额**（有 ctx 时）；否则用自己的兜底默认（旧路径，行为不变）
    const budget = s.jobBudget ?? null;
    const maxJobs = Math.max(1, Math.floor(Number(
        s.maxJobs
        ?? (budget ? Math.max(0, Number(budget.limit ?? 0) - Number(budget.used ?? 0)) : FIRST_NIGHT.MAX_TOTAL_JOBS),
    )));

    const steps = [];
    const skipped = [];
    const have = (n) => Number(inv[n] ?? 0) > 0;
    const count = (n) => Number(inv[n] ?? 0);

    const pickaxeRank = bestToolRank(inv, 'pickaxe');
    const stoneDone = pickaxeRank >= TIER_RANK.stone;      // 已经有石镐或更好
    const woodenDone = pickaxeRank >= TIER_RANK.wooden;     // 至少有木镐

    /** 加一步；带 why 与依赖（dependsOn 用"步骤 key"引用，落单时换成真实 job id）。 */
    const add = (key, skill, args, why, dependsOnKeys = []) => {
        steps.push({ key, skill, args, why, dependsOnKeys, priority: 1 });
    };

    // ── 1) 撸木头 ────────────────────────────────────────────────────
    // 已经有石镐 → 根本不需要木头（跳）；已有木镐且木头够 → 跳
    if (stoneDone) {
        skipped.push({ key: 'wood', why: '已有石镐或更好（前面全不需要）' });
    } else if (woodenDone && count('oak_log') >= 2) {
        skipped.push({ key: 'wood', why: '已有木镐且木头够用' });
    } else if (count('oak_log') >= FIRST_NIGHT.WOOD_TARGET) {
        skipped.push({ key: 'wood', why: `已有 ${count('oak_log')} 个木头` });
    } else {
        add('wood', 'obtain', { item: 'oak_log', count: FIRST_NIGHT.WOOD_TARGET },
            '第一夜要先有木头才能做工作台和木镐');
    }

    // ── 2) 工作台 ────────────────────────────────────────────────────
    if (stoneDone) {
        skipped.push({ key: 'table', why: '已有石镐或更好' });
    } else if (s.placedTable) {
        skipped.push({ key: 'table', why: '附近已经有工作台' });
    } else if (count('crafting_table') > 0) {
        skipped.push({ key: 'table', why: '背包里已有工作台（不需要合成）' });
    } else {
        add('table', 'craft', { item: 'crafting_table', count: 1 },
            '木镐要在工作台上做', ['wood']);
    }

    // ── 3) 木镐 ──────────────────────────────────────────────────────
    if (stoneDone) {
        skipped.push({ key: 'wooden_pickaxe', why: '已有石镐或更好' });
    } else if (woodenDone) {
        skipped.push({ key: 'wooden_pickaxe', why: '已经有木镐' });
    } else {
        add('wooden_pickaxe', 'craft', { item: 'wooden_pickaxe', count: 1 },
            '要先有木镐才能挖石头', ['table']);
    }

    // ── 4) 石镐 ──────────────────────────────────────────────────────
    if (stoneDone) {
        skipped.push({ key: 'stone_pickaxe', why: '已经有石镐或更好' });
    } else {
        add('stone_pickaxe', 'craft', { item: 'stone_pickaxe', count: 1 },
            '石镐是第一夜的核心工具（挖石头/挡怪）', ['wooden_pickaxe']);
    }

    // ── 5) 天黑前找地方待：shelter 或 sleep ──────────────────────────
    const night = isNightFalling(t);
    if (!night) {
        skipped.push({ key: 'shelter', why: `天还亮着（timeOfDay=${t}），不急着遮蔽` });
    } else if (s.hasShelter) {
        skipped.push({ key: 'shelter', why: '附近已经有能待的地方' });
    } else if (s.hasBed) {
        // 有床就睡，不搭屋子（04 §6.3：「flow_shelter **或** flow_sleep」）
        add('sleep', 'sleep', {}, '有床，直接睡过去（比搭屋子省事）');
    } else {
        add('shelter', 'shelter', {}, '快天黑了且没有床，要搭个遮蔽');
    }

    // ── 6) 吃饱 ──────────────────────────────────────────────────────
    const food = Number(s.foodCount ?? count('bread') + count('cooked_beef') + count('apple'));
    if (food >= FIRST_NIGHT.FOOD_MIN) {
        skipped.push({ key: 'eat', why: `食物够（${food} ≥ ${FIRST_NIGHT.FOOD_MIN}）` });
    } else {
        add('eat', 'eat', { food: 'auto' }, '空着肚子过夜会掉血');
    }

    // ★ 全局闸：本策略自己的子单总数上限
    //   （为什么需要：`planObtain` 的 6 层/30 张闸是**每次调用各自算**的，
    //     4 个 obtain 步骤各自最多 30 张 → 理论上 120 张。这里统一收紧。）
    let hitJobCap = false;
    let out = steps;
    if (out.length > maxJobs) {
        out = out.slice(0, maxJobs);
        hitJobCap = true;
    }

    return { steps: out, skipped, hitJobCap };
}

/** manifest（04 §4.1）。codes 只能写已注册的码。 */
export const manifest = {
    name: 'first_night',
    level: 'strat',
    summary: '第一夜：木头→工作台→木镐→石镐→遮蔽/睡→吃饱（已满足的步骤自动跳过）',
    params: {
        maxJobs: 'int 1..40 = 12',
    },
    needs: { items: [], near: [] },
    claims: [],
    codes: ['OK', 'NO_ITEM', 'NO_TARGET', 'NO_RECIPE', 'NO_WORKSTATION', 'INTERRUPTED', 'INTERNAL', 'TIMEOUT'],
    resumable: false,
    timeoutMs: 20 * 60 * 1000,
    // ★ 2026-11-03（A2）：声明本策略要多少子单预算。
    //   由 `makeCtx` 变成 `ctx.jobBudget.limit`，`strat_obtain` 拆单时从共享预算里扣。
    //   值仍是 12（与改造前 `MAX_TOTAL_JOBS` 一致 —— 不能因为改了机制就变数）。
    jobBudget: 12,
};

/**
 * 跑一次 `strat_first_night`：算步骤 → 逐张下子单（带 parentId + why + dependsOn）。
 *
 * **只下单，不执行** —— 执行是任务板调度器的事（04 §6.3）。
 *
 * @param {object} agent
 * @param {object} deps { board, inventory, timeOfDay, hasShelter, hasBed, foodCount, placedTable }
 * @returns {Promise<ActionResult>}
 */
export async function firstNight(agent, deps = {}) {
    if (agent?.bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const board = deps.board ?? agent?.board ?? null;
    const inv = deps.inventory ?? countInventory(agent);
    const timeOfDay = deps.timeOfDay ?? agent?.bot?.time?.timeOfDay ?? 0;

    // ★ 2026-11-03（A2）：从 ctx 取共享预算（不再自己数）
    const budget = deps.ctx?.jobBudget ?? deps.jobBudget ?? null;

    const planned = planFirstNight({
        inventory: inv,
        timeOfDay,
        hasShelter: deps.hasShelter,
        hasBed: deps.hasBed,
        foodCount: deps.foodCount,
        placedTable: deps.placedTable,
        maxJobs: deps.maxJobs,
        jobBudget: budget,
    });

    // 全都被跳过了 → 直接 ok（这就是"策略"该有的样子：什么都不用做）
    if (planned.steps.length === 0) {
        return ok({
            steps: [], skipped: planned.skipped, timeOfDay,
            note: '第一夜要做的事都已经满足了，不用下任何单',
        });
    }

    // 没有板：只把计划交回去（不假装下了单）
    if (!board?.add) {
        return ok({
            steps: planned.steps, skipped: planned.skipped, timeOfDay, noBoard: true,
            note: '没有任务板：只返回拆单计划，没有真的下单',
        });
    }

    // 父单：它本身就是一张 first_night 单（skill 必须非空且在注册表里）
    const parent = await board.add({
        kind: 'personal', title: '第一夜生存', skill: 'first_night',
        args: { maxJobs: deps.maxJobs ?? FIRST_NIGHT.MAX_TOTAL_JOBS },
        why: '天黑前要能安全过夜',
        priority: 5, source: 'self',
        assignee: agent?.name ?? null, state: 'running',
    });
    if (!parent?.ok) {
        return fail('INTERNAL', `父单没下进去：${parent?.message ?? ''}`, {});
    }
    const parentId = parent.data?.id ?? parent.data?.job?.id ?? null;

    // 子单：先把 key → jobId 的映射建起来，才能把 dependsOnKeys 换成真实 id
    const keyToId = {};
    const created = [];
    for (const step of planned.steps) {
        const dependsOn = (step.dependsOnKeys ?? [])
            .map((k) => keyToId[k])
            .filter(Boolean);

        const r = await board.add({
            kind: 'personal',
            parentId,
            title: `${step.skill} ${JSON.stringify(step.args)}`,
            skill: step.skill,
            args: step.args,
            why: step.why,                              // ★ 06 §4
            dependsOn: dependsOn.length ? dependsOn : undefined,   // ★ 06 §9.1 工序门控
            priority: 1,                                // ★ 自己找的单 0–2
            source: 'self',
            assignee: agent?.name ?? null,
            state: 'ready',
        });
        if (r?.ok) {
            const id = r.data?.id ?? r.data?.job?.id ?? null;
            keyToId[step.key] = id;
            created.push({ key: step.key, id, skill: step.skill, why: step.why, dependsOn });
        }
    }

    // ★ 扣共享预算 + 如实上报（不许静默截断）
    let hitBudget = false;
    if (budget) {
        budget.used = Number(budget.used ?? 0) + created.length;
        if (planned.hitJobCap) { hitBudget = true; budget.hitCap = true; }
    }

    return ok({
        parentId, jobs: created.map((c) => c.id),
        steps: created, skipped: planned.skipped,
        timeOfDay, hitJobCap: planned.hitJobCap,
        hitBudget,
        budget: budget ? { limit: budget.limit, used: budget.used, hitCap: budget.hitCap } : null,
    });
}

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
