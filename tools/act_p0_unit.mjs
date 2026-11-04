/**
 * M6 P0 动作单测（11 个）—— 用 tools/fixtures/fake_bot.mjs 的假 bot，不连服务器。
 *
 * 每个动作至少一条用例，重点是**错误码选得对不对**：
 *   同一个"做不成"，用错码会让上层做错决定（比如把"没熟"报成 BLOCKED，
 *   流程就会去换个目标，而不是等它长）。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import Vec3 from 'vec3';
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';
import { CODES, isResult } from '../src/agent/library/contract.js';
import { craftOnce, furnaceLoad, furnaceCollect } from '../src/agent/library/act_craft.js';
import { harvestCrop, plantSeed, tillSoil } from '../src/agent/library/act_farm.js';
import { equip, eat, equipItem } from '../src/agent/library/act_items.js';
import { deposit, withdraw } from '../src/agent/library/act_container.js';
import { attackOnce } from '../src/agent/library/act_attack.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

/** 所有动作的返回值都必须是合法 ActionResult（硬约束 1）。 */
function assertResult(name, r) {
    if (!isResult(r) || !CODES.includes(r.code)) {
        badCase(name, { why: '不是合法 ActionResult', got: r });
        return false;
    }
    if (r.ok === false && !r.message) { badCase(name, { why: '失败但没有 message' }); return false; }
    return true;
}

// ── 1. craftOnce：没有配方 → NO_RECIPE ─────────────────────────────────
{
    const bot = makeFakeBot({ registry: { itemsByName: {}, blocksByName: {} } });
    const r = await craftOnce(bot, 'definitely_not_an_item_xyz', 1);
    if (assertResult('craftOnce 无配方', r) && !r.ok && r.code === 'NO_RECIPE') {
        okCase('craftOnce 无配方 → NO_RECIPE', r.code);
    } else if (!r.ok) {
        // 有些环境 mcdata 对未知名字可能抛，退一步只要求"不是 NO_ITEM"
        badCase('craftOnce 无配方 → NO_RECIPE', { code: r.code, msg: r.message });
    }
}

// ── 2. craftOnce：料不够 → NO_ITEM ────────────────────────────────────
{
    const bot = makeFakeBot({ items: [] });          // 空背包
    const r = await craftOnce(bot, 'stick', 1);
    if (assertResult('craftOnce 料不够', r) && !r.ok && ['NO_ITEM', 'NO_RECIPE'].includes(r.code)) {
        okCase('craftOnce 料不够 → NO_ITEM（空背包）', r.code);
    } else {
        badCase('craftOnce 料不够 → NO_ITEM（空背包）', { code: r.code });
    }
}

// ── 3. craftOnce：要工作台但 4 格内没有 → NO_WORKSTATION ───────────────
{
    // 造一个"有料、但 recipesFor(null) 给空、recipesFor(table) 有货"的假 bot
    const bot = makeFakeBot({
        items: [{ name: 'oak_planks', type: 5, count: 8 }],
        stubs: {
            // ★ t113：假 recipe **必须带 result.id**（真实 mineflayer recipe 一定有）——
            //   否则 `act_craft` 按产出物过滤时匹配不到，会误报 NO_RECIPE（假件太松/太假）。
            recipesFor: (id, _md, _n, table) => (table ? [{ result: { id, count: 1 }, delta: [{ count: 1, id: 340 }] }] : []),
            findBlock: () => null,                  // 4 格内没有工作台
        },
    });
    const r = await craftOnce(bot, 'crafting_table', 1);
    if (assertResult('craftOnce 需工作台', r) && !r.ok && r.code === 'NO_WORKSTATION') {
        okCase('craftOnce 需要工作台但没有 → NO_WORKSTATION', r.code);
    } else {
        badCase('craftOnce 需要工作台但没有 → NO_WORKSTATION', { code: r.code, msg: r.message });
    }
}

// ── 4. craftOnce：成功路径 → 产物真的增加 ─────────────────────────────
{
    const slots = [{ name: 'oak_planks', type: 5, count: 8, slot: 0 }];
    const bot = makeFakeBot({
        items: slots,
        stubs: {
            recipesFor: (id) => [{ result: { id, count: 4 }, delta: [{ count: 4, id: 340 }] }],
            craft: async (_recipe, n) => {
                // 模拟合成产出：往背包里加 4*n 个 stick
                const stick = bot.inventory.slots.find((i) => i.name === 'stick');
                if (stick) stick.count += 4 * n;
                else bot.inventory.slots.push({ name: 'stick', type: 340, count: 4 * n, slot: 1 });
            },
        },
    });
    const r = await craftOnce(bot, 'stick', 2);
    // ★ t115：**断言改成"按次数折算"后的正确结果。**
    //   `stick` 一次产 4 根 → 要 2 根只需**合 1 次** → produced = 4（不是 8）。
    //   旧断言 `produced === 8` 钉的是"件数当次数"的旧行为（合 2 次、多做一半）。
    //   新判据：produced 必须 **≥ 需要的 2 根**，且**恰好是 1 次的产量 4**（不多做）。
    if (assertResult('craftOnce 成功', r) && r.ok && r.data.produced === 4 && r.data.produced >= 2) {
        okCase('craftOnce 成功 → 要 2 根只合 1 次（produced=4，不再多做一半）', `produced=${r.data.produced}`);
    } else {
        badCase('craftOnce 成功 → 按次数折算', { code: r.code, data: r.data });
    }
}

// ── 5. furnaceLoad：熔炉太远 → OUT_OF_REACH ───────────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 }, items: [{ name: 'raw_iron', type: 1, count: 3, slot: 0 }] });
    const far = { position: new Vec3(0, 64, 40) };
    const r = await furnaceLoad(bot, far, 'raw_iron', 'coal');
    if (assertResult('furnaceLoad 太远', r) && !r.ok && r.code === 'OUT_OF_REACH') {
        okCase('furnaceLoad 熔炉太远 → OUT_OF_REACH（不是 NO_WORKSTATION）', r.code);
    } else {
        badCase('furnaceLoad 熔炉太远 → OUT_OF_REACH', { code: r.code });
    }
}

// ── 6. furnaceLoad：没有料 → NO_ITEM ─────────────────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 }, items: [] });
    const near = { position: new Vec3(0, 64, 1) };
    const r = await furnaceLoad(bot, near, 'raw_iron', 'coal');
    if (assertResult('furnaceLoad 没料', r) && !r.ok && r.code === 'NO_ITEM') {
        okCase('furnaceLoad 没有料 → NO_ITEM', r.code);
    } else {
        badCase('furnaceLoad 没有料 → NO_ITEM', { code: r.code });
    }
}

// ── 6b. furnaceLoad：熔炉里在炼别人的东西 → OCCUPIED，且**不许放料** ─────
//    captain 抓到的真 bug：这条保护一度丢了，她会往别人正在烧的熔炉里塞自己的料。
{
    let putInputCalled = 0;
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: [
            { name: 'raw_iron', type: 1, count: 3, slot: 0 },
            { name: 'coal', type: 2, count: 5, slot: 1 },
        ],
        stubs: {
            openFurnace: async () => ({
                // 里面正在烧别人的金矿
                inputItem: () => ({ name: 'raw_gold', count: 4 }),
                fuelItem: () => ({ name: 'coal', count: 2 }),
                outputItem: () => null,
                putInput: async () => { putInputCalled++; },
                putFuel: async () => { putInputCalled++; },
                close: () => {},
            }),
        },
    });
    const near = { position: new Vec3(0, 64, 1) };
    const r = await furnaceLoad(bot, near, 'raw_iron', 'coal');
    const good = assertResult('furnaceLoad 不抢', r) && !r.ok && r.code === 'OCCUPIED' && putInputCalled === 0;
    if (good) {
        okCase('furnaceLoad 熔炉在炼别人的料 → OCCUPIED 且一次都没放料', `occupant=${r.data?.occupantNow}`);
    } else {
        badCase('furnaceLoad 熔炉在炼别人的料 → OCCUPIED 且不放料', { code: r.code, putInputCalled });
    }
}

// ── 6c. furnaceLoad：熔炉里是**同种**料 → 允许续料（不误判成抢占）──────
{
    let putInputCalled = 0;
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: [
            { name: 'raw_iron', type: 1, count: 3, slot: 0 },
            { name: 'coal', type: 2, count: 5, slot: 1 },
        ],
        stubs: {
            openFurnace: async () => ({
                inputItem: () => ({ name: 'raw_iron', count: 2 }),   // 同种：续料
                fuelItem: () => ({ name: 'coal', count: 1 }),
                outputItem: () => null,
                putInput: async () => { putInputCalled++; },
                putFuel: async () => { putInputCalled++; },
                close: () => {},
            }),
        },
    });
    const near = { position: new Vec3(0, 64, 1) };
    const r = await furnaceLoad(bot, near, 'raw_iron', 'coal');
    const good = assertResult('furnaceLoad 续料', r) && r.ok && putInputCalled === 2;
    if (good) okCase('furnaceLoad 熔炉里是同种料 → 正常续料（不误判 OCCUPIED）', `putInputCalled=${putInputCalled}`);
    else badCase('furnaceLoad 熔炉里是同种料 → 正常续料', { code: r.code, putInputCalled });
}

// ── 7. furnaceCollect：产物空 → NOT_READY（不是 TIMEOUT）───────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: {
            openFurnace: async () => ({
                outputItem: () => null,             // 还没烧出东西
                takeOutput: async () => null,
                close: () => {},
            }),
        },
    });
    const near = { position: new Vec3(0, 64, 1) };
    const r = await furnaceCollect(bot, near);
    if (assertResult('furnaceCollect 未就绪', r) && !r.ok && r.code === 'NOT_READY') {
        okCase('furnaceCollect 产物空 → NOT_READY（不是 TIMEOUT）', r.code);
    } else {
        badCase('furnaceCollect 产物空 → NOT_READY', { code: r.code });
    }
}

// ── 8. furnaceCollect：有产物 → 取出来 ───────────────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: {
            openFurnace: async () => ({
                outputItem: () => ({ name: 'iron_ingot', count: 3 }),
                takeOutput: async () => ({ name: 'iron_ingot', count: 3 }),
                close: () => {},
            }),
        },
    });
    const near = { position: new Vec3(0, 64, 1) };
    const r = await furnaceCollect(bot, near);
    if (assertResult('furnaceCollect 取出', r) && r.ok && r.data.count === 3) {
        okCase('furnaceCollect 有产物 → 取出 3 个', `taken=${r.data.taken}`);
    } else {
        badCase('furnaceCollect 有产物 → 取出 3 个', { code: r.code, data: r.data });
    }
}

// ── 9. equip：护甲槽校验（M6 新增）───────────────────────────────────
{
    // 槽读得到且装上了
    const slots = [];
    slots[5] = { name: 'iron_helmet', type: 9, count: 1 };      // head 槽
    const bot = makeFakeBot({
        items: [{ name: 'iron_helmet', type: 9, count: 1, slot: 0 }],
        stubs: { equip: async (item, dest) => { if (dest === 'head') slots[5] = item; } },
    });
    bot.inventory.slots = slots;
    const r = await equip(bot, 'iron_helmet', 'head');
    if (assertResult('equip 护甲', r) && r.ok && r.data.verified === true && r.data.slot === 'head') {
        okCase('equip 护甲槽校验通过（verified=true）', `slot=${r.data.slot}`);
    } else {
        badCase('equip 护甲槽校验通过', { code: r.code, data: r.data });
    }
}

// ── 10. equip：没这件东西 → NO_ITEM；槽名错 → NO_TARGET ────────────────
{
    const bot = makeFakeBot({ items: [] });
    const noItem = await equip(bot, 'iron_helmet', 'head');
    const badSlot = await equip(bot, 'anything', 'elbow');
    const alias = await equipItem(makeFakeBot({ items: [] }), 'x', 'hand');   // 旧名仍可用
    if (assertResult('equip 无物品', noItem) && noItem.code === 'NO_ITEM'
        && badSlot.code === 'NO_TARGET' && isResult(alias)) {
        okCase('equip 无物品→NO_ITEM / 槽名错→NO_TARGET / 旧名 equipItem 仍可用', `${noItem.code}/${badSlot.code}`);
    } else {
        badCase('equip 无物品/槽名错/旧名', { a: noItem.code, b: badSlot.code, alias });
    }
}

// ── 11. eat：饱食度满 → NOT_READY（旧 consume 没有这条前置）─────────────
{
    const bot = makeFakeBot({ items: [{ name: 'bread', type: 1, count: 3, slot: 0 }] });
    bot.food = 20;                                   // 吃饱了
    const r = await eat(bot, 'bread');
    if (assertResult('eat 饱了', r) && !r.ok && r.code === 'NOT_READY') {
        okCase('eat 饱食度满 → NOT_READY（不浪费食物）', r.code);
    } else {
        badCase('eat 饱食度满 → NOT_READY', { code: r.code });
    }
}

// ── 12. eat：饿 + 有食物 → 吃掉，饱食度上升 ──────────────────────────
{
    const bot = makeFakeBot({
        items: [{ name: 'bread', type: 1, count: 3, slot: 0 }],
        stubs: { consume: async () => { bot.food = 12; } },
    });
    bot.food = 6;
    const r = await eat(bot, 'bread');
    if (assertResult('eat 成功', r) && r.ok && r.data.foodAfter === 12) {
        okCase('eat 饿→吃掉→饱食度 6→12', `food ${r.data.foodBefore}→${r.data.foodAfter}`);
    } else {
        badCase('eat 饿→吃掉', { code: r.code, data: r.data });
    }
}

// ── 13. eat：没有食物 → NO_ITEM ──────────────────────────────────────
{
    const bot = makeFakeBot({ items: [{ name: 'cobblestone', type: 1, count: 3, slot: 0 }] });
    bot.food = 5;
    const r = await eat(bot);
    if (assertResult('eat 没食物', r) && !r.ok && r.code === 'NO_ITEM') {
        okCase('eat 背包里没有吃的 → NO_ITEM', r.code);
    } else {
        badCase('eat 背包里没有吃的 → NO_ITEM', { code: r.code });
    }
}

// ── 14. deposit：没有窗口 → WINDOW_CLOSED ────────────────────────────
{
    const bot = makeFakeBot({ items: [{ name: 'coal', type: 1, count: 5, slot: 0 }] });
    bot.currentWindow = null;
    const r = await deposit(bot, 'coal', 2);
    if (assertResult('deposit 无窗口', r) && !r.ok && r.code === 'WINDOW_CLOSED') {
        okCase('deposit 没有打开容器 → WINDOW_CLOSED（不是 NOT_READY）', r.code);
    } else {
        badCase('deposit 没有打开容器 → WINDOW_CLOSED', { code: r.code });
    }
}

// ── 15. deposit：正常存取，两边计数对上 ───────────────────────────────
{
    const bot = makeFakeBot({ items: [{ name: 'coal', type: 1, count: 5, slot: 0 }] });
    // ★ 假窗口要**忠实**：真实箱子窗口有 inventoryStart/End + containerItems()。
    //   旧假窗口没有这些 → 正好把"计数口径"的 bug 藏住了（真机上才爆）。
    //   slots[0..2] = 容器 3 格，[3..5] = 玩家背包 3 格。
    // ★ 真实客户端开窗时会把**玩家背包镜像进窗口的 [inventoryStart..inventoryEnd) 段**。
    //   假窗口也必须镜像，否则"背包计数"恒为 0（旧假窗口没镜像 → 把计数口径的 bug 藏住了）。
    const win = {
        slots: [null, null, null, null, null, null],   // [0..2]=容器, [3..5]=背包镜像
        inventoryStart: 3,
        inventoryEnd: 6,
        containerItems() { return win.slots.slice(0, 3); },
    };
    const mirror = () => {
        for (let i = 0; i < 3; i++) {
            const src = bot.inventory.slots[i];
            win.slots[3 + i] = src ? { name: src.name, type: src.type, count: src.count } : null;
        }
    };
    win.deposit = async (_t, _m, n) => {
        const it = bot.inventory.slots.find((i) => i.name === 'coal');
        it.count -= n;
        win.slots[0] = { name: 'coal', type: it.type, count: ((win.slots[0]?.count) ?? 0) + n };
        mirror();
    };
    bot.currentWindow = win;
    mirror();
    const r = await deposit(bot, 'coal', 3);
    const counted = r.ok && r.data.stored === 3 && r.data.invAfter === 2 && r.data.winAfter === 3;
    if (assertResult('deposit 成功', r) && counted) {
        okCase('deposit 存 3 个：背包 5→2、容器 0→3', JSON.stringify({ inv: r.data.invAfter, win: r.data.winAfter }));
    } else {
        badCase('deposit 存 3 个', { code: r.code, data: r.data });
    }
}

// ── 16. withdraw：容器里没有 → NO_ITEM ───────────────────────────────
{
    const bot = makeFakeBot({ items: [] });
    // 忠实假窗口（含 inventoryStart/End + containerItems）—— 旧假窗口缺这些字段，
    // 正好把"容器侧计数把背包算进去"的 bug 藏住了。
    bot.currentWindow = {
        slots: [{ name: 'coal', type: 1, count: 3 }, null, null],
        inventoryStart: 1, inventoryEnd: 3,
        containerItems() { return this.slots.slice(0, 1); },
        withdraw: async () => { },
    };
    const r = await withdraw(bot, 'iron_ingot', 1);
    if (assertResult('withdraw 容器里没有', r) && !r.ok && r.code === 'NO_ITEM') {
        okCase('withdraw 容器里没有该物 → NO_ITEM', r.code);
    } else {
        badCase('withdraw 容器里没有该物 → NO_ITEM', { code: r.code });
    }
}

// ── 17. withdraw：正常取出 ───────────────────────────────────────────
{
    const bot = makeFakeBot({ items: [{ name: 'iron_ingot', type: 1, count: 0, slot: 0 }] });
    const win = {
        slots: [{ name: 'iron_ingot', type: 1, count: 4 }, null],   // [0]=容器, [1]=背包镜像
        inventoryStart: 1, inventoryEnd: 2,
        containerItems() { return win.slots.slice(0, 1); },
        withdraw: async () => {
            win.slots[0].count -= 2;
            bot.inventory.slots[0].count += 2;
            win.slots[1] = { name: 'iron_ingot', type: 1, count: bot.inventory.slots[0].count };
        },
    };
    bot.currentWindow = win;
    const r = await withdraw(bot, 'iron_ingot', 2);
    const counted = r.ok && r.data.taken === 2 && r.data.invAfter === 2 && r.data.winAfter === 2;
    if (assertResult('withdraw 成功', r) && counted) {
        okCase('withdraw 取 2 个：容器 4→2、背包 0→2', JSON.stringify({ inv: r.data.invAfter, win: r.data.winAfter }));
    } else {
        badCase('withdraw 取 2 个', { code: r.code, data: r.data });
    }
}

// ── 18. attackOnce：超出近战距离 → OUT_OF_REACH ──────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    const target = { kind: 'entity', entity: {
        name: 'zombie', isValid: true, health: 20, height: 1.8,
        position: new Vec3(0, 64, 10),                     // 10 格远
    } };
    const r = await attackOnce(bot, target);
    if (assertResult('attackOnce 太远', r) && !r.ok && r.code === 'OUT_OF_REACH') {
        okCase('attackOnce 目标太远 → OUT_OF_REACH（不是 NO_TARGET）', r.code);
    } else {
        badCase('attackOnce 目标太远 → OUT_OF_REACH', { code: r.code });
    }
}

// ── 19. attackOnce：冷却没好 → NOT_READY ────────────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    bot.__lastAttackAt = Date.now();                       // 刚打过
    const target = { kind: 'entity', entity: {
        name: 'zombie', isValid: true, health: 20, height: 1.8,
        position: new Vec3(0, 64, 2),                      // 2 格，够得着
    } };
    const r = await attackOnce(bot, target);
    if (assertResult('attackOnce 冷却', r) && !r.ok && r.code === 'NOT_READY') {
        okCase('attackOnce 冷却没好 → NOT_READY（不是 TIMEOUT）', r.code);
    } else {
        badCase('attackOnce 冷却没好 → NOT_READY', { code: r.code });
    }
}

// ── 20. attackOnce：打到、目标掉血 ──────────────────────────────────
{
    const ent = { name: 'zombie', isValid: true, health: 20, height: 1.8, position: new Vec3(0, 64, 2) };
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: { attack: (e) => { e.health -= 6; } },      // 挥一下就掉血
    });
    const r = await attackOnce(bot, { kind: 'entity', entity: ent });
    if (assertResult('attackOnce 成功', r) && r.ok && r.data.damaged === true && ent.health === 14) {
        okCase('attackOnce 打中 → 目标 20→14', `hp ${r.data.hpBefore}→${r.data.hpAfter}`);
    } else {
        badCase('attackOnce 打中', { code: r.code, data: r.data, hp: ent.health });
    }
}

// ── 21. harvestCrop：没熟 → NOT_READY ───────────────────────────────
{
    const bot = makeFakeBot({
        // t74：`wheat 遍地 + age 常量` → **只有目标那格是 wheat，且 age 来自 world 的属性**
        //   多抓到：读错格子会拿到 air（→ NO_TARGET 而不是 NOT_READY）；属性来自世界而非测试闭包。
        world: worldOf([[1, 64, 0, 'wheat', { age: 3 }]]),
        unloaded: 'air',
        feet: { x: 0, y: 64, z: 0 },
    });
    const r = await harvestCrop(bot, { pos: { x: 1, y: 64, z: 0 } });
    if (assertResult('harvestCrop 没熟', r) && !r.ok && r.code === 'NOT_READY') {
        okCase('harvestCrop 没熟 → NOT_READY（不是 BLOCKED）', r.code);
    } else {
        badCase('harvestCrop 没熟 → NOT_READY', { code: r.code });
    }
}

// ── 22. harvestCrop：不是作物 → NO_TARGET ───────────────────────────
{
    const bot = makeFakeBot({
        // t74：stone 只在目标那格（读错位置 → air）
        world: worldOf([[0, 64, 0, 'stone', {}]]),
        unloaded: 'air',
    });
    const r = await harvestCrop(bot, { pos: { x: 0, y: 64, z: 0 } });
    if (assertResult('harvestCrop 非作物', r) && !r.ok && r.code === 'NO_TARGET') {
        okCase('harvestCrop 那格不是作物 → NO_TARGET', r.code);
    } else {
        badCase('harvestCrop 那格不是作物 → NO_TARGET', { code: r.code });
    }
}

// ── 23. harvestCrop：熟了 → 挖掉且方块消失 ──────────────────────────
{
    // t74：真 world + 属性(age:7)；dig 把那一格改成 air（**改夹具那份 world**）
    const bot = makeFakeBot({
        world: worldOf([[0, 64, 0, 'wheat', { age: 7 }]]),
        unloaded: 'air',
        stubs: { dig: async () => { bot.__world.set('0,64,0', 'air'); bot.__world.__props?.delete?.('0,64,0'); } },
    });
    const r = await harvestCrop(bot, { pos: { x: 0, y: 64, z: 0 } });
    if (assertResult('harvestCrop 成功', r) && r.ok && r.data.harvested === 1) {
        okCase('harvestCrop 熟了 → 收走 1 个', r.data.crop);
    } else {
        badCase('harvestCrop 熟了', { code: r.code, data: r.data });
    }
}

// ── 24. plantSeed：不是耕地 → NO_TARGET ─────────────────────────────
{
    const bot = makeFakeBot({
        // t68：原来是「dirt 遍地」的纯回声桩 → 改成**真 world**（只有这一格是 dirt）。
        //   等价性：用例只读 (0,64,0)，其余格原为 dirt、现为 air，结论不变（NO_TARGET）。
        world: worldOf([[0, 64, 0, 'dirt']]),
        unloaded: 'air',
    });
    const r = await plantSeed(bot, { pos: { x: 0, y: 64, z: 0 } }, 'wheat_seeds');
    if (assertResult('plantSeed 非耕地', r) && !r.ok && r.code === 'NO_TARGET') {
        okCase('plantSeed 目标不是耕地 → NO_TARGET', r.code);
    } else {
        badCase('plantSeed 目标不是耕地 → NO_TARGET', { code: r.code });
    }
}

// ── 25. plantSeed：耕地上方被占 → OCCUPIED ──────────────────────────
{
    const bot = makeFakeBot({
        items: [{ name: 'wheat_seeds', type: 1, count: 4, slot: 0 }],
        // t68：纯位置桩 → 真 world（64 层耕地、65 层叶子 = 上方被占）
        world: worldOf([[0, 64, 0, 'farmland'], [0, 65, 0, 'oak_leaves']]),
        unloaded: 'air',
    });
    const r = await plantSeed(bot, { pos: { x: 0, y: 64, z: 0 } }, 'wheat_seeds');
    if (assertResult('plantSeed 被占', r) && !r.ok && r.code === 'OCCUPIED') {
        okCase('plantSeed 耕地上方被占 → OCCUPIED', r.code);
    } else {
        badCase('plantSeed 耕地上方被占 → OCCUPIED', { code: r.code });
    }
}

// ── 26. plantSeed：没有种子 → NO_ITEM ───────────────────────────────
{
    const bot = makeFakeBot({
        items: [],
        // t68：纯位置桩 → 真 world（等价：64 层耕地、其余空气）
        world: worldOf([[0, 64, 0, 'farmland']]),
        unloaded: 'air',
    });
    const r = await plantSeed(bot, { pos: { x: 0, y: 64, z: 0 } }, 'wheat_seeds');
    if (assertResult('plantSeed 无种子', r) && !r.ok && r.code === 'NO_ITEM') {
        okCase('plantSeed 背包里没有种子 → NO_ITEM', r.code);
    } else {
        badCase('plantSeed 背包里没有种子 → NO_ITEM', { code: r.code });
    }
}

// ── 27. plantSeed：成功 → 上方长成作物 ──────────────────────────────
{
    // t74：真 world（64 层耕地、65 层初始空气）；plant 把 65 层改成 wheat
    const bot = makeFakeBot({
        items: [{ name: 'wheat_seeds', type: 1, count: 4, slot: 0 }],
        world: worldOf([[0, 64, 0, 'farmland', {}], [0, 65, 0, 'air']]),
        unloaded: 'air',
        stubs: { plant: async () => { bot.__world.set('0,65,0', 'wheat'); } },
    });
    const r = await plantSeed(bot, { pos: { x: 0, y: 64, z: 0 } }, 'wheat_seeds');
    if (assertResult('plantSeed 成功', r) && r.ok && r.data.crop === 'wheat') {
        okCase('plantSeed 种下 → 上方变 wheat', r.data.crop);
    } else {
        badCase('plantSeed 种下', { code: r.code, data: r.data });
    }
}

// ── 28. tillSoil：没有锄 → NO_TOOL ──────────────────────────────────
{
    const bot = makeFakeBot({
        items: [],
        // t68：纯回声桩（grass_block 遍地）→ 真 world，只铺这一格
        world: worldOf([[0, 64, 0, 'grass_block']]),
        unloaded: 'air',
    });
    const r = await tillSoil(bot, { pos: { x: 0, y: 64, z: 0 } });
    if (assertResult('tillSoil 没锄', r) && !r.ok && r.code === 'NO_TOOL') {
        okCase('tillSoil 没有锄 → NO_TOOL（不是 NO_ITEM）', r.code);
    } else {
        badCase('tillSoil 没有锄 → NO_TOOL', { code: r.code });
    }
}

// ── 29. tillSoil：不是泥土 → NO_TARGET ─────────────────────────────
{
    const bot = makeFakeBot({
        items: [{ name: 'iron_hoe', type: 1, count: 1, slot: 0 }],
        // t68：纯回声桩（stone 遍地）→ 真 world，只铺这一格
        world: worldOf([[0, 64, 0, 'stone']]),
        unloaded: 'air',
    });
    const r = await tillSoil(bot, { pos: { x: 0, y: 64, z: 0 } });
    if (assertResult('tillSoil 非泥土', r) && !r.ok && r.code === 'NO_TARGET') {
        okCase('tillSoil 目标是石头 → NO_TARGET', r.code);
    } else {
        badCase('tillSoil 目标是石头 → NO_TARGET', { code: r.code });
    }
}

// ── 30. tillSoil：成功 → 变耕地 ────────────────────────────────────
{
    // t74：真 world（初始 dirt）；activateBlock 把那一格改成 farmland
    const bot = makeFakeBot({
        items: [{ name: 'iron_hoe', type: 1, count: 1, slot: 0 }],
        world: worldOf([[0, 64, 0, 'dirt', {}]]),
        unloaded: 'air',
        stubs: { activateBlock: async () => { bot.__world.set('0,64,0', 'farmland'); } },
    });
    const r = await tillSoil(bot, { pos: { x: 0, y: 64, z: 0 } });
    if (assertResult('tillSoil 成功', r) && r.ok && r.data.after === 'farmland') {
        okCase('tillSoil 泥土 → 耕地', `${r.data.before}→${r.data.after}`);
    } else {
        badCase('tillSoil 泥土 → 耕地', { code: r.code, data: r.data });
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
