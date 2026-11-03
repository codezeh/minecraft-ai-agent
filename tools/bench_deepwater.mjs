/**
 * 深水游泳验收（05 §665 原文：**"过 6 格宽 4 格深河 10 轮 9 过"**）。
 *
 * 为什么单独一个脚本（不改 `bench_move_actions.mjs`）：
 *   1. 45/55 是**可复现的既有口径**（11 场景 × 5 轮 + 每轮重建 + 深基岩），加场景就破坏可比性；
 *   2. 深水要 **10 轮**（05 §665），轮次也不一样；
 *   3. 分开跑更省时间：不用每次跑全套。
 *   → 产出**独立 jsonl**（`tmp/bench/deepwater-<日期>.jsonl`），不写进 `move-actions.jsonl`。
 *
 * 场景（t45 定稿）：
 *   · 河宽 **6 格**、深 **4 格**：水面 `G`，水到 `G-3`，**底下石头兜底**（防掉出世界）
 *   · 起点在**西岸**、终点在**东岸**（跨河 6 格）
 *   · **每轮重建场地**（`59b22b0` 的口径 —— 否则又是"复用上一轮挖出来的路"的假分数）
 *
 * 判据：
 *   · **≥9/10 通过**（05 §665）
 *   · `execActions['swim-step']` 出现次数 > 0（真的走了 swim 分支，不是绕过去）
 *   · `pillar-attempt` / `clear-feet` 应为 **0**（深水不该靠垫柱子/清脚下水过河）
 *   · **反向对照**：若 `swim` 步被误拦，必须能看到 `unsafe-landing` 事件及其 reason
 *     （真正的闸是 `executor.js:343` 的 `landing.t===T.WATER && !isSwim`，
 *       不是 `fallRisk` —— 2026-11-03 t37 实测：`fallRisk` 把 WATER 当"有支撑"，不会拦深水）
 *
 * 用法：
 *   node tools/bench_deepwater.mjs            # 默认 10 轮
 *   node tools/bench_deepwater.mjs 10         # 指定轮数
 *
 * ★ 纪律：跑前先归档旧 jsonl；确认 25566 上只有自己的 bot（bench 的 bot 名 `ma<时间戳>`）。
 * ★ 本脚本**不碰** `bench_move_actions.mjs`，两者可以各自跑，但**不要同时跑**（同一 arena）。
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rcon } from './rcon.mjs';
import { rentArena, fillSafe, tpSafe } from './arena.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { walkTo } from '../src/agent/library/executor.js';
import { scanSphere, closeDb3d } from '../src/agent/library/terrain3d.js';
import { plan3D } from '../src/agent/library/path_3d.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'ma' + (Date.now() % 100000);
const ROUNDS = Number(process.argv[2] ?? 10);

// ── 深水场景参数（05 §665：6 宽 × 4 深）────────────────────────────────
const RIVER_W = 6;      // 河宽 6 格（x 方向）
const RIVER_D = 4;      // 河深 4 格
const WANT_PASS = 9;    // 10 轮要 ≥9 过

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

const here = () => ({ x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z });
const instanceOfBlockOk = (b) => !!b && typeof b.name === 'string';

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

await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('bot 登录超时')), 40000);
    bot.once('spawn', () => { clearTimeout(t); res(); });
});
await new Promise((r) => setTimeout(r, 1200));

// ══════════════════════════════════════════════════════════════════════════
// 场地：租 arena（与 bench_move_actions 同一个 arena，所以**不要同时跑**）
// ══════════════════════════════════════════════════════════════════════════
const arena = await rentArena(RC);
const G = arena.groundY;      // 实心底面 y（脚位 = G+1）
const S = G + 1;
const AX = arena.x, AZ = arena.z;
console.log(`arena: x=${AX} z=${AZ} groundY=${G} | 深水场景 ${RIVER_W} 宽 × ${RIVER_D} 深`);

/**
 * 建深水河。**每轮都调**（`59b22b0` 口径：每轮重建，5/10 轮才真正独立）。
 *
 * 几何（沿 Z 方向挖一条横贯的河，起点在西岸、终点在东岸）：
 *   · 河面 x ∈ [AX - RIVER_W/2, AX + RIVER_W/2 - 1]（6 格宽）
 *   · 水深 RIVER_D：从水位 G 往下 RIVER_D-1 格是水，底下一层石头兜底
 *   · 水面 = G（与地面同高，这样岸上走过去是平的，只需跨水）
 *   · 两侧岸保持 stone 地面
 */
async function build() {
    // 1) 清场（与 bench_move_actions 的 reset 同口径：清空 + 地面 + 深层基岩兜底）
    await fillSafe(RC, AX - 26, S, AZ - 26, AX + 26, S + 24, AZ + 26, 'air');
    await fillSafe(RC, AX - 26, G, AZ - 26, AX + 26, G, AZ + 26, 'stone');
    await fillSafe(RC, AX - 26, G - 6, AZ - 26, AX + 26, G - 6, AZ + 26, 'bedrock');

    // 2) 挖河：从 G 往下挖 RIVER_D 格（含水面那格），x 跨 6 格，z 横贯全场
    const x0 = AX - Math.floor(RIVER_W / 2);
    const x1 = x0 + RIVER_W - 1;
    await fillSafe(RC, x0, G - (RIVER_D - 1), AZ - 26, x1, G, AZ + 26, 'air');
    // 3) 河底石头兜底（防掉出世界 —— 也防止她钻到基岩层）
    await fillSafe(RC, x0, G - RIVER_D, AZ - 26, x1, G - RIVER_D, AZ + 26, 'stone');
    // 4) 灌水：水到 G-3（深 4 格 = G, G-1, G-2, G-3）
    await fillSafe(RC, x0, G - (RIVER_D - 1), AZ - 26, x1, G, AZ + 26, 'water');
}

// 起点在西岸（河左边 4 格），终点在东岸（河右边 4 格）
const startDx = -(Math.ceil(RIVER_W / 2) + 4);
const destDx = Math.ceil(RIVER_W / 2) + 4;

const outDir = join('tmp', 'bench');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const outFile = join(outDir, `deepwater-${stamp}.jsonl`);
// 独立文件：每次跑覆盖（不 append 到 move-actions.jsonl，保证 45/55 口径不受影响）
if (existsSync(outFile)) {
    const arch = join(outDir, 'archive');
    mkdirSync(arch, { recursive: true });
    const { renameSync } = await import('node:fs');
    renameSync(outFile, join(arch, `deepwater-${stamp}-${Date.now()}.jsonl`));
    console.log(`旧的 ${outFile} 已归档到 archive/`);
}
writeFileSync(outFile, '');
console.log(`输出（独立 jsonl，不动 move-actions 基线）：${outFile}`);

// ══════════════════════════════════════════════════════════════════════════
// 10 轮
// ══════════════════════════════════════════════════════════════════════════
const rows = [];
const flakes = [];

for (let round = 1; round <= ROUNDS; round++) {
    // ★ 每轮重建场地（否则 r2+ 走的是 r1 挖出来的路 = 假分数）
    await build();
    await sleep(500);

    // 补给（跨水要垫方块/挖，给足）
    await RC(`gamemode creative ${NAME}`);
    await RC(`give ${NAME} dirt 64`);
    await RC(`give ${NAME} diamond_pickaxe 1`);
    await RC(`gamemode survival ${NAME}`);
    await sleep(300);

    const sx = AX + startDx, sz = AZ;
    const dx = AX + destDx, dz = AZ;

    const tpOk = await tpSafe(RC, bot, NAME, sx, S, sz);
    if (!tpOk) { flakes.push({ round, why: 'tpSafe false' }); console.log(`  ⊘ #${round} 传送未确认，跳过`); continue; }
    const loaded = await waitLoaded(sx, S, sz);
    if (!loaded) { flakes.push({ round, why: '区块未加载' }); console.log(`  ⊘ #${round} 区块未加载，跳过`); continue; }
    await sleep(400);

    // 起点合法性（脚下实心、身上是空）
    const bBelow = bot.blockAt(new Vec3(sx, S - 1, sz));
    const bFeet = bot.blockAt(new Vec3(sx, S, sz));
    if (!instanceOfBlockOk(bBelow) || (bFeet && bFeet.boundingBox === 'block')) {
        flakes.push({ round, why: `起点非法(脚下=${bBelow?.name} 身上=${bFeet?.name})` });
        console.log(`  ⊘ #${round} 起点非法，跳过`);
        continue;
    }

    const before = here();
    const startExpect = { x: sx + 0.5, y: S, z: sz + 0.5 };
    const dStart = Math.hypot(before.x - startExpect.x, before.z - startExpect.z);
    if (dStart > 5 || Math.abs(before.y - startExpect.y) > 4) {
        flakes.push({ round, dStart: +dStart.toFixed(1), why: '开跑时不在起点' });
        console.log(`  ⊘ #${round} TPFLAKE 偏 ${dStart.toFixed(1)} 格，跳过`);
        continue;
    }

    // 干跑规划（证明这条路线**需要 swim**）—— 与 bench_move_actions 同口径
    const mapDir = join('tmp', 'bench-actions-map', 'deepwater');
    mkdirSync(mapDir, { recursive: true });
    let planHist = {};
    try {
        const startY = Math.floor(bot.entity.position.y);
        scanSphere(bot, mapDir, { x: sx, y: startY, z: sz }, 24);
        const plan = plan3D(mapDir, { x: sx, y: startY, z: sz }, { x: dx, y: S, z: dz }, { maxNodes: 60000, margin: 20 });
        if (plan.ok) {
            for (const step of plan.path) {
                if (step.action === 'start') continue;
                planHist[step.action] = (planHist[step.action] ?? 0) + 1;
            }
        } else planHist = { planFail: plan.code };
    } catch (e) { planHist = { planErr: String(e?.message ?? e).slice(0, 40) }; }
    closeDb3d(mapDir);
    const planHasSwim = (planHist.swim ?? 0) > 0;

    // ── 真跑 ────────────────────────────────────────────────────────
    const execActions = {};
    const unsafeEvents = [];
    const countEvent = (e) => {
        if (!e || !e.type) return;
        execActions[e.type] = (execActions[e.type] ?? 0) + 1;
        if (String(e.type).startsWith('unsafe')) unsafeEvents.push({ type: e.type, why: e.why ?? null, action: e.action ?? null });
    };
    const t0 = Date.now();
    const r = await walkTo(bot, { x: dx, z: dz }, {
        mapDir, deadlineMs: 120000, arriveTol: 2, onEvent: countEvent,
    });
    const ms = Date.now() - t0;
    const after = here();
    const remain = Math.hypot(dx - after.x, dz - after.z);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);

    // 死亡/重生作废（位移远超场地跨度）
    if (moved > 200 || remain > 256) {
        flakes.push({ round, why: '疑似死亡重生', moved: +moved.toFixed(0) });
        console.log(`  ⊘ #${round} 死亡/重生（位移 ${moved.toFixed(0)}）→ 作废`);
        continue;
    }

    const row = {
        scenario: 'deep-water', round,
        riverW: RIVER_W, riverD: RIVER_D,
        planHasSwim, plan: planHist,
        ok: !!r.ok, code: r.code ?? 'OK',
        ms, moved: +moved.toFixed(1), remain: +remain.toFixed(1),
        execActions,
        swimSteps: execActions['swim-step'] ?? 0,
        pillarAttempt: execActions['pillar-attempt'] ?? 0,
        clearFeet: execActions['clear-feet'] ?? 0,
        unsafeEvents,
    };
    rows.push(row);
    writeFileSync(outFile, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');

    const flag = row.ok ? 'PASS' : 'FAIL';
    console.log(`  ${flag} deep-water #${round} code=${row.code} ${ms}ms `
        + `swim-step=${row.swimSteps} pillar=${row.pillarAttempt} clear-feet=${row.clearFeet} `
        + `moved=${row.moved} 剩${row.remain}`
        + (unsafeEvents.length ? ` ⚠unsafe=${JSON.stringify(unsafeEvents.slice(0, 2))}` : ''));
}

// ══════════════════════════════════════════════════════════════════════════
// 汇总与断言
// ══════════════════════════════════════════════════════════════════════════
const n = rows.length;
const passed = rows.filter((r) => r.ok).length;
const withSwim = rows.filter((r) => r.swimSteps > 0).length;
const withPillar = rows.filter((r) => r.pillarAttempt > 0).length;
const withClear = rows.filter((r) => r.clearFeet > 0).length;
const msList = rows.map((r) => r.ms).sort((a, b) => a - b);
const median = msList.length ? msList[Math.floor(msList.length / 2)] : 0;

console.log('\n════════ 深水游泳汇总（05 §665）════════');
console.log(`  轮数(有效) ${n} / 计划 ${ROUNDS}｜作废 ${flakes.length}｜通过 ${passed}｜要求 ≥${WANT_PASS}`);
console.log(`  中位耗时 ${median}ms`);
console.log(`  走过 swim 分支的轮数 ${withSwim}/${n}`);
console.log(`  出现 pillar-attempt 的轮数 ${withPillar}/${n}（应为 0）`);
console.log(`  出现 clear-feet 的轮数 ${withClear}/${n}（应为 0）`);
if (flakes.length) console.log('  作废轮明细: ' + JSON.stringify(flakes));
console.log(`  明细: ${outFile}`);

let pass = 0, fail = 0;
const chk = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS ${name} —— ${detail}`); }
    else { fail++; console.log(`  FAIL ${name} —— ${detail}`); }
};
console.log('');
chk(`★ 05 §665：${ROUNDS} 轮 ≥${WANT_PASS} 过`, passed >= WANT_PASS, `${passed}/${n}`);
chk('真的走了 swim 分支（swim-step>0，不是绕过去/垫过去）', withSwim >= WANT_PASS, `${withSwim}/${n} 轮有 swim-step`);
chk('深水不该靠垫柱子（pillar-attempt 应为 0）', withPillar === 0, `${withPillar} 轮出现 pillar-attempt`);
chk('深水不该靠清脚下水（clear-feet 应为 0）', withClear === 0, `${withClear} 轮出现 clear-feet`);
chk('没有被落点闸误拦（无 unsafe-landing/swim 被拒）',
    rows.every((r) => !r.unsafeEvents.some((e) => e.type === 'unsafe-landing')),
    JSON.stringify(rows.flatMap((r) => r.unsafeEvents).slice(0, 3)));

console.log(`\n════════ 深水断言 ════════`);
console.log(`${pass}/${pass + fail} 条通过`);
try { bot.quit(); } catch { }
await sleep(500);
process.exit(fail ? 1 : 0);
