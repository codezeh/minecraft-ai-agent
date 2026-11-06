/**
 * settings 键一致性检查 —— 「代码读的键」必须等于「面板声明的键」。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（这一条值回全部成本）
 *
 * 病灶实例（2026-11-06 实测发现）：
 *   src/agent/commands/index.js:31
 *       if (!settings.companion_mode) return true;
 *   而 companion_mode 从来没有出现在 settings_spec.json 里 →
 *   面板一保存 profile 就把它从 settings 对象里删掉 → 恒为 undefined →
 *   !undefined === true → **每一个命令都被判定为"可见"**。
 *   于是「方案 §12：60 条命令 → 7 条」这个设计**从写下那天起就没生效过**，
 *   而且没有任何报错、没有任何日志、没有一条测试会红。
 *
 * 同一个病在 actions.js 里已经咬过三次（!goToPlayer / !followPlayer /
 * !collectBlocks 的旧分支），每次都是靠人肉读代码才发现。
 *
 * 这三处的共同结构：
 *   **一个从未被定义的开关 → 条件恒为某个值 → 一整条分支静默走另一边。**
 *
 * 靠人记没用，所以把它做成机械检查。
 * ══════════════════════════════════════════════════════════════════
 *
 * 判据（三张表，含义不同，别混）：
 *   §1 代码读了、面板没声明 → 红（就是这个 bug 类）
 *   §2 已登记的例外        → 黄，但每次都要打印（不许静默变绿）
 *   §3 面板声明了、代码没读 → 灰，只告知（可能是给别的进程/CLI 用的）
 *
 * 两条防「假绿」的护栏（沿用 preflight 的教训）：
 *   - requireScanned：扫到 0 个文件 / 0 个键 = 失败，不是通过
 *   - --selftest    ：证明提取器看得见该看见的、看不见不该看见的
 *
 * 用法：
 *   node tools/settings_check.mjs
 *   node tools/settings_check.mjs --selftest   # 只跑提取器自检
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');
const SPEC_PATH = join(SRC, 'mindcraft', 'public', 'settings_spec.json');

/* ============================================================================
 * agent 进程的真实作用域
 *
 * 注意：不是只有 src/agent/。agent 进程还会加载 models/（prompter 读
 * relevant_docs_count / num_examples / log_all_prompts）、utils/（mcdata 读
 * host / port / minecraft_version）。
 * 只扫 src/agent 会漏掉一半读取面 —— 实测 relevant_docs_count 就在 models 里。
 *
 * 排除 src/mindcraft/：那是 mindserver 进程，settings 在那里是局部变量
 * （mindserver.js 的 settings 参数），不属于同一套 schema。
 * ========================================================================== */
const AGENT_SCOPE_DIRS = ['agent', 'models', 'utils', 'sim'];

/** settings 这个默认绑定从哪 import —— 只认这些文件里的 settings 是"那一份"。 */
const SETTINGS_IMPORT_RE = /import\s+settings\s+from\s+['"][^'"]*settings\.js['"]/;

/* ============================================================================
 * 已登记的例外 —— 每条必须写清理由和决策状态，否则它就是一块遮羞布。
 * （沿用 unit_all.mjs 的 EXCLUDE 约定：不写理由的排除项等于藏红。）
 * ========================================================================== */
const KNOWN_UNDECLARED = new Map([
    // ★ F-GATE-001 + F-AI-204（2026-11-06）：原来这里挂的唯一一条 `companion_mode` **已经解决** ——
    //   该键已在 `src/mindcraft/public/settings_spec.json` 正式声明（default `true` = 收敛到 8 条白名单），
    //   且 `commands/index.js` 的判据已反转成 fail-closed（`=== false` 才全开，键缺失按收敛）。
    //   ⇒ 它不再是"代码读了但 spec 没声明"的键，**必须从这里删除**，否则就是"修好了还挂在遮羞布上"。
    //
    //   机制本身保留（空 Map）：以后再有"代码读了但尚未声明"的键，仍要登记在这里、写清理由、
    //   并且**每次运行都打印**，不许静默变绿。空表不是"没问题"，而是"当前没有已登记例外"。
]);

/* ============================================================================
 * §0 源码掩码：把注释与字符串**内容**抹成空格（保留引号、保留换行、保留长度）
 *
 * 为什么不能直接正则扫原文：实测两个假阳性
 *   1) commands/actions.js:121  "…Code writing is disabled in settings. Notify the user."
 *      → 被扫成 settings.Notify
 *   2) models/mistral.js:21     "…set MISTRAL_API_KEY in settings.json"
 *      → 被扫成 settings.json
 * 两条都是英文句子里的 "settings." + 下一个单词。不掩码就会报假红，
 * 而一条会报假红的检查器，跟一条永远绿的检查器一样没用。
 *
 * 掩码后偏移量与原文一一对应，所以可以拿原位置回原文取上下文。
 * 正则字面量也要认（否则 /['"]/ 这种会把后面的引号当成字符串起点，
 * 掩码错位 → 后续全是假的）。
 * ========================================================================== */
function maskSource(src) {
    const out = src.split('');
    const n = src.length;
    let i = 0;
    let mode = 'code';          // code | line | block | sq | dq | tpl | regex
    let prevSig = '';           // 上一个"有意义的"代码字符，用来判断 / 是除号还是正则

    const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?',
        '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];

        if (mode === 'code') {
            if (c === '/' && c2 === '/') { mode = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
            if (c === '/' && c2 === '*') { mode = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
            if (c === '/' && REGEX_PREV.has(prevSig)) { mode = 'regex'; i += 1; continue; }
            if (c === "'") { mode = 'sq'; i += 1; continue; }
            if (c === '"') { mode = 'dq'; i += 1; continue; }
            if (c === '`') { mode = 'tpl'; i += 1; continue; }
            if (!/\s/.test(c)) prevSig = c;
            i += 1; continue;
        }

        if (mode === 'line') {
            if (c === '\n') { mode = 'code'; prevSig = ''; i += 1; continue; }
            out[i] = ' '; i += 1; continue;
        }

        if (mode === 'block') {
            if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; mode = 'code'; i += 2; continue; }
            if (c !== '\n') out[i] = ' ';
            i += 1; continue;
        }

        if (mode === 'regex') {
            if (c === '\\') { out[i] = ' '; if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
            if (c === '/') { mode = 'code'; prevSig = ')'; i += 1; continue; }
            if (c !== '\n') out[i] = ' ';
            i += 1; continue;
        }

        // 字符串模式：抹内容，保留引号，处理转义
        if (c === '\\') { out[i] = ' '; if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
        if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
            mode = 'code'; prevSig = '"'; i += 1; continue;
        }
        if (c !== '\n') out[i] = ' ';
        i += 1;
    }
    return out.join('');
}

/**
 * 从一个文件的源码里提取 settings 键的读取点。
 *
 * 只认两种写法（覆盖率实测 100%，见 --selftest 的样本）：
 *   settings.foo
 *   settings['foo'] / settings["foo"]
 *
 * 不认 const { foo } = settings 这种解构 —— 本仓库 0 处（实测）。
 * 若将来出现，下面的 requireScanned 不会报警，但 §3 会把对应键列成"没人读"，
 * 那时看 §3 就能发现。这是已知盲区，写在这里而不是假装没有。
 *
 * @returns {{keys: Map<string, number[]>, masked: string}}
 */
function extractSettingsKeys(src) {
    const masked = maskSource(src);
    const keys = new Map();

    // ① 点号访问 —— 在掩码后的源码上扫，天然排除注释与字符串
    for (const m of masked.matchAll(/(?<![.\w$])settings\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
        const line = masked.slice(0, m.index).split('\n').length;
        const arr = keys.get(m[1]) || [];
        arr.push(line);
        keys.set(m[1], arr);
    }

    // ② 方括号访问 —— 键名本身在引号里，只能在原文上扫；
    //    再用掩码校验"这个位置确实是代码"（掩码在这里应当是 's'，不是空格）。
    for (const m of src.matchAll(/(?<![.\w$])settings\s*\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g)) {
        const at = m.index;
        if (masked.slice(at, at + 8) !== 'settings') continue;   // 落在字符串里 → 丢掉
        const line = masked.slice(0, at).split('\n').length;
        const arr = keys.get(m[1]) || [];
        arr.push(line);
        keys.set(m[1], arr);
    }

    return { keys, masked };
}

/* ============================================================================
 * 自检：证明提取器看得见该看见的、看不见不该看见的
 *
 * 直接对应 preflight 里那条教训：
 * 「0x08 字节让正则永不命中 → 一直打印 ✓ → 这道门从上线起没检过任何东西」。
 * 自检不过，本脚本一律以失败退出，不许打绿。
 * ========================================================================== */
const SELFTEST_CASES = [
    {
        name: '① 正常点号访问要被抓到',
        src: 'const a = settings.max_messages;',
        expect: ['max_messages'],
    },
    {
        name: '② 英文句子里的 "settings. Xxx" 不许误报（真实假阳性样本）',
        src: 'const msg = "Code writing is disabled in settings. Notify the user.";',
        expect: [],
    },
    {
        name: '③ 文件路径 settings.json 不许误报（真实假阳性样本）',
        src: 'throw new Error("set MISTRAL_API_KEY in settings.json");',
        expect: [],
    },
    {
        name: '④ 注释里的 settings.foo 不许误报',
        src: '// 原来这里是 if (settings.companion_mode)\nconst x = 1;',
        expect: [],
    },
    {
        name: '⑤ 方括号访问要被抓到',
        src: "const b = settings['block_place_delay'];",
        expect: ['block_place_delay'],
    },
    {
        name: '⑥ 正则字面量里的引号不能把掩码带偏',
        src: 'const R = /\\/\\*\\*([\\s\\S]*?)\\*\\//;\nconst c = settings.spawn_timeout;',
        expect: ['spawn_timeout'],
    },
    {
        name: '⑦ 别的对象的 .settings.foo 不算（只认本模块 import 的那一份）',
        src: 'const d = config.settings.foo;',
        expect: [],
    },
    {
        name: '⑧ 模板字符串里的不算',
        src: 'const e = `${settings.not_a_key_real}`;',
        expect: [],
    },
];

function runSelftest(verbose) {
    let bad = 0;
    for (const c of SELFTEST_CASES) {
        const { keys } = extractSettingsKeys(c.src);
        const got = [...keys.keys()].sort();
        const want = [...c.expect].sort();
        const pass = JSON.stringify(got) === JSON.stringify(want);
        if (!pass) bad++;
        if (verbose || !pass) {
            console.log('  ' + (pass ? '✓' : '✗') + ' ' + c.name);
            if (!pass) console.log('      期望 ' + JSON.stringify(want) + ' 实得 ' + JSON.stringify(got));
        }
    }
    return { total: SELFTEST_CASES.length, bad };
}

/* ============================================================================
 * 主流程
 * ========================================================================== */
function walk(dir) {
    const out = [];
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (f.endsWith('.js')) out.push(p);
    }
    return out;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) {
        console.log('提取器自检：');
        const { total, bad } = runSelftest(true);
        console.log('\n' + (bad === 0 ? '✓' : '✗') + ' 自检 ' + (total - bad) + '/' + total + ' 通过');
        process.exit(bad === 0 ? 0 : 1);
    }

    let failed = 0;

    // ── 前置：自检不过就别往下跑（不可信的检查器不许出报告）──
    const st = runSelftest(false);
    if (st.bad > 0) {
        console.log('✗ [自检] 提取器 ' + st.bad + ' 条用例不通过 —— 本检查器不可信，拒绝出报告');
        console.log('   跑 node tools/settings_check.mjs --selftest 看详情');
        process.exit(1);
    }

    if (!existsSync(SPEC_PATH)) {
        console.log('✗ [spec] 找不到 ' + SPEC_PATH);
        process.exit(1);
    }
    const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    const specKeys = Object.keys(spec);

    // 护栏：spec 读到 0 个键 = 失败，不是"没有违规"
    if (specKeys.length === 0) {
        console.log('✗ [spec] settings_spec.json 解析出 0 个键 —— 不能当成"没有违规"');
        process.exit(1);
    }

    // ── 收集 agent 进程作用域内所有 settings 读取 ──
    const reads = new Map();     // key -> Set<"file:line">
    let scannedFiles = 0;
    let settingsFiles = 0;

    for (const d of AGENT_SCOPE_DIRS) {
        const dir = join(SRC, d);
        if (!existsSync(dir)) continue;
        for (const f of walk(dir)) {
            const src = readFileSync(f, 'utf8');
            scannedFiles++;
            if (!SETTINGS_IMPORT_RE.test(src)) continue;   // 这个文件的 settings 不是那一份
            settingsFiles++;
            const rel = relative(SRC, f).replace(/\\/g, '/');
            const { keys } = extractSettingsKeys(src);
            for (const [k, lines] of keys) {
                const set = reads.get(k) || new Set();
                for (const ln of lines) set.add(rel + ':' + ln);
                reads.set(k, set);
            }
        }
    }

    // 护栏：样本数为 0 → 失败
    if (scannedFiles === 0) {
        console.log('✗ [扫描] 扫到 0 个 js 文件 —— 检查 AGENT_SCOPE_DIRS 是否指对');
        process.exit(1);
    }
    if (settingsFiles === 0 || reads.size === 0) {
        console.log('✗ [扫描] 扫到 0 个 settings 读取点 —— 不能当成"没有违规"');
        process.exit(1);
    }

    console.log('扫描 ' + scannedFiles + ' 个模块（其中 ' + settingsFiles
        + ' 个 import 了 agent settings），提取到 ' + reads.size
        + ' 个被读取的键；spec 声明 ' + specKeys.length + ' 个。\n');

    // ── §1 代码读了、面板没声明 ──
    console.log('§1 代码读了、但 settings_spec.json 没声明：');
    const undeclared = [...reads.keys()].filter(k => !specKeys.includes(k)).sort();
    const hardFails = undeclared.filter(k => !KNOWN_UNDECLARED.has(k));
    if (hardFails.length === 0) {
        console.log('  ✓ 无（零漏声明）');
    } else {
        failed += hardFails.length;
        for (const k of hardFails) {
            console.log('  ✗ settings.' + k);
            for (const loc of [...reads.get(k)].slice(0, 5)) console.log('      ' + loc);
            console.log('      → 面板保存 profile 时会把它删掉 → 恒 undefined → 分支静默走另一边');
        }
    }

    // ── §2 已登记例外（每次必打印，不许静默变绿）──
    console.log('\n§2 已登记的例外（不计入失败，但必须保持可见）：');
    const exceptions = undeclared.filter(k => KNOWN_UNDECLARED.has(k));
    if (exceptions.length === 0) {
        console.log('  （无）');
    } else {
        for (const k of exceptions) {
            console.log('  ⚠ settings.' + k);
            for (const loc of [...reads.get(k)].slice(0, 5)) console.log('      读取点: ' + loc);
            console.log('      理由: ' + KNOWN_UNDECLARED.get(k));
        }
    }

    // ── §3 声明了、代码没读（只告知）──
    const unread = specKeys.filter(k => !reads.has(k)).sort();
    console.log('\n§3 面板声明了、agent 进程内未见读取（' + unread.length + ' 个，仅供核对）：');
    console.log('  ' + (unread.join(', ') || '（无）'));
    console.log('  说明：可能是给 mindserver / CLI 参数 / 前端用的，不判失败。');

    console.log('');
    if (failed > 0) {
        console.log('✗ settings 键一致性检查未通过：' + failed + ' 处未声明');
        process.exit(1);
    }
    console.log('✓ settings 键一致性检查通过');
}

main();
