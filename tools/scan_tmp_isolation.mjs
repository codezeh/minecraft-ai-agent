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
 *   node tools/scan_tmp_isolation.mjs --audit-exemptions # 逐条核对豁免/非风险登记是否仍与代码相符
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
    // ★ T19：`dir-as-arg` 会把**事件名**当成目录 —— `socket.on('data', cb)`、
    //   `emit('logs', …)` 都长成"字面量当第一个参数"的样子。
    //   这类假阳性比漏报更坏：它让人开始不信这个扫描器。所以按行做一次排除。
    // 注意：匹配起点就是那个 `(`，所以这里只看它前面是不是 .on / .emit 之类（不含括号）
    const EVENT_CALL = /\.(?:on|once|off|emit|addListener|removeListener)\s*$/;
    const collectFixed = () => {
        const out = [];
        for (const { id, re } of FIXED_SUBPATH_PATTERNS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(code)) !== null) {
                if (id === 'dir-as-arg') {
                    const lineStart = code.lastIndexOf('\n', m.index) + 1;
                    const before = code.slice(lineStart, m.index).trimEnd();
                    if (EVENT_CALL.test(before)) continue;   // 事件名，不是路径
                }
                out.push({ line: lineOf(code, m.index), text: m[0].trim(), kind: id });
            }
        }
        return out;
    };
    const fixed = collectFixed();
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
 *
 * ★ T19 逐条审计过（`--audit-exemptions` 可复现），删掉了两条：
 *   ① `tools/preflight.mjs` —— T18（`e540515`）已改成 `mkdtempSync` + `MC_BOTS_ROOT` 独占，
 *      它现在真的**已隔离**。那条豁免的理由还引着 `rmSync(join(ROOT, "../../bots/preflight_tmp"))`
 *      —— 一句**已不存在于代码**的话（只剩注释里提到）。这正是一条"过期豁免 = 假证据"。
 *   ② `tools/t51_firstnight_realagent.mjs` —— 它当初被扫到，是因为 `on('data', …)` 里的
 *      `'data'` 被当成了目录（T19 已修掉这个假阳性）。修完它**不再有任何固定共享目录**，
 *      豁免成了僵尸。（它确实会写一个固定的 `tmp-t59-agent.log`，但那是**单个文件**、
 *      不是目录，不在本判据范围内 —— 见文档 §T19 的"边界"。）
 *
 * 字段说明：
 *   · `why`        —— 为什么不能/不该改成每进程隔离
 *   · `keepReason` —— 可选。给"工具会判它已隔离，但那个标记其实不是目录隔离"的情形留话，
 *                     避免把假绿当成真隔离（`--audit-exemptions` 会照此显示为"保留"而不是"冗余"）
 */
export const EXEMPTIONS = [
    {
        file: 'tools/bench_move_actions.mjs',
        why: '**基准脚本，不是测试**：产物 append 到 `tmp/bench/<日期>-move-actions.jsonl`，'
            + "并在开头 `join('tmp', 'bench-actions-map')` 清掉自己的地图缓存。"
            + '`unit_all` 不会跑它（不是 *_unit.mjs、不在 UNITS）——'
            + '两路并发跑基准没有意义：基准比的正是"独占机器时的表现"。',
    },
    {
        file: 'tools/bench_deepwater.mjs',
        why: '**基准脚本，不是测试**：产物写 `tmp/bench/deepwater-<日期>.jsonl`（独立 jsonl，'
            + '不与 move-actions 混），供人对照历史；`unit_all` 不跑它。',
    },
    {
        file: 'tools/bench_move_baseline.mjs',
        why: '**基准脚本，不是测试**：产物写 `tmp/bench/<日期>-move.jsonl`，'
            + "地图缓存在 `join('tmp', 'bench-move-map', 'terrain')`；`unit_all` 不跑它。",
    },
    {
        file: 'tools/bench_s2_main.mjs',
        why: '**基准脚本，不是测试**：产物落在**项目根**的 `tmp/bench/<时间戳>-s2-main.jsonl`'
            + "（`'..', '..', 'tmp', 'bench'`，即 mindcraft 仓**之外**）；"
            + '`unit_all` 不跑它。',
    },
    {
        file: 'tools/restart_bot.mjs',
        why: '**运维脚本**（重启 bot），`unit_all` 不跑它，并发跑两个"重启"本身没有意义。'
            + '真实固定路径只有 `tmp/bot_run.log`（**单个文件**日志，开跑 `writeFileSync` 清空）。',
        keepReason: '工具会把它判成"已隔离（process.pid）"，但那个 `process.pid` 出现在'
            + '一段 **PowerShell 进程过滤**脚本里（排除自己的 PID），与目录/文件隔离**无关**。'
            + '所以保留豁免并写明 —— 否则就成了"用无关标记换来的假绿"。',
    },
    {
        file: 'tools/t51_triple_round.mjs',
        why: '**人工真机三轮演练脚本**（要连服务器），`unit_all` 不跑它；'
            + '产物写 `tmp/t51-craft-chain.jsonl` / `tmp/t51-craft-fail-full.jsonl` / `tmp/t51-triple.json`，'
            + '是给人事后翻的。',
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

/**
 * 判定**一个文件**落在哪一类 —— `main()` 与 `--audit-exemptions` 共用同一套规则
 * （★ 单一真相：审查豁免时用的判据必须和扫描时一模一样，否则"审查"就是另一套东西）。
 *
 * @param {string} rel 形如 `tools/x.mjs`
 * @param {string} src 源码
 * @returns {{rel:string, fixed:Array, deletes:Array, writes:Array, rms:Array, isolated:string[],
 *            exempt:object|undefined, risky:boolean, allReadOnly:boolean, destructive:boolean, testLike:boolean}}
 */
export function classify(rel, src) {
    const a = analyse(src);
    const exempt = EXEMPTIONS.find((e) => e.file === rel);
    // 非风险用途：文件里**所有**固定共享路径都登记过（只读 / 消息字符串 / 纯参数）
    const allReadOnly = a.fixed.every((f) => isNonRiskUse(rel, f.text));
    const destructive = a.deletes.length > 0 || a.writes.length > 0;
    const risky = a.fixed.length > 0 && destructive && a.isolated.length === 0 && !allReadOnly;
    return { rel, ...a, exempt, risky, allReadOnly, destructive, testLike: isTestLike(rel) };
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
// 11: `sock.on('data', …)` —— 事件名，**不许**被 dir-as-arg 当成目录（T19 假阳性修正）
// 12: 正对照 —— `resolve(cwd, 'bots', …)` 必须被认出（证明排除事件名没把功能关掉）
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
sock.on('data', (b) => { void b; });
const d2 = path.resolve(cwd, 'bots', name);
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
    // ★ T19：第 11 行是 `sock.on('data', …)` —— 那是**事件名**，不许被当成目录
    if (lines.includes(11)) problems.push('事件名 on(\'data\',…) 被当成了目录（dir-as-arg 假阳性）');
    // ★ 正对照：同时必须有 resolve(cwd, 'bots', …) 被认出，
    //   否则「排除事件名」这一条可能把整个 dir-as-arg 功能关掉了，而自检照样绿。
    if (!lines.includes(12)) problems.push('漏报第 12 行（resolve(cwd, bots, ...) 这个真目录没被认出）');

    // ★ T19：理由里的"代码引用"检查 —— 占位符跳过、真引用必须能找到
    const spans1 = codeSpansOf('产物写 `tmp/bench/<日期>.jsonl`，并 `rmSync(join(\'tmp\', \'x\'))` 清缓存');
    if (spans1.some((x) => x.includes('<日期>'))) problems.push('占位符（<日期>）没被跳过：会制造假警报');
    if (!spans1.some((x) => x.startsWith('rmSync('))) problems.push('真代码引用没被抽出来');

    console.log(problems.length
        ? `✗ 自检失败：${problems.join('；')}`
        : '✓ 自检通过：注释样本被忽略 / 代码真样本全中 / 字符串里的 // 没误判 / bots 模板命中 / '
          + '只读登记双向正确 / 事件名不算目录 / 代码引用检查（含占位符跳过）');
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
// ④b 豁免自审（--audit-exemptions）
//
// ★ T19 的由来：一条**过期的豁免理由**，看起来和有效理由一模一样。
//   `tools/preflight.mjs` 那条写着"它收尾会 rmSync(bots/preflight_tmp)"，
//   而 T18 已经把 preflight 改成 mkdtemp + MC_BOTS_ROOT 独占 —— 那句话指向一段**已不存在的代码**。
//   这类"假证据"会让下一个人以为那里还有风险（或以为已经有人处理过）。
//
// 所以这个模式对每一条豁免做三件事：
//   ① 文件还在吗；
//   ② **如果删掉这条豁免**，它会落在哪类？（还是"需处置"= 豁免仍必要；
//      落进"已隔离/非风险"= 豁免已是冗余；完全没有命中 = 僵尸豁免，理由在描述一个不存在的东西）
//   ③ `why` 里用反引号引的**代码片段**，是否仍出现在该文件的**代码**里（剥注释后比 ——
//      因为"被删的代码"经常还留在注释里，那不算还在）。
// ───────────────────────────────────────────────────────────────────────────

/** 把空白折叠，便于跨换行比代码片段 */
const squash = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/**
 * 从 `why` 里抽出反引号包起来的片段，挑出"看起来像代码"的那些。
 * @param {string} why
 * @returns {string[]}
 */
export function codeSpansOf(why) {
    const out = [];
    const re = /`([^`\n]{4,120})`/g;
    let m;
    while ((m = re.exec(String(why ?? ''))) !== null) {
        const span = m[1];
        // ★ 只查"**声称的代码引用**"。带占位符的（`<日期>`、`…`、`...`）是**人话描述**，
        //   不是逐字引用 —— 拿它去比对代码只会制造假警报（T19 第一版就这么误伤了自己的文案）。
        if (/[<…]|\.\.\./.test(span)) continue;
        // 只查"像代码"的：含调用括号 / 路径分隔 / 赋值 / 点号调用
        if (/[(){}]|=>|=[^=]|\.\w+/.test(span) || span.includes('/')) out.push(span);
    }
    return out;
}

/**
 * 一条豁免的现状。
 * @param {object} e EXEMPTIONS 条目
 * @param {(rel:string)=>string|null} readSrc 读文件（不存在返回 null）
 */
export function auditOne(e, readSrc) {
    const src = readSrc(e.file);
    const problems = [];
    if (src == null) {
        return { file: e.file, exists: false, verdict: '僵尸（文件不存在）', problems, spans: [], missingSpans: [] };
    }
    const row = classify(e.file, src);
    // 关键：把这条豁免**摘掉**再判一次，看它还需不需要豁免
    let land;
    if (!row.fixed.length) land = '没有命中（僵尸豁免）';
    else if (row.risky) land = '需处置（豁免仍必要）';
    else if (row.isolated.length) land = `已隔离（${row.isolated.join('+')}）`;
    else if (row.allReadOnly) land = '非风险用途';
    else land = '无删除/写入动作';

    const spans = codeSpansOf(e.why);
    // 比之前把引号也统一：理由是给人看的，用 `"tmp"` 还是 `'tmp'` 不该算"引用失效"。
    const norm = (t) => squash(t).replace(/"/g, "'").replace(/\s+/g, '');
    const codeOnly = norm(stripComments(src));
    const missingSpans = spans.filter((sp) => !codeOnly.includes(norm(sp)));

    let verdict;
    if (!row.fixed.length) verdict = '僵尸（文件里已无固定共享路径，应删除）';
    else if (!row.risky && e.keepReason) verdict = '保留（工具判为安全，但那个标记不是目录隔离 —— 见 keepReason）';
    else if (!row.risky) verdict = `冗余（本身已安全：${land}，应删除）`;
    else verdict = '仍必要（仍会被判为需处置）';
    if (missingSpans.length) problems.push(`理由引用了**代码里已不存在**的片段：${missingSpans.join(' / ')}`);

    return { file: e.file, exists: true, land, verdict, problems, spans, missingSpans };
}

function reportExemptions() {
    const readSrc = (rel) => {
        try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; }
    };
    console.log('逐条核对 EXEMPTIONS（判定用的是**同一套** classify 规则）');
    console.log('');
    let bad = 0;
    for (const e of EXEMPTIONS) {
        const r = auditOne(e, readSrc);
        const flag = (r.verdict.startsWith('僵尸') || r.verdict.startsWith('冗余') || r.problems.length) ? '✗' : '·';
        if (flag === '✗') bad += 1;
        console.log(`${flag} ${r.file}`);
        console.log(`    判定：${r.verdict}`);
        if (r.land) console.log(`    若去掉豁免会落在：${r.land}`);
        if (e.keepReason) console.log(`    保留依据：${e.keepReason}`);
        for (const p of r.problems) console.log(`    ⚠ ${p}`);
    }
    console.log('');
    // NON_RISK_USES 也一起核（同一母题：登记也会过期）
    console.log('逐条核对 NON_RISK_USES');
    for (const e of NON_RISK_USES) {
        const src = readSrc(e.file);
        if (src == null) { console.log(`✗ ${e.file}  ← ${e.path} [${e.kind}]：**文件不存在**`); bad += 1; continue; }
        const hit = analyse(src).fixed.some((f) => f.text.includes(e.path));
        console.log(`${hit ? '·' : '✗'} ${e.file}  ← ${e.path} [${e.kind}]${hit ? '' : '：**该片段已不再命中**（登记过期）'}`);
        if (!hit) bad += 1;
    }
    console.log('');
    console.log(bad === 0 ? '✓ 所有豁免/非风险登记都与当前代码相符' : `✗ 有 ${bad} 条需要订正`);
    return bad === 0;
}

// ───────────────────────────────────────────────────────────────────────────
// ⑤ 主流程
// ───────────────────────────────────────────────────────────────────────────
function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
    if (argv.includes('--leftovers')) { reportLeftovers(argv); process.exit(0); }
    if (argv.includes('--audit-exemptions')) process.exit(reportExemptions() ? 0 : 1);

    const files = listTools();
    const rows = [];
    for (const abs of files) {
        const rel = relative(ROOT, abs).split('\\').join('/');
        const row = classify(rel, readFileSync(abs, 'utf8'));
        if (!row.fixed.length) continue;
        rows.push(row);
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
