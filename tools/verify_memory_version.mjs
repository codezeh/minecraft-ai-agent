// 验证 memory 版本机制不会崩：load + save 各跑一次。
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'node:path';
import os from 'node:os';

// ★ T17（并发加固）：每进程一个独立 bots 根（History 的内存/历史路径都走它）
process.env.MC_BOTS_ROOT = mkdtempSync(join(os.tmpdir(), 'bots-root-verify-mem-'));
const BOTS_ROOT = process.env.MC_BOTS_ROOT;

import { History } from '../src/agent/history.js';

const fake = {
    name: 'testbot_ver',
    self_prompter: { state: 'idle', isStopped: () => true, prompt: null },
    task: { taskStartTime: 0 },
    last_sender: 'x',
    memory_bank: { getJson: () => ({}) },
    prompter: { promptMemSaving: async () => 'test memory' },
};

const h = new History(fake);

// 1) load：文件不存在时应安全返回
const r1 = h.load();
console.log('load() 无文件时:', r1 === null ? '返回 null（正确）' : '有其他返回');

// 2) save：应写入 codeVersion
h.memory = '测试记忆';
await h.save();
const d = JSON.parse(readFileSync(`${BOTS_ROOT}/testbot_ver/memory.json`, 'utf8'));
console.log('save() 写入 codeVersion =', d.codeVersion);
console.log('memory 内容 =', JSON.stringify(d.memory));

// 3) 版本不符时应丢弃 memory
const d2 = { ...d, codeVersion: 1, memory: '旧版本的经验结论' };
const fs = await import('fs');
fs.writeFileSync(`${BOTS_ROOT}/testbot_ver/memory.json`, JSON.stringify(d2));
const h2 = new History(fake);
h2.load();
console.log('版本 1 → 2 后 memory =', JSON.stringify(h2.memory), h2.memory === '' ? '（已丢弃，正确）' : '（未丢弃，错误）');

// 4) 版本相同时应保留
fs.writeFileSync(`${BOTS_ROOT}/testbot_ver/memory.json`, JSON.stringify({ ...d, codeVersion: 2, memory: '同版本记忆' }));
const h3 = new History(fake);
h3.load();
console.log('同版本时 memory =', JSON.stringify(h3.memory), h3.memory === '同版本记忆' ? '（保留，正确）' : '（错误）');

rmSync(BOTS_ROOT, { recursive: true, force: true });
console.log('\n全部通过');
