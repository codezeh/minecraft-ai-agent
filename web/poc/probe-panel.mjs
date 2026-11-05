// 直连 mindserver 看它到底报了什么状态（等同面板启动时的握手）
import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });

s.on('connect', () => {
    console.log('connected to mindserver');
    s.emit('listen-to-agents');
});

s.on('agents-status', (agents) => {
    console.log('agents-status:', JSON.stringify(agents));
});

s.on('state-update', (states) => {
    const names = Object.keys(states);
    console.log('state-update agents:', names);
    for (const n of names) {
        const st = states[n];
        console.log(`  ${n}: pos=${JSON.stringify(st?.gameplay?.position)} action=${st?.action?.current}`);
    }
});

setTimeout(() => {
    console.log('--- 尝试 request-terrain（预期失败：bot 未 spawn） ---');
    s.emit('request-terrain', 'deepseek', { mode: 'full', lod: 2 }, (r) => {
        console.log('terrain result:', JSON.stringify(r).slice(0, 200));
        process.exit(0);
    });
}, 4000);
