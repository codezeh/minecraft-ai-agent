/**
 * 移动引擎基线（live）—— Phase 3 的"改前 X"。
 *
 * 为什么必须有：《改进规划》§3.2 明令禁止"没有基线数字就动手改"。
 * Phase 3 要动导航主干（nav_core 统一入口 + 拆 executor），这是全项目风险最高的一块，
 * 没有基线就没有"改之前 X、改之后 Y"，也就无法回答"到底有没有变好"。
 *
 * 测什么：一组可控地形上的真实 walkTo。每条路线记录
 *   ok / 最终 code / 耗时 / 实际位移 / 距目标剩余距离 / 中间失败码
 *
 * 场地：用 tools/arena.mjs 租远处 forceload 区块，不碰出生点、不影响别的测试。
 *
 * 用法：
 *   node tools/bench_move_baseline.mjs [每场景轮数]
 * 输出：
 *   tmp/bench/<日期>-move.jsonl   每条路线一行
 *   控制台一行汇总 + 每场景成功率
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { rcon } from './rcon.mjs';
import { rentArena } from './arena.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { walkTo } from '../src/agent/library/executor.js';
import { goTo } from '../src/agent/library/nav_core.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'mv' + (Date.now() % 100000);
const ROUNDS = Number(process.argv[2] ?? 3);
// 走哪个入口：walkTo（引擎本身）或 goTo（产品实际入口 nav_core）
// 基线用 walkTo 记"改前"；接线 task_hop→nav_core 之后再跑 goTo 对比。
const VIA = (process.argv[3] ?? 'walkTo').toLowerCase();

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

const feet = () => Math.floor(bot.entity.position.y);
const here = () => ({
    x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
});

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(800);

    const arena = await rentArena(RC, 'move', { halfSize: 24 });
    const G = arena.groundY;                 // 实心地面 y（脚位 = G+1）
    const SURF = G + 1;
    const AX = arena.x, AZ = arena.z;

    // 地形扫描/规划要用的临时库
    const mapDir = join('tmp', 'bench-move-map', 'terrain');
    mkdirSync(mapDir, { recursive: true });

    await RC(`gamemode creative ${NAME}`);
    await RC(`give ${NAME} dirt 64`);
    await RC(`give ${NAME} diamond_pickaxe 1`);
    await RC(`gamemode survival ${NAME}`);
    await sleep(600);

    /**
     * 场景定义：build() 造地形，start 起点偏移，dest 终点偏移。
     * 全部相对场地中心。
     */
    const scenarios = [
        {
            name: 'flat-straight',
            async build() {
                await RC(`fill ${AX - 20} ${SURF} ${AZ - 20} ${AX + 20} ${SURF + 10} ${AZ + 20} air`);
                await RC(`fill ${AX - 20} ${G} ${AZ - 20} ${AX + 20} ${G} ${AZ + 20} stone`);
            },
            start: { dx: -12, dz: 0 },
            dest: { dx: 12, dz: 0 },
        },
        {
            name: 'stairs-up-1',
            // 每 4 格抬 1 格，共抬 3 格（pathfinder 应当能直接跳上去）
            async build() {
                await RC(`fill ${AX - 20} ${SURF} ${AZ - 20} ${AX + 20} ${SURF + 10} ${AZ + 20} air`);
                await RC(`fill ${AX - 20} ${G} ${AZ - 20} ${AX + 20} ${G} ${AZ + 20} stone`);
                for (let i = 0; i < 3; i++) {
                    const x0 = AX - 4 + i * 4;
                    await RC(`fill ${x0} ${G + 1} ${AZ - 3} ${x0 + 15} ${G + 1 + i} ${AZ + 3} stone`);
                }
            },
            start: { dx: -12, dz: 0 },
            dest: { dx: 12, dz: 0 },
        },
        {
            name: 'wall-to-dig',
            // 中间一堵 2 格高的墙，必须挖穿或绕
            async build() {
                await RC(`fill ${AX - 20} ${SURF} ${AZ - 20} ${AX + 20} ${SURF + 10} ${AZ + 20} air`);
                await RC(`fill ${AX - 20} ${G} ${AZ - 20} ${AX + 20} ${G} ${AZ + 20} stone`);
                await RC(`fill ${AX} ${G + 1} ${AZ - 10} ${AX} ${G + 2} ${AZ + 10} stone`);
                await RC(`fill ${AX - 10} ${G + 1} ${AZ - 10} ${AX + 10} ${G + 3} ${AZ - 10} stone`);
                await RC(`fill ${AX - 10} ${G + 1} ${AZ + 10} ${AX + 10} ${G + 3} ${AZ + 10} stone`);
            },
            start: { dx: -6, dz: 0 },
            dest: { dx: 6, dz: 0 },
        },
        {
            name: 'gap-bridge',
            // 中间 3 格宽的沟，必须有垫脚方块才能过
            async build() {
                await RC(`fill ${AX - 20} ${SURF} ${AZ - 20} ${AX + 20} ${SURF + 10} ${AZ + 20} air`);
                await RC(`fill ${AX - 20} ${G} ${AZ - 20} ${AX + 20} ${G} ${AZ + 20} stone`);
                await RC(`fill ${AX - 2} ${G} ${AZ - 6} ${AX + 2} ${G} ${AZ + 6} air`);
            },
            start: { dx: -10, dz: 0 },
            dest: { dx: 10, dz: 0 },
        },
        {
            name: 'long-route',
            // 30 格长直线，测长距离稳定性
            async build() {
                await RC(`fill ${AX - 40} ${SURF} ${AZ - 10} ${AX + 40} ${SURF + 10} ${AZ + 10} air`);
                await RC(`fill ${AX - 40} ${G} ${AZ - 10} ${AX + 40} ${G} ${AZ + 10} stone`);
            },
            start: { dx: -28, dz: 0 },
            dest: { dx: 28, dz: 0 },
        },
    ];

    const outDir = join('tmp', 'bench');
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const outFile = join(outDir, `${stamp}-move-${VIA}.jsonl`);

    const rows = [];
    for (const sc of scenarios) {
        await sc.build();
        await sleep(600);

        for (let round = 1; round <= ROUNDS; round++) {
            const sx = AX + sc.start.dx, sz = AZ + sc.start.dz;
            const dx = AX + sc.dest.dx, dz = AZ + sc.dest.dz;
            await RC(`tp ${NAME} ${sx + 0.5} ${SURF} ${sz + 0.5}`);
            await sleep(1200);
            const before = here();

            const t0 = Date.now();
            const r = VIA === 'goto'
                ? await goTo(bot, { x: dx, z: dz }, { mapDir, deadlineMs: 45000, arriveTol: 2 })
                : await walkTo(bot, { x: dx, z: dz }, { mapDir, deadlineMs: 45000, arriveTol: 2 });
            const ms = Date.now() - t0;
            const after = here();
            const remain = Math.hypot(dx - after.x, dz - after.z);
            const moved = Math.hypot(after.x - before.x, after.z - before.z);

            const row = {
                scenario: sc.name, round, via: VIA,
                ok: !!r.ok, code: r.code ?? 'OK',
                ms, moved: +moved.toFixed(1), remain: +remain.toFixed(1),
                fromY: +before.y.toFixed(1), toY: +after.y.toFixed(1),
                msg: String(r.message ?? '').slice(0, 80),
            };
            rows.push(row);
            appendFileSync(outFile, JSON.stringify(row) + '\n', 'utf8');
            console.log(`  ${row.ok ? 'PASS' : 'FAIL'} ${sc.name} #${round} code=${row.code} ${ms}ms 走${row.moved}格 剩${row.remain}格 y ${row.fromY}->${row.toY}`);
        }
    }

    // ---- 汇总（《标准流程》要求"一行汇总"）----
    const bySc = {};
    for (const r of rows) {
        bySc[r.scenario] ??= { n: 0, ok: 0, ms: 0, remain: 0 };
        bySc[r.scenario].n++;
        if (r.ok) bySc[r.scenario].ok++;
        bySc[r.scenario].ms += r.ms;
        bySc[r.scenario].remain += r.remain;
    }
    console.log('\n=== 移动基线汇总 ===');
    for (const [name, s] of Object.entries(bySc)) {
        console.log(`  ${name.padEnd(16)} 成功 ${s.ok}/${s.n}  平均 ${(s.ms / s.n).toFixed(0)}ms  平均剩余 ${(s.remain / s.n).toFixed(1)}格`);
    }
    const total = rows.length, okAll = rows.filter(r => r.ok).length;
    const codes = {};
    for (const r of rows) if (!r.ok) codes[r.code] = (codes[r.code] ?? 0) + 1;
    console.log(`  总计 成功 ${okAll}/${total}  失败码 ${JSON.stringify(codes)}`);
    console.log(`  明细: ${outFile}`);

    await arena.release();
    try { bot.quit(); } catch { }
    process.exit(0);
});
