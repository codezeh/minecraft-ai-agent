/**
 * `tools/` 的 eslint **棘轮**（T04 / 队长裁决 4）。
 *
 * 为什么 tools/ 不设成"必须清零"：
 *   tools/ 下是 200 多个历史探针 / 基准 / 一次性诊断脚本，为它们开一次几百行清理
 *   不划算；但**放任它涨更糟**（下一个人会照着最脏的文件写）。
 *   所以用棘轮：**不高于记录上限**，每次改善后再把上限压下去。
 *
 * 与 `npm run lint` 的分工（别把两者混为一谈）：
 *   - `npm run lint`      = 硬门（eslint src main.js），目标 no-undef=0 / no-floating-promise=0。
 *   - `npm run lint:tools`= 棘轮（本文件），只要求不高于基线，**不要求清零**。
 *   - `npm run lint:all`  = 两条都跑。
 *
 * 用法：
 *   node tools/lint_ratchet.mjs            # 检查（超过任一项即 exit 1）
 *   node tools/lint_ratchet.mjs --update   # 把当前真实计数写成新基线（只在确实改善后用）
 *
 * 口径：按 **ruleId 分类计数** + 总数。只看总数会被"修好一个问题、又新写两个"掩盖；
 * 分类计数能抓到"总数没变但某一类暴涨"。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const BASELINE_PATH = join(HERE, 'lint_tools_baseline.json');
const ESLINT_BIN = join(REPO, 'node_modules', 'eslint', 'bin', 'eslint.js');

const update = process.argv.includes('--update');

if (!existsSync(ESLINT_BIN)) {
    console.error(`[lint:ratchet] 找不到 eslint：${ESLINT_BIN}`);
    console.error('  → 先 npm install（eslint 现在是 devDependency）');
    process.exit(1);
}

const r = spawnSync(process.execPath, [ESLINT_BIN, 'tools', '--format', 'json'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
});

// eslint 有 lint 错误时退出码为 1 —— 这是正常情况（tools/ 本来就有问题）。
// 只有拿不到可解析的 JSON 才算"工具没跑起来"。
let report = null;
try {
    report = JSON.parse(r.stdout ?? '');
} catch {
    console.error('[lint:ratchet] eslint 没有输出可解析的 JSON —— 工具没跑起来');
    console.error(`  status=${r.status}`);
    console.error(`  stderr=${(r.stderr ?? '').slice(0, 400)}`);
    process.exit(1);
}
if (!Array.isArray(report)) {
    console.error('[lint:ratchet] eslint 输出不是数组');
    process.exit(1);
}

const counts = {};
let total = 0;
for (const file of report) {
    for (const m of file.messages ?? []) {
        const key = m.ruleId ?? `parse:${String(m.message ?? '').slice(0, 40)}`;
        counts[key] = (counts[key] ?? 0) + 1;
        total += 1;
    }
}

// 扫到 0 个文件时 totals 也会是 0 —— 那是"扫描器坏了"，不是"干净了"。
if (report.length === 0) {
    console.error('[lint:ratchet] 一个文件都没扫到 —— 不许当成"没有违规"');
    process.exit(1);
}

const current = {
    scope: 'tools/',
    note: '由 tools/lint_ratchet.mjs 维护：棘轮上限，只许降不许升。--update 收紧。',
    filesScanned: report.length,
    total,
    byRule: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])),
};

if (update) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    console.log(`[lint:ratchet] 基线已更新 → ${relative(REPO, BASELINE_PATH)}`);
    console.log(`  扫 ${current.filesScanned} 个文件，总问题 ${current.total}`);
    process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
    console.error(`[lint:ratchet] 没有基线文件：${relative(REPO, BASELINE_PATH)}`);
    console.error('  首次建立基线请跑： node tools/lint_ratchet.mjs --update');
    process.exit(1);
}

const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const violations = [];

// ① 总数不许升
if (total > base.total) {
    violations.push(`总数 ${base.total} → ${total}（+${total - base.total}）`);
}

// ② 分类不许升（抓"总数没变但某类暴涨"）
for (const [rule, n] of Object.entries(counts)) {
    const was = base.byRule[rule] ?? 0;
    if (n > was) violations.push(`${rule} ${was} → ${n}（+${n - was}）`);
}

if (violations.length) {
    console.error('');
    console.error('  ✗ [lint:ratchet] tools/ 的 lint 问题超过基线（棘轮只许降不许升）');
    for (const v of violations) console.error(`     · ${v}`);
    console.error('');
    console.error('  修掉新增的问题即可。若确认是"基线本身该收紧"，跑：');
    console.error('     node tools/lint_ratchet.mjs --update');
    console.error('  （--update 会把当前**包含新增问题**的数字写成新上限 —— 只在确实改善后用）');
    console.error('');
    process.exit(1);
}

const improved = [];
if (total < base.total) improved.push(`总数 ${base.total} → ${total}（改善 ${base.total - total}）`);
for (const [rule, was] of Object.entries(base.byRule)) {
    const now = counts[rule] ?? 0;
    if (now < was) improved.push(`${rule} ${was} → ${now}`);
}

console.log(`  ✓ [lint:ratchet] tools/ 未超过基线（${total} ≤ ${base.total}，扫 ${report.length} 个文件）`);
if (improved.length) {
    console.log('  可以收紧基线了（跑 --update）：');
    for (const s of improved.slice(0, 8)) console.log(`     · ${s}`);
}
process.exit(0);
