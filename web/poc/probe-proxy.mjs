// 验证 vite 5173 的 socket.io 代理——浏览器实际走的就是这条路
import { io } from 'socket.io-client';

const s = io('http://localhost:5173', { path: '/socket.io' });

let ok = false;
s.on('connect', () => {
    console.log('✓ 通过 5173 代理连上 socket.io，transport =', s.io.engine.transport.name);
    s.emit('listen-to-agents');
});
s.on('connect_error', (e) => console.log('✗ 代理连接失败:', e.message));
s.on('agents-status', (a) => {
    console.log('✓ agents-status:', JSON.stringify(a));
    ok = true;
});
s.on('state-update', (st) => {
    const n = Object.keys(st || {});
    if (n.length) {
        const p = st[n[0]].gameplay.position;
        console.log(`✓ state-update: ${n[0]} pos=(${p.x}, ${p.y}, ${p.z})`);
        console.log(ok ? '\n=== 浏览器通路完全可用 ===' : '');
        s.close();
        process.exit(0);
    }
});
setTimeout(() => {
    console.log('超时：没收到 state-update（panel 会显示空态）');
    process.exit(1);
}, 12000);
