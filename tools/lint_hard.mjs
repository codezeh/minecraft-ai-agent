#!/usr/bin/env node
/**
 * lint 硬门（终审 R1 - 第 11 条）
 *
 * 为什么需要这一层，而不是直接把 `eslint src main.js` 塞进 pre-commit：
 *
 *   `eslint src main.js` 当前有 **197 problems**（semi / require-await / no-empty /
 *   no-ex-assign 等），它们**不属本轮整改指标**。如果把它的退出码直接当提交门禁，
 *   门禁上线第一天就是全红 —— 所有人只能 SKIP_GATE，等于把门焊死再拆掉。
 *
 *   所以硬门只钉在**本轮已经真实归零的两个指标**上：
 *     · no-undef            → 必须是 0（第 11 条：6 处 ReferenceError 已修）
 *     · no-floating-promise → 必须是 0（第 11 条：39 条已清零）
 *
 *   其余规则走 `lint:tools` 的棘轮思路：不要求清零，但不许**变多**。
 *   这样门禁既守住了两条真正的不变量，又不会因为历史欠账把人逼去绕过它。
 *
 * 明确写清它**不**管什么（别让下一个人误以为 lint 全绿了）：
 *   它不判 semi / require-await / no-empty / no-ex-assign —— 那些仍是非零，
 *   要看全貌请跑 `npm run lint`。
 *
 * 退出码：两条指标都为 0 → 0；否则 1 并打印明细。
 */

import { spawnSync } from 'node:child_process';

// 用 --format json 而不是 grep 文本行：
// 本轮栽过 `-f compact` 在这个 ESLint 版本不存在（命令报错 → 输出为空 →
// grep 数出 0 → 假绿）。JSON 会给出结构化结果，且**格式异常会显式报错**。
const r = spawnSync(process.execPath, [
    'node_modules/eslint/bin/eslint.js',
    'src', 'main.js',
    '--format', 'json',
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (r.error) {
    console.error(`  ✗ lint:hard 起不来：${r.error.code || r.error.message}`);
    process.exit(1);
}
if (r.status !== 0 && !r.stdout) {
    console.error('  ✗ lint:hard 没有拿到任何输出（命令本身可能坏了）');
    console.error(`    stderr: ${(r.stderr || '').slice(0, 400)}`);
    process.exit(1);
}

let results;
try {
    results = JSON.parse(r.stdout);
} catch (e) {
    console.error('  ✗ lint:hard 无法解析 eslint 的 JSON 输出（格式变了？）');
    console.error(`    ${String(e.message).slice(0, 200)}`);
    process.exit(1);
}
if (!Array.isArray(results)) {
    console.error('  ✗ lint:hard 的 JSON 结构不是数组，拒绝给出"通过"');
    process.exit(1);
}

const HARD = new Set(['no-undef', 'no-floating-promise/no-floating-promise']);
const hits = [];
let scanned = 0;

// ★ gate 复核补充（R1 收尾）：解析失败也算红，不能算"干净"。
//   抓 bug 时发现的一条假绿路径：文件语法错时 eslint 报的是 `{ fatal: true, ruleId: null }`，
//   而下面原实现只认 HARD 里的两条 ruleId → 该文件**一条记录都不产生** → 照样打 ✓。
//   那正是本仓库的母题："0 命中"被当成"通过"，其实文件根本没被 lint 过。
//   当前仓 0 个 fatal（167 文件全部解析成功），所以这条只是把口子堵上，不改变现状。
const parseErrors = [];

for (const file of results) {
    scanned++;
    for (const m of file.messages || []) {
        if (m.fatal) {
            parseErrors.push({ file: file.filePath, line: m.line, msg: m.message });
            continue;
        }
        if (HARD.has(m.ruleId)) {
            hits.push({ file: file.filePath, line: m.line, rule: m.ruleId, msg: m.message });
        }
    }
}

// 防"扫了 0 个文件还报绿"—— 本轮母题之一就是"0 命中 = 通过"
if (scanned === 0) {
    console.error('  ✗ lint:hard 扫到 0 个文件 —— 扫描器自己坏了，不是干净');
    process.exit(1);
}

// 解析失败 = 这个文件没被真正 lint 过，硬指标的 0 对它没有意义 → 直接判红
if (parseErrors.length) {
    console.error(`  ✗ [lint:hard] ${parseErrors.length} 个文件解析失败 —— 它们没被 lint 过，0 不等于干净`);
    for (const p of parseErrors.slice(0, 10)) console.error(`     ${p.file}:${p.line ?? '-'}  ${p.msg}`);
    if (parseErrors.length > 10) console.error(`     … 还有 ${parseErrors.length - 10} 个`);
    process.exit(1);
}

if (hits.length === 0) {
    console.log(`  ✓ [lint:hard] no-undef = 0 · no-floating-promise = 0（扫 ${scanned} 个文件）`);
    console.log('    注：semi / require-await 等历史欠账**不在本门禁范围**，看全貌请跑 npm run lint');
    process.exit(0);
}

console.error(`  ✗ [lint:hard] 硬指标不为 0：${hits.length} 处`);
for (const h of hits.slice(0, 30)) {
    console.error(`     ${h.file}:${h.line}  ${h.rule}  ${h.msg}`);
}
if (hits.length > 30) console.error(`     … 还有 ${hits.length - 30} 处`);
process.exit(1);
