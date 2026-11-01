/**
 * 原子层全部验收：一次跑完 7 个原子的测试。
 *
 * 为什么需要：单个跑容易漏，而且顺序跑能暴露"测试之间互相污染"的问题
 * （实测踩过：残留实体、残留窗口、模式没复位）。
 *
 * 用法：
 *   node tools/atom_all.mjs            # 跑全部
 *   node tools/atom_all.mjs dig place  # 只跑指定几个
 *
 * 前置：测试服 25566 在跑（RCON 25576）。
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';
import net from 'node:net';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * 开跑前先确认测试服在。
 *
 * ★ 2026-10-31 修：**服务器没开时这里原来会"全绿通过"**。
 * 实测：25566 关掉后 `node tools/atom_drops.mjs` 打 ECONNREFUSED 却**退出码 0**
 * （各脚本里 `bot.on('error', () => {})` 把连接错误吞了），于是 atom_all 照样打 ✅。
 * 这是最坏的一种假绿——什么都没测，却说通过了。
 * 现在连不上就直接判失败，不许它冒充通过。
 */
function serverUp(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const s = net.connect({ host, port, timeout: timeoutMs });
        const done = (v) => { try { s.destroy(); } catch { } resolve(v); };
        s.on('connect', () => done(true));
        s.on('timeout', () => done(false));
        s.on('error', () => done(false));
    });
}

if (!(await serverUp('127.0.0.1', 25566))) {
    console.log('✗ 测试服 127.0.0.1:25566 连不上 —— 原子测试**没有执行**（这不等于通过）。');
    console.log('  请先起测试服（超平坦，RCON 25576），再跑本脚本。');
    process.exit(1);
}

/** 原子层测试（单文件前缀 atom_） */
const ATOM_ORDER = ['move', 'dig', 'place', 'items', 'container', 'use', 'attack', 'stand', 'drops', 'look', 'safe', 'query', 'wait'];
/** 复合层测试（plan/runSteps 那套），跑在原子之后 */
const SKILL_TESTS = ['skill_collect', 'skill_clear'];
/** 原子层契约专项测试（不属于 atom_* 命名，单独列） */
const EXTRA_TESTS = ['atom_move_landing', 'atom_pickup_parts', 'vine_physics_test'];

const want = process.argv.slice(2);
const list = want.length
    ? [...ATOM_ORDER.filter(t => want.includes(t)).map(t => `atom_${t}`), ...SKILL_TESTS.filter(t => want.includes(t)), ...EXTRA_TESTS.filter(t => want.includes(t))]
    : [...ATOM_ORDER.map(t => `atom_${t}`), ...EXTRA_TESTS, ...SKILL_TESTS];

let failed = 0;
const results = [];

for (const name of list) {
    const script = join(HERE, `${name}.mjs`);
    process.stdout.write(`\n===== ${name} =====\n`);
    try {
        // 用 pipe 而不是 inherit：要检查"到底有没有真的跑用例"
        const out = execFileSync(process.execPath, [script], {
            encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const printed = String(out);
        process.stdout.write(printed);
        // ★ 防假绿：一个用例都没 PASS 就说明脚本中途放弃（最常见是连不上服务器后静默退出）
        // ★ 2026-11-01 修：只数**行首**的 PASS，不要数汇总行里的。
        // 每个测试脚本结尾都会打印 `xxx 原子：12 PASS / 0 FAIL` 这样一行汇总，
        // 原来的词边界匹配把这一行也算成一条用例 → 显示数系统性 +1（18 个脚本 = +18）。
        // 实测后果：atom_all 显示 262 条、真实 244 条；"skill_collect 23/23" 实为 22/22。
        // 凡引用过显示数的地方都被虚高抬了一次 —— 这是测量说谎，比慢 8% 更该先修。
        const passCount = (printed.match(/^\s*PASS\s/mg) || []).length;
        if (passCount === 0) {
            console.log(`  ✗ ${name} 一条 PASS 都没有 —— 视为失败（可能没连上服务器）`);
            results.push({ name, ok: false, code: 'NO_CASES_RAN' });
            failed++;
        } else {
            results.push({ name, ok: true, cases: passCount });
        }
    } catch (e) {
        // 测试失败时 execFileSync 会抛；退出码 1 就是"有用例失败"
        const printed = `${e.stdout ?? ''}`;
        if (printed.trim()) process.stdout.write(printed);
        results.push({ name, ok: false, code: e.status ?? 'error' });
        failed++;
    }
}

console.log('\n================ 原子层总览 ================');
for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? `  (${r.cases} 个用例)` : `  (exit ${r.code})`}`);
}
console.log(`  ${results.length - failed}/${results.length} 个测试通过`);
console.log('============================================');
process.exit(failed === 0 ? 0 : 1);
