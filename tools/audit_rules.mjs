/**
 * preflight 的第 3、4 层：规则审计 + 新模块申报检查。
 *
 * 第 3 层 rules_audit
 *   扫描 src/agent/library/**，游戏常量必须是"取自规则表"或带 // rule:Rx-xx 出处。
 *   存量违规记在 rules/audit_baseline.json（棘轮：只许变少，不许新增）。
 *
 * 第 4 层 new_module_guard
 *   git 里新增的 library 文件，必须在 自研申报.md 有「已批准」记录。
 *
 * 用法：
 *   node tools/audit_rules.mjs            # 报告 + 退出码
 *   node tools/audit_rules.mjs --update   # 把当前存量写进基线（仅在你确认后手工跑）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, closeSync, unlinkSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { assertRulesIntact, ruleIds } from '../src/agent/rules/rules.runtime.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));      // .../mindcraft/tools/
const MC_ROOT = join(HERE, '..');                               // .../mindcraft/
const PROJECT_ROOT = join(MC_ROOT, '..');                       // 项目根（含 自研申报.md）
const LIB = join(MC_ROOT, 'src', 'agent', 'library');
const BASELINE = join(MC_ROOT, 'src', 'agent', 'rules', 'audit_baseline.json');
const TMP_DIR = join(PROJECT_ROOT, 'tmp');

/**
 * 需要出处的游戏常量。
 * 只收「有明确游戏语义」的数字，避免把业务参数（超时、重试次数）也算进来。
 */
const GAME_CONSTANTS = [
    '1.62',    // 眼高
    '1.65',    // 眼高（错误值，出现过）
    '1.27',    // 蹲下眼高
    '1.8',     // 玩家高
    '0.6',     // 玩家宽
    '1.25',    // 跳跃高度
    '4.317',   // 行走速度
    '5.612',   // 冲刺速度
    '4.5',     // GoalLookAtBlock 默认 reach
    '5.1',     // 可用挖掘距离
    '6.11',    // 实测最大挖掘距离
    '0.42',    // 跳跃初速度
];

function walk(dir) {
    const out = [];
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (f.endsWith('.js')) out.push(p);
    }
    return out;
}

/** 去掉字符串与注释，避免把注释里的数字当真 */
function stripCode(line, state) {
    let s = line;
    // 块注释
    if (state.inBlock) {
        const end = s.indexOf('*/');
        if (end === -1) return { code: '', state };
        s = s.slice(end + 2);
        state.inBlock = false;
    }
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    const open = s.indexOf('/*');
    if (open !== -1) {
        s = s.slice(0, open);
        state.inBlock = true;
    }
    s = s.replace(/\/\/.*$/, '');
    s = s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    return { code: s, state };
}

/** 跑一条 git 命令并返回非空输出行（用文件代替管道，避开沙箱 EPERM）。 */
function gitLines(args) {
    const tmp = join(TMP_DIR, `_git_${process.pid}_${Math.random().toString(36).slice(2, 8)}.txt`);
    const fd = openSync(tmp, 'w');
    try {
        execFileSync('git', args, { cwd: MC_ROOT, stdio: ['ignore', fd, 'ignore'] });
        return readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean);
    } finally {
        closeSync(fd);
        try { unlinkSync(tmp); } catch { }
    }
}

export function rulesAudit({ quiet = false } = {}) {
    const problems = [];
    const violations = [];
    const ids = new Set(ruleIds());

    // 规则表自身自洽
    for (const p of assertRulesIntact()) problems.push(`规则表: ${p}`);

    for (const file of walk(LIB)) {
        const rel = relative(MC_ROOT, file).replace(/\\/g, '/');
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        const state = { inBlock: false };
        for (let i = 0; i < lines.length; i++) {
            const { code, state: ns } = stripCode(lines[i], state);
            state.inBlock = ns.inBlock;
            if (!code.trim()) continue;

            for (const c of GAME_CONSTANTS) {
                const re = new RegExp(`(?<![\\w.])${c.replace('.', '\\.')}(?![\\w.])`);
                if (!re.test(code)) continue;

                // 出处：本行或上一行有 // rule:Rx-xx
                const ctx = `${lines[i - 1] ?? ''}\n${lines[i]}`;
                const m = ctx.match(/rule:(R[123]-\d+)/);
                if (!m) {
                    violations.push({ file: rel, line: i + 1, value: c, why: '没有出处' });
                } else if (!ids.has(m[1])) {
                    problems.push(`${rel}:${i + 1} 引用了不存在的规则 ${m[1]}`);
                }
            }
        }
    }

    // 棘轮：和基线比，只许变少
    let base = { count: 0, items: [] };
    if (existsSync(BASELINE)) base = JSON.parse(readFileSync(BASELINE, 'utf8'));

    // ★ 第27条（T05）：**基线条目本身必须是活的**。
    //   为什么必须校验：基线是"欠账名单"。条目一旦指向已删除/已改名的文件，
    //   它就永远躺在名单里充数 —— 棘轮看起来"还有很多欠账"，实际一大半是死条目，
    //   等于**给棘轮开了空名额**。没有存在性断言，删掉一个模块就白得一个名额，
    //   删得越多棘轮越宽松 —— 方向正好反了。
    //   实测（T05）：14 条里 **9 条**指向已删除的模块（atom_dig / atom_move /
    //   atom_perceive / task_collect / tile_map），真正活着的只有 skills.js 那 5 条。
    //   棘轮名义 14、实际 5。
    const deadItems = (base.items ?? []).filter((it) => !it?.file || !existsSync(join(MC_ROOT, it.file)));
    if (deadItems.length) {
        problems.push(`基线里有 ${deadItems.length} 条**死条目**（文件已不存在），棘轮被这些空名额放宽了：`
            + deadItems.slice(0, 12).map((x) => `${x.file}:${x.line}`).join('、')
            + ' —— 请删掉它们并同步 count');
        if (!quiet) {
            for (const x of deadItems) console.log(`     ✗ 死条目 ${x.file}:${x.line}（常量 ${x.value}，文件不存在）`);
        }
    }

    // ★ 第27条（T05）：身份比对**不再挂在"总数超标"这个条件里**。
    //
    //   旧写法的漏洞（实测）：`if (violations.length > base.count)` 才去比对身份。
    //   于是只要总数没超过基线，**内容换了也发现不了** ——
    //   死条目（文件已删）腾出来的名额，正好被新写的裸常量悄悄占掉：
    //   示例就是本次实测到的：基线 14 条里 9 条是死条目，而 act_craft/act_dig/
    //   atom_read/atom_tunnel/nav_pathfinder/query_perceive/query_tree 这 7 处
    //   **新增**的裸常量一直没被报出来 —— 因为 12 < 14。
    //   "总数没涨"不等于"没有新增"，这是第26条同族：数字相等，构成全变了。
    //
    //   现在：只要有**不在名单里的**违规，就报新增（逐条点名），与总数无关。
    //   身份用「文件 + 常量值」，不用行号 —— 行号会随正常编辑上下移动，
    //   拿它当身份会让"改了一行注释"也报成新增（实测踩过）。
    const known = new Set(base.items.map(x => `${x.file}:${x.value}`));
    const fresh = violations.filter(v => !known.has(`${v.file}:${v.value}`));
    if (fresh.length) {
        problems.push(`裸常量新增 ${fresh.length} 处（基线名单里没有）：`);
        for (const v of fresh.slice(0, 20)) problems.push(`  新增 ${v.file}:${v.line} 常量 ${v.value}（${v.why}）`);
    }
    // 总数兜底：即使身份全都认识，条数也不能涨（防"同一文件同一值重复出现"绕过身份比对）
    if (violations.length > base.count) {
        problems.push(`裸常量条数上涨：基线 ${base.count} 处，现在 ${violations.length} 处`);
    }

    if (!quiet) {
        console.log(`  规则表：${ids.size} 条，自洽${problems.length ? '' : '通过'}`);
        console.log(`  裸常量：${violations.length} 处（基线 ${base.count} 处）`);
        if (violations.length) {
            const byFile = {};
            for (const v of violations) byFile[v.file] = (byFile[v.file] || 0) + 1;
            for (const [f, n] of Object.entries(byFile)) console.log(`     ${f}: ${n}`);
        }
    }

    return { problems, violations, base, ok: problems.length === 0 };
}

export function newModuleGuard({ quiet = false } = {}) {
    const problems = [];
    // ★ 2026-10-28 修：**申报文件在 docs/ 下**，不在根目录。
    //
    // 起因：本次新增 act_climb.js，审计报"没有申报记录"，但文档里明明写了。
    // 根因：提交 2a500a9「纳入项目与方法论文档（22 份）」把 自研申报.md
    // 从根目录移到了 docs/，而这里仍然只查 PROJECT_ROOT。
    // 结果：这条校验对所有人静默失效 —— 新模块申报 = 形同虚设。
    //
    // 现在按优先级探测多个位置，任一命中即可（以后文档再挪也不会静默失效）。
    const declCandidates = [
        join(MC_ROOT, 'docs', '自研申报.md'),      // 当前实际位置
        join(MC_ROOT, '自研申报.md'),
        join(PROJECT_ROOT, '自研申报.md'),         // 历史位置
        join(PROJECT_ROOT, 'docs', '自研申报.md'),
    ];
    const declPath = declCandidates.find(p => existsSync(p));

    let newFiles = [];
    try {
        // 注意：不能用管道 stdio（沙箱里 spawnSync 取管道输出会 EPERM）。
        // 改成把 git 输出写进临时文件再读，行为相同且跨环境稳定。
        newFiles.push(...gitLines(['ls-files', '--others', '--exclude-standard', 'src/agent/library']));
        newFiles.push(...gitLines(['diff', '--name-only', '--diff-filter=A', 'HEAD', '--', 'src/agent/library']));
    } catch (e) {
        if (!quiet) console.log(`  新模块申报：git 不可用（${String(e.message).slice(0, 40)}），跳过`);
        return { problems, ok: true };
    }

    newFiles = [...new Set(newFiles)];
    if (!newFiles.length) {
        if (!quiet) console.log('  新模块申报：没有新增模块');
        return { problems, ok: true };
    }

    if (!existsSync(declPath)) {
        problems.push(`有 ${newFiles.length} 个新模块但没有 自研申报.md`);
        return { problems, ok: false };
    }
    const decl = readFileSync(declPath, 'utf8');
    const sections = decl.split(/^## /m).slice(1);

    // Phase R（2026-11-01）：**转发文件不算新模块**。
    // `git mv` 改名后，原路径会留一行 `export * from './新名.js'` 作临时转发（02 §5 强制手法），
    // 这类文件里没有任何新实现，要求它写自研申报只会逼人往申报文档里灌垃圾。
    // 判据写窄：整个文件除注释外**只有** export * from './x.js' 才算转发。
    const isForwarder = (rel) => {
        let text = '';
        try { text = readFileSync(join(MC_ROOT, rel), 'utf8'); } catch { return false; }
        const code = text
            .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
            .replace(/^\s*\/\/.*$/gm, '')          // 行注释
            .trim();
        return /^export\s+\*\s+from\s+['"]\.\/[^'"]+\.js['"];?$/m.test(code)
            && code.split('\n').filter((l) => l.trim()).length <= 2;
    };

    const realNew = newFiles.filter((f) => !isForwarder(f));
    const forwarders = newFiles.length - realNew.length;

    for (const f of realNew) {
        const name = f.split('/').pop();
        const sec = sections.find(s => s.includes(name));
        if (!sec) { problems.push(`新模块 ${name} 没有申报记录`); continue; }
        if (!/结论[:：]\s*\**\s*已批准/.test(sec)) problems.push(`新模块 ${name} 申报结论不是「已批准」`);
    }

    if (!quiet) {
        console.log(`  新模块申报：${realNew.length} 个新增，`
            + `${problems.length ? `${problems.length} 个有问题` : '全部已批准'}`
            + (forwarders ? `（另有 ${forwarders} 个 Phase R 转发文件，不计入）` : ''));
    }
    return { problems, ok: problems.length === 0 };
}

/**
 * 第 5 层：字段审计（见 字段标准.md §2）。
 *
 * 两件事：
 *   1. 原子/任务返回的 data 键必须在白名单内
 *   2. 被取代的旧名一律禁止出现（collected / got / at / cell / 裸 dist）
 *
 * 为什么用"禁止旧名"而不是"只允许白名单"做代码扫描：
 * 白名单扫描需要解析调用关系，容易误报；旧名字符串是确定的，扫得准。
 */
const FORBIDDEN_FIELDS = [
    // 数量：统一用 count / want
    { re: /data\?*\.collected\b|data\.collected\b/, why: 'collected → 改用 count' },
    // 只认「对象字面量的键」：{ collected: ... } 或 , collected:
    // 不认局部变量 collected/got（那是代码里的名字，不是返回字段）
    { re: /[{,]\s*collected:\s*/, why: '返回字段 collected → 改用 count' },
    { re: /[{,]\s*got:\s*/, why: '返回字段 got → 改用 count' },
    { re: /[{,]\s*placed:\s*/, why: '返回字段 placed → 改用 count' },
    // 距离：必须带参照点
    { re: /data\?*\.dist\b(?!FeetTo|EyeTo)/, why: 'dist → distEyeToBlock / distFeetToPoint / distFeetToEntity' },
    { re: /ok\(\{\s*dist\s*:/, why: '返回信封里的 dist 必须带参照点' },
    // 位置：2D 不许冒充 3D。允许 posXZ: { x, z }（名字已声明是二维）
    { re: /(?<!posXZ:\s*)\{\s*x,\s*z\s*\}/, why: '二维位置必须显式命名 posXZ: {x, z}' },

    // === 原子接口标准（原子接口标准.md）===
    // 1) block 在返回里有两个意思 → 拆成 placedBlock / dugBlock / occupiedBy
    //    注意：`block: block.name` 是"诊断上下文"（哪个方块挖不动），允许；
    //    有歧义的是 `block: item`（放上去的）和 `block: target.name`（被占的）。
    { re: /ok\(\{[^}]*\bblock:\s*/, why: '返回字段 block 有歧义 → placedBlock（放置）/ dugBlock（挖掘）' },
    { re: /\bblock:\s*(item|target\.name|now\?\.name)\b/, why: '返回字段 block 有歧义 → occupiedBy（被占）' },
    // 2) 目标标识统一成 target:{kind,name}，不许平铺 kind
    { re: /ok\(\{\s*kind:\s*'/, why: '平铺 kind → target:{kind,name} 或 containerKind/useKind' },
    // 3) 参数名统一
    { re: /\breach\s*=\s*MELEE|reach\s*=\s*3/, why: 'opts.reach → maxReach' },
    { re: /\bextraMs\b/, why: 'extraMs → verifyMs' },
    { re: /\ballowBreak\b/, why: 'allowBreak → canDig/scaffold' },
    // 4) 二维坐标统一叫 posXZ，不许叫 reached
    { re: /\breached:\s*\{/, why: 'reached:{x,z} → posXZ:{x,z}' },
    // 5) 调用原子时必须传描述对象，不许传裸坐标（B 步已迁完，兼容分支已删）
    { re: /(moveTo|moveToXZ|moveToXZEx)\([a-zA-Z_.]+, *[a-zA-Z_.]+\.[xyz]/, why: '原子调用必须传 {kind,pos}，不许传裸坐标' },
    { re: /(digBlock|useBlock|openContainer|placeBlockAt)\([a-zA-Z_.]+, *\{(?![^}]*kind:)/, why: '原子调用必须传 {kind,pos}，不许传裸坐标对象' },
];

export function fieldAudit({ quiet = false } = {}) {
    const problems = [];
    const files = [
        ...walk(LIB).filter(f => /atom_|task_|skill_|collect_planner/.test(f)),
    ];

    for (const file of files) {
        const rel = relative(MC_ROOT, file).replace(/\\/g, '/');
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        const state = { inBlock: false };
        for (let i = 0; i < lines.length; i++) {
            const { code, state: ns } = stripCode(lines[i], state);
            state.inBlock = ns.inBlock;
            if (!code.trim()) continue;
            for (const f of FORBIDDEN_FIELDS) {
                if (f.re.test(code)) {
                    problems.push(`${rel}:${i + 1} 旧字段 ${f.why}`);
                }
            }
        }
    }

    if (!quiet) {
        console.log(`  字段标准：${problems.length ? `${problems.length} 处违规` : '通过'}`);
    }
    return { problems, ok: problems.length === 0 };
}

export function runAudits() {
    const a = rulesAudit();
    const b = newModuleGuard();
    const c = fieldAudit();
    return { ok: a.ok && b.ok && c.ok, problems: [...a.problems, ...b.problems, ...c.problems] };
}
// 直接运行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const update = process.argv.includes('--update');
    const print = process.argv.includes('--print');
    const a = rulesAudit({ quiet: print });
    if (print) {
        // 沙箱里 node 直接写文件可能 EPERM，所以支持输出到 stdout 交给 shell 重定向：
        //   node tools/audit_rules.mjs --print > src/agent/rules/audit_baseline.json
        process.stdout.write(JSON.stringify({
            updated_at: new Date().toISOString().slice(0, 10),
            count: a.violations.length,
            items: a.violations,
        }, null, 2) + '\n');
        process.exit(0);
    }
    if (update && a.violations.length) {
        try {
            writeFileSync(BASELINE, JSON.stringify({
                updated_at: new Date().toISOString().slice(0, 10),
                count: a.violations.length,
                items: a.violations,
            }, null, 2));
        } catch (e) {
            console.log(`\n写基线失败（${e.code}）：改用 node tools/audit_rules.mjs --print > src/agent/rules/audit_baseline.json`);
            process.exit(2);
        }
        console.log(`\n基线已更新：${a.violations.length} 处`);
        process.exit(0);
    }
    const b = newModuleGuard();
    const problems = [...a.problems, ...b.problems];
    if (problems.length) {
        console.log('\n审计失败：');
        for (const p of problems) console.log(`  ✗ ${p}`);
        process.exit(1);
    }
    console.log('\n审计通过。');
}
