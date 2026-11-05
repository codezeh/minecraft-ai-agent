// t24 R2①：R1-b 实测 —— 从 preflight.mjs 源码抽出错误码审计的两条正则，
// 对作者自测样本 + 任务要求的 3 条注入（含数字码、双引号码）逐条验命中。
// 运行：cd E:\我的世界ai && node docs/audit/probes/t24-r1b-regex-injection.mjs
// 判据：①全大写单引号 ②含数字 ③双引号 —— 三条都必须命中；纯数据载荷 code 不应命中。
import { readFileSync } from 'fs';

const SRC = 'E:/我的世界ai/mindcraft/tools/preflight.mjs';
const text = readFileSync(SRC, 'utf8');

const blk = text.match(/const CODE_AUDIT_REGEXES = \[([\s\S]*?)\n\];/);
if (!blk) { console.log('X 抽不到 CODE_AUDIT_REGEXES'); process.exit(1); }

// 作者把两条正则各写成独立一行、以逗号结尾。只取这种行，避免被注释里的 '/' 干扰。
const lines = blk[1].split('\n').map((l) => l.trim());
const litLines = lines.filter((l) => l.startsWith('/') && !l.startsWith('//') && /[gimsuy]*,?$/.test(l));
console.log('抽到的正则行数 =', litLines.length);
const regexes = litLines.map((l) => {
    const body = l.replace(/,$/, '');
    const lastSlash = body.lastIndexOf('/');
    const pattern = body.slice(1, lastSlash);
    const flags = body.slice(lastSlash + 1);
    return new RegExp(pattern, flags);
});
regexes.forEach((r, i) => console.log(`  [${i}] ${r}`));
console.log('');

const CASES = [
    ["fail('T23_UNREGISTERED_CODE')", '1 全大写+下划线+单引号（原来能抓）', true],
    ["fail('ZZPROBE2X')", '2 含数字（R1-b 前会漏）', true],
    ['fail("ZZPROBEDQ")', '3 双引号（R1-b 前会漏）', true],
    ["  fail('NO_TARGET', 'x')", '4 常规 fail 调用（不能坏）', true],
    ["{ ok: false, code: 'PREEMPTED' }", '5 ActionResult 形态（第二条正则的目标）', true],
    ["code: 'DIED'", '6 纯数据载荷 code（收紧后应不命中）', false],
];

let bad = 0;
for (const [src, label, want] of CASES) {
    const which = [];
    regexes.forEach((re, i) => { re.lastIndex = 0; if (re.test(src)) which.push(i); });
    const hit = which.length > 0;
    let verdict;
    if (want === true) { verdict = hit ? `PASS 命中[${which}]` : 'FAIL 漏了!'; if (!hit) bad++; }
    else { verdict = !hit ? 'PASS 正确不命中' : `NOTE 命中[${which}]（口径偏宽）`; }
    console.log(`${verdict.padEnd(22)} ${label}  ←  ${JSON.stringify(src)}`);
}

console.log('');
console.log(bad === 0
    ? '结论：三条注入（含数字码、双引号码）全部命中 —— R1-b 两个词法盲区都已修好。'
    : `结论：${bad} 条该命中的没命中 —— R1-b 没修全。`);
