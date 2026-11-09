/**
 * 探针 c：src/agent/action_manager.js:422 `no-ex-assign`
 *   catch (err) { ... await this.stop(...); err = err.toString();
 *                 let message = ... 'Stack trace:\n' + err.stack + '\n'; ... }
 *
 * 疑点：err 在第 422 行被换成**字符串**，第 427 行却还去读 `err.stack`。
 *       字符串没有 .stack ⇒ 结果里会出现字面量 "undefined"。
 *
 * 复刻 catch 块 417-434 行的真实语句序（逐行对应源码），用一个真 Error 触发。
 * 退出码：0 = 缺陷成立；1 = 不成立
 */
const src = await import('node:fs').then(m => m.readFileSync(
    'E:/我的世界ai/mindcraft/src/agent/action_manager.js', 'utf8'));

// —— 先做静态校验：确认源码里确实是"先 toString、后读 .stack" ——
const iAssign = src.indexOf('err = err.toString();');
const iStack = src.indexOf("'Stack trace:\\n' + err.stack");
const staticOk = iAssign > 0 && iStack > iAssign;
console.log('[静态] `err = err.toString()` 出现在源码位置', iAssign);
console.log('[静态] `+ err.stack`                出现在源码位置', iStack);
console.log('[静态] toString 在读取 .stack 之前：', staticOk ? '是（符合疑点）' : '否');

// —— 运行时复刻同一条路径 ——
function runCatchBody() {
    const err0 = new Error('boom-from-action');
    let err = err0;
    // ↓ 422 行：把异常对象换成字符串
    err = err.toString();
    // ↓ 424-427 行：拼给模型/用户看的失败消息
    const message = '!!Code threw exception!!\n' +
        'Error: ' + err + '\n' +
        'Stack trace:\n' + err.stack + '\n';
    return { message, stackType: typeof err.stack };
}

const { message, stackType } = runCatchBody();
console.log('\n[运行时] err = err.toString() 之后，typeof err.stack =', stackType);
console.log('[运行时] 生成的 message 末尾：');
console.log('-----------');
console.log(message.trimEnd());
console.log('-----------');

const lostStack = message.includes('Stack trace:\nundefined');
console.log('\n消息里是否出现字面量 "Stack trace:\\nundefined"：', lostStack);

if (staticOk && lostStack) {
    console.log('\nVERDICT: REAL-DEFECT —— 第 422 行把 err 换成字符串后，第 427 行的 err.stack 恒为 undefined，');
    console.log('         失败消息里的堆栈**永久丢失**（只剩 console.error 那两行在终端里）。');
    process.exit(0);
} else {
    console.log('\nVERDICT: 不成立');
    process.exit(1);
}
