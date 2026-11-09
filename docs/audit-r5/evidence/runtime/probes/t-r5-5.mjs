/**
 * t-r5-5 —— 「memory_bank 保留方向相反：留最旧、丢最新」
 *
 * 缺陷形态（老实现）：`capSize()` 里 `keys.slice(0, MAX_BANK)` ——
 *   插入序在前 = **最旧**的 120 条留下，刚 `!rememberHere` 登记的地点/箱子最先被淘汰，
 *   模型于是"刚记住就忘"。
 *
 * 判定方式（不靠读码，靠跑）：塞 200 条 memory_bank（后插入的是最新的），
 *   调 History.save() 真写盘，再读回 memory.json 看**留下了谁**：
 *     · 最新的那条（place-199）没了、最旧的都在 → 缺陷复现，退出码 0；
 *     · 留下的是最新 120 条 → 未复现，退出码 1。
 *
 * 用法：node .../t-r5-5.mjs            （当前树）
 *       R5_SRC=<pre-fix>/src node .../t-r5-5.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.R5_SRC || path.resolve(HERE, '../../../../../mindcraft/src'));
const say = (...a) => console.log('[t-r5-5]', ...a);

// 独立 bots 根：绝不碰仓库里真实的 bots/<name>
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-t5-'));
process.env.MC_BOTS_ROOT = tmpRoot;

let History;
try {
    ({ History } = await import(pathToFileURL(path.join(SRC, 'agent/history.js')).href));
} catch (e) {
    console.error('[t-r5-5] CANNOT-RUN：导入 history.js 失败：', e?.message ?? e);
    process.exit(2);
}

const BANK_SIZE = 200;
const bank = {};
for (let i = 0; i < BANK_SIZE; i++) bank[`place-${i}`] = { x: i, y: 64, z: 0, note: `第 ${i} 个登记的地点` };

const agent = {
    name: 'probe5',
    memory_bank: { getJson: () => bank },
    self_prompter: { state: 0, isStopped: () => true, isActive: () => false, prompt: null, author: null },
    task: { taskStartTime: 0 },
    last_sender: null,
    prompter: {},
};

const history = new History(agent);
history.turns = [];
history.memory = '';
history.save();

const fp = history.memory_fp;
if (!fs.existsSync(fp)) {
    console.error('[t-r5-5] CANNOT-RUN：save() 没有写出 memory.json（' + fp + '）');
    process.exit(2);
}
const saved = JSON.parse(fs.readFileSync(fp, 'utf8'));
const kept = Object.keys(saved.memory_bank ?? {});
say('memory.json 路径：', fp);
say(`写入 ${BANK_SIZE} 条，写回后保留 ${kept.length} 条`);
say('保留的前 3 条：', kept.slice(0, 3).join(', '));
say('保留的后 3 条：', kept.slice(-3).join(', '));

const newestKept = kept.includes(`place-${BANK_SIZE - 1}`);
const oldestKept = kept.includes('place-0');
say('最新一条 place-' + (BANK_SIZE - 1) + ' 是否保留：', newestKept, '；最旧一条 place-0 是否保留：', oldestKept);

if (!newestKept && oldestKept) {
    say('REPRODUCED：保留方向相反 —— 留下的是最旧的一批，最新登记的地点被丢弃'
        + `（保留 ${kept.length} 条，place-${BANK_SIZE - 1} 丢失）`);
    process.exit(0);
}
say(`NOT-REPRODUCED：保留的是最新的一批（${kept.length} 条，最新一条保留=${newestKept}）`);
process.exit(1);
