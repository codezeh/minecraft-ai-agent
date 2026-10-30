// B6 验收：memory.json 20 KB 硬上限。
// 用真实的 History 类（不连服务器）验证 capSize 行为。
import { History } from '../src/agent/history.js';
import { readFileSync } from 'fs';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const real = JSON.parse(readFileSync('./bots/deepseek/memory.json', 'utf8'));
const fakeAgent = { name: 'testbot', self_prompter: { state: 'idle', isStopped: () => true, prompt: null }, task: { taskStartTime: 0 }, last_sender: 'x', memory_bank: { getJson: () => ({}) } };
const h = new History(fakeAgent);

const longTurn = (n) => ({ role: 'system', content: 'x'.repeat(n) });
const mkData = (turns, memory = 'm'.repeat(200)) => ({ memory, turns, memory_bank: {}, self_prompt: null, self_prompting_state: 'idle', taskStart: 0, last_sender: 'x' });

// 1) 未超限：原样返回
const small = mkData([longTurn(50), longTurn(50)]);
const s1 = h.capSize(small);
check('未超 20KB 时原样保留', JSON.stringify(s1).length === JSON.stringify(small).length,
    `${JSON.stringify(s1).length} bytes`);

// 2) 大量超长 turns：裁到 20KB 以内
const big = mkData(Array.from({ length: 40 }, () => longTurn(2000)));
const s2 = h.capSize(big);
const size2 = JSON.stringify(s2, null, 2).length;
check('40 条 × 2000 字符 → 裁到 20KB 内', size2 <= 20 * 1024, `${size2} bytes, 保留 ${s2.turns.length} 条`);

// 3) 至少保留 6 条（上下文连贯）
check('至少保留 6 条 turn', s2.turns.length >= 6, `${s2.turns.length} 条`);

// 4) 保留的是「最近的」：最后一条内容应与输入最后一条一致
const tail = big.turns[big.turns.length - 1];
check('保留最新的 turn（不是最旧的）', s2.turns[s2.turns.length - 1].content === tail.content);

// 5) memory 文本超长会被截断
const m = h.capSize(mkData([longTurn(50)], 'y'.repeat(10000)));
check('memory 文本超 4000 字符会被截断', m.memory.length < 4200, `${m.memory.length} 字符`);

// 6) 真实 memory 文件当前不超过 20KB
const realSize = JSON.stringify(real, null, 2).length;
check('当前真实 memory.json < 20KB', realSize < 20 * 1024, `${(realSize / 1024).toFixed(1)} KB`);

// 7) 真实文件经过 capSize 不丢关键字段
const capped = h.capSize(real);
check('capSize 保留 memory_bank / memory / turns',
    capped.memory_bank !== undefined && typeof capped.memory === 'string' && Array.isArray(capped.turns));

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
