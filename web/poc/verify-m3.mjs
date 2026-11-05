// M3 端到端验证：任务状态 / 记忆 / 事件流（含实时推送）
import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });
const live = [];

s.on('connect', () => { console.log('connected'); s.emit('listen-to-agents'); });
s.on('agent-event', (name, e) => { live.push(e); });

function ack(event, ...args) {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: '超时' }); } }, 16000);
        s.emit(event, ...args, (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); });
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await sleep(2500);

console.log('\n=== get-task-state ===');
const ts = await ack('get-task-state', 'deepseek');
console.log(JSON.stringify(ts, null, 2).slice(0, 900));

console.log('\n=== get-memory ===');
const mem = await ack('get-memory', 'deepseek');
console.log(`ok=${mem.ok} bytes=${mem.bytes} codeVersion=${mem.codeVersion} turns=${mem.turns}`);
console.log('memory 摘要:', (mem.memory || '').slice(0, 200).replace(/\n/g, ' '));

console.log('\n=== get-events（历史）===');
const ev = await ack('get-events', 'deepseek', 0);
console.log(`ok=${ev.ok} 条数=${ev.events?.length} stats=${JSON.stringify(ev.stats)}`);
for (const e of (ev.events || []).slice(-6)) console.log('  #' + e.seq, e.type, JSON.stringify(e).slice(0, 120));

// 触发真实动作 → 导航层会发 dig/plan/scan3d 等事件
console.log('\n=== 派活：!collectBlocks(木头, 3) ===');
s.emit('send-message', 'deepseek', { from: 'ADMIN', message: "!collectBlocks('木头', 3)" });

console.log('等 45s 收事件…');
await sleep(45000);

console.log(`\n=== 实时推送收到 ${live.length} 条 ===`);
const byType = {};
for (const e of live) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('类型分布:', JSON.stringify(byType));
for (const e of live.slice(0, 12)) console.log('  #' + e.seq, e.type, JSON.stringify(e).slice(0, 130));

console.log('\n=== 再拉一次历史（应包含刚才的）===');
const ev2 = await ack('get-events', 'deepseek', 0);
console.log(`历史条数=${ev2.events?.length}`);

process.exit(0);
