// 审计：所有 fail('XXX') / code: 'XXX' 用到的错误码，是否都注册在 CODES 里。
//
// 为什么要这个：本项目已经踩过 4 次同一个坑 ——
//   NO_REACH / NOT_CLIMBABLE / UNSAFE / LIQUID_RISK
// 都是新模块用了新错误码但忘了注册，运行时 fail() 直接 throw，
// 表现是"功能莫名崩溃"，而且报错信息（"非法 code"）完全不指向根因。
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src';
const file = path.join(SRC, 'agent/library/contract.js');
const src = fs.readFileSync(file, 'utf8');

const m = src.match(/export const CODES = \[([\s\S]*?)\]/);
if (!m) { console.error('读不到 CODES 定义'); process.exit(2); }
const codes = [...m[1].matchAll(/'([A-Z_]+)'/g)].map(x => x[1]);

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
for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const mm of s.matchAll(/\bfail\(\s*'([A-Z_]+)'/g)) {
        if (!used.has(mm[1])) used.set(mm[1], new Set());
        used.get(mm[1]).add(path.relative('.', f));
    }
    for (const mm of s.matchAll(/\bcode:\s*'([A-Z_]+)'/g)) {
        if (!used.has(mm[1])) used.set(mm[1], new Set());
        used.get(mm[1]).add(path.relative('.', f));
    }
}

const missing = [...used.keys()].filter(k => !codes.includes(k)).sort();
const unused = codes.filter(c => !used.has(c)).sort();

console.log(`CODES 已注册: ${codes.length} 个`);
console.log(`代码里实际用到: ${used.size} 个`);
console.log('');
if (missing.length) {
    console.log(`✗ 用了但没注册: ${missing.length} 个`);
    for (const k of missing) {
        console.log(`   ${k}`);
        for (const f of used.get(k)) console.log(`       ${f}`);
    }
    process.exit(1);
} else {
    console.log('✓ 所有用到的错误码都已注册');
}
if (unused.length) {
    console.log('');
    console.log(`（已注册但没人用: ${unused.join(', ')}）`);
}
