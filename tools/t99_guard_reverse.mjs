#!/usr/bin/env node
/**
 * 变异（mutation）反向验证器 —— 证明「门禁的护栏真的会红」。
 *
 * ★ 为什么要这个工具（2026-11-04，t99）：
 *   今晚把「扫到 0 个样本 = 通过」这一类假绿全部加了护栏（`requireScanned`）。
 *   但**加了护栏 ≠ 护栏有效** —— 必须能证明"把输入弄空，门禁真的会红"。
 *   "改完看着对"今晚栽过多次（ENOENT 当 A 档、锚点插错、过滤器太宽、`\n` 转义）。
 *
 * ★★ 本工具最核心的一条：**锚点唯一性断言**
 *
 *   今晚"锚点匹配"这个方法踩了 **3 次**（control 跨行锚点遇 CRLF 静默 SKIP、
 *   captain 的 anchor 匹配到第一个相似片段把 `obtain` 注入插进了 `smelt` 绑定）。
 *
 *   共同点：**锚点匹配到别处时不会报错，它只是"改了另一个地方"**，
 *   而你看到的症状会指向别处（工具崩了 / A 档有货 / 那例被 SKIP）。
 *   所以：**执行变异之前，必须先断言锚点在全文里恰好出现 1 次**；
 *   != 1 就**报错退出**（exit 2），**绝不静默跳过**。
 *
 * 判据三条（缺一不可）：
 *   1. 锚点唯一（恰好 1 次）—— 防"改错对象"
 *   2. 变异后 preflight **exit=1** —— 防"护栏是摆设"
 *   3. 还原后 preflight **exit=0** 且**逐字节还原** —— 防"改测试迁就代码"
 *
 * 用法：
 *   node tools/t99_guard_reverse.mjs            # 全量（5 个变异，约 3~5 分钟）
 *   node tools/t99_guard_reverse.mjs --list     # 只列变异，不执行
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TARGET = join(REPO, 'tools', 'preflight.mjs');
const TARGET_REL = 'tools/preflight.mjs';

/** 统计 needle 在 haystack 里出现几次（按字面量，不解释正则）。 */
function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let n = 0, i = 0;
    for (;;) {
        const at = haystack.indexOf(needle, i);
        if (at < 0) return n;
        n++;
        i = at + needle.length;
    }
}

/**
 * 每个变异：把某段的"扫描输入"清 0，期望门禁因此变红。
 * ★ anchor 必须**单行 + 完整语句**（跨行锚点会被 CRLF 坑：`\n` ≠ `\r\n`）。
 */
const CASES = [
    {
        name: '[1] 模块导入（0 个模块）',
        anchor: 'const files = walk(ROOT);',
        mutate: (s) => s.replace('const files = walk(ROOT);', 'const files = walk(ROOT); files.length = 0;'),
        expectMsg: /扫到 0 个模块/,
    },
    {
        name: '[3b] 错误码审计（0 个 src 文件）',
        anchor: "})(path2.join(projectRoot2, 'src'));",
        mutate: (s) => s.replace("})(path2.join(projectRoot2, 'src'));", "})(path2.join(projectRoot2, 'src')); files2.length = 0;"),
        expectMsg: /扫到 0 个\s*src 源文件/,
    },
    {
        name: '[4] API 扫描（0 个源文件）',
        anchor: 'const sources = collectApiScanSources();',
        mutate: (s) => s.replace('const sources = collectApiScanSources();', 'const sources = collectApiScanSources(); sources.length = 0;'),
        expectMsg: /扫到 0 个源文件/,
    },
    {
        name: '[4b] API 扫描（0 条规则）',
        anchor: 'const active = API_SCAN_RULES.filter((r) => r.enabled !== false);',
        mutate: (s) => s.replace('const active = API_SCAN_RULES.filter((r) => r.enabled !== false);',
            'const active = API_SCAN_RULES.filter((r) => r.enabled !== false); active.length = 0;'),
        expectMsg: /扫到 0 个启用中的规则/,
    },
    {
        name: '[5] 前缀规矩（0 个源文件）',
        anchor: "const sources = collectApiScanSources().filter((s) => s.path.startsWith('src/agent/'));",
        mutate: (s) => s.replace("const sources = collectApiScanSources().filter((s) => s.path.startsWith('src/agent/'));",
            "const sources = collectApiScanSources().filter((s) => s.path.startsWith('src/agent/')); sources.length = 0;"),
        expectMsg: /扫到 0 个源文件/,
    },
];

/** 跑一次 preflight，返回 { code, out }。 */
function runPreflight() {
    try {
        const out = execFileSync(process.execPath, [TARGET], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
}

// ── --list ────────────────────────────────────────────────────────────────
if (process.argv.includes('--list')) {
    console.log(`变异用例 ${CASES.length} 个（目标 ${TARGET_REL}）：`);
    for (const c of CASES) console.log(`  · ${c.name}\n      anchor: ${c.anchor}`);
    process.exit(0);
}

const orig = readFileSync(TARGET, 'utf8');

// ★★ 第一步：**先做锚点唯一性断言**（全部用例一起查，一次报清），再动任何字节。
//    这一步放在最前面：宁可"一条都不改就退出"，也不要"改错一半再回滚"。
{
    const bad = [];
    for (const c of CASES) {
        const n = countOccurrences(orig, c.anchor);
        if (n !== 1) bad.push({ name: c.name, anchor: c.anchor, n });
    }
    if (bad.length) {
        console.error(`✗ 锚点唯一性断言失败（必须恰好出现 1 次；出现 0 次=锚点过时，>1 次=会改错对象）:`);
        for (const b of bad) console.error(`   · ${b.name}: 锚点出现 ${b.n} 次 → "${b.anchor}"`);
        console.error('  **不做任何变异，直接退出** —— 静默跳过/改错对象比不验更危险。');
        process.exit(2);
    }
    console.log(`✓ 锚点唯一性断言通过（${CASES.length} 个锚点各恰好 1 次）\n`);
}

let pass = 0, fail = 0;
for (const c of CASES) {
    const mutated = c.mutate(orig);
    if (mutated === orig) {
        fail++;
        console.log(`  FAIL  ${c.name} → 变异没生效（replace 未改变内容）`);
        continue;
    }
    try {
        writeFileSync(TARGET, mutated, 'utf8');
        const { code, out } = runPreflight();
        const msgHit = c.expectMsg.test(out);
        if (code === 1 && msgHit) { pass++; console.log(`  PASS  ${c.name} → exit=1，且命中预期报错`); }
        else { fail++; console.log(`  FAIL  ${c.name} → exit=${code} 命中预期报错=${msgHit}`); }
    } finally {
        writeFileSync(TARGET, orig, 'utf8');    // 逐例即时还原
    }
}

// ── 还原校验：必须逐字节一致 + 门禁复绿 ────────────────────────────────
{
    const now = readFileSync(TARGET, 'utf8');
    if (now !== orig) { fail++; console.log('  FAIL  还原不是逐字节一致（文件被污染）'); }
    else { pass++; console.log('  PASS  还原逐字节一致'); }
}
{
    const { code } = runPreflight();
    if (code === 0) { pass++; console.log('  PASS  还原后 preflight exit=0'); }
    else { fail++; console.log(`  FAIL  还原后 preflight exit=${code}`); }
}

console.log(`\n变异反向验证：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
