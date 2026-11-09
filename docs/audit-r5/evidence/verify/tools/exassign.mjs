// 最小复刻：与 action_manager.js:422/427 完全相同的表达式序列
let err = new Error('boom-from-action');
err = err.toString();                       // ← 422
const message = '!!Code threw exception!!\n' + 'Error: ' + err + '\n' + 'Stack trace:\n' + err.stack + '\n';
console.log('--- message 原样 ---');
console.log(JSON.stringify(message));
console.log('--- err 类型 ---', typeof err);
console.log('--- err.stack ---', String(err.stack));
console.log('--- 结论 ---', err.stack === undefined ? 'STACK_IS_UNDEFINED (缺陷成立)' : 'stack 正常');
