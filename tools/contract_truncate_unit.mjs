/**
 * R6 #76 / #77 回归（离线，纯逻辑）—— 两条都是"错误被伪装成别的错误"。
 *
 * #76 truncate：行裁剪后不再跑字符裁剪 ⇒ 100 行 × 每行 5000 字符返回 25 万字符，
 *     正好是它要防的场景的变体（巨量正文以"省略 N 行"的名义回灌模型）。
 * #77 normalizeTarget：floor3/floorXZ 不校验分量 ⇒ {x:'a'} 得到 NaN 且判为合法，
 *     下游 path_3d 报 NO_START/NO_PATH，把**传参错误**伪装成**寻路失败**。
 *
 * 输出：PASS / FAIL，全过退出码 0。
 */
import assert from 'node:assert';
import { truncate, normalizeTarget } from '../src/agent/library/contract.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); pass++; console.log(`PASS ${name}`); }
    catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
};

const pad = (n) => 'x'.repeat(n);

// ════════════════════════════════════════════════════════════════════════
// #76：字符上限是**硬**上限，行裁剪之后必须再裁字符
// ════════════════════════════════════════════════════════════════════════
t('#76 既超行又超字符时，输出仍不超过 maxChars', () => {
    const big = Array.from({ length: 100 }, (_, i) => `line${i}:${pad(5000)}`).join('\n');
    assert.ok(big.length > 250000, '夹具本身要够大');
    const out = truncate(big);
    assert.ok(out.length <= 6000, `输出 ${out.length} 字符，超过 6000（#76 原样复现）`);
});

t('#76 双超时"省略多少行"这条信息不能丢', () => {
    const big = Array.from({ length: 100 }, (_, i) => `line${i}:${pad(5000)}`).join('\n');
    const out = truncate(big);
    assert.ok(out.includes('省略'), '应保留"省略"提示');
    assert.ok(out.includes('100 行'), '应保留总行数');
    assert.ok(out.includes('已截断') || out.includes('截断'), '应说明按字符截断');
});

t('#76 只超行不超字符时，只做行裁剪（不应出现字符截断提示）', () => {
    const many = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
    assert.ok(many.length < 6000, '夹具不能超字符');
    const out = truncate(many);
    assert.ok(out.includes('省略'), '应有省略提示');
    assert.ok(!out.includes('已截断'), '不该走字符裁剪分支');
});

t('#76 只超字符不超行时，仍按字符截断', () => {
    const out = truncate(pad(9000));
    assert.ok(out.length <= 6000, `输出 ${out.length}`);
    assert.ok(out.includes('已截断'), '应有字符截断提示');
});

t('#76 未超限的短文本原样返回', () => {
    assert.strictEqual(truncate('abc'), 'abc');
    assert.strictEqual(truncate(''), '');
});

// ════════════════════════════════════════════════════════════════════════
// #77：非法坐标必须返回 null，不能变成 NaN 继续往下走
// ════════════════════════════════════════════════════════════════════════
t('#77 分量是字符串时 normalizeTarget 返回 null（原来是 NaN 且判合法）', () => {
    assert.strictEqual(normalizeTarget({ kind: 'block', pos: { x: 'a', y: 2, z: 3 } }), null);
});

t('#77 分量是 NaN 时返回 null', () => {
    assert.strictEqual(normalizeTarget({ kind: 'block', pos: { x: NaN, y: 2, z: 3 } }), null);
});

t('#77 分量缺失（undefined）时返回 null', () => {
    assert.strictEqual(normalizeTarget({ kind: 'block', pos: { x: 1, y: undefined, z: 3 } }), null);
});

t('#77 分量是 Infinity 时返回 null', () => {
    assert.strictEqual(normalizeTarget({ kind: 'block', pos: { x: Infinity, y: 2, z: 3 } }), null);
});

t('#77 posXZ 分量非法时返回 null', () => {
    assert.strictEqual(normalizeTarget({ kind: 'point', posXZ: { x: 'a', z: 3 } }), null);
});

t('#77 合法坐标仍然向下取整（行为不变）', () => {
    assert.deepStrictEqual(
        normalizeTarget({ kind: 'block', pos: { x: 1.7, y: 2.9, z: -3.2 } }).pos,
        { x: 1, y: 2, z: -4 },
    );
});

t('#77 合法 posXZ 仍然向下取整', () => {
    assert.deepStrictEqual(
        normalizeTarget({ kind: 'point', posXZ: { x: 1.5, z: 3.7 } }).posXZ,
        { x: 1, z: 3 },
    );
});

t('#77 数字字符串仍可接受（Number() 归一化，不误伤 "12" 这类输入）', () => {
    assert.deepStrictEqual(
        normalizeTarget({ kind: 'block', pos: { x: '12', y: '64', z: '-3' } }).pos,
        { x: 12, y: 64, z: -3 },
    );
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
