/**
 * 移动基线（扩展版）：**逐种 action 覆盖** —— Phase 3 拆 executor 的前置基线。
 *
 * 为什么单独一个文件而不改 bench_move_baseline.mjs：
 *   那一份（5 地形 × 10 轮 = 50/50）是"整条链路"的干净基线，要留着做同口径对比。
 *   这一份的目标不同：**证明每一种 action 都被真的走过**，并且各自的成绩可单独对比。
 *   拆 executor 成 steps/ 之后，必须能回答"climb 有没有变差""digdown 有没有变差"，
 *   而不是只有"总体上还行"。
 *
 * path_3d 会产出的 action 全集（见 path_3d.js:413/451/478/596）：
 *   start / walk / jump / down / dig / climb
 * 另外 executor 里还有一个派生分支：dy < -1 且脚下实心时走 'digdown'。
 *
 * 每条路线做两件事：
 *   1) **干跑规划**：扫地形 → plan3D → 记录动作直方图。
 *      这证明"这条路线确实需要 climb/jump/dig…"，否则就是在测别的东西。
 *   2) **真跑执行**：walkTo，记录 ok / code / 耗时 / 位移 / 剩余距离。
 *
 * 场地：tools/arena.mjs（/forceload 远处区块 + fillSafe 切块填充）。
 *
 * ★ 2026-11-01 首跑就遇到两个**真实能力边界**，作为"改前已知失败"记录，
 *   拆 executor 后要专门看这两条有没有变化（不是必须变好，但必须知道）：
 *   - down5（跳下 5 格）：NO_PATH —— plan3D 的 maxDrop 默认 4，5 格跳不规划
 *   - dig-through（2 格厚墙，横贯全场）：能挖 1 格（动作里有 dig）但随后 NO_PATH，
 *     **挖不穿**。注意墙必须横贯整个场地，否则她会从两端绕过去，
 *     首跑墙只有 ±12 宽，于是"通过"了但动作里一个 dig 都没有 —— 那是在测走路，不是挖穿
 *   - water-cross（5 格宽水池）：首跑 TIMEOUT 70s，第二跑 42.9s 勉强通过（不稳）
 * 另外：**walkTo 只按水平距离判到达**（climb 场景里她本来就在目标列上，
 *   于是 0ms 就报成功、根本没爬），所以 climb 场景的起点要离柱子远一点。
 *
 * 用法：node tools/bench_move_actions.mjs [每场景轮数]
 * 输出：tmp/bench/<日期>-move-actions.jsonl + 控制台按 action 汇总
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { rcon } from './rcon.mjs';
import { rentArena, fillSafe, tpSafe } from './arena.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { walkTo } from '../src/agent/library/executor.js';
import { scanSphere, closeDb3d } from '../src/agent/library/terrain3d.js';
import { plan3D } from '../src/agent/library/path_3d.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'ma' + (Date.now() % 100000);
const ROUNDS = Number(process.argv[2] ?? 3);

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

const instanceOfBlockOk = (b) => !!b && typeof b.name === 'string';

const here = () => ({ x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z });

/**
 * 等她脚下那块区块真的到了客户端。
 *
 * ★ 踩过的坑：tp 到 10000 格外的场地后立刻 scanSphere / walkTo，
 *   mineflayer 还没收到区块数据 → blockAt 返回 null → 扫不到地形 → NO_START；
 *   更糟的是 tp 没生效时 walkTo 会真的去横跨一万格（实测走了 195 格后 TIMEOUT）。
 *   所以传送后必须**轮询到读得到方块**再往下走。
 */
async function waitLoaded(x, y, z, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const b = bot.blockAt(new Vec3(x, y - 1, z));
            if (b && b.name) return true;
        } catch { /* 还没加载好 */ }
        await sleep(200);
    }
    return false;
}

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(800);

    const arena = await rentArena(RC, 'actions', { halfSize: 28 });
    const G = arena.groundY;         // 实心底面 y（脚位 = G+1）
    const S = G + 1;
    const AX = arena.x, AZ = arena.z;

    await RC(`gamemode creative ${NAME}`);
    await RC(`give ${NAME} dirt 64`);
    await RC(`give ${NAME} diamond_pickaxe 1`);
    await RC(`gamemode survival ${NAME}`);
    await sleep(600);

    /** 清场：把整块场地清成空气 + 一层实心地面 */
    const reset = async () => {
        // ★ 必须切块：/fill 单次上限 32768 格，这里 53×53×25≈70k 会静默失败
        await fillSafe(RC, AX - 26, S, AZ - 26, AX + 26, S + 24, AZ + 26, 'air');
        await fillSafe(RC, AX - 26, G, AZ - 26, AX + 26, G, AZ + 26, 'stone');
    };

    const scenarios = [
        // ── walk ────────────────────────────────────────────────────────
        {
            name: 'walk-flat', want: ['walk'],
            build: async () => { await reset(); },
            start: { dx: -12, dz: 0 }, dest: { dx: 12, dz: 0 },
        },
        // ── jump（上 1 格）──────────────────────────────────────────────
        {
            name: 'jump-up1', want: ['jump', 'walk'],
            build: async () => {
                await reset();
                // 一段 1 格高的台阶，终点在台阶上
                await fillSafe(RC, AX + 4, S, AZ - 6, AX + 20, S, AZ + 6, 'stone');
            },
            start: { dx: -8, dz: 0 }, dest: { dx: 14, dz: 0 },
        },
        // ── pillar：上 2 格（pathfinder 跳不上去，执行层要垫方块）────────
        {
            name: 'pillar-up2', want: ['jump', 'walk'],
            build: async () => {
                await reset();
                // 2 格高的台（顶面在 S+1，即脚位 S+2）
                await fillSafe(RC, AX + 3, S, AZ - 6, AX + 20, S + 1, AZ + 6, 'stone');
            },
            start: { dx: -8, dz: 0 }, dest: { dx: 14, dz: 0 },
        },
        // ── down（往下掉 1 格）──────────────────────────────────────────
        {
            name: 'down1', want: ['down', 'walk'],
            build: async () => {
                await reset();
                // 前半段高 1 格，终点在低处
                await fillSafe(RC, AX - 20, S, AZ - 6, AX - 2, S, AZ + 6, 'stone');
            },
            start: { dx: -12, dz: 0 }, dest: { dx: 10, dz: 0 },
        },
        // ── down（高处往下 5 格）────────────────────────────────────────
        {
            name: 'down5', want: ['down', 'walk'], deadlineMs: 120000,
            build: async () => {
                await reset();
                // 5 格高台，往下跳到地面
                await fillSafe(RC, AX - 20, S, AZ - 6, AX - 4, S + 4, AZ + 6, 'stone');
            },
            start: { dx: -12, dz: 0, up: 5 }, dest: { dx: 10, dz: 0 },
        },
        // ── dig（横着挖穿一堵墙）────────────────────────────────────────
        {
            name: 'dig-through', want: ['dig'],
            build: async () => {
                await reset();
                // 一堵 2 格厚、5 格高的墙把场地一分为二
                await fillSafe(RC, AX, S, AZ - 26, AX + 1, S + 4, AZ + 26, 'stone');
            },
            start: { dx: -8, dz: 0 }, dest: { dx: 8, dz: 0 },
        },
        // ── digdown（往下挖穿一层地板）──────────────────────────────────
        {
            name: 'digdown', want: ['digdown', 'dig', 'down'],
            build: async () => {
                await reset();
                // 在起点与终点之间铺一层厚 3 的实心台，终点在台下
                await fillSafe(RC, AX - 4, G, AZ - 6, AX + 12, G + 3, AZ + 6, 'stone');
                await RC(`fill ${AX + 8} ${G + 1} ${AZ - 3} ${AX + 8} ${G + 3} ${AZ + 3} air`);
            },
            start: { dx: -10, dz: 0 }, dest: { dx: 16, dz: 0 },
        },
        // ── climb（梯子）───────────────────────────────────────────────
        {
            name: 'climb-ladder', want: ['climb'],
            build: async () => {
                await reset();
                // 一根 6 格高的实心柱，东面贴梯子；终点在柱顶
                await RC(`fill ${AX} ${S} ${AZ} ${AX} ${S + 5} ${AZ} stone`);
                await RC(`fill ${AX - 1} ${S} ${AZ} ${AX - 1} ${S + 5} ${AZ} ladder[facing=east]`);
                // 柱顶平台
                await RC(`fill ${AX - 2} ${S + 6} ${AZ - 2} ${AX + 2} ${S + 6} ${AZ + 2} stone`);
            },
            start: { dx: -8, dz: 0 }, dest: { dx: 0, dz: 0, up: 6 },
        },
        // ── climb（藤蔓）───────────────────────────────────────────────
        {
            name: 'climb-vine', want: ['climb'],
            build: async () => {
                await reset();
                await RC(`fill ${AX} ${S} ${AZ} ${AX} ${S + 5} ${AZ} stone`);
                await RC(`fill ${AX - 1} ${S} ${AZ} ${AX - 1} ${S + 5} ${AZ} vine[east=true]`);
                await RC(`fill ${AX - 2} ${S + 6} ${AZ - 2} ${AX + 2} ${S + 6} ${AZ + 2} stone`);
            },
            start: { dx: -8, dz: 0 }, dest: { dx: 0, dz: 0, up: 6 },
        },
        // ── 水（游泳横渡）──────────────────────────────────────────────
        {
            name: 'water-cross', want: ['walk'], deadlineMs: 120000,
            build: async () => {
                await reset();
                // 5 格宽、2 格深的水池
                await fillSafe(RC, AX - 3, G, AZ - 10, AX + 3, G + 1, AZ + 10, 'air');
                await fillSafe(RC, AX - 3, G, AZ - 10, AX + 3, G + 1, AZ + 10, 'water');
            },
            start: { dx: -10, dz: 0 }, dest: { dx: 10, dz: 0 },
        },
        // ── 沟（要垫方块）──────────────────────────────────────────────
        {
            name: 'gap-bridge', want: ['dig', 'jump', 'walk'],
            build: async () => {
                await reset();
                await fillSafe(RC, AX - 2, G, AZ - 6, AX + 2, G, AZ + 6, 'air');
            },
            start: { dx: -10, dz: 0 }, dest: { dx: 10, dz: 0 },
        },
    ];

    const outDir = join('tmp', 'bench');
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const outFile = join(outDir, `${stamp}-move-actions.jsonl`);

    const rows = [];
    for (const sc of scenarios) {
        await sc.build();
        await sleep(700);

        // ---- 干跑规划：证明这条路线真的需要这些 action ----
        //
        // ★ 必须先把她传送到起点再扫：mineflayer 只在她身边加载区块，
        //   人不在场时 blockAt 返回 null → 扫不到地形 → 误报 NO_START/NO_DATA。
        //   （第一版就是先扫后传，前 5 个场景全假失败。）
        const sx0 = AX + sc.start.dx, sz0 = AZ + sc.start.dz;
        const sy0 = S + (sc.start.up ?? 0);
        const tpOk0 = await tpSafe(RC, bot, NAME, sx0, sy0, sz0);
        const loaded = await waitLoaded(sx0, sy0, sz0);
        if (!tpOk0 || !loaded) {
            console.log(`  SKIP ${sc.name}: 传送未确认（tpOk=${tpOk0} loaded=${loaded}）`);
            continue;   // 不污染基线：传送没确认就整条跳过
        }
        // 起点合法性：脚下要实心、身上要是空。不合法就直接说清，别甩 NO_START 让人猜
        const bBelow = bot.blockAt(new Vec3(sx0, sy0 - 1, sz0));
        const bFeet = bot.blockAt(new Vec3(sx0, sy0, sz0));
        if (!instanceOfBlockOk(bBelow) || !instanceOfBlockOk(bFeet)) {
            console.log(`  SKIP ${sc.name}: 起点非法（脚下=${bBelow?.name} 身上=${bFeet?.name}）`);
        }

        const mapDir = join('tmp', 'bench-actions-map', sc.name);
        mkdirSync(mapDir, { recursive: true });
        let actionHist = {};
        try {
            const sx = sx0, sz = sz0;
            const dx = AX + sc.dest.dx, dz = AZ + sc.dest.dz;
            const startY = Math.floor(bot.entity.position.y);
            scanSphere(bot, mapDir, { x: sx, y: startY, z: sz }, 24);
            const plan = plan3D(mapDir,
                { x: sx, y: startY, z: sz },
                { x: dx, y: S + (sc.dest.up ?? 0), z: dz },
                { maxNodes: 60000, margin: 20 });
            if (plan.ok) {
                for (const step of plan.path) {
                    if (step.action === 'start') continue;
                    actionHist[step.action] = (actionHist[step.action] ?? 0) + 1;
                }
            } else {
                actionHist = { planFail: plan.code };
            }
        } catch (e) {
            actionHist = { planErr: String(e?.message ?? e).slice(0, 40) };
        }
        closeDb3d(mapDir);
        const gotWanted = sc.want.some((a) => (actionHist[a] ?? 0) > 0);

        // ---- 真跑 ----
        for (let round = 1; round <= ROUNDS; round++) {
            const sx = AX + sc.start.dx, sz = AZ + sc.start.dz;
            const dx = AX + sc.dest.dx, dz = AZ + sc.dest.dz;
            const tpOk = await tpSafe(RC, bot, NAME, sx, S + (sc.start.up ?? 0), sz);
            if (!tpOk) {
                console.log(`  SKIP ${sc.name} #${round}: 传送未确认`);
                continue;
            }
            await waitLoaded(sx, S + (sc.start.up ?? 0), sz);
            await sleep(400);
            const before = here();

            // 每个场景用自己的库（避免上一个场景的地形数据串味）
            const liveMapDir = join('tmp', 'bench-actions-map', sc.name);
            const t0 = Date.now();
            const r = await walkTo(bot, { x: dx, z: dz }, { mapDir: liveMapDir, deadlineMs: sc.deadlineMs ?? 60000, arriveTol: 2 });
            const ms = Date.now() - t0;
            const after = here();
            const remain = Math.hypot(dx - after.x, dz - after.z);
            const moved = Math.hypot(after.x - before.x, after.z - before.z);

            const row = {
                scenario: sc.name, round,
                want: sc.want.join('|'), actions: actionHist, wantHit: gotWanted,
                ok: !!r.ok, code: r.code ?? 'OK',
                ms, moved: +moved.toFixed(1), remain: +remain.toFixed(1),
                fromY: +before.y.toFixed(1), toY: +after.y.toFixed(1),
                msg: String(r.message ?? '').slice(0, 60),
            };
            rows.push(row);
            appendFileSync(outFile, JSON.stringify(row) + '\n', 'utf8');
            console.log(`  ${row.ok ? 'PASS' : 'FAIL'} ${sc.name.padEnd(14)} #${round} code=${row.code} ${ms}ms 走${row.moved} 剩${row.remain} y ${row.fromY}->${row.toY}  动作=${JSON.stringify(actionHist)}`);
        }
        closeDb3d(mapDir);
    }

    // ---- 汇总 ----
    console.log('\n=== 扩展基线汇总（按场景）===');
    const bySc = {};
    for (const r of rows) {
        bySc[r.scenario] ??= { n: 0, ok: 0, ms: 0, remain: 0, wantHit: r.wantHit, actions: r.actions };
        bySc[r.scenario].n++;
        if (r.ok) bySc[r.scenario].ok++;
        bySc[r.scenario].ms += r.ms;
        bySc[r.scenario].remain += r.remain;
    }
    for (const [name, s] of Object.entries(bySc)) {
        const hit = s.wantHit ? '' : '  ⚠️ 未命中目标动作';
        console.log(`  ${name.padEnd(15)} 成功 ${s.ok}/${s.n}  ${(s.ms / s.n).toFixed(0)}ms  剩 ${(s.remain / s.n).toFixed(1)}格  动作 ${JSON.stringify(s.actions)}${hit}`);
    }
    const okAll = rows.filter(r => r.ok).length;
    const codes = {};
    for (const r of rows) if (!r.ok) codes[r.code] = (codes[r.code] ?? 0) + 1;
    console.log(`  总计 成功 ${okAll}/${rows.length}  失败码 ${JSON.stringify(codes)}`);
    console.log(`  明细: ${outFile}`);

    await arena.release();
    try { rmSync(join('tmp', 'bench-actions-map'), { recursive: true, force: true }); } catch { }
    try { bot.quit(); } catch { }
    process.exit(0);
});
