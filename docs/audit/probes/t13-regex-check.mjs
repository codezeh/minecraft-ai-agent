// t13：核验 preflight.mjs 里 0x08 退格符污染的三条正则的实际行为。
// 只读 preflight.mjs 与 control.js，不改任何源码。
import { readFileSync } from 'fs';

const PF = 'mindcraft/tools/preflight.mjs';
const lines = readFileSync(PF, 'utf8').split('\n');

// 1) 0x08 出现在哪些行
const badLines = [];
lines.forEach((l, i) => { if (l.includes('\u0008')) badLines.push(i + 1); });
console.log('含 0x08 的行号:', badLines.join(', '));

// 2) :183 那两条正则（照抄源码，保留 0x08）
const L183 = lines[182];
const regs = L183.match(/\/[^\n]*?\/g/g) || [];
console.log('\n:183 解析出', regs.length, '条正则');
for (const r of regs) {
    const hasBS = r.includes('\u0008');
    let re = null;
    try { re = new Function('return ' + r)(); } catch (e) { console.log('  构造失败:', e.message); continue; }
    const samples = ["fail('DIED', 'x')", "code: 'DIED'", "  code: 'ORPHAN_PARENT',"];
    const hits = samples.filter((s) => { re.lastIndex = 0; return re.test(s); });
    console.log(`  ${JSON.stringify(r)}  含0x08=${hasBS}  命中样本=${JSON.stringify(hits)}`);
}

// 3) 同样两条正则的「正确写法」（\b 词边界）
console.log('\n正确写法（\\b）对同样样本:');
for (const re of [/\bfail\(\s*'([A-Z_]+)'/g, /\bcode:\s*'([A-Z_]+)'/g]) {
    const samples = ["fail('DIED', 'x')", "code: 'DIED'"];
    const hits = samples.filter((s) => { re.lastIndex = 0; return re.test(s); });
    console.log(`  ${re}  命中=${JSON.stringify(hits)}`);
}

// 4) :933 sawASection —— 三选一里哪几条还活着
const L933 = lines[932];
console.log('\n:933 原文:', JSON.stringify(L933.trim()));
const sawSrc = L933.match(/=\s*(\/.*\/)\.test/);
if (sawSrc) {
    const re = new Function('return ' + sawSrc[1])();
    console.log('  "── A·策略" 命中:', re.test('── A·策略'), ' ← 第一条 \u2500\u2500 A· 完好就仍为 true');
    re.lastIndex = 0;
    console.log('  "A·策略"   命中:', re.test('A·策略'), ' ← 中间那条带 0x08，应 false');
}

// 5) control.js 里 DIED 的实际出现形式（判断是数据载荷还是 fail 调用）
const ctrl = readFileSync('mindcraft/src/agent/library/control.js', 'utf8');
console.log('\ncontrol.js: fail(\'DIED\' 出现次数 =', (ctrl.match(/fail\(\s*'DIED'/g) || []).length);
console.log("control.js: code: 'DIED' 出现次数 =", (ctrl.match(/code:\s*'DIED'/g) || []).length);
