/**
 * `strat_obtain` 的「反向配方降级」（t103/t104）+ `cycles` 独立出口（t106）—— 离线守卫。
 *
 * 为什么要有这个文件：这两处改动今晚只做了**真机实测**，没有单测：
 *   · t103/t104 让**铁/金/铜全链 1/15 → 13/15 可执行**（把"反向配方/能熔炼"的合成源降到所有自然来源之后）
 *   · t106 把"成环"从 `gaps` 里分出独立出口 `cycles`（`gaps` 仍然包含它，兼容上层）
 *
 * ★ 反向验证的做法（本文件不 import 真函数、**也不改 `strat_obtain.js`** —— control 可能在改它）：
 *   ① **源码级守卫**：断言关键判据那几行还在（`isReverseRecipe(c) || hasSmeltSrc` 等）
 *   ② **守卫敏感性自检**：把源码文本在内存里改坏（删掉 `|| hasSmeltSrc`），
 *      同一套守卫必须报 false —— 证明"删了会红"不是空话
 *   ③ 行为用例跑**真的** `planObtain()`
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import { planObtain } from '../src/agent/library/strat_obtain.js';
import * as stratObtainModule from '../src/agent/library/strat_obtain.js';

/** 真实的 sourcesOf（若模块没导出就退回空表 —— 只影响 ④-6 的 fallback） */
const realSourcesOf = stratObtainModule.sourcesOf ?? (() => []);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const SRC = readFileSync('src/agent/library/strat_obtain.js', 'utf8');

// ══════════════════════════════════════════════════════════════════════════
// ① 源码级守卫 + 敏感性自检
// ══════════════════════════════════════════════════════════════════════════
/** 这套守卫就是"删了会红"的探测器；对"改坏的文本"必须报 false。 */
function stratGuards(src) {
    return {
        // 反向配方降级：craft 源在"是反向配方 **或** 有熔炼源"时被降级到后面
        reverseDowngrade: /isReverseRecipe\s*\(\s*c\s*\)\s*\|\|\s*hasSmeltSrc/.test(src),
        reverseDetector: /const\s+isReverseRecipe\s*=/.test(src) && /hasOwnProperty\.call\(\s*r\s*,\s*name\s*\)/.test(src),
        smeltSrcFlag: /const\s+hasSmeltSrc\s*=\s*!!smeltSrc/.test(src),
        // cycles 独立出口：成环时**同时**记 cycles 和 gaps（gaps 保留兼容）
        cyclesRecorded: /cycles\[name\]\s*=\s*\(cycles\[name\]\s*\?\?\s*0\)\s*\+\s*need/.test(src),
        gapsStillGetsCycle: /gaps\[name\]\s*=\s*\(gaps\[name\]\s*\?\?\s*0\)\s*\+\s*need;\s*\/\/\s*保留/.test(src),
        cyclesExported: /cycles,\s*\/\/\s*★\s*t73/.test(src),
    };
}
{
    const g = stratGuards(SRC);
    check('①-1 源码守卫：反向配方降级判据 `isReverseRecipe(c) || hasSmeltSrc` 在',
        g.reverseDowngrade && g.smeltSrcFlag, JSON.stringify(g));
    check('①-2 源码守卫：`isReverseRecipe` 会查"配方里有没有我自己"（真检测器，不是恒 false）',
        g.reverseDetector, `reverseDetector=${g.reverseDetector}`);
    check('①-3 源码守卫：成环时 `cycles` 与 `gaps` 都记（gaps 保留兼容）',
        g.cyclesRecorded && g.gapsStillGetsCycle, JSON.stringify({ c: g.cyclesRecorded, g: g.gapsStillGetsCycle }));
    check('①-4 源码守卫：`cycles` 作为独立字段返回',
        g.cyclesExported, `cyclesExported=${g.cyclesExported}`);

    // ★ 敏感性自检：把源码改坏 → 守卫必须报 false（证明 ①-1/①-3 真的会红）
    const broken1 = SRC.replace('isReverseRecipe(c) || hasSmeltSrc', 'isReverseRecipe(c)');
    check('①-5 反向验证（删 `|| hasSmeltSrc`）→ 守卫立刻报 false（用例 ①-1 会红）',
        stratGuards(broken1).reverseDowngrade === false, 'guard=false ✓');

    const broken2 = SRC.replace('const isReverseRecipe = (craftSrc) => {', 'const isReverseRecipe = (craftSrc) => { return false;');
    check('①-6 反向验证（`isReverseRecipe` 一进来 return false）→ reverseDowngrade 仍匹配？',
        // 注意：这个变异**不改**调用处，所以守卫仍然匹配 —— 它靠下面的**行为用例**抓（见 ④-1/④-2）
        stratGuards(broken2).reverseDowngrade === true,
        '源码守卫抓不到"函数体被短路"，所以 ④ 必须有行为用例 ← 这正是本文件的重点');

    const broken3 = SRC.replace('gaps[name] = (gaps[name] ?? 0) + need;   // 保留：上层仍按 gaps 算总缺口', '');
    check('①-7 反向验证（删掉成环处的 gaps 累加）→ 守卫报 false（用例 ①-3 会红）',
        stratGuards(broken3).gapsStillGetsCycle === false, 'guard=false ✓');
}

// ══════════════════════════════════════════════════════════════════════════
// ② 行为用例：反向配方降级（t103/t104）
// ══════════════════════════════════════════════════════════════════════════
const plan = (item) => planObtain({ item, count: 1, inventory: {}, chests: {} });
/** 有没有"被降级的反向配方"逐步（reverse:true）—— 有 = 降级生效 */
const reverseSteps = (r) => r.plan.filter((s) => s.reverse === true);
const stepOf = (r, pred) => r.plan.find(pred);

// ④-1 iron_pickaxe：铁锭必须走**熔炼**，不是"反向合成成铁锭"
{
    const r = plan('iron_pickaxe');
    const smeltStep = stepOf(r, (s) => s.skill === 'smelt');
    const mineIron = stepOf(r, (s) => s.skill === 'mine' && (s.args?.ore === 'raw_iron'));
    const good = r.ok === true
        && !!smeltStep && smeltStep.source === 'smelt' && smeltStep.args?.input === 'raw_iron'
        && !!mineIron
        && Object.keys(r.gaps).length === 0;
    check('④-1 iron_pickaxe：铁锭走 `smelt`（不是反向合成），且 gaps === {}',
        good, smeltStep ? `smelt input=${smeltStep.args?.input} gaps=${JSON.stringify(r.gaps)}` : `无 smelt 步：${JSON.stringify(r.plan.map((s) => s.skill + ':' + (s.args?.item ?? s.args?.input ?? s.args?.ore)))}`);
}

// ④-2 raw_iron：首步就是 mine（不是反向合成 raw_iron）
{
    const r = plan('raw_iron');
    const good = r.ok === true && r.plan.length === 1
        && r.plan[0].skill === 'mine' && r.plan[0].source === 'collect'
        && Object.keys(r.gaps).length === 0;
    check('④-2 raw_iron：首步 = `mine`（不是 `craft`），gaps === {}',
        good, `steps=${JSON.stringify(r.plan.map((s) => s.skill + ':' + (s.args?.item ?? s.args?.ore)))}`);
}

// ④-3 crafting_table：正常走 craft，**不能**被降级成 mine:crafting_table
{
    const r = plan('crafting_table');
    const first = r.plan[0];
    const badMine = stepOf(r, (s) => s.skill === 'mine' && s.args?.ore === 'crafting_table');
    const good = r.ok === true && first?.skill === 'craft' && first?.args?.item === 'crafting_table'
        && first?.source === 'craft' && !badMine && reverseSteps(r).length === 0
        && Object.keys(r.gaps).length === 0;
    check('④-3 crafting_table：正常 `craft`（不被降级成 mine:crafting_table）',
        good, `first=${first?.skill}:${first?.args?.item} reverse=${reverseSteps(r).length}`);
}

// ④-4 wooden_pickaxe：拆单**逐字不变**（第一夜物品不受降级影响）
{
    const r = plan('wooden_pickaxe');
    const seq = r.plan.map((s) => `${s.skill}:${s.args?.item ?? s.args?.input ?? s.args?.ore ?? ''}x${s.args?.count ?? ''}`);
    // 任务书给的就是：planks×3 / log×1 / stick×2 / planks×2 / log×1
    const want = [
        'craft:wooden_pickaxex1',
        'craft:oak_planksx3',
        'mine:oak_logx1',
        'craft:stickx2',
        'craft:oak_planksx2',
        'mine:oak_logx1',
    ];
    check('④-4 wooden_pickaxe：拆单逐字不变（planks×3 / log×1 / stick×2 / planks×2 / log×1）',
        JSON.stringify(seq) === JSON.stringify(want) && reverseSteps(r).length === 0,
        `got=${JSON.stringify(seq)}`);
}

// ④-5 copper_ingot：**两跳间接反向**也必须降级 → 首步 = smelt（不是蜡铜块那条）
{
    const r = plan('copper_ingot');
    const first = r.plan[0];
    const good = r.ok === true && first?.skill === 'smelt' && first?.source === 'smelt'
        && first?.args?.input === 'raw_copper'
        && Object.keys(r.gaps).length === 0;
    check('④-5 copper_ingot：两跳间接反向也被降级 → 首步 = `smelt`（`|| hasSmeltSrc` 这条判据的守卫）',
        good, `first=${first?.skill}:${first?.args?.input ?? first?.args?.item} gaps=${JSON.stringify(r.gaps)}`);
}

// ── ④-6 ★ 判据敏感性（替代"把 isReverseRecipe 改成 return false"的真变异）──
//   任务书要求的反向验证是"把 `isReverseRecipe` 改成 return false → 用例 1、2 必须红"。
//   但本轮**禁止改 `strat_obtain.js`**（control 在改），所以改用它的**注入口**
//   `deps.sourcesOf` 造同样效果：让 iron_ingot **只有 craft 源、没有 smelt 源**。
//   → ④-1 的判据（"必须有一个 smelt 步"）必然不成立。
//   这证明 ④-1 不是"怎么写都会绿"的假用例：
//     ①-6 已经证明**源码守卫抓不到**"函数体被短路"；
//     ④-6 证明**行为用例抓得到**"来源里没 smelt"。
{
    const r = planObtain({
        item: 'iron_pickaxe', count: 1, inventory: {}, chests: {},
        deps: {
            sourcesOf: (n) => (n === 'iron_ingot'
                ? [{ type: 'craft', item: 'iron_ingot', recipe: { raw_iron: 1 }, cost: 10 }]  // 没有 smelt
                : realSourcesOf(n)),
        },
    });
    const hasSmelt = r.plan.some((x) => x.skill === 'smelt');
    check('④-6 判据敏感性：把 iron_ingot 的 smelt 源抽掉 → 计划里**没有** smelt 步（④-1 会红）',
        hasSmelt === false, `hasSmelt=${hasSmelt}（④-1 要求 true）`);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ cycles 与 gaps 的关系（t106）：cycles 非空时 gaps 必须也非空（兼容上层）
// ══════════════════════════════════════════════════════════════════════════
{
    // 造一个必然成环的物品：A 需要 B，B 需要 A。用注入的 sourcesOf 保证确定性。
    const cyclic = {
        a: [{ type: 'craft', item: 'a', recipe: { b: 1 }, cost: 10 }],
        b: [{ type: 'craft', item: 'b', recipe: { a: 1 }, cost: 10 }],
    };
    const r = planObtain({
        item: 'a', count: 1, inventory: {}, chests: {},
        deps: { sourcesOf: (n) => cyclic[n] ?? [] },
    });
    const hasCycles = Object.keys(r.cycles ?? {}).length > 0;
    const hasGaps = Object.keys(r.gaps ?? {}).length > 0;
    // 判据：**只要 cycles 非空，gaps 也必须非空**（上层仍按 gaps 算总缺口/兼容旧逻辑）
    const good = hasCycles && hasGaps;
    check('③-1 `cycles` 非空时 `gaps` 也必须非空（gaps 保留兼容上层）',
        good, `cycles=${JSON.stringify(r.cycles)} gaps=${JSON.stringify(r.gaps)}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
