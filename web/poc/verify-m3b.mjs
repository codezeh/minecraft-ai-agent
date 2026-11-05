// 用"游戏内真实状态 + 事件流"验证命令与事件链路（不依赖日志文件，日志有重定向缓冲）
import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });
const live = [];
let latest = null;

s.on('connect', () => s.emit('listen-to-agents'));
s.on('agent-event', (n, e) => live.push(e));
s.on('state-update', (st) => { if (st?.deepseek) latest = st.deepseek; });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const wood = (st) => {
    const c = st?.inventory?.counts || {};
    return Object.entries(c)
        .filter(([k]) => /log|wood/i.test(k))
        .reduce((a, [, v]) => a + v, 0);
};

for (let i = 0; i < 20 && !latest; i++) await sleep(500);
console.log('初始: action=' + latest?.action?.current + ' 木头=' + wood(latest) + ' 背包=' + latest?.inventory?.stacksUsed + '格');

const before = wood(latest);
const evBefore = live.length;

console.log("\n派活: !collectBlocks('木头', 2)");
s.emit('send-message', 'deepseek', { from: 'ADMIN', message: "!collectBlocks('木头', 2)" });

for (let i = 0; i < 24; i++) {
    await sleep(3000);
    const w = wood(latest);
    const act = latest?.action?.current || '(空)';
    console.log(`+${(i + 1) * 3}s  action=${act.padEnd(20)} 木头=${w} 事件累计=${live.length}`);
    if (w >= before + 2) { console.log('\n✓ 木头到手，命令确实执行了'); break; }
}

console.log(`\n事件：连上后新增 ${live.length - evBefore} 条`);
const byType = {};
for (const e of live) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('类型分布:', JSON.stringify(byType));
for (const e of live.slice(0, 15)) console.log('  #' + e.seq, e.type, JSON.stringify(e).slice(0, 120));

// 再用 ack 拉一次历史，确认仓库与推送一致
const hist = await new Promise((resolve) => s.emit('get-events', 'deepseek', 0, resolve));
console.log(`\nget-events 历史条数=${hist?.events?.length} stats=${JSON.stringify(hist?.stats)}`);
process.exit(0);
