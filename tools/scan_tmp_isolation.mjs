/**
 * 扫描 `tools/` 下的**并发隐患**：固定 tmp 路径 + 开跑先删。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要这个扫描器（真实事故，不是理论风险）：
 *   `tools/board_open_migrate_unit.mjs` 原来用**固定**目录 `tmp/board-open-test`，
 *   且开跑第一件事是 `rmSync(DIR, {recursive:true, force:true})`。
 *   于是**同机两路 `unit_all`**（或两路并发跑测试）会：
 *     A 建目录 → B 把同一目录 rm 掉 → A 的下一句 writeFileSync/ENOENT → 随机变红。
 *   现场表现就是"整跑随机红、单跑全绿"，9 次里能碰上 1~2 次。
 *
 *   危害不在"红一次"：它把**真实回归伪装成环境抖动**，久而久之所有人都学会
 *   "重跑一下就好"，直到某天真正的回归被重跑掉。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 判据（不是靠肉眼看命名，是两条同时成立）：
 *   ① 出现**固定** tmp 路径：字符串字面量里的 `tmp/xxx`，或 `join('tmp', 'xxx')`；
 *   ② 同一文件里既有 `rmSync(` / `rm -rf`。
 *   ——隔离的做法（`mkdtempSync` / `os.tmpdir()` / 路径里拼 `process.pid`）任一出现即视为**已隔离**。
 *
 * ★ 本文件自己也要靠得住：扫描器必须**先剥注释再匹配**（本仓已经因为
 *   "注释里的样本被当成真命中" / "正则被控制字符弄坏" 栽过好几次）。
 *   所以它自带 `--selftest`：用一段同时含"注释里的假样本"和"代码里的真样本"的文本，
 *   断言**只报真样本**。扫描器自己没被验过，它给的红绿都不作数。
 *
 * 用法：
 *   node tools/scan_tmp_isolation.mjs            # 打印清单（永远 exit 0，供人读）
 *   node tools/scan_tmp_isolation.mjs --check    # 有未处置项就 exit 1（可挂 CI）
 *   node tools/scan_tmp_isolation.mjs --selftest # 只验扫描器本身
 *   node tools/scan_tmp_isolation.mjs --leftovers # 列（并可 --purge）%TEMP% 里的测试残留目录
 */
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();

// ───────────────────────────────────────────────────────────────────────────
// ① 剥注释（保留字符串）—— 不用正则糊弄：字符串里也有 `//`，正则一定会错
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把注释替换成等长空白（**保留行号**），字符串/模板串原样保留。
 *
 * @param {string} src
 * @returns {string} 同样行数、同样长度的"只剩代码"的文本
 */
export function stripComments(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    let quote = null;
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];

        if (quote) {
            out.push(c);
            if (c === '\\') {              // 转义：把下一个字符整体带过
                if (i + 1 < n) { out.push(src[i + 1]); i += 2; continue; }
                i += 1; continue;
            }
            if (c === quote) quote = null;
            i += 1;
            continue;
        }

        if (c === '/' && c2 === '/') {     // 行注释 → 吃到行尾
            while (i < n && src[i] !== '\n') { out.push(' '); i += 1; }
            continue;
        }
        if (c === '/' && c2 === '*') {     // 块注释 → 吃掉但保留换行，行号不错位
            i += 2; out.push(' ', ' ');
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                out.push(src[i] === '\n' ? '\n' : ' ');
                i += 1;
            }
            if (i < n) { out.push(' ', ' '); i += 2; }
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; out.push(c); i += 1; continue; }
        out.push(c);
        i += 1;
    }
    return out.join('');
}

// ───────────────────────────────────────────────────────────────────────────
// ② 判据
// ───────────────────────────────────────────────────────────────────────────

/** 固定 tmp 路径的三种写法（会命中的都是"与别人共用一个目录"的形态） */
const FIXED_TMP_PATTERNS = [
    { id: 'string-literal', re: /(['"`])tmp[\\/][^'"`\n]*/g },
    { id: 'join-tmp', re: /join\(\s*(['"`])tmp\1\s*,/g },
];

/** 已隔离的形态：出现任一即认为这个文件不会和别人共用目录 */
const ISOLATED_MARKERS = [
    { id: 'mkdtempSync', re: /\bmkdtempSync\s*\(/ },
    { id: 'os.tmpdir', re: /\btmpdir\s*\(\s*\)/ },
    { id: 'process.pid', re: /process\.pid/ },
    { id: 'randomUUID', re: /randomUUID\s*\(/ },
];

/** "开跑先删"的形态 */
const RM_PATTERNS = [
    { id: 'rmSync', re: /\brmSync\s*\(/g },
    { id: 'rm -rf', re: /\brm\s+-rf\b/g },
];

/** 行号（1 起） */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * 分析一段源码。
 * @param {string} src
 * @returns {{fixed:Array<{line:number, text:string, kind:string}>, rms:Array<{line:number, text:string, kind:string}>, isolated:string[]}}
 */
export function analyse(src) {
    const code = stripComments(src);
    const fixed = [];
    for (const { id, re } of FIXED_TMP_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code)) !== null) {
            fixed.push({ line: lineOf(code, m.index), text: m[0].trim(), kind: id });
        }
    }
    const rms = [];
    for (const { id, re } of RM_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code)) !== null) {
            rms.push({ line: lineOf(code, m.index), text: m[0], kind: id });
        }
    }
    const isolated = [];
    for (const { id, re } of ISOLATED_MARKERS) {
        if (re.test(code)) isolated.push(id);
    }
    // 去重（同一行同一形态只报一次）
    const uniq = (arr) => {
        const seen = new Set();
        return arr.filter((x) => {
            const k = `${x.line}|${x.kind}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    };
    return { fixed: uniq(fixed), rms: uniq(rms), isolated };
}

/**
 * **确实不能改成隔离**的（每条都要写清为什么）—— 扫描器会把它们单列，
 * 并且会在结尾断言"清单里每一条都还在"，避免这份豁免表变成僵尸。
 */
export const EXEMPTIONS = [
    {
        file: 'tools/bench_move_actions.mjs',
        why: '**基准脚本，不是测试**：它把结果写到仓库内 tmp/bench/ 供人对照历史，'
            + '并在开始前清掉自己的输出目录。unit_all 不会跑它（不是 *_unit.mjs、不在 UNITS），'
            + '两路并发跑基准本身没有意义 —— 基准比的正是"独占机器时的表现"。',
    },
    {
        file: 'tools/bench_deepwater.mjs',
        why: '**基准脚本，不是测试**：它按设计把结果写到仓库内的 tmp/bench-* 供人对照历史，'
            + 'unit_all 不会跑它（不是 *_unit.mjs / 不在 UNITS），两路并发跑基准本身没有意义。',
    },
    {
        file: 'tools/bench_move_baseline.mjs',
        why: '同上：人工触发的基准脚本。',
    },
    {
        file: 'tools/_dbg_scan.mjs',
        why: '**未被 git 跟踪**的临时调试脚本（2026-11-01 的手工脚本，直连真实服务器做地形扫描），'
            + '不在仓库里、也不在 unit_all 名单里。**建议由它的作者删除**；'
            + '在它被删掉之前扫描器会一直看到它，所以先在此列明"为什么不改"'
            + '（改了等于替别人保管一个不该入库的东西，删了又可能打断对方正在做的排查）。',
    },
    {
        file: 'tools/restart_bot.mjs',
        why: '运维脚本（重启 bot），**要的就是**仓库内固定路径的 pid/日志；不在 unit_all 名单里。',
    },
    {
        file: 'tools/t51_triple_round.mjs',
        why: '人工真机三轮演练脚本（要连服务器），不在 unit_all 名单里；tmp 路径是给人事后翻日志的。',
    },
];

/** 递归列 tools/ 下的 .mjs（跳过 node_modules / tmp） */
function listTools(dir = join(ROOT, 'tools')) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...listTools(p));
        else if (name.endsWith('.mjs')) out.push(p);
    }
    return out;
}

/** 只扫**会被 unit_all 调度**的脚本（这里用"是不是单测/在登记表里"近似，最终以 unit_all 的名单为准） */
function isTestLike(relPath) {
    return /_unit\.mjs$/.test(relPath) || /^tools\/test_.*\.mjs$/.test(relPath) || /^tools\/flow_.*\.mjs$/.test(relPath);
}

// ───────────────────────────────────────────────────────────────────────────
// ③ 自检：扫描器自己先被验一遍
// ───────────────────────────────────────────────────────────────────────────
// 行号是断言的一部分，改这段请同步改下面的 [4,5,7] / [2,3]
// 1: (模板串开头的空行)
// 2: 行注释里的**假样本** —— 必须不被报
// 3: 块注释里的**假样本** —— 必须不被报
// 4: 代码里的固定 tmp（join 形态）—— 必须被报
// 5: 代码里的固定 tmp（字符串形态）—— 必须被报
// 6: rmSync —— 必须被认出来
// 7: 字符串里带 // 的行 —— 剥注释不许把 `//` 后面的代码吃掉，必须仍报 tmp
const SELFTEST_FIXTURE = `
// 注释里的假样本：const DIR = join('tmp', 'fake-comment');  rmSync(DIR);
/* 块注释里的假样本：tmp/block-comment  rmSync(x) */
const realFixed = join('tmp', 'real-shared-dir');
const alsoReal = 'tmp/another-shared';
rmSync(realFixed, { recursive: true, force: true });
const tricky = 'a//b' + 'tmp/in-string';
`;

function selftest() {
    const a = analyse(SELFTEST_FIXTURE);
    const lines = a.fixed.map((x) => x.line);
    const problems = [];
    // 注释里的两处（第 2、3 行）必须**不出现**
    if (lines.includes(2) || lines.includes(3)) problems.push('注释里的样本被当成了真命中');
    // 代码里的三处必须出现（第 4、5、7 行）
    for (const want of [4, 5, 7]) if (!lines.includes(want)) problems.push(`漏报第 ${want} 行`);
    // rm 必须被发现
    if (!a.rms.length) problems.push('rmSync 没被认出来');
    // 字符串里的 // 不能把后面的内容吃掉（第 7 行还能被找到就说明没吃）
    console.log(problems.length ? `✗ 自检失败：${problems.join('；')}` : '✓ 自检通过：注释里的样本被忽略、代码里的真样本 3 处全中、字符串里的 // 没误判');
    return problems.length === 0;
}

// ───────────────────────────────────────────────────────────────────────────
// ④ 残留目录报告（--leftovers）
//
// 为什么需要它：测试改成 mkdtempSync 之后，"清理"这一步在 Windows 上**经常删不掉** ——
//   `node:sqlite` 的句柄要等进程退出才关，而 rmSync 是在退出之前跑的 ⇒ EPERM。
//   我们按验收要求让"清理失败不变红"，但这不等于可以**假装清理成功**：
//   残留必须**看得见**。这个子命令把 %TEMP% 里属于本仓测试的目录列出来（含体积），
//   于是它可以被顺手清掉，也可以被将来挂进 CI（超过 N 个就告警）。
// ───────────────────────────────────────────────────────────────────────────

/** 本仓测试用过的目录前缀（与各测试里的 mkdtempSync(prefix) 对应） */
export const TMP_PREFIXES = [
    'board-b3-test-', 'board-b4-test-', 'board-iface-test-', 'board-lease-test-',
    'board-openonly-test-', 'board-open-test-', 'board-orphan-test-', 'board-stop-test-',
    'board-converge-test-', 'board-finish-test-', 'board-test-', 'shared-chest-test-',
    'board-cmd-test-',
];

function dirSize(dir) {
    let bytes = 0;
    let entries = [];
    try { entries = readdirSync(dir); } catch { return 0; }
    for (const f of entries) {
        try { bytes += statSync(join(dir, f)).size; } catch { /* 忽略不可读项 */ }
    }
    return bytes;
}

/**
 * @returns {{dir:string, size:number}[]}
 */
export function findLeftovers(tmpDir = os.tmpdir()) {
    let names = [];
    try { names = readdirSync(tmpDir); } catch { return []; }
    return names
        .filter((n) => TMP_PREFIXES.some((p) => n.startsWith(p)))
        .map((n) => ({ dir: join(tmpDir, n), size: dirSize(join(tmpDir, n)) }));
}

function reportLeftovers(argv) {
    const purge = argv.includes('--purge');
    const items = findLeftovers();
    if (!items.length) {
        console.log('残留测试目录：0 个（干净）');
        return;
    }
    const total = items.reduce((a, b) => a + b.size, 0);
    console.log(`残留测试目录：${items.length} 个，合计 ${(total / 1024).toFixed(0)} KB（在 ${os.tmpdir()}）`);
    console.log('  ★ 说明：清理这一步在 Windows 上常因 node:sqlite 句柄未关而 EPERM；');
    console.log('    这些目录在**进程退出后**即可删除，体积很小，不是仓库内容。');
    for (const it of items.slice(0, 20)) console.log(`  · ${it.dir}`);
    if (items.length > 20) console.log(`  … 另有 ${items.length - 20} 个`);
    if (purge) {
        let n = 0;
        for (const it of items) { try { rmSync(it.dir, { recursive: true, force: true }); n += 1; } catch { /* 还有进程占用 */ } }
        console.log(`  --purge：已删除 ${n}/${items.length} 个`);
    } else {
        console.log('  （加 --purge 可尝试现在删除）');
        console.log('  ⚠ --purge **只在没有测试在跑时用**：它不区分"正在被并发运行的测试所用"的目录。');
    }
}

// ───────────────────────────────────────────────────────────────────────────
// ⑤ 主流程
// ───────────────────────────────────────────────────────────────────────────
function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
    if (argv.includes('--leftovers')) { reportLeftovers(argv); process.exit(0); }

    const files = listTools();
    const rows = [];
    for (const abs of files) {
        const rel = relative(ROOT, abs).split('\\').join('/');
        const src = readFileSync(abs, 'utf8');
        const a = analyse(src);
        if (!a.fixed.length) continue;
        const exempt = EXEMPTIONS.find((e) => e.file === rel);
        const risky = a.fixed.length > 0 && a.rms.length > 0 && a.isolated.length === 0;
        rows.push({ rel, ...a, exempt, risky, testLike: isTestLike(rel) });
    }

    console.log('扫描范围：tools/**/*.mjs =' + files.length + ' 个文件');
    console.log('');
    const needFix = rows.filter((r) => r.risky && !r.exempt);
    const alreadyOk = rows.filter((r) => !r.risky);
    const exempted = rows.filter((r) => r.exempt);

    console.log('── A) 【固定 tmp + 开跑先删 + 无隔离】需要处置 ─────────────────');
    if (!needFix.length) console.log('  （空）');
    for (const r of needFix) {
        const locs = r.fixed.map((f) => `${f.line}: ${f.text}`).join(' | ');
        console.log(`  ✗ ${r.rel}  [${r.testLike ? '被 unit_all 调度' : '非单测'}]`);
        console.log(`      tmp 位置 → ${locs}`);
        console.log(`      rm 位置  → ${r.rms.map((x) => x.line).join(',')}`);
    }

    console.log('');
    console.log('── B) 已隔离 / 无风险（含 mkdtempSync / os.tmpdir / process.pid）──');
    for (const r of alreadyOk) {
        const why = r.isolated.length ? r.isolated.join('+') : '无 rmSync';
        console.log(`  · ${r.rel}  (${why})`);
    }

    console.log('');
    console.log('── C) 豁免（已在文档说明为什么不能改）──────────────────────────');
    for (const r of exempted) console.log(`  ~ ${r.rel}`);

    // 豁免表不许变僵尸：每条都要在扫描结果里真的存在
    const stale = EXEMPTIONS.filter((e) => !rows.some((r) => r.rel === e.file));
    if (stale.length) {
        console.log('');
        console.log(`  ⚠ 豁免表里有 ${stale.length} 条已经扫不到了（僵尸豁免，应删除）：${stale.map((e) => e.file).join(', ')}`);
    }

    console.log('');
    console.log(`合计：需处置 ${needFix.length} · 已隔离 ${alreadyOk.length} · 豁免 ${exempted.length}`);

    if (argv.includes('--check')) {
        const bad = needFix.length > 0 || stale.length > 0;
        console.log(bad ? '✗ --check 未通过' : '✓ --check 通过');
        process.exit(bad ? 1 : 0);
    }
    process.exit(0);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('scan_tmp_isolation.mjs')) {
    main();
}
