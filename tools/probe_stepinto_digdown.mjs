/**
 * t34 打点（**不改任何逻辑**）：digdown 场景第 2 轮，逐 step 打印
 *   action / stepInto 尝试与结果 / 位置变化
 *
 * 目的：定位上次"stepInto 接进 executor 后 digdown #2 死循环"的确切触发点。
 * 做法：不接 executor，而是在**旁路**对每个 step 先试一次 stepInto（只读诊断），
 *      记录它成不成、位置动没动，然后照常走原来的 execStep。
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
const RC = (c, o) => rcon(c, { port: 25576, ...(o ?? {}) });
const NAME = 'p' + (Date.now() % 100000);
const F = (n) => Number(n).toFixed(2);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
await new Promise((res) => bot.once('spawn', res));
await sleep(2500);
await RC(`op ${NAME}`);
await RC(`gamemode creative ${NAME}`);
await sleep(600);

const arena = await rentArena(RC, 'actions-probe', { halfSize: 28 });
const G = arena.groundY, S = G + 1, AX = arena.x, AZ = arena.z;
const fillSafe = async (x1, y1, z1, x2, y2, z2, b) => {
    await RC(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${b}`);
};
const reset = async () => {
    await fillSafe(AX - 26, G - 6, AZ - 26, AX + 26, G - 6, AZ + 26, 'bedrock');
    await fillSafe(AX - 26, G - 5, AZ - 26, AX + 26, G + 12, AZ + 26, 'air');
    await fillSafe(AX - 26, G, AZ - 26, AX + 26, G, AZ + 26, 'stone');
};

// digdown 场景：盖板铺到 AX+8，目标 AX+16（见 bench 注释 ④）
await reset();
await fillSafe(AX - 8, G + 3, AZ - 26, AX + 8, G + 3, AZ + 26, 'stone');

// ★ 与 bench 的 digdown 一致：起点 dx=-4 / up=3（站在盖顶，脚位 G+4），目标 dx=16（地面）
const sx = AX - 4, sz = AZ;
const START_Y = S + 3;
await RC(`tp ${NAME} ${sx + 0.5} ${START_Y} ${sz + 0.5}`);
await sleep(1200);
console.log(`场地 G=${G} 起点=(${sx},${START_Y},${sz}) 目标=(${AX + 16},${S},${AZ})`);

// 手动跑两轮，模拟 bench 的 #1/#2（第一轮会把盖板挖开 → 第二轮面对的是什么，正是我们要看的）
const mapDir = mapDirOf(bot);
(await import('node:fs')).mkdirSync(mapDir, { recursive: true });   // 否则 terrain3d 打不开库

for (let round = 1; round <= 2; round++) {
    await reset();
    await fillSafe(AX - 8, G + 3, AZ - 26, AX + 8, G + 3, AZ + 26, 'stone');
    await RC(`tp ${NAME} ${sx + 0.5} ${START_Y} ${sz + 0.5}`);
    await sleep(1000);
    console.log(`\n════════ digdown #${round} ════════`);

    const dest = { x: AX + 16, y: S, z: AZ };
    for (let iter = 1; iter <= 6; iter++) {
        const pos0 = bot.entity.position.clone();
        await scanSphere(bot, mapDir, { x: Math.floor(pos0.x), y: Math.floor(pos0.y), z: Math.floor(pos0.z) }, 20);
        const plan = plan3D(mapDir, { x: Math.floor(pos0.x), y: Math.floor(pos0.y), z: Math.floor(pos0.z) },
            dest, { maxNodes: 20000, margin: 6 });
        if (!plan.ok) { console.log(`  [iter${iter}] 规划失败 ${plan.code}`); break; }
        const hist = {};
        for (const st of plan.path) hist[st.action] = (hist[st.action] ?? 0) + 1;
        console.log(`  [iter${iter}] 规划 ${plan.path.length}步 直方图=${JSON.stringify(hist)} 起点=(${F(pos0.x)},${F(pos0.y)},${F(pos0.z)})`);

        // ★★ 旁路诊断（2026-11-03 按 captain 要求）：
        //   ① 把 **y+1（脚位）** 传进去，看是否变成 ok=true / 进格=true
        //   ② 同时确认 `down`/`jump` 步**不该**走 stepInto（它只会按前进，不会下降/上跳）
        const ELIGIBLE = new Set(['walk']);        // 只有 walk（同层相邻）才准试 stepInto
        // ★ 把**非 walk 的全部 step** 单独列出来，确认 down/jump/dig/climb 都被跳过
        const nonWalk = plan.path.filter((st) => !ELIGIBLE.has(st.action));
        if (nonWalk.length) {
            console.log(`  非 walk 步（应全部跳过 stepInto）: `
                + nonWalk.map((st) => `${st.action}(${st.x},${st.y},${st.z})`).join(' '));
        }
        const steps = plan.path.slice(0, 8);
        for (let i = 0; i < steps.length; i++) {
            const st = steps[i];
            const p0 = bot.entity.position.clone();
            const feetCell = { x: st.x, y: st.y + 1, z: st.z };   // ★ 面位 → 脚位（与 executor:115 同一换算）
            const inCellBefore = insideCell(p0, feetCell);
            const eligible = ELIGIBLE.has(st.action);

            if (!eligible) {
                console.log(`    [step${i}] action=${st.action} 目标(面位)=(${st.x},${st.y},${st.z})`
                    + ` | ★ 非 walk，**不试 stepInto**（它只会按前进，不下降/不上跳）`);
                continue;
            }
            if (inCellBefore) {
                console.log(`    [step${i}] action=${st.action} 脚位格=(${feetCell.x},${feetCell.y},${feetCell.z}) | 已在格内，跳过`);
                continue;
            }
            const t0 = Date.now();
            const r = await stepInto(bot, feetCell, { timeoutMs: 2500 });
            const p1 = bot.entity.position.clone();
            const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
            const inAfter = insideCell(p1, feetCell);
            console.log(`    [step${i}] action=${st.action} 脚位格=(${feetCell.x},${feetCell.y},${feetCell.z})`
                + ` | stepInto(y+1): ok=${r.ok} code=${r.code ?? 'OK'} 进格=${inAfter} 位移=${F(dist)}`
                + ` ${r.ok && inAfter ? '✅验通' : '❌仍失败'}  (${Date.now() - t0}ms)`);
        }

        // 照常执行整条路径的前几步（原逻辑，不变）
        let moved = false;
        for (const st of plan.path.slice(0, 2)) {
            const before = bot.entity.position.clone();
            const r = await execStep(bot, st, { mapDir, onEvent: () => { } });
            const after = bot.entity.position;
            const d = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
            console.log(`    [exec] action=${st.action} → (${st.x},${st.y},${st.z}) code=${r?.code ?? 'OK'} 位移=${F(d)}`);
            if (d > 0.1) moved = true;
        }
        const pEnd = bot.entity.position;
        console.log(`  [iter${iter}] 结束位置=(${F(pEnd.x)},${F(pEnd.y)},${F(pEnd.z)}) movedThisIter=${moved}`);
        if (!moved) { console.log('  ★ 连续无位移 —— 这正是死循环的特征'); break; }
    }
}

try { bot.quit(); } catch { }
await sleep(400);
process.exit(0);
