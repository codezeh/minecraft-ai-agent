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
            // 其他错误（缺少 bot 实例之类）在导入阶段不致命
        }
    }
}

if (failed === 0) {
    console.log(`  ✓ 所有模块导入成功（${loaded}/${files.length}），没有未定义引用`);
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
        const h = new m.History({
            name: 'preflight_tmp',
            self_prompter: { state: 'idle', isStopped: () => true, prompt: null },
            task: { taskStartTime: 0 }, last_sender: 'x',
            memory_bank: { getJson: () => ({}) },
            prompter: { promptMemSaving: async () => 'x' },
        });
        h.load();
    }],
    ['tile_map.classifyChunk', async () => {
        const m = await import(pathToFileURL(join(ROOT, 'library/tile_map.js')).href);
        m.classifyChunk({ explored: true, y: 64, h: 2, water: 0, lava: 0, built: 0, leaves: 0 });
    }],
];

for (const [name, fn] of smokeTests) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (e?.name === 'ReferenceError' || /is not defined/.test(msg)) {
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
        const t = fs2.readFileSync(f, 'utf8');
        for (const re of [/fail\(\s*'([A-Z_]+)'/g, /code:\s*'([A-Z_]+)'/g]) {
            for (const mm of t.matchAll(re)) {
                if (!used2.has(mm[1])) used2.set(mm[1], new Set());
                used2.get(mm[1]).add(path2.relative(projectRoot2, f));
            }
        }
    }
    const missing2 = [...used2.keys()].filter(k => !CODES.includes(k)).sort();
    const dup2 = CODES.filter((c, i) => CODES.indexOf(c) !== i);
    if (missing2.length) {
        failed++;
        console.log(`  ✗ 有 ${missing2.length} 个错误码没注册：${missing2.join(', ')}`);
        for (const k of missing2) console.log(`      ${k} ← ${[...used2.get(k)].join(', ')}`);
    } else if (dup2.length) {
        failed++;
        console.log(`  ✗ CODES 有重复项：${[...new Set(dup2)].join(', ')}`);
    } else {
        console.log(`  ✓ 错误码审计通过（${CODES.length} 个已注册，全部合法）`);
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
    const DOC = 'docs/交接文档.md';
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
        console.log(`    建议看一眼 ${DOC} 的「一·五」章节是否还准确。`);
    } else {
        console.log('  ✓ 交接文档不比代码旧');
    }
}

// ---- 第四层：API 扫描（骨架；规则由后续任务填）----
//
// 为什么需要（docs/architecture/09_crosscut.md §5、01_primitives.md §6、02_actions.md）：
// 分层规矩（"控制键只有 atom_input_move 能碰"、"聊天走 openChat 拦 / 开头"、
// "RCON 密码不许写死"）写在文档里，靠自觉一定漂。要一条能跑、能报位置、能填规则的检查。
//
// 这一层**只报告不判失败**（API_SCAN_ENFORCE = false）：
// 规则还没填全、代码还没迁完，现在就判失败等于把 preflight 变成红灯常亮。
// 后续任务把规则填严、代码迁完之后，用 `node tools/preflight.mjs --strict-api`
// 验一遍再翻默认值。规则格式见下面的 API_SCAN_RULES。
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
        id: 'slash-command-owner',
        why: '斜杠命令只许从 atom_input_misc.command() 出去（op 账号，一条 /op 就是全图）',
        files: ['src/agent/**/*.js'],
        allow: [
            'src/agent/library/atom_input_misc.js',
            // 冻结文件（src 里没人 import），Phase R 一并删/迁
            // 开发用任务脚本（造场景/烹饪测试），不是运行时链路；后续并入 command()
            'src/agent/tasks/**/*.js',
        ],
        pattern: /bot\.chat\s*\([^\n]*?['"`]\s*\//,
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
            'src/agent/library/skills.js',
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
            for (const idx of findAllHits(scanText, rule.pattern)) {
                hits.push({ file: src.path, ...locateInText(src.text, idx) });
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
        console.log('  · 规则表是空的（骨架阶段合法，后续任务往里填）');
    } else if (totalHits === 0) {
        console.log('  ✓ API 扫描没有命中');
    } else {
        console.log(`  · 共 ${totalHits} 处命中：现在只报告不判失败；` +
            '规则填严后用 `node tools/preflight.mjs --strict-api` 验，再翻默认值。');
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
    } else if (violations.length) {
        const extra = tightened.length ? `，其中 ${tightened.length} 处为收紧后新暴露（${STRICT_PREFIX ? '已判失败' : '默认只报告'}）` : '';
        console.log(`  ✓ 除 ${violations.length} 处已知违规外没有新违规${extra}`);
    }
    if (violations.length === 0) console.log('  ✓ 前缀 import 规矩没有命中');
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
        const r = spawnSync(process.execPath, [join(REPO_ROOT, 'tools', 'deps_injection_audit.mjs')],
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
        const sawASection = /──\s*A·|A·策略|未发现"有早退分支但生产不提供"/.test(out);
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
     * `unit_all` 的注册/执行/跳过数 —— **解析清单，不实跑**（实跑要几分钟，装不进门禁）。
     * 只读 `UNITS` 与 `NEEDS_REAL_DATA` 两个字面量列表；解析不出来给 `—`。
     */
    const unitStats = () => {
        try {
            const src = readFileSync(join(ROOT, '../../tools/unit_all.mjs'), 'utf8');
            const unitsBlock = src.match(/const UNITS = \[([\s\S]*?)\];/);
            if (!unitsBlock) return null;
            const registered = [...unitsBlock[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
            const nrBlock = src.match(/NEEDS_REAL_DATA = new Set\(\[([\s\S]*?)\]\)/);
            const needsReal = nrBlock ? [...nrBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
            const skipped = registered.filter((n) => needsReal.includes(n));
            return { registered: registered.length, executed: registered.length - skipped.length, skipped: skipped.length };
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

const { rmSync } = await import('fs');
try { rmSync(join(ROOT, '../../bots/preflight_tmp'), { recursive: true, force: true }); } catch { }

if (failed === 0) {
    console.log('\n启动自检通过（含函数体冒烟测试）。');
    process.exit(0);
} else {
    console.log(`\n启动自检失败：${failed} 处有问题。不要重启 agent。`);
    process.exit(1);
}
