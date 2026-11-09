/**
 * t-r5-9 —— 「截断的摘要覆盖 memory.json」
 *
 * 缺陷形态（老实现）：`promptMemSaving()` 在摘要被输出额度截断时
 *   **剥掉内部标记后照旧返回**半截摘要，`summarizeMemories()` 直接 `this.memory = 返回值`
 *   ⇒ 半截摘要覆盖长期记忆，而 memory.json 跨重启存活 = 一次覆盖永久降级，
 *   且这一批 turns 已被 splice 掉，没有重来的机会。
 *
 * 判定方式（不靠读码，靠跑）：memory 先置 'OLD-SUMMARY'，用"返回被截断摘要"的 prompter 桩
 *   调 summarizeMemories()，然后看 memory 有没有被半截内容顶掉：
 *     · memory 变成半截摘要 → 缺陷复现，退出码 0；
 *     · memory 仍是 'OLD-SUMMARY' → 未复现，退出码 1。
 *
 * 测试桩同时提供新 API（promptMemSavingResult，结果类型）与老 API（promptMemSaving，字符串），
 * 两份历史代码都能驱动。
 *
 * 用法：node .../t-r5-9.mjs ；R5_SRC=<pre-fix>/src node .../t-r5-9.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.R5_SRC || path.resolve(HERE, '../../../../../mindcraft/src'));
const say = (...a) => console.log('[t-r5-9]', ...a);

process.env.MC_BOTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-t9-'));

let History, shared;
try {
    ({ History } = await import(pathToFileURL(path.join(SRC, 'agent/history.js')).href));
    shared = await import(pathToFileURL(path.join(SRC, 'models/_shared.js')).href);
} catch (e) {
    console.error('[t-r5-9] CANNOT-RUN：导入失败：', e?.message ?? e);
    process.exit(2);
}

const HALF = '半截摘要：她当时正在往（此处被输出额度截断';
const OLD = 'OLD-SUMMARY';

/** 带截断标记的老式返回值（老 prompter 就是这么返回的）。 */
const truncatedString = shared?.markTruncated ? shared.markTruncated(HALF) : `${HALF}[LLM_TRUNCATED]`;

const prompter = {
    last_memory_summary_truncated: false,
    // 新 API：明确 status=truncated
    async promptMemSavingResult() {
        this.last_memory_summary_truncated = true;
        return {
            status: 'truncated', truncated: true, failed: false, hasContent: true,
            content: HALF, errorCode: null, errorMessage: null,
            toString: () => HALF,
        };
    },
    // 老 API：字符串 + 标记
    async promptMemSaving() { return truncatedString; },
};

const agent = {
    name: 'probe9',
    prompter,
    memory_bank: { getJson: () => ({}) },
    self_prompter: { state: 0, isStopped: () => true, isActive: () => false, prompt: null, author: null },
    task: { taskStartTime: 0 },
    last_sender: null,
};

const history = new History(agent);
history.memory = OLD;

const chunk = [{ role: 'user', content: '玩家：帮我挖点木头' }];
try {
    await history.summarizeMemories(chunk);
} catch (e) {
    console.error('[t-r5-9] CANNOT-RUN：summarizeMemories 抛错：', e?.message ?? e);
    process.exit(2);
}

const after = String(history.memory ?? '');
say('调用前 memory =', JSON.stringify(OLD));
say('调用后 memory =', JSON.stringify(after.slice(0, 120)));

const overwritten = after !== OLD;
if (overwritten) {
    say('REPRODUCED：截断的摘要覆盖了长期记忆（OLD-SUMMARY 被半截内容顶掉，memory.json 已被污染）');
    process.exit(0);
}
say('NOT-REPRODUCED：截断的摘要没有覆盖长期记忆（保留旧摘要）');
process.exit(1);
