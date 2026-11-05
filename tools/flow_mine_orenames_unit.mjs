/**
 * `oreNames`（`flow_mine.js`）守卫 —— t137 `3fdc35f`，含 `35860ce` 的补充修复。
 *
 * 背景（真机第 57 跑）：`mine cobblestone c=3` → `failed «附近没有 cobblestone»` 连续三轮。
 *   权威：`getItemBlockSources('cobblestone')` → `["stone","cobblestone"]`
 *   旧逻辑：`cobblestone / cobblestone_ore / deepslate_cobblestone_ore`
 *   → **只搜"叫 cobblestone 的方块"（自然界几乎没有），从不搜 `stone`（地下满地）。**
 *   本质是**名字漂移于真相**：掉落物名 ≠ 方块名，而挖矿要找的是**方块**。
 *
 * 本文件覆盖三类风险：
 *   ① 掉落物名 → 真实方块（t137 的修复本体）
 *   ② 方块名 → 深/浅层双向（`35860ce` 修的 `deepslate_*` 双前缀与丢 `iron_ore`）
 *   ③ **真实调用形态**（`mine(bot,'iron',3)` 这种简写）—— `35860ce` 回滚过一次的坑
 *   ⑩ **"用了没 import 被 catch 吞掉"的静默降级**（源码断言 + 坏依赖复现）
 *
 * 输出：PASS / FAIL，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import mcDataFactory from 'minecraft-data';
import * as mc from '../src/utils/mcdata.js';
import { oreNames } from '../src/agent/library/flow_mine.js';

const REG = mcDataFactory('1.21.8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const names = (x) => oreNames(x);
const has = (x, n) => names(x).includes(n);

// ══════════════════════════════════════════════════════════════════════════
// ①-④ 掉落物名 → 必须含真实方块（期望值用 getItemBlockSources 交叉验证，不硬编码）
// ══════════════════════════════════════════════════════════════════════════
const ITEM_CASES = [
    { n: '①', input: 'cobblestone', mustHave: 'stone', note: '★ 修复核心：挖 stone 掉 cobblestone' },
    { n: '②', input: 'raw_iron', mustHave: 'iron_ore', note: '铁的真实来源' },
    { n: '③', input: 'coal', mustHave: 'coal_ore', note: '' },
    { n: '④', input: 'diamond', mustHave: 'diamond_ore', note: '' },
];
for (const c of ITEM_CASES) {
    const auth = mc.getItemBlockSources?.(c.input) ?? [];
    check(`${c.n} oreNames('${c.input}') 必须含 '${c.mustHave}' ${c.note}`,
        has(c.input, c.mustHave), `got=${JSON.stringify(names(c.input))} 权威=${JSON.stringify(auth)}`);
    check(`${c.n}-b 交叉验证：getItemBlockSources('${c.input}') 确实含 '${c.mustHave}'（期望值有据）`,
        auth.includes(c.mustHave), `权威=${JSON.stringify(auth)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤⑥ 方块名 → 深/浅层双向（⑥ 曾是 XFAIL，35860ce 修好后转硬断言）
//    ★ 为什么必须转硬断言：XFAIL 修好后若仍留 `checkXfail`，
//      **回归时会重新变回 XFAIL 而照样全绿** —— 那时它就不再是守卫了。
// ══════════════════════════════════════════════════════════════════════════
check("⑤ oreNames('iron_ore') 必须含 deepslate_iron_ore",
    has('iron_ore', 'deepslate_iron_ore'), `got=${JSON.stringify(names('iron_ore'))}`);
check("⑥ oreNames('deepslate_iron_ore') 必须含 iron_ore（深/浅层双向都能找）",
    has('deepslate_iron_ore', 'iron_ore'), `got=${JSON.stringify(names('deepslate_iron_ore'))}`);

// ══════════════════════════════════════════════════════════════════════════
// ⑦⑧ 不许有垃圾（⑧ 也曾是 XFAIL）
// ══════════════════════════════════════════════════════════════════════════
{
    const got = names('oak_log');
    check("⑦ oreNames('oak_log') 不许含 oak_log_ore / deepslate_oak_log_ore",
        !got.includes('oak_log_ore') && !got.includes('deepslate_oak_log_ore'), `got=${JSON.stringify(got)}`);
}
{
    const ins = ['deepslate_iron_ore', 'deepslate_coal_ore', 'deepslate_diamond_ore', 'cobblestone', 'raw_iron', 'iron_ore', 'stone'];
    const bad = [];
    for (const i of ins) for (const out of names(i)) if (/^deepslate_deepslate_/.test(out)) bad.push(`${i} → ${out}`);
    check('⑧ 任何输入都不许产出 `deepslate_deepslate_*`（第一版就产出过）',
        bad.length === 0, bad.length ? `违规：${JSON.stringify(bad)}` : '无');
}
{
    // ⑧-b：旧逻辑对普通方块会造出不存在的 `<x>_ore` / `deepslate_<x>_ore`（`stone_ore` 那种）
    const fake = names('stone').filter((n) => /(^|_)stone_ore$/.test(n));
    check('⑧-b 不许凭空造出不存在的 `stone_ore` / `deepslate_stone_ore`',
        fake.length === 0, fake.length ? `违规：${JSON.stringify(fake)}` : `got=${JSON.stringify(names('stone'))}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑨ ★ 反向验证：把实现改回旧逻辑（不调 getItemBlockSources）→ ① 必须红
//    做法：从源码**括号配平**抠出 oreNames 函数体 → 编译 → 注入不同版本的 `mc` 对比
//    （不碰真文件；CRLF 仓库里别用 `lines[j] === '}'` 判断结尾）
// ══════════════════════════════════════════════════════════════════════════
const SRC = readFileSync('src/agent/library/flow_mine.js', 'utf8');
function extractOreNames(src) {
    const lines = src.split('\n');
    const i = lines.findIndex((L) => L.startsWith('export function oreNames('));
    if (i < 0) throw new Error('找不到 oreNames 定义');
    let depth = 0, end = -1;
    for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        if (j > i && depth <= 0) { end = j; break; }
    }
    if (end < 0) throw new Error('找不到 oreNames 结尾（括号没配平）');
    return lines.slice(i, end + 1).join('\n').replace('export function', 'function');
}
let implSrc = null;
try { implSrc = extractOreNames(SRC); } catch (e) { check('⑨ 能从源码抠出 oreNames 函数体', false, String(e?.message ?? e)); }

if (implSrc) {
    const makeOreNames = (mcImpl) => new Function('mc', `${implSrc}\nreturn oreNames;`)(mcImpl);

    const realFn = makeOreNames(mc);
    check("⑨-a 用真 mc 编译出的 oreNames 与产品一致（cobblestone 含 stone）",
        realFn('cobblestone').includes('stone'), JSON.stringify(realFn('cobblestone')));

    const oldOut = makeOreNames({ getItemBlockSources: () => [] })('cobblestone');
    check('⑨ 反向验证：`getItemBlockSources` 失效（= 旧逻辑）→ cobblestone **不含 stone**（① 必红）',
        !oldOut.includes('stone'), `oldLogic got=${JSON.stringify(oldOut)}`);

    // ⑩-d ★ 静默降级复现：mc 完全不可用（等价于"用了没 import"→ ReferenceError）
    //   **它不抛错**，而是被 oreNames 自己的 try/catch 吞掉 → 静默退回旧逻辑
    const noMc = new Proxy({}, { get() { throw new ReferenceError('mc is not defined'); } });
    let threw = false, silent = null;
    try { silent = makeOreNames(noMc)('cobblestone'); } catch { threw = true; }
    check('⑩-d ★ 复现"用了没 import"的静默降级：mc 不可用时**不抛错**，返回旧逻辑结果',
        threw === false && !silent.includes('stone'),
        `threw=${threw} got=${JSON.stringify(silent)} ← 这就是"测试全绿但修复无效"的真相`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑩ ★★ import 守卫：「用了 mc.* 就必须 import * as mc」
//   事故：第一版写了 `mc.getItemBlockSources(...)` 但 `flow_mine.js` **没 import mc**
//   → 抛错被 try/catch 吞 → **静默退回旧逻辑，修复完全无效，而 unit_all 全绿。**
//   功能测试抓不到它（测试文件自己 import 是好的），所以必须在**源码层**断言。
// ══════════════════════════════════════════════════════════════════════════
{
    const mcImportGuard = (src) => {
        const usesMc = /\bmc\.\w+/.test(src);
        const hasImport = /import\s+\*\s+as\s+mc\s+from\s+['"][^'"]*mcdata\.js['"]/.test(src);
        return { ok: !usesMc || hasImport, usesMc, hasImport };
    };
    const g = mcImportGuard(SRC);
    check('⑩ flow_mine.js 用了 `mc.*` 就必须 `import * as mc from …mcdata.js`',
        g.ok === true, `usesMc=${g.usesMc} hasImport=${g.hasImport}`);

    check('⑩-b 源码里 `mc.getItemBlockSources` 调用仍在（t137 的修复本体没被删）',
        /mc\.getItemBlockSources\?\./.test(SRC), `found=${/mc\.getItemBlockSources/.test(SRC)}`);

    const mutant = SRC.replace(/^import \* as mc from '\.\.\/\.\.\/utils\/mcdata\.js';$/m, '');
    const gm = mcImportGuard(mutant);
    check('⑩-c 反向验证：内存里删掉 `import * as mc` → 守卫报红（⑩ 会红）',
        gm.ok === false, `mutant usesMc=${gm.usesMc} hasImport=${gm.hasImport}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑪⑫ ★★ 真实调用形态守卫（来自 `35860ce` 那次"修好 A 弄坏 B"的事故）
//
//   事故：修 ⑥⑧ 时把「没带 `_ore` 就补 `_ore`」整段删掉，理由是"真正的矿石名本来就是 `*_ore`"。
//   **但调用方常传简写**：`mine(bot, 'iron', 3)`（本仓库 tools 里 11 处都是这么调的）
//   → `oreNames('iron')` 不含 `iron_ore` → 三个 flow_mine 测试全 `NO_TARGET`。
//
//   判据（结果型、与实现无关）：**每种真实调用形态都必须至少解析出一个"游戏里真实存在的方块"**。
//   否则症状永远是"附近没有 X"（永远不是"名字算错"），排查会跑偏。
// ══════════════════════════════════════════════════════════════════════════
{
    // 形态取自 `grep -rhoE "ore: '[a-z_]+'" src tools` 的真实取值，不是我想的
    const REAL_FORMS = ['iron', 'raw_iron', 'redstone', 'raw_gold', 'raw_copper',
        'lapis_lazuli', 'emerald', 'diamond', 'coal', 'cobblestone', 'stone'];
    const noRealBlock = [];
    for (const f of REAL_FORMS) {
        const real = names(f).filter((n) => !!REG.blocksByName[n]);
        if (!real.length) noRealBlock.push(`${f} → ${JSON.stringify(names(f))}`);
    }
    check('⑪ 每种**真实调用形态**都至少解析出一个真实方块（否则必然"附近没有 X"）',
        noRealBlock.length === 0,
        noRealBlock.length ? `无真实方块：${JSON.stringify(noRealBlock)}` : `${REAL_FORMS.length} 种全都有`);

    check("⑫ 简写 'iron' 必须含 iron_ore（那次回滚就是把它弄丢了）",
        has('iron', 'iron_ore'), `got=${JSON.stringify(names('iron'))}`);

    const viaIron = names('iron').filter((n) => REG.blocksByName[n]);
    const viaRaw = names('raw_iron').filter((n) => REG.blocksByName[n]);
    const overlap = viaIron.filter((n) => viaRaw.includes(n));
    check('⑫-b 简写 iron 与掉落物 raw_iron 解析出的真实方块有交集（能挖到同一处矿）',
        overlap.length > 0,
        `iron=${JSON.stringify(viaIron)} raw_iron=${JSON.stringify(viaRaw)} 交集=${JSON.stringify(overlap)}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
// ══════════════════════════════════════════════════════════════════════════
// ⑪-反向 ★ 把「补 `_ore` 的猜测」禁掉（= 35860ce 那次回滚的写法）→ ⑪⑫ 必须红
//   这条是 ⑪⑫ 的**鉴别器证明**：没有它，⑪⑫ 可能只是"怎么写都绿"。
// ══════════════════════════════════════════════════════════════════════════
if (implSrc) {
    // 变异点：`if (!stem.endsWith('_ore') && !isPlainBlock) {` → `if (false) {`
    const mutBody = implSrc.replace(
        `if (!stem.endsWith('_ore') && !isPlainBlock) {`,
        'if (false) { /* MUTANT: 删掉补 _ore 的猜测 */',
    );
    const mutated = mutBody !== implSrc;
    check('⑪-反向 变异点存在（源码里那行 `if (!stem.endsWith(...) && !isPlainBlock)` 还在）',
        mutated, `mutated=${mutated}`);

    if (mutated) {
        const mutFn = new Function('mc', `${mutBody}
return oreNames;`)(mc);
        const REAL_FORMS = ['iron', 'raw_iron', 'redstone', 'raw_gold', 'raw_copper',
            'lapis_lazuli', 'emerald', 'diamond', 'coal', 'cobblestone', 'stone'];
        const bad = REAL_FORMS.filter((x) => !mutFn(x).some((n) => !!REG.blocksByName[n]));
        check('⑪-反向验证：禁掉补 `_ore` 猜测 → 有形态**解析不出任何真实方块**（⑪ 会红）',
            bad.length > 0, `变异后无真实方块：${JSON.stringify(bad)}（真实形态：${JSON.stringify(mutFn('iron'))}）`);
        check('⑫-反向验证：禁掉补 `_ore` 猜测 → `iron` 不含 iron_ore（⑫ 会红）',
            !mutFn('iron').includes('iron_ore'), `变异后 got=${JSON.stringify(mutFn('iron'))}`);
    }
}

console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
