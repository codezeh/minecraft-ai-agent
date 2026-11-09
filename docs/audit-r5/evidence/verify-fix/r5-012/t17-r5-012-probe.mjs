/**
 * t17 独立探针 —— R5-012（err.stack 恒 undefined）
 *
 * 立场：**不采信实现者的探针**（不用 tools/fix_r5_012_unit.mjs），
 * 走**产品代码的真实路径**：`ActionManager.runAction(label, actionFn)`，
 * 让 actionFn 抛异常，读它返回的 message。
 *
 * 断言（全部必须成立，否则 exit 1）：
 *   1. message 含 `Stack trace:` 后面**跟着真实帧**（不是 undefined）
 *   2. message **不含** `undefined`
 *   3. message **不含** `Error: Error:`（双前缀）
 *   4. message 含原始错误文本（证明 message 没丢）
 *   5. message 里能匹配到本探针的栈帧（`t17-r5-012-probe`）——证明 stack 是这次异常的，不是别处的残留
 *
 * 退出码：0 = 修复有效；1 = 缺陷仍在（或断言失败）。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.R5_SRC || 'E:/我的世界ai/mindcraft/src';

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' —— ' + detail : ''}`);
};

let ActionManager;
try {
    ({ ActionManager } = await import(pathToFileURL(path.join(SRC, 'agent/action_manager.js')).href));
} catch (e) {
    console.error('CANNOT-RUN：导入失败：', e?.message ?? e);
    process.exit(2);
}

// 最小假 agent：只提供 catch 块会用到的形状
const bot = {
    interrupt_code: false,
    output: 'probe output\n',
    listeners: () => [],
    emit: () => true,
    lastFailure: null,
};
const agent = {
    bot,
    actions: { stop_reason: null },
    clearBotLogs: () => {},
    self_prompter: { isRunning: () => false, stop: () => {} },
};

const am = new ActionManager(agent);

// 让 catch 块里的 this.stop() 立刻返回：把 stopWaitMs 设小 + 非 executing
am.stopWaitMs = 1;

let message = null;
try {
    const ret = await am.runAction('t17-probe', async () => {
        // 故意抛一个带独特标记的异常
        throw new Error('t17-r5-012-boom-marker');
    }, { timeout: 5000 });
    message = ret?.message ?? '';
    check('runAction 返回了 message', typeof message === 'string' && message.length > 0, `len=${message?.length}`);
} catch (e) {
    check('runAction 不向调用方抛异常', false, String(e?.message ?? e).slice(0, 200));
}

const msg = String(message ?? '');
console.log('--- message 原文（JSON，保留换行）---');
console.log(JSON.stringify(msg));
console.log('--- 分割显示 ---');

const stackPart = msg.includes('Stack trace:') ? msg.slice(msg.indexOf('Stack trace:') + 'Stack trace:'.length) : '';
const stackLines = stackPart.split('\n').map((s) => s.trim()).filter(Boolean);
const hasRealFrame = stackLines.some((l) => /^\s*at\s+/.test(l) || /:\d+:\d+/.test(l));

check('1. Stack trace 后有真实帧', hasRealFrame, `帧数=${stackLines.length}，首行=${stackLines[0] ?? '(空)'}`);
check('2. message 不含 undefined', !/\bundefined\b/.test(msg), `命中=${(msg.match(/\bundefined\b/g) || []).length}`);
check('3. message 不含双前缀 Error: Error:', !msg.includes('Error: Error:'), '');
check('4. message 含原始错误文本', msg.includes('t17-r5-012-boom-marker'), '');
check('5. stack 里有本探针的帧（同一异常）', /t17-r5-012-probe\.mjs/.test(msg), '');

const bad = results.filter((r) => !r.ok);
console.log(`\n=== 小计：PASS ${results.length - bad.length} / ${results.length}，FAIL ${bad.length} ===`);
process.exit(bad.length ? 1 : 0);
