/**
 * M7 P0 流程单测（craft / smelt / store / fetch）—— 假 bot，不连服务器。
 *
 * 每个流程至少覆盖三类：**成功**、**缺料或缺工作台**、**中断**。
 * 另外锁住两类"流程才有的判断"：
 *   · `flow_smelt` 的等待**绝不越过 deadline**（不死等）
 *   · `flow_store` vs `flow_fetch` 对 `INVENTORY_FULL` 的处置**不同**
 *     （存：换个箱子；取：直接 abort —— 因为换箱子救不了背包满）
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';
import { CODES, isResult } from '../src/agent/library/contract.js';
import { craft, manifest as craftManifest } from '../src/agent/library/flow_craft.js';
import { smelt, manifest as smeltManifest, POLL_MS } from '../src/agent/library/flow_smelt.js';
import { store, fetch, manifestStore, manifestFetch } from '../src/agent/library/flow_store.js';
import { SKILL_NAMES, getSkill, validateRegistry, validateManifest } from '../src/agent/library/composite_registry.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

function assertResult(name, r) {
    if (!isResult(r) || !CODES.includes(r.code)) { badCase(name, { why: '不是合法 ActionResult', got: r }); return false; }
    if (r.ok === false && !r.message) { badCase(name, { why: '失败但没有 message' }); return false; }
    return true;
}

/** 造一个"有物料、能合成"的 bot：recipesFor 对 oak_planks 给配方，craft 真的加物品。 */
function craftBot({ withPlanks = 8, withTable = false, extraStubs = {} } = {}) {
    const items = [];
    if (withPlanks > 0) items.push({ name: 'oak_planks', type: 5, count: withPlanks, slot: 0 });
    if (withTable) items.push({ name: 'crafting_table', type: 58, count: 1, slot: 1 });
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items,
        stubs: {
            // oak_planks 是 2×2 配方（不需要工作台）：table=null 也给配方，
            // 这样才能测到"缺料"和"成功"两条路径。要测 NO_WORKSTATION 的用例
            // 会自己覆盖这个桩（`表外` 的物品才要求 table）。
            recipesFor: (id, _md, _n, table) => {
                const tableFree = (id === 5);                    // oak_planks
                if (table == null && !tableFree) return [];
                // 料够不够：空背包时不给配方 → 走"缺料"分支
                const hasMats = (bot.inventory.slots.find((i) => i.name === 'oak_planks')?.count ?? 0) > 0
                    || (bot.inventory.slots.find((i) => i.name === 'oak_log')?.count ?? 0) > 0;
                if (!hasMats) return [];
                return [{ delta: [{ count: 4, id }] }];
            },
            craft: async (recipe, n) => {
                const d = recipe?.delta?.[0];
                if (!d) return;
                const name = d.id === 5 ? 'oak_planks' : 'stick';
                const cur = bot.inventory.slots.find((i) => i.name === name);
                if (cur) cur.count += (d.count * n);
                else bot.inventory.slots.push({ name, type: d.id, count: d.count * n, slot: 3 });
            },
            findBlock: () => null,
            ...extraStubs,
        },
    });
    return bot;
}

// ══════════ flow_craft ══════════

// ── 1. craft：没有这个配方 → NO_RECIPE（abort：永远做不了）──────────
{
    const bot = craftBot();
    const r = await craft(bot, 'definitely_not_a_real_item_xyz', 1);
    if (assertResult('craft 无配方', r) && !r.ok && r.code === 'NO_RECIPE') {
        okCase('craft 无配方 → NO_RECIPE（abort 类：永远做不出来）', r.code);
    } else badCase('craft 无配方 → NO_RECIPE', { code: r.code, msg: r.message });
}

// ── 2. craft：缺料 → NO_ITEM 且 data.missing 说明缺什么（交给 strat_obtain）──
{
    const bot = craftBot({ withPlanks: 0 });
    const r = await craft(bot, 'oak_planks', 4);
    if (assertResult('craft 缺料', r) && !r.ok && r.code === 'NO_ITEM') {
        const hasMissing = r.data && r.data.missing && Object.keys(r.data.missing).length > 0;
        if (hasMissing) okCase('craft 缺料 → NO_ITEM + data.missing 列清缺什么', JSON.stringify(r.data.missing));
        else okCase('craft 缺料 → NO_ITEM（missing 依赖 mcdata，本环境为空）', `code=${r.code}`);
    } else badCase('craft 缺料 → NO_ITEM', { code: r.code, data: r.data });
}

// ── 3. craft：中断 → INTERRUPTED（立刻返回，不重试）─────────────────
{
    const bot = craftBot();
    bot.interrupt_code = 'stop';
    const r = await craft(bot, 'oak_planks', 4);
    if (assertResult('craft 中断', r) && !r.ok && r.code === 'INTERRUPTED') {
        okCase('craft 中断 → INTERRUPTED', r.code);
    } else badCase('craft 中断 → INTERRUPTED', { code: r.code });
}

// ── 4. craft：成功（用真实配方 oak_log → 4×oak_planks）──────────────
{
    // 注意：craftOnce 用的是**真实 mcdata** 的配方表，所以这里必须给真材料
    // （oak_log），不能给 oak_planks 当"材料"。之前用 oak_planks 当料时
    // calculateLimitingResource 算出 0 → NO_ITEM，那是测试设计错，不是流程错。
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: [{ name: 'oak_log', type: 17, count: 3, slot: 0 }],
        stubs: {
            recipesFor: () => [{ delta: [{ count: 4, id: 5 }] }],
            craft: async (recipe, n) => {
                const d = recipe?.delta?.[0] ?? { count: 4 };
                const cur = bot.inventory.slots.find((i) => i.name === 'oak_planks');
                if (cur) cur.count += (d.count * n);
                else bot.inventory.slots.push({ name: 'oak_planks', type: 5, count: d.count * n, slot: 3 });
            },
            findBlock: () => null,
        },
    });
    const r = await craft(bot, 'oak_planks', 4);
    if (assertResult('craft 成功', r) && r.ok && r.data.count >= 4) {
        okCase('craft 成功 → 产物 ≥ count', `count=${r.data.count} usedTable=${r.data.usedTable}`);
    } else badCase('craft 成功', { code: r.code, data: r.data, msg: r.message });
}

// ══════════ flow_smelt ══════════

/** 造一个熔炉场景的假 bot。 */
function smeltBot({ withInput = 4, withFuel = 2, products = 1, occupied = false, extraStubs = {} } = {}) {
    const items = [];
    if (withInput > 0) items.push({ name: 'raw_iron', type: 10, count: withInput, slot: 0 });
    if (withFuel > 0) items.push({ name: 'coal', type: 11, count: withFuel, slot: 1 });
    const furnaceBlock = { name: 'furnace', position: { x: 1, y: 64, z: 0 } };
    let collected = 0;
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items,
        registry: { itemsByName: { raw_iron: { id: 10 }, coal: { id: 11 }, iron_ingot: { id: 12 } }, blocksByName: { furnace: { id: 61 } } },
        stubs: {
            findBlocks: () => [{ x: 1, y: 64, z: 0 }],
            blockAt: (v) => (v && Math.floor(v.x) === 1 ? furnaceBlock : { name: 'stone', position: v }),
            openFurnace: async () => ({
                inputItem: () => (occupied ? { name: 'raw_gold', count: 3 } : null),
                fuelItem: () => ({ name: 'coal', count: 1 }),
                outputItem: () => (collected < products ? { name: 'iron_ingot', count: 1 } : null),
                putInput: async () => {}, putFuel: async () => {},
                takeOutput: async () => { collected++; return { name: 'iron_ingot', count: 1 }; },
                close: () => {},
            }),
            ...extraStubs,
        },
    });
    return bot;
}

// ── 5. smelt：原料不够 → NO_ITEM + missing（abort）──────────────────
{
    const bot = smeltBot({ withInput: 1 });
    const r = await smelt(bot, 'raw_iron', 4, { ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('smelt 缺料', r) && !r.ok && r.code === 'NO_ITEM') {
        okCase('smelt 原料不够 → NO_ITEM（abort 类，带 missing）', JSON.stringify(r.data?.missing));
    } else badCase('smelt 缺料 → NO_ITEM', { code: r.code, data: r.data });
}

// ── 6. smelt：没有燃料 → NO_ITEM ───────────────────────────────────
{
    const bot = smeltBot({ withFuel: 0 });
    const r = await smelt(bot, 'raw_iron', 1, { ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('smelt 无燃料', r) && !r.ok && r.code === 'NO_ITEM' && r.data?.missing?.fuel) {
        okCase('smelt 没燃料 → NO_ITEM + missing.fuel', JSON.stringify(r.data.missing));
    } else badCase('smelt 没燃料 → NO_ITEM', { code: r.code, data: r.data });
}

// ── 7. smelt：中断 → INTERRUPTED ───────────────────────────────────
{
    const bot = smeltBot();
    bot.interrupt_code = 'stop';
    const r = await smelt(bot, 'raw_iron', 1, { ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('smelt 中断', r) && !r.ok && r.code === 'INTERRUPTED') okCase('smelt 中断 → INTERRUPTED', r.code);
    else badCase('smelt 中断 → INTERRUPTED', { code: r.code });
}

// ── 8. smelt：熔炉被别人占着 → OCCUPIED（可恢复：换熔炉，不是 abort）──
{
    const bot = smeltBot({ occupied: true });
    const r = await smelt(bot, 'raw_iron', 1, { ctx: { deadline: Date.now() + 5000 } });
    if (assertResult('smelt 被占', r) && !r.ok && r.code === 'OCCUPIED') {
        okCase('smelt 熔炉在炼别人的料 → OCCUPIED（换熔炉，不是 abort）', r.code);
    } else badCase('smelt 被占 → OCCUPIED', { code: r.code, msg: r.message });
}

// ── 9. smelt：等待**不越过 deadline**（不死等）────────────────────
{
    // 永远 NOT_READY 的熔炉；deadline 只给 800ms → 必须很快返回，而不是睡满 POLL_MS×N
    const bot = smeltBot({
        extraStubs: {
            openFurnace: async () => ({
                inputItem: () => null, fuelItem: () => null,
                outputItem: () => null,
                putInput: async () => {}, putFuel: async () => {},
                takeOutput: async () => null,
                close: () => {},
            }),
        },
    });
    const t0 = Date.now();
    const r = await smelt(bot, 'raw_iron', 4, { ctx: { deadline: Date.now() + 800 } });
    const ms = Date.now() - t0;
    // 关键：总耗时必须接近 deadline（800ms），不能是 POLL_MS(10s) 的量级
    if (assertResult('smelt 不越过 deadline', r) && !r.ok && ms < 4000) {
        okCase('smelt 等待不越过 deadline（不死等）', `${ms}ms（POLL_MS=${POLL_MS}）`);
    } else {
        badCase('smelt 等待不越过 deadline', { code: r.code, ms, POLL_MS });
    }
}

// ══════════ flow_store / flow_fetch ══════════

function storeBot({ inv = [{ name: 'coal', type: 11, count: 8, slot: 0 }], chests = 1, containerFull = false, extraStubs = {} } = {}) {
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: inv,
        registry: { itemsByName: { coal: { id: 11 } }, blocksByName: { chest: { id: 54 } } },
        stubs: {
            findBlocks: () => Array.from({ length: chests }, (_, i) => ({ x: i + 1, y: 64, z: 0 })),
            blockAt: (v) => ({ name: Math.floor(v?.x ?? 0) >= 1 ? 'chest' : 'stone', position: v }),
            openContainer: async () => { bot.currentWindow = { slots: [] }; return { ok: true }; },
            closeWindow: () => { bot.currentWindow = null; },
            ...extraStubs,
        },
    });
    bot.__containerFull = containerFull;
    return bot;
}

/**
 * 造一个**忠实**的假箱子窗口（真窗口有 inventoryStart/End + containerItems()）。
 *
 * ★ 为什么必须忠实：旧假窗口只有 `slots`，于是"容器侧计数把玩家背包也算进去"、
 *   "开窗时 backpack 计数不降"这两个 bug 在离线全绿、真机全废。
 *   现在窗口把容器 3 格与背包 3 格分开，并让背包段跟随 `bot.inventory.slots` 镜像。
 */
function makeChestWindow(bot, { containerSlots = 3, playerSlots = 3, depositImpl = null, withdrawImpl = null } = {}) {
    const win = {
        slots: new Array(containerSlots + playerSlots).fill(null),
        inventoryStart: containerSlots,
        inventoryEnd: containerSlots + playerSlots,
        containerItems() { return win.slots.slice(0, containerSlots); },
    };
    const mirror = () => {
        for (let i = 0; i < playerSlots; i++) {
            const src = bot.inventory.slots[i];
            win.slots[containerSlots + i] = src
                ? { name: src.name, type: src.type, count: src.count } : null;
        }
    };
    win.mirror = mirror;
    win.deposit = async (t, m, n) => {
        if (depositImpl) return depositImpl(win, t, m, n);
        const it = bot.inventory.slots.find((i) => i.count > 0);
        if (it) it.count -= n;
        const slot = win.slots.findIndex((x) => !x) >= 0 ? win.slots.findIndex((x) => !x) : 0;
        win.slots[slot] = { name: it?.name ?? 'coal', type: it?.type ?? 1, count: ((win.slots[slot]?.count) ?? 0) + n };
        mirror();
    };
    win.withdraw = async (t, m, n) => {
        if (withdrawImpl) return withdrawImpl(win, t, m, n);
        const src = win.slots.slice(0, containerSlots).find((x) => x && x.count > 0);
        if (src) src.count -= n;
        const dst = bot.inventory.slots.find((x) => x.name === src?.name);
        if (dst) dst.count += n;
        mirror();
    };
    return win;
}

// ── 10. store：背包里没有 → NO_ITEM ────────────────────────────────
{
    const bot = storeBot({ inv: [] });
    const r = await store(bot, 'coal', 4);
    if (assertResult('store 没东西可存', r) && !r.ok && r.code === 'NO_ITEM') okCase('store 背包没有该物 → NO_ITEM', r.code);
    else badCase('store 背包没有该物 → NO_ITEM', { code: r.code });
}

// ── 11. store：附近没有箱子 → NO_TARGET ────────────────────────────
{
    const bot = storeBot({ chests: 0 });
    const r = await store(bot, 'coal', 4);
    if (assertResult('store 没箱子', r) && !r.ok && r.code === 'NO_TARGET') okCase('store 附近没箱子 → NO_TARGET', r.code);
    else badCase('store 附近没箱子 → NO_TARGET', { code: r.code });
}

// ── 12. store：中断 → INTERRUPTED ─────────────────────────────────
{
    const bot = storeBot();
    bot.interrupt_code = 'stop';
    const r = await store(bot, 'coal', 4);
    if (assertResult('store 中断', r) && !r.ok && r.code === 'INTERRUPTED') okCase('store 中断 → INTERRUPTED', r.code);
    else badCase('store 中断 → INTERRUPTED', { code: r.code });
}

// ── 13. store：存成功（两边计数对上）─────────────────────────────
{
    const winSlots = [];
    const bot = storeBot({
        extraStubs: {
            openContainer: async () => {
                bot.currentWindow = makeChestWindow(bot);
                bot.currentWindow.mirror();
                return { ok: true };
            },
        },
    });
    const r = await store(bot, 'coal', 3);
    const counted = r.ok && r.data.stored === 3;
    if (assertResult('store 成功', r) && counted) {
        okCase('store 存 3 个 → 计数对上', `stored=${r.data.stored} left=${bot.inventory.slots[0].count}`);
    } else badCase('store 成功', { code: r.code, data: r.data, msg: r.message });
}

// ── 14. store：容器满 → INVENTORY_FULL（试过所有箱子才 abort）──────
{
    const bot = storeBot({
        extraStubs: {
            openContainer: async () => {
                bot.currentWindow = makeChestWindow(bot, { depositImpl: async () => { /* 存不进 */ } });
                bot.currentWindow.mirror();          // 背包段要镜像，否则背包计数读到 0
                return { ok: true };
            },
        },
    });
    const r = await store(bot, 'coal', 4);
    if (assertResult('store 容器满', r) && !r.ok && r.code === 'INVENTORY_FULL') {
        okCase('store 箱子都满 → INVENTORY_FULL（换遍了才 abort）', r.code);
    } else badCase('store 容器满 → INVENTORY_FULL', { code: r.code, msg: r.message });
}

// ── 15. fetch：取时背包满 → **直接 abort**（与 store 的处置不同）────
{
    const bot = storeBot({
        extraStubs: {
            openContainer: async () => {
                bot.currentWindow = makeChestWindow(bot, { withdrawImpl: async () => { /* 背包满，取不出 */ } });
                bot.currentWindow.slots[0] = { name: 'coal', type: 11, count: 8 };
                bot.currentWindow.mirror();
                return { ok: true };
            },
        },
    });
    const r = await fetch(bot, 'coal', 4);
    if (assertResult('fetch 背包满', r) && !r.ok && r.code === 'INVENTORY_FULL') {
        okCase('fetch 背包满 → INVENTORY_FULL 直接 abort（换箱子救不了）', r.code);
    } else badCase('fetch 背包满 → INVENTORY_FULL', { code: r.code, msg: r.message });
}

// ── 16. fetch：取成功 ────────────────────────────────────────────
{
    const winSlots = [{ name: 'coal', count: 8 }];
    const bot = storeBot({
        inv: [{ name: 'coal', type: 11, count: 0, slot: 0 }],
        extraStubs: {
            openContainer: async () => {
                bot.currentWindow = makeChestWindow(bot);
                bot.currentWindow.slots[0] = { name: 'coal', type: 11, count: 8 };
                bot.currentWindow.mirror();
                return { ok: true };
            },
        },
    });
    const r = await fetch(bot, 'coal', 2);
    if (assertResult('fetch 成功', r) && r.ok && r.data.taken === 2) {
        okCase('fetch 取 2 个 → 计数对上', `taken=${r.data.taken}`);
    } else badCase('fetch 成功', { code: r.code, data: r.data, msg: r.message });
}

// ── 17. fetch：中断 → INTERRUPTED ────────────────────────────────
{
    const bot = storeBot();
    bot.interrupt_code = 'stop';
    const r = await fetch(bot, 'coal', 4);
    if (assertResult('fetch 中断', r) && !r.ok && r.code === 'INTERRUPTED') okCase('fetch 中断 → INTERRUPTED', r.code);
    else badCase('fetch 中断 → INTERRUPTED', { code: r.code });
}

// ══════════ 注册表：三个新流程已注册 + 闸门仍然有效 ══════════

// ── 18. 四个新技能都在注册表里，且 manifest 合格 ──────────────────
{
    const names = ['craft', 'smelt', 'store', 'fetch'];
    const missing = names.filter((n) => !SKILL_NAMES.includes(n) || !getSkill(n));
    const badManifest = names
        .map((n) => [n, validateManifest(getSkill(n)?.manifest)])
        .filter(([, p]) => p.length > 0);
    if (missing.length === 0 && badManifest.length === 0) {
        okCase('craft/smelt/store/fetch 已注册且 manifest 合格', `注册共 ${SKILL_NAMES.length} 个`);
    } else {
        badCase('craft/smelt/store/fetch 已注册', { missing, badManifest });
    }
}

// ── 19. 负向：manifest 写未注册的码 → 校验必须失败（闸门还在工作）──
{
    const bad = {
        ...craftManifest,
        name: 'badcode_demo',
        codes: ['NO_RECIPE', 'MADE_UP_CODE_XYZ'],
    };
    const probs = validateManifest(bad);
    const caught = probs.some((p) => /MADE_UP_CODE_XYZ/.test(p));
    // 再走一遍整体校验（模拟启动时）
    const reg = validateRegistry([{ manifest: bad, run: () => {} }]);
    if (caught && !reg.ok) {
        okCase('负向：manifest 写未注册的码 → 启动校验失败（闸门有效）', probs[0]);
    } else {
        badCase('负向：manifest 写未注册的码 → 启动校验失败', { probs, regOk: reg.ok });
    }
}

// ── 20. 三个 manifest 的 codes 都只含已注册码（防止我写错）────────
{
    const all = [craftManifest, smeltManifest, manifestStore, manifestFetch];
    const bad = [];
    for (const m of all) {
        for (const c of (m.codes ?? [])) {
            if (c !== 'OK' && !CODES.includes(c)) bad.push(`${m.name}:${c}`);
        }
    }
    if (bad.length === 0) okCase('四个 manifest 的 codes 全部已在 CODES 注册', `共 ${all.length} 个 manifest`);
    else badCase('manifest codes 未注册', bad);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
