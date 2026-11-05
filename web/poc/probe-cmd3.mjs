import { io } from 'socket.io-client';
const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });
const ev = []; let latest = null;
s.on('connect', () => s.emit('listen-to-agents'));
s.on('bot-output', (n, m) => console.log('  [out]', String(m).slice(0, 200)));
s.on('agent-event', (n, e) => ev.push(e));
s.on('state-update', (st) => { if (st?.deepseek) latest = st.deepseek; });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 20 && !latest; i++) await sleep(500);
const wood = () => {
    const c = latest?.inventory?.counts || {};
    return Object.entries(c).filter(([k]) => /log|wood/i.test(k)).reduce((a, [, v]) => a + v, 0);
};
console.log('起点 木头=' + wood(), JSON.stringify(latest?.gameplay?.position));

console.log('\n>>> !collectBlocks("oak_log", 2)  ← 双引号');
const evN = ev.length;
s.emit('send-message', 'deepseek', { from: 'ADMIN', message: '!collectBlocks("oak_log", 2)' });
for (let i = 0; i < 30; i++) {
    await sleep(3000);
    console.log(`+${(i + 1) * 3}s action=${(latest?.action?.current || '').padEnd(18)} 木头=${wood()} 事件=${ev.length - evN}`);
    if (wood() >= 2) break;
    if (i > 3 && latest?.action?.current === 'Stopped' && ev.length === evN) { console.log('  （已停且无事件）'); break; }
}
const byType = {}; for (const e of ev) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('\n事件类型:', JSON.stringify(byType));
for (const e of ev.slice(0, 14)) console.log('  #' + e.seq, e.type, JSON.stringify(e).slice(0, 120));
process.exit(0);
