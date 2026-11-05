// 用 bot-output 观察命令执行结果（不受日志文件缓冲影响）+ 观察事件流
import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });
const out = [];
const ev = [];
let latest = null;

s.on('connect', () => s.emit('listen-to-agents'));
s.on('bot-output', (n, m) => { out.push(m); console.log('  [bot-output]', String(m).slice(0, 200)); });
s.on('agent-event', (n, e) => { ev.push(e); console.log('  [event]', e.type, JSON.stringify(e).slice(0, 140)); });
s.on('state-update', (st) => { if (st?.deepseek) latest = st.deepseek; });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 20 && !latest; i++) await sleep(500);

async function tryCmd(cmd, waitMs = 25000) {
    console.log(`\n>>> ${cmd}`);
    const outN = out.length, evN = ev.length;
    s.emit('send-message', 'deepseek', { from: 'ADMIN', message: cmd });
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
        await sleep(1000);
        if (out.length > outN || ev.length > evN) {
            if (Date.now() - t0 > 6000) break;
        }
        if (latest?.action?.current && latest.action.current !== 'Stopped') {
            console.log('  action 已变:', latest.action.current);
            break;
        }
    }
    console.log(`  结果: 新输出 ${out.length - outN} 条, 新事件 ${ev.length - evN} 条, action=${latest?.action?.current}`);
}

await tryCmd('!stop');
await tryCmd('!walkTo(-80, -204)');
await tryCmd("!collectBlocks('木头', 2)");

console.log('\n=== 汇总 ===');
console.log('输出条数:', out.length, '事件条数:', ev.length);
const byType = {}; for (const e of ev) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('事件类型:', JSON.stringify(byType));
process.exit(0);
