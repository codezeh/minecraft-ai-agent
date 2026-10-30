// S0 验收：30 分钟陪坐采样。
// 判据（方案 §1）：不崩、不断连、不自己走开（位移 < 2 格）、memory.json < 20 KB。
// 这个脚本只观察，不操作 bot。
import { rcon } from './rcon.mjs';
import { statSync } from 'fs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const MINUTES = Number(process.argv[2] || 30);
const MEM = 'bots/deepseek/memory.json';

async function pos() {
    const r = await RC('data get entity deepseek Pos');
    const m = r.match(/\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
}
async function online() {
    return /deepseek/.test(await RC('list'));
}
function memKB() {
    try { return +(statSync(MEM).size / 1024).toFixed(1); } catch { return -1; }
}

(async () => {
    const t0 = Date.now();
    const start = await pos();
    if (!start) { console.log('deepseek 不在线，S0 无法开始'); process.exit(2); }
    const mem0 = memKB();
    console.log(`S0 开始：位置 ${JSON.stringify(start)}，memory ${mem0} KB，时长 ${MINUTES} 分钟`);

    let maxDrift = 0, offline = 0, samples = 0, maxMem = mem0;
    const tEnd = t0 + MINUTES * 60 * 1000;

    while (Date.now() < tEnd) {
        await sleep(15000);           // 每 15 秒采样一次
        samples++;
        const on = await online();
        if (!on) { offline++; continue; }
        const p = await pos();
        if (p) maxDrift = Math.max(maxDrift, Math.hypot(p.x - start.x, p.y - start.y, p.z - start.z));
        maxMem = Math.max(maxMem, memKB());
        const el = ((Date.now() - t0) / 60000).toFixed(1);
        if (samples % 8 === 0) console.log(`  ${el}min: 位移 ${maxDrift.toFixed(2)} 格，memory ${memKB()} KB，离线采样 ${offline} 次`);
    }

    const ok = offline === 0 && maxDrift < 2 && maxMem < 20;
    console.log(`\nS0 结果：${ok ? 'PASS' : 'FAIL'}`);
    console.log(`  离线采样：${offline}/${samples}`);
    console.log(`  最大位移：${maxDrift.toFixed(2)} 格（判据 < 2）`);
    console.log(`  memory 峰值：${maxMem} KB（判据 < 20）`);
    process.exit(ok ? 0 : 1);
})();
