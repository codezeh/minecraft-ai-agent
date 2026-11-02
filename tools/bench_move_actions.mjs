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
 * ═══════════════════════════════════════════════════════════════════
 * ★ 场景设计规约（两条，都是踩过两次才写的，造新场景前先读）
 *
 *   1) **想逼出某个 action，障碍物就必须封死所有绕行方向。**
 *      反例：dig-through 的墙只铺 ±12（她从两端绕过去，"通过"了但直方图里没有 dig）；
 *            digdown 的台子只铺 AZ±6（她从南北走过去，直方图纯 {"walk":32}）。
 *      做法：横贯场地（AZ±26），或直接铺满。
 *
 *   2) **终点不能落在"水平上已经算到达"的位置。**
 *      `walkTo` 只按**水平**距离判到达（arriveTol，默认 2 格），完全不看 y。
 *      反例一（climb-ladder）：起点本来就在柱子那一列 → 0ms 报成功、根本没爬。
 *      反例二（digdown v1）：终点放在盖板正下方 → 她站在盖顶、水平距离已进 arriveTol
 *             → 判到达，规划里那步 `down` 压根没执行（y 全程不变）。
 *      做法：让终点与"她能站的那一面"在**水平**上至少隔开 arriveTol 以上，
 *            使最后那段垂直移动成为到达的必要条件。
 *
 *   3) 想验证"某个派生分支被执行到"，别只看干跑直方图 —— 干跑直方图只含
 *      plan3D 产出的动作（start/walk/jump/down/dig/climb）。像 `digdown` 这种
 *      **executor 执行期的派生分支**（executor.js:261）必须数执行期事件：
 *      本脚本已把 `onEvent` 接进 walkTo，每行 jsonl 记 `execActions` / `digdownSeen`。
 *
 *   4) **传送噪声（tpFlake）单列，不计入通过率分母。**
 *      `tpSafe` 三次重试后仍可能没把她送到起点（实测过一次：`moved 11456 格 /
 *      60s TIMEOUT / scan3d×10`，跑的是"从出生点横跨一万格"）。本脚本在**开跑那一刻**
 *      再核一次起点（偏 >5 格或 Δy >4 即判 tpFlake），跳过该轮并单独计数。
 *      把它算成失败会稀释基准，让真正的回归看不出来。
 *
 * ═══════════════════════════════════════════════════════════════════
 * ★ 跑之前必做（纪律，2026-11-01 两人各犯过一次）：**先归档上一次的 jsonl**。
 *
 *     mv tmp/bench/<日期>-move-actions.jsonl tmp/bench/archive/<日期>-<用途>.jsonl
 *
 *   为什么：本脚本是 `appendFileSync` 追加写。不归档就会把上一轮的基线和新数据
 *   混进同一个文件（实测出现过 110 行 = 两轮各 55 行混在一起，"基线"从此不可信）。
 * ═══════════════════════════════════════════════════════════════════
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
        // ── digdown（站在顶盖上，目标在同列的下层地面 → 必须往下挖穿）──────
        //
        // ★ 2026-11-01（t6 专项）：改了三处，目标只有一个 —— 让 executor 的
        //   **digdown 派生分支**（`dy < -1 && dxz < 1.5 && 脚下实心`）真的被走到。
        //
        //   ① 删掉原来 `AX+8` 那条竖空气槽：它把顶盖打通了，她直接从槽里走下去，
        //      永远不需要挖。
        //   ② 顶盖铺满整个场地（AX/AZ 都是 ±26）：原来只铺 X∈[AX-4,AX+12]，
        //      她可以从 X 边缘走下去、再在地面层绕到目标点下方（G+1 那层是通的）。
        //      铺满之后**没有任何绕行方向**，下去的唯一办法就是挖穿顶盖。
        //   ③ 目标点与起点**同一列**（dx 只差 7 格、同一 dz），且比起点低 3 格 ——
        //      这样规划出的那一步一定是"同列往下掉 3 格"，正是 digdown 的触发条件。
        //      同时两点距离 7 格 < scanSphere 半径 24，扫描能同时看到上下两层地面。
        //
        //   为什么起点要 `up: 3`：顶盖在 G+3，站在盖上的脚位是 G+4 = S+3。
        {
            name: 'digdown', want: ['digdown', 'dig', 'down'],
            build: async () => {
                await reset();
                // 顶盖：1 格厚，Z 方向铺满全场（封死南北绕行），X 方向止于 AX+8（见下面 ④）。
                // 下面 G+1~G+2 是空气（reset 清出来的），于是有盖的列都有**两个可站立面**：
                // 盖顶(G+4) 与 地面(G+1)。
                await fillSafe(RC, AX - 8, G + 3, AZ - 26, AX + 8, G + 3, AZ + 26, 'stone');
            },
            //   ④ **盖板必须止于目标之前**：第一版把盖铺满全场、目标在盖的正下方，
            //      结果她站在盖顶、水平距离已在 arriveTol(2) 内 → walkTo 直接判到达，
            //      规划的 `down` 那一步根本没被执行（实测 执行={"scan3d":1,"plan3d":1}、
            //      y 全程 -57 不变）。walkTo 只按**水平**距离判到达，所以终点不能待在盖正下方。
            //      现在盖只铺到 AX+8，目标在 AX+16：她在盖沿必须下降 3 格才走得完剩下的 8 格。
            //      离线用 terrain3d.saveSurfaces + plan3D 验过：直方图 {"walk":19,"down":1}，
            //      其中那步 down 是 dy=-3 / dxz=1（正是 executor.js:261 的触发条件）。
            start: { dx: -4, dz: 0, up: 3 }, dest: { dx: 16, dz: 0 },
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
                // ★ 2026-11-01（captain 实测修复）：**沟底必须有地板，否则她会掉出世界**。
                //
                // 实测日志：`[23:48:12] ma67453 fell out of the world` —— 原来的沟
                // 直接挖到 G，而 G 下面是虚空；她搭不过去就掉下去摔死，重生在出生点，
                // 然后 walkTo 从出生点往 10000 格外走 → 那一轮变成
                // `moved 11456 格 / 60s TIMEOUT`。
                //
                // 这个现象之前被 atoms 和 verify 都归因成"tpFlake（传送没生效）"，
                // **是错的**：tp 明明生效了，是她在跑的过程中死亡重生。
                // 场景层修掉：沟底铺一层实心（G-3），掉下去只是"困在坑里"这种正常失败，
                // 不会死、不会重生、不会产生 1 万格的假位移。
                await fillSafe(RC, AX - 2, G, AZ - 6, AX + 2, G, AZ + 6, 'air');
                await fillSafe(RC, AX - 2, G - 3, AZ - 6, AX + 2, G - 3, AZ + 6, 'stone');
            },
            start: { dx: -10, dz: 0 }, dest: { dx: 10, dz: 0 },
        },
    ];

    const outDir = join('tmp', 'bench');
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const outFile = join(outDir, `${stamp}-move-actions.jsonl`);

    const rows = [];
    // ★ 2026-11-01：tpFlake 单列，**不计入通过率分母**。
    // 起因：gap-bridge 出现过 `moved 11456 格 / 60s TIMEOUT`，她根本没被传到起点，
    // 跑的是"从出生点横跨一万格"。把它算成一次失败会稀释基准，让真正的回归看不出来。
    const tpFlakes = [];
    for (const sc of scenarios) {
        await sc.build();
        await sleep(700);

        // ★ 2026-11-01：**每个场景都要补一次补给**，不能只在开场给一次。
        //
        // 实测（t4 报告）：前面场景把 64 块 dirt 用完（pad/pillar 要垫方块），
        // 后面的场景就开始以 `NO_ITEM 没有可垫脚的方块` 失败 ——
        // 那是"背包空了"，不是"路径/按键坏了"，会被误判成回归。
        // 同理补镐（dig-through / digdown 要挖）。
        await RC(`gamemode creative ${NAME}`);
        await RC(`give ${NAME} dirt 64`);
        await RC(`give ${NAME} diamond_pickaxe 1`);
        await RC(`gamemode survival ${NAME}`);
        await sleep(300);

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
            // ★★ 2026-11-03（verify 定位的结构性问题）：**每轮重建场地**。
            //
            // 原来 `build()` 在每个场景开头只跑一次，5 轮共用同一份场地。
            // 而 water-cross 最"破坏性"：`clear-feet` 挖掉脚下水块、反复 pillar/垫方块
            // → **r1 的扰动留在池子里，r2 面对的已不是原始几何**。
            //
            // 实测证据（两轮连跑都挂在同一位置，不是抖动）：
            //   t25 r2: NO_REACH 38851ms  moved 9.6   pillar-attempt 26  oscillation 1
            //   t27 r2: NO_REACH 50981ms  moved 12.5  pillar-attempt 38  clear-feet 14
            //   两次的 r1/r3/r4/r5 都过。
            // 后果：`48/55` 里那 1 个失败是**被自己上一轮挖坏的地形**造成的，
            // 不是代码回归 —— 这会污染每一次基线对比。
            //
            // 重建放在 tp 之前：先把场地恢复原状，再把她传到起点，5 轮才真正独立。
            // （干跑扫描在轮循环之前、用的是原始场景，不受影响。）
            await sc.build();
            await sleep(400);

            const sx = AX + sc.start.dx, sz = AZ + sc.start.dz;
            const dx = AX + sc.dest.dx, dz = AZ + sc.dest.dz;
            const tpOk = await tpSafe(RC, bot, NAME, sx, S + (sc.start.up ?? 0), sz);
            if (!tpOk) {
                console.log(`  SKIP ${sc.name} #${round}: 传送未确认`);
                tpFlakes.push({ scenario: sc.name, round, why: 'tpSafe 返回 false' });
                continue;
            }
            await waitLoaded(sx, S + (sc.start.up ?? 0), sz);
            await sleep(400);
            const before = here();

            // ★ 2026-11-01（t10 报告 tpFlake 后修）：**开跑前最后一道起点校验**。
            //
            // 为什么 tpSafe 不够：`tpSafe` 只判"位置是否落在目标 ±2 格内"，
            // 但实测出现过一次 `tpSafe` 返回 true、她实际却不在起点的情况
            // （gap-bridge #1：`moved 11456 格 / 60s TIMEOUT / scan3d×10`，
            //  后 4 轮同场景全过 `moved 19.8 / 7.7s`）。那一轮跑的是"从出生点横跨一万格"，
            // 不是 gap-bridge —— 假失败。
            //
            // 所以不管什么原因让她不在起点（tp 部分生效 / 物理把她弹走 / 位置守卫回位），
            // 一律在**开跑那一刻**再核一次。差得远就标 `tpFlake` 并跳过，
            // **不计入通过率分母**（否则基准会被这种噪声稀释，看不出真正的回归）。
            const startExpect = { x: sx + 0.5, y: S + (sc.start.up ?? 0), z: sz + 0.5 };
            const dStart = Math.hypot(before.x - startExpect.x, before.z - startExpect.z);
            if (dStart > 5 || Math.abs(before.y - startExpect.y) > 4) {
                tpFlakes.push({ scenario: sc.name, round, dStart: +dStart.toFixed(1), dy: +(before.y - startExpect.y).toFixed(1), at: before });
                console.log(`  ⊘ TPFLAKE ${sc.name} #${round}: 起点不对（偏 ${dStart.toFixed(1)} 格 / Δy ${(before.y - startExpect.y).toFixed(1)}）—— 本轮跳过，不计入分母`);
                continue;
            }

            // 每个场景用自己的库（避免上一个场景的地形数据串味）
            const liveMapDir = join('tmp', 'bench-actions-map', sc.name);
            const t0 = Date.now();
            // ★ 2026-11-01（t6）：**执行期动作计数**。
            //   干跑直方图来自 plan3D，而 plan3D 的动作只有 start/walk/jump/down/dig/climb ——
            //   `digdown` 根本不是规划出来的动作，它是 executor 里的派生分支
            //   （executor.js:261：dy<-1 且同列且脚下实心）。所以"直方图里出现 digdown"
            //   在原理上不可能，只能从执行期事件里数（executor.js:287 会发 {type:'digdown'}）。
            const execActions = {};
            const countEvent = (e) => {
                if (!e || !e.type) return;
                execActions[e.type] = (execActions[e.type] ?? 0) + 1;
            };
            const r = await walkTo(bot, { x: dx, z: dz }, { mapDir: liveMapDir, deadlineMs: sc.deadlineMs ?? 60000, arriveTol: 2, onEvent: countEvent });
            const ms = Date.now() - t0;
            const after = here();
            const remain = Math.hypot(dx - after.x, dz - after.z);
            const moved = Math.hypot(after.x - before.x, after.z - before.z);

            // ★ 2026-11-01（captain 实测定性的真凶）：**死亡重生检测**。
            //
            // `tpSafe` 只保证"开跑时她在起点"，管不了"跑到一半死掉"。
            // 实测：`[23:48:12] ma67453 fell out of the world` —— 掉进虚空摔死，
            // 重生在出生点（0,0），于是 after 离起点 11456 格，看起来像"她横跨了一万格"。
            //
            // 这种轮次跑的不是被测场景，必须**单列、不计入分母**：
            // 位移 > 200 格 = 不可能是场景内的正常移动（本场地最大跨度 ~56 格）。
            const DIED_RADIUS = 200;
            if (moved > DIED_RADIUS || remain > DIED_RADIUS + 56) {
                tpFlakes.push({
                    scenario: sc.name, round, why: '疑似死亡重生（位移/剩余远超场地跨度）',
                    moved: +moved.toFixed(0), remain: +remain.toFixed(0),
                    at: { x: Math.round(after.x), y: Math.round(after.y), z: Math.round(after.z) },
                });
                console.log(`  ⊘ 死亡/重生 ${sc.name} #${round}: 位移 ${moved.toFixed(0)} 格、剩 ${remain.toFixed(0)} 格 `
                    + `（场地跨度 ~56，这不可能是正常移动）→ 本轮作废，不计入分母`);
                continue;
            }

            const row = {
                scenario: sc.name, round,
                want: sc.want.join('|'), actions: actionHist, wantHit: gotWanted,
                ok: !!r.ok, code: r.code ?? 'OK',
                ms, moved: +moved.toFixed(1), remain: +remain.toFixed(1),
                fromY: +before.y.toFixed(1), toY: +after.y.toFixed(1),
                execActions,
                digdownSeen: (execActions.digdown ?? 0) > 0,
                msg: String(r.message ?? '').slice(0, 60),
            };
            rows.push(row);
            appendFileSync(outFile, JSON.stringify(row) + '\n', 'utf8');
            console.log(`  ${row.ok ? 'PASS' : 'FAIL'} ${sc.name.padEnd(14)} #${round} code=${row.code} ${ms}ms 走${row.moved} 剩${row.remain} y ${row.fromY}->${row.toY}  动作=${JSON.stringify(actionHist)}` +
                `  执行=${JSON.stringify(execActions)}${row.digdownSeen ? ' ★digdown' : ''}`);
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
    const denom = rows.length;
    console.log(`  总计 成功 ${okAll}/${denom}${denom ? ` (${(okAll / denom * 100).toFixed(1)}%)` : ''}  失败码 ${JSON.stringify(codes)}`);
    // tpFlake 单列：分母只算"真正跑了的轮次"，被传送噪声废掉的轮不计入
    if (tpFlakes.length) {
        console.log(`  ⊘ tpFlake ${tpFlakes.length} 轮（已排除出分母，不计失败）:`);
        for (const f of tpFlakes) {
            console.log(`      ${f.scenario} #${f.round}  ${f.why ?? `起点偏 ${f.dStart} 格 / Δy ${f.dy}`}`);
        }
        console.log(`    → 期望总轮次 ${denom + tpFlakes.length}，实跑 ${denom}；比较基准时请用 ${okAll}/${denom}`);
    }
    console.log(`  明细: ${outFile}`);

    await arena.release();
    try { rmSync(join('tmp', 'bench-actions-map'), { recursive: true, force: true }); } catch { }
    try { bot.quit(); } catch { }
    process.exit(0);
});
