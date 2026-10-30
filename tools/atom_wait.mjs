/**
 * atom_wait 的独立验收（不需要服务器，纯逻辑）。
 *
 * 重点验证：谓词返回 false 必须算"完成"（这是 atom_use 踩过的坑）。
 *
 * 用法：node tools/atom_wait.mjs
 */
import { waitUntil, waitBool } from '../src/agent/library/atom_wait.js';

let pass = 0, fail_ = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
    else { fail_++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    // 1) 立刻成立
    const r1 = await waitUntil(() => 42);
    check('立即成立', r1.ok && r1.data?.value === 42, `value=${r1.data?.value}`);

    // 2) ★ 返回 false 必须算完成（历史 bug：被当成"未完成"）
    const r2 = await waitUntil(() => false, { timeoutMs: 500 });
    check('★ false 算完成（不是超时）', r2.ok && r2.data?.value === false,
        `ok=${r2.ok} code=${r2.code} value=${r2.data?.value}`);

    // 3) 返回 0 / '' 也算完成
    const r3 = await waitUntil(() => 0, { timeoutMs: 500 });
    check('0 算完成', r3.ok && r3.data?.value === 0, `value=${r3.data?.value}`);
    const r4 = await waitUntil(() => '', { timeoutMs: 500 });
    check("'' 算完成", r4.ok && r4.data?.value === '', `value=${JSON.stringify(r4.data?.value)}`);

    // 4) undefined / null = 未完成 → 超时
    const r5 = await waitUntil(() => undefined, { timeoutMs: 200 });
    check('undefined → TIMEOUT', r5.code === 'TIMEOUT', `code=${r5.code}`);
    const r6 = await waitUntil(() => null, { timeoutMs: 200 });
    check('null → TIMEOUT', r6.code === 'TIMEOUT', `code=${r6.code}`);

    // 5) 延迟成立
    let n = 0;
    const r7 = await waitUntil(() => (++n >= 3 ? 'done' : undefined), { timeoutMs: 2000, intervalMs: 20 });
    check('延迟成立', r7.ok && r7.data?.value === 'done', `n=${n} waitedMs=${r7.data?.waitedMs}`);

    // 6) 中断
    const fakeBot = { interrupt_code: false };
    const p = waitUntil(() => undefined, { timeoutMs: 3000, intervalMs: 20, bot: fakeBot });
    setTimeout(() => { fakeBot.interrupt_code = true; }, 60);
    const r8 = await p;
    check('中断 → INTERRUPTED', r8.code === 'INTERRUPTED', `code=${r8.code} waitedMs=${r8.data?.waitedMs}`);

    // 7) 谓词抛错 → INTERNAL（不能把异常吞成超时）
    const r9 = await waitUntil(() => { throw new Error('boom'); }, { timeoutMs: 300 });
    check('谓词抛错 → INTERNAL', r9.code === 'INTERNAL', `code=${r9.code} msg=${r9.message}`);

    // 8) 非法参数
    check('非函数谓词 → INTERNAL', (await waitUntil('not a function')).code === 'INTERNAL');
    check('非法 timeout → INTERNAL', (await waitUntil(() => 1, { timeoutMs: NaN })).code === 'INTERNAL');

    // 9) waitBool 等价
    check('waitBool: false 也是 true', (await waitBool(() => false)) === true);
    check('waitBool: 超时为 false', (await waitBool(() => undefined, { timeoutMs: 150 })) === false);

    // 10) timeoutMs = 0 立刻超时（但先测一次谓词）
    const r10 = await waitUntil(() => undefined, { timeoutMs: 0 });
    check('timeoutMs=0 → TIMEOUT', r10.code === 'TIMEOUT', `code=${r10.code}`);

    console.log(`\nwait 原子：${pass} PASS / ${fail_} FAIL`);
    process.exit(fail_ === 0 ? 0 : 1);
})();
