/**
 * 探针 a：src/agent/library/flow_craft.js:415 `no-dupe-keys` Duplicate key 'count'
 *
 * 复刻该处对象字面量的**键序**：
 *     return ok({ craftedItem, count: produced, ..., ...(lastData ?? {}), count: produced })
 *
 * 要证明两件事：
 *   ① JS 对象字面量里同名键**后者覆盖前者**，且中间的 spread 也可能塞进同名键；
 *   ② 因此末尾那个 `count: produced` 确实是"压住"语义，不是笔误。
 *
 * 退出码：0 = 缺陷成立；1 = 不成立（本探针预期 1）
 */
const produced = 3;                 // 本层真实产出数
const lastData = { count: 999, invAfter: ['log'], limitUsed: false };  // 底层 craftOnce 的 data

// —— 与源码 415 行完全一致的键序 ——
const result = {
    craftedItem: 'oak_planks',
    count: produced,
    want: 3,
    got: produced,
    usedTable: false,
    placedTable: null,
    costMs: 12,
    jobId: 'job-1',
    ...(lastData ?? {}),        // 底层诊断：可能带来自己的 count
    count: produced,            // 本层语义压最后
};

console.log('lastData.count            =', lastData.count);
console.log('result.count              =', result.count);
console.log('result.got                =', result.got);
console.log('result.invAfter           =', JSON.stringify(result.invAfter), '(spread 带来的诊断字段仍在)');

let bad = 0;
if (result.count !== produced) { console.log('!! count 没有被压住，被 spread 覆盖了'); bad++; }
if (!Array.isArray(result.invAfter)) { console.log('!! spread 的诊断字段丢了'); bad++; }

// 反证：把末尾那行删掉会怎样（说明它不是冗余）
const withoutLast = { count: produced, ...(lastData ?? {}) };
console.log('若删掉末尾 count 行 → count =', withoutLast.count, '（错误的产出数）');
if (withoutLast.count === produced) { console.log('!! 反证失败：spread 不会带来 count'); bad++; }

// 再看对象字面量重复键的纯粹语义
const pure = { k: 1, k: 2 };
console.log('字面量重复键 { k:1, k:2 } →', pure.k, '（后者胜）');

if (bad === 0) {
    console.log('\nVERDICT: FALSE-POSITIVE —— 重复键是**故意**的"压住"写法，语义正确（无缺陷）');
    process.exit(1);   // 1 = 缺陷不成立
} else {
    console.log('\nVERDICT: REAL-DEFECT');
    process.exit(0);
}
