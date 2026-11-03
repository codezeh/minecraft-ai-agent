/**
 * t35 打点：dig-through 挖了 4 格之后，terrain3d 里那几格到底是什么？
 *   ① 挖完立刻读 columnSurfaces → 通道那格还是 T.SOLID 吗？
 *   ② 墙另一侧（AX+2 以外）有没有地形数据？
 *
 * 只诊断，不改产品逻辑。
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { rentArena } from './arena.mjs';
import { execStep } from '../src/agent/library/executor.js';
import { plan3D } from '../src/agent/library/path_3d.js';
import { scanSphere, columnSurfaces, hasSurface, T } from '../src/agent/library/terrain3d.js';
import { mapDirOf } from '../src/agent/library/bot_paths.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'dg' + (Date.now() % 100000);
const F = (n) => Number(n).toFixed(1);
const TNAME = { 0: 'SOLID', 1: 'WATER', 2: 'LAVA', 3: 'BUILT', 4: 'LEAVES', 5: 'CLIMBABLE', 6: 'SUBMERGED' };

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
await new Promise((res) => bot.once('spawn', res));
await sleep(2500);
await RC(`op ${NAME}`); await RC(`gamemode creative ${NAME}`);
await RC(`give ${NAME} diamond_pickaxe 1`);   // ★ 第一版漏了 → dig 报 NO_TOOL，测不到真正行为
await sleep(800);

const arena = await rentArena(RC, 'digprobe', { halfSize: 28 });
const G = arena.groundY, S = G + 1, AX = arena.x, AZ = arena.z;
const fillSafe = async (x1, y1, z1, x2, y2, z2, b) => { await RC(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${b}`); };

await fillSafe(AX - 26, G - 6, AZ - 26, AX + 26, G - 6, AZ + 26, 'bedrock');
await fillSafe(AX - 26, G - 5, AZ - 26, AX + 26, G + 12, AZ + 26, 'air');
await fillSafe(AX - 26, G, AZ - 26, AX + 26, G, AZ + 26, 'stone');
// ★ dig-through 场景：墙在 AX..AX+1（2 格厚）、5 格高、横贯全场
await fillSafe(AX, S, AZ - 26, AX + 1, S + 4, AZ + 26, 'stone');

const mapDir = mapDirOf(bot);
(await import('node:fs')).mkdirSync(mapDir, { recursive: true });

await RC(`tp ${NAME} ${AX - 8 + 0.5} ${S} ${AZ + 0.5}`);
await sleep(1200);
console.log(`场地 G=${G} 起点=(${AX - 8},${S},${AZ}) 目标=(${AX + 8},${S},${AZ})`);
console.log(`墙 x=${AX}..${AX + 1}  y=${S}..${S + 4}`);

const readCol = (x, z, label) => {
    const col = columnSurfaces(mapDir, x, z);
    const items = col.slice().sort((a, b) => b.y - a.y).slice(0, 6)
        .map((c) => `y=${c.y}:${TNAME[c.t] ?? c.t}`);
    console.log(`  ${label} columnSurfaces(${x},${z}) = [${items.join(', ')}]`);
    return col;
};

for (let round = 1; round <= 2; round++) {
    if (round > 1) {
        // 重跑：恢复墙
        await fillSafe(AX, S, AZ - 26, AX + 1, S + 4, AZ + 26, 'stone');
        await RC(`tp ${NAME} ${AX - 8 + 0.5} ${S} ${AZ + 0.5}`);
        await sleep(900);
    }
    console.log(`\n════════ dig-through #${round} ════════`);
    const p0 = bot.entity.position.clone();
    await scanSphere(bot, mapDir, { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) }, 20);
    const dest = { x: AX + 8, y: S, z: AZ };
    let plan = plan3D(mapDir, { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) }, dest, { maxNodes: 20000, margin: 6 });
    if (!plan.ok) { console.log(`  规划失败 ${plan.code}`); continue; }
    const hist = {};
    for (const st of plan.path) hist[st.action] = (hist[st.action] ?? 0) + 1;
    console.log(`  规划 ${plan.path.length}步 直方图=${JSON.stringify(hist)}`);
    const digSteps = plan.path.filter((s) => s.action === 'dig' || s.action === 'digdown');
    console.log(`  dig 步: ${digSteps.map((s) => `(${s.x},${s.y},${s.z})`).join(' ')}`);

    console.log(`  ── 执行前库里的墙列 ──`);
    readCol(AX, AZ, '墙第1格');
    readCol(AX + 1, AZ, '墙第2格');
    readCol(AX + 2, AZ, '墙后(目标侧)');

    // 执行整条路径（和 executor 一样）
    for (const st of plan.path.slice(1)) {
        const r = await execStep(bot, st, { mapDir, onEvent: () => { } });
        console.log(`    exec ${st.action}→(${st.x},${st.y},${st.z}) code=${r?.code ?? 'OK'}`);
        if (!r?.ok) break;
    }

    // ★★ 关键证据：挖完之后库里那几格
    console.log(`  ── ★ 执行后库里的墙列（关键证据）──`);
    const c1 = readCol(AX, AZ, '墙第1格');
    const c2 = readCol(AX + 1, AZ, '墙第2格');
    const c3 = readCol(AX + 2, AZ, '墙后(目标侧)');

    // 真机世界实际是什么（对照）
    const V3 = (await import('vec3')).default;
    for (const yy of [S, S + 1]) {
        const b1 = bot.blockAt(new V3(AX, yy, AZ), false);
        const b2 = bot.blockAt(new V3(AX + 1, yy, AZ), false);
        console.log(`    真实世界 (${AX},${yy},${AZ})=${b1?.name}  (${AX + 1},${yy},${AZ})=${b2?.name}`);
    }

    // 再规划一次（模拟 walkTo 的下一轮）
    await scanSphere(bot, mapDir, { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) }, 20);
    const p1 = bot.entity.position;
    const plan2 = plan3D(mapDir, { x: Math.floor(p1.x), y: Math.floor(p1.y), z: Math.floor(p1.z) }, dest, { maxNodes: 20000, margin: 6 });
    console.log(`  ★ 重扫后再规划: ${plan2.ok ? 'OK ' + plan2.path.length + '步' : '失败 ' + plan2.code}`);
}

try { bot.quit(); } catch { }
await sleep(400);
process.exit(0);
