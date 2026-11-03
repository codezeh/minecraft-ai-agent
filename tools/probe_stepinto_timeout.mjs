/**
 * A5 收口前测数：dig-through 里那 6 次 `stepInto` 到底是
 *   ① 立刻 UNSAFE 返回（便宜 ~几 ms）
 *   ② 撞满 timeout（贵 ~430ms）
 *
 * 只诊断，不改产品逻辑。
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { rentArena } from './arena.mjs';
import { execStep } from '../src/agent/library/executor.js';
import { stepInto, insideCell } from '../src/agent/library/act_step.js';
import { plan3D } from '../src/agent/library/path_3d.js';
import { scanSphere } from '../src/agent/library/terrain3d.js';
import { mapDirOf } from '../src/agent/library/bot_paths.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'pt' + (Date.now() % 100000);
const F = (n) => Number(n).toFixed(2);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
await new Promise((res) => bot.once('spawn', res));
await sleep(2500);
await RC(`op ${NAME}`); await RC(`gamemode creative ${NAME}`); await sleep(600);

const arena = await rentArena(RC, 'timeout-probe', { halfSize: 28 });
const G = arena.groundY, S = G + 1, AX = arena.x, AZ = arena.z;
const fillSafe = async (x1, y1, z1, x2, y2, z2, b) => { await RC(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${b}`); };
const reset = async () => {
    await fillSafe(AX - 26, G - 6, AZ - 26, AX + 26, G - 6, AZ + 26, 'bedrock');
    await fillSafe(AX - 26, G - 5, AZ - 26, AX + 26, G + 12, AZ + 26, 'air');
    await fillSafe(AX - 26, G, AZ - 26, AX + 26, G, AZ + 26, 'stone');
};

// dig-through 场地：2 格厚 5 格高的墙
await reset();
await fillSafe(AX, S, AZ - 26, AX + 1, S + 4, AZ + 26, 'stone');

const mapDir = mapDirOf(bot);
(await import('node:fs')).mkdirSync(mapDir, { recursive: true });

await RC(`tp ${NAME} ${AX - 8 + 0.5} ${S} ${AZ + 0.5}`);
await sleep(1200);
console.log(`场地 G=${G} 起点=(${AX - 8},${S},${AZ}) 目标=(${AX + 8},${S},${AZ}) 墙 x=${AX}..${AX + 1}`);

const samples = [];

// ★ 关键：要把她**放到墙边**，stepInto 才会真的失败（撞墙）。
//   第一版从起点一路走，每次都成功就 break，只拿到 3 个成功样本 —— 测错了地方。
//   现在直接从"紧贴墙"的位置开始，并对**朝墙那一格**反复试 stepInto。
async function measureAt(x0, label) {
    await RC(`tp ${NAME} ${x0 + 0.5} ${S} ${AZ + 0.5}`);
    await sleep(900);
    const p0 = bot.entity.position.clone();
    console.log(`
── ${label} 站到 (${F(p0.x)},${F(p0.y)},${F(p0.z)}) ──`);
    // 朝墙方向(+x)的相邻格：墙在 AX..AX+1，所以她站在 AX-1 时，+x 邻格就是墙体内/墙前
    for (let k = 0; k < 3; k++) {
        const cell = { x: Math.floor(p0.x) + 1, y: Math.floor(p0.y), z: Math.floor(p0.z) };
        const b4 = bot.entity.position.clone();
        const t0 = Date.now();
        const r = await stepInto(bot, cell, { timeoutMs: 1600 });
        const ms = Date.now() - t0;
        const d = Math.hypot(bot.entity.position.x - b4.x, bot.entity.position.z - b4.z);
        samples.push({ ms, code: r.code ?? 'OK', ok: r.ok, d: +d.toFixed(2), cell });
        console.log(`    stepInto→(${cell.x},${cell.y},${cell.z}) ok=${r.ok} code=${r.code ?? 'OK'} 耗时=${ms}ms 位移=${F(d)}`);
    }
}

// 墙在 AX..AX+1：站 AX-1（墙前）、AX-2（隔一格）
await measureAt(AX - 1, '紧贴墙前');
await measureAt(AX - 2, '离墙一格');

// 汇总
console.log('\n══════ stepInto 耗时分布 ══════');
const byCode = {};
for (const s of samples) {
    const k = s.ok ? 'OK(成功)' : s.code;
    byCode[k] = byCode[k] ?? [];
    byCode[k].push(s.ms);
}
for (const [k, arr] of Object.entries(byCode)) {
    arr.sort((a, b) => a - b);
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    console.log(`  ${k}: ${arr.length} 次  耗时 ${arr.join('/')}ms  均值 ${avg}ms`);
}
const timeouts = samples.filter((s) => !s.ok && s.ms >= 1200).length;
const instant = samples.filter((s) => !s.ok && s.ms < 200).length;
console.log(`\n★ 判定：撞满超时(≥1200ms) ${timeouts} 次；立刻返回(<200ms) ${instant} 次；成功 ${samples.filter(s => s.ok).length} 次`);
console.log(`  → ${timeouts > instant ? '【超时主导】可调 timeoutMs 1600→500' : '【立刻返回主导】调 timeout 无用，收口'}`);

try { bot.quit(); } catch { }
await sleep(400);
process.exit(0);
