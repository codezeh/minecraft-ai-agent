/**
 * M7 P0 第二批流程单测（eat / mine / farm / fight / build）—— 假 bot，不连服务器。
 *
 * 每个流程至少覆盖：**成功**、**缺料或目标不存在**、**中断**。
 * 另外锁住三处"流程特有"的判断（这些是卡片要求、别处看不出来的）：
 *   · `flow_eat` 暂停/恢复 auto-eat（成对，漏了恢复就是 bug）
 *   · `flow_fight` 按 `ATTACK_COOLDOWN_MS` 节流（冷却没好**等**，不空转）
 *   · `flow_build` 用 `fallRisk` 拦踩空 + 材料不够"一块都不建"
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import Vec3 from 'vec3';
import { makeFakeBot, worldOf, assertPointLike } from './fixtures/fake_bot.mjs';
import { CODES, isResult } from '../src/agent/library/contract.js';
import { eatToFull, manifest as eatManifest } from '../src/agent/library/flow_eat.js';
import { mine, manifest as mineManifest } from '../src/agent/library/flow_mine.js';
import { farm, manifest as farmManifest } from '../src/agent/library/flow_farm.js';
import { fight, manifest as fightManifest } from '../src/agent/library/flow_fight.js';
import { build, manifest as buildManifest } from '../src/agent/library/flow_build.js';
import { SKILL_NAMES, getSkill } from '../src/agent/library/composite_registry.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

function assertResult(name, r) {
    if (!isResult(r) || !CODES.includes(r.code)) { badCase(name, { why: '不是合法 ActionResult', got: r }); return false; }
    if (r.ok === false && !r.message) { badCase(name, { why: '失败但没有 message' }); return false; }
    return true;
}

// ══════════ flow_eat ══════════

// ── 1. eat：已经饱了 → ok（不浪费食物）────────────────────────────
{
    const bot = makeFakeBot({ items: [{ name: 'bread', type: 1, count: 5, slot: 0 }] });
    bot.food = 20;
    const r = await eatToFull(bot, { targetFood: 20 });
    if (assertResult('eat 已饱', r) && r.ok && r.data.alreadyFull === true && r.data.ate === 0) {
        okCase('eat 已经饱了 → ok 且一口都不吃（不浪费食物）', `food=${r.data.foodAfter}`);
    } else badCase('eat 已饱 → ok 不浪费', { code: r.code, data: r.data });
}

// ── 2. eat：没有食物 → NO_ITEM ───────────────────────────────────
{
    const bot = makeFakeBot({ items: [{ name: 'cobblestone', type: 1, count: 3, slot: 0 }] });
    bot.food = 4;
    const r = await eatToFull(bot, {});
    if (assertResult('eat 没食物', r) && !r.ok && r.code === 'NO_ITEM') okCase('eat 背包里没有吃的 → NO_ITEM', r.code);
    else badCase('eat 没食物 → NO_ITEM', { code: r.code });
}

// ── 3. eat：吃到饱，且 auto-eat 被暂停后**恢复**（成对，卡片要求）──
{
    const autoCalls = [];
    const bot = makeFakeBot({
        items: [{ name: 'bread', type: 1, count: 9, slot: 0 }],
        stubs: { consume: async () => { bot.food = Math.min(20, (bot.food ?? 0) + 5); } },
    });
    bot.food = 6;
    bot.autoEat = {
        enabled: true,
        isEating: false,
        disableAuto: () => { autoCalls.push('disable'); },
        enableAuto: () => { autoCalls.push('enable'); },
    };
    const r = await eatToFull(bot, { targetFood: 20 });
    const paired = autoCalls.includes('disable') && autoCalls.includes('enable');
    if (assertResult('eat 吃到饱', r) && r.ok && r.data.foodAfter >= 20 && paired) {
        okCase('eat 吃到饱 + auto-eat 暂停/恢复成对', `${r.data.foodBefore}→${r.data.foodAfter} ${autoCalls.join('+')}`);
    } else badCase('eat 吃到饱 + auto-eat 成对', { code: r.code, data: r.data, autoCalls });
}

// ── 4. eat：中断 → INTERRUPTED ───────────────────────────────────
{
    const bot = makeFakeBot({ items: [{ name: 'bread', type: 1, count: 5, slot: 0 }] });
    bot.food = 4;
    bot.interrupt_code = 'stop';
    const r = await eatToFull(bot, {});
    if (assertResult('eat 中断', r) && !r.ok && r.code === 'INTERRUPTED') okCase('eat 中断 → INTERRUPTED', r.code);
    else badCase('eat 中断 → INTERRUPTED', { code: r.code });
}

// ══════════ flow_mine ══════════

/** 造一个"能挖到矿"的假 bot。 */
function mineBot({ withOre = 2, canDig = true } = {}) {
    const oreBlocks = [];
    for (let i = 0; i < withOre; i++) {
        oreBlocks.push({
            name: 'iron_ore', position: { x: i + 1, y: 16, z: 0, distanceTo: () => 1 },
            diggable: true, canHarvest: () => true, harvestTools: { 877: true },
        });
    }
    const dug = new Set();
    const bot = makeFakeBot({
        feet: { x: 0, y: 16, z: 0 },
        items: [{ name: 'iron_pickaxe', type: 257, count: 1, slot: 0, maxDurability: 250, durabilityUsed: 0 }],
        registry: { blocksByName: { iron_ore: { id: 15 }, deepslate_iron_ore: { id: 16 } }, itemsByName: { iron_pickaxe: { id: 257 } } },
        stubs: {
            // ★ t68：findBlocks 返回 Vec3（产品会把它直接喂给 blockAt）
            findBlocks: () => oreBlocks.filter((b) => !dug.has(b.position.x)).map((b) => new Vec3(b.position.x, b.position.y, b.position.z)),
            blockAt: (v) => {
                assertPointLike(v);      // ★ t68：严格守卫
                if (v && dug.has(Math.floor(v.x))) return { name: 'air', position: v };
                const b = oreBlocks.find((x) => x.position.x === Math.floor(v?.x ?? -1));
                return b ? { ...b, position: { ...b.position, distanceTo: () => 1 } } : { name: 'stone', position: v };
            },
            dig: async (b) => { dug.add(Math.floor(b.position.x)); },
            canHarvest: () => canDig,
        },
    });
    return bot;
}

// ── 5. mine：附近没有矿 → NO_TARGET ──────────────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 16, z: 0 },
        registry: { blocksByName: { iron_ore: { id: 15 } }, itemsByName: {} },
        stubs: { findBlocks: () => [] },
    });
    const r = await mine(bot, 'iron', 2, { ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('mine 没矿', r) && !r.ok && r.code === 'NO_TARGET') {
        okCase('mine 附近没有这种矿 → NO_TARGET（换地方，不是做不到）', r.code);
    } else badCase('mine 没矿 → NO_TARGET', { code: r.code, msg: r.message });
}

// ── 6. mine：没有镐 → NO_TOOL（abort 类）─────────────────────────
{
    // 直接造一个空背包的 bot（不要"先给镐再清空 slots"：heldItem / count 闭包会留旧值）
    const ore = { name: 'iron_ore', position: { x: 1, y: 16, z: 0, distanceTo: () => 1 }, diggable: true, canHarvest: () => true, harvestTools: { 877: true } };
    const bot = makeFakeBot({
        feet: { x: 0, y: 16, z: 0 },
        items: [],
        registry: { blocksByName: { iron_ore: { id: 15 } }, itemsByName: {} },
        stubs: {
            findBlocks: () => [{ x: 1, y: 16, z: 0 }],
            blockAt: () => ({ ...ore, position: { ...ore.position } }),
        },
    });
    const r = await mine(bot, 'iron', 1, { ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('mine 没镐', r) && !r.ok && r.code === 'NO_TOOL') {
        okCase('mine 挖不动 → NO_TOOL（abort：换方向也没用）', r.code);
    } else badCase('mine 没镐 → NO_TOOL', { code: r.code, msg: r.message });
}

// ── 7. mine：中断 → INTERRUPTED ─────────────────────────────────
{
    const bot = mineBot();
    bot.interrupt_code = 'stop';
    const r = await mine(bot, 'iron', 2, { ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('mine 中断', r) && !r.ok && r.code === 'INTERRUPTED') okCase('mine 中断 → INTERRUPTED', r.code);
    else badCase('mine 中断 → INTERRUPTED', { code: r.code });
}

// ── 8. mine：太深挖不够 → TIMEOUT 且带 {count, want}（卡片要求）──
{
    // 有矿但一块也挖不掉（dig 永远返回失败）→ 循环走完 → TIMEOUT/NO_TARGET
    const bot = makeFakeBot({
        feet: { x: 0, y: 16, z: 0 },
        items: [{ name: 'iron_pickaxe', type: 257, count: 1, slot: 0, maxDurability: 250, durabilityUsed: 0 }],
        registry: { blocksByName: { iron_ore: { id: 15 } }, itemsByName: { iron_pickaxe: { id: 257 } } },
        stubs: {
            findBlocks: () => [{ x: 1, y: 16, z: 0 }],
            blockAt: (v) => { assertPointLike(v); return { name: 'iron_ore', position: { x: 1, y: 16, z: 0, distanceTo: () => 1 }, diggable: true, canHarvest: () => true, harvestTools: { 877: true }, digTime: () => 100 }; },
            dig: async () => { /* 挖不动：方块一直在 */ },
        },
    });
    const r = await mine(bot, 'iron', 4, { maxDepth: 0, ctx: { deadline: Date.now() + 3000 } });
    const hasCountWant = r.data && Number.isFinite(r.data.count) && Number.isFinite(r.data.want);
    if (assertResult('mine 挖不够', r) && !r.ok && hasCountWant) {
        okCase('mine 挖不够 → 失败码且带 {count, want}', `${r.code} ${JSON.stringify({ c: r.data.count, w: r.data.want })}`);
    } else badCase('mine 挖不够 → 带 count/want', { code: r.code, data: r.data });
}

// ══════════ flow_farm ══════════

/** 造一块地：farmland + 成熟/未熟作物。 */
function farmBot({ mature = 2, farmland = 2, seeds = 4 } = {}) {
    // ★ t68：改用 `worldOf` 的**第 5 元素**承载方块属性（作物 age）。
    //   多抓到的一层：**属性来自世界本身**（同一引用），产品若"没真收获却报成功"，
    //   再读那一格仍是 age:7 → 后置复核会露出来。
    const cells = [];
    for (let i = 0; i < mature; i++) cells.push([i, 63, 0, 'wheat', { age: 7 }]);
    for (let i = 0; i < farmland; i++) cells.push([i + 10, 63, 0, 'farmland', { age: 0 }]);
    const items = [];
    if (seeds > 0) items.push({ name: 'wheat_seeds', type: 1, count: seeds, slot: 0 });
    let harvestedCount = 0, plantedCount = 0;
    const farmWorld = worldOf(cells);
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items,
        world: farmWorld,
        unloaded: 'air',
        stubs: {
            // ★ 必须真的把方块从 world 里删掉：`harvestCrop` 有"挖完那格是否变空"的后置复核，
            //   只计数而不改动世界 → 它会判 TIMEOUT，流程就把这棵算成 skip。
            dig: async (b) => {
                const k = `${Math.floor(b.position.x)},${Math.floor(b.position.y)},${Math.floor(b.position.z)}`;
                // ★ 必须改**夹具自己那份** world：`makeFakeBot` 会 `worldOf(rawWorld)` **复制** Map，
                //   改外面那个 `farmWorld` 夹具看不见（踩过一次：症状是"收了但 wheat 还在"→ skipped）。
                const live = bot.__world;
                if (live.get(k) !== undefined) {
                    live.set(k, 'air');
                    live.__props?.delete?.(k);
                    harvestedCount++;
                }
            },
            plant: async () => { plantedCount++; },
        },
    });
    bot.__stats = () => ({ harvestedCount, plantedCount });
    return bot;
}

// ── 9. farm：成功（收到成熟作物并补种）──────────────────────────
{
    const bot = farmBot({ mature: 2, farmland: 2, seeds: 4 });
    const r = await farm(bot, { x: 0, y: 64, z: 0, radius: 16 }, { ctx: { deadline: Date.now() + 8000 } });
    const hasFields = r.ok && Number.isFinite(r.data.harvested) && Number.isFinite(r.data.planted);
    if (assertResult('farm 成功', r) && hasFields) {
        okCase('farm 一轮 → 返回 {harvested, planted}', JSON.stringify({ h: r.data.harvested, p: r.data.planted }));
    } else badCase('farm 成功', { code: r.code, data: r.data, msg: r.message });
}

// ── 10. farm：没给区域 → NO_TARGET ──────────────────────────────
{
    const bot = farmBot();
    const r = await farm(bot, null, { ctx: { deadline: Date.now() + 3000 } });
    if (assertResult('farm 没区域', r) && !r.ok && r.code === 'NO_TARGET') okCase('farm 没给区域 → NO_TARGET', r.code);
    else badCase('farm 没区域 → NO_TARGET', { code: r.code });
}

// ── 11. farm：种子用完 → 收割照做、种植 skip（卡片要求）───────────
{
    const bot = farmBot({ mature: 2, farmland: 2, seeds: 0 });   // 没种子
    const r = await farm(bot, { x: 0, y: 64, z: 0, radius: 16 }, { ctx: { deadline: Date.now() + 8000 } });
    if (assertResult('farm 无种子', r) && r.ok && r.data.harvested >= 1 && r.data.planted === 0) {
        okCase('farm 种子用完 → 仍然收割（种植 skip）', `harvested=${r.data.harvested} planted=${r.data.planted}`);
    } else badCase('farm 无种子 → 收割照做', { code: r.code, data: r.data });
}

// ── 12. farm：中断 → INTERRUPTED ────────────────────────────────
{
    const bot = farmBot();
    bot.interrupt_code = 'stop';
    const r = await farm(bot, { x: 0, y: 64, z: 0, radius: 4 }, { ctx: { deadline: Date.now() + 3000 } });
    if (assertResult('farm 中断', r) && !r.ok && r.code === 'INTERRUPTED') okCase('farm 中断 → INTERRUPTED', r.code);
    else badCase('farm 中断 → INTERRUPTED', { code: r.code });
}

// ══════════ flow_fight ══════════

/** 造一个目标实体。 */
function makeEnemy({ hp = 20, x = 2, z = 0, name = 'zombie' } = {}) {
    // attackOnce 会调 `entity.position.offset(...)`，所以这里给个最小的 Vec3 形状
    const position = {
        x, y: 64, z,
        distanceTo: () => 2,
        offset: (dx = 0, dy = 0, dz = 0) => ({
            x: x + dx, y: 64 + dy, z: z + dz, distanceTo: () => 2,
            offset: () => ({ x, y: 64, z }),
        }),
    };
    return { name, type: 'hostile', isValid: true, health: hp, height: 1.8, position };
}

// ── 13. fight：附近没有目标 → NO_TARGET ─────────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    bot.entities = {};
    const r = await fight(bot, 'zombie', { ctx: { deadline: Date.now() + 3000 } });
    if (assertResult('fight 没目标', r) && !r.ok && r.code === 'NO_TARGET') okCase('fight 附近没有目标 → NO_TARGET（skip）', r.code);
    else badCase('fight 没目标 → NO_TARGET', { code: r.code, msg: r.message });
}

// ── 14. fight：打断它（一次攻击掉光血）→ ok ─────────────────────
{
    const enemy = makeEnemy({ hp: 4, x: 2, z: 0 });
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: {
            attack: (e) => { e.health = 0; e.isValid = false; },   // 一击必杀
            lookAt: async () => {},
            blockAt: () => ({ name: 'stone', position: { x: 0, y: 63, z: 0 } }),
        },
    });
    bot.entities = { e1: enemy };
    bot.nearestEntity = () => (enemy.isValid ? enemy : null);
    const r = await fight(bot, 'zombie', { maxKills: 1, ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('fight 打死', r) && r.ok && r.data.kills >= 1) {
        okCase('fight 打死 1 个 → ok killed', `kills=${r.data.kills}`);
    } else badCase('fight 打死', { code: r.code, data: r.data, msg: r.message });
}

// ── 15. fight：血太少 → 撤退，返回 **ok + retreated:true**（卡片：撤退不算失败）──
{
    const enemy = makeEnemy({ hp: 20, x: 2, z: 0 });
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: { blockAt: () => ({ name: 'stone', position: { x: 0, y: 63, z: 0 } }) },
    });
    bot.health = 3;                                  // 低于 retreatHp=8
    bot.entities = { e1: enemy };
    bot.nearestEntity = () => enemy;
    const r = await fight(bot, 'zombie', { retreatHp: 8, ctx: { deadline: Date.now() + 3000 } });
    if (assertResult('fight 撤退', r) && r.ok && r.data.retreated === true && r.data.killed === false) {
        okCase('fight 血少 → ok + retreated:true（撤退是正确行为，不是失败）', `hp=${r.data.hpAtRetreat}`);
    } else badCase('fight 撤退', { code: r.code, data: r.data });
}

// ── 16. fight：按冷却节流（NOT_READY 时等待而不是空转）─────────────
{
    let attackCalls = 0;
    const enemy = makeEnemy({ hp: 100, x: 2, z: 0 });   // 血厚，要多打几次
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: {
            attack: () => { attackCalls++; },
            lookAt: async () => {},
            blockAt: () => ({ name: 'stone', position: { x: 0, y: 63, z: 0 } }),
        },
    });
    bot.entities = { e1: enemy };
    bot.nearestEntity = () => enemy;
    const t0 = Date.now();
    // deadline 只给 1200ms：按 625ms 冷却，最多也就能挥 2~3 次，不会几百次
    const r = await fight(bot, 'zombie', { maxKills: 1, ctx: { deadline: Date.now() + 1200 } });
    const ms = Date.now() - t0;
    // 关键：攻击次数必须很小（证明按冷却节流，没空转）
    if (assertResult('fight 节流', r) && attackCalls <= 4 && ms < 4000) {
        okCase('fight 按冷却节流（1.2s 内只挥 ≤4 次，不空转）', `calls=${attackCalls} ms=${ms}`);
    } else {
        badCase('fight 按冷却节流', { calls: attackCalls, ms, code: r.code });
    }
}

// ── 16b. fight：撤退要交代"战场情况"（目标是谁 / 还剩几个敌人）──────
//     captain 2026-11-02 指出：只回 ok({retreated:true}) 的话，上层会以为打完了不再追。
{
    const mkEnemy = () => makeEnemy({ hp: 20, x: 2, z: 0 });
    const e1 = mkEnemy(), e2 = mkEnemy();
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: { blockAt: () => ({ name: 'stone', position: { x: 0, y: 63, z: 0 } }) },
    });
    bot.health = 3;                                  // 低于 retreatHp
    bot.entities = { a: e1, b: e2 };                 // 附近两只
    bot.nearestEntity = () => e1;
    const r = await fight(bot, 'zombie', { retreatHp: 8, ctx: { deadline: Date.now() + 3000 } });
    const d = r.data ?? {};
    const informative = r.ok && d.retreated === true
        && d.killed === false
        && d.remaining === 1                          // 还差 1 个才够数
        && d.target === 'zombie'                      // 被派去打的是什么
        && d.enemiesLeft === 2                        // ★ 附近还剩几个（上层据此决定要不要回来）
        && d.hpAtRetreat === 3;
    if (assertResult('fight 撤退带战场信息', r) && informative) {
        okCase('fight 撤退 data 含 target/remaining/enemiesLeft（上层知道敌人还在）',
            `enemiesLeft=${d.enemiesLeft} remaining=${d.remaining} target=${d.target}`);
    } else {
        badCase('fight 撤退带战场信息', d);
    }
}

// ══════════ flow_build ══════════

/** 造一个建造用假 bot：地面是石头、上方空气。 */
function buildBot({ items = [{ name: 'cobblestone', type: 4, count: 32, slot: 0 }], unsafeCells = [] } = {}) {
    const placedMap = new Map();
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items,
        stubs: {
            blockAt: (v) => {
                // ★ t68：严格守卫（坐标形状与真 mineflayer 一致）
                assertPointLike(v);
                const k = `${Math.floor(v?.x ?? 0)},${Math.floor(v?.y ?? 0)},${Math.floor(v?.z ?? 0)}`;
                if (placedMap.has(k)) return { name: placedMap.get(k), position: v };
                if (Math.floor(v?.y ?? 0) < 64) return { name: 'stone', position: v };
                return { name: 'air', position: v };
            },
            placeBlock: async (ref, face) => {
                const x = Math.floor(ref.position.x) + Math.floor(face.x);
                const y = Math.floor(ref.position.y) + Math.floor(face.y);
                const z = Math.floor(ref.position.z) + Math.floor(face.z);
                placedMap.set(`${x},${y},${z}`, bot.heldItem?.name ?? 'cobblestone');
            },
        },
    });
    bot.__placedMap = placedMap;
    return bot;
}

// ── 17. build：材料不够 → NO_ITEM 且**一块都不建**（卡片：不建一半）──
{
    const bot = buildBot({ items: [{ name: 'cobblestone', type: 4, count: 1, slot: 0 }] });
    const blocks = [
        { x: 1, y: 64, z: 0, name: 'cobblestone' },
        { x: 2, y: 64, z: 0, name: 'cobblestone' },
        { x: 3, y: 64, z: 0, name: 'cobblestone' },
    ];
    const r = await build(bot, blocks, { ctx: { deadline: Date.now() + 3000 } });
    const notBuilt = bot.__placedMap.size === 0;
    if (assertResult('build 缺料', r) && !r.ok && r.code === 'NO_ITEM' && notBuilt && r.data.missing) {
        okCase('build 材料不够 → NO_ITEM + missing，且一块都没建', JSON.stringify(r.data.missing));
    } else badCase('build 缺料 → 不建一半', { code: r.code, placed: bot.__placedMap.size, data: r.data });
}

// ── 18. build：空蓝图 → NO_TARGET ───────────────────────────────
{
    const bot = buildBot();
    const r = await build(bot, [], { ctx: { deadline: Date.now() + 3000 } });
    if (assertResult('build 空蓝图', r) && !r.ok && r.code === 'NO_TARGET') okCase('build 空蓝图 → NO_TARGET', r.code);
    else badCase('build 空蓝图 → NO_TARGET', { code: r.code });
}

// ── 19. build：中断 → INTERRUPTED ───────────────────────────────
{
    const bot = buildBot();
    bot.interrupt_code = 'stop';
    const r = await build(bot, [{ x: 1, y: 64, z: 0, name: 'cobblestone' }], { ctx: { deadline: Date.now() + 3000 } });
    if (assertResult('build 中断', r) && !r.ok && r.code === 'INTERRUPTED') okCase('build 中断 → INTERRUPTED', r.code);
    else badCase('build 中断 → INTERRUPTED', { code: r.code });
}

// ── 20. build：底下悬空且不在蓝图里 → NO_SUPPORT（3 层以上要有支撑）──
{
    const bot = buildBot({ items: [{ name: 'cobblestone', type: 4, count: 32, slot: 0 }] });
    // y=70 那块底下 y=69 是空气，也不在蓝图里 → 悬空
    const blocks = [{ x: 1, y: 70, z: 0, name: 'cobblestone' }];
    const r = await build(bot, blocks, { ctx: { deadline: Date.now() + 3000 } });
    if (assertResult('build 悬空', r) && !r.ok && r.code === 'NO_SUPPORT') {
        okCase('build 底下悬空 → NO_SUPPORT（不硬放）', r.code);
    } else badCase('build 悬空 → NO_SUPPORT', { code: r.code, data: r.data });
}

// ── 21. build：成功（地面一层）──────────────────────────────────
{
    const bot = buildBot();
    const blocks = [
        { x: 1, y: 64, z: 0, name: 'cobblestone' },
        { x: 2, y: 64, z: 0, name: 'cobblestone' },
    ];
    const r = await build(bot, blocks, { ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('build 成功', r) && r.ok && r.data.placed >= 1) {
        okCase('build 地面 2 块 → ok', `placed=${r.data.placed}/${r.data.want}`);
    } else badCase('build 成功', { code: r.code, data: r.data, msg: r.message });
}

// ══════════ 注册表 ══════════

// ── 22. 五个新流程都已注册且 manifest 合格 ──────────────────────
{
    const names = ['eat', 'mine', 'farm', 'fight', 'build'];
    const missing = names.filter((n) => !SKILL_NAMES.includes(n) || !getSkill(n));
    // ★ 不要写死总数（M10 加了 obtain/tool_tier 就成了 16，这条就假红了）。
    //   断言"这 5 个必须在、且总数不少于 14"——以后加技能不该让这条红，
    //   但"某个技能被误删"必须红。
    if (missing.length === 0 && SKILL_NAMES.length >= 14) {
        okCase('eat/mine/farm/fight/build 已注册（技能总数 ≥14）', `共 ${SKILL_NAMES.length} 个`);
    } else {
        badCase('五个新流程已注册', { missing, total: SKILL_NAMES.length });
    }
}

// ── 23. 五个 manifest 的 codes 全部已在 CODES 注册 ─────────────
{
    const all = [eatManifest, mineManifest, farmManifest, fightManifest, buildManifest];
    const bad = [];
    for (const m of all) for (const c of (m.codes ?? [])) if (c !== 'OK' && !CODES.includes(c)) bad.push(`${m.name}:${c}`);
    if (bad.length === 0) okCase('五个 manifest 的 codes 全部已注册', `共 ${all.length} 个 manifest`);
    else badCase('manifest codes 未注册', bad);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
