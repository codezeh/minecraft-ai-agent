/**
 * `flow_mine.findStandNear` 离线回归（t68）—— 不需要服务器、**不改产品文件**。
 *
 * ── 这个文件要守住的三层改动（t67 → t68 → t70 → t71）────────────────────
 *   · `04933c5`（t68）：范围 `±1`/`dy 0..-3` → `±3`/`dy 0..-6`
 *   · `63e99f4`（t70）：`bot.blockAt(裸对象)` → `readBlock`（内部包 Vec3）
 *   · `d12a1bc`（t71）：**必须换列**（`dx===0 && dz===0` 一律 continue）
 *
 * ── 为什么不再 import 真函数 ────────────────────────────────────────────
 *   `flow_mine.js` 是多人在改的热文件。沿用 t65 的办法：
 *   **取源码文本 → 把函数体编译成可调用函数 → 跑用例**；
 *   反向验证只在**内存里的拷贝文本**上变异。产品文件一个字节都不动。
 *
 *   注意：t70 之后函数体依赖自由变量 `readBlock`（来自 query_perceive），
 *   所以编译时把它作为**参数注入**，注入实现与 `query_perceive.blockAt(bot,pos)` 同形：
 *   `bot.blockAt(new Vec3(p.x,p.y,p.z), false)`。
 *
 * ── ★★ 假件忠实度（本轮核心）────────────────────────────────────────────
 *   真链路：`bot.blockAt(p)` → `world.getBlock(p)` → `p.floored()`
 *   （`prismarine-world/src/world.js:229`）→ **裸对象 `{x,y,z}` 直接 TypeError**。
 *   t70 那个真机 bug（`stand=null ×130`）就是"传裸对象 → 抛错 → 被 catch 吞成 null"，
 *   而当时的假 bot **收裸对象**，于是单测全绿、真机全 null —— **假件太松 = 假绿**。
 *   现在 `tools/fixtures/fake_bot.mjs` 默认 `strictPoints: true`，
 *   本文件 ⓪ 再用一条**前置断言**把它钉住（谁把假件改宽松，这条立刻红）。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import Vec3 from 'vec3';
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const SRC_PATH = 'src/agent/library/flow_mine.js';

/** 抠出 `findStandNear` 的完整函数文本；抠不到就抛（绝不静默跳过）。 */
function extractFindStandNear(src) {
    const start = src.indexOf('function findStandNear(');
    if (start < 0) throw new Error('源码里找不到 `function findStandNear(`（被改名/删除了？）—— 本用例必须随之更新');
    const rest = src.slice(start);
    const m = rest.match(/\r?\n\}\r?\n/);            // 列 0 的单独一行 `}`（容忍 CRLF）
    if (m) return { text: rest.slice(0, m.index + m[0].indexOf('}') + 1), at: start };
    let depth = 0, started = false;                  // 兜底：数花括号
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '{') { depth++; started = true; }
        else if (rest[i] === '}') { depth--; if (started && depth === 0) return { text: rest.slice(0, i + 1), at: start }; }
    }
    throw new Error('找不到 findStandNear 的函数结尾（源码结构变了？）');
}

/** 与 `query_perceive.blockAt(bot,pos)` 同形：内部把裸坐标包成 Vec3。 */
const faithfulReadBlock = (bot, p) => bot.blockAt(new Vec3(p.x, p.y, p.z), false);

/** 把函数文本编译成可调用函数（`readBlock` 作为参数注入）。 */
function compile(fnText, readBlockImpl = faithfulReadBlock) {
    const body = fnText.trim().replace(/^function findStandNear/, 'function');
    return new Function('readBlock', `return (${body});`)(readBlockImpl);
}

let srcText = '', real = null;
try {
    srcText = readFileSync(SRC_PATH, 'utf8');
    const text = extractFindStandNear(srcText).text;
    real = compile(text);

    // ── ① 源码级守卫（对齐 t68 / t70 / t71）─────────────────────────────
    const guards = {
        feetAir: /\^\(air\|cave_air\|void_air\)\$/.test(text),
        noWaterLava: /\^\(water\|lava\)\$/.test(text),
        noLeaves: /\/_leaves\$\/\.test\(below\.name\)/.test(text),
        rangeXZ: /dx = -3; dx <= 3/.test(text),
        rangeY: /dy >= -6/.test(text),
        score: /Math\.abs\(dy\)\s*\*\s*1\.5/.test(text),
        mustChangeColumn: /if \(dx === 0 && dz === 0\) continue;/.test(text),   // t71
        usesReadBlock: /readBlock\(bot,/.test(text),                            // t70
    };
    check('① 源码级守卫：t68 范围 + t70 readBlock + t71 必须换列 + 脚下判据 全在',
        Object.values(guards).every(Boolean), JSON.stringify(guards));
} catch (e) {
    check('① 源码级守卫：能从源码取出并编译 findStandNear', false, String(e?.message ?? e));
}

const fn = real ?? (() => { throw new Error('findStandNear 不可用'); });

// ══════════════════════════════════════════════════════════════════════════
// ⓪ ★★ 假件忠实度前置守卫（本轮最有价值的一条）
//   假 bot 必须**比真 bot 更挑剔，不能更宽松** —— 否则测试是假绿。
// ══════════════════════════════════════════════════════════════════════════
{
    const strictBot = makeFakeBot({ world: worldOf([[0, 64, 0, 'stone']]) });
    let threw = null;
    try { strictBot.blockAt({ x: 0, y: 64, z: 0 }, false); } catch (e) { threw = e; }
    check('⓪-1 假件忠实度：blockAt(裸对象) 必须像真 mineflayer 一样抛 TypeError',
        threw instanceof TypeError, `threw=${threw?.constructor?.name ?? 'null（假件太松！）'}`);

    // 反向对照：显式 `strictPoints:false` 的假件不抛 —— 证明"抛"来自那个开关本身，
    // 也说明把它关掉就等于把这条守卫拆了。
    const lenientBot = makeFakeBot({ world: worldOf([[0, 64, 0, 'stone']]), strictPoints: false });
    let lenientThrew = false;
    try { lenientBot.blockAt({ x: 0, y: 64, z: 0 }, false); } catch { lenientThrew = true; }
    check('⓪-2 对照：strictPoints:false 的假件不抛（说明守卫真的在盯那个开关）',
        !lenientThrew, `lenientThrew=${lenientThrew}`);

    // Vec3 当然要能正常工作，否则假件就"挑剔到不能用"了
    let vecName = null;
    try { vecName = strictBot.blockAt(new Vec3(0, 64, 0), false)?.name; } catch { vecName = 'threw'; }
    check('⓪-3 Vec3 坐标照常工作（挑剔 ≠ 不能用）', vecName === 'stone', `got=${vecName}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ① ★ t70 回归守卫：把 `readBlock(bot, …)` 变异回 `bot.blockAt(裸对象, false)`
//    配合 ⓪ 的严格假件 → 变异体会抛 → 被函数内 catch 吞掉 → 返回 null。
// ══════════════════════════════════════════════════════════════════════════
let mutT70 = null;
try {
    const text = extractFindStandNear(srcText).text;
    const mutText = text.replace(/readBlock\(bot,\s*(\{[^{}]*\})\)/g, 'bot.blockAt($1, false) /* MUTANT t70 */');
    if (mutText === text) throw new Error('变异点没找到（readBlock(bot, …) 写法变了）');
    mutT70 = compile(mutText);
} catch (e) {
    check('①-t70 变异体可构造', false, String(e?.message ?? e));
}
{
    const bot = makeFakeBot({ world: worldOf([[1, 64, 0, 'air'], [1, 63, 0, 'stone']]), feet: { x: 0, y: 64, z: 0 } });
    const good = fn(bot, { x: 0, y: 64, z: 0 });
    const bad = mutT70 ? mutT70(bot, { x: 0, y: 64, z: 0 }) : 'no-mutant';
    check('①-t70 正常实现能找到落点', !!good && good.x === 1, `got=${JSON.stringify(good)}`);
    check('①-t70 反向验证：变异回「bot.blockAt(裸对象)」→ 被严格假件拒绝 → 返回 null（真机就是这个现象）',
        bad === null, `mutant=${JSON.stringify(bad)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 基本判据（脚下必须实心、非液体、非树叶、读炸不崩）
//   ⚠ t71 之后"必须换列"：候选必须与目标水平错开（dx 或 dz ≠ 0）
// ══════════════════════════════════════════════════════════════════════════
const ORE = { x: 0, y: 64, z: 0 };
const botWith = (cells, at = ORE) => makeFakeBot({ world: worldOf(cells), feet: { x: at.x, y: at.y, z: at.z } });

// ② 有一格 air + 脚下实心 → 返回该格
{
    const bot = botWith([
        [1, 64, 0, 'air'], [1, 63, 0, 'stone'],
        [-1, 64, 0, 'stone'], [-1, 63, 0, 'stone'],
    ]);
    const r = fn(bot, ORE);
    check('② 有一格 air + 脚下实心 → 返回那一格', !!r && r.x === 1 && r.y === 64 && r.z === 0, `got=${JSON.stringify(r)}`);
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

// ④ 脚下是 air（悬空）→ null
{
    const bot = botWith([[1, 64, 0, 'air'], [1, 63, 0, 'air']]);
    const r = fn(bot, ORE);
    check('④ 脚下悬空（below=air）→ 不算可站，返回 null', r === null, `got=${JSON.stringify(r)}`);
}

// ⑤ 脚下是水 / 岩浆 → null；换石头立刻选中（正向对照，排除"永远 null"的假绿）
{
    const r1 = fn(botWith([[1, 64, 0, 'air'], [1, 63, 0, 'water']]), ORE);
    check('⑤-1 脚下是水 → null', r1 === null, `got=${JSON.stringify(r1)}`);

    const r2 = fn(botWith([[1, 64, 0, 'air'], [1, 63, 0, 'lava']]), ORE);
    check('⑤-2 脚下是岩浆 → null', r2 === null, `got=${JSON.stringify(r2)}`);

    const r3 = fn(botWith([[1, 64, 0, 'air'], [1, 63, 0, 'stone']]), ORE);
    check('⑤-b 同位换成石头 → 立刻选中（排除"永远返回 null"的假绿）', !!r3 && r3.x === 1, `got=${JSON.stringify(r3)}`);
}

// ⑥ blockAt 抛异常 → null（不许崩）
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 }, stubs: { blockAt: () => { throw new Error('世界读炸了'); } } });
    let crashed = false, r = 'unset';
    try { r = fn(bot, ORE); } catch { crashed = true; }
    check('⑥ blockAt 抛异常 → 返回 null 且不抛（try/catch 兜住）', !crashed && r === null, `crashed=${crashed} got=${JSON.stringify(r)}`);
}

// ⑦ 脚下是树叶 → null；去掉"树叶判据"的拷贝变异体会选中它（反向验证）
let mutLeaves = null;
try {
    const text = extractFindStandNear(srcText).text;
    const mutText = text.replace(/if \(\/_leaves\$\/\.test\(below\.name\)\) continue;/, '/* MUTANT: 去掉树叶判据 */');
    if (mutText !== text) mutLeaves = compile(mutText);
} catch { /* 下面按 null 处理 */ }
{
    const bot = botWith([[1, 64, 0, 'air'], [1, 63, 0, 'oak_leaves']]);
    const r = fn(bot, ORE);
    const m = mutLeaves ? mutLeaves(bot, ORE) : 'no-mutant';
    check('⑦-1 脚下是树叶 → 不算可站，返回 null', r === null, `got=${JSON.stringify(r)}`);
    check('⑦-2 反向验证：去掉「树叶判据」的变异体会选中它（证明 ⑦-1 真盯着这条判据）',
        !!m && m.x === 1, `mutant=${JSON.stringify(m)}`);
}

// ⑧ 就近打分：多个可站点 → 取 `|dx|+|dz|+|dy|*1.5` 最小
{
    const bot = botWith([
        [1, 64, 0, 'air'], [1, 63, 0, 'stone'],       // score 1（同层 1 格）
        [0, 64, 1, 'air'], [0, 63, 1, 'stone'],       // score 1（同层 1 格，dz=1）
        [2, 64, 0, 'air'], [2, 63, 0, 'stone'],       // score 2（更远）
    ]);
    const r = fn(bot, ORE);
    const score = r ? Math.abs(r.x) + Math.abs(r.z) + Math.abs(r.y - ORE.y) * 1.5 : Infinity;
    check('⑧ 就近打分：选 score 最小的（同层 1 格）', !!r && score === 1 && r.y === 64, `got=${JSON.stringify(r)} score=${score}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑨ t68 边界：dy −6 / dx 3 找得到，再远一格就不在范围内
// ══════════════════════════════════════════════════════════════════════════
{
    const r6 = fn(botWith([[1, 58, 0, 'air'], [1, 57, 0, 'stone']]), ORE);   // dy=-6
    check('⑨-1 dy=-6（下界之内）能找到', !!r6 && r6.y === 58, `got=${JSON.stringify(r6)}`);

    const r7 = fn(botWith([[1, 57, 0, 'air'], [1, 56, 0, 'stone']]), ORE);   // dy=-7
    check('⑨-2 dy=-7（超出下界）→ 不找，返回 null', r7 === null, `got=${JSON.stringify(r7)}`);

    const r3 = fn(botWith([[3, 64, 0, 'air'], [3, 63, 0, 'stone']]), ORE);   // dx=3
    check('⑨-3 dx=3（范围之内）能找到', !!r3 && r3.x === 3, `got=${JSON.stringify(r3)}`);

    const r4 = fn(botWith([[4, 64, 0, 'air'], [4, 63, 0, 'stone']]), ORE);   // dx=4
    check('⑨-4 dx=4（超出 ±3）→ 不找，返回 null', r4 === null, `got=${JSON.stringify(r4)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑩ ★ t71 回归守卫：2×2 树干（y=-58..-54、地面 -60）→ 落点**必须不在树干列内**
//    反向验证：改回 t67 版（只跳 `dy===0`）→ 变异体会选中树干自己那一列（真机 NO_REACH 的形态）
// ══════════════════════════════════════════════════════════════════════════
function trunkWorld(logYs) {
    const cells = [];
    for (let x = 0; x <= 1; x++) {                       // 2×2 树干
        for (let z = 0; z <= 1; z++) {
            for (const y of logYs) cells.push([x, y, z, 'oak_log']);
            cells.push([x, -60, z, 'dirt']);             // 树干下面也是地面
        }
    }
    for (let x = -3; x <= 4; x++) {                      // 周围地面 + 空气
        for (let z = -3; z <= 4; z++) {
            cells.push([x, -60, z, 'grass_block']);
            cells.push([x, -59, z, 'air']);
        }
    }
    return cells;
}
let mutT71 = null;
try {
    const text = extractFindStandNear(srcText).text;
    const mutText = text.replace('if (dx === 0 && dz === 0) continue;', 'if (dx === 0 && dz === 0 && dy === 0) continue; /* MUTANT t67 */');
    if (mutText !== text) mutT71 = compile(mutText);
} catch { /* 下面按 null 处理 */ }
{
    const inTrunkCols = (r) => !!r && (r.x === 0 || r.x === 1) && (r.z === 0 || r.z === 1);
    const world = worldOf(trunkWorld([-58, -57, -56, -55, -54]));
    for (const y of [-54, -55, -56, -57, -58]) {
        const bot = makeFakeBot({ world, feet: { x: 0, y, z: 0 } });
        const r = fn(bot, { x: 0, y, z: 0 });
        check(`⑩ t71 树干(y=${y})：落点必须不在树干列内（否则寻路器走不进树干 → NO_REACH ×128）`,
            !!r && !inTrunkCols(r), `got=${JSON.stringify(r)} 树干内=${inTrunkCols(r)}`);

        const m = mutT71 ? mutT71(bot, { x: 0, y, z: 0 }) : 'no-mutant';
        check(`⑩-b t71 反向验证(y=${y})：改回 t67 版（只跳 dy===0）→ 变异体确实选中树干列（证明用例抓的是真差异）`,
            inTrunkCols(m), `mutant=${JSON.stringify(m)} 树干内=${inTrunkCols(m)}`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过  （产品文件未改动：函数体从源码取出后编译；假件按真 mineflayer 挑剔）`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
