/**
 * t21 回归：`flow_mine` 的 NO_TOOL 假失败 + 三态判据（离线，假 bot）。
 *
 * 真机根因（2026-11-02）：
 *   造场地时把她 entomb 在方块里 → 窒息死亡 → 服务端清空背包 →
 *   `bot.inventory.items()` 返回 `[]` → 旧 `canDigWithInventory` 只有 true/false
 *   → 报 `NO_TOOL` → 任务板按规则②判 **blocked（终态）**。
 *   但那是"刚死、背包正在重建"，**下一秒重试就好了**。
 *
 * 本文件锁三件事：
 *   ① **只有一把全新镐、挖掉 1 块之后**仍然能继续挖（不许第 2 块起报没工具）
 *   ② **背包读不到**（inventory 缺失 / 技能抛错 / 血量 0）→ 三态给 `unreadable`，
 *      `flow_mine` 必须报 **NOT_READY（可重试）** 而**不是** NO_TOOL（因为 NO_TOOL 会被判 blocked）
 *   ③ **真的没工具**（背包读得到且空）→ 仍然是 NO_TOOL（不放宽判据）
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { makeFakeBot } from './fixtures/fake_bot.mjs';
import { CODES, isResult } from '../src/agent/library/contract.js';
import { canDigWithInventory, canDigReason } from '../src/agent/library/act_dig.js';
import { mine, manifest } from '../src/agent/library/flow_mine.js';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

function assertResult(name, r) {
    if (!isResult(r) || !CODES.includes(r.code)) { badCase(name, { why: '不是合法 ActionResult', got: r }); return false; }
    return true;
}

/** 造一个"有矿石 + 有镐"的场景；dig 会真的把方块挖掉并让矿物进背包。 */
function mineBot({ picks = [{ name: 'iron_pickaxe', type: 892, count: 1, slot: 36, maxDurability: 250, durabilityUsed: 0 }], oreCount = 4 } = {}) {
    const world = new Map();          // "x,y,z" -> block
    const addOre = (x) => world.set(`${x},16,0`, {
        name: 'iron_ore', position: { x, y: 16, z: 0, distanceTo: () => 1 },
        diggable: true, canHarvest: () => true, harvestTools: { 877: true }, digTime: () => 50,
    });
    for (let i = 0; i < oreCount; i++) addOre(i + 1);

    let dugCount = 0;
    const bot = makeFakeBot({
        feet: { x: 0, y: 16, z: 0 },
        items: [...picks],
        registry: {
            blocksByName: { iron_ore: { id: 15 } },
            itemsByName: { iron_pickaxe: { id: 892 }, raw_iron: { id: 867 } },
        },
        stubs: {
            findBlocks: () => [...world.keys()]
                .map((k) => k.split(',').map(Number))
                .map(([x, y, z]) => ({ x, y, z })),
            blockAt: (v) => {
                const k = `${Math.floor(v?.x ?? 0)},${Math.floor(v?.y ?? 0)},${Math.floor(v?.z ?? 0)}`;
                return world.get(k) ?? { name: 'air', position: v };
            },
            dig: async (b) => {
                // 真的删方块 + 让磨损推进 + 掉落到背包（模拟真实挖矿全过程）
                const k = `${b.position.x},${b.position.y},${b.position.z}`;
                if (!world.has(k)) return;
                world.delete(k);
                dugCount++;
                // 镐的磨损：挖一块 +1
                const pick = bot.inventory.slots.find((i) => i.name === 'iron_pickaxe');
                if (pick) pick.durabilityUsed = (pick.durabilityUsed ?? 0) + 1;
                // 产物进背包
                const cur = bot.inventory.slots.find((i) => i.name === 'raw_iron');
                if (cur) cur.count += 1;
                else bot.inventory.slots.push({ name: 'raw_iron', type: 867, count: 1, slot: 37 });
            },
        },
    });
    bot.__dug = () => dugCount;
    return bot;
}

// ── 1. ① 只有一把全新镐，挖掉 1 块后**仍然能继续挖** ─────────────────
{
    const bot = mineBot({ oreCount: 4 });
    const before = canDigWithInventory(bot, { name: 'iron_ore', diggable: true, canHarvest: () => true, harvestTools: { 877: true } });
    const r = await mine(bot, 'iron', 3, { ctx: { deadline: Date.now() + 20000 } });
    const afterPick = bot.inventory.slots.find((i) => i.name === 'iron_pickaxe');
    const good = before === true && r.ok && r.data.count >= 3 && afterPick.durabilityUsed >= 3;
    if (good) {
        okCase('① 一把全新镐挖 3 块全程可用（第 2 块起不报没工具）',
            `count=${r.data.count} used=${afterPick.durabilityUsed}`);
    } else {
        badCase('① 一把镐挖多块', { before, ok: r.ok, code: r.code, data: r.data, used: afterPick?.durabilityUsed });
    }
}

// ── 2. 挖 1 块之后立刻再问判据 → 必须仍是 true（真机 bug 的核心断言）──
{
    const bot = mineBot({ oreCount: 2 });
    const oreBlock = () => ({ name: 'iron_ore', diggable: true, canHarvest: () => true, harvestTools: { 877: true } });
    // 手动挖掉 1 块（模拟"挖了 1 个之后"）
    const r1 = await mine(bot, 'iron', 1, { ctx: { deadline: Date.now() + 10000 } });
    const afterOne = canDigWithInventory(bot, oreBlock());
    const whyAfter = canDigReason(bot, oreBlock());
    if (r1.ok && afterOne === true && whyAfter.why === 'ok') {
        okCase('② 挖掉 1 块后判据仍为 true（真机假 NO_TOOL 的回归点）', `after=${afterOne} why=${whyAfter.why}`);
    } else {
        badCase('② 挖 1 块后判据', { ok1: r1.ok, afterOne, why: whyAfter });
    }
}

// ── 3. ★ 背包读不到（inventory 缺失）→ unreadable，flow 报 NOT_READY ──
{
    const bot = mineBot();
    // 模拟"刚死/重建中"：inventory 整个不见了
    Object.defineProperty(bot, 'inventory', { configurable: true, get: () => null });
    const block = { name: 'iron_ore', diggable: true, canHarvest: () => true, harvestTools: { 877: true } };
    const why = canDigReason(bot, block);
    const r = await mine(bot, 'iron', 2, { ctx: { deadline: Date.now() + 8000 } });

    const good = why.can === false && why.why === 'unreadable'
        && assertResult('inventory 不可读', r)
        && !r.ok && r.code === 'NOT_READY'
        && r.data?.verified === false;          // 不谎报：明确"工具状态未确认"
    if (good) {
        okCase('★ 背包读不到 → unreadable → flow 报 NOT_READY + verified:false（不是 NO_TOOL）',
            `why=${why.why} code=${r.code} verified=${r.data?.verified}`);
    } else {
        badCase('★ 背包读不到的三态', { why, code: r.code, data: r.data });
    }
}

// ── 4. inventory.items() 抛错 → unreadable ────────────────────────
{
    const bot = mineBot();
    bot.inventory = { items: () => { throw new Error('desync'); } };
    const why = canDigReason(bot, { name: 'iron_ore', diggable: true, canHarvest: () => true, harvestTools: { 877: true } });
    if (why.can === false && why.why === 'unreadable') okCase('inventory.items() 抛错 → unreadable', why.why);
    else badCase('items() 抛错', why);
}

// ── 5. 血量 0（刚死）→ unreadable，不许报没工具 ──────────────────
{
    const bot = mineBot();
    bot.health = 0;
    const why = canDigReason(bot, { name: 'iron_ore', diggable: true, canHarvest: () => true, harvestTools: { 877: true } });
    if (why.can === false && why.why === 'unreadable') {
        okCase('血量 0（刚死、背包被清）→ unreadable（不是 no-tool）', why.why);
    } else badCase('血量 0 的三态', why);
}

// ── 6. ★ 真的没工具（背包读得到且空）→ 仍是 NO_TOOL（没放宽判据）──
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 16, z: 0 },
        items: [],                                     // 空背包，但**读得到**
        registry: { blocksByName: { iron_ore: { id: 15 } }, itemsByName: {} },
        stubs: {
            findBlocks: () => [{ x: 1, y: 16, z: 0 }],
            blockAt: () => ({
                name: 'iron_ore', position: { x: 1, y: 16, z: 0, distanceTo: () => 1 },
                diggable: true, canHarvest: () => true, harvestTools: { 877: true },
            }),
        },
    });
    const why = canDigReason(bot, { name: 'iron_ore', diggable: true, canHarvest: () => true, harvestTools: { 877: true } });
    const r = await mine(bot, 'iron', 1, { ctx: { deadline: Date.now() + 5000 } });
    const good = why.can === false && why.why === 'no-tool'
        && !r.ok && r.code === 'NO_TOOL';
    if (good) okCase('★ 真没工具（背包读得到但空）→ 仍报 NO_TOOL（判据没放宽）', `why=${why.why} code=${r.code}`);
    else badCase('真没工具', { why, code: r.code });
}

// ── 7. 磨损到不能用的镐 → no-tool（不是 unreadable）────────────────
{
    const bot = mineBot({ picks: [{ name: 'iron_pickaxe', type: 892, count: 1, slot: 36, maxDurability: 250, durabilityUsed: 249 }] });
    const why = canDigReason(bot, { name: 'iron_ore', diggable: true, canHarvest: () => true, harvestTools: { 877: true } });
    // max-used = 1 → 不能用 → no-tool（背包读得到，所以不是 unreadable）
    if (why.can === false && why.why === 'no-tool') okCase('磨损到剩 1 耐久的镐 → no-tool（不是 unreadable）', why.why);
    else badCase('磨损镐', why);
}

// ── 8. 多把镐：任一把可用即可（上一轮的修复不能被回退）──────────────
{
    const bot = mineBot({
        picks: [
            { name: 'iron_pickaxe', type: 892, count: 1, slot: 36, maxDurability: 250, durabilityUsed: 250 }, // 废了
            { name: 'iron_pickaxe', type: 892, count: 1, slot: 37, maxDurability: 250, durabilityUsed: 0 },   // 全新
        ],
    });
    const why = canDigReason(bot, { name: 'iron_ore', diggable: true, canHarvest: () => true, harvestTools: { 877: true } });
    if (why.can === true) okCase('多把镐：任一把能用即可（第一把废了也不误判）', why.why);
    else badCase('多把镐', why);
}

// ── 9. 徒手能挖的方块不受影响 ────────────────────────────────────
{
    const bot = makeFakeBot({ items: [], registry: { blocksByName: {}, itemsByName: {} } });
    // ★ dirt 真实没有 harvestTools（徒手可挖）—— 别给它加，否则这个用例就没意义了
    const why = canDigReason(bot, { name: 'dirt', diggable: true, canHarvest: () => true });
    if (why.can === true && why.why === 'ok') okCase('徒手可挖（dirt）→ ok，与工具无关', why.why);
    else badCase('徒手可挖', why);
}

// ── 10. manifest 的 codes 已含 NOT_READY（否则注册表启动会拒）────────
{
    const has = (manifest.codes ?? []).includes('NOT_READY');
    const allRegistered = (manifest.codes ?? []).every((c) => c === 'OK' || CODES.includes(c));
    if (has && allRegistered) okCase('mine 的 manifest 含 NOT_READY 且全部码已注册', `codes=${manifest.codes.length}`);
    else badCase('manifest codes', { has, allRegistered });
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
