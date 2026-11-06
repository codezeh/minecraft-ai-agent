/**
 * 离线单元测试总入口 —— **不需要 Minecraft 服务器**。
 *
 * 为什么需要：`tools/atom_all.mjs` 要测试服 25566，服务器没开时根本跑不了；
 * 而这轮（Phase 1 + Phase 2）新增的回归脚本都是"假 bot + 纯逻辑"，
 * 本来就能离线跑。没有统一入口的话，要么漏跑，要么各跑各的。
 *
 * 用法：
 *   node tools/unit_all.mjs            # 跑全部（**跳过**要真机数据的，见 NEEDS_REAL_DATA）
 *   node tools/unit_all.mjs terrain    # 只跑文件名含 "terrain" 的
 *   node tools/unit_all.mjs --real     # 连要真机数据的也跑（本机得有 bots/<名字>/map 里的库）
 *
 * 约定：每个脚本自己打印 `PASS/FAIL`，全过退出码 0。
 * 这里额外检查"至少跑出一条用例"，防止脚本中途静默退出被当成通过
 * （同一个坑在 atom_all 上踩过，见 tools/atom_all.mjs 的说明）。
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/* ============================================================================
 * 脚本发现（第18条，2026-11-05 T03）
 *
 * 原来是一张**手写白名单**：新增离线测试忘了登记 → 那个测试永远不跑，
 * 而且**看不出来谁没跑**（"没登记"和"没失败"长得一模一样，同第26条那族 bug）。
 * 报告实测：tools/ 下有 13 个纯离线的 test_*.mjs 从来没进过门禁。
 *
 * 现在：`tools/*_unit.mjs` **自动纳入**（新增脚本零登记成本），
 * 再用两张表处理命名模式覆盖不到的例外 —— 例外必须写理由，否则它自己就会烂掉。
 * ========================================================================== */

/**
 * **已确认废弃、等待 `git rm` 的脚本**（F-GATE-002）
 *
 * 与 EXCLUDE 的区别（这是本条的关键）：
 *  - EXCLUDE  = "这个测试不该进默认集合，但它**还活着**"（如需要在线 bot 的）；
 *  - PENDING_DELETE = "这个测试**已经没有意义了**，它 import 的模块已被删除"。
 *
 * 原来的问题：两者混在一张 EXCLUDE 里 ⇒ 两个**永久必红**的死测试被静默排除，
 * 等于"把红点藏起来"（同第26条那族）。现在把它们单独列出，并且：
 *   ① 每次跑 unit_all 都**打印可见告警**（不再是看不见的排除）；
 *   ② 告警里直接给**待执行的删除命令**，谁看到谁就能收掉；
 *   ③ 若脚本文件已经不在了（已被 git rm），这条自动静默——不会留下永久噪音。
 *
 * 为什么本轮没有直接删：member 会话的 shell 沙箱**不允许删文件**（`rm` → Permission denied），
 * 只能用 write/edit 改内容。所以删除动作登记给 captain 执行（命令见下）。
 */
const PENDING_DELETE = new Map([
    ['test_mca_import', 'import 的 src/agent/library/chunk_map.js + tile_map.js 均已删除（实测 ERR_MODULE_NOT_FOUND）'],
    ['test_tile_map', '同上：import 的 chunk_map.js / tile_map.js 均已删除（实测 ERR_MODULE_NOT_FOUND）'],
]);

/** 名字像单测、但**还活着**却不能进默认集合的 —— 每条都要写清理由（不写理由的排除项等于藏红）。 */
const EXCLUDE = new Map([
    ['test_reconnect', '需要**在线 bot**（deepseek 不在线时 exit 2 SKIP），不是环境无关的单元测试'],
    ['test_s0_afk', '同上：需要在线 bot 才能开始 S0'],
]);

/** 命名模式（*_unit.mjs）覆盖不到的离线脚本：老的 test_*.mjs 与历史上就在名单里的。 */
const EXTRA_OFFLINE = [
    'test_escape',            // skill_escape 规划（假 bot，纯读世界）
    'test_tunnel',            // 掘进安全检查（含 D15 液体地板）
    // ↓ 第18条补入：报告点名的纯离线 test_*.mjs（逐个实跑确认过能离线通过）
    'test_climb',             // 攀爬判据
    'test_codes',             // 错误码注册（口径已在 T03 对齐 preflight §3：只看 fail() 实参）
    'test_collect_targets',   // 采集目标解析
    'test_context_trim',      // 上下文裁剪
    'test_goto_wiring',       // goToPlayer → hopTo 接线（假 bot；本机 RCON 探测失败也照常过）
    'test_terrain3d',         // 连接复用 / fail 表 TTL / prune
];

/**
 * 需要真机数据的脚本 —— 默认**跳过**，加 `--real` 才跑（见 docs/architecture/09_crosscut.md §5.2）。
 *
 * 为什么按名字单独标：这类脚本读 `bots/<名字>/map|memory.json` 里真机录的数据，
 * 换台机器 / 清过 bots 目录就跑不动（`bots/` 在 .gitignore 里）。
 * 混在默认集合里，要么每次都得手动摘掉，要么一红就以为是代码坏了。
 *
 * ★ T03：第18条补入 3 个 —— 它们读 `./bots/deepseek/*`，在本机是绿的，
 *   但在一份干净克隆上是**必然红**的，所以归这里而不是默认集。
 */
const NEEDS_REAL_DATA = new Set([
    'verify_y_semantics',        // 读真机地形库 terrain3d.db（没有那个库无法量化 y 语义）
    'test_memory_cap',           // readFileSync('./bots/deepseek/memory.json')，无兜底
    'test_nav_opt',              // REAL = './bots/deepseek/map'
    'test_path3d',               // MAP = './bots/deepseek/map'，空库直接 exit 2
]);

/** 自动发现 + 例外表合成最终名单。 */
const UNITS = (() => {
    const discovered = readdirSync(HERE)
        .filter((f) => f.endsWith('_unit.mjs'))
        .map((f) => f.slice(0, -'_unit.mjs'.length) + '_unit')
        .sort();
    // ★ NEEDS_REAL_DATA 里的名字必须进 UNITS：它们要「被登记、然后跳过」，
    //   而不是「不在名单 → 默认集没有 → 也没人报它被跳过」—— 那就是静默不跑。
    const all = [...new Set([...discovered, ...EXTRA_OFFLINE, ...NEEDS_REAL_DATA])]
        .filter((n) => !EXCLUDE.has(n) && !PENDING_DELETE.has(n));
    return all.sort();
})();

// 「登记了但文件不存在」必须当场炸：否则 execFileSync ENOENT 会被当成"测试红了"，
// 或者更糟 —— 名字写错、测试静默不跑（又是一个"什么都没跑"的假绿）。
{
    const missing = UNITS.filter((n) => !existsSync(join(HERE, `${n}.mjs`)));
    if (missing.length) {
        console.log(`  ✗ 名单里有 ${missing.length} 个脚本找不到文件：${missing.join(', ')}`);
        process.exit(1);
    }
    if (!UNITS.length) {
        console.log('  ✗ 一个脚本都没发现 —— 发现规则坏了，不能当成"没有测试"');
        process.exit(1);
    }
    // 反向也要查：NEEDS_REAL_DATA 写了名字却不在名单里 → 既不会被跑、也不会报"跳过"。
    const orphanSkip = [...NEEDS_REAL_DATA].filter((n) => !UNITS.includes(n));
    if (orphanSkip.length) {
        console.log(`  ✗ NEEDS_REAL_DATA 里有 ${orphanSkip.length} 个名字不在名单中（永远不跑也不报跳过）：${orphanSkip.join(', ')}`);
        process.exit(1);
    }
    const both = UNITS.filter((n) => EXCLUDE.has(n));
    if (both.length) {
        console.log(`  ✗ 名单里出现了被排除的脚本：${both.join(', ')}`);
        process.exit(1);
    }
    // F-GATE-002：废弃脚本必须**看得见**，不能被静默跳过。
    // 文件还在 = 还没 git rm ⇒ 每次跑都提醒一次，并给出可直接复制的删除命令。
    const pending = [...PENDING_DELETE.keys()].filter((n) => existsSync(join(HERE, `${n}.mjs`)));
    if (pending.length) {
        console.log(`  ⚠ ${pending.length} 个**已废弃**的脚本仍未删除（它们依赖的模块已被删，跑必红，故不进默认集）：`);
        for (const n of pending) console.log(`      · tools/${n}.mjs —— ${PENDING_DELETE.get(n)}`);
        console.log(`    收掉方式：git rm ${pending.map((n) => `tools/${n}.mjs`).join(' ')}`);
    }
}

const argv = process.argv.slice(2);

// ★ T05（新增2）：`--list` —— 只吐清单，**不实跑任何脚本**，给 preflight 的统计段用。
//   为什么加这个而不是让 preflight 去文本解析：T03 把 UNITS 改成 readdirSync 自动发现后，
//   preflight 里那段 `const UNITS = [...]` 的正则解析就永远匹配不到，于是 [7/7] 打出
//   「测试脚本 — ← 清单解析失败」。修法有两条：(a) 让 preflight 重新实现一遍发现规则
//   → 立刻变成第二份真相，改一处必须改两处；(b) **让这里导出清单**，preflight 只消费。
//   选 (b)：清单只有一份，preflight 不再需要知道"怎么发现脚本"。
if (argv.includes('--list')) {
    const payload = {
        registered: UNITS.length,
        executed: UNITS.filter((n) => !NEEDS_REAL_DATA.has(n)).length,
        skipped: UNITS.filter((n) => NEEDS_REAL_DATA.has(n)).length,
        units: UNITS,
        needsRealData: [...NEEDS_REAL_DATA],
        excluded: [...EXCLUDE.keys()],
        // 与第 130 行的运行时告警保持一致：文件已删（git rm 完成）就不再列，避免永久噪音。
        pendingDelete: [...PENDING_DELETE.keys()].filter((n) => existsSync(join(HERE, `${n}.mjs`))),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(0);
}

const withReal = argv.includes('--real');
const filter = argv.filter((a) => !a.startsWith('--'));
const picked = filter.length ? UNITS.filter((n) => filter.some((f) => n.includes(f))) : UNITS;
const list = picked.filter((n) => withReal || !NEEDS_REAL_DATA.has(n));
const skipped = picked.filter((n) => !withReal && NEEDS_REAL_DATA.has(n));

if (skipped.length) {
    console.log(`跳过 ${skipped.length} 个需要真机数据的脚本（加 --real 才跑）：${skipped.join(', ')}`);
}

let failed = 0;
const results = [];
/**
 * ★ T04：脚本**跑过了但自己声明缺环境**（行首 SKIP + exit 0）的，记这里。
 * 与 `skipped`（按 NEEDS_REAL_DATA 名单事先排除）分开：这些是"跑了才知道没数据"。
 * 两边都要**点名打印**，否则就是"静默没跑"。
 */
const skippedDynamic = [];
/** t68：统计"绕过了严格假件（覆盖 stubs.blockAt）"的次数 = 单测盲区宽度的下限。 */
let strictBypass = 0;
let strictGuarded = 0;          // 其中已调用 assertPointLike 的
let strictBypassFiles = [];

for (const name of list) {
    const script = join(HERE, `${name}.mjs`);
    process.stdout.write(`\n===== ${name} =====\n`);
    try {
        const out = execFileSync(process.execPath, [script], {
            encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
            // 把 fake_bot 的"覆盖严格 blockAt"告警改走 stdout，好在这里统计到
            env: { ...process.env, FAKE_BOT_NOTICE_STDOUT: '1' },
        });
        const printed = String(out);
        process.stdout.write(printed);
        const bypass = (printed.match(/\[fake_bot\]\[STRICT-BYPASS\]/g) || []).length;
        const guarded = (printed.match(/\[fake_bot\]\[STRICT-GUARDED\]/g) || []).length;
        if (bypass || guarded) {
            strictBypass += bypass + guarded;
            strictGuarded += guarded;
            strictBypassFiles.push(`${name}(${bypass}+${guarded}守卫)`);
        }
        // ★ 2026-11-01 修：只数**行首**的 PASS（同 atom_all）。汇总行里也含 "PASS" 字样，
        // 用词边界匹配会把汇总行算成一条用例，显示数系统性虚高。
        const passCount = (printed.match(/^\s*PASS\s/mg) || []).length;
        // ★ T04：脚本自己声明「缺环境，跳过」= 行首 SKIP 且 exit 0。
        //   区分「缺数据」和「代码坏了」：前者不算失败，但要**点名报出来**，
        //   否则就变成"静默没跑"（第18条那族坑）。
        const skipLines = printed.match(/^\s*SKIP\s.*$/mg) || [];
        if (passCount === 0 && skipLines.length) {
            const why = skipLines[0].trim();
            results.push({ name, ok: true, skipped: true, cases: 0, why });
            skippedDynamic.push(`${name}（${why}）`);
        } else if (passCount === 0) {
            console.log(`  ✗ ${name} 一条 PASS 都没有 —— 视为失败`);
            results.push({ name, ok: false, code: 'NO_CASES_RAN' });
            failed++;
        } else {
            results.push({ name, ok: true, cases: passCount });
        }
    } catch (e) {
        const printed = `${e.stdout ?? ''}`;
        if (printed.trim()) process.stdout.write(printed);
        results.push({ name, ok: false, code: e.status ?? 'error' });
        failed++;
    }
}

console.log('\n================ 离线单测总览 ================');
for (const r of results) {
    if (r.skipped) {
        console.log(`  ⏭ ${r.name}  (缺环境，脚本自报跳过)`);
        continue;
    }
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? `  (${r.cases} 个用例)` : `  (exit ${r.code})`}`);
}
for (const name of skipped) {
    console.log(`  ⏭ ${name}  (需要真机数据，加 --real 跑)`);
}
for (const line of skippedDynamic) {
    console.log(`  ⏭ ${line}`);
}
{
    // "通过"只数真有断言的；跳过的单独算，不混进分母（混进去会让"跳过"看起来像"通过"）。
    const ran = results.filter((r) => !r.skipped);
    const skippedTotal = skipped.length + skippedDynamic.length;
    console.log(`  ${ran.length - failed}/${ran.length} 个脚本通过${skippedTotal ? `，${skippedTotal} 个跳过` : ''}`);
}
// ★ t68：绕过严格假件的次数 —— **单测盲区宽度的下限**。
//   "门装了吗" 不等于 "有多少人走门"：`strictPoints` 只在**没被 stubs.blockAt 覆盖**时生效。
//   这个数 = 当前有多少个用例走偏门、对"裸坐标"这类形状错误无感。
if (strictBypass) {
    const naked = Math.max(0, strictBypass - strictGuarded);
    console.log(`  ⚠ blockAt 覆盖：${strictBypass} 处 —— 按"保护强度"分三档：`);
    console.log(`     ├─ 完全裸奔（无任何形状守卫）：${naked} 处   ← **这才是真盲区**`);
    console.log(`     ├─ 已加 assertPointLike 守卫：${strictGuarded} 处   ← 形状错会立刻抛，保护已在`);
    console.log(`     └─ 已改 world / blockProps：见各测试文件（不再出现于本计数）  ← 最理想`);
    console.log(`     明细（裸奔+守卫）：${strictBypassFiles.join(' ')}`);
    console.log('     ★ 口径说明：只有"完全裸奔"是真盲区；把两个数混在一起会误导人。');
} else {
    console.log('  ✓ 没有用例覆盖 stubs.blockAt（严格假件全量生效）');
}
console.log('  （这些都不需要服务器；需要真机的另有 tools/atom_all.mjs）');
console.log('============================================');
process.exit(failed === 0 ? 0 : 1);
