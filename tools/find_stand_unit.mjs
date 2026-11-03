/**
 * `flow_mine.findStandNear` 离线回归（t65 / t65b）—— 不需要服务器、**不改产品文件**。
 *
 * 它是什么：`mine()` 里"目标方块自己去不了（实心格内部）→ 找附近一格能站的地方"。
 * 找不到就 `null`，调用方退回旧行为（只给 x/z）。这个函数原来**零用例**。
 *
 * ★★ 为什么这里**不 import**，而是从源码里"取函数体"来跑（t65b，captain 定的做法）：
 *   给 `findStandNear` 加 `export` 要改产品文件 —— 而 `flow_mine.js` 是多人在改的**热文件**
 *   （owner 是 captain，正在改 t68 搜索范围）。为测试去改它 = 撞车。
 *   所以改成"**不动产品文件**"的三件套：
 *     ① 源码级守卫：断言源码里那两条判据还在（那格 air + 脚下实心且非水/岩浆）
 *     ② 把函数体**取出来**编译成可调用函数，跑全部用例
 *     ③ 反向验证：把**取出来的拷贝体**改坏（去掉"脚下必须实心"），证明用例会红
 *        —— 改的是内存里的字符串，产品文件一个字节都不动。
 *
 * 顺带的好处：产品文件若被改成"没有那两条判据"，① 立刻红；
 *   若 `findStandNear` 被改名/删除，提取会失败并**明确报错**（不是静默跳过）。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const SRC_PATH = 'src/agent/library/flow_mine.js';

/**
 * 从产品源码里抠出 `findStandNear` 的**完整函数文本**。
 * 抠不到就抛（明确失败），绝不静默跳过 —— 否则改个名就能让本文件"永远绿"。
 */
function extractFindStandNear(src) {
    const start = src.indexOf('function findStandNear(');
    if (start < 0) throw new Error('源码里找不到 `function findStandNear(`（被改名/删除了？）—— 本用例必须随之更新');
    const rest = src.slice(start);
    // 优先：**列 0 的单独一行 `}`** = 函数结尾（注意 Windows 是 CRLF，必须容忍 \r）
    const m = rest.match(/\r?\n\}\r?\n/);
    if (m) {
        const end = m.index + m[0].indexOf('}') + 1;      // 切到那个 `}` 为止（不含行尾换行）
        return { text: rest.slice(0, end), at: start };
    }
    // 兜底：数花括号（函数体里没有含花括号的字符串/正则，够用）
    let depth = 0, started = false;
    for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') {
            depth--;
            if (started && depth === 0) return { text: rest.slice(0, i + 1), at: start };
        }
    }
    throw new Error('找不到 findStandNear 的函数结尾（源码结构变了？）');
}

/** 把函数文本编译成可调用函数（函数体只依赖参数 bot/pos，无外部自由变量）。 */
function compile(fnText) {
    return new Function(`return (${fnText.trim().replace(/^function findStandNear/, 'function')});`)();
}

let srcText = '';
let real = null;
{
    try {
        srcText = readFileSync(SRC_PATH, 'utf8');
        const { text } = extractFindStandNear(srcText);
        real = compile(text);

        // ── ① 源码级守卫（已对齐 t68 `04933c5` 的新判据）─────────────────
        //   旧判据：同层四邻 ±1、feetAir && belowSolid、dy∈[0,-3]
        //   新判据：dx,dz ∈ [-3,3] × dy ∈ [0,-6]；脚下非 air/水/岩浆/**树叶**；按距离打分取最近
        const hasFeetAir = /\^\(air\|cave_air\|void_air\)\$/.test(text);
        const hasNoWaterLava = /\^\(water\|lava\)\$/.test(text);
        const hasNoLeaves = /\/_leaves\$\/\.test\(below\.name\)/.test(text);
        const hasRangeXZ = /dx = -3; dx <= 3/.test(text);
        const hasRangeY = /dy >= -6/.test(text);
        const hasScore = /Math\.abs\(dy\)\s*\*\s*1\.5/.test(text);
        const guards = { hasFeetAir, hasNoWaterLava, hasNoLeaves, hasRangeXZ, hasRangeY, hasScore };
        check('① 源码级守卫：t68 的搜索范围(±3 / dy −6) + 脚下判据(非 air/水/岩浆/树叶) + 距离打分 都还在',
            Object.values(guards).every(Boolean), JSON.stringify(guards));
    } catch (e) {
        check('① 源码级守卫：能从源码取出 findStandNear', false, String(e?.message ?? e));
    }
}

/** 实现；取不到就整体失败（后面每条都会红，绝不假装通过）。 */
const fn = real ?? (() => { throw new Error('findStandNear 不可用'); });

/**
 * 反向验证用的**拷贝变异体**：把"脚下是不是树叶"那条判据去掉（只改内存字符串）。
 * 选这条是因为它最容易漏（树叶看着像实心，站上去会掉 —— 真机踩过 4 格自由落体被踢）。
 */
let mutant = null;
if (real) {
    try {
        const { text } = extractFindStandNear(srcText);
        const mutText = text.replace(/if \(\/_leaves\$\/\.test\(below\.name\)\) continue;/, '/* MUTANT: 去掉树叶判据 */');
        if (mutText === text) throw new Error('变异点没找到（源码写法变了）');
        mutant = compile(mutText);
    } catch (e) {
        check('反向验证：变异体可构造', false, String(e?.message ?? e));
    }
}

const ORE = { x: 0, y: 64, z: 0 };
const botWith = (cells, at = ORE) => makeFakeBot({ world: worldOf(cells), feet: { x: at.x, y: at.y, z: at.z } });

// ══════════════════════════════════════════════════════════════════════════
// 基本判据（脚下必须实心、非液体、非树叶）
// ══════════════════════════════════════════════════════════════════════════

// ② 有一格 air 且脚下实心 → 返回该格（最近，score=1）
{
    const bot = botWith([
        [1, 64, 0, 'air'], [1, 63, 0, 'stone'],
        [-1, 64, 0, 'stone'], [-1, 63, 0, 'stone'],
    ]);
    const r = fn(bot, ORE);
    check('② 有一格 air + 脚下实心 → 返回那一格',
        !!r && r.x === 1 && r.y === 64 && r.z === 0, `got=${JSON.stringify(r)}`);
}

// ③ 周围一个能站的都没有 → null
{
    const bot = botWith([
        [1, 64, 0, 'stone'], [-1, 64, 0, 'stone'],
        [0, 64, 1, 'stone'], [0, 64, -1, 'stone'],
    ]);
    const r = fn(bot, ORE);
    check('③ 周围全实心 → null（退回旧行为）', r === null, `got=${JSON.stringify(r)}`);
}

// ④ 脚下是 air（悬空）→ 不算可站 → null
{
    const bot = botWith([[1, 64, 0, 'air'], [1, 63, 0, 'air']]);
    const r = fn(bot, ORE);
    check('④ 脚下悬空（below=air）→ 不算可站，返回 null', r === null, `got=${JSON.stringify(r)}`);
}

// ⑤ 脚下是水 / 岩浆 → null；换成石头立刻选中（正向对照，排除"永远 null"的假绿）
{
    const r1 = fn(botWith([[1, 64, 0, 'air'], [1, 63, 0, 'water']]), ORE);
    check('⑤-1 脚下是水 → 不算可站，返回 null', r1 === null, `got=${JSON.stringify(r1)}`);

    const r2 = fn(botWith([[1, 64, 0, 'air'], [1, 63, 0, 'lava']]), ORE);
    check('⑤-2 脚下是岩浆 → 不算可站，返回 null', r2 === null, `got=${JSON.stringify(r2)}`);

    const r3 = fn(botWith([[1, 64, 0, 'air'], [1, 63, 0, 'stone']]), ORE);
    check('⑤-b 同一位置脚下换成石头 → 立刻选中（排除"永远返回 null"的假绿）',
        !!r3 && r3.x === 1, `got=${JSON.stringify(r3)}`);
}

// ⑥ blockAt 抛异常 → null（不许崩）
{
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        stubs: { blockAt: () => { throw new Error('世界读炸了'); } },
    });
    let crashed = false;
    let r = 'unset';
    try { r = fn(bot, ORE); } catch { crashed = true; }
    check('⑥ blockAt 抛异常 → 返回 null 且不抛（try/catch 兜住）', !crashed && r === null,
        `crashed=${crashed} got=${JSON.stringify(r)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ★ t68 新判据：树叶不算支撑 + 就近打分 + 范围放开到 ±3 / dy −6
// ══════════════════════════════════════════════════════════════════════════

// ⑦ 脚下是**树叶** → 不算可站（树叶会消失：站上去 4 格自由落体会被服务端判 invalid_move 踢）
//    + 反向验证：把「树叶判据」去掉的拷贝体会选中它 → 证明这条用例真盯着该判据
{
    const bot = botWith([[1, 64, 0, 'air'], [1, 63, 0, 'oak_leaves']]);
    const r = fn(bot, ORE);
    check('⑦-1 脚下是树叶(oak_leaves) → 不算可站，返回 null', r === null, `got=${JSON.stringify(r)}`);

    const m = mutant ? mutant(bot, ORE) : 'no-mutant';
    check('⑦-2 反向验证：去掉「树叶判据」的拷贝变异体会选中它（证明 ⑦-1 真盯着这条判据）',
        !!m && m.x === 1, `mutant=${JSON.stringify(m)}`);
}

// ⑧ 就近打分：多个可站点 → 取 `|dx|+|dz|+|dy|*1.5` 最小的那个
//    这里 (0,64,1) 与 (1,64,0) 都是 score=1，(0,63,0) 是 score=1.5（dy=-1 更贵）
//    → 结果必须是 score=1 的某个，绝不能选正下方 dy=-1 那个（否则"跳一格下去"不划算）
{
    const bot = botWith([
        [1, 64, 0, 'air'], [1, 63, 0, 'stone'],
        [0, 64, 1, 'air'], [0, 63, 1, 'stone'],
        [0, 63, 0, 'air'], [0, 62, 0, 'stone'],     // 正下方 dy=-1：score 1.5，应输给 score=1 的
    ]);
    const r = fn(bot, ORE);
    const score = r ? Math.abs(r.x - ORE.x) + Math.abs(r.z - ORE.z) + Math.abs(r.y - ORE.y) * 1.5 : Infinity;
    check('⑧ 就近打分：选 score 最小的（同层 1 格 优于 正下方 1 格）',
        !!r && score === 1 && r.y === 64, `got=${JSON.stringify(r)} score=${score}`);
}

// ⑨ ★★ 本次修复的核心场景：**树干在半空**（log 在 y=-55，地面在 y=-60）
//    旧版（同层四邻 + 脚下实心）在这里**必然全 null** → NO_REACH 降不下来。
//    新判据 dy 放到 -6 → 应当返回下面那层能站的格子 y=-59（below=y-60 是实心地面）。
for (const logY of [-55, -56, -57, -58]) {
    const at = { x: 0, y: logY, z: 0 };
    const bot = botWith([
        [0, -60, 0, 'stone'],                       // 地面（-60）
        [0, -59, 0, 'air'],                         // 唯一能站的一层（below = 地面）
    ], at);
    const r = fn(bot, at);
    check(`⑨ 树干在半空（log y=${logY}，地面 y=-60）→ 返回下方可站的 y=-59（旧版必 null）`,
        !!r && r.y === -59 && r.x === 0 && r.z === 0, `got=${JSON.stringify(r)}`);
}

// ⑩ 范围放开：能站的点在 **3 格远**（旧版 ±1 必然 null）
{
    const bot = botWith([
        [3, 64, 0, 'air'], [3, 63, 0, 'stone'],
    ]);
    const r = fn(bot, ORE);
    check('⑩ dx=3（3 格外才有的落点）→ 也能找到（旧版 ±1 会 null）',
        !!r && r.x === 3 && r.y === 64, `got=${JSON.stringify(r)}`);
}

// ⑪ dy=-6 边界：地面在 y-7 时也能找到（再深一层就该找不到了）
{
    const at = { x: 0, y: 64, z: 0 };
    const bot = botWith([
        [0, 57, 0, 'air'], [0, 56, 0, 'stone'],     // dy=-7：正好超出 dy>=-6
        [0, 58, 0, 'air'], [0, 57, 0, 'stone'],     // dy=-6：在范围内
    ], at);
    const r = fn(bot, at);
    check('⑪ dy 下界 -6：y-6 那层能找到、y-7 那层不在范围内', !!r && r.y === 58, `got=${JSON.stringify(r)}`);
}

// ⑫ 变异体与真身：在**正常**场景下结论必须一致（差异只出现在树叶那种边界）
{
    const bot = botWith([
        [1, 64, 0, 'air'], [1, 63, 0, 'stone'],
        [-1, 64, 0, 'stone'], [0, 64, 1, 'stone'],
    ]);
    const a = JSON.stringify(fn(bot, ORE));
    const b = mutant ? JSON.stringify(mutant(bot, ORE)) : 'no-mutant';
    check('⑫ 正常场景下真身与变异体结论一致（差异只在"脚下是树叶"这种边界）',
        a === b && mutant !== null, `real=${a} mutant=${b}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过  （产品文件未改动：函数体是从源码取出后编译运行的）`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
