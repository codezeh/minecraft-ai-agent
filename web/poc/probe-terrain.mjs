// 聚焦探测 request-terrain：每次调用都带自己的超时，明确区分"没回调"和"回调失败"
import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });

let ready = false;

s.on('connect', () => {
    console.log('connected, emit listen-to-agents');
    s.emit('listen-to-agents');
    setTimeout(() => { ready = true; console.log('ready to probe'); }, 1500);
});

s.on('agents-status', (a) => console.log('agents-status:', JSON.stringify(a)));
s.on('disconnect', () => console.log('!! client disconnected'));

function probe(event, args, label, timeoutMs = 20000) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            console.log(`${label}: >>> 没有收到任何回调（${timeoutMs}ms 超时）<<<`);
            resolve();
        }, timeoutMs);
        const t0 = Date.now();
        s.emit(event, ...args, (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const ms = Date.now() - t0;
            if (!r) {
                console.log(`${label}: 回调为空  往返=${ms}ms`);
            } else if (r.ok && typeof r.pos === 'string') {
                const kb = ((r.pos.length + r.types.length) / 1024).toFixed(0);
                console.log(`${label}: OK count=${r.count} dtype=${r.dtype} lod=${r.lod} ${kb}KB fails=${r.fails?.length} 往返=${ms}ms 服务端=${r.ms}ms`);
            } else if (r.ok) {
                console.log(`${label}: OK (map) blockSize=${r.blockSize} ascii=${r.ascii?.length}B extent=${JSON.stringify(r.extent)} 往返=${ms}ms`);
            } else {
                console.log(`${label}: 回调失败 ${JSON.stringify(r).slice(0, 160)}  往返=${ms}ms`);
            }
            resolve();
        });
    });
}

setTimeout(async () => {
    if (!ready) { console.log('never ready'); process.exit(1); }
    console.log('\n--- 先确认已有通路（request-map）---');
    await probe('request-map', ['deepseek', { radius: 32 }], 'request-map');
    console.log('\n--- 新通路（request-terrain）---');
    await probe('request-terrain', ['deepseek', { mode: 'around', radius: 48, lod: 2 }], 'terrain around');
    await probe('request-terrain', ['deepseek', { mode: 'full', lod: 2 }], 'terrain full lod2');
    await probe('request-terrain', ['deepseek', { mode: 'full', lod: 1 }], 'terrain full lod1');
    process.exit(0);
}, 3000);
