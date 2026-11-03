/**
 * M6 P1 动作单测（8 个）—— 用 tools/fixtures/fake_bot.mjs 的假 bot，不连服务器。
 *
 * 重点仍是**错误码选得对不对**（上层处理方式确实不同）：
 *   NOT_READY = 等一会再来；BLOCKED = 现在就是做不了，换办法；NO_TOOL = 去弄工具；
 *   OUT_OF_REACH = 走近就行；TIMEOUT = 一直在试但没到。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import Vec3 from 'vec3';
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';
import { CODES, isResult } from '../src/agent/library/contract.js';
import { sleepInBed, wake } from '../src/agent/library/act_rest.js';
import { toggleBlock, boneMeal } from '../src/agent/library/act_blockuse.js';
import { feedEntity, tradeOnce } from '../src/agent/library/act_entity.js';
import { fishOnce } from '../src/agent/library/act_fish.js';
import { swimStep, SWIM_ARRIVE_XZ } from '../src/agent/library/act_swim.js';
import { stepInto, STEP_ARRIVE_XZ } from '../src/agent/library/act_step.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

function assertResult(name, r) {
    if (!isResult(r) || !CODES.includes(r.code)) { badCase(name, { why: '不是合法 ActionResult', got: r }); return false; }
    if (r.ok === false && !r.message) { badCase(name, { why: '失败但没有 message' }); return false; }
    return true;
}

// ══════════ sleepInBed / wake ══════════

// ── 1. sleepInBed：白天 → NOT_READY（不是 BLOCKED）────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        // t68：`red_bed 遍地` → **只有目标那格是床**。
        //   以前任何坐标都返回床 → 读错格子/读错 y 也照样通过；
        //   现在读错位置会拿到 air → 该红就红。
        world: worldOf([[0, 64, 1, 'red_bed']]),
        unloaded: 'air',
        stubs: {
            time: { isDay: true, timeOfDay: 6000 },
            isRaining: false, thunderState: 0,
        },
    });
    const r = await sleepInBed(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('sleepInBed 白天', r) && !r.ok && r.code === 'NOT_READY') {
        okCase('sleepInBed 白天 → NOT_READY（等到晚上，不是 BLOCKED）', r.code);
    } else badCase('sleepInBed 白天 → NOT_READY', { code: r.code });
}

// ── 2. sleepInBed：不是床 → NO_TARGET ───────────────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        // t68：`stone 遍地` → **只有目标那格是石头**（读错格子会拿到 air → 可能误走别的分支）
        world: worldOf([[0, 64, 1, 'stone']]),
        unloaded: 'air',
        stubs: { time: { isDay: false } },
    });
    const r = await sleepInBed(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('sleepInBed 非床', r) && !r.ok && r.code === 'NO_TARGET') okCase('sleepInBed 不是床 → NO_TARGET', r.code);
    else badCase('sleepInBed 不是床 → NO_TARGET', { code: r.code });
}

// ── 3. sleepInBed：太远 → OUT_OF_REACH ──────────────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        // t68：床只在**目标那一格**（20,64,0）→ 读错位置会拿到 air
        world: worldOf([[20, 64, 0, 'red_bed']]),
        unloaded: 'air',
        stubs: { time: { isDay: false }, isRaining: false, thunderState: 0 },
    });
    const r = await sleepInBed(bot, { pos: { x: 20, y: 64, z: 0 } });
    if (assertResult('sleepInBed 太远', r) && !r.ok && r.code === 'OUT_OF_REACH') okCase('sleepInBed 太远 → OUT_OF_REACH（走近即可）', r.code);
    else badCase('sleepInBed 太远 → OUT_OF_REACH', { code: r.code });
}

// ── 4. sleepInBed：夜里 → 睡着 ──────────────────────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        // t68：床只在目标那格
        world: worldOf([[0, 64, 1, 'red_bed']]),
        unloaded: 'air',
        stubs: {
            time: { isDay: false, timeOfDay: 14000 },
            isRaining: false, thunderState: 0,
            sleep: async () => { bot.isSleeping = true; },
        },
    });
    bot.isSleeping = false;
    const r = await sleepInBed(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('sleepInBed 睡着', r) && r.ok && r.data.sleeping === true) okCase('sleepInBed 夜里 → isSleeping=true', r.data.block);
    else badCase('sleepInBed 夜里 → 睡着', { code: r.code, data: r.data });
}

// ── 5. wake：没在睡也返回 ok（幂等，不是失败）────────────────────────
{
    const bot = makeFakeBot({});
    bot.isSleeping = false;
    const r = await wake(bot);
    if (assertResult('wake 幂等', r) && r.ok && r.data.wasSleeping === false) {
        okCase('wake 没在睡 → ok（幂等：目的已达成，不该报失败）', `wasSleeping=${r.data.wasSleeping}`);
    } else badCase('wake 幂等', { code: r.code, data: r.data });
}

// ── 6. wake：在睡 → 醒 ─────────────────────────────────────────────
{
    const bot = makeFakeBot({ stubs: { wake: () => { bot.isSleeping = false; } } });
    bot.isSleeping = true;
    const r = await wake(bot);
    if (assertResult('wake 醒', r) && r.ok && r.data.wasSleeping === true) okCase('wake 在睡 → 醒来', `${r.data.wasSleeping}`);
    else badCase('wake 在睡 → 醒来', { code: r.code, data: r.data });
}

// ══════════ toggleBlock / boneMeal ══════════

// ── 7. toggleBlock：不是可翻方块 → NO_TARGET ────────────────────────
{
    // t68：`stone 遍地` → 只有目标那格是石头
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 }, world: worldOf([[0, 64, 1, 'stone']]), unloaded: 'air' });
    const r = await toggleBlock(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('toggleBlock 非可翻', r) && !r.ok && r.code === 'NO_TARGET') okCase('toggleBlock 石头 → NO_TARGET', r.code);
    else badCase('toggleBlock 石头 → NO_TARGET', { code: r.code });
}

// ── 8. toggleBlock：太远 → OUT_OF_REACH ────────────────────────────
{
    // t68：属性走 `worldOf` 第 5 个元素（不再覆盖 blockAt）
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 }, world: worldOf([[20, 64, 0, 'oak_door', { open: false }]]), unloaded: 'air' });
    const r = await toggleBlock(bot, { pos: { x: 20, y: 64, z: 0 } });
    if (assertResult('toggleBlock 太远', r) && !r.ok && r.code === 'OUT_OF_REACH') okCase('toggleBlock 太远 → OUT_OF_REACH', r.code);
    else badCase('toggleBlock 太远 → OUT_OF_REACH', { code: r.code });
}

// ── 9. toggleBlock：状态真的翻转 ────────────────────────────────────
{
    // t68：属性用**可变对象**（getProperties() 返回同一引用 → 改它就是"门开了"）
    const doorProps = { open: false };
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        world: worldOf([[0, 64, 1, 'oak_door', doorProps]]),
        unloaded: 'air',
        stubs: {
            activateBlock: async () => { doorProps.open = true; },
        },
    });
    const r = await toggleBlock(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('toggleBlock 翻转', r) && r.ok && r.data.before === false && r.data.after === true && r.data.verified === true) {
        okCase('toggleBlock 门 false→true', JSON.stringify({ b: r.data.before, a: r.data.after }));
    } else badCase('toggleBlock 门翻转', { code: r.code, data: r.data });
}

// ── 10. toggleBlock：右键了但状态没变 → BLOCKED（不是 NOT_READY）────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        // t68：属性走 worldOf（`open:false` + activateBlock 不动作 = 永远打不开）
        world: worldOf([[0, 64, 1, 'oak_door', { open: false }]]),
        unloaded: 'air',
        stubs: {
            activateBlock: async () => { /* 被红石锁住，没反应 */ },
        },
    });
    const r = await toggleBlock(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('toggleBlock 锁住', r) && !r.ok && r.code === 'BLOCKED') {
        okCase('toggleBlock 状态没变 → BLOCKED（现在就是打不开，不是等一会）', r.code);
    } else badCase('toggleBlock 锁住 → BLOCKED', { code: r.code });
}

// ── 10b. 「方块名 → 可交互类别」的匹配广度（承重正则的钉子）────────────
//
// ★ 为什么补这一节（t44 收尾，2026-11-03）：
//   删掉 `act_use.js` 时，它导出的 `useKindOf`（名字→类别分类器）一起没了。
//   captain 要求把那份"分类映射"的 6 条断言补回来 —— 但 `useKindOf` 已不存在，
//   所以这里钉的是**现在真正承重的实现**：`act_blockuse` 的 `TOGGLEABLE` / `BONE_MEALABLE`
//   两个正则（床/作物/耕地/容器各自已在别处有用例：sleepInBed 非床、harvestCrop 非作物、
//   tillSoil 石头、atom_container 的 containerKindOf 4 条）。
//
//   **判据**：谁把 TOGGLEABLE 里的 `_trapdoor` / `_fence_gate` / `lever` 删掉，
//             下面三条立刻变红（会从 BLOCKED 变成 NO_TARGET）。
{
    // 桩：方块认得（能进 TOGGLEABLE），但右键后状态不变 → BLOCKED 而不是 NO_TARGET。
    // 这样"认不认得"就有可判据：认得=BLOCKED，不认得=NO_TARGET。
    const lockedWith = (name) => makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        // t68：属性走 worldOf；`open:false` = 右键了也没开（activateBlock 不动作）
        world: worldOf([[0, 64, 1, name, { open: false }]]),
        unloaded: 'air',
        stubs: {
            activateBlock: async () => { /* 没反应 */ },
        },
    });
    for (const [name, why] of [
        ['oak_trapdoor', '_trapdoor'],
        ['oak_fence_gate', '_fence_gate'],
        ['lever', 'lever'],
    ]) {
        const bot = lockedWith(name);
        const r = await toggleBlock(bot, { pos: { x: 0, y: 64, z: 1 } });
        if (assertResult(`toggleBlock ${name}`, r) && !r.ok && r.code === 'BLOCKED') {
            okCase(`toggleBlock 认得 ${name}（TOGGLEABLE 的 ${why} 支）→ BLOCKED 而非 NO_TARGET`, r.code);
        } else badCase(`toggleBlock ${name} 应被认得 → BLOCKED`, { code: r.code });
    }
}

// ── 10c. boneMeal：不可撒的方块 → NO_TARGET（钉住 BONE_MEALABLE 的拒绝侧）──
//   可撒侧已由 12/13 两条（小麦）覆盖；这里补"石头不该被撒"。
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: [{ name: 'bone_meal', type: 1, count: 3, slot: 0 }],
        world: worldOf([[0, 64, 1, 'stone', {}]]),
        unloaded: 'air',
    });
    const r = await boneMeal(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('boneMeal 石头', r) && !r.ok && r.code === 'NO_TARGET') {
        okCase('boneMeal 石头 → NO_TARGET（BONE_MEALABLE 拒绝侧）', r.code);
    } else badCase('boneMeal 石头 → NO_TARGET', { code: r.code });
}

// ── 11. boneMeal：没有骨粉 → NO_TOOL（不是 NO_ITEM）─────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: [],
        world: worldOf([[0, 64, 1, 'wheat', { age: 3 }]]),
        unloaded: 'air',
    });
    const r = await boneMeal(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('boneMeal 无骨粉', r) && !r.ok && r.code === 'NO_TOOL') {
        okCase('boneMeal 没骨粉 → NO_TOOL（工具性消耗品，提示去弄骨粉）', r.code);
    } else badCase('boneMeal 没骨粉 → NO_TOOL', { code: r.code });
}

// ── 12. boneMeal：已经熟了 → NOT_READY ─────────────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: [{ name: 'bone_meal', type: 1, count: 3, slot: 0 }],
        world: worldOf([[0, 64, 1, 'wheat', { age: 7 }]]),
        unloaded: 'air',
    });
    const r = await boneMeal(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('boneMeal 已熟', r) && !r.ok && r.code === 'NOT_READY') {
        okCase('boneMeal 作物已熟 → NOT_READY（撒了没用）', r.code);
    } else badCase('boneMeal 已熟 → NOT_READY', { code: r.code });
}

// ── 13. boneMeal：撒了 age 推进 ────────────────────────────────────
{
    // t68：属性用**可变对象**（撒骨粉后 age 3 → 5，同一引用可见）
    const cropProps = { age: 3 };
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        world: worldOf([[0, 64, 1, 'wheat', cropProps]]),
        unloaded: 'air',
        items: [{ name: 'bone_meal', type: 1, count: 3, slot: 0 }],
        stubs: {
            activateBlock: async () => { cropProps.age = 5; },
        },
    });
    const r = await boneMeal(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('boneMeal 生长', r) && r.ok && r.data.before === 3 && r.data.after === 5 && r.data.advanced === true) {
        okCase('boneMeal age 3→5', JSON.stringify({ b: r.data.before, a: r.data.after }));
    } else badCase('boneMeal 生长', { code: r.code, data: r.data });
}

// ══════════ feedEntity / tradeOnce ══════════

// ── 14. feedEntity：太远 → OUT_OF_REACH（02 §3.5 原表就是 OUT_OF_REACH）──
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    const cow = { name: 'cow', isValid: true, position: new Vec3(0, 64, 10) };
    const r = await feedEntity(bot, cow, 'wheat');
    if (assertResult('feedEntity 太远', r) && !r.ok && r.code === 'OUT_OF_REACH') okCase('feedEntity 太远 → OUT_OF_REACH', r.code);
    else badCase('feedEntity 太远 → OUT_OF_REACH', { code: r.code });
}

// ── 15. feedEntity：没有食物 → NO_ITEM ─────────────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 }, items: [] });
    const cow = { name: 'cow', isValid: true, position: new Vec3(0, 64, 1) };
    const r = await feedEntity(bot, cow, 'wheat');
    if (assertResult('feedEntity 无食物', r) && !r.ok && r.code === 'NO_ITEM') okCase('feedEntity 没食物 → NO_ITEM', r.code);
    else badCase('feedEntity 没食物 → NO_ITEM', { code: r.code });
}

// ── 16. feedEntity：喂成功，读不到繁殖状态就 verified:false（不谎报）──
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: [{ name: 'wheat', type: 1, count: 5, slot: 0 }],
        stubs: { activateEntity: async () => {} },
    });
    const cow = { name: 'cow', isValid: true, position: new Vec3(0, 64, 1) };   // 没有 inLove 字段
    const r = await feedEntity(bot, cow, 'wheat');
    if (assertResult('feedEntity 成功', r) && r.ok && r.data.verified === false) {
        okCase('feedEntity 喂了但读不到 inLove → verified:false（不假装）', `item=${r.data.item}`);
    } else badCase('feedEntity 成功', { code: r.code, data: r.data });
}

// ── 17. tradeOnce：没有窗口 → WINDOW_CLOSED ────────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    bot.currentWindow = null;
    const v = { name: 'villager', isValid: true, position: new Vec3(0, 64, 1) };
    const r = await tradeOnce(bot, v, 0);
    if (assertResult('tradeOnce 无窗口', r) && !r.ok && r.code === 'WINDOW_CLOSED') {
        okCase('tradeOnce 窗口没开 → WINDOW_CLOSED（先开窗）', r.code);
    } else badCase('tradeOnce 无窗口 → WINDOW_CLOSED', { code: r.code });
}

// ── 18. tradeOnce：没有那个交易 → NO_TARGET ───────────────────────
//
// ★ 为什么这条断言从 NOT_READY 改成 NO_TARGET（t41，2026-11-03）：
//   判据来自 `CODES`（contract.js）：NOT_READY = **时间能解决**的"等一会再来"
//   （作物没熟、熔炉没烧完、白天睡不了）；而"这个村民只有 3 个交易、你要第 5 个"
//   **等多久都不会出现** —— 得上层改请求（换交易/换村民）→ 那是 NO_TARGET。
//   旧断言钉的是旧错码，不是行为：改后覆盖不变，只是码选对了。
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    bot.currentWindow = { trades: [{ inputItem1: { name: 'wheat', count: 3 } }] };
    const v = { name: 'villager', isValid: true, position: new Vec3(0, 64, 1) };
    const r = await tradeOnce(bot, v, 5);            // 只有 1 条，要第 6 条
    if (assertResult('tradeOnce 没这交易', r) && !r.ok && r.code === 'NO_TARGET') {
        okCase('tradeOnce 没有该条交易 → NO_TARGET（终态，不是"等一会"；也不是 NO_ITEM）', r.code);
    } else badCase('tradeOnce 没这交易 → NO_TARGET', { code: r.code });
}

// ── 19. tradeOnce：货不够 → NO_ITEM ──────────────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 }, items: [{ name: 'wheat', type: 1, count: 1, slot: 0 }] });
    bot.currentWindow = { trades: [{ inputItem1: { name: 'wheat', count: 3 } }] };
    const v = { name: 'villager', isValid: true, position: new Vec3(0, 64, 1) };
    const r = await tradeOnce(bot, v, 0);
    if (assertResult('tradeOnce 货不够', r) && !r.ok && r.code === 'NO_ITEM') okCase('tradeOnce 货不够 → NO_ITEM', r.code);
    else badCase('tradeOnce 货不够 → NO_ITEM', { code: r.code });
}

// ══════════ fishOnce ══════════

// ── 20. fishOnce：没有鱼竿 → NO_TOOL ─────────────────────────────
{
    const bot = makeFakeBot({ items: [] });
    const r = await fishOnce(bot);
    if (assertResult('fishOnce 无竿', r) && !r.ok && r.code === 'NO_TOOL') okCase('fishOnce 没鱼竿 → NO_TOOL（工具不是材料）', r.code);
    else badCase('fishOnce 没鱼竿 → NO_TOOL', { code: r.code });
}

// ── 21. fishOnce：目标不是水 → NO_TARGET ─────────────────────────
{
    const bot = makeFakeBot({
        items: [{ name: 'fishing_rod', type: 1, count: 1, slot: 0 }],
        stubs: { blockAt: () => ({ name: 'stone' }) },
    });
    const r = await fishOnce(bot, { pos: { x: 1, y: 62, z: 0 } });
    if (assertResult('fishOnce 非水', r) && !r.ok && r.code === 'NO_TARGET') okCase('fishOnce 目标不是水 → NO_TARGET', r.code);
    else badCase('fishOnce 非水 → NO_TARGET', { code: r.code });
}

// ── 22. fishOnce：收竿但没钓到 → NOT_READY ───────────────────────
{
    const bot = makeFakeBot({
        items: [{ name: 'fishing_rod', type: 1, count: 1, slot: 0 }],
        stubs: { fish: async () => { /* 收竿，背包没变 */ } },
    });
    const r = await fishOnce(bot);
    if (assertResult('fishOnce 没钓到', r) && !r.ok && r.code === 'NOT_READY') {
        okCase('fishOnce 收竿但没钓到 → NOT_READY（这次没鱼，换位置）', r.code);
    } else badCase('fishOnce 没钓到 → NOT_READY', { code: r.code });
}

// ── 23. fishOnce：钓到东西 ──────────────────────────────────────
{
    const bot = makeFakeBot({
        items: [{ name: 'fishing_rod', type: 1, count: 1, slot: 0 }],
        stubs: {
            fish: async () => { bot.inventory.slots.push({ name: 'cod', type: 349, count: 1, slot: 5 }); },
        },
    });
    const r = await fishOnce(bot);
    if (assertResult('fishOnce 成功', r) && r.ok && r.data.caught === 1) okCase('fishOnce 钓到 1 条', r.data.caught);
    else badCase('fishOnce 成功', { code: r.code, data: r.data });
}

// ══════════ swimStep ══════════

// ── 24. swimStep：目标格不是水 → NO_TARGET ──────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 }, stubs: { blockAt: () => ({ name: 'stone' }) } });
    const r = await swimStep(bot, { pos: { x: 0, y: 62, z: 1 } });
    if (assertResult('swimStep 非水', r) && !r.ok && r.code === 'NO_TARGET') {
        okCase('swimStep 目标格不是水 → NO_TARGET（本动作只处理水面）', r.code);
    } else badCase('swimStep 非水 → NO_TARGET', { code: r.code });
}

// ── 25. swimStep：按住 forward+jump 两个键（05 规格第②条）──────────
{
    const seen = new Set();
    const bot = makeFakeBot({
        feet: { x: 0, y: 63, z: 0 },
        // t68：`永远是 water`（两个分支都返回 water，其实等于常量）→ 只让**目标那格**是水。
        //   以前读错格子也会拿到 water；现在读错位置拿到 air → 会被"目标不是水"挡下。
        world: worldOf([[1, 62, 0, 'water']]),
        unloaded: 'air',
        stubs: {
            setControlState: (k, v) => { if (v) seen.add(k); if (bot.__controls) { if (v) bot.__controls.set(k, true); else bot.__controls.delete(k); } },
            lookAt: async () => {},
        },
    });
    // 让 until 立刻成立：把位置直接放到目标格中心、且头在水面上
    const target = { x: 1, y: 62, z: 0 };
    bot.entity.position = new Vec3(target.x + 0.5, 62.1, target.z + 0.5);
    const r = await swimStep(bot, { pos: target }, { timeoutMs: 800 });
    const bothKeys = seen.has('forward') && seen.has('jump');
    if (assertResult('swimStep 按键', r) && bothKeys) {
        okCase('swimStep 同时按住 forward + jump（05 规格第②条）', JSON.stringify([...seen]));
    } else badCase('swimStep 按键', { code: r.code, keys: [...seen] });
}

// ── 26. swimStep：进不去 → TIMEOUT（一直在试但没到，不是 BLOCKED）──
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 63, z: 0 },
        stubs: {
            blockAt: () => ({ name: 'water' }),
            setControlState: () => {},
            lookAt: async () => {},
        },
    });
    // 位置永远不动 → until 不成立
    const r = await swimStep(bot, { pos: { x: 5, y: 62, z: 0 } }, { timeoutMs: 300 });
    if (assertResult('swimStep 超时', r) && !r.ok && r.code === 'TIMEOUT') {
        okCase('swimStep 没进格 → TIMEOUT（一直试没到，不是 BLOCKED）', `${r.data?.costMs}ms`);
    } else badCase('swimStep 超时 → TIMEOUT', { code: r.code });
}

// ── 27. swimStep 常量与 05 规格一致（水平 ≤0.5）─────────────────
{
    if (SWIM_ARRIVE_XZ === 0.5) okCase('swimStep 到位阈值 = 0.5（05 末节原文）', `SWIM_ARRIVE_XZ=${SWIM_ARRIVE_XZ}`);
    else badCase('swimStep 到位阈值 = 0.5', { SWIM_ARRIVE_XZ });
}

// ══════════ stepInto ══════════

// ── 28. stepInto：不是相邻一格 → NO_TARGET（没走的活不该它管）─────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    const r = await stepInto(bot, { pos: { x: 10, y: 64, z: 0 } });
    if (assertResult('stepInto 非相邻', r) && !r.ok && r.code === 'NO_TARGET') {
        okCase('stepInto 目标不是相邻一格 → NO_TARGET（那是导航的事）', r.code);
    } else badCase('stepInto 非相邻 → NO_TARGET', { code: r.code });
}

// ── 29. stepInto：落点脚下是空气 → UNSAFE（不是 BLOCKED）─────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: { blockAt: () => ({ name: 'air' }) },     // 脚下那格也是 air
    });
    const r = await stepInto(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('stepInto 悬空', r) && !r.ok && r.code === 'UNSAFE') {
        okCase('stepInto 落点脚下是空气 → UNSAFE（这格不该去，不是走不进去）', r.code);
    } else badCase('stepInto 悬空 → UNSAFE', { code: r.code });
}

// ── 29b. stepInto：读不到**自己**的坐标 → INTERNAL（不是 NO_TARGET）────────
//
// ★ 为什么是 INTERNAL（t41，2026-11-03）：
//   `NO_TARGET` 的语义是"**你给的**目标位置不对" —— 目标没问题，是**她自己**的状态读不到
//   （实体还没就绪/断线瞬间）。这是内部状态异常，上层既不该去改坐标，也不该"走近再试"，
//   该重试整个动作或报内部错误 → INTERNAL。
//   也刻意**不用 NO_DATA**：NO_DATA 绑的是"目标格未加载"，用在这儿会把上层引去"走近点"。
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    bot.entity = undefined;                          // 读不到自己
    const r = await stepInto(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('stepInto 无自身坐标', r) && !r.ok && r.code === 'INTERNAL') {
        okCase('stepInto 读不到自己的坐标 → INTERNAL（不是 NO_TARGET）', r.code);
    } else badCase('stepInto 无自身坐标 → INTERNAL', { code: r.code });
}

// ── 29c. stepInto：自己的坐标是 **NaN** → INTERNAL（不是"继续算下去"）──────
//
// ★ 为什么需要单独一条（t41b，2026-11-03）：
//   29b 只覆盖「`bot.entity` 缺失」。但 `position` **存在**、`x`/`z` 是 `NaN` 时会绕过它：
//     d0 = Math.hypot(NaN, ...) = NaN
//     NaN > maxReach  →  **false**   ← "不是相邻一格"的检查被绕过
//   → 继续往下做无意义的移动（pressKey + 轮询到超时），最后报一个不相干的码。
//   这与「读不到」是同一件事 → 同一个码 `INTERNAL`。
//
// 反向验证：把 act_step 里那段 NaN 守卫删掉 → 本例应变成别的码/或走到移动逻辑 → 变红。
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    bot.entity = { position: { x: NaN, y: 64, z: 0 } };   // 存在，但坐标是 NaN
    const r = await stepInto(bot, { pos: { x: 0, y: 64, z: 1 } });
    if (assertResult('stepInto 自身坐标 NaN', r) && !r.ok && r.code === 'INTERNAL') {
        okCase('stepInto 自身坐标 NaN → INTERNAL（NaN 会绕过 maxReach 检查）', r.code);
    } else badCase('stepInto 自身坐标 NaN → INTERNAL', { code: r.code });
}

// ── 30. stepInto：按前进并真的进格 ─────────────────────────────────
{
    const seen = new Set();
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        // t68：`y===63 就 stone`（不分 x/z）→ **只有目标那一列**的脚下是地板。
        //   以前读错列（x/z 错）也会拿到 stone；现在会拿到 air → UNSAFE 分支会露出来。
        world: worldOf([[0, 63, 0, 'stone']]),
        unloaded: 'air',
        stubs: {
            lookAt: async () => {},
            setControlState: (k, v) => { if (v) seen.add(k); if (bot.__controls) { if (v) bot.__controls.set(k, true); else bot.__controls.delete(k); } },
        },
    });
    // 直接把她放到目标格 → until 立刻成立
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    const r = await stepInto(bot, { pos: { x: 0, y: 64, z: 0 } }, { timeoutMs: 500 });
    if (assertResult('stepInto 成功', r) && r.ok && seen.has('forward')) {
        okCase('stepInto 进格成功（只按 forward，不按 jump）', JSON.stringify([...seen]));
    } else badCase('stepInto 成功', { code: r.code, keys: [...seen] });
}

// ── 31. stepInto：一直进不去 → TIMEOUT ────────────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        // t68：同上 —— 地板只在目标那一列 (0,63,1)
        world: worldOf([[0, 63, 1, 'stone']]),
        unloaded: 'air',
        stubs: {
            lookAt: async () => {},
            setControlState: () => {},
        },
    });
    const r = await stepInto(bot, { pos: { x: 0, y: 64, z: 1 } }, { timeoutMs: 300 });
    if (assertResult('stepInto 超时', r) && !r.ok && r.code === 'TIMEOUT') {
        okCase('stepInto 没进格 → TIMEOUT（一直试没到，不是 BLOCKED）', `${r.data?.costMs}ms`);
    } else badCase('stepInto 超时 → TIMEOUT', { code: r.code });
}

// ── 32. stepInto 到位阈值与 swim 同口径（0.5）──────────────────────
{
    if (STEP_ARRIVE_XZ === 0.5 && SWIM_ARRIVE_XZ === 0.5) {
        okCase('stepInto / swimStep 到位阈值同口径 0.5', `step=${STEP_ARRIVE_XZ} swim=${SWIM_ARRIVE_XZ}`);
    } else badCase('到位阈值同口径', { STEP_ARRIVE_XZ, SWIM_ARRIVE_XZ });
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
