// 全接口巡检：一次跑完 M1-M5 的关键通路
import { io } from 'socket.io-client';

const s = io('http://localhost:8080', { path: '/socket.io', transports: ['websocket'] });
let latest = null;
s.on('connect', () => s.emit('listen-to-agents'));
s.on('state-update', (st) => { if (st?.deepseek) latest = st.deepseek; });

const ack = (ev, ...args) => new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: '超时' }); } }, 32000);
    s.emit(ev, ...args, (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(2500);

const rows = [];
const add = (name, ok, detail) => rows.push({ 接口: name, 结果: ok ? '✅' : '❌', 详情: detail });

// 1. 实时状态
add('state-update (1Hz)', !!latest, latest ? `pos=(${latest.gameplay.position.x}, ${latest.gameplay.position.z}) hp=${latest.gameplay.health}` : '-');

// 2. 2D 地图
const m = await ack('request-map', 'deepseek', { radius: 32 });
add('request-map', !!m?.ok, m?.ok ? `blockSize=${m.blockSize} extent=${m.extent?.xFrom}..${m.extent?.xTo}` : m?.reason);

// 3. 3D 地形（三档）
for (const [label, opts] of [
    ['request-terrain around', { mode: 'around', radius: 48, lod: 2 }],
    ['request-terrain full lod2', { mode: 'full', lod: 2 }],
    ['request-terrain full lod1', { mode: 'full', lod: 1 }],
]) {
    const t = await ack('request-terrain', 'deepseek', opts);
    add(label, !!t?.ok, t?.ok ? `${t.count} 面 ${((t.pos.length + t.types.length) / 1024).toFixed(0)}KB ${t.ms}ms fails=${t.fails?.length}` : t?.reason);
}

// 4. 事件流
const ev = await ack('get-events', 'deepseek', 0);
add('get-events', !!ev?.ok, ev?.ok ? `${ev.events?.length} 条 · stats=${JSON.stringify(ev.stats)}` : ev?.reason);

// 5. 任务状态
const ts = await ack('get-task-state', 'deepseek');
add('get-task-state', !!ts?.ok, ts?.ok ? `store=${ts.store?.cells}面/${ts.store?.chunks}区块 有效失败=${ts.activeFails} 动作=${ts.action?.current || '空闲'}` : ts?.reason);

// 6. 记忆
const mem = await ack('get-memory', 'deepseek');
add('get-memory', !!mem?.ok, mem?.ok ? `${mem.bytes}B codeVersion=${mem.codeVersion} turns=${mem.turns}` : mem?.reason);

// 7. profiles
const pf = await ack('get-profiles');
add('get-profiles', !!pf?.ok, pf?.ok ? `${pf.profiles?.length} 个 profile` : pf?.reason);
const p1 = await ack('get-profile', 'deepseek.json');
add('get-profile', !!p1?.ok, p1?.ok ? `${p1.json?.name} / ${p1.json?.model} / ${p1.json?.url}` : p1?.reason);

// 8. 服务状态
const srv = await ack('server-status');
add('server-status', !!srv?.ok, srv?.ok ? `listening=${srv.listening} 外部启动=${srv.externallyStarted} rcon=${srv.rcon?.enabled ? 'on' : 'off'}` : srv?.reason);

// 9. 启服守卫
const ss = await ack('server-start');
add('server-start 守卫', ss?.ok === false && ss?.reason === 'port_in_use', ss?.reason || 'ok');

// 10. 日志尾
const lg = await ack('server-log', 5);
add('server-log', !!lg?.ok, `${lg.lines?.length} 行`);

console.log('\n项目'.padEnd(28) + '结果  详情');
console.log('-'.repeat(100));
for (const r of rows) console.log(String(r.接口).padEnd(28) + r.结果 + '  ' + String(r.详情).slice(0, 70));
const bad = rows.filter(r => r.结果 === '❌');
console.log(`\n共 ${rows.length} 项，失败 ${bad.length} 项`);
process.exit(bad.length ? 1 : 0);
