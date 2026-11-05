import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });
const ev = [];
let latest = null;
s.on('connect', () => s.emit('listen-to-agents'));
s.on('bot-output', (n, m) => console.log('  [out]', String(m).slice(0, 180)));
s.on('agent-event', (n, e) => { ev.push(e); });
s.on('state-update', (st) => { if (st?.deepseek) latest = st.deepseek; });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 20 && !latest; i++) await sleep(500);
console.log('起点:', JSON.stringify(latest?.gameplay?.position));

async function cmd(c, ms = 20000) {
    console.log(`\n>>> ${c}`);
    const t0 = Date.now();
    s.emit('send-message', 'deepseek', { from: 'ADMIN', message: c });
    const evN = ev.length;
    while (Date.now() - t0 < ms) {
        await sleep(1000);
        const a = latest?.action?.current || '';
        if (a && a !== 'Stopped' && a !== '') {
            console.log('  action:', a);
        }
        if (Date.now() - t0 > 8000 && ev.length === evN && a === 'Stopped') break;
    }
    console.log(`  新事件 ${ev.length - evN} 条, 位置=${JSON.stringify(latest?.gameplay?.position)}`);
}

await cmd("!collectBlocks(oak_log, 2)", 12000);
await cmd("!collectBlocks(木头, 2)", 12000);
await cmd('!walkTo(-60, -190)', 60000);

const byType = {}; for (const e of ev) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('\n事件类型汇总:', JSON.stringify(byType));
for (const e of ev.slice(0, 20)) console.log('  #' + e.seq, e.type, JSON.stringify(e).slice(0, 130));
process.exit(0);
