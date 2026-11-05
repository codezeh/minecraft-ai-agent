// 端到端验证：连 mindserver，确认 bot 在线、有实时状态、3D 地形接口通
import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });
let got = false;

s.on('connect', () => {
    console.log('connected');
    s.emit('listen-to-agents');
});

s.on('agents-status', (a) => console.log('agents-status:', JSON.stringify(a)));

s.on('state-update', (states) => {
    const names = Object.keys(states || {});
    if (!names.length || got) return;
    got = true;
    for (const n of names) {
        const st = states[n];
        console.log(`state[${n}]: pos=${JSON.stringify(st?.gameplay?.position)} hp=${st?.gameplay?.health} ` +
            `action=${st?.action?.current} facing=${st?.facing?.text} inv=${st?.inventory?.stacksUsed}格 ` +
            `nearby=${JSON.stringify(st?.nearby?.humanPlayers)}`);
    }
});

function callTerrain(opts, label) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        s.emit('request-terrain', 'deepseek', opts, (r) => {
            const ms = Date.now() - t0;
            if (r?.ok) {
                const kb = ((r.pos.length + r.types.length) / 1024).toFixed(0);
                console.log(`${label}: ok count=${r.count} dtype=${r.dtype} lod=${r.lod} ${kb}KB ` +
                    `bbox=${JSON.stringify(r.bbox)} fails=${r.fails?.length} 往返=${ms}ms 服务端=${r.ms}ms`);
            } else {
                console.log(`${label}: FAIL ${JSON.stringify(r)}`);
            }
            resolve();
        });
    });
}

setTimeout(async () => {
    console.log('\n--- 3D 地形接口 ---');
    await callTerrain({ mode: 'around', radius: 48, lod: 2 }, 'around r=48 lod=2');
    await callTerrain({ mode: 'full', lod: 2 }, 'full lod=2');
    await callTerrain({ mode: 'full', lod: 1 }, 'full lod=1');

    console.log('\n--- 2D 地图接口（旧通路）---');
    s.emit('request-map', 'deepseek', { radius: 32 }, (r) => {
        console.log('request-map:', r?.ok ? `ok blockSize=${r.blockSize} extent=${JSON.stringify(r.extent)} ascii长度=${r.ascii?.length}` : 'FAIL ' + JSON.stringify(r));
        process.exit(0);
    });
}, 6000);
