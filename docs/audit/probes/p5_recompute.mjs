// P5：从现存 artifact 重算「格/秒」，检验 README 的 1.41 是否可复算。
// 运行：node docs/audit/probes/p5_recompute.mjs
// 只读：遍历 tmp/bench、mindcraft/tmp/bench 下所有 .jsonl/.json，不写任何东西。
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [
    'tmp/bench',
    'mindcraft/tmp/bench',
    'mindcraft/tmp/bench/archive',
];
const files = [];
for (const r of ROOTS) {
    if (!existsSync(r)) continue;
    for (const f of readdirSync(r)) {
        const p = join(r, f);
        try { if (statSync(p).isFile() && /\.(jsonl|json)$/.test(f)) files.push(p); } catch { }
    }
}

const rows = [];
for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
    for (const line of lines) {
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        // 找出所有含"距离"与"耗时"的对
        const dist = o.moved ?? o.dist ?? o.blocks ?? o.distance ?? o.progress ?? null;
        const ms = o.ms ?? o.costMs ?? o.elapsedMs ?? o.durationMs ?? null;
        const scen = o.scenario ?? o.name ?? o.label ?? (o.run !== undefined ? `run${o.run}` : '?');
        if (typeof dist === 'number' && typeof ms === 'number' && ms > 0) {
            rows.push({
                file: f, scen, dist, ms,
                rate: +(dist / (ms / 1000)).toFixed(3),
                ok: o.ok, code: o.code ?? '',
            });
        }
    }
}

console.log(`扫描文件 ${files.length} 个，可复算记录 ${rows.length} 条\n`);
if (!rows.length) {
    console.log('没有任何 artifact 同时带距离与耗时 → 无法复算。');
}

// 按场景汇总
const byScen = new Map();
for (const r of rows) {
    const k = r.scen.replace(/run\d+/, 'runN');
    if (!byScen.has(k)) byScen.set(k, []);
    byScen.get(k).push(r);
}
console.log('=== 按场景汇总（从 artifact 重算）===');
console.log('scenario'.padEnd(28) + 'n'.padStart(3) + '  平均格'.padStart(9) + '  平均秒'.padStart(9) + '  平均格/秒'.padStart(11) + '   最小~最大');
for (const [k, arr] of byScen) {
    const n = arr.length;
    const d = arr.reduce((a, b) => a + b.dist, 0);
    const ms = arr.reduce((a, b) => a + b.ms, 0);
    const rates = arr.map(r => r.rate).sort((a, b) => a - b);
    console.log(
        k.padEnd(28) + String(n).padStart(3)
        + (d / n).toFixed(1).padStart(9)
        + (ms / n / 1000).toFixed(1).padStart(9)
        + (d / (ms / 1000)).toFixed(2).padStart(11)
        + `   ${rates[0]}~${rates[rates.length - 1]}`
    );
}

console.log('\n=== 有没有任何一条接近 1.41 格/秒？ ===');
const near = rows.filter(r => Math.abs(r.rate - 1.41) <= 0.15);
console.log(near.length ? near.map(r => `${r.file} ${r.scen} ${r.dist}格/${r.ms}ms = ${r.rate}`).join('\n')
    : '没有。全部记录的格/秒分布见上表。');

console.log('\n=== 有没有 "302 格" 级别的场景？ ===');
const big = rows.filter(r => r.dist >= 250);
console.log(big.length ? big.map(r => `${r.file} ${r.scen} dist=${r.dist}`).join('\n') : '没有任何一条记录的推进量 ≥250 格。');

console.log('\n=== 明细（前 30 条）===');
for (const r of rows.slice(0, 30)) {
    console.log(`${r.file.padEnd(52)} ${String(r.scen).padEnd(18)} dist=${String(r.dist).padStart(6)} ms=${String(r.ms).padStart(7)} rate=${r.rate} ok=${r.ok}`);
}
