// B6 验收：max_messages 是否真的在裁剪上下文。
// 不连服务器：用假的 agent 直接喂 History.add。
import { History } from '../src/agent/history.js';
import settings from '../src/agent/settings.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const fakeAgent = {
    name: 'testbot2',
    self_prompter: { state: 'idle', isStopped: () => true, prompt: null },
    task: { taskStartTime: 0 },
    last_sender: 'player',
    memory_bank: { getJson: () => ({}) },
    prompter: { promptMemSaving: async () => 'summary' },
};

const h = new History(fakeAgent);
h.appendFullHistory = async () => { };   // 不写盘

const N = 100;
let maxSeen = 0;
for (let i = 0; i < N; i++) {
    await h.add(i % 2 ? 'player' : 'system', `消息 ${i}`);
    maxSeen = Math.max(maxSeen, h.turns.length);
}

const LIMIT = Number.isFinite(settings.max_messages) && settings.max_messages > 0 ? settings.max_messages : 30;
check(`喂 ${N} 条后 turns 不超过 max_messages(${LIMIT})`,
    maxSeen <= LIMIT + 1, `峰值 ${maxSeen} 条，当前 ${h.turns.length} 条`);
check('裁剪时从头部摘（保留最近的）',
    h.turns.length > 0 && String(h.turns[h.turns.length - 1].content).includes('消息 99'),
    `最后一条: ${String(h.turns[h.turns.length - 1].content).slice(0, 40)}`);
check('裁剪触发了记忆摘要', typeof h.memory === 'string' && h.memory.length > 0, `memory="${h.memory}"`);

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
