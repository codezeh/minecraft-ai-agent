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

const HERE = fileURLToPath(new URL('.', import.meta.url));

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
        // 直接继承 stdio，让每个测试的输出实时可见
        execFileSync(process.execPath, [script], { stdio: 'inherit', timeout: 180000 });
        results.push({ name, ok: true });
    } catch (e) {
        // 测试失败时 execFileSync 会抛；退出码 1 就是"有用例失败"
        results.push({ name, ok: false, code: e.status ?? 'error' });
        failed++;
    }
}

console.log('\n================ 原子层总览 ================');
for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `  (exit ${r.code})`}`);
}
console.log(`  ${results.length - failed}/${results.length} 个测试通过`);
console.log('============================================');
process.exit(failed === 0 ? 0 : 1);
