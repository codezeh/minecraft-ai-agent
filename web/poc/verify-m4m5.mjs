// 验证 M4（profile 列表/读取）与 M5（paper 服务状态/启动守卫/RCON 停止）
import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });
s.on('connect', () => s.emit('listen-to-agents'));

const ack = (ev, ...args) => new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: '超时' }); } }, 20000);
    s.emit(ev, ...args, (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(2500);

console.log('=== get-profiles ===');
const p = await ack('get-profiles');
console.log('ok=' + p.ok, 'dir=' + p.dir, '数量=' + (p.profiles?.length || 0));
for (const x of (p.profiles || []).slice(0, 6)) {
    console.log(`  ${x.file.padEnd(24)} name=${String(x.name).padEnd(14)} api=${String(x.api).padEnd(8)} model=${x.model}`);
}

console.log('\n=== get-profile（读 deepseek.json）===');
const one = await ack('get-profile', 'deepseek.json');
console.log('ok=' + one.ok, 'file=' + one.file, 'bytes=' + one.raw?.length,
    'name=' + one.json?.name, 'model=' + one.json?.model, 'url=' + one.json?.url);

console.log('\n=== 目录穿越防护（应拒绝）===');
const evil = await ack('get-profile', '../../settings.js');
console.log('ok=' + evil.ok, 'reason=' + evil.reason);

console.log('\n=== server-status ===');
const st = await ack('server-status');
console.log(JSON.stringify(st, null, 2).slice(0, 700));

console.log('\n=== server-start（端口已占用 → 应拒绝，防起第二个服）===');
const ss = await ack('server-start');
console.log('ok=' + ss.ok, 'reason=' + ss.reason, '|', ss.hint);

console.log('\n=== server-log ===');
const lg = await ack('server-log', 5);
console.log('ok=' + lg.ok, '行数=' + lg.lines?.length, '(我们没托管进程，所以为空是对的)');

process.exit(0);
