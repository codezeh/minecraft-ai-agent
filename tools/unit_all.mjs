/**
 * 离线单元测试总入口 —— **不需要 Minecraft 服务器**。
 *
 * 为什么需要：`tools/atom_all.mjs` 要测试服 25566，服务器没开时根本跑不了；
 * 而这轮（Phase 1 + Phase 2）新增的回归脚本都是"假 bot + 纯逻辑"，
 * 本来就能离线跑。没有统一入口的话，要么漏跑，要么各跑各的。
 *
 * 用法：
 *   node tools/unit_all.mjs            # 跑全部
 *   node tools/unit_all.mjs terrain    # 只跑文件名含 "terrain" 的
 *
 * 约定：每个脚本自己打印 `PASS/FAIL`，全过退出码 0。
 * 这里额外检查"至少跑出一条用例"，防止脚本中途静默退出被当成通过
 * （同一个坑在 atom_all 上踩过，见 tools/atom_all.mjs 的说明）。
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 离线回归脚本（新增离线测试后记得加进来） */
const UNITS = [
    'atom_classify_unit',        // 原子纯函数化 + 地标缓存按 bot 隔离
    'atom_stuck_detect_unit',    // 卡住判据（垂直权重 / 真实位移 / NaN）
    'detect_trapped_unit',       // 被困判据（面积/封顶/出口/地表）
    'exec_step_dig_unit',        // D2 挖邻列 / 液体不假成功
    'exec_step_y_unit',          // D1 y 语义（脚位 vs 面位）
    'nav_core_unit',             // 导航入口的坐标归一与前置
    'scaffold_tracker_unit',     // D7 只清自己放的方块
    'task_pickup_unit',          // 掉落物回收搬到复合层后语义不变
    'terrain3d_unit',            // 连接复用 / fail 表 TTL / prune
    'test_escape',               // skill_escape 规划（假 bot，纯读世界）
    'tool_prep_timeout_unit',    // D12 goto/dig/craft 有上限
    'verify_y_semantics',        // 在真机录的地图库上量化 y 语义
];

const filter = process.argv.slice(2);
const list = filter.length ? UNITS.filter((n) => filter.some((f) => n.includes(f))) : UNITS;

let failed = 0;
const results = [];

for (const name of list) {
    const script = join(HERE, `${name}.mjs`);
    process.stdout.write(`\n===== ${name} =====\n`);
    try {
        const out = execFileSync(process.execPath, [script], {
            encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const printed = String(out);
        process.stdout.write(printed);
        const passCount = (printed.match(/\bPASS\b/g) || []).length;
        if (passCount === 0) {
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
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? `  (${r.cases} 个用例)` : `  (exit ${r.code})`}`);
}
console.log(`  ${results.length - failed}/${results.length} 个脚本通过`);
console.log('  （这些都不需要服务器；需要真机的另有 tools/atom_all.mjs）');
console.log('============================================');
process.exit(failed === 0 ? 0 : 1);
