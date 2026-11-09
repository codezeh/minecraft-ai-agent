/**
 * t-r5-2 —— 「截断代码假成功」
 *
 * 断言（缺陷形态）：prompter 在**代码生成被输出额度截断**时返回的兜底串自带三反引号
 *   （老实现：'```//no response (truncated)```'），coder 只要 `res.indexOf('```') !== -1`
 *   就判"模型写了代码"，把抽出来的 `//no response (truncated)`（一行注释）当代码
 *   **执行并记账成功** ⇒ 一次截断 = 一次"什么都没做却报成功"的动作。
 *
 * 判定方式（不靠读码，靠跑）：把 Coder 的**副作用边界**（_stageCode / _lintCode）
 *   换成记录器（mock 边界，不改被测逻辑）：
 *     · 若 `_stageCode` 收到 `//no response (truncated)` 且 generateCode 返回"成功摘要"
 *       → 缺陷复现，退出码 0；
 *     · 若从头到尾没有东西被送进执行路径 → 缺陷未复现，退出码 1。
 *
 * 用法：
 *   node docs/audit-r5/evidence/runtime/probes/t-r5-2.mjs                 # 当前工作树
 *   R5_SRC=<pre-fix>/src node .../t-r5-2.mjs                              # 对照组（历史版本）
 * 退出码：0=缺陷复现，1=未复现。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = path.resolve(HERE, '../../../../../mindcraft/src');
const SRC = path.resolve(process.env.R5_SRC || DEFAULT_SRC);

const say = (...a) => console.log('[t-r5-2]', ...a);

// ── 被测模块 ────────────────────────────────────────────────────────────────
const coderUrl = pathToFileURL(path.join(SRC, 'agent/coder.js')).href;
let Coder;
try {
    ({ Coder } = await import(coderUrl));
} catch (e) {
    console.error('[t-r5-2] CANNOT-RUN：导入 coder.js 失败：', e?.message ?? e);
    process.exit(2);
}

/** prompter 桩：模拟"代码生成被截断"的老兜底串。两条 API 都提供（老树是字符串 API）。 */
const TRUNCATED_FALLBACK = '```//no response (truncated)```';
const fakePrompter = {
    // 新 API（结果类型）
    async promptCodingResult() {
        return {
            status: 'truncated', content: TRUNCATED_FALLBACK, hasContent: true,
            failed: false, truncated: true, errorCode: null, errorMessage: null,
            toString() { return TRUNCATED_FALLBACK; },
        };
    },
    // 老 API（字符串）
    async promptCoding() { return TRUNCATED_FALLBACK; },
    skill_libary: { getAllSkillDocs: async () => [] },
};

const executed = [];
const agent = {
    name: 'probe2',
    prompter: fakePrompter,
    bot: { interrupt_code: false, modes: { pause() {} } },
    actions: { getBotOutputSummary: () => '' },
    history: { getHistory: () => [], memory: '' },
};

// ── 驱动 ────────────────────────────────────────────────────────────────────
// coder.js 的构造函数会同步去读 bots/*Template.js 并 mkdir；我们只替换下游副作用边界。
const coder = new Coder(agent);
coder._stageCode = async (code) => {
    executed.push(String(code));
    say('!! _stageCode 被调用，收到的"代码"：', JSON.stringify(String(code)));
    return { func: { main: async () => {} }, src: '', src_lint_copy: '' };
};
coder._lintCode = async () => null;

let out;
try {
    out = await coder.generateCode({ getHistory: () => [] });
} catch (e) {
    say('generateCode 抛错（按"没写代码"路径之外的情况处理）：', e?.message ?? e);
    out = null;
}

const summary = typeof out === 'string' ? out : (out == null ? 'null' : JSON.stringify(out));
say('generateCode 返回：', summary.slice(0, 200).replace(/\n/g, '\\n'));
say('进入执行路径的次数：', executed.length, executed.length ? JSON.stringify(executed) : '');

const falseSuccess = executed.length > 0
    && executed.some((c) => String(c).trim() === '//no response (truncated)');
const reportedSuccess = typeof out === 'string' && /Agent wrote this code/i.test(out);

if (falseSuccess || reportedSuccess) {
    say('REPRODUCED：截断兜底串被判成"有代码"，注释被当代码送进执行路径'
        + `（执行 ${executed.length} 次，返回 ${reportedSuccess ? '成功摘要' : '非成功摘要'}）`);
    process.exit(0);
}
say('NOT-REPRODUCED：截断兜底串没有进入执行路径（没有任何东西被当成代码执行）');
process.exit(1);
