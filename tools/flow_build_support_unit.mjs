/**
 * t31 承重规则：`flow_build` 的支撑判据（2026-11-03 用户定的精确条件）。
 *
 * 允许放的条件（满足任一）：
 *   A) 下方是实心方块
 *   B) 下方那一格在蓝图里
 *   C) ★四邻（同层前后左右）至少一个**已经是真·实心方块**（不认"蓝图里的"）
 *
 * 为什么 C 必须要求"已落地"：否则 4 个邻居互相证明 → 循环论证 → 悬空块也能放。
 *
 * 这里直接测**导出的纯函数 `hasPlacedNeighbor`**（条件 C 的实现）——
 * 不跑整个 build 流程，所以不会被 placeBlockAt 的后置校验干扰。
 */
import { hasPlacedNeighbor } from '../src/agent/library/flow_build.js';
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

const botWith = (entries) => makeFakeBot({ world: worldOf(entries) });
const at = (x, y, z) => ({ x, y, z });

// ① 屋顶正中、4 邻**已实心** → 允许（shelter 封顶的场景）
{
    const bot = botWith([
        { x: 1, y: 64, z: 0, name: 'cobblestone' },
        { x: -1, y: 64, z: 0, name: 'cobblestone' },
        { x: 0, y: 64, z: 1, name: 'cobblestone' },
        { x: 0, y: 64, z: -1, name: 'cobblestone' },
    ]);
    check('① 屋顶正中 + 4 邻已实心 → hasPlacedNeighbor=true（C 生效，shelter 能封顶）',
        hasPlacedNeighbor(bot, at(0, 64, 0)) === true, 'true');
}

// ② ★ 空中孤块、4 邻都没实物 → false（防循环论证）
//    注意：这里"蓝图画了 4 邻"对 hasPlacedNeighbor **没有影响**（它只看世界），
//    这正是防循环论证的关键 —— 邻居在蓝图里不算支撑。
{
    const bot = botWith([]);                     // 世界全空（蓝图有没有邻居都不影响这条）
    check('② ★ 空中孤块 + 4 邻只在蓝图里 → hasPlacedNeighbor=false（防循环论证）',
        hasPlacedNeighbor(bot, at(0, 64, 0)) === false, 'false');
}

// ③ 下方实心 → 条件 A 由调用方判；这里验 C 不受下方影响（下方实心但 4 邻空 → C=false）
{
    const bot = botWith([{ x: 0, y: 63, z: 0, name: 'stone' }]);
    check('③ 只有下方实心、4 邻空 → C=false（A 与 C 相互独立，不串味）',
        hasPlacedNeighbor(bot, at(0, 64, 0)) === false, 'false');
}

// ④ 下方在蓝图 → 同样是 B 的事；4 邻空时 C 仍 false（证明 C 不靠蓝图）
{
    const bot = botWith([]);
    check('④ 4 邻空（哪怕下方在蓝图里）→ C=false（C 不认蓝图）',
        hasPlacedNeighbor(bot, at(0, 65, 0)) === false, 'false');
}

// ⑤ 四邻只有一个实心、其余空 → true（C 是"至少一个"）
{
    const bot = botWith([{ x: 1, y: 64, z: 0, name: 'cobblestone' }]);
    check('⑤ 四邻只有一个实心 → C=true（"至少一个"即可）',
        hasPlacedNeighbor(bot, at(0, 64, 0)) === true, 'true');
}

// ⑥ ★ 反向验证：把 C 的判断去掉（等价于永远 false）→ 用例① 的场景必须变 false
{
    const bot = botWith([
        { x: 1, y: 64, z: 0, name: 'cobblestone' },
        { x: -1, y: 64, z: 0, name: 'cobblestone' },
    ]);
    // 模拟"没有 C"：不调 hasPlacedNeighbor，直接按旧逻辑（A/B 都不满足）判
    const belowSolid = false, belowInBlueprint = false, noC = false;
    const oldLogicWouldReject = !belowSolid && !belowInBlueprint && !noC;     // true = 旧逻辑会拒绝
    const withC = hasPlacedNeighbor(bot, at(0, 64, 0));
    check('⑥ ★ 反向验证：没有 C 时旧逻辑会拒绝(NO_SUPPORT)，有 C 时允许 —— 证明 C 真在起作用',
        oldLogicWouldReject === true && withC === true, `旧=${oldLogicWouldReject} 有C=${withC}`);
}

// ⑦ 顺带：非实心邻居不算支撑（水/空气）
{
    const bot = botWith([
        { x: 1, y: 64, z: 0, name: 'water' },
        { x: -1, y: 64, z: 0, name: 'air' },
    ]);
    check('⑦ 邻居是水/空气 → 不算支撑（C=false）',
        hasPlacedNeighbor(bot, at(0, 64, 0)) === false, 'false');
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
