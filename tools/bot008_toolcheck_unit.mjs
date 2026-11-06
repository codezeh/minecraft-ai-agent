/**
 * BOT-008（2026-11-06 深度检查）—— 工具能力预检只看名称，木镐/铲子也被判"能采钻石矿"。
 *
 * 缺陷原貌（`act_dig.canDigReason`）：
 *   原来是「任意 `*_pickaxe` → can:true；认不出就退到**任意** `*_shovel` / `*_axe`」。
 *   报告用真实 minecraft-data / prismarine-block 1.21.8 数据实测：
 *     diamond_ore + wooden_pickaxe → 预检 can:true，真实 canHarvest=false
 *     diamond_ore + diamond_shovel → 预检 can:true，真实 canHarvest=false
 *     diamond_ore + iron_pickaxe   → 两边都是 true（正例）
 *   后果：采集/导航前置放行根本挖不出来的方块 → 白走到跟前，digBlock 才报 NO_TOOL，
 *   上层的"补工具"决策也因此不稳定。
 *
 * 修法：逐件按 `block.canHarvest(item.type)` 真值匹配（= harvestTools 权威判据），
 *       保留"磨秃的工具不算"，**去掉铲/斧无条件后备**。
 *
 * 本文件用**真实方块/物品数据**断言（不连服务器、不读世界）：
 *   ① 木镐 / 钻石铲 对钻石矿必须 can:false（修复前是 true ← 必失败点）
 *   ② 同档或更高的镐仍是 true（正例不能误伤）
 *   ③ 铲/斧不得替代镐（石头/铁矿/黑曜石逐档核对）
 *   ④ 徒手可挖的方块（木头/泥土）不受影响
 *   ⑤ 耐久边缘：只剩 2 点耐久的镐不算"有工具"，剩 3 点算
 *   ⑥ 多把工具：第一把磨秃、第二把能用 → 仍然 can:true（上一轮的修复不许回退）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcData = require('minecraft-data')('1.21.8');
const Block = require('prismarine-block')('1.21.8');
const { canDigReason, canDigWithInventory } = await import('../src/agent/library/act_dig.js');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/** 真实方块对象（带真实的 harvestTools 与 canHarvest）。 */
const blockOf = (name) => Block.fromStateId(mcData.blocksByName[name].minStateId, 0);

/** 一件真实物品（type = minecraft-data 的数字 id）。 */
function item(name, { durabilityUsed = 0, maxDurability = 250, count = 1 } = {}) {
    const def = mcData.itemsByName[name];
    return { name, type: def.id, count, slot: 0, maxDurability, durabilityUsed };
}

/** 只实现 canDigReason 会碰到的接口。 */
function botWith(items, { health = 20 } = {}) {
    return {
        health,
        inventory: { items: () => items },
        registry: { itemsByName: mcData.itemsByName },
    };
}

// ── ① 报告复现：钻石矿 + 木镐 / 钻石铲 → 必须 can:false ────────────────
{
    const ore = blockOf('diamond_ore');
    const wooden = item('wooden_pickaxe');
    const shovel = item('diamond_shovel');
    // 先证明数据前提（真实 canHarvest 就是 false，不是我们编的）
    check('① 数据前提：diamond_ore 的 harvestTools 不含木镐/铲',
        !ore.canHarvest(wooden.type) && !ore.canHarvest(shovel.type),
        `ht=${JSON.stringify(ore.harvestTools)}`);

    const rWood = canDigReason(botWith([wooden]), ore);
    check('① 木镐对钻石矿：预检必须 can:false（修复前误判 true）',
        rWood.can === false, `can=${rWood.can} why=${rWood.why}`);
    check('① 木镐对钻石矿：三态给 no-tool（背包读得到、真没合适工具）',
        rWood.why === 'no-tool', `why=${rWood.why}`);

    const rShovel = canDigReason(botWith([shovel]), ore);
    check('① 钻石铲对钻石矿：can:false（铲不再无条件后备）',
        rShovel.can === false, `can=${rShovel.can} why=${rShovel.why}`);

    // canDigWithInventory 是同一判据的布尔壳，必须一致
    check('① canDigWithInventory 与 canDigReason 一致',
        canDigWithInventory(botWith([wooden]), ore) === false
        && canDigWithInventory(botWith([shovel]), ore) === false);
}

// ── ② 正例：铁镐对钻石矿仍是 true ─────────────────────────────────────
{
    const ore = blockOf('diamond_ore');
    const iron = item('iron_pickaxe');
    const r = canDigReason(botWith([iron]), ore);
    check('② 铁镐对钻石矿 → ok（正例不能误伤）', r.can === true && r.why === 'ok', `can=${r.can}`);
    check('② 真实 canHarvest 也是 true（判据与引擎一致）', ore.canHarvest(iron.type) === true);
}

// ── ③ 逐档核对：铲/斧不得替代镐 ───────────────────────────────────────
{
    const cases = [
        // [方块, 工具, 期望 can]
        ['stone', 'wooden_pickaxe', true],
        ['stone', 'iron_axe', false],
        ['iron_ore', 'wooden_pickaxe', false],
        ['iron_ore', 'stone_pickaxe', true],
        ['obsidian', 'iron_pickaxe', false],
        ['obsidian', 'diamond_pickaxe', true],
        ['obsidian', 'diamond_shovel', false],
    ];
    for (const [blockName, toolName, want] of cases) {
        const b = blockOf(blockName);
        const it = item(toolName);
        const realCan = !!b.canHarvest(it.type);
        const judged = canDigReason(botWith([it]), b);
        check(`③ ${toolName} 对 ${blockName} → ${want ? 'ok' : 'no-tool'}`,
            judged.can === want,
            `judged=${judged.can} real=${realCan} why=${judged.why}`);
        check(`③ ${toolName}/${blockName}：预检与真实 canHarvest 一致`,
            judged.can === realCan, `judged=${judged.can} real=${realCan}`);
    }
}

// ── ④ 徒手可挖：不受影响 ──────────────────────────────────────────────
{
    for (const name of ['oak_log', 'dirt']) {
        const b = blockOf(name);
        const r = canDigReason(botWith([]), b);
        check(`④ 空背包也能挖 ${name}（徒手，与工具无关）`, r.can === true && r.why === 'ok', `why=${r.why}`);
    }
}

// ── ⑤ 耐久边缘：剩 2 点不算有工具，剩 3 点算 ───────────────────────────
{
    const ore = blockOf('diamond_ore');
    const nearlyBroken = item('diamond_pickaxe', { durabilityUsed: 248 });   // 剩 2
    const usable = item('diamond_pickaxe', { durabilityUsed: 247 });         // 剩 3
    const rBad = canDigReason(botWith([nearlyBroken]), ore);
    const rOk = canDigReason(botWith([usable]), ore);
    check('⑤ 只剩 2 点耐久的钻石镐 → no-tool（快坏了不算有工具）',
        rBad.can === false && rBad.why === 'no-tool', `can=${rBad.can} why=${rBad.why}`);
    check('⑤ 剩 3 点耐久的钻石镐 → ok（不误杀）', rOk.can === true, `can=${rOk.can}`);
}

// ── ⑥ 多把工具：第一把磨秃、第二把能用 → 仍然 can:true ─────────────────
{
    const ore = blockOf('diamond_ore');
    const worn = item('diamond_pickaxe', { durabilityUsed: 250 });
    const fresh = item('iron_pickaxe', { durabilityUsed: 0 });
    const r = canDigReason(botWith([worn, fresh]), ore);
    check('⑥ 第一把磨秃 + 第二把铁镐能用 → ok（"只看第一把"的修复不回退）',
        r.can === true, `can=${r.can} why=${r.why}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
