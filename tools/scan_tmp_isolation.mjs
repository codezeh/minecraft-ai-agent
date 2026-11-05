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

/**
 * 仓库里**会被真实运行共用**的持久化目录。
 *
 * ★ T17：原来只认 `tmp/` —— 于是「固定 `bots/` 路径 + 开跑先删」**整类漏掉**。
 *   `atom_classify_unit` 三路并行互删地标（`bots/<agent>/memory/*.json`）就是这么漏的：
 *   单跑 6/6 绿，三路并行时「写入=true/true 但读回 A=[] B=[]」。
 */
export const SHARED_DIRS = ['tmp', 'bots', 'logs', 'data', 'schemas', 'schematics', 'reports'];

// T17：除上面这些"正常目录"，还要认**点开头的临时目录**（`.tmp_mut` / `.mut_x` …）。
//   `strat_alloc_unit` 的变异体副本原来写在 `tools/.tmp_mut/`，两路并行时互删 ——
//   它既不以 `tmp/` 开头、也不在仓库根，旧判据**完全看不到**（第二类病灶的第三张脸）。
const DOT_TMP_GROUP = '\\.tmp[a-zA-Z0-9_]*';

const DIR_GROUP = SHARED_DIRS.join('|') + '|' + DOT_TMP_GROUP;

/**
 * 固定共享路径的两种写法（会命中的都是"与别人共用一个目录"的形态）：
 *   · 字符串/模板字面量前缀：'tmp/x'、`./bots/${name}/memory`、"./logs/a"
 *   · join('<dir>', ...)：join('bots', name, 'memory')
 * ★ 模板字面量只匹配**固定前缀**（`bots/` 之后是变量也算）——
 *   因为"前缀固定"就等于"大家共用一个父目录"。
 */
const FIXED_SUBPATH_PATTERNS = [
    { id: 'string/template', re: new RegExp("(['\"`])(?:\\./)?(" + DIR_GROUP + ")[\\\\/][^'\"`\\n]*", 'g') },
    { id: 'join(dir,...)', re: new RegExp("join\\(\\s*(['\"`])(" + DIR_GROUP + ")\\1\\s*,", 'g') },
    // ★ T17：`resolve(process.cwd(), 'bots', name)` 这种"把目录名当**参数**传"的写法
    //   （memory_store 就是这么算 bots 根的）—— 上面两条都漏掉它。
    { id: 'dir-as-arg', re: new RegExp("[(,]\\s*(['\"`])(" + DIR_GROUP + ")\\1\\s*,", 'g') },
    // ★ T17：点开头的临时目录**嵌在路径中间**也算（'tools/.tmp_mut'）——
    //   上面几条要求目录名出现在字面量开头，抓不到这个形态。
    { id: 'nested-scratch', re: new RegExp("(['\"`])[^'\"`\\n]*[\\\\/]" + DOT_TMP_GROUP + "[^'\"`\\n]*", 'g') },
];

/**
 * 已隔离的形态：出现任一即认为这个文件不会和别人共用目录。
 * ★ T17 新增 `env-root`：测试若能通过**环境变量**把根指到自己的临时目录
 *   （本仓约定 `MC_BOTS_ROOT`），也算隔离 —— 这正是修 `bots/` 那一类的正解。
 */
const ISOLATED_MARKERS = [
    { id: 'mkdtempSync', re: /\bmkdtempSync\s*\(/ },
    { id: 'os.tmpdir', re: /\btmpdir\s*\(\s*\)/ },
    { id: 'process.pid', re: /process\.pid/ },
    { id: 'randomUUID', re: /randomUUID\s*\(/ },
    { id: 'env-root', re: /\bMC_BOTS_ROOT\b/ },
    { id: 'env-root(其他)', re: /\bprocess\.env\.[A-Z0-9_]*_ROOT\b/ },
];

/** **删除**动作（"开跑先删"的正身） */
const DELETE_PATTERNS = [
    { id: 'rmSync', re: /\brmSync\s*\(/g },
    { id: 'unlinkSync', re: /\bunlinkSync\s*\(/g },
    { id: 'rmdirSync', re: /\brmdirSync\s*\(/g },
    { id: 'rm -rf', re: /\brm\s+-rf\b/g },
];

/** **写入**动作（不是删除，但同样会污染别人共享的目录） */
const WRITE_PATTERNS = [
    { id: 'writeFileSync', re: /\bwriteFileSync\s*\(/g },
    { id: 'appendFileSync', re: /\bappendFileSync\s*\(/g },
    { id: 'createWriteStream', re: /\bcreateWriteStream\s*\(/g },
    { id: 'copyFileSync', re: /\bcopyFileSync\s*\(/g },
];

/**
 * **只读**的固定共享路径：文件里出现它，但只读不写不删。
 * 逐条写清理由；扫描器会校验"这条还在文件里"（防僵尸）。
 */
export const NON_RISK_USES = [
    {
        file: 'tools/test_nav_opt.mjs',
        path: 'bots/deepseek/map',
        kind: 'read-only',
        why: '**真机录的地形库**（bots/ 在 .gitignore 里），只当输入读取；缺失时整支测试 SKIP。'
            + '它自己的写入/清理都落在 tmpdir 的临时目录（T04 改的），不碰 bots/。'
            + '★ 不能改成"每进程一份"：这份数据是**真机采集的现场录音**，复制一份没有意义，'
            + '而且它本来就是只读。',
    },
    {
        file: 'tools/test_path3d.mjs',
        path: 'bots/deepseek/map',
        kind: 'read-only',
        why: '同上：真机地形库只读输入，缺就 SKIP；写入落在 tmpdir。',
    },
    {
        file: 'tools/prompter_path_unit.mjs',
        path: 'bots/${name}',
        kind: 'string-message',
        why: '这两处是**断言消息字符串**（"prompter.js 里没有 mkdirSync(`./bots/${name}`) 这种裸拼"），'
            + '是给人看的文字，不是本测试用的路径。★ 同一个字符串里还含 `writeFileSync` 字样，'
            + '所以它同时被"写入动作"命中 —— 这正是"文本里提到路径 != 代码里用了路径"。',
    },
    {
        file: 'tools/prompter_path_unit.mjs',
        path: "('logs'",
        kind: 'arg-only',
        why: '`botDirOf("deepseek", path.join("logs", "task_1"))` —— 这一段只是**喂给路径拼接用例的子路径**，'
            + '用来断言"子路径仍在 bots/ 之下"，不落盘。',
    },
];

/**
 * 该固定路径是不是"只读用途"（按文件 + 路径前缀登记）。
 * @param {string} rel 形如 tools/x.mjs
 * @param {string} text 命中的原文
 */
function isNonRiskUse(rel, text) {
    return NON_RISK_USES.some((e) => e.file === rel && text.includes(e.path));
}
// 兼容旧名（本文件早先叫 read-only）
const isReadOnlyUse = isNonRiskUse;

/** 行号（1 起） */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * 分析一段源码。
 * @param {string} src
 * @returns {{fixed:Array, deletes:Array, writes:Array, rms:Array, isolated:string[]}}
 *   `rms` 保留旧名（= deletes），免得调用方白改。
 */
export function analyse(src) {
    const code = stripComments(src);
    const collect = (patterns) => {
        const out = [];
        for (const { id, re } of patterns) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(code)) !== null) out.push({ line: lineOf(code, m.index), text: m[0].trim(), kind: id });
        }
        return out;
    };
    const fixed = collect(FIXED_SUBPATH_PATTERNS);
    const deletes = collect(DELETE_PATTERNS);
    const writes = collect(WRITE_PATTERNS);
    const rms = deletes;
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
    return {
        fixed: uniq(fixed),
        deletes: uniq(deletes),
        writes: uniq(writes),
        rms: uniq(deletes),
        isolated,
    };
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
        file: 'tools/restart_bot.mjs',
        why: '运维脚本（重启 bot），**要的就是**仓库内固定路径的 pid/日志；不在 unit_all 名单里。',
    },
    {
        file: 'tools/preflight.mjs',
        why: '**门禁脚本，不是测试**（不归本轮改，且任务书要求"不碰 preflight"）。'
            + '★ 但要如实纠正一处："它只读"不成立 —— 它在收尾真的会 '
            + '`rmSync(join(ROOT, "../../bots/preflight_tmp"))`。'
            + '之所以列成豁免：① 它是**串行**门禁（一次一个提交），不是被 unit_all 并发调度的测试；'
            + '② 它自己 `mkdtemp` 出的是别的临时目录，那行 `bots/preflight_tmp` 的删除是'
            + '"清自己上一次的残留"。'
            + '★ 真正的风险（两次提交恰好同时跑 preflight）已写进文档，交给 gate 的负责人决定是否加 pid 后缀。',
    },
    {
        file: 'tools/bench_s2_main.mjs',
        why: '**基准脚本，不是测试**：把每轮结果 append 到仓库内 tmp/ 供人对比历史，'
            + '`unit_all` 不会跑它（不是 *_unit.mjs、不在 UNITS）。两路并发跑基准没有意义 ——'
            + '基准比的正是"独占机器时的表现"。',
    },
    {
        file: 'tools/t51_firstnight_realagent.mjs',
        why: '**真机演练脚本**（要连真实服务器跑 agent），把过程 append 到 data/ 给人事后翻；'
            + '不在 unit_all 名单里，也不该被并发调度。与 t51_triple_round 同类。',
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
// 8/9: 固定 bots/ 路径（模板字面量）—— 必须被报
// 10: **嵌在路径中间**的点开头临时目录（'tools/.tmp_mut/...'）—— T17 新增形态
// T17 追加：固定 `bots/` 路径（模板字面量带变量）也必须被认出来 ——
//   这正是 atom_classify 三路并行互删地标的那一类。
const SELFTEST_FIXTURE = `
// 注释里的假样本：const DIR = join('tmp', 'fake-comment');  rmSync(DIR);
/* 块注释里的假样本：tmp/block-comment  rmSync(x) */
const realFixed = join('tmp', 'real-shared-dir');
const alsoReal = 'tmp/another-shared';
rmSync(realFixed, { recursive: true, force: true });
const tricky = 'a//b' + 'tmp/in-string';
const botsFixed = \`bots/\${name}/memory\`;
rmSync(\`bots/\${name}\`, { recursive: true, force: true });
const scratch = 'tools/.tmp_mut/strat_obtain_mut.mjs';
`;

function selftest() {
    const a = analyse(SELFTEST_FIXTURE);
    const lines = a.fixed.map((x) => x.line);
    const problems = [];
    // 注释里的两处（第 2、3 行）必须**不出现**
    if (lines.includes(2) || lines.includes(3)) problems.push('注释里的样本被当成了真命中');
    // 代码里的必须出现：4(join tmp)、5(字符串 tmp)、7(字符串里带//)、8(bots 模板)
    // ★ 9 行是 `rmSync(\`bots/...\`)`，同一行的 fixed 已在 8 命中，9 行本身也会命中 fixed —— 一起要求
    for (const want of [4, 5, 7, 8, 9, 10]) if (!lines.includes(want)) problems.push(`漏报第 ${want} 行`);
    // rm 必须被发现
    if (!a.rms.length) problems.push('rmSync 没被认出来');
    // 字符串里的 // 不能把后面的内容吃掉（第 7 行还能被找到就说明没吃）
    // 只读判定也要自检：同一条路径登记成只读时，不该进"需处置"
    if (!isNonRiskUse('tools/test_nav_opt.mjs', 'bots/deepseek/map')) {
        problems.push('只读登记没生效（isReadOnlyUse 认不出已登记的只读路径）');
    }
    if (isNonRiskUse('tools/atom_classify_unit.mjs', 'bots/probe')) {
        problems.push('只读登记误伤：未登记的文件被判成只读');
    }
    console.log(problems.length
        ? `✗ 自检失败：${problems.join('；')}`
        : '✓ 自检通过：注释样本被忽略 / 代码真样本全中 / 字符串里的 // 没误判 / bots 模板命中 / 只读登记双向正确');
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
    // T17：bots 根隔离用的前缀
    'bots-root-', 'atom-classify-test-', 'mem-corrupt-test-',
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
        // 只读用途：文件里所有固定共享路径都登记成只读 → 不算风险
        const allReadOnly = a.fixed.every((f) => isNonRiskUse(rel, f.text));
        const destructive = a.deletes.length > 0 || a.writes.length > 0;
        const risky = a.fixed.length > 0 && destructive && a.isolated.length === 0 && !allReadOnly;
        rows.push({ rel, ...a, exempt, risky, allReadOnly, destructive, testLike: isTestLike(rel) });
    }

    console.log('扫描范围：tools/**/*.mjs =' + files.length + ' 个文件');
    console.log('');
    const needFix = rows.filter((r) => r.risky && !r.exempt);
    const alreadyOk = rows.filter((r) => !r.risky && !r.exempt && !r.allReadOnly);
    const exempted = rows.filter((r) => r.exempt);
    const readOnly = rows.filter((r) => r.allReadOnly && !r.exempt);

    console.log('── A) 【固定共享路径 + 删除/写入 + 无隔离】需要处置 ────────────────');
    if (!needFix.length) console.log('  （空）');
    for (const r of needFix) {
        const locs = r.fixed.map((f) => `${f.line}: ${f.text}`).join(' | ');
        const dels = r.deletes.map((x) => `${x.line}(${x.kind})`).join(',') || '—';
        const wr = r.writes.map((x) => `${x.line}(${x.kind})`).join(',') || '—';
        console.log(`  ✗ ${r.rel}  [${r.testLike ? '被 unit_all 调度' : '非单测'}]`);
        console.log(`      固定路径 → ${locs}`);
        console.log(`      删除动作 → ${dels}`);
        console.log(`      写入动作 → ${wr}`);
    }

    console.log('');
    console.log('── B) 已隔离 / 无风险（mkdtempSync / os.tmpdir / process.pid / MC_BOTS_ROOT）');
    for (const r of alreadyOk) {
        const why = r.isolated.length ? r.isolated.join('+') : '无删除/写入动作';
        console.log(`  · ${r.rel}  (${why})`);
    }

    console.log('');
    console.log('── B2) 固定路径但**非风险用途**（只读/消息字符串/纯参数，逐条登记）──────');
    if (!readOnly.length) console.log('  （空）');
    for (const r of readOnly) {
        const e = NON_RISK_USES.find((x) => x.file === r.rel);
        console.log(`  ○ ${r.rel}  ← ${e ? e.path : '?'}  [${e ? e.kind : '?'}]`);
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
    // 只读登记也不许变僵尸：每条都要在扫描结果里真的存在
    const staleRo = NON_RISK_USES.filter((e) => !rows.some((r) => r.rel === e.file && r.allReadOnly));
    if (staleRo.length) {
        console.log('');
        console.log(`  ⚠ 只读登记里有 ${staleRo.length} 条已经对不上（僵尸只读，应删除/复核）：${staleRo.map((e) => e.file).join(', ')}`);
    }
    console.log('');
    console.log(`合计：需处置 ${needFix.length} · 已隔离 ${alreadyOk.length} · 只读 ${readOnly.length} · 豁免 ${exempted.length}`);

    if (argv.includes('--check')) {
        const bad = needFix.length > 0 || stale.length > 0 || staleRo.length > 0;
        console.log(bad ? '✗ --check 未通过' : '✓ --check 通过');
        process.exit(bad ? 1 : 0);
    }
    process.exit(0);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('scan_tmp_isolation.mjs')) {
    main();
}
