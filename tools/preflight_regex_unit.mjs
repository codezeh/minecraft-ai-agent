#!/usr/bin/env node
// preflight 审计正则自检（T02 / 报告第 26 条的配套）。
//
// 为什么要有这个文件
// ------------------
// preflight 的错误码审计曾带着两个 0x08（退格）字节前缀上线：正则要求"字面退格"才匹配，
// 于是**永不命中** → used2 恒空 → 恒打印「✓ 错误码审计通过」。这道门从上线起没检过任何东西。
//
// 这个 bug 的可怕之处不是"写错了"，而是**报错形态和被检查干净时一模一样**：
//   "扫到 0 处" == "扫了 162 个文件、没有违规"
// 所以光靠人眼看 preflight 的输出永远发现不了。必须有一个东西**专门证明扫描器还看得见**。
//
// 设计要点（别改成"自证式断言"）
// ------------------------------
// 1. **正则不是抄来的**：本文件用正则从 `tools/preflight.mjs` 源码里**抽出真身**
//    （CODE_AUDIT_REGEXES 与 SAW_A_SECTION 两块常量），再拿去喂样本。
//    抄一份副本过来断言"副本能匹配"，那种测试只能证明我没打错字，证明不了生产代码是对的。
// 2. **每条都给正反两面样本**：能命中（正例）+ 不该命中（反例）。
//    只有正例时，"永远匹配"的坏正则也能通过。
// 3. **整文件控制字符扫描**：0x08 这一族不留任何余地 —— 只要 preflight 里出现控制字符就红。
//
// 用法：
//   node tools/preflight_regex_unit.mjs              # 检查默认的 tools/preflight.mjs
//   node tools/preflight_regex_unit.mjs <path>       # 检查指定文件（用于"改之前/改之后"对照）
// 退出码：0 = 全绿；1 = 有红项。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(HERE, 'preflight.mjs');

let failed = 0;
let passed = 0;

function ok(name, detail = '') {
    passed++;
    // 行首 PASS —— tools/unit_all.mjs 按 `^\s*PASS` 数用例，本文件要被它自动纳入就得守这个约定。
    console.log(`  PASS  ${name}${detail ? `　${detail}` : ''}`);
}
function bad(name, detail) {
    failed++;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`     ${detail}`);
}
function assert(cond, name, detail) {
    if (cond) ok(name, detail);
    else bad(name, detail);
}

console.log(`preflight 审计正则自检`);
console.log(`目标文件：${TARGET}\n`);

let src;
try {
    src = readFileSync(TARGET, 'utf8');
} catch (e) {
    console.log(`  ✗ 读不到目标文件：${e.message}`);
    process.exit(1);
}

// ---------- 1. 整文件控制字符扫描（0x08 这一族的根治） ----------
// 允许的只有正常的换行/制表；其余 C0 控制字符一律不许出现在源码里。
console.log('[1/3] 控制字符扫描 —— 扫描器自己坏了，后面所有"0 处"都不可信');
{
    const badChars = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        for (const ch of lines[i]) {
            const c = ch.codePointAt(0);
            if (c < 0x20 && c !== 0x09 /* tab */) {
                badChars.push(`第 ${i + 1} 行：0x${c.toString(16).padStart(2, '0')}`);
            }
            if (c === 0x7f) badChars.push(`第 ${i + 1} 行：0x7f (DEL)`);
        }
    }
    const hits = badChars.slice(0, 8);
    assert(badChars.length === 0, '源码里没有控制字符（0x08 退格等）',
        badChars.length ? `发现 ${badChars.length} 处：${hits.join('；')}` : `共 ${lines.length} 行，干净`);
}

// ---------- 2. 从源码抽出真正则 ----------
console.log('\n[2/3] 从 preflight.mjs 源码里抽出审计正则（不是抄副本）');
function extractBlock(name, srcText) {
    // 匹配 `const NAME = [ ... ];` 或 `const NAME = /.../;`
    const head = `const ${name} = `;
    const at = srcText.indexOf(head);
    if (at < 0) return null;
    const rest = srcText.slice(at + head.length);
    if (rest.startsWith('[')) {
        const end = rest.indexOf('\n];');
        if (end < 0) return null;
        return rest.slice(0, end + 3);          // 含 '\n];'
    }
    const lineEnd = rest.indexOf(';\n');
    if (lineEnd < 0) return null;
    return rest.slice(0, lineEnd + 1);          // 含 ';'
}

function evalLiteral(literal) {
    // 只 eval 从**本仓库自己的源码**里抽出来的常量字面量（不做任何外部输入）。
    // eslint-disable-next-line no-new-func
    return new Function(`return ${literal};`)();
}

let codeRegexes = null;
let sawASection = null;
{
    const codeLit = extractBlock('CODE_AUDIT_REGEXES', src);
    const sawLit = extractBlock('SAW_A_SECTION', src);

    if (!codeLit) {
        bad('抽不出 CODE_AUDIT_REGEXES（常量被改名/改成动态拼接了？）',
            '这条自检依赖它存在且是字面量数组 —— 见 preflight.mjs 里的注释。');
    } else {
        try {
            codeRegexes = evalLiteral(codeLit);
            assert(Array.isArray(codeRegexes) && codeRegexes.length >= 2,
                'CODE_AUDIT_REGEXES 是可求值的数组', `共 ${codeRegexes?.length ?? 0} 条`);
        } catch (e) {
            bad('CODE_AUDIT_REGEXES 求值失败', e.message);
        }
    }

    if (!sawLit) {
        bad('抽不出 SAW_A_SECTION（§6 的指纹正则被改名了？）');
    } else {
        try {
            sawASection = evalLiteral(sawLit);
            assert(sawASection instanceof RegExp, 'SAW_A_SECTION 是正则', String(sawASection));
        } catch (e) {
            bad('SAW_A_SECTION 求值失败', e.message);
        }
    }
}

// ---------- 3. 喂已知样本：正例必须命中，反例必须不命中 ----------
console.log('\n[3/3] 已知样本（正例命中 / 反例不命中）');

// 从正则里读回它的捕获组数量，取第一个捕获组的值
function hits(re, s) {
    re.lastIndex = 0;
    const out = [];
    for (const m of s.matchAll(re)) out.push(m[1]);
    return out;
}

if (codeRegexes) {
    const [reFail, reOkObj] = codeRegexes;

    // --- 3.1 fail('XXX') ---
    if (!(reFail instanceof RegExp)) {
        bad('第 1 条不是正则（应该是 fail() 那条）');
    } else {
        assert(hits(reFail, `return fail('NO_TARGET', '没目标')`).includes('NO_TARGET'),
            '[fail] 正例命中：fail(\'NO_TARGET\', …)', '← 0x08 时代这条会命中 0 次');
        assert(hits(reFail, `const r = fail('DIED');`).includes('DIED'),
            '[fail] 正例命中：fail(\'DIED\')', '（能命中 ≠ 该码已注册，注册由 §3 判）');
        assert(hits(reFail, `fail( code )`).length === 0,
            '[fail] 反例不命中：参数是变量 fail( code )');
        assert(hits(reFail, `// 注释里提到 fail('GHOST') 不该被当代码`).includes('GHOST'),
            '[fail] 已知局限：注释里的写法也会被算作使用', '（宁左勿右：报出来好过人看漏）');
    }

    // --- 3.2 ActionResult 字面量 { ok: …, code: 'XXX' } ---
    if (!(reOkObj instanceof RegExp)) {
        bad('第 2 条不是正则（应该是 ActionResult 字面量那条）');
    } else {
        assert(hits(reOkObj, `return { ok: false, code: 'WINDOW_CLOSED', message: '没开容器' };`)
            .includes('WINDOW_CLOSED'), '[字面量] 正例命中：{ ok: false, code: … } 同一行');
        assert(hits(reOkObj, `return {\n    ok: false,\n    code: 'NO_FLOOR',\n    why: '空的'\n};`)
            .includes('NO_FLOOR'), '[字面量] 正例命中：跨行写法');
        // 反例：任务板的停止/结果码，是另一套词汇表，不该被当错误码
        assert(hits(reOkObj, `result: { code: 'DIED', at: now }`).length === 0,
            '[字面量] 反例不命中：任务板结果载荷 result: { code: \'DIED\', at }');
        assert(hits(reOkObj, `failed.push({ pos, code: 'NO_SUPPORT' })`).length === 0,
            '[字面量] 反例不命中：数据载荷 failed.push({ pos, code })');
        assert(hits(reOkObj, `const x = { ok: true, code: 'OK' };`).includes('OK'),
            '[字面量] 正例命中：ok: true 的码也算（OK 本身由 §3 的 dup 检查管）');
    }
}

// --- 3.3 §6 指纹正则（原 :933 那处 0x08） ---
if (sawASection instanceof RegExp) {
    const t = (s) => { sawASection.lastIndex = 0; return sawASection.test(s); };
    assert(t('── A·策略 3 条'), '[§6] 正例命中：── A·策略');
    assert(t('A·策略'), '[§6] 正例命中：行首 A·策略', '← 0x08 只在三条备选之一上，另两条本来就好的');
    assert(t('未发现"有早退分支但生产不提供"的情况'), '[§6] 正例命中：未发现… 兜底文案');
    assert(!t('── C·需要人判断 13 条'), '[§6] 反例不命中：C 档段落');
}

// ---------- 汇总 ----------
console.log(`\n${failed === 0 ? '✓ 全绿' : '✗ 有红项'}：${passed} 通过，${failed} 失败。`);if (failed === 0) {
    console.log('说明：本文件只证明"扫描器看得见"，不判断被扫描代码是否合规 —— 那是 preflight 的职责。');
}
process.exit(failed === 0 ? 0 : 1);
