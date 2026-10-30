// 复现"38 秒只走 3 格"的卡死场景，抓逐步日志。
//
// 已知线索：
//   `[walkTo] 第1~5轮 规划20步 → 现在(-92,68,-211)` —— 5 轮位置完全不变
//   且没有"步失败"日志 → 每步都返回 ok 但实际没动
//
// 本脚本：把探针放到远处 → 让她 goToPlayer → 抓 [step] / [walkTo] 全部日志
import { rcon } from './rcon.mjs';

const R = (c) => rcon(c, { port: 25575, password: 'localdev' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const pos = async (n) => {
    try {
        const r = String(await R(`data get entity ${n} Pos`));
        const m = r.match(/\[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/);
        return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
    } catch { return null; }
};

const list = String(await R('list'));
const names = (list.split(':')[1] || '').split(',').map(x => x.trim()).filter(Boolean);
const probe = names.find(n => n !== 'deepseek');
if (!probe) { console.log('探针不在线'); process.exit(1); }

const her = await pos('deepseek');
console.log(`她 (${her.x.toFixed(1)},${her.y.toFixed(1)},${her.z.toFixed(1)})`);

// 探针放到 90 格外的已知地形处（用 tp，落到有地形的地方）
const tx = Math.round(her.x - 90), tz = Math.round(her.z - 60);
console.log(`tp 探针到 (${tx},80,${tz})`);
await R(`tp ${probe} ${tx} 80 ${tz}`);
await sleep(4000);
const p = await pos(probe);
console.log(`探针落在 (${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`);

const dist = Math.hypot(p.x - her.x, p.z - her.z);
console.log(`相距 ${dist.toFixed(0)} 格\n`);

await R(`msg deepseek !goToPlayer(${JSON.stringify(probe)}, 3)`);
console.log('已下指令，观察 120 秒…\n');

let prev = her;
for (let i = 1; i <= 12; i++) {
    await sleep(10000);
    const h = await pos('deepseek');
    const pp = await pos(probe);
    if (!h || !pp) continue;
    const moved = Math.hypot(h.x - prev.x, h.z - prev.z);
    const remain = Math.hypot(h.x - pp.x, h.z - pp.z);
    console.log(`[${String(i * 10).padStart(3)}s] (${h.x.toFixed(0)},${h.y.toFixed(0)},${h.z.toFixed(0)}) 剩${remain.toFixed(0)} 本段${moved.toFixed(1)}`);
    prev = h;
}
