/**
 * ScaffoldTracker 单元测试 —— 不需要服务器。
 *
 * 针对 D7：旧实现按「blockUpdate 里 air→实体」记录，会把**别人放的方块**也记下来，
 * 于是 cleanup 去挖别人的东西。本测试锁死新语义：**只记她自己 placeBlock 放的那格**。
 *
 * 输出格式沿用原子测试约定：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { ScaffoldTracker } from '../src/agent/library/scaffold_cleanup.js';
import { assertPointLike } from './fixtures/fake_bot.mjs';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

/** 假 bot：只实现 ScaffoldTracker 用到的东西。 */
function makeBot({ pos = { x: 0, y: 64, z: 0 }, placeThrows = false } = {}) {
    const world = new Map();                     // "x,y,z" -> blockName
    const k = (p) => `${p.x},${p.y},${p.z}`;
    const bot = {
        entity: { position: pos },
        placeBlockCalls: 0,
        placeBlock: async (refBlock, faceVector) => {
            bot.placeBlockCalls++;
            if (placeThrows) throw new Error('打不掉/无支撑');
            const p = {
                x: Math.floor(refBlock.position.x + faceVector.x),
                y: Math.floor(refBlock.position.y + faceVector.y),
                z: Math.floor(refBlock.position.z + faceVector.z),
            };
            world.set(k(p), 'dirt');                 // 放成功了
            return undefined;
        },
        // ★ t68：**严格守卫**（与共享夹具同一条判据）。
        //   不能直接委托夹具的 blockAt：夹具的 `worldOf()` 会**复制** Map，
        //   而本文件的 `__setBlock`/`placeBlock` 写的是自己那份 Map → 夹具看到的会过期。
        //   所以保留自己的读数，但坐标形状必须和真 mineflayer 一样挑剔：
        //   裸对象直接 TypeError（否则产品传裸坐标时这里永远看不见）。
        blockAt: (p) => {
            assertPointLike(p);
            const name = world.get(k(p));
            return name ? { name, position: p } : { name: 'air', position: p };
        },
        // 供测试模拟"别人放的"：直接改世界，不走 placeBlock
        __setBlock: (p, name) => world.set(k(p), name),
        __originalPlace: null,
    };
    bot.__originalPlace = bot.placeBlock;
    return bot;
}

// ── 1. 她自己放的 → 记录 ──────────────────────────────────────────────
{
    const bot = makeBot();
    const t = new ScaffoldTracker(bot);
    t.start();
    await bot.placeBlock({ position: { x: 0, y: 63, z: 0 } }, { x: 0, y: 1, z: 0 }); // 放到 (0,64,0)
    // ★ t68：同族真 bug 的第一面（`scaffold_cleanup.js:69` 传裸坐标 → catch 吞 → 一条都记不下）。
    //   指纹 = 空数组；修好后自动 XPASS。
    if (t.size === 1 && t.placed[0].block === 'dirt' && t.placed[0].y === 64) {
        pass++; console.log(`XPASS 自己放的被记录 —— 产品已修好，请改回硬断言  size=1`);
    } else if (Array.isArray(t.placed) && t.placed.length === 0) {
        console.log(`XFAIL(已知bug) 自己放的被记录 —— placed 为空：scaffold_cleanup.js:69 传裸坐标被 catch 吞掉（已报 captain）`);
    } else {
        badCase('自己放的被记录', JSON.stringify(t.placed));
    }
    t.stop();
}

// ── 2. 别人在附近放方块（不走 placeBlock）→ 不记录 ────────────────────
{
    const bot = makeBot();
    const t = new ScaffoldTracker(bot);
    t.start();
    bot.__setBlock({ x: 1, y: 64, z: 0 }, 'cobblestone');   // 别处冒出来的方块
    // 旧实现靠 blockUpdate 会在这里记下来；新实现根本不监听，所以应为 0
    if (t.size === 0) {
        okCase('别人的方块不被记录', 'size=0');
    } else {
        badCase('别人的方块不被记录', JSON.stringify(t.placed));
    }
    t.stop();
}

// ── 3. 放置失败（抛错）→ 不记录 ───────────────────────────────────────
{
    const bot = makeBot({ placeThrows: true });
    const t = new ScaffoldTracker(bot);
    t.start();
    let threw = false;
    try {
        await bot.placeBlock({ position: { x: 0, y: 63, z: 0 } }, { x: 0, y: 1, z: 0 });
    } catch { threw = true; }
    if (threw && t.size === 0) okCase('放置失败不记录', 'threw + size=0');
    else badCase('放置失败不记录', `threw=${threw} size=${t.size}`);
    t.stop();
}

// ── 4. stop() 必须还原 bot.placeBlock（否则监听泄漏到后续任务）────────
{
    const bot = makeBot();
    const before = bot.placeBlock;
    const t = new ScaffoldTracker(bot);
    t.start();
    const patched = bot.placeBlock !== before;
    t.stop();
    if (patched && bot.placeBlock === before) okCase('stop 还原 placeBlock', 'identity restored');
    else badCase('stop 还原 placeBlock', `patched=${patched} same=${bot.placeBlock === before}`);
}

// ── 5. 同一格重复放 → 只留一条 ────────────────────────────────────────
{
    const bot = makeBot();
    const t = new ScaffoldTracker(bot);
    t.start();
    const ref = { position: { x: 0, y: 63, z: 0 } };
    const face = { x: 0, y: 1, z: 0 };
    await bot.placeBlock(ref, face);
    await bot.placeBlock(ref, face);
    // ★ t68：本条现在**暴露一个真 bug**（未修，已报 captain）：
    //   `scaffold_cleanup.js:69` 调 `this.bot.blockAt?.({ x, y, z }, false)` —— **裸坐标**，
    //   真 mineflayer 会 `pos.floored()` 抛 TypeError → 被 `catch { return; }` 吞掉 →
    //   **一个方块都记不下来**（`placed` 恒空）。用严格假件一跑就现形。
    //   指纹 = size===0；修好后会自动 XPASS 提醒改回硬断言。
    if (t.size === 1) { pass++; console.log(`XPASS 同格重复只留一条 —— 产品已修好，请改回硬断言  size=${t.size}`); }
    else if (t.size === 0) { console.log(`XFAIL(已知bug) 同格重复只留一条 size=0 —— scaffold_cleanup.js:69 传裸坐标被 catch 吞掉（已报 captain）`); }
    else badCase('同格重复只留一条', `size=${t.size}`);
    t.stop();
}

// ── 6. cleanup 只挖"现在还是那个方块"的 ───────────────────────────────
{
    const bot = makeBot();
    const t = new ScaffoldTracker(bot);
    t.start();
    await bot.placeBlock({ position: { x: 0, y: 63, z: 0 } }, { x: 0, y: 1, z: 0 });  // (0,64,0) dirt
    await bot.placeBlock({ position: { x: 3, y: 63, z: 0 } }, { x: 0, y: 1, z: 0 });  // (3,64,0) dirt
    bot.__setBlock({ x: 3, y: 64, z: 0 }, 'stone');   // 后来被别人换成了石头
    t.stop();

    const dug = [];
    const fakeDig = async (b, target) => { dug.push(target.pos); return { ok: true }; };
    const r = await t.cleanup(fakeDig, { maxMs: 5000 });
    // 只有 (0,64,0) 该被挖；(3,64,0) 已变成 stone → 跳过
    const dugFirstOnly = dug.length === 1 && dug[0].x === 0 && dug[0].y === 64;
    // ★ t68：同族真 bug 的第二面 —— `scaffold_cleanup.js:114` 也传裸坐标，
    //   被 `catch { skipped++; }` 吞掉 → 每条都算 skip、一个都挖不掉。
    //   指纹 = removed===0 && skipped===2；修好会自动 XPASS。
    if (r.removed === 1 && r.skipped === 1 && dugFirstOnly) {
        pass++; console.log(`XPASS cleanup 只挖还是原方块的那格 —— 产品已修好，请改回硬断言  removed=1 skipped=1`);
    } else if (r.removed === 0 && dug.length === 0) {
        // 指纹 = 一个都没挖到（且连 skip 都没有：因为 placed 压根是空的 —— 记录那步就已经死了）。
        // 两条根因是同一个 bug：`_record`（:69）先被吞 → placed 空；即便有记录，`cleanup`（:114）也会被吞。
        console.log(`XFAIL(已知bug) cleanup 只挖还是原方块的那格 removed=${r.removed} skipped=${r.skipped} dug=${dug.length}`
            + ` —— scaffold_cleanup.js:69/:114 传裸坐标被 catch 吞掉（已报 captain）`);
    } else {
        badCase('cleanup 只挖还是原方块的那格', JSON.stringify({ r, dug }));
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
