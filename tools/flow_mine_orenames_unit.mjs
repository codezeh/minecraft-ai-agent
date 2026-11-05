/**
 * `oreNames`（`flow_mine.js`）守卫 —— t137 `3fdc35f`。
 *
 * 背景（真机第 57 跑）：`mine cobblestone c=3` → `failed «附近没有 cobblestone»` 连续三轮。
 *   权威：`getItemBlockSources('cobblestone')` → `["stone","cobblestone"]`
 *   旧逻辑：`cobblestone / cobblestone_ore / deepslate_cobblestone_ore`
 *   → **只搜"叫 cobblestone 的方块"（自然界几乎没有），从不搜 `stone`（地下满地）。**
 *   本质是**名字漂移于真相**：掉落物名 ≠ 方块名，而挖矿要找的是方块。
 *
 * ★ 本文件同时发现并标注了两处**仍活着的旧逻辑缺陷**（XFAIL，见 ⑥/⑧）：
 *   走"旧逻辑兜底"的分支（`getItemBlockSources` 返回空时，即**传的是方块名**）：
 *     · `deepslate_iron_ore` → `["deepslate_iron_ore","deepslate_deepslate_iron_ore"]`
 *       —— 既**丢了** `iron_ore`，又**产出** `deepslate_deepslate_*`
 *     · `stone` → `["stone","deepslate_stone","stone_ore","deepslate_stone_ore"]`
 *       —— 后三个方块在游戏里根本不存在
 *
 * 输出：PASS / FAIL / XFAIL(已知bug) / XPASS(已修好)，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import * as mc from '../src/utils/mcdata.js';
import { oreNames } from '../src/agent/library/flow_mine.js';

let pass = 0, fail = 0, xfail = 0, xpass = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
/** 已知 bug 用例：坏 → XFAIL（绿）；好了 → XPASS（提示改硬断言） */
const checkXfail = (name, ok, detail = '') => {
    if (ok) { xpass++; console.log(`XPASS ${name} —— 已修好，请改回硬断言 ${detail}`); }
    else { xfail++; console.log(`XFAIL(已知bug) ${name} ${detail}`); }
};

const names = (x) => oreNames(x);
const has = (x, n) => names(x).includes(n);

// ══════════════════════════════════════════════════════════════════════════
// ①-④ 掉落物名 → 必须含真实方块（**期望值来自 getItemBlockSources 交叉验证**，不硬编码）
// ══════════════════════════════════════════════════════════════════════════
const ITEM_CASES = [
    { n: '①', input: 'cobblestone', mustHave: 'stone', note: '★ 修复核心：挖 stone 掉 cobblestone' },
    { n: '②', input: 'raw_iron', mustHave: 'iron_ore', note: '铁的真实来源' },
    { n: '③', input: 'coal', mustHave: 'coal_ore', note: '' },
    { n: '④', input: 'diamond', mustHave: 'diamond_ore', note: '' },
];
for (const c of ITEM_CASES) {
    // 交叉验证：权威表里确实有它（避免我把期望写错）
    const auth = mc.getItemBlockSources?.(c.input) ?? [];
    const authOk = auth.includes(c.mustHave);
    check(`${c.n} oreNames('${c.input}') 必须含 '${c.mustHave}' ${c.note}`,
        has(c.input, c.mustHave),
        `got=${JSON.stringify(names(c.input))} 权威=${JSON.stringify(auth)}`);
    check(`${c.n}-b 交叉验证：getItemBlockSources('${c.input}') 确实含 '${c.mustHave}'（期望值有据）`,
        authOk, `权威=${JSON.stringify(auth)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤⑥ 方块名 → 旧逻辑
// ══════════════════════════════════════════════════════════════════════════
check('⑤ oreNames(\'iron_ore\') 必须含 deepslate_iron_ore', has('iron_ore', 'deepslate_iron_ore'), `got=${JSON.stringify(names('iron_ore'))}`);
checkXfail('⑥ oreNames(\'deepslate_iron_ore\') 必须含 iron_ore（反向也要能找）',
    has('deepslate_iron_ore', 'iron_ore'), `got=${JSON.stringify(names('deepslate_iron_ore'))}`);

// ══════════════════════════════════════════════════════════════════════════
// ⑦⑧ 不许有垃圾
// ══════════════════════════════════════════════════════════════════════════
{
    const got = names('oak_log');
    check('⑦ oreNames(\'oak_log\') 不许含 oak_log_ore / deepslate_oak_log_ore',
        !got.includes('oak_log_ore') && !got.includes('deepslate_oak_log_ore'), `got=${JSON.stringify(got)}`);
}
{
    // ⑧ 任取若干输入，都不许出现 `deepslate_deepslate_*`
    const ins = ['deepslate_iron_ore', 'deepslate_coal_ore', 'deepslate_diamond_ore', 'cobblestone', 'raw_iron', 'iron_ore'];
    const bad = [];
    for (const i of ins) for (const out of names(i)) if (/^deepslate_deepslate_/.test(out)) bad.push(`${i} → ${out}`);
    // 指纹：只有"传 deepslate_* 方块名"这条路径会产出它
    checkXfail('⑧ 任何输入都不许产出 `deepslate_deepslate_*`（第一版就产出过）',
        bad.length === 0, bad.length ? `违规：${JSON.stringify(bad)}` : '无');
}

// ══════════════════════════════════════════════════════════════════════════
// ⑨ ★ 反向验证：把实现改回旧逻辑（不调 getItemBlockSources）→ ① 必须红
//    做法：从源码文本里**抠出 oreNames 函数体** → 注入不同版本的 `mc` 编译 → 对比
// ══════════════════════════════════════════════════════════════════════════
const SRC = readFileSync('src/agent/library/flow_mine.js', 'utf8');
function extractOreNames(src) {
    const lines = src.split('\n');
    const i = lines.findIndex((L) => L.startsWith('export function oreNames('));
    if (i < 0) throw new Error('找不到 oreNames 定义');
    // ★ 别用 lines[j] === '}' 判断结尾 —— 这个仓库是 CRLF，行尾带回车符，严格相等永远不成立。
    //   改成**括号配平**（顺带对缩进/注释更稳）。
    //   改成**括号配平**（顺带对缩进/注释更稳）。
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
    /** 用给定的 mc 桩编译 oreNames */
    const makeOreNames = (mcImpl) => new Function('mc', `${implSrc}\nreturn oreNames;`)(mcImpl);

    // 真 mc（应当复现产品行为）
    const realFn = makeOreNames(mc);
    check('⑨-a 用真 mc 编译出来的 oreNames 与产品一致（cobblestone 含 stone）',
        realFn('cobblestone').includes('stone'), JSON.stringify(realFn('cobblestone')));

    // 旧逻辑等价：getItemBlockSources 返回空 → 走兜底分支 → 不含 stone
    const oldFn = makeOreNames({ getItemBlockSources: () => [] });
    const oldOut = oldFn('cobblestone');
    check('⑨ 反向验证：`getItemBlockSources` 失效时（= 旧逻辑）→ cobblestone **不含 stone**（① 必红）',
        !oldOut.includes('stone'), `oldLogic got=${JSON.stringify(oldOut)}`);

    // ⑩-d ★ 静默降级复现：mc 完全不可用（等价于"用了没 import"→ ReferenceError）
    //   注意：**它不抛错**，而是被 oreNames 自己的 try/catch 吞掉 → 静默退回旧逻辑
    const noMc = new Proxy({}, { get() { throw new ReferenceError('mc is not defined'); } });
    let threw = false, silentOut = null;
    try {
        const brokenFn = makeOreNames(noMc);
        silentOut = brokenFn('cobblestone');
    } catch { threw = true; }
    check('⑩-d ★ 复现"用了没 import"的静默降级：mc 不可用时 **不抛错**，返回旧逻辑结果',
        threw === false && !silentOut.includes('stone'),
        `threw=${threw} got=${JSON.stringify(silentOut)} ← 这就是"测试全绿但修复无效"的真相`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑩ ★★ import 守卫：「用了 mc.* 就必须 import * as mc」
//
//   事故（captain 自述）：第一版写了 `mc.getItemBlockSources(...)` 但 flow_mine.js **没 import mc**
//   → 抛错被 try/catch 吞 → **静默退回旧逻辑，修复完全无效，而 unit_all 全绿。**
//   功能测试抓不到它（测试里 import 是好的），所以必须在**源码层**断言。
// ══════════════════════════════════════════════════════════════════════════
{
    /** 守卫：源码里出现 `mc.<x>` 用法，就必须有 `import * as mc` */
    const mcImportGuard = (src) => {
        const usesMc = /\bmc\.\w+/.test(src);
        const hasImport = /import\s+\*\s+as\s+mc\s+from\s+['"][^'"]*mcdata\.js['"]/.test(src);
        return { ok: !usesMc || hasImport, usesMc, hasImport };
    };
    const g = mcImportGuard(SRC);
    check('⑩ flow_mine.js 用了 `mc.*` 就必须 `import * as mc from …mcdata.js`',
        g.ok === true, `usesMc=${g.usesMc} hasImport=${g.hasImport}`);

    // ⑩-b 具体点：`mc.getItemBlockSources` 那行确实存在（修复没被别人删掉）
    check('⑩-b 源码里 `mc.getItemBlockSources` 调用仍在（t137 的修复本体）',
        /mc\.getItemBlockSources\?\./.test(SRC), `found=${/mc\.getItemBlockSources/.test(SRC)}`);

    // ⑩-c 守卫敏感性：内存里删掉那行 import → 守卫必须报红
    const mutant = SRC.replace(/^import \* as mc from '\.\.\/\.\.\/utils\/mcdata\.js';$/m, '');
    const gm = mcImportGuard(mutant);
    check('⑩-c 反向验证：内存里删掉 `import * as mc` → 守卫报红（⑩ 会红）',
        gm.ok === false, `mutant usesMc=${gm.usesMc} hasImport=${gm.hasImport}`);
}

console.log('============================================');
console.log(`${pass} PASS / ${fail} FAIL / ${xfail} XFAIL(已知bug) / ${xpass} XPASS`);
if (xfail) console.log('注意：XFAIL 是**旧逻辑兜底分支**的已知缺陷（传方块名时），不是 t137 的修复失效。');
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
