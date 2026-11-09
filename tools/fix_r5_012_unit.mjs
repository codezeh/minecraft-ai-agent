/**
 * R5-012 验收单测（2026-11-08）—— 失败消息里的 `Stack trace` 必须是**真堆栈**。
 *
 * 缺陷原貌（`src/agent/action_manager.js` catch 块）：
 *     err = err.toString();                        // ← err 从 Error 变成字符串
 *     let message = ... 'Error: ' + err + '\n'
 *                       'Stack trace:\n' + err.stack + '\n';   // ← 字符串没有 .stack
 * 后果：
 *   ① `Stack trace:` 后面**恒为字面量 undefined** —— 模型拿到的失败消息永久丢堆栈；
 *   ② `'Error: ' + err.toString()` 派生出 "Error: Error: boom" 的**双前缀**。
 *
 * 本测用**真实 ActionManager** + 假 agent/bot，让动作抛 new Error('boom-from-action')，
 * 直接断言返回值（不碰服务器、不挖方块）。四条验收 + 两条"没弄坏别的"：
 *   (a) message 含 'boom-from-action'
 *   (b) message 含**真实 stack**（匹配 /at\s/，且含本文件/被测模块的文件名）
 *   (c) message **不含** 'undefined'
 *   (d) message **不含** 'Error: Error:'
 *   (e) 正常路径（不抛）行为不变：success=true、message 仍是 "Action output:\n..." 形态
 *   (f) 抛出**非 Error**（字符串）时不崩、且不会冒出 undefined
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { ActionManager } from '../src/agent/action_manager.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

/** 假 agent：只实现 ActionManager 真正会碰到的接口（同 bot002_action_start_unit 的口径）。 */
function makeAgent() {
    const bot = {
        interrupt_code: false,
        output: '',
        emit: () => {},
        clearControlStates: () => {},
        releaseAll: () => {},
        pathfinder: { stop: () => {} },
        stopDigging: () => {},
        pvp: { stop: () => {} },
    };
    return {
        name: 'tester',
        bot,
        history: { add: () => {} },
        clearBotLogs: () => { bot.interrupt_code = false; bot.output = ''; },
        requestInterrupt: () => { bot.interrupt_code = true; },
        cleanKill: () => {},
        isIdle: () => true,
        self_prompter: { isActive: () => false },
    };
}

/** 跑一个会抛异常的动作，返回 runAction 的结果。 */
async function runThrowing(errToThrow, label = 'action:probe') {
    const agent = makeAgent();
    agent.bot.output = 'some log line\n';
    const am = new ActionManager(agent);
    // 静音 catch 里的 console.error（那段是给终端/日志的，不是被测对象）
    const origError = console.error;
    console.error = () => {};
    try {
        return await am.runAction(label, () => { throw errToThrow; }, {});   // 同步抛 = 同样落进 catch；不加 async 免得触发 require-await
    } finally {
        console.error = origError;
    }
}

console.log('===== R5-012：失败消息必须带真堆栈 =====\n');

// ── 主用例：抛 new Error('boom-from-action') ────────────────────────────────
const r = await runThrowing(new Error('boom-from-action'));
console.log('--- 实际返回值 ---');
console.log('success =', r.success, '| interrupted =', r.interrupted, '| timedout =', r.timedout);
console.log('message ↓');
console.log(r.message);
console.log('--- message 结束 ---\n');

check('(a) message 含 boom-from-action', String(r.message).includes('boom-from-action'));
check('(b) message 含真实 stack（匹配 /at\\s/）', /at\s/.test(r.message),
    /at\s/.test(r.message) ? '（命中 at <frame>）' : '（没有堆栈帧）');
check('(b2) stack 里带得出被测模块/本文件名',
    /action_manager|fix[-_]r5[-_]012/i.test(r.message),
    (r.message.match(/([^\s()]*action_manager\.js[^\s)]*)/) || [])[1] ? '（' + (r.message.match(/([^\s()]*action_manager\.js[^\s)]*)/) || [])[1] + '）' : '');
check('(c) message 不含 undefined', !String(r.message).includes('undefined'),
    String(r.message).includes('undefined') ? `（…${String(r.message).match(/.{0,25}undefined.{0,25}/)?.[0]}…）` : '');
check('(d) message 不含 "Error: Error:"', !String(r.message).includes('Error: Error:'));
check('(d2) 失败标记与 error 行结构仍在',
    String(r.message).includes('!!Code threw exception!!') && String(r.message).includes('Error: boom-from-action'));
check('(d3) 返回值契约不变（success=false / interrupted=false / timedout=false）',
    r.success === false && r.interrupted === false && r.timedout === false);

// ── (e) 正常路径行为不变 ───────────────────────────────────────────────────
{
    const agent = makeAgent();
    const am = new ActionManager(agent);
    // 注意：runAction 开工前会 clearBotLogs()（把 bot.output 清空）—— 所以日志要在**动作执行期间**产生，
    // 这也正是生产的真实时序（bot 在跑的时候才往 bot.output 追加）。事前塞 output 会被清掉。
    const ok = await am.runAction('action:normal', () => {
        agent.bot.output = 'hello from action\n';
    }, {});
    console.log('\n--- 正常路径返回值 ---');
    console.log(JSON.stringify({ success: ok.success, message: ok.message, interrupted: ok.interrupted, timedout: ok.timedout }));
    check('(e) 正常路径 success=true', ok.success === true);
    check('(e2) 正常路径 message 仍是 "Action output:\\n<原文>" 形态',
        ok.message === 'Action output:\nhello from action\n', JSON.stringify(ok.message));
    check('(e3) 正常路径不含堆栈字样', !String(ok.message).includes('Stack trace'));
}

// ── (f) 抛出非 Error：不许崩、不许冒 undefined ──────────────────────────────
{
    let crash = null, res = null;
    try { res = await runThrowing('just-a-string'); } catch (e) { crash = e; }
    console.log('\n--- 抛字符串时的返回值 ---');
    console.log(crash ? 'THREW: ' + crash.message : JSON.stringify({ success: res.success, tail: String(res.message).slice(-80) }));
    check('(f) 抛非 Error 不让 runAction 崩', crash === null);
    check('(f2) 抛非 Error 时 message 里仍不含 undefined',
        crash === null && !String(res.message).includes('undefined'));
    check('(f3) 抛非 Error 时仍带出原始信息', crash === null && String(res.message).includes('just-a-string'));
}

console.log('\n============================================');
console.log(`${pass} PASS / ${fail} FAIL`);
console.log('============================================');
if (fail === 0) {
    console.log('\nR5-012 修复验收通过：堆栈回来了、双前缀没了、正常路径与异常值形态都没坏。');
    process.exit(0);
} else {
    console.log('\nR5-012 未通过：见上面 FAIL 行。');
    process.exit(1);
}
