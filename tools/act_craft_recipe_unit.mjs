/**
 * `act_craft.craftOnce` 的「按产出物精确挑 recipe」+「stale 工作台前置阻断」—— 离线守卫（t79）。
 *
 * 为什么要有这个文件（今晚第 43 层，此前**零单测**）：
 *   第 44 跑真机：`craft oak_planks` **产出了 `oak_button`（木按钮）** ——
 *   6 个原木全没了、凭空出来一个按钮。根因两条：
 *     ① `bot.recipesFor(id, …)` 返回的列表里 **`recipes[0]` 不一定是产出目标物品的那条**
 *        （`oak_button` 的配方是「1 木板 → 1 按钮」）→ 修：按 `result.id === wantId` 过滤（`0522ce7`）
 *     ② `bot.craft` 拿 **stale 的 tableBlock** 也会 resolve 且零产出（mineflayer 对第 4 参只做真值判断）
 *        → 修：读到表不在了就**前置阻断**（t113）
 *
 * ★ 用**真实 itemId**（`mcdata('1.21.8')`），不硬编码数字 —— 否则测不出"id 匹配"这件事。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import mcDataFactory from 'minecraft-data';
import { Vec3 } from 'vec3';
import { craftOnce } from '../src/agent/library/act_craft.js';
import { makeFakeBot, assertPointLike } from './fixtures/fake_bot.mjs';

const REG = mcDataFactory('1.21.8');
/** 真 itemId（不要硬编码数字） */
const ID = (name) => REG.itemsByName[name]?.id;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/**
 * 造一个"能合成木板"的假 bot。
 *
 * @param {object} o
 *   recipes     每次 recipesFor 调用返回的配方数组（可以是函数，收 (id, tableArg)）
 *   items       背包（会被 countItem 读到；`craft` 会往里面加产出）
 *   tableAt     若给 `{pos, name}` → blockAt(pos) 返回那个方块（用来造 stale 表）
 *   knownTable  传给 craftOnce 的第 4 参
 *   onCraft     (recipe, limit, table) => void 记录 bot.craft 收到了什么
 */
function craftBot({ recipes, items = [], tableAt = null, knownTable = null, onCraft = null } = {}) {
    const slots = items.map((it, i) => ({ count: 1, slot: i, ...it }));
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: slots,
        registry: { itemsByName: REG.itemsByName, blocksByName: REG.blocksByName },
        world: new Map(),
        unloaded: 'null',
        stubs: {
            recipesFor: (id, _meta, _n, tableArg) => (typeof recipes === 'function' ? recipes(id, tableArg) : recipes),
            craft: async (recipe, limit, table) => {
                onCraft?.({ recipe, limit, table });
                // 真的把产出加进背包（否则 `produced` 恒 0，用例④验不出来）
                const out = REG.itemsByName[recipe?.result ? Object.keys(REG.itemsByName).find((k) => REG.itemsByName[k].id === recipe.result.id) : ''];
                const name = out?.name;
                const cnt = Number(recipe?.result?.count ?? 1) * Math.max(1, Number(limit ?? 1));
                if (name) {
                    const cur = bot.inventory.slots.find((i) => i.name === name);
                    if (cur) cur.count += cnt;
                    else bot.inventory.slots.push({ name, type: recipe.result.id, count: cnt, slot: 40 });
                }
            },
            blockAt: (v, dflt) => {
                // t79：坐标形状守卫（与真 mineflayer 一致）—— 这文件覆盖了 blockAt，
                //   但"读方块的坐标形状"仍属 t70 家族，别让它重新变成裸奔。
                assertPointLike(v);
                if (tableAt && tableAt.pos && v && Math.floor(v.x) === tableAt.pos.x
                    && Math.floor(v.y) === tableAt.pos.y && Math.floor(v.z) === tableAt.pos.z) {
                    return tableAt.name === null ? (typeof dflt === 'function' ? dflt(null) : null) : { name: tableAt.name, position: v };
                }
                return typeof dflt === 'function' ? dflt(null) : null;
            },
        },
    });
    bot.__slots = slots;
    return bot;
}

/** 一条"产出 X"的 recipe 形状（只要 result.id/count + delta 就够 act_craft 用） */
const recipeFor = (name, count = 1) => ({
    result: { id: ID(name), count },
    delta: [],
    requiresTable: false,
});

const PLANK = ID('oak_planks'), BUTTON = ID('oak_button');

// ══════════════════════════════════════════════════════════════════════════
// ① 混入错误 recipe（按钮在前）→ 必须挑"产出木板"的那条
// ══════════════════════════════════════════════════════════════════════════
{
    let seen = null;
    const bot = craftBot({
        items: [{ name: 'oak_log', type: REG.itemsByName.oak_log.id, count: 3, slot: 0 }],
        // ★ 干扰项放**第一位**（这正是第 44 跑的形状）
        recipes: [
            recipeFor('oak_button', 1),
            { ...recipeFor('oak_planks', 4), delta: [{ id: ID('oak_log'), count: -1 }] },
        ],
        onCraft: (x) => { seen = x; },
    });
    const r = await craftOnce(bot, 'oak_planks', 1);
    const gotId = seen?.recipe?.result?.id ?? null;
    check('① 混入错误 recipe（按钮在前）→ bot.craft 收到的是「产出木板」那条',
        r.ok === true && gotId === PLANK,
        `craft 收到 result.id=${gotId}（期望 ${PLANK}=oak_planks；干扰项 ${BUTTON}=oak_button）`);
}

// ══════════════════════════════════════════════════════════════════════════
// ② 一条都不匹配 → NO_RECIPE 且带 gotResults（元素含 id + name）
// ══════════════════════════════════════════════════════════════════════════
{
    const bot = craftBot({
        items: [{ name: 'oak_log', type: REG.itemsByName.oak_log.id, count: 3, slot: 0 }],
        recipes: [recipeFor('oak_button', 1)],      // 只有按钮，没有木板
    });
    const r = await craftOnce(bot, 'oak_planks', 1);
    const gr = r.data?.gotResults;
    const hasShape = Array.isArray(gr) && gr.length > 0
        && gr.every((x) => x && 'id' in x && 'name' in x);
    check('② 一条都不匹配 → NO_RECIPE，且 data.gotResults 非空、元素含 id+name',
        !r.ok && r.code === 'NO_RECIPE' && hasShape,
        `code=${r.code} gotResults=${JSON.stringify(gr)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ stale 工作台 → 前置阻断（NO_WORKSTATION + reason='stale-table-block'）
// ══════════════════════════════════════════════════════════════════════════
{
    // 需要工作台的物品：iron_pickaxe（3×3）。路径：
    //   recipesFor(id,null,1,null) → []        （不用表合不出来）
    //   recipesFor(id,null,1,true) → [配方]    （有表就能合）
    //   recipesFor(id,null,1,tableBlock) → [配方]
    const recipesByArg = (id, tableArg) => {
        if (tableArg === null) return [];                  // 不用表：没有
        return [recipeFor('iron_pickaxe', 1)];             // 有表/有已知表：有
    };
    let crafted = 0;
    const tableBlock = { position: new Vec3(0, 64, 0) };
    const bot = craftBot({
        items: [
            { name: 'iron_ingot', type: ID('iron_ingot'), count: 3, slot: 0 },
            { name: 'stick', type: ID('stick'), count: 2, slot: 1 },
        ],
        recipes: recipesByArg,
        knownTable: tableBlock,
        tableAt: { pos: { x: 0, y: 64, z: 0 }, name: 'air' },   // ★ 表不在了
        onCraft: () => { crafted++; },
    });
    const r = await craftOnce(bot, 'iron_pickaxe', 1, tableBlock);
    check('③ 表位置读到 air（stale）→ 前置阻断：NO_WORKSTATION + reason=stale-table-block',
        !r.ok && r.code === 'NO_WORKSTATION' && r.data?.reason === 'stale-table-block' && crafted === 0,
        `code=${r.code} reason=${r.data?.reason} crafted=${crafted}`);
}

// ── ③-反证：blockAt 返回 null（未加载/假 bot）时**不许阻断**（否则假红）──
{
    const recipesByArg = (id, tableArg) => (tableArg === null ? [] : [recipeFor('iron_pickaxe', 1)]);
    let crafted = 0;
    const tableBlock = { position: new Vec3(0, 64, 0) };
    const bot = craftBot({
        items: [
            { name: 'iron_ingot', type: ID('iron_ingot'), count: 3, slot: 0 },
            { name: 'stick', type: ID('stick'), count: 2, slot: 1 },
        ],
        recipes: recipesByArg,
        knownTable: tableBlock,
        tableAt: { pos: { x: 0, y: 64, z: 0 }, name: null },     // ★ 读不到（null）
        onCraft: () => { crafted++; },
    });
    const r = await craftOnce(bot, 'iron_pickaxe', 1, tableBlock);
    check('③-反证 表那格读不到（null）→ **不阻断**，仍然调 bot.craft（防假红）',
        crafted === 1 && r.code !== 'NO_WORKSTATION',
        `crafted=${crafted} code=${r.code}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 正常路径不受影响（只有正确 recipe → craft 正常调用、produced > 0）
// ══════════════════════════════════════════════════════════════════════════
{
    let seen = null;
    const bot = craftBot({
        items: [{ name: 'oak_log', type: REG.itemsByName.oak_log.id, count: 4, slot: 0 }],
        recipes: [{ ...recipeFor('oak_planks', 4), delta: [{ id: ID('oak_log'), count: -1 }] }],
        onCraft: (x) => { seen = x; },
    });
    const r = await craftOnce(bot, 'oak_planks', 1);
    check('④ 正常路径：只有正确 recipe → bot.craft 被调用且 produced > 0',
        r.ok === true && !!seen && r.data?.produced > 0,
        `produced=${r.data?.produced} 收到 result.id=${seen?.recipe?.result?.id}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
