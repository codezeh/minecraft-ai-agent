// 启动自检：加载所有 agent 模块，确认没有「引用了未定义符号」这类错误。
//
// 为什么需要：连续两次出现同类问题
//   1) MEMORY_CODE_VERSION 只加了引用没加定义 → agent 启动即崩
//   2) resolveCollectTarget 只加了使用没加 import → 「砍树」技能全废
// 两者都是 node --check 查不出来的（语法正确，运行时才炸）。
// 这个脚本真的 import 一遍模块并调用关键函数，把这类错误挡在重启之前。
import { pathToFileURL, fileURLToPath } from 'url';
import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// 注意：用 fileURLToPath 而不是手写 pathname ——
// 中文目录名会被 URL 编码（实测 path 变成 %E6%88%91... 导致 scandir ENOENT）。
const ROOT = fileURLToPath(new URL('../src/agent/', import.meta.url));

let failed = 0;
let loaded = 0;
// ★ 第34条：导入阶段被「其他错误」静默跳过的模块。以前不记，
//   于是 loaded < files.length 也照样打「✓ 所有模块导入成功」。
const skippedByOther = [];

/**
 * ★★ 2026-11-04（t99）：「**扫到 0 个样本 = 通过**」的通用护栏。
 *
 * 这是今晚一整族 bug 的门禁版：**"什么都没检测到"和"检测了、没有"在报告里长得一模一样**。
 * 每一段审计的本质都是「扫 N 个样本 → 有命中就失败」。可当 N=0 时：
 *   - 命中数必然 0 → 打 ✓
 *   - 于是"路径错了 / glob 挂了 / 目录空了"全都被读成"干净"
 *
 * **判据：任何审计段在打 ✓ 之前，必须先断言"我确实扫到了样本"。**
 * 这和 `--selftest`（断言"扫描器看得见"）是同一原则的不同层：
 *   - selftest   → 证明**判据**有效
 *   - 本护栏     → 证明**输入**非空
 * 两者缺一，"0 处命中"就不可信。
 */
function requireScanned(section, n, what, hint = '') {
    if (Number(n) > 0) return true;
    failed++;
    console.log(`  ✗ [${section}] **扫到 0 个${what}** —— 不能当成"没有违规"`);
    if (hint) console.log(`     ${hint}`);
    return false;
}

/**
 * ★★★ 2026-11-05（T02 / 报告第 26 条）：**审计用的正则集中定义在这里，且必须可自检**。
 *
 * 教训：本节两个正则曾各带一个 0x08（退格）字节前缀 —— 正则要求"字面退格"才匹配，
 * 于是**永不命中** → used2 恒空 → 恒打印「✓ 错误码审计通过」。这道门从上线起没检过任何东西，
 * 而"0 处命中"和"检查过、没有"在报告里长得一模一样。
 *
 * 防回归：`tools/preflight_regex_unit.mjs` 会**从本文件源码里抽出这两块常量**，
 * 断言 ①整个文件没有控制字符 ②对已知样本能命中 ③对已知反例不命中。
 * 所以：**不要改成动态拼接**（拼了就抽不出来，自检会红）。
 */
const CODE_AUDIT_REGEXES = [
    // ① fail('XXX') —— 唯一会在运行期直接 throw 的路径（contract.fail 会校验 CODES）
    /\bfail\(\s*'([A-Z_]+)'/g,
    // ② ActionResult 字面量 { ok: false, code: 'XXX', … } —— 走 assertResult 也会 throw「未知 code」
    //
    // 为什么不用宽口径的 `code: 'XXX'`：`code:` 这个键在三处被用，含义不同 ——
    //   (a) ActionResult 错误码（本正则的目标，必须在 CODES 里）
    //   (b) 任务板的**停止/结果码**（control.js：PREEMPTED / INTERRUPTED / TIMEOUT / DIED）
    //   (c) 纯数据载荷回显（`result: { code, at }`、`failed.push({ pos, code })`）
    // (b)(c) 是另一套词汇表。宽口径会把 (b) 的 DIED 报成"未注册错误码" —— 那是**判据错**，
    // 不是源码错：`fail('DIED')` 全仓 0 次，把它塞进 CODES 反而让 assertResult 误认它是 ActionResult 码。
    // 收紧到「对象里带 ok: 的 code 字面量」后：162 个源文件仍扫到 20 个不同码，0 漏报。
    /\{\s*ok:\s*(?:true|false)[^{}]{0,300}?\bcode:\s*'([A-Z_]+)'/g,
];

// §6「工具到底跑没跑起来」的指纹正则。同样收进来，让自检能喂样本。
const SAW_A_SECTION = /──\s*A·|\bA·策略|未发现"有早退分支但生产不提供"/;

function walk(dir) {
    const out = [];
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (f.endsWith('.js')) out.push(p);
    }
    return out;
}

const files = walk(ROOT);
console.log(`检查 ${files.length} 个模块...\n`);
// ★ t99 护栏：0 个模块时后面那句「✓ 所有模块导入成功（0/0）」是假绿
const gotModules = requireScanned('1 模块导入', files.length, '模块（src/agent/**/*.js）',
    '检查 ROOT 是否指对（preflight 的 ROOT 是 src/agent/）');

for (const f of files) {
    const rel = f.replace(/\\/g, '/').split('/src/agent/')[1] || f;
    try {
        await import(pathToFileURL(f).href);
        loaded++;
    } catch (e) {
        // 有些模块需要运行环境（fs/socket），缺依赖不算错；
        // 只把「ReferenceError / 未定义的标识符」当致命错误。
        const msg = String(e?.message ?? e);
        if (e?.name === 'ReferenceError' && !/document|window|navigator/.test(msg)) {
            failed++;
            console.log(`  ✗ [ReferenceError] ${rel}: ${msg}`);
        } else if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg)) {
            failed++;
            console.log(`  ✗ [缺少模块] ${rel}: ${msg.slice(0, 100)}`);
        } else {
            // 其他错误（缺少 bot 实例之类）在导入阶段不致命 —— 但**必须记账**。
            // ★ 第34条：原来这里什么都不记，于是 `loaded < files.length` 时
            //   下面照样打「✓ 所有模块导入成功（62/122）」并 exit 0。
            //   "静默跳过"和"导入成功"在报告里长得一模一样 —— 判据见下面的 loaded === files.length。
            skippedByOther.push({
                rel,
                name: String(e?.name ?? 'Error'),
                msg: String(e?.message ?? e).slice(0, 120),
            });
        }
    }
}

// ★★★ 第34条（T02）：判据从 `failed === 0` 收紧为 `loaded === files.length`。
//   旧判据只看"有没有报致命错"，**不看"到底导入了几个"** —— 被静默跳过的模块
//   既不计 failed 也不计 loaded，于是 62/122 也能打 ✓ 并 exit 0。
//   现在：少导一个就是失败，并把少的那几个点名。
if (!gotModules) {
    // 0 个模块已在上面由 requireScanned 记失败，"0/0 全部成功"是假绿，这里不重复报
} else if (loaded === files.length) {
    console.log(`  ✓ 所有模块导入成功（${loaded}/${files.length}），没有未定义引用`);
} else {
    failed++;
    const short = files.length - loaded;
    console.log(`  ✗ 只导入了 ${loaded}/${files.length} 个模块，差 ${short} 个 —— 不能算"导入成功"`);
    console.log('     "静默跳过"不等于"导入成功"：这些模块报了非致命错，根本没加载进来。');
    for (const it of skippedByOther.slice(0, 10)) {
        console.log(`     · ${it.rel} [${it.name}] ${it.msg}`);
    }
    if (skippedByOther.length > 10) {
        console.log(`     · …另有 ${skippedByOther.length - 10} 个被静默跳过`);
    }
}

// ---- 第二层：跑一遍关键函数，抓「函数体内的未定义引用」 ----
// 为什么要这层：连续三次出现「import 漏了」，而模块导入阶段不会执行函数体，
// 所以 import 检查完全抓不到（MEMORY_CODE_VERSION、resolveCollectTarget、reachDistanceTo）。
// 这里用假 bot 真的调用一次，把函数体里的引用错误暴露在重启之前。
const fakeBot = {
    entity: { position: { x: 0, y: 64, z: 0, floored: () => ({ x: 0, y: 64, z: 0 }), distanceTo: () => 5, clone: () => ({ x: 0, y: 64, z: 0 }) } },
    interrupt_code: false,
    registry: { blocksByName: {}, itemsByName: {} },
    players: {},
    entities: {},
    inventory: { slots: [], items: () => [] },
    modes: null,
    game: { dimension: 'overworld' },
    username: 'preflight',
};

const smokeTests = [
    ['task_collect.collect', async () => {
        const m = await import(pathToFileURL(join(ROOT, 'library/flow_collect.js')).href);
        await m.collect(fakeBot, ['oak_log'], 1, { deadlineMs: 500 });
    }],
    ['collect_targets.resolveCollectTarget', async () => {
        const m = await import(pathToFileURL(join(ROOT, 'library/collect_targets.js')).href);
        m.resolveCollectTarget('木头', fakeBot.registry);
    }],
    ['atom_move.makeMovements', async () => {
        const m = await import(pathToFileURL(join(ROOT, 'library/nav_pathfinder.js')).href);
        m.makeMovements({ registry: { blocksByName: {}, itemsByName: {} } });
    }],
    ['history.load+save', async () => {
        const m = await import(pathToFileURL(join(ROOT, 'history.js')).href);
        // ★ T18（封版后补钉）：这个冒烟测试原来写死 `name: 'preflight_tmp'`，
        //   于是临时目录固定落在 `bots/preflight_tmp/`，由文件末尾那句
        //   `rmSync('bots/preflight_tmp')` 收尾删除。两个进程同时跑 preflight 时，
        //   一方收尾就会把另一方**正在用**的目录删掉（已实测确证：目录在 3563ms 被删，
        //   而此刻两个进程都还在运行）。
        //
        //   现在改为：本次调用**独占一个 mkdtemp 临时根**，用 `MC_BOTS_ROOT` 把
        //   `History` 的落盘全部重定向到那里，跑完连根一起删。
        //   —— 没有任何两个进程会共用同一个路径，也就没有"互删"这回事。
        //
        //   为什么能这么改（而不是只能加 pid 后缀）：`History` 的路径来自 `botsRootOf()`，
        //   它认 `MC_BOTS_ROOT`（T17 已改造），所以**不依赖目录深度、不涉及相对 import**，
        //   可以整体搬走。board 那种"按目录深度改写相对 import"的约束在这里不存在。
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const root = mkdtempSync(join(tmpdir(), 'mc-preflight-'));
        const prevRoot = process.env.MC_BOTS_ROOT;
        process.env.MC_BOTS_ROOT = root;
        try {
            const h = new m.History({
                name: 'preflight_tmp',
                self_prompter: { state: 'idle', isStopped: () => true, prompt: null },
                task: { taskStartTime: 0 }, last_sender: 'x',
                memory_bank: { getJson: () => ({}) },
                prompter: { promptMemSaving: async () => 'x' },
            });
            h.load();
        } finally {
            // 恢复环境变量：不能让这次冒烟测试的临时根泄漏给后续阶段（别的层也可能调 botsRootOf）。
            if (prevRoot === undefined) delete process.env.MC_BOTS_ROOT;
            else process.env.MC_BOTS_ROOT = prevRoot;
            // 只删**自己**这个唯一根 —— 这正是"互删"消失的原因。
            try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
        }
    }],
    // ★ S33（T05）：这里原来指向 `library/tile_map.js` —— 那个模块**早已删除**，
    //   于是 name 是「tile_map.classifyChunk」的这条永远走 `~ 非致命` 分支：
    //   名义上 5 条冒烟测试，实际只有 4 条在测东西，而且看起来一切正常。
    //   现在换成它的继任者：分类判断已迁到 query_classify.js，`isProtected` 是纯函数
    //   （只吃 pos + opts，不需要 bot），顺手断言两个分支，比原来"只求不抛"更硬。
    ['query_classify.isProtected', async () => {
        const m = await import(pathToFileURL(join(ROOT, 'library/query_classify.js')).href);
        const spot = { x: 10, y: 64, z: 10 };
        const inside = m.isProtected({ x: 10, y: 64, z: 10 }, { spots: [spot], radius: 6 });
        const outside = m.isProtected({ x: 200, y: 64, z: 200 }, { spots: [spot], radius: 6 });
        if (!inside?.ok || inside.data?.protectedBy !== 'landmark') {
            throw new Error(`isProtected 圈内应判受保护，实际 ${JSON.stringify(inside)}`);
        }
        if (!outside?.ok || outside.data?.protectedBy !== null) {
            throw new Error(`isProtected 圈外不应受保护，实际 ${JSON.stringify(outside)}`);
        }
    }],
];

for (const [name, fn] of smokeTests) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (e) {
        const msg = String(e?.message ?? e);
        // ★ S33（T05）：**缺模块必须判失败**。
        //   原来只把 ReferenceError 当致命，于是"冒烟测试指向一个已删除的模块"会永远走
        //   `~ 非致命` —— 名义 5 条实际 4 条，而报告里看不出任何异常。这是第26条同族：
        //   "没测到"和"测了没问题"长得一模一样。模块找不到 = 这条冒烟测试根本不存在。
        const missingModule = e?.code === 'ERR_MODULE_NOT_FOUND'
            || /Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg);
        if (missingModule) {
            failed++;
            console.log(`  ✗ ${name}: 目标模块不存在（这条冒烟测试形同虚设）: ${e.code ?? ''} ${msg.slice(0, 80)}`);
        } else if (e?.name === 'ReferenceError' || /is not defined/.test(msg)) {
            failed++;
            console.log(`  ✗ ${name}: ${e.name}: ${msg}`);
        } else {
            console.log(`  ~ ${name}: 非致命（${msg.slice(0, 60)}）`);
        }
    }
}

// ---- 第三、四层：规则审计 + 新模块申报（见 改进规划.md §2.3 / §4.4） ----
console.log('\n[3/4] 规则与申报审计');
try {
    const { runAudits } = await import(pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), 'audit_rules.mjs')).href);
    const audit = runAudits();
    for (const p of audit.problems) {
        failed++;
        console.log(`  ✗ ${p}`);
    }
    if (audit.ok) console.log('  ✓ 规则审计通过');
} catch (e) {
    failed++;
    console.log(`  ✗ 审计脚本自身出错: ${e.message}`);
}

// 错误码审计。
//
// 本项目已踩过 4 次同一个坑：新模块用了新错误码但忘了注册，
// 运行时 fail() 直接 throw「非法 code "XXX"」，报错不指向根因
// （NO_REACH / NOT_CLIMBABLE / UNSAFE / LIQUID_RISK 都是这么炸的）。
//
// 用 import 而不是子进程：Windows 中文路径下 execFileSync 容易 MODULE_NOT_FOUND。
try {
    const { CODES } = await import('../src/agent/library/contract.js');
    const fs2 = await import('node:fs');
    const path2 = await import('node:path');
    const projectRoot2 = fileURLToPath(new URL('../', import.meta.url));
    const files2 = [];
    (function walk2(d) {
        for (const e of fs2.readdirSync(d, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'bots' || e.name.startsWith('.')) continue;
            const q = path2.join(d, e.name);
            if (e.isDirectory()) walk2(q);
            else if (e.name.endsWith('.js')) files2.push(q);
        }
    })(path2.join(projectRoot2, 'src'));

    const used2 = new Map();
    for (const f of files2) {
        const raw2 = fs2.readFileSync(f, 'utf8');
        // ★ T05（新增1）：**先剥注释再扫**。
        //   实测事故：board 只是在 board_store.js 的注释里写了一个 `{ ok:false, code:'XXX' }`
        //   形式的举例，这道门就把它当成"未注册错误码"报红，skills 的提交被拒 ——
        //   而双方代码都没错。绕法是"把注释改成散文"，但那等于把代价转给每个写注释的人，
        //   而且下一个人还会踩。根治办法是扫描前把注释抹掉。
        //   strings:false = 只剥注释、**保留字符串内容** —— 字符串里的码仍然要抓（动态拼出来的同样危险）。
        const t = maskJsSource(raw2, { strings: false });
        for (const re of CODE_AUDIT_REGEXES) {
            for (const mm of t.matchAll(re)) {
                if (!used2.has(mm[1])) used2.set(mm[1], new Set());
                used2.get(mm[1]).add(path2.relative(projectRoot2, f));
            }
        }
    }
    const missing2 = [...used2.keys()].filter(k => !CODES.includes(k)).sort();
    const dup2 = CODES.filter((c, i) => CODES.indexOf(c) !== i);
    // ★ t99 护栏：0 个源文件 → missing2 必然为空 → 会打「✓ 错误码审计通过」，那是假绿
    const gotSrcFiles = requireScanned('3 错误码审计', files2.length, 'src 源文件',
        '检查 projectRoot2/src 是否指对；扫不到源码时"没有未注册的码"毫无意义');
    // ★ T02 护栏（第26条真正的教训）：「扫到 0 个码」和「扫了一堆、都合法」必须能分开。
    //   files2 非空 **不代表** 正则有效 —— 0x08 那一次就是 files2=162、used2=0、照样打 ✓。
    const gotCodes = gotSrcFiles
        && requireScanned('3 错误码审计', used2.size, '错误码用法（正则可能又坏了）',
            'CODE_AUDIT_REGEXES 一条都没命中 —— 扫描器坏了，不等于"没有未注册的码"');
    if (!gotSrcFiles || !gotCodes) {
        // 不判"通过"，也不重复报 missing（已在 requireScanned 里记过失败）
    } else if (missing2.length) {
        failed++;
        console.log(`  ✗ 有 ${missing2.length} 个错误码没注册：${missing2.join(', ')}`);
        for (const k of missing2) console.log(`      ${k} ← ${[...used2.get(k)].join(', ')}`);
    } else if (dup2.length) {
        failed++;
        console.log(`  ✗ CODES 有重复项：${[...new Set(dup2)].join(', ')}`);
    } else {
        // 把「扫到几个」印出来：绿字自证扫过东西，而不是"0 命中也是绿"。
        console.log(`  ✓ 错误码审计通过（扫到 ${used2.size} 个码，均已注册；CODES 共 ${CODES.length} 个）`);
    }
} catch (e) {
    failed++;
    console.log(`  ✗ 错误码审计脚本出错: ${String(e?.message ?? e).slice(0, 80)}`);
}

// 交接文档漂移检查。
//
// 为什么需要：2026-10-29 盘点遗留时发现 `docs/交接文档.md` 停在 3 天前，
// 里面点名的 chunk_map.js / heatmap.js **早已删除**，
// "待办 P0/P1/P2" 其实都做完了 —— 照它接手的人会直接走错路。
//
// 这类漂移靠自觉不可靠，所以做成自检的一环：**代码比文档新就提示**。
// 只提示不拦截（文档该不该更新是人的判断，不该阻断启动）。
//
// 用 git 提交时间而不是文件 mtime：mtime 在 git clone / checkout 后会被重置，
// 同一份仓库两次克隆会得出不同结论；提交时间是仓库里的稳定事实。
{
    const { spawnSync } = await import('node:child_process');
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    // ★ 第27条（T05）：这里原来盯的是 `docs/交接文档.md` —— 而**那份文档自己头部就写着**
    //   「本文是 2026-10-24 的快照…2~6 节已过时…权威交接是 架构交接-总.md」。
    //   也就是说：这道门在检查"一份自称作废的文档是否比代码新"。
    //   它当然永远"通过"，因为那份文档本来就不再更新 —— 又一个"检查通过"与"检查没意义"同形。
    //   现在改成盯权威文档。顺带把历史快照也列出来，但只作提示、不参与判定。
    const DOC = 'docs/架构交接-总.md';
    const HISTORICAL_DOCS = ['docs/交接文档.md'];
    const CODE_PATHS = ['src/agent/library', 'src/agent/commands', 'src/agent/process'];

    const gitTime = (args) => {
        const r = spawnSync('git', ['log', '-1', '--format=%ct', '--', ...args],
            { cwd: projectRoot, encoding: 'utf8' });
        if (r.status !== 0) return null;            // 不是 git 仓库 / 没装 git
        const n = Number(String(r.stdout).trim());
        return Number.isFinite(n) && n > 0 ? n : null;
    };

    const docTs = gitTime([DOC]);
    const codeTs = gitTime(CODE_PATHS);

    if (docTs === null || codeTs === null) {
        console.log('  · 交接文档漂移检查：跳过（没有 git 历史可比）');
    } else if (codeTs > docTs) {
        const days = Math.floor((codeTs - docTs) / 86400);
        const when = days >= 1 ? `${days} 天` : '不到一天';
        // 只提示，不计入 failed —— 不该因为文档没跟上就阻止启动
        console.log(`  ! 交接文档可能过时：代码比它新 ${when}。`);
        console.log(`    建议看一眼 ${DOC} 是否还准确（这是**当前**的权威交接）。`);
    } else {
        console.log(`  ✓ 权威交接文档 ${DOC} 不比代码旧`);
    }
    // 历史快照只做提示：它们本来就该停在原地，不参与"是否过时"的判定。
    for (const h of HISTORICAL_DOCS) {
        const ts = gitTime([h]);
        if (ts === null) continue;
        const days = Math.floor((Date.now() / 1000 - ts) / 86400);
        console.log(`  · ${h} 是历史快照（最后一次提交 ${days} 天前），只作对照，不参与判定`);
    }
}

// ---- 第四层：API 扫描（规则已填全，**默认命中即判失败**）----
//
// 为什么需要（docs/architecture/09_crosscut.md §5、01_primitives.md §6、02_actions.md）：
// 分层规矩（"控制键只有 atom_input_move 能碰"、"聊天走 openChat 拦 / 开头"、
// "RCON 密码不许写死"）写在文档里，靠自觉一定漂。要一条能跑、能报位置、能填规则的检查。
//
// ★ S36（T05）：这段注释原来写的是「这一层**只报告不判失败**（API_SCAN_ENFORCE = false）」，
//   而下面第 :341 行的真实取值是 `!process.argv.includes('--report-api')` —— **默认 true**。
//   A.1~A.3 迁完、五条规则全绿之后就翻成判失败了，但这段说明一直没改。
//   后果不是功能错，而是**读码的人会把 §4 的门禁强度判断反**：以为它只是提示，
//   于是"红了也不管"，等于把一道真门当成装饰。注释与代码不一致，比没有注释更坏。
//
// 现状（与代码一致）：**默认命中即判失败**；`--report-api` 临时退回只报告
// （大改期间明知会红一片时用）。规则格式见下面的 API_SCAN_RULES。
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 报多少条；超出的折叠成一句"还有 N 处"，免得刷屏 */
const API_SCAN_MAX_REPORT = 10;

/**
 * 命中就判失败。
 *
 * ★ 2026-11-01（Phase A · A.4）：**默认已翻成判失败**。
 * 骨架阶段它是 false（规则没填全、代码没迁完，开红灯没意义）；A.1~A.3 迁完、
 * 五条规则全绿之后翻过来：再有人从别处直接 setControlState、或自己拼 "/" 命令，
 * preflight 当场拦下 —— 这才是这条规矩能长时间活着的唯一办法。
 *
 * `--report-api` 临时退回「只报告」（大改期间明知会红一片时用）。
 */
const API_SCAN_ENFORCE = !process.argv.includes('--report-api');

/** 扫哪些目录（相对仓库根，只收 .js / .mjs） */
const API_SCAN_ROOTS = ['src/agent', 'tools'];

// 规则表。**规则由后续任务填**，这里给的是按 §5 举的示例（三个都是文档点名的风险项）。
//
// 单条规则的字段：
//   id      规则名（报告里显示，唯一）
//   why     为什么禁（显示在报告里，写给下一个人看）
//   files   扫哪些文件，相对仓库根、"/" 分隔，支持 * ? 和跨目录通配
//   allow   豁免名单（可选）：命中了这些文件就放行，将来"迁一个删一个"
//   pattern 要抓的 API：正则，或按字面量找的字符串
//   enabled 可选，默认 true；先关掉某条规则就写 false
//
// 例：{ id: 'x', why: '...', files: ['src/agent/任意目录/任意.js'], allow: [], pattern: /foo\(/ }
const API_SCAN_RULES = [
    {
        id: 'control-state-owner',
        why: '控制键统一走 atom_input_move（别处直接 setControlState 会绕过「松键」保证）',
        files: ['src/agent/**/*.js'],
        allow: [
            'src/agent/library/atom_input_move.js',
            'src/agent/modes.js',               // M2（t3）负责：自保跳一下，属于控制层
        ],
        pattern: /\bsetControlState\s*\(/,
    },
    {
        // A1 的「点击」那一半：挖 / 放 / 右键 / 挥拳 / 停止挖掘，只许从 atom_input_mouse 出去。
        // `bot.look*` 也在 A1 里，但它的实现本来就是原子（atom_look，由 atom_input_mouse 转出），
        // 所以允许项里写的是 atom_look，而不是整个 library。
        id: 'mouse-input-owner',
        why: '挖/放/右键/挥拳统一走 atom_input_mouse（别处直接调会绕过超时与中断收尾）',
        files: ['src/agent/**/*.js'],
        allow: [
            'src/agent/library/atom_input_mouse.js',
            'src/agent/library/atom_input_inventory.js',   // 切快捷栏 / 点窗口格子（clickWindow、setQuickBarSlot）
            'src/agent/library/atom_look.js',
            // 2026-11-01（t6 遗留清理）已销账：skills.js（14 处鼠标输入 + 6 处 bot.lookAt）、
            //   tool_prep.js（2 处）、act_attack.js（1 处挥击）、vision_interpreter.js（3 处）、
            //   flow_follow.js（1 处）、nav_pathfinder.js（重复的 lookAt 实现已删）—— 全部改调 atom_input_mouse。
            //   空豁免 flow_clear.js / scaffold_cleanup.js 也已删（真实命中 0）。
            'src/agent/modes.js',               // bot.look* ×4（296/298/311/313）—— M2 残项，control 负责
            'src/agent/agent.js',               // this.bot.stopDigging()：停任务时的收尾清理（M1 文件）
        ],
        // 必须带上"谁在调"：`skills.placeBlock(bot, …)` 是库函数的**名字**，不是鼠标输入，
        // 只匹配 `.placeBlock(` 会把调用库的地方全判成违规（第一版就踩了，7 处里 5 处是假阳性）。
        pattern: /\b(?:bot|agent|agent\.bot|this\.bot|this\.agent\.bot)\.(dig|placeBlock|activateBlock|activateItem|activateEntity|attack|stopDigging|swingArm|clickWindow|setQuickBarSlot|lookAt|look)\s*\(/,
    },
    {
        // A1 的「斜杠命令」那一半。**命令是写在字符串里的**，所以这条必须 scan:'raw'
        // （只去注释、保留字符串内容）——用默认的 code 模式永远扫不到，等于规则形同虚设。
        //
        // ★ T05（第29条闸门加强）：原来只有一条 pattern `bot\.chat\(…['"`]\s*\/`
        //   —— 它要求"同一行里先有字面量 /"。于是 `bot.chat(msg)` 这种**变量实参**扫不到，
        //   而 skills.js 那两处历史事故正是变量实参（先 `let msg='/setblock '+…`，再 `bot.chat(msg)`）。
        //   换句话说：规则只能看见"已经写成字面量"的形态，最该防的间接形态正好在盲区里。
        //   现在补两条（T20 文档 §二 给的形态，我按实测把 ② 收窄了一档，见下）：
        //   ① 禁止 bot.chat 传**非字面量**实参（变量/表达式）—— 间接传命令的唯一入口
        //   ② 禁止在字符串里**拼**斜杠命令（`let msg='/setblock '+…`）
        //
        //   ② 为什么不是原样 `['"`]\s*\/[a-z]`：实测全仓 77 处命中里，大量是
        //   **文件路径**（`'/bots/'+agent.name`）、**正则字面量的 flag**（`"/g`、`'/g`）、
        //   **shell 命令**（`espeak "..."`）—— 全是假阳性，把一个规则做成噪音源，
        //   下一个人就会给它加豁免加到失效。收窄成「斜杠后至少两个字母、且后面不紧跟斜杠」
        //   （`\/(?![a-z]*[\\/])[a-z]{2,}`）：77 → 57，路径/flag 类假阳性清零；
        //   真命令（`/setblock `、`/skin clear`、`/op `、`/ride `）全部保留。
        //   剩下的命中都在被豁免的 tasks/ 与 atom_input_misc，属于已知待迁点。
        id: 'slash-command-owner',
        why: '斜杠命令只许从 atom_input_misc.command() 出去（op 账号，一条 /op 就是全图）',
        files: ['src/agent/**/*.js'],
        allow: [
            'src/agent/library/atom_input_misc.js',
            // 冻结文件（src 里没人 import），Phase R 一并删/迁
            // 开发用任务脚本（造场景/烹饪测试），不是运行时链路；后续并入 command()
            'src/agent/tasks/**/*.js',
            // agent.js 的 sendSlashCommand 是 M1 定的另一个合法出口（openChat 同文件）
            'src/agent/agent.js',
        ],
        patterns: [
            // ① bot.chat 传非字面量：`bot.chat(msg)` / `bot.chat('a'+b)` / `bot.chat(code > 1 ? …)`
            /\bbot\.chat\s*\(\s*(?!['"`])/,
            // ② 字符串里拼斜杠命令（收窄版，理由见上）：
            //    `\/(?![a-z]*[\\/\-])[a-z]{2,}` =
            //    斜杠 + 至少两个小写字母，且**该字母串后面不紧跟** `/` 或 `-`。
            //    排掉斜杠：`'/bots/'`、`'/usr/local'` 这类**路径**；
            //    排掉连字符：`'/action-code/'`、`'/tmp/x-y'` 这类**带连字符的路径**
            //    （实测 coder.js:16 就是这么误报的 —— 只排斜杠挡不住它）。
            //    真命令（setblock/skin/op/ride/fill…）后面不是斜杠也不是连字符，全部保留。
            //    注：字符类里连字符放末尾不必转义（`\-` 会被 eslint 判 no-useless-escape）。
            /['"`]\s*\/(?![a-z]*[\\/-])[a-z]{2,}/,
        ],
        scan: 'raw',
    },
    {
        id: 'chat-via-openchat',
        why: '发聊天统一走 openChat / atom_input_misc（M1：回复以 / 开头会被当命令执行）',
        files: ['src/agent/**/*.js'],
        allow: [
            'src/agent/library/atom_input_misc.js',
            'src/agent/agent.js',            // openChat / sendSlashCommand：M1 定的唯一出口
            // 待迁：模型回复之外的直发（任务脚本 / 语音 / 模式提示），尚未接 openChat
            'src/agent/speak.js',
            // ★ T05：**skills.js 已从豁免里摘掉**（第29条要求「收紧、要真阳性不靠放宽」）。
            //   T20 已把 skills.js 里最后两处裸 `bot.chat('/setblock …')` 改成 command(...)，
            //   现在这个文件里 `bot.chat(` 出现次数是 0 —— 豁免已经没有存在理由。
            //   留着它的唯一效果：以后有人在 skills.js 里再写一句 bot.chat 直发，门禁看不见。
            'src/agent/modes.js',
            'src/agent/permissions.js',
            'src/agent/library/flow_follow.js',
            'src/agent/self_prompter.js',
            'src/agent/conversation.js',
            'src/agent/tasks/**/*.js',
        ],
        pattern: /\bbot\.chat\s*\(/,
    },
    {
        id: 'rcon-password-literal',
        why: 'RCON 密码不写死在源码 / 脚本里（应绑本机 + 换密码 + 从 server.properties 读）',
        files: ['src/agent/**/*.js', 'tools/**/*.mjs'],
        allow: [],
        pattern: /\b(password|passwd)\b\s*[:=]\s*['"][^'"\n]+['"]/i,
    },
];

/** glob（相对路径，/ 分隔）→ 正则。只支持 * ? **，够用了，别引依赖。 */
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {          // ** 跨目录
                i++;
                if (glob[i + 1] === '/') i++;
                re += '.*';
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
        }
    }
    return new RegExp(`^${re}$`);
}

const API_SCAN_SKIP_DIRS = new Set(['node_modules', 'bots', '.git', 'dist', 'build']);

/** 收集要扫的源码：{ path: '相对/仓库/根的/posix/路径', text } */
function collectApiScanSources() {
    const out = [];
    const seen = new Set();
    const walkFiles = (dir) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (API_SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) { walkFiles(p); continue; }
            if (!/\.(m?js)$/.test(e.name)) continue;
            const relPath = p.slice(PROJECT_ROOT.length).replace(/\\/g, '/');
            if (seen.has(relPath)) continue;
            seen.add(relPath);
            try { out.push({ path: relPath, text: readFileSync(p, 'utf8') }); } catch { /* 读不了就跳过 */ }
        }
    };
    for (const root of API_SCAN_ROOTS) {
        const abs = join(PROJECT_ROOT, root);
        if (existsSync(abs)) walkFiles(abs);
    }
    return out;
}

/**
 * 把 JS 源码的注释（以及可选的字符串内容）换成空格，**保留所有字符偏移与换行**。
 *
 * 为什么必须有这一步（t1 骨架留下的坑，A.4 补上）：
 *   骨架版直接对原文做正则，于是文档注释里提到 setControlState 也算命中
 *   （当时 `atom_boat` 的注释、`atom_dig` 里「契约不允许原子直接按键」那句都是）。
 *   不清掉注释，唯一的出路就是给注释加豁免 —— 豁免名单立刻变脏，以后真违规也看不出来。
 *
 * ★ T05 修：**认得正则字面量**。
 *   旧版只认行注释和块注释、以及引号；遇到正则字面量里的引号就整段错位 ——
 *   典型是 `commands/index.js:59` 的 `/!(\w+)…"[^"]*"…/`：里面的 `"` 被当成字符串开头，
 *   于是它一路"吞"到下一个 `"`，把后面 82 行 JSDoc 当成字符串内容，**注释根本没被抹掉**。
 *   这是实测出来的：剥注释后该文件仍有 82 行注释原样残留，而全仓其它 165 个文件都干净。
 *   错位的后果很实在 —— §3 错误码审计会去扫注释里的举例（board 那次 preflight 直接红）。
 *
 * @param {string} text
 * @param {object} opts
 *   strings=true  连字符串 / 模板字面量的内容也抹掉（引号保留）→ 用来扫 `bot.xxx(` 这类 API
 *   strings=false 只抹注释、字符串内容保留        → 用来扫「写在字符串里的斜杠命令」
 * @returns {string} 与原文等长、偏移一一对应
 */
function maskJsSource(text, { strings = true } = {}) {
    const out = text.split('');
    const n = text.length;
    const blank = (from, to) => {
        for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
    };
    /**
     * 这个 `/` 是"正则字面量的开头"还是"除号"？
     * 判据（业界通行的做法）：看**前一个非空白字符**。
     *   `=` `(` `,` `:` `[` `!` `&` `|` `?` `{` `}` `;` `+` `-` `*` `%` `~` `<` `>` 之后、
     *   或行首 / 关键字 return·typeof·case·in·of·new·delete·void·do·else 之后 → 正则
     *   `)`、`]`、标识符、数字、引号、`++`/`--` 之后 → 除号
     * 判错只会让"某个正则里的斜杠被当成注释开头"或反之，比整段错位安全得多。
     */
    const regexAllowedAfter = (pos) => {
        let k = pos - 1;
        while (k >= 0 && /\s/.test(text[k])) k--;
        if (k < 0) return true;                       // 文件/行开头
        const prev = text[k];
        if ('=(,[:!&|?{};+-*%~<>'.includes(prev)) return true;
        if (prev === ')' || prev === ']') return false;
        // 关键字结尾（return / typeof / case / in / of / new / delete / void / do / else）
        const head = text.slice(Math.max(0, k - 8), k + 1);
        if (/\b(return|typeof|case|in|of|new|delete|void|do|else)$/.test(head)) return true;
        // 除号：前面是标识符/数字/引号/右括号
        return false;
    };

    let i = 0;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (c === '/' && c2 === '/') {
            let j2 = i;
            while (j2 < n && text[j2] !== '\n') j2++;
            blank(i, j2);
            i = j2;
            continue;
        }
        if (c === '/' && c2 === '*') {
            let j2 = i + 2;
            while (j2 < n && !(text[j2] === '*' && text[j2 + 1] === '/')) j2++;
            j2 = Math.min(n, j2 + 2);
            blank(i, j2);
            i = j2;
            continue;
        }
        // ★ 正则字面量：整段跳过，避免里面的引号被当成字符串开头（T05）
        if (c === '/' && regexAllowedAfter(i)) {
            let j2 = i + 1;
            let inClass = false;                       // 字符类 [...] 里的 `/` 不结束正则
            while (j2 < n) {
                const ch = text[j2];
                if (ch === '\\') { j2 += 2; continue; }
                if (ch === '\n') break;                // 未闭合：当它到此为止，别吞掉后面整份文件
                if (ch === '[') { inClass = true; j2++; continue; }
                if (ch === ']') { inClass = false; j2++; continue; }
                if (ch === '/' && !inClass) { j2++; break; }
                j2++;
            }
            // 跳过 flags
            while (j2 < n && /[a-z]/.test(text[j2])) j2++;
            i = j2;                                    // 正则内容原样保留（里面的字符串内容本就不是注释）
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const q = c;
            let j2 = i + 1;
            while (j2 < n) {
                if (text[j2] === '\\') { j2 += 2; continue; }
                if (text[j2] === q) break;
                j2++;
            }
            if (strings) blank(i + 1, j2);
            i = j2 + 1;
            continue;
        }
        i++;
    }
    return out.join('');
}


/** 在文本里找全部命中位置。pattern 是正则（自动补 g）或按字面量找的字符串。 */
function findAllHits(text, pattern) {
    const hits = [];
    if (pattern instanceof RegExp) {
        const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
        for (const m of text.matchAll(re)) hits.push(m.index);
        return hits;
    }
    const needle = String(pattern);
    if (!needle) return hits;
    let i = 0;
    while ((i = text.indexOf(needle, i)) !== -1) { hits.push(i); i += needle.length; }
    return hits;
}

/** 字符下标 → 行号 / 列号（1 起）+ 该行内容（截断，报告里直接能看）。 */
function locateInText(text, index) {
    const before = text.slice(0, index);
    const line = before.split('\n').length;
    const col = index - (before.lastIndexOf('\n') + 1) + 1;
    const raw = text.slice(index).split('\n')[0] ?? '';
    const snippet = raw.trim().replace(/\s+/g, ' ');
    return { line, col, snippet: snippet.length > 100 ? `${snippet.slice(0, 100)}…` : snippet };
}

{
    console.log(`
[4/4] API 扫描（${API_SCAN_ENFORCE ? '命中即判失败；--report-api 退回只报告' : '只报告（--report-api）'}）`);
    const sources = collectApiScanSources();
    const active = API_SCAN_RULES.filter((r) => r.enabled !== false);
    console.log(`  扫 ${sources.length} 个文件，${active.length} 条规则`);
    // ★ t99 护栏（两条）：0 个文件 / 0 条规则 → 命中数必然 0 → 会打「✓ API 扫描没有命中」，假绿。
    const gotApiFiles = requireScanned('4 API 扫描', sources.length, '源文件（glob 没匹配到任何文件）',
        '检查 collectApiScanSources() 的 glob 与 cwd；扫不到文件时"0 处命中"没有意义');
    const gotApiRules = requireScanned('4 API 扫描', active.length, '启用中的规则',
        '规则表为空曾是"骨架阶段合法"，现在规则已存在 → 空表意味着规则没加载成功');

    let totalHits = 0;
    for (const rule of active) {
        const fileRes = (rule.files ?? ['src/agent/**/*.js']).map(globToRegExp);
        const allowRes = (rule.allow ?? []).map(globToRegExp);
        const hits = [];
        for (const src of sources) {
            if (!fileRes.some((re) => re.test(src.path))) continue;
            if (allowRes.some((re) => re.test(src.path))) continue;
            // scan:'raw' = 只去注释（要看得到字符串里的斜杠命令）；默认 'code' = 去注释 + 去字符串
            const scanText = rule.scan === 'raw'
                ? maskJsSource(src.text, { strings: false })
                : maskJsSource(src.text, { strings: true });
            // 单 pattern 与多 patterns 都支持。注意 rule.pattern 可能**不存在**
            // （只用 patterns 的规则）—— 不判空就会把 String(undefined) 当成字面量去搜 "undefined"。
            const allPatterns = [
                ...(rule.pattern === undefined ? [] : [rule.pattern]),
                ...(rule.patterns ?? []),
            ];
            for (const pat of allPatterns) {
                for (const idx of findAllHits(scanText, pat)) {
                    hits.push({ file: src.path, ...locateInText(src.text, idx) });
                }
            }
        }
        totalHits += hits.length;

        const mark = hits.length === 0 ? '✓' : (API_SCAN_ENFORCE ? '✗' : '⚠');
        console.log(`  ${mark} [${rule.id}] ${hits.length} 处${rule.why ? ` —— ${rule.why}` : ''}`);
        for (const h of hits.slice(0, API_SCAN_MAX_REPORT)) {
            console.log(`      ${h.file}:${h.line}:${h.col}  ${h.snippet}`);
        }
        if (hits.length > API_SCAN_MAX_REPORT) {
            console.log(`      …还有 ${hits.length - API_SCAN_MAX_REPORT} 处（调 API_SCAN_MAX_REPORT 可放开）`);
        }
        if (hits.length > 0 && API_SCAN_ENFORCE) failed++;
    }

    if (active.length === 0) {
        // ★ t99：原来这里只打 `·` 不判失败（骨架阶段合法）。现在规则已存在，
        //   空表 = 规则没加载成功 → 已在上面 requireScanned 判失败，这里只补充说明。
        console.log('  · 规则表是空的（骨架阶段曾合法；现在出现即表示规则没加载）');
    } else if (totalHits === 0 && gotApiFiles) {
        console.log('  ✓ API 扫描没有命中');
    } else if (totalHits === 0) {
        console.log('  · 命中 0 处，但**扫描输入无效** → 已按护栏判失败，不算通过');
    } else {
        // ★ S36（T05）：原来这里提示用 `--strict-api` 重新验 —— 但那是 §5 前缀 import 规则的开关，
        //   跟 API 扫描无关（API 扫描的开关是 `--report-api`）。照着旧提示敲命令的人会
        //   得到"门禁强度没变"的困惑，甚至以为已经验过。参数名写错，等于把说明变成陷阱。
        console.log(`  · 共 ${totalHits} 处命中：当前是 \`--report-api\` 只报告模式（不判失败）；` +
            '去掉该参数即恢复「命中即判失败」。');
    }
}

// ───────────────────────────────────────────────────────────────────────────
// [5/5] 前缀 import 规矩（Phase R · 02_actions.md §5）
//
// 为什么要有这一层：改完前缀之后"文件名就是层级"，但**没有任何东西保证层没有被绕过**。
// 之前 `commands/actions.js:8` 直接 import 了 `atom_place.placeBlockAt`（现在是 `act_place`）——
// 上游命令层伸手去调动作，跳过整个流程层，这类错误编译器完全看不出来。
//
// 判据照抄 02 §5 那张表（"谁能 import 谁"）。**只报不改**：这一层先当门禁，
// 真要重构的地方按 Phase 5.4 另开任务（目前已知 1 处：commands → act_place）。
// ───────────────────────────────────────────────────────────────────────────

/** 文件 → 层（看前缀；没前缀的基础设施返回 'infra'）。 */
function layerOfFile(relPath) {
    const base = relPath.split('/').pop().replace(/\.js$/, '');
    // commands/ 是命令层，单独一档（规矩最严：不许碰动作和原子）
    if (/\/commands\//.test(relPath)) return 'commands';
    if (base.startsWith('atom_input_') || base === 'atom_read' || base === 'atom_wait'
        || base === 'atom_wait_item' || base === 'atom_look') return 'atom';
    if (base.startsWith('query_')) return 'query';
    if (base.startsWith('act_')) return 'act';
    if (base.startsWith('nav_')) return 'nav';
    if (base.startsWith('flow_')) return 'flow';
    if (base.startsWith('strat_')) return 'strat';
    if (base.startsWith('board_')) return 'board';
    return 'infra';                       // contract / step_runner / trace_bus / terrain3d / modes …
}

/**
 * 每层能 import 哪些层（02 §5）。
 *   atom   : mineflayer、基础设施
 *   query  : 读取原子、别的查询（+ 基础设施）
 *   act    : 原子、查询（+ 基础设施）；动作之间不互相调用
 *   nav    : 原子、查询、单格动作（下面 SINGLE_CELL_ACTIONS 名单）
 *   flow   : 动作、导航、查询、原子、别的流程（+ 基础设施）
 *   commands: 流程、策略、任务板、查询（+ 基础设施）；**不许 import 动作和原子**
 */
const PREFIX_IMPORT_ALLOW = {
    atom: ['atom', 'infra'],
    query: ['atom', 'query', 'infra'],
    act: ['atom', 'query', 'infra'],
    nav: ['atom', 'query', 'infra'],
    flow: ['atom', 'query', 'act', 'nav', 'flow', 'infra'],
    strat: ['query', 'flow', 'strat', 'board', 'infra'],
    board: ['query', 'infra'],
    commands: ['query', 'flow', 'strat', 'board', 'infra'],
    infra: ['atom', 'query', 'act', 'nav', 'flow', 'infra'],
};

/**
 * 导航层唯一允许直接调的几个**单格动作**（02 §5 明列）。
 * 其余 act_* 一律不许：要动地形就走动作本身，别在导航里编排。
 */
const NAV_ALLOWED_ACT_FUNCS = new Set([
    'stepInto', 'climb', 'pillarUp', 'sinkInWater', 'swimStep', 'digBlock', 'placeBlockAt',
    'climbUp', 'climbDown', 'pillarUpOnce',       // 现名（改造中的等价物）
]);

/** 从一行 import 里取被 import 的本地文件路径（相对路径才管，第三方不管）。 */
function importedLocalPaths(line) {
    const out = [];
    const m = line.match(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/);
    const m2 = line.match(/^\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/);          // 动态 import
    for (const mm of [m, m2]) {
        if (!mm) continue;
        const spec = mm[1];
        if (spec.startsWith('.')) out.push(spec);
    }
    return out;
}

/** 相对 import 规格 + 当前文件 → 归一化的仓库相对路径（只处理落在 src/agent 下的）。 */
function resolveLocal(relPath, spec) {
    const dir = relPath.split('/').slice(0, -1);
    const parts = spec.split('/');
    for (const p of parts) {
        if (p === '.' || p === '') continue;
        if (p === '..') dir.pop();
        else dir.push(p);
    }
    let p = dir.join('/');
    if (!p.endsWith('.js')) p += '.js';
    return p;
}

/**
 * 同层 import 的**只读工具白名单**（同层 = act_*→act_* / query_*→query_*）。
 *
 * ★ 2026-11-01（t10，captain 定稿口径）：
 *   **一份白名单 + 默认拒绝** —— 符号 ∈ 本集合 → 放行；其余**一律违规**（含不认识的符号）。
 *   所以 `digBlock` / `placeBlockAt` 这些副作用入口**不需要黑名单**：不在白名单里就自然违规。
 *
 *   为什么要这条：原来同层一律放过（`if (targetLayer === selfLayer) return`），注释还写着
 *   「动作之间不互相调用是行为约定，靠 review 不靠 import 图」。实测后果：`act_pillar` 里
 *   `import { digBlock } from './act_dig.js'` **完全拦不住**（检查条数 256→257 说明扫到了，
 *   违规数不变、exit 0）—— 那条规矩等于纸做的。
 *
 *   **新增符号必须显式加进来，并在下面写一句「为什么它是纯读/纯判断、为什么不搬去 query_*」。**
 *   白名单是数据驱动的显式集合，不许改成隐式正则。
 *
 *   判据只跑在**剥掉注释后**的代码上（见下方 `lines`）—— 否则文档注释里提到的
 *   `digBlock(bot, pos)` 会被当成真调用（atom_boat 那次注释假命中的教训）。
 */
const PURE_SIBLING_IMPORTS = new Set([
    // ── act_items 的只读工具（待办：搬去 query_items 后即可从这里删）──────────────
    'findItem',            // 查"包里有没有这个物品、在第几格"：只读 inventory，不动手
    // ── act_container 的只读工具 ────────────────────────────────────────────────
    'containerKindOf',     // 判"这个方块名对应哪类容器"：查 registry + 正则，纯判断
    'windowItems',         // 列"当前窗口里有哪些格子/物品"：读 bot.currentWindow 快照，纯读
    // ── act_dig 的纯判断 ───────────────────────────────────────────────────────
    'isDiggable',          // 判"这类方块能不能挖"：查黑名单表，纯判断
    'canDigWithInventory', // 判"手上工具够不够挖它"：查背包 + 工具等级，纯判断
    // ── act_attack 的纯查询 ────────────────────────────────────────────────────
    'nearestAttackable',   // 找"最近的可攻击目标"：只遍历 entities 比较距离，不挥击
    // ── query_* 的纯读取 ───────────────────────────────────────────────────────
    'blockAt',             // 读"那一格是什么方块"：一次世界查询
    'findBlocks',          // 找"符合名字的方块都在哪"：一次世界查询
    'canStand',            // 判"那一格能不能站人"：读脚下/头顶，纯判断
    'countItem',           // 数"某物品有几个"：只读 inventory
    // 故意不在名单里（副作用入口，上层应走原子或由流程编排）：
    //   digBlock / placeBlockAt / useOnBlock / openContainer / equipItem / dropItem / tunnelStep …
]);

/** 从一行 import 取具名导入的**原符号名**（`a as b` 取 `a`）；不是具名 import 返回 null。 */
function namedImportSymbols(line) {
    const m = line.match(/^\s*import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
    if (!m) return null;
    return m[1].split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
}

{
    const sources = collectApiScanSources().filter((s) => s.path.startsWith('src/agent/'));
    const violations = [];
    let checked = 0;

    for (const src of sources) {
        const selfLayer = layerOfFile(src.path);
        const lines = maskJsSource(src.text, { strings: false }).split('\n');
        const raw = src.text.split('\n');
        lines.forEach((line, i) => {
            for (const spec of importedLocalPaths(line)) {
                const target = resolveLocal(src.path, spec);
                if (!target.startsWith('src/agent/')) return;
                // 转发文件与被 import 的文件同层判定（按真身名判：转发的旧名也有前缀）
                const targetLayer = layerOfFile(target);
                if (targetLayer === 'infra' || selfLayer === 'infra') { checked++; return; }
                const allowed = PREFIX_IMPORT_ALLOW[selfLayer] ?? [];
                // ── 同层：层间规矩不管这一格，但 02 §5「动作之间不互相调用」必须管。 ──
                //
                // ★ 2026-11-01（t10）：这里原来是 `if (targetLayer === selfLayer) { checked++; return; }`
                //   一律放过 → `act_pillar → act_dig.digBlock` 谁都拦不住（已用注入实测证明）。
                //   现在改成按**导入了哪个符号名**判：白名单外的符号一律违规（默认拒绝）。
                //   只对 act_* / query_* 判（这两层的语义最严：动作不互相调用、查询只读）。
                if (targetLayer === selfLayer) {
                    if (selfLayer === 'act' || selfLayer === 'query') {
                        const syms = namedImportSymbols(line);
                        if (syms === null) {
                            // default / import * as ns / 纯副作用 import：符号名不可审计 → 判违规
                            violations.push({
                                file: src.path, line: i + 1, target,
                                selfLayer, targetLayer, symbols: [],
                                snippet: raw[i].trim().slice(0, 100),
                                why: '同层 import 用了非具名形式（default / namespace），审计不了调的是哪个函数',
                            });
                        } else {
                            const bad = syms.filter((s) => !PURE_SIBLING_IMPORTS.has(s));
                            if (bad.length) {
                                violations.push({
                                    file: src.path, line: i + 1, target,
                                    selfLayer, targetLayer, symbols: bad,
                                    snippet: raw[i].trim().slice(0, 100),
                                    why: `同层导入了非只读符号：${bad.join(' / ')}`,
                                });
                            }
                        }
                    }
                    checked++;
                    return;
                }
                if (!allowed.includes(targetLayer)) {
                    violations.push({
                        file: src.path, line: i + 1, target,
                        selfLayer, targetLayer,
                        snippet: raw[i].trim().slice(0, 100),
                    });
                }
                checked++;
            }
        });
    }

    console.log('\n[5/5] 前缀 import 规矩（02 §5）');
    console.log(`  扫 ${sources.length} 个文件，检查 ${checked} 条本地 import，违规 ${violations.length} 处`);
    // ★ t99 护栏（两条）：0 个文件 / 0 条 import → violations 必然为空 → 会打「✓ 没有命中」，假绿。
    const gotPrefixFiles = requireScanned('5 前缀规矩', sources.length, '源文件',
        '检查 layerOfFile/扫描根是否指对；扫不到文件时"0 处违规"没有意义');
    const gotPrefixImports = requireScanned('5 前缀规矩', checked, '本地 import 语句',
        '一条 import 都没读到 → 可能是解析正则失效（不是"没有违规"）');
    // ── 已知违规（点名记录，不是悄悄放过）────────────────────────────────
    //
    // 这些是**真问题**，只是不在 t9（改名+收敛）的范围里：改它们要动结构。
    // 名单要短、要有到期日；每条都必须写清"留给谁、在哪个阶段"。
    const KNOWN_PREFIX_VIOLATIONS = [
        {
            file: 'src/agent/commands/actions.js', target: 'src/agent/library/act_place.js',
            why: '命令层直接 import 动作 placeBlockAt（02 §5 原文就点了这处）',
            todo: 'Phase 5.4：改成调流程（如 flow_build 的 placeOne），commands 只碰流程/查询',
        },
        {
            file: 'src/agent/library/atom_read.js', target: 'src/agent/library/query_perceive.js',
            why: '原子层转出查询层的 findBlocks（atom_read 只是转发，未自带实现）',
            todo: 'Phase R 收尾：把 findBlocks 的实现搬进 atom_read（读取原子的真身），query_perceive 反向复用',
        },
        {
            file: 'src/agent/library/atom_read.js', target: 'src/agent/library/act_container.js',
            why: '原子层转出动作层的 windowItems',
            todo: '同上：windowItems 是纯读取，应搬进 atom_read；act_container 反向复用',
        },
        {
            file: 'src/agent/library/atom_input_inventory.js', target: 'src/agent/library/act_container.js',
            why: 'closeWindow 转出 act_container.closeContainer（避免两份实现）',
            todo: 'Phase R 收尾：closeContainer 的 bot.closeWindow 那一层搬进 atom_input_inventory，act_container 反向复用',
        },
    ];

    /**
     * ── 收紧同层规则后**新暴露**的真问题（不是悄悄放过，也不是现在就判死）──────────
     *
     * ★ 2026-11-01（t10，captain 定稿）：把"同层一律放过"改成"白名单外一律违规"之后，
     *   `act_use:15 → act_container.openContainer` 露出来了 —— 动作调动作的**副作用入口**。
     *   它**不许塞进白名单**（塞进去就等于把规则改回纸做的）。
     *
     *   处置按 captain 口径：**默认模式只报告（exit 0）**，`--strict-api` 下判失败（exit 1），
     *   避免"每天开机就因为一条已知真问题红着"、也避免"红了就被顺手加白名单"。
     *   修完就删这条，届时 strict 也应恢复 exit 0。
     */
    const TIGHTENED_NEW_VIOLATIONS = [
        // ★ 2026-11-03（t44，已销账，列表恢复为空）：
        //   `act_use.js:15 → act_container.openContainer` 那条已消除 —— 不是加白名单，
        //   而是**删掉了违规本身**：`act_use.useBlock` 这段"按方块类型分派到门/床/工作站/作物"
        //   的分派壳，其四类交互早已按 02 §3 拆成独立动作（act_blockuse / act_rest / act_farm /
        //   act_container），生产代码零调用方，02 §3 也**没有** `use`/`useBlock` 这个动作行
        //   （line 73 明写 toggleBlock 是「🔀 从 atom_use 拆」）→ 这个壳就是"拆完没清理"的残留。
        //   删完 strict 恢复 exit 0。以后再出现同层次的真问题，照旧往这里加。
    ];

    const knownKey = (v) => `${v.file}|${v.target}`;
    const knownMap = new Map(KNOWN_PREFIX_VIOLATIONS.map((k) => [`${k.file}|${k.target}`, k]));
    const tightenedMap = new Map(TIGHTENED_NEW_VIOLATIONS.map((k) => [`${k.file}|${k.target}`, k]));
    const STRICT_PREFIX = process.argv.includes('--strict-api');

    const unexpected = [];
    const tightened = [];
    for (const v of violations) {
        const k = knownMap.get(knownKey(v));
        if (k) { console.log(`  · 已知（${k.todo.split('：')[0]}）${v.file}:${v.line} ${v.selfLayer}→${v.targetLayer}`); continue; }
        const t = tightenedMap.get(knownKey(v));
        if (t) { tightened.push({ v, t }); continue; }
        unexpected.push(v);
    }
    for (const { v, t } of tightened) {
        console.log(`  ⚠ 收紧后新暴露 ${v.file}:${v.line}  ${v.selfLayer} → ${v.targetLayer}`
            + `  [符号 ${v.symbols?.join(', ') || '?'}]`);
        console.log(`      ${t.why}`);
        console.log(`      归属：${t.todo.split('：')[0]}（见 Phase R 台账）`
            + (STRICT_PREFIX ? '  ← --strict-api：判失败' : '  ← 默认只报告；--strict-api 会判失败'));
    }
    if (STRICT_PREFIX && tightened.length) failed++;
    if (unexpected.length) {
        failed++;
        for (const v of unexpected) {
            const syms = v.symbols?.length ? `  [符号 ${v.symbols.join(', ')}]` : '';
            console.log(`  ✗ 新违规 ${v.file}:${v.line}  ${v.selfLayer} → ${v.targetLayer}  目标 ${v.target}${syms}`);
            if (v.why) console.log(`      ${v.why}`);
            console.log(`      ${v.snippet}`);
        }
    } else if (violations.length && gotPrefixFiles && gotPrefixImports) {
        const extra = tightened.length ? `，其中 ${tightened.length} 处为收紧后新暴露（${STRICT_PREFIX ? '已判失败' : '默认只报告'}）` : '';
        console.log(`  ✓ 除 ${violations.length} 处已知违规外没有新违规${extra}`);
    }
    // ★ t99：只有"确实扫到了文件 + 确实读到了 import"时才敢说"没有命中"
    if (violations.length === 0 && gotPrefixFiles && gotPrefixImports) {
        console.log('  ✓ 前缀 import 规矩没有命中');
    } else if (violations.length === 0) {
        console.log('  · 违规 0 处，但**扫描输入无效** → 已按护栏判失败，不算通过');
    }
}

// ---- [6/6] 依赖注入审计（**A 档死分支参与失败判定**）----------------------
//
// ★★ 2026-11-04（t97）：把 control 写的 `deps_injection_audit` 接进门禁。
//
//   为什么必须接：今晚最大的教训之一是「**单测注入 → 生产不注入**」
//   （同族 5 例：availableSkills / planNeeds 5 字段 / ctx.board / ctx.jobId / tool_tier 的 obtain）。
//   这类 bug 让 **`!do xxx` 报 ok 却什么都不干**，而所有单测都是绿的 ——
//   「**单测越绿，越说明生产那条路没人走**」（control 的原话）。
//
//   工具判据：
//     A 档（死分支）= `deps.F` 有 `if (!F) return ok/fail/continue` 早退，
//                    但注册表 `run:` 绑定没提供 F → **exit 1**
//     C 档（信息）= 读了 `deps.F` 但没有早退分支（静默退化成空）→ 只报告
//   **A 档有货就判失败**。
console.log("");console.log("[6/6] 依赖注入审计（A 档 = 单测能测到、生产走不到的死分支）");
{
    try {
        const { spawnSync } = await import('node:child_process');
        // ★ 注意：preflight 里的 `ROOT` 是 **`src/agent/`**（看第 14 行），不是仓库根！
        //   我第一版用 `join(ROOT, 'tools', ...)` → 拼出 `src/agent/tools/...` → 文件不存在
        //   → spawnSync status 非 0 → **误判成"A 档有货"**。
        //   （工具没跑起来 ≠ 工具报了问题 —— 这两件事必须分开。）
        const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));   // tools/ 的上一级 = 仓库根
        const AUDIT = join(REPO_ROOT, 'tools', 'deps_injection_audit.mjs');

        // ══════════════════════════════════════════════════════════════════
        // ★★ 6a：**先跑 `--selftest`（扫描器自测），过了才继续跑审计。**
        //
        // 为什么（2026-11-04，control 的建议 —— 「三态原则的递归应用」）：
        //   `--selftest` 上线第一跑就抓到 **control 自己两个错**（夹具漏 `return {`、
        //   断言写反）。这证明：**扫描器的自测也可能失效**。
        //   如果 selftest 自己不跑，我们就不知道审计还准不准 ——
        //   "审计报 0 处"到底是"真的没有"还是"它看不见"，永远无法区分。
        //
        //   原状态：检测了-有问题→失败 ✅｜检测了-没问题→通过 ✅｜**根本没检测→通过** ❌
        //   现在补上第三态：**没检测 / 自测不过 → 失败**。
        // ══════════════════════════════════════════════════════════════════
        const st = spawnSync(process.execPath, [AUDIT, '--selftest'], { cwd: REPO_ROOT, encoding: 'utf8' });
        const stOut = (st.stdout ?? '') + (st.stderr ?? '');
        const stM = stOut.match(/扫描器自测[：:]\s*(\d+)\s*passed,\s*(\d+)\s*failed/);
        const stPassed = stM ? Number(stM[1]) : 0;
        const stFailed = stM ? Number(stM[2]) : -1;
        // 阈值：至少 6 条（6 种形态）且 0 失败 —— "跑完了但只跑 2 条"同样不可信
        const selftestOk = !!stM && stFailed === 0 && stPassed >= 6;

        if (!selftestOk) {
            failed++;
            if (!stM) {
                console.log('  ✗ 扫描器自测**没跑起来**（输出里没有「扫描器自测：N passed, M failed」指纹）');
                console.log(`     status=${st.status}  输出前 120 字=${stOut.slice(0, 120).replace(RegExp(String.fromCharCode(10), 'g'), ' | ')}`);
            } else {
                console.log(`  ✗ 扫描器自测**不过**（${stPassed} passed / ${stFailed} failed，要求 ≥6 且 0 失败）`);
                for (const l of stOut.split(String.fromCharCode(10))) if (/FAIL/.test(l)) console.log('     ' + l.trim());
            }
            console.log('     → **审计结果不可信**：自测不过时"审计报 0 处"没有意义，本段不判干净');
        } else {
            console.log(`  ✓ 扫描器自测 ${stPassed}/${stPassed} 通过（6 种代码形态都能看见，才开始信任审计）`);
        }

        if (!selftestOk) {
            // 自测不过 → 不跑审计（跑了也不可信），本段到此结束
        } else {
        const r = spawnSync(process.execPath, [AUDIT],
            { cwd: REPO_ROOT, encoding: 'utf8' });
        const out = (r.stdout ?? '').trim();
        // 只摘出 A 档那几行，别把 C 档的 13 条全铺开（那是"需要人判断"的信息）
        // ★ 只摘「A·」那一段 —— 工具的 A 档段落以 `── A·...` 开头，到 `── C·` 或 `合计` 结束。
        //   （不能匹配 "A 档" 三个字：C 档说明里也有"A 档要求……"，会误判成失败。
        //     也不能只匹配 ✗：工具在 A 档段落里用的是 `·` 前缀。）
        const allLines = out.split(String.fromCharCode(10));
        const aStart = allLines.findIndex((l) => /──\s*A·/.test(l));
        let aLines = [];
        if (aStart >= 0) {
            for (let i = aStart; i < allLines.length; i += 1) {
                if (i > aStart && /──\s*C·|^合计/.test(allLines[i])) break;
                aLines.push(allLines[i]);
            }
        }
        // ★★★ 2026-11-04（t98，control 的建议 —— 它正中我踩过的坑）：
        //   **工具没跑起来 ≠ 工具报了"没有问题"。**
        //
        //   我接线时把 ENOENT 当成了"A 档有货"，但反过来更危险：
        //   如果审计**静默失败**（路径错 / 崩溃 / 输出为空），我原来的写法会打一句警告
        //   然后 `failed` 不 ++ → **绿灯** → 读成"0 处 = 干净"。
        //   **"什么都没检测到"和"检测了、没有"在报告里长得一模一样。**
        //
        //   所以：**必须看到工具确实跑完的指纹**（A· 或 C· 段标记 + 合计行），
        //   看不到就判失败（"审计没跑起来"），而不是给绿灯。
        const sawASection = SAW_A_SECTION.test(out);
        const sawCSection = /──\s*C·/.test(out);
        const ranOk = sawASection || sawCSection;

        if (!ranOk) {
            failed++;
            console.log('  ✗ 审计**没跑起来**（输出里没有 A·/C· 段标记）—— 不能当成"0 处干净"');
            console.log(`     status=${r.status}  stdout 前 120 字=${out.slice(0, 120).replace(RegExp(String.fromCharCode(10), 'g'), ' | ')}`);
            console.log(`     stderr=${(r.stderr ?? '').slice(0, 160)}`);
        } else if (r.status !== 0 && aLines.length) {
            failed++;
            console.log('  ✗ A 档有货（生产绑定没提供 deps 字段，对应分支永远走不到）:');
            for (const l of aLines) console.log('     ' + l.trim());
        } else if (r.status !== 0) {
            // 有段标记但退出码非 0 且没有 A 段内容 → 工具自身异常
            failed++;
            console.log(`  ✗ 审计工具异常退出（status=${r.status}，有段标记但无 A 档明细）`);
            console.log(`     stderr=${(r.stderr ?? '').slice(0, 160)}`);
        } else {
            console.log('  ✓ A 档 0 处（没有"单测能测到、生产走不到"的死分支）');
        }
        }   // ← 关闭 `if (selftestOk) { … }`（自测不过时不跑审计）
    } catch (e) {
        // ★ t98：**工具跑不起来也判失败。**
        //   原来的写法是"只警告不失败" —— 但那等于"防护失效时绿灯"，
        //   比"防护发现了问题"危险得多（control 的建议）。
        //   审计工具是**门禁的一部分**：它自己坏了，门禁就不成立。
        failed++;
        console.log(`  ✗ 审计工具没跑起来（判失败 —— 防护失效不能当通过）：${String(e?.message ?? e).slice(0, 120)}`);
    }
}

// ---- [7/7] 代码规模（**统计信息，不参与失败判定**）----------------------
//
// 为什么放这里：§九「代码规模」原来写死在交接文档里（55 / 89），
// 之后 M10 收尾 + A 系列 + 遗留清理又加了 33 个提交，一直没更新 → 数字变旧没人发现。
// **让数字自己从代码里算出来，是唯一能根治的办法**（今晚 3 次"数字没标口径/没归档"）。
//
// 三条硬规矩（captain 定）：
//   1. 统计**不参与** failed 判定 —— 退出码语义不变（默认 0 / --strict-api 0）
//   2. **算不出来就显示 `—`，绝不给 0** —— 0 会被读成"真的没有"
//   3. 每一项都要打印**来源命令**，别人能复核
{
    const { execFileSync } = await import('child_process');
    const UNKNOWN = '—';

    /** 递归数某目录下的 .js（等价 `find <dir> -name '*.js' | wc -l`）。 */
    const countJs = (dir) => {
        try {
            let n = 0;
            const rec = (d) => {
                for (const f of readdirSync(d)) {
                    const p = join(d, f);
                    if (statSync(p).isDirectory()) rec(p);
                    else if (f.endsWith('.js')) n++;
                }
            };
            rec(dir);
            return String(n);
        } catch { return UNKNOWN; }
    };

    /** 跑一条 git 命令；不可用/失败一律 `—`（不许显示 0）。 */
    const gitLines = (args) => {
        try {
            const out = execFileSync('git', args, { cwd: join(ROOT, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return out.trim() ? out.trim().split('\n').length : UNKNOWN;
        } catch { return UNKNOWN; }
    };

    /**
     * 跑一条**输出本身就是那个数字**的 git 命令（如 `rev-list --count`）。
     * ★ 不能复用 gitLines：`rev-list --count HEAD` 只输出一行 "123"，
     *   数行数会得到 1 —— 我第一版就踩了这个，显示"重构提交数 1"。
     */
    const gitText = (args) => {
        try {
            const out = execFileSync('git', args, { cwd: join(ROOT, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const t = out.trim();
            return t === '' ? UNKNOWN : t;
        } catch { return UNKNOWN; }
    };

    /** `composite_registry.SKILL_NAMES.length`（注册表技能数）。 */
    const skillCount = async () => {
        try {
            const m = await import(pathToFileURL(join(ROOT, 'library/composite_registry.js')).href);
            return Array.isArray(m.SKILL_NAMES) ? String(m.SKILL_NAMES.length) : UNKNOWN;
        } catch { return UNKNOWN; }
    };

    /** `contract.CODES.length`（错误码数）。 */
    const codeCount = async () => {
        try {
            const m = await import(pathToFileURL(join(ROOT, 'library/contract.js')).href);
            return Array.isArray(m.CODES) ? String(m.CODES.length) : UNKNOWN;
        } catch { return UNKNOWN; }
    };

    /**
     * `unit_all` 的注册/执行/跳过数 —— **问它本人要，不自己解析**（实跑要几分钟，装不进门禁）。
     *
     * ★ T05（新增2）：原来是文本解析 `const UNITS = [...]` 两个字面量列表。
     *   T03 把 UNITS 改成 `readdirSync('tools').filter(/_unit\.mjs$/)` 自动发现之后，
     *   那段正则就永远匹配不到 → [7/7] 打出「测试脚本 — ← 清单解析失败」。
     *   当时的修法选择：让 unit_all 提供 `--list` 导出机器可读清单，这里只消费。
     *   **不在这里重新实现一遍发现规则** —— 否则"哪些脚本算单测"就有两份真相，
     *   改一处必须记得改两处，迟早点漂（这正是 S34 那条的同一类问题）。
     */
    const unitStats = () => {
        try {
            // 用 execFileSync（与本段其它命令一致，不另引 spawnSync）
            const out = execFileSync(process.execPath,
                [join(ROOT, '../../tools/unit_all.mjs'), '--list'],
                { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
            const j = JSON.parse(String(out ?? ''));
            if (!Number.isInteger(j?.registered) || j.registered <= 0) return null;
            return { registered: j.registered, executed: j.executed, skipped: j.skipped };
        } catch { return null; }
    };

    const units = unitStats();
    console.log('[7/7] 代码规模（统计信息，不参与失败判定；**算不出来显示 `—`**）');
    console.log(`  源文件（src/**/*.js）     ${countJs(join(ROOT, '..'))}      ← find src -name '*.js' | wc -l`);
    console.log(`  注册表技能                ${await skillCount()}      ← composite_registry.SKILL_NAMES.length`);
    console.log(`  测试脚本                  ${units ? `${units.executed}（+${units.skipped} 跳过）` : UNKNOWN}`
        + `      ← tools/unit_all.mjs 的 UNITS 清单`
        + (units ? `（注册 ${units.registered} = 执行 ${units.executed} + 跳过 ${units.skipped}）` : '（清单解析失败）'));
    console.log(`  错误码（CODES）           ${await codeCount()}      ← library/contract.js 的 CODES.length`);
    const revCount = gitText(['rev-list', '--count', 'HEAD']);
    const sinceCount = gitLines(['log', '--since=2026-10-31', '--oneline']);
    console.log(`  重构提交数                ${revCount}      ← git rev-list --count HEAD`);
    console.log(`  　（其中自 2026-10-31 起）  ${sinceCount}      ← git log --since=2026-10-31 --oneline | wc -l`);
    if (revCount === UNKNOWN || sinceCount === UNKNOWN) {
        console.log('  ⚠ git 不可用（或不在仓库内）→ 提交数显示 `—`，不是 0');
    }
    console.log('  说明：这些数字会随开发变化。**引用时以本段输出为准**，别抄文档里的快照。\n');
}

// ★ T18（封版后补钉）：**这里原来有一句针对固定路径的收尾删除，已移除**：
//
//     const { rmSync } = await import('fs');
//     try { rmSync(join(ROOT, '../../bots/preflight_tmp'), { recursive: true, force: true }); } catch { }
//
//   它删的是 `bots/preflight_tmp` —— 一个**所有 preflight 进程共用**的固定路径。
//   两个进程同时跑时，先跑完的那个会删掉另一个**正在用**的目录（T18 实测确证：
//   目录在 3563ms 被删，而此刻 A/B 两个进程都还在运行）。
//
//   现在临时目录改由 `history.load+save` 那条冒烟测试**各自 mkdtemp、各自删除**，
//   进程之间不再共享任何路径，所以这里不需要（也不应该）再做全局清理 ——
//   留着它就等于把"互删"重新装回去。

if (failed === 0) {
    console.log('\n启动自检通过（含函数体冒烟测试）。');
    process.exit(0);
} else {
    console.log(`\n启动自检失败：${failed} 处有问题。不要重启 agent。`);
    process.exit(1);
}
