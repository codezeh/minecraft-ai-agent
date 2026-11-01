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
        const m = await import(pathToFileURL(join(ROOT, 'library/task_collect.js')).href);
        await m.collect(fakeBot, ['oak_log'], 1, { deadlineMs: 500 });
    }],
    ['collect_targets.resolveCollectTarget', async () => {
        const m = await import(pathToFileURL(join(ROOT, 'library/collect_targets.js')).href);
        m.resolveCollectTarget('木头', fakeBot.registry);
    }],
    ['atom_move.makeMovements', async () => {
        const m = await import(pathToFileURL(join(ROOT, 'library/atom_move.js')).href);
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
    const { CODES } = await import('../src/agent/library/atom_contract.js');
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
            'src/agent/library/atom_boat.js',   // 冻结文件（src 里没人 import），Phase R 一并删/迁
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
            'src/agent/library/atom_look.js',
            // 待迁（Phase R / 动作补齐时一并搬，搬完删掉对应行）：
            //   skills.js / tool_prep.js / atom_attack.js 仍是「动作层直接发鼠标输入」的存量，行为没变，只是还没搬。
            //   （skill_clear.js / scaffold_cleanup.js 原本也列过，实测真实命中 0——只在注释里提到，已删。）
            'src/agent/library/skills.js',
            'src/agent/library/tool_prep.js',
            'src/agent/library/atom_attack.js',
            'src/agent/library/atom_boat.js',   // 冻结文件（src 里没人 import），Phase R 一并删/迁
            // ── bot.look* 的具名残余（2026-11-01 补齐扫描后逐条列明，**不是为了消灭违规，是让缺口可见**）──
            //   这些地方仍可直接转头；Phase R / M2 收尾时逐条销账，迁一个删一行。
            'src/agent/modes.js',                      // bot.look* ×6（295/296/298/310/311/313）—— M2 残项
            'src/agent/vision/vision_interpreter.js',  // bot.look/lookAt ×3（28/32/47）—— 视觉解释器，跟随玩家视角
            'src/agent/library/task_follow.js',        // bot.lookAt ×1（384）—— 跟随时看人
            'src/agent/library/atom_move.js',          // bot.lookAt ×1（507，lookAt 函数）—— 与 atom_look.lookAt 重复实现，Phase R 收敛
            'src/agent/agent.js',               // this.bot.stopDigging()：停任务时的收尾清理
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
            'src/agent/library/atom_boat.js',
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
            'src/agent/library/atom_boat.js',
            'src/agent/modes.js',
            'src/agent/permissions.js',
            'src/agent/library/task_follow.js',
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
 *   骨架版直接对原文做正则，于是 `atom_boat` 的文档注释里提到 setControlState 也算命中、
 *   `atom_dig` 里「契约不允许原子直接按键」那句注释同理。
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

const { rmSync } = await import('fs');
try { rmSync(join(ROOT, '../../bots/preflight_tmp'), { recursive: true, force: true }); } catch { }

if (failed === 0) {
    console.log('\n启动自检通过（含函数体冒烟测试）。');
    process.exit(0);
} else {
    console.log(`\n启动自检失败：${failed} 处有问题。不要重启 agent。`);
    process.exit(1);
}
