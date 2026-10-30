// 启动自检：加载所有 agent 模块，确认没有「引用了未定义符号」这类错误。
//
// 为什么需要：连续两次出现同类问题
//   1) MEMORY_CODE_VERSION 只加了引用没加定义 → agent 启动即崩
//   2) resolveCollectTarget 只加了使用没加 import → 「砍树」技能全废
// 两者都是 node --check 查不出来的（语法正确，运行时才炸）。
// 这个脚本真的 import 一遍模块并调用关键函数，把这类错误挡在重启之前。
import { pathToFileURL, fileURLToPath } from 'url';
import { readdirSync, statSync } from 'fs';
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
console.log('\n[3/3] 规则与申报审计');
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

const { rmSync } = await import('fs');
try { rmSync(join(ROOT, '../../bots/preflight_tmp'), { recursive: true, force: true }); } catch { }

if (failed === 0) {
    console.log('\n启动自检通过（含函数体冒烟测试）。');
    process.exit(0);
} else {
    console.log(`\n启动自检失败：${failed} 处有问题。不要重启 agent。`);
    process.exit(1);
}
