// 契约测试：不需要服务器，验证 ActionResult 的形状、校验、序列化。
import assert from 'node:assert';
import { CODES, ok, fail, isResult, asBool, truncate, formatActionResult } from '../src/agent/library/atom_contract.js';

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('契约测试');

t('ok() 形状', () => {
    const r = ok({ dist: 1.2 });
    assert.deepStrictEqual(Object.keys(r).sort(), ['code', 'data', 'message', 'ok']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code, 'OK');
    assert.strictEqual(r.message, '');
});

t('fail() 形状', () => {
    const r = fail('NO_PATH', '没有路', { dist: 3 });
    assert.deepStrictEqual(Object.keys(r).sort(), ['code', 'data', 'message', 'ok']);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NO_PATH');
    assert.strictEqual(r.message, '没有路');
});

t('fail() 拒绝非法 code', () => {
    assert.throws(() => fail('NOT_A_CODE', 'x'), /非法 code/);
    assert.throws(() => fail('OK', 'x'), /非法 code/);
});

t('fail() 拒绝空 message', () => {
    assert.throws(() => fail('NO_PATH', ''), /message 不能为空/);
});

t('返回值被冻结（防手改）', () => {
    const r = ok();
    assert.throws(() => { 'use strict'; r.ok = false; }, TypeError);
});

t('JSON 往返不变（抓 undefined / 函数）', () => {
    const r = fail('TIMEOUT', '超时', { costMs: 1000, pos: { x: 1, y: 2, z: 3 } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r);
});

t('isResult / asBool', () => {
    assert.strictEqual(isResult(ok()), true);
    assert.strictEqual(isResult(true), false);
    assert.strictEqual(isResult(null), false);
    assert.strictEqual(asBool(ok()), true);
    assert.strictEqual(asBool(fail('NO_PATH', 'x')), false);
    assert.strictEqual(asBool(true), true);
    assert.strictEqual(asBool('非空字符串'), false); // 旧代码里的真值陷阱
});

t('truncate 行数截断', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const out = truncate(text);
    assert.ok(out.includes('省略'), '应带省略提示');
    assert.ok(out.split('\n').length < 60, '截断后应显著变短');
});

t('truncate 短文本不动', () => {
    assert.strictEqual(truncate('abc'), 'abc');
});

t('formatActionResult: ActionResult 压成一行', () => {
    const out = formatActionResult('collect', { message: '旧日志' }, fail('NO_PATH', '没有路', { dist: 3 }));
    assert.ok(out.startsWith('collect: NO_PATH'), out);
    assert.ok(out.includes('没有路'), out);
});

t('formatActionResult: 旧返回值退回日志', () => {
    const out = formatActionResult('x', { message: '旧日志内容' }, true);
    assert.strictEqual(out, '旧日志内容');
});

t('CODES 无重复且包含关键项', () => {
    assert.strictEqual(new Set(CODES).size, CODES.length);
    for (const c of ['NO_PATH', 'OUT_OF_REACH', 'TIMEOUT', 'INTERNAL']) assert.ok(CODES.includes(c));
});

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
