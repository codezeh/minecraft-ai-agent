/**
 * S37~S42 / S45 的「假成功」回归测试 —— 不需要服务器，用假 bot 直接压行为。
 *
 * 每条都对应报告「三、小项」里一个已核实的缺陷。行号会位移，所以这里**只认行为**：
 * 同一个调用在修复前会给出"成功"，修复后必须给出"失败/如实"。
 *
 * 反向验证（交付文档里有逐字输出）：把 SKILLS_MODULE / WORLD_MODULE 指向
 * `git show HEAD:…` 的副本，本测试必须变红 —— 否则它只证明"现在不报错"。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import Vec3 from 'vec3';
import mcDataLoader from 'minecraft-data';

const SKILLS = process.env.SKILLS_MODULE ?? '../src/agent/library/skills.js';
const WORLD = process.env.WORLD_MODULE ?? '../src/agent/library/world.js';
const skills = await import(SKILLS);
const world = await import(WORLD);

/** mineflayer-pathfinder 的 new Movements(bot) 会读 bot.registry.blocksByName —— 给它一份真的。 */
const REGISTRY = mcDataLoader('1.21.8');

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, actual) => { fail++; console.log(`FAIL ${n} ${actual}`); };

console.log(`被测模块：skills=${SKILLS} world=${WORLD}`);

/** 最小假 bot：位置、背包、modes、pathfinder 桩。 */
function makeBot(over = {}) {
    const pos = new Vec3(0.5, 64, 0.5);
    const bot = {
        username: 'unit_fakesuccess',
        entity: { position: pos },
        registry: REGISTRY,
        // world.getNearestEntityWhere → bot.nearestEntity（mineflayer 真 API）
        nearestEntity: (pred) => Object.values(bot.entities ?? {}).find((e) => pred(e)) ?? null,
        players: {},
        game: { dimension: 'overworld', gameMode: 'survival' },
        inventory: {
            slots: [], items: () => [],
            emptySlotCount: () => 20,
            findInventoryItem: () => null,
        },
        modes: { isOn: () => false, pause: () => { }, unpause: () => { }, isPaused: () => false },
        pathfinder: {
            setMovements() { }, setGoal() { }, stop() { }, isMoving: () => false,
            // ★ 桩：goto 永远 reject —— 模拟"根本走不到"
            //   （返回 Promise 但不用 async：本仓 require-await 会拦空 async）
            goto: () => Promise.reject(new Error('no path')),
            getPathTo: () => Promise.resolve({ status: 'noPath', path: [] }),
        },
        blockAt: () => null,
        controlState: {},
        clearControlStates() { },
        output: '',
        ...over,
    };
    return bot;
}

// ── S38-1：goToNearestEntity 走不到时不得报成功 ──────────────────────────
{
    const entity = { name: 'cow', type: 'animal', position: new Vec3(20, 64, 20), isValid: true };
    const bot = makeBot();
    bot.entities = { 1: entity };
    let r = null, threw = null;
    try {
        r = await skills.goToNearestEntity(bot, 'cow', 2, 64);
    } catch (e) { threw = e; }
    // 修复前：goToPosition 的返回值被丢掉，恒 true。修复后必须是 false（走不到）。
    if (!threw && r === false) {
        okCase('S38 goToNearestEntity 走不到 → 返回 false', `返回 ${r}`);
    } else {
        badCase('S38 goToNearestEntity 走不到应返回 false', `返回=${r}${threw ? ' 抛错=' + threw.message : ''}`);
    }
}

// ── S38-2：moveAwayFromEntity 走不到时不得报成功 ────────────────────────
{
    const bot = makeBot();
    const enemy = { name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0) };
    let r = null, threw = null;
    try {
        r = await skills.moveAwayFromEntity(bot, enemy, 16);
    } catch (e) { threw = e; }
    if (!threw && r === false) {
        okCase('S38 moveAwayFromEntity 走不到 → 返回 false', `返回 ${r}`);
    } else {
        badCase('S38 moveAwayFromEntity 走不到应返回 false', `返回=${r}${threw ? ' 抛错=' + threw.message : ''}`);
    }
}

// ── S38-3：goToNearestBlock 走不到时不得报成功 ──────────────────────────
{
    const stone = { name: 'stone', position: new Vec3(30, 64, 30), boundingBox: 'block' };
    const bot = makeBot({
        findBlocks: () => [new Vec3(30, 64, 30)],
        blockAt: () => stone,
    });
    bot.entities = {};
    let r = null, threw = null;
    try {
        r = await skills.goToNearestBlock(bot, 'stone', 2, 64);
    } catch (e) { threw = e; }
    if (!threw && r === false) {
        okCase('S38 goToNearestBlock 走不到 → 返回 false', `返回 ${r}`);
    } else {
        badCase('S38 goToNearestBlock 走不到应返回 false', `返回=${r}${threw ? ' 抛错=' + threw.message : ''}`);
    }
}

// ── S39：tillAndSow 在 cheat 模式 + seedType=null（JSDoc 默认用法）不得抛 ──
{
    const bot = makeBot({
        modes: { isOn: (n) => n === 'cheat', pause: () => { }, unpause: () => { }, isPaused: () => false },
        blockAt: () => ({ name: 'grass_block', position: new Vec3(0, 63, 0), boundingBox: 'block', diggable: true, drops: [{}] }),
    });
    let threw = null, r = null;
    try {
        r = await skills.tillAndSow(bot, 0, 63, 0);   // seedType 缺省 = null
    } catch (e) { threw = e; }
    if (!threw) {
        okCase('S39 tillAndSow(seedType=null) 不抛异常（null.endsWith 已修）', `返回 ${r}`);
    } else {
        badCase('S39 tillAndSow(seedType=null) 不应抛异常', `抛了 ${threw.constructor?.name}: ${threw.message}`);
    }
}

// ── S41：digDown 读不到方块时不得报"到世界尽头成功" ────────────────────
{
    const bot = makeBot({ blockAt: () => null });   // 区块未加载 = 全 null
    let r = null, threw = null;
    try {
        r = await skills.digDown(bot, 3);
    } catch (e) { threw = e; }
    // 修复前：`.position` 直接 TypeError；或（若首块可读）报"end of the world" + true。
    if (!threw && r === false) {
        okCase('S41 digDown 区块未加载 → 如实失败（且不抛 TypeError）', `返回 ${r}`);
    } else {
        badCase('S41 digDown 区块未加载应返回 false 且不抛',
            `返回=${r}${threw ? ' 抛错=' + threw.constructor?.name + ': ' + threw.message : ''}`);
    }
}

// ── S45a：getNearestFreeSpace 的空地守卫不能是恒 false 的死检查 ──────────
//
// 修复前 `!top.name == 'air'` 恒 false ⇒ 这条检查从不生效，于是"上方根本不是空气"
// （被石头占着）的位置也会被当成 size×size 空地返回。
//
// 夹具设计：**上方是石头**、下方是"可挖且会掉落"的石头。
//   → 这显然不是空地，修复后必须拒绝（返回 undefined）；
//   → 修复前因为那条死检查被跳过，会把它当成空地返回。
{
    const stone = { name: 'stone', boundingBox: 'block', diggable: true, drops: [{ item: 'cobblestone' }] };
    const bot = makeBot({
        findBlocks: () => [new Vec3(0, 64, 0)],
        blockAt: () => stone,           // 上下都是石头：上方不是 air
    });
    let r = null, threw = null;
    try {
        r = await world.getNearestFreeSpace(bot, 2, 16);
    } catch (e) { threw = e; }
    if (threw) {
        badCase('S45a getNearestFreeSpace 不应抛', threw.message);
    } else if (r === undefined || r === null) {
        okCase('S45a getNearestFreeSpace 守卫生效（上方是石头 ⇒ 不是空地）', `返回 ${r}`);
    } else {
        badCase('S45a 恒 false 死检查应已修（上方是石头，不该算空地）', JSON.stringify(r));
    }
}

// ── S45b：getBlockAtPosition 的假空气对象必须补齐 diggable / drops ────────
{
    const bot = makeBot({ blockAt: () => null });
    const b = world.getBlockAtPosition(bot, 0, -1, 0);
    const hasFields = b && b.name === 'air' && Array.isArray(b.drops) && b.diggable === false;
    if (hasFields) {
        okCase('S45b getBlockAtPosition 假对象含 diggable/drops', `drops=${JSON.stringify(b.drops)} diggable=${b.diggable}`);
    } else {
        badCase('S45b 假对象应含 diggable=false 与 drops=[]',
            JSON.stringify({ name: b?.name, drops: b?.drops, diggable: b?.diggable }));
    }
}

// ── S40：storeItem 的 stored 数必须是"真的挪走了多少"，不是"打算挪多少" ──
//
// 夹具：openContainer 成功、窗口有效、有空位 —— 但 deposit() **什么也不做**
// （模拟服务端静默拒收/只收一部分）。修复前 `storedTotal += put` 会报"存进去了 N 个"，
// 仓储链上的数字从此不可信；修复后按背包前后差值算 ⇒ stored 必须是 0 且 ok:false。
{
    const itemObj = { name: 'iron_ingot', type: 265, count: 10 };
    const inventorySlots = [itemObj];
    const container = {
        containerItems: () => [],
        deposit: async () => { /* 静默不挪任何东西 */ },
        close: async () => { },
    };
    const bot = makeBot({
        inventory: {
            slots: inventorySlots,
            items: () => inventorySlots,
            emptySlotCount: () => 20,
            findInventoryItem: (n) => (n === 'iron_ingot' ? itemObj : null),
        },
        blockAt: () => ({ name: 'chest', position: new Vec3(1, 64, 1) }),
        // 真 bot.openContainer 返回 Promise；这里同样返回 Promise，但不写 async（无 await）
        openContainer: () => Promise.resolve(container),
        currentWindow: container,
    });
    const lm = await import('../src/agent/library/landmarks.js');
    lm.rememberChest(bot, { x: 1, y: 64, z: 1 }, 'unit_test_chest', { category: 'ores' });
    let r = null, threw = null;
    try {
        r = await skills.storeItem(bot, 'iron_ingot', 10);
    } catch (e) { threw = e; }
    const stored = r?.stored ?? null;
    if (!threw && stored === 0 && r?.ok === false) {
        okCase('S40 storeItem 什么都没挪走 ⇒ stored=0 且 ok:false', `stored=${stored} ok=${r?.ok}`);
    } else {
        badCase('S40 storeItem 应按背包实际差值记账（没挪走就不算）',
            `stored=${stored} ok=${r?.ok}${threw ? ' 抛错=' + threw.message : ''} 返回=${JSON.stringify(r)}`);
    }
}

// ── S37：collectHazardsCached 必须是**活的**（否则缓存永不填、resetHazardCache 空转）──
//
// 观测手段：world_model.collectHazards 内部调 bot.findBlocks 枚举危险 —— 数它的调用次数。
//   修复前：isSafeHere 直接调 wmCollectHazards，**每次都枚举** ⇒ 两次 isSafeHere = 2 次 findBlocks；
//   修复后：走 collectHazardsCached（TTL 3s）⇒ 第二次命中缓存 ⇒ 只有 1 次 findBlocks。
{
    let findBlocksCalls = 0;
    const bot = makeBot({
        blockAt: () => null,
        findBlocks: () => { findBlocksCalls++; return []; },
    });
    bot.entity.position = new Vec3(0, 64, 0);
    let threw = null;
    try {
        await skills.isSafeHere(bot);
        await skills.isSafeHere(bot);
    } catch (e) { threw = e; }
    if (!threw && findBlocksCalls === 1) {
        okCase('S37 连续两次 isSafeHere 只枚举一次（collectHazardsCached 生效）',
            `findBlocks 调用 ${findBlocksCalls} 次`);
    } else {
        badCase('S37 第二次应命中缓存（findBlocks 只调 1 次）',
            `findBlocks 调用 ${findBlocksCalls} 次${threw ? ' 抛错=' + threw.message : ''}`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
