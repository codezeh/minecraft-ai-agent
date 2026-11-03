/**
 * `flow_mine.findStandNear` 离线回归（t65）—— 不需要服务器。
 *
 * 它是什么：`mine()` 里"目标方块自己去不了（实心格内部）→ 找同层四邻的一格能站的地方"
 * （`flow_mine.js:118`）。找不到就 `null`，调用方退回旧行为（只给 x/z）。
 * 这个函数原来**零用例** —— 改坏了没人知道，所以这里把它钉住。
 *
 * 判据（源码原话，逐条对应一个用例）：
 *   · 那格是 air（能站人）**且**它脚下是实心（站得住，不是 air / 水 / 岩浆）→ 选它
 *   · 四邻都不满足 → null（调用方退回旧行为）
 *   · `bot.blockAt` 抛异常 → null（不许把「读不到」变成崩）
 *
 * 假 bot 用公共夹具 `tools/fixtures/fake_bot.mjs`（不手写第四份假件）。
 * 注意它默认 `unloaded: 'null'` —— 未登记的格子返回 null，正好对应"没加载/不知道"。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';
import { findStandNear } from '../src/agent/library/flow_mine.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/** 目标方块位置：她要去挖的那一格（findStandNear 的入参 pos）。 */
const ORE = { x: 0, y: 64, z: 0 };

/**
 * 变异体：把「脚下必须实心」那条判据**去掉**（反向验证用）。
 *
 * ★ 为什么要这个：用例只是"断言返回 null"的话，实现里那条判据删掉也可能照样过
 *   （例如四邻恰好都不满足）。所以把"被删掉判据的实现"也跑一遍：
 *   它必须给出**不一样**的结论 —— 不一致才证明用例真的在盯那条判据。
 *   其余用例上两者必须**完全一致**（说明变异只影响该影响的地方）。
 */
function findStandNearNoBelowCheck(bot, pos) {
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
        const feet = bot.blockAt?.({ x: bx + dx, y: by, z: bz + dz }, false);
        const feetAir = feet && /^(air|cave_air|void_air)$/.test(feet.name);
        // ← 变异点：`belowSolid` 判据整段去掉
        if (feetAir) return { x: bx + dx, y: by, z: bz + dz };
    }
    return null;
}

/** 造一个"目标方块在 (0,64,0)、四邻由 cells 决定"的世界。 */
const botWith = (cells) => makeFakeBot({ world: worldOf(cells), feet: { x: 0, y: 64, z: 0 } });

// ── 1. 有一格 air 且脚下实心 → 返回那一格 ────────────────────────────────
{
    const bot = botWith([
        [1, 64, 0, 'air'], [1, 63, 0, 'stone'],      // 东邻：能站
        [-1, 64, 0, 'stone'], [-1, 63, 0, 'stone'],  // 西邻：实心（站不进）
    ]);
    const r = findStandNear(bot, ORE);
    check('① 四邻有一格 air + 脚下实心 → 返回那一格',
        !!r && r.x === 1 && r.y === 64 && r.z === 0, `got=${JSON.stringify(r)}`);
}

// ── 2. 四邻全是实心 → null（调用方退回旧行为）───────────────────────────
{
    const bot = botWith([
        [1, 64, 0, 'stone'], [-1, 64, 0, 'stone'],
        [0, 64, 1, 'stone'], [0, 64, -1, 'stone'],
    ]);
    const r = findStandNear(bot, ORE);
    check('② 四邻全是实心 → null（退回旧行为）', r === null, `got=${JSON.stringify(r)}`);
}

// ── 3. ★ 那格是 air 但脚下是 air（悬空）→ 不算可站 → null ───────────────
{
    const bot = botWith([
        [1, 64, 0, 'air'], [1, 63, 0, 'air'],        // 东邻能站进去，但脚下是空 → 会掉下去
    ]);
    const r = findStandNear(bot, ORE);
    const mutant = findStandNearNoBelowCheck(bot, ORE);
    check('③ 脚下悬空（below=air）→ 不算可站，返回 null', r === null, `got=${JSON.stringify(r)}`);
    check('③-b 同一场景下「去掉脚下判据」的变异体会返回该格（证明 ③ 真在盯这条判据）',
        !!mutant && mutant.x === 1, `mutant=${JSON.stringify(mutant)}`);
}

// ── 4. 那格是 air 但脚下是水 / 岩浆 → 不算可站 → null ───────────────────
{
    const wet = botWith([[1, 64, 0, 'air'], [1, 63, 0, 'water']]);
    const r1 = findStandNear(wet, ORE);
    check('④-1 脚下是水 → 不算可站，返回 null', r1 === null, `got=${JSON.stringify(r1)}`);

    const lava = botWith([[1, 64, 0, 'air'], [1, 63, 0, 'lava']]);
    const r2 = findStandNear(lava, ORE);
    check('④-2 脚下是岩浆 → 不算可站，返回 null', r2 === null, `got=${JSON.stringify(r2)}`);

    // 反向对照：把脚下换成石头，同一格就该被选中（证明 ④ 不是"永远 null"的假绿）
    const solid = botWith([[1, 64, 0, 'air'], [1, 63, 0, 'stone']]);
    const r3 = findStandNear(solid, ORE);
    check('④-b 同一位置脚下换成石头 → 立刻选中（排除"永远返回 null"的假绿）',
        !!r3 && r3.x === 1, `got=${JSON.stringify(r3)}`);
}

// ── 5. bot.blockAt 抛异常 → null（不许崩）───────────────────────────────
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: { blockAt: () => { throw new Error('世界读炸了'); } },
    });
    let crashed = false;
    let r = 'unset';
    try { r = findStandNear(bot, ORE); } catch { crashed = true; }
    check('⑤ blockAt 抛异常 → 返回 null 且不抛（try/catch 兜住）',
        !crashed && r === null, `crashed=${crashed} got=${JSON.stringify(r)}`);
}

// ── 6. 反向验证（一行判据级）：四邻顺序 / 只挑第一格 ──────────────────────
//   把"东邻也做成能站"再确认返回的仍是东邻（顺序稳定，调用方 goTo 目标可复现）。
{
    const bot = botWith([
        [1, 64, 0, 'air'], [1, 63, 0, 'stone'],
        [0, 64, 1, 'air'], [0, 63, 1, 'stone'],
    ]);
    const r = findStandNear(bot, ORE);
    check('⑥ 多格可站时取四邻顺序里的第一格（结果可复现）',
        !!r && r.x === 1 && r.z === 0, `got=${JSON.stringify(r)}`);
}

// ── 7. 变异体与真身的差异**只**在"脚下判据"这一处（防止变异体自己跑偏）──
{
    const cells = [
        [1, 64, 0, 'air'], [1, 63, 0, 'stone'],
        [-1, 64, 0, 'stone'], [0, 64, 1, 'stone'],
    ];
    const bot = botWith(cells);
    const a = JSON.stringify(findStandNear(bot, ORE));
    const b = JSON.stringify(findStandNearNoBelowCheck(bot, ORE));
    check('⑦ 有合法站位时真身与变异体结论一致（差异只出现在"脚下不实心"的场景）',
        a === b, `real=${a} mutant=${b}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
