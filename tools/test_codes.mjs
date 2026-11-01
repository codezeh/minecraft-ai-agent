// 错误码注册测试（2026-10-29）
//
// 为什么需要这条测试：本项目已经踩过 4 次同一个坑 ——
//   NO_REACH / NOT_CLIMBABLE / UNSAFE / LIQUID_RISK
// 都是新模块用了新错误码但忘了注册，运行时 `fail()` 直接 throw：
//     throw new Error(`fail(): 非法 code "${code}"`);
// 表现是"功能莫名崩溃"，而报错信息完全不指向根因（只说 code 非法，不说是哪个模块忘了注册）。
//
// 这条测试把"用到的 code 必须在 CODES 里"变成硬约束。
import fs from 'node:fs';
import path from 'node:path';
import { CODES } from '../src/agent/library/contract.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

// 1) CODES 本身要是合法数组
check('CODES 是非空数组', Array.isArray(CODES) && CODES.length > 0, `${CODES.length} 个`);
check('CODES 无重复', new Set(CODES).size === CODES.length, `${new Set(CODES).size}/${CODES.length}`);
check('CODES 全是大写加下划线', CODES.every(c => /^[A-Z][A-Z_]*$/.test(c)), '');

// 2) 扫源码里所有 fail('XXX') 与 code: 'XXX'
const SRC = 'src';
const files = [];
(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'bots' || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
    }
})(SRC);

const used = new Map();   // code -> Set<file>
const PATTERNS = [
    /\bfail\(\s*'([A-Z_]+)'/g,        // fail('XXX')
    /\bcode:\s*'([A-Z_]+)'/g,         // { code: 'XXX' }
];
for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const re of PATTERNS) {
        for (const mm of s.matchAll(re)) {
            if (!used.has(mm[1])) used.set(mm[1], new Set());
            used.get(mm[1]).add(path.relative('.', f));
        }
    }
}

const missing = [...used.keys()].filter(k => !CODES.includes(k)).sort();
console.log(`\n  扫到 ${used.size} 个错误码，CODES 注册 ${CODES.length} 个`);
if (missing.length) {
    for (const k of missing) {
        console.log(`    未注册: ${k}`);
        for (const f of used.get(k)) console.log(`        ${f}`);
    }
}
check('所有用到的错误码都已注册在 CODES 里', missing.length === 0,
    missing.length ? missing.join(', ') : '');

// 3) 关键：fail() 对未注册 code 会 throw，必须验证这个行为本身是"响亮的"
//    （如果哪天有人把 throw 改成静默返回，这条测试会失败，提醒他别这么做）
{
    const { fail } = await import('../src/agent/library/contract.js');
    let threw = false;
    try { fail('__DEFINITELY_NOT_A_REAL_CODE__'); } catch { threw = true; }
    check('fail() 对未注册 code 会 throw（不静默）', threw, '');
}

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
