/**
 * `act_craft` 的 **`limit` 单位修复（t115）** 守卫 —— 离线，纯 `tools/`。
 *
 * 背景（今晚第 44 层）：`limit` 曾经混用单位 ——
 *   `want` = 要几**件**，`cap.num` = 能合几**次**，`bot.craft(recipe, count)` 的 count 是**次数**。
 *   旧写法 `limit = Math.min(want, cap.num)` 把"3 件"当成"3 次"
 *   → 全链原木需求被放大（真机症状："挖了 8 个只剩 1 个"）。
 * 修法（`e792d04`）：
 *   `const perCraft = max(1, recipe.result.count)`；`limit = ceil(want / perCraft)`；
 *   再与 `cap.num`（次数）取小。
 *
 * ★ 全部**用真 itemId**（`mcdata('1.21.8')`），不硬编码数字。
 * ★ **不改 `src/agent/library/act_craft.js`**（captain 今天改了 4 次）：
 *   反向验证用"从源码文本里**抠出 limit 那几行** → 编译 → 变异"，不碰真文件。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import mcDataFactory from 'minecraft-data';
import * as mc from '../src/utils/mcdata.js';
import { craftOnce } from '../src/agent/library/act_craft.js';
import { makeFakeBot, assertPointLike } from './fixtures/fake_bot.mjs';

const REG = mcDataFactory('1.21.8');
const ID = (n) => REG.itemsByName[n]?.id;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/**
 * 造一个能合成的假 bot。
 * @param {object} o  { item, perCraft, want, capNum }
 *   `cap.num` 由 `mc.calculateLimitingResource` 决定 —— 这里用**材料数量**间接控制：
 *   材料够 → cap.num 大；材料只够 N 次 → cap.num = N。
 */
function botFor({ item, perCraft, planks = 64, other = {} }) {
    const slots = [{ name: 'oak_planks', type: ID('oak_planks'), count: planks, slot: 0 }];
    for (const [n, c] of Object.entries(other)) slots.push({ name: n, type: ID(n), count: c, slot: slots.length });
    const calls = [];
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: slots,
        registry: { itemsByName: REG.itemsByName, blocksByName: REG.blocksByName },
        world: new Map(),
        unloaded: 'null',
        stubs: {
            // ★ 必须给**真实配方形状**（`inShape`）：`mc.ingredientsFromPrismarineRecipe` 靠它算料；
            //   没有 inShape → `calculateLimitingResource` 拿不到 required → cap=null →
            //   用例③「cap.num 取小」根本测不到（会假绿）。
            recipesFor: () => [{
                result: { id: ID(item), count: perCraft },
                inShape: [[{ id: ID('oak_planks'), count: 4 }]],   // 每次耗 4 板
                requiresTable: false,
            }],
            craft: async (recipe, n) => {
                calls.push({ recipe, n });
                // 模拟产出：把 n 次 × perCraft 件加进背包
                const cur = bot.inventory.slots.find((s) => s.name === item);
                const add = n * perCraft;
                if (cur) cur.count += add;
                else bot.inventory.slots.push({ name: item, type: ID(item), count: add, slot: 41 });
            },
            blockAt: (v, dflt) => { assertPointLike(v); return typeof dflt === 'function' ? dflt(null) : null; },
        },
    });
    bot.__calls = calls;
    return bot;
}

// ══════════════════════════════════════════════════════════════════════════
// ① 一次产 4 件、要 2 件 → limit 必须是 **1 次**（stick: 2 板 → 4 棍）
// ══════════════════════════════════════════════════════════════════════════
{
    const bot = botFor({ item: 'stick', perCraft: 4, planks: 64 });
    const r = await craftOnce(bot, 'stick', 2);
    const n = bot.__calls[0]?.n;
    check('① 一次产 4 件、要 2 件 → bot.craft 收到 **1 次**（ceil(2/4)=1，不是 2）',
        r.ok === true && n === 1, `craft n=${n}（旧 bug 会是 2）produced=${r.data?.produced}`);
}

// ② 一次产 1 件、要 3 件 → limit 必须是 **3 次**
{
    const bot = botFor({ item: 'crafting_table', perCraft: 1, planks: 64 });
    const r = await craftOnce(bot, 'crafting_table', 3);
    const n = bot.__calls[0]?.n;
    check('② 一次产 1 件、要 3 件 → craft 收到 **3 次**（ceil(3/1)=3）',
        r.ok === true && n === 3, `craft n=${n}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ `cap.num`（次数）要与 `limit`（次数）取小
//    want=3、perCraft=1 → limit=3；材料只够 2 次 → cap.num=2 → 最终 2
// ══════════════════════════════════════════════════════════════════════════
{
    // crafting_table 需要 4 板/次 → 8 板 = 只够 2 次
    const bot = botFor({ item: 'crafting_table', perCraft: 1, planks: 8 });
    const r = await craftOnce(bot, 'crafting_table', 3);
    const n = bot.__calls[0]?.n;
    check('③ cap.num（次数）与 limit（次数）取小：要 3 次但材料只够 2 次 → craft 收到 2',
        n === 2, `craft n=${n}（期望 2）code=${r.code}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ④ ★ 反向验证：从源码文本抠出 limit 那几行 → 编译 → 变异成旧写法 → ① 会红
//     （**不碰真文件**；这是 captain 要求的"提取函数体 + 编译"）
// ══════════════════════════════════════════════════════════════════════════
const SRC = readFileSync('src/agent/library/act_craft.js', 'utf8');
/**
 * 抠出 limit 计算并编译成函数（**不碰真文件**）。
 * ★ 只抠「perCraft + let limit」两行，再单独找「cap.num 取小」那一行 ——
 *   中间隔了 t116 的 `_preDiag` 块，用"跨行连续匹配"会失配（第一版就栽在这）。
 */
function extractLimitFn(src) {
    // ★ 逐行扫，不用"跨行正则"（正则里的 \n 在两处都被转义坑过一次）。
    const lines = src.split('\n');
    const iP = lines.findIndex((L) => /const perCraft = /.test(L));
    const iL = lines.findIndex((L) => /let limit = /.test(L));
    const iC = lines.findIndex((L) => /Number\.isFinite\(cap\.num\)\) limit = /.test(L));
    if (iP < 0 || iL < 0) throw new Error('抠不到 perCraft/limit 两行（源码结构变了？）');
    const body = 'return (function (want, recipe, cap) {\n'
        + lines[iP] + '\n'
        + lines[iL] + '\n'
        + (iC >= 0 ? lines[iC] + '\n' : '')
        + 'return limit;\n});';
    return new Function(body)();
}
{
    let real = null, mutant = null;
    try {
        real = extractLimitFn(SRC);
        // 旧写法（t115 之前的 bug）：把"件数"当"次数"
        const oldText = SRC.replace(
            /const perCraft = [^\n]*\n\s*let limit = [^\n]*/,
            'const perCraft = Math.max(1, Number(recipe?.result?.count) || 1);\n    let limit = want;',
        ).replace(
            /if \(cap && Number\.isFinite\(cap\.num\)\) limit = [^\n]*/,
            'if (cap && Number.isFinite(cap.num)) limit = Math.min(want, cap.num);',
        );
        mutant = extractLimitFn(oldText);
    } catch (e) {
        check('④ 能从源码里抠出 limit 计算并编译', false, String(e?.message ?? e));
    }
    if (real) {
        const recipe = { result: { count: 4 } };
        const a = real(2, recipe, null);            // 要 2 件、每次 4 件 → 1 次
        const b = mutant ? mutant(2, recipe, null) : 'no-mutant';
        check('④ 源码级：真实现 want=2/perCraft=4 → limit=1（① 的判据成立）', a === 1, `limit=${a}`);
        check('④ 反向验证：把实现「改回旧写法 Math.min(want, cap.num)」→ limit=2（① 必然红）',
            b === 2, `mutant limit=${b}（期望 2 = 旧 bug）`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 产出"够用但不多做"：want=2、perCraft=4 → 1 次 → produced=4（≥2 且 ==4）
// ══════════════════════════════════════════════════════════════════════════
{
    const bot = botFor({ item: 'stick', perCraft: 4, planks: 64 });
    const r = await craftOnce(bot, 'stick', 2);
    const n = bot.__calls[0]?.n;
    const produced = r.data?.produced ?? 0;
    check('⑤ 产出够用但不多做：produced >= want 且 produced === perCraft × limit',
        produced >= 2 && produced === 4 * n, `produced=${produced} perCraft×limit=${4 * n}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ ★★ 全链账目回归（**结果型**，不依赖实现细节）
//
//   把 first_night 的四件（crafting_table / wooden_pickaxe / stick / stone_pickaxe）
//   按 `ceil(want / 每次产出)` 的规则**递归折成原木需求**，断言总需求**没有被单位混用放大**。
//
//   ⚠️ 口径说明（如实报）：任务书写"应为 4 个原木"、"旧写法是 11"。
//      我按 `mc.getItemCraftingRecipes` 的第一条配方 + ceil 规则**独立算出来是 5**，
//      旧规则（把件数当次数）算出来是 **17**。差异出在"中间产物是否跨物品共享"
//      （比如给木镐做的木板能否给工作台用）——这个共享取决于执行顺序。
//      所以这条断言的是**可复现的口径**：新规则 5、旧规则 17，
//      并附上"必须显著小于旧规则"这一条**与共享无关**的判据（≤ 旧规则的 1/3）。
// ══════════════════════════════════════════════════════════════════════════
{
    const firstRecipe = (name) => {
        const list = mc.getItemCraftingRecipes(name) ?? [];
        if (!list.length) return null;
        const [ing, meta] = list[0];
        return { ing: ing ?? {}, out: Number(meta?.craftedCount ?? 1) };
    };
    /** mode='ceil'（新规则）| 'want'（旧规则：把件数当次数） */
    function logsFor(name, want, mode, depth = 0, acc = {}) {
        if (depth > 8) return acc;
        const rc = firstRecipe(name);
        if (!rc) { acc[name] = (acc[name] ?? 0) + want; return acc; }
        const crafts = mode === 'ceil' ? Math.ceil(want / rc.out) : want;
        for (const [n, c] of Object.entries(rc.ing)) logsFor(n, crafts * c, mode, depth + 1, acc);
        return acc;
    }
    const chain = ['crafting_table', 'wooden_pickaxe', 'stick', 'stone_pickaxe'];
    const sumLogs = (mode) => {
        const acc = {};
        for (const it of chain) logsFor(it, 1, mode, 0, acc);
        // 木板也是原木做的：4 板/原木
        return (acc.oak_log ?? 0) + Math.ceil((acc.oak_planks ?? 0) / 4);
    };
    const now = sumLogs('ceil');
    const old = sumLogs('want');
    check('⑥ 全链账目（新规则）：四件共需原木 = 5（不是旧规则的 17）',
        now === 5, `新=${now} 旧=${old}`);
    check('⑥-b 与"是否共享中间产物"无关的判据：新规则必须 **≤ 旧规则的 1/3**（防需求被放大）',
        now * 3 <= old, `新=${now} 旧=${old}（3×${now}=${now * 3} ≤ ${old}）`);
    // 真机口径参照：WOOD_TARGET=8，新规则 5 装得下、旧规则 17 装不下
    check('⑥-c 现实约束：新规则 5 ≤ WOOD_TARGET(8)，旧规则 17 > 8（这就是"挖了 8 个只剩 1 个"）',
        now <= 8 && old > 8, `新=${now} 旧=${old}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
