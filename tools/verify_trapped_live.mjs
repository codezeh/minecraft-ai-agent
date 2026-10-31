/**
 * atom_stuck_detect.detectTrapped 真机验收 —— 测试服 25566。
 *
 * 为什么需要：判据原来是 task_follow 里就地写的 110 行（walkable + 泛洪 + 扫地表 + 探8向），
 * 2026-11-01 抽成原子。离线用例（tools/detect_trapped_unit.mjs）只能验纯逻辑，
 * 而真实 blockAt / canStand 的行为（区块加载、方块名、支撑判定）只有真机能验。
 *
 * 三个场景：
 *   1) 密封石盒子里 → trapped=true，area 很小，capped=true
 *   2) 站到开阔平地 → trapped=false，area 很大
 *   3) 1×1 竖井（头顶挖穿、四周封死）→ trapped=true 且 capped=false
 *      —— 这正是历史上"第十六次修"踩过的坑：头顶开阔了但人还困着
 *
 * 用法：node tools/verify_trapped_live.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { detectTrapped } from '../src/agent/library/atom_stuck_detect.js';
import { rentArena } from './arena.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'tr' + (Date.now() % 100000);

let pass = 0, fail_ = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
    else { fail_++; console.log(`  FAIL  ${name}  ${detail}`); }
};

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(1000);

    // ★ 场地租在远处并用 forceload 强制加载：不要在出生点附近造东西，
    //   否则会和其它 live 测试的场地重叠（踩过两次，见 tools/arena.mjs 的说明）。
    const arena = await rentArena(RC, 'trapped');
    const SURF = arena.groundY + 1;               // 脚位（实心在 groundY）
    const AX = arena.x - 6, AZ = arena.z - 6;     // 密封盒子
    const BX = arena.x + 6, BZ = arena.z - 6;     // 开阔平地
    const CX = arena.x - 6, CZ = arena.z + 6;     // 1×1 竖井

    // ---- 场景 1：密封石盒子（内部 3×3×2 空气）----
    await RC(`fill ${AX - 3} ${SURF - 1} ${AZ - 3} ${AX + 3} ${SURF + 6} ${AZ + 3} air`);
    await RC(`fill ${AX - 3} ${SURF - 1} ${AZ - 3} ${AX + 3} ${SURF - 1} ${AZ + 3} stone`);
    // 四周墙 + 顶盖
    await RC(`fill ${AX - 1} ${SURF} ${AZ - 1} ${AX + 1} ${SURF + 2} ${AZ + 1} stone`);
    await RC(`fill ${AX} ${SURF} ${AZ} ${AX} ${SURF + 1} ${AZ} air`);
    await sleep(800);
    await RC(`tp ${NAME} ${AX + 0.5} ${SURF} ${AZ + 0.5}`);
    await sleep(1500);
    {
        const r = detectTrapped(bot);
        const d = r.data ?? {};
        const inside = bot.blockAt(new Vec3(AX, SURF + 2, AZ))?.name;
        check('盒子建好了（头顶实心）', inside && inside !== 'air', String(inside));
        check('密封盒子 → 判被困', d.trapped === true, `trapped=${d.trapped} area=${d.area} capped=${d.capped}`);
        check('面积很小（< 20）', d.area < 20, `area=${d.area}`);
        check('goalY 是地表+2（找不到地表则 +12）', Number.isFinite(d.goalY), `goalY=${d.goalY} surfaceY=${d.surfaceY}`);
    }

    // ---- 场景 2：开阔平地 → 不该被困 ----
    await RC(`fill ${BX - 12} ${SURF} ${BZ - 12} ${BX + 12} ${SURF + 8} ${BZ + 12} air`);
    await RC(`fill ${BX - 12} ${SURF - 1} ${BZ - 12} ${BX + 12} ${SURF - 1} ${BZ + 12} stone`);
    await sleep(800);
    await RC(`tp ${NAME} ${BX + 0.5} ${SURF} ${BZ + 0.5}`);
    await sleep(1500);
    {
        const r = detectTrapped(bot);
        const d = r.data ?? {};
        check('开阔平地 → 不被困', d.trapped === false, `trapped=${d.trapped} area=${d.area} openDirs=${d.openDirs}`);
        check('面积大（>= 300）', d.area >= 300, `area=${d.area}`);
    }

    // ---- 场景 3：1×1 竖井，头顶挖穿、四周封死 ----
    // 外壳必须封到 probeRadius(8) 以外：判据探的是"8 格内有没有能站的地方"，
    // 而它**不管走不走得到**。所以只要 8 格内是开阔地，哪怕她被 1×1 竖井困着，
    // 也会被判"能走开"。这是继承下来的已知弱点（详见 atom_stuck_detect 的注释），
    // 本测试要验的是"真的封死时判得对"，所以外壳封到 ±9。
    await RC(`fill ${CX - 9} ${SURF - 1} ${CZ - 9} ${CX + 9} ${SURF + 12} ${CZ + 9} stone`);
    await RC(`fill ${CX} ${SURF} ${CZ} ${CX} ${SURF + 12} ${CZ} air`);   // 竖井一路到顶部
    await sleep(800);
    await RC(`tp ${NAME} ${CX + 0.5} ${SURF} ${CZ + 0.5}`);
    await sleep(1500);
    {
        const r = detectTrapped(bot);
        const d = r.data ?? {};
        check('1×1 竖井（头顶已挖穿）→ 仍判被困', d.trapped === true, `trapped=${d.trapped} area=${d.area} capped=${d.capped} walled=${d.walled}`);
        check('头顶确实开阔（capped=false）', d.capped === false, `capped=${d.capped} ceilingAt=${d.ceilingAt}`);
    }

    // ---- 收尾：清空场地 + 取消 forceload（不碰出生点）----
    await arena.release();

    console.log('');
    console.log(`detectTrapped 真机：${pass} PASS / ${fail_} FAIL`);
    console.log('============================================');
    try { bot.quit(); } catch { }
    process.exit(fail_ === 0 ? 0 : 1);
});
