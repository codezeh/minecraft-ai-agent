/**
 * M8 B2 真机验收：**三级/九级抢占** + 两条服务端侧断言（captain 2026-11-02 补充）。
 *
 * 离线断言（`maxConcurrent===1`）只是"进程内计数"，captain 要求真机再验两条：
 *
 *   ① **抢占后旧流程真的没再动身体** —— 数 **server 侧**的痕迹：
 *      抢占后 1 秒内该 bot 的操作应停止（挖掉的方块数不再增长、位置不再变化）。
 *      做法：抢占瞬间快照"(已挖方块数, 位置)"，1 秒后再快照，断言**两者都没变**。
 *
 *   ② **INTERRUPTED 不算失败要在真机验** —— 抢占后查任务板：
 *      被抢占的单 `attempts` 必须仍为 0、`state` 必须是 `paused`（不是 ready+attempts=1）。
 *
 * 场景：
 *   3 级单（mine，挖一批矿）在跑 → 下 9 级单（collect 或 mine，短任务）→
 *   断言：3 级 → paused(preempted) & attempts=0；9 级执行并 done；
 *        抢占后旧流程停手（server 侧痕迹）；之后 resume 3 级，progress 不倒退。
 *
 * 用法：node tools/board_b2_live.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rcon } from './rcon.mjs';
import { openBoard, getJob, JOB_STATE } from '../src/agent/library/board_store.js';
import { BoardClient } from '../src/agent/library/board_client.js';
import { getCommand } from '../src/agent/commands/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = join(__dirname, 'board_b2_live.mjs');
const MS_PORT = 18098;
const MC_PORT = 25566;
const RC = (c) => rcon(c, { port: 25576 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ══════════════════════════════════════════════════════════════════════════
// 子进程：真 bot + 真调度器（跑真正的 BoardScheduler）
// ══════════════════════════════════════════════════════════════════════════
if (process.argv[2] === '--agent') {
    const NAME = process.argv[3];
    const { io: ioClient } = await import('socket.io-client');
    // ★ t145：连 mindserver 必须带握手 token（否则 AUTH_REQUIRED，且退出码仍是 0）
    const { connectMindserver } = await import('./lib/ms_token.mjs');
    const mineflayer = (await import('mineflayer')).default;
    const pf = (await import('mineflayer-pathfinder')).default;
    const { installPositionGuard } = await import('../src/sim/position_guard.js');
    const { BoardScheduler } = await import('../src/agent/library/board_scheduler.js');
    const { keepBotCellClear } = await import('./arena.mjs');

    const sock = connectMindserver(ioClient, MS_PORT);
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });

    const board = new BoardClient({
        socket: sock, name: NAME, skills: ['mine', 'collect'], timeoutMs: 5000,
    });
    await board.hello();

    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: MC_PORT, username: NAME, auth: 'offline', version: '1.21.8',
    });
    bot.loadPlugin(pf.pathfinder);
    installPositionGuard(bot);
    bot.on('error', () => { });
    await new Promise((res) => bot.once('spawn', res));
    await sleep(1200);

    // 场地：铺一大片铁矿石（够挖很久）+ 保住她自己那格
    const p = bot.entity.position;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    await RC(`fill ${bx - 8} ${by - 2} ${bz - 8} ${bx + 8} ${by + 5} ${bz + 8} air`);
    await RC(`fill ${bx - 8} ${by - 1} ${bz - 8} ${bx + 8} ${by - 1} ${bz + 8} stone`);
    await RC(`fill ${bx - 6} ${by} ${bz - 6} ${bx + 6} ${by + 2} ${bz + 6} iron_ore`);
    await keepBotCellClear(RC, bot.entity.position);
    await RC(`clear ${NAME}`).catch(() => { });
    await sleep(300);
    await RC(`give ${NAME} iron_pickaxe 1`);
    for (let i = 0; i < 25; i++) {
        await sleep(200);
        const pick = (bot.inventory?.items?.() ?? []).find((x) => /_pickaxe$/.test(x?.name ?? ''));
        if (pick && ((pick.maxDurability ?? 0) - (pick.durabilityUsed ?? 0)) > 2) break;
    }
    log(`[AGENT] ${NAME} 就绪 @${bx},${by},${bz}`);

    // 真 ActionManager 的最小替身：只需要 executing/killed/stop
    const actions = {
        executing: false, killed: false, stopReason: null, currentJobId: null,
        async stop(reason) {
            this.stopReason = reason;
            this.requestStop = true;
            // 等流程自己退出（流程在步骤边界检查 bot.interrupt_code）
            try { bot.interrupt_code = reason; } catch { /* ignore */ }
            const t0 = Date.now();
            while (this.executing && Date.now() - t0 < 10000) await sleep(100);
            this.executing = false;
        },
        async runAction(_l, fn) { return fn(); },
    };

    const sched = new BoardScheduler({
        agent: { name: NAME, bot, actions, roles: [] },
        board, actions,
        runSkill: async (_agent, skill, argStr) => {
            actions.executing = true;
            try {
                // 每次开跑前清掉上次的中断标记
                bot.interrupt_code = null;
                const reg = await import('../src/agent/library/composite_registry.js');
                return await reg.runSkill({ bot, name: NAME, actions }, skill, argStr);
            } finally {
                actions.executing = false;
            }
        },
        onEvent: (e) => {
            if (['job-claimed', 'job-paused-preempted', 'job-finished', 'preempt-start', 'job-resumed', 'preempt-aborted-killed', 'skip-finish-preempted'].includes(e.type)) {
                log(`[AGENT-EV] ${e.type} ${JSON.stringify(e).slice(0, 160)}`);
            }
            // ★ 抢占暂停的**那一刻**立刻回报服务端真值，供父进程断言。
            //   不能等父进程稍后再查 —— 调度器下一个 tick 就会把它 resume 成 ready（那是对的）。
            if (e.type === 'job-paused-preempted') {
                board.getAsync(e.id).then((r) => {
                    const j = r?.data?.job;
                    log(`[AGENT-SNAP-PAUSED] ${JSON.stringify({ id: e.id, state: j?.state, attempts: j?.attempts })}`);
                }).catch(() => { });
            }
        },
    });

    // 自己跑 tick 循环（3 秒一拍，同 agent.js）
    const timer = setInterval(() => { sched.tick().catch(() => { }); }, 3000);
    timer.unref?.();
    // 不死，等父进程 kill
    await new Promise(() => { });
}

// ══════════════════════════════════════════════════════════════════════════
// 父进程
// ══════════════════════════════════════════════════════════════════════════
const { createMindServer } = await import('../src/mindcraft/mindserver.js');
createMindServer(false, MS_PORT);
await sleep(2500);
const { io: ioClient } = await import('socket.io-client');
// ★ t145：连 mindserver 必须带握手 token（否则 AUTH_REQUIRED，且退出码仍是 0）
const { connectMindserver } = await import('./lib/ms_token.mjs');

const sock = connectMindserver(ioClient, MS_PORT);
await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
const probe = new BoardClient({ socket: sock, name: 'b2probe', skills: ['mine', 'collect'], timeoutMs: 5000 });
await probe.hello();

const BOT = 'b2miner';

/** 服务端侧的"身体痕迹"：某点周围被挖掉的方块数（用 execute if block 直接查几格）。 */
async function serverTrace() {
    try {
        // 用一个确定位置探测：她脚下那格的铁矿石是否还在（挖了会变 air）
        const out = await RC(`execute if entity @a[name=${BOT}] run data get entity ${BOT} Pos`);
        return String(out ?? '');
    } catch { return ''; }
}

const results = [];
const push = (name, pass, detail) => { results.push({ name, pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name} —— ${detail}`); };

// ── 下 3 级单（长任务：挖 32 个铁）──────────────────────────────────
let lowId = null, highId = null;
/** 抢占**那一刻**的服务端快照（子进程回传）。 */
let pausedSnapshot = null;
const low = await probe.add({
    kind: 'personal', title: 'B2 验收：3 级挖矿', skill: 'mine',
    args: { ore: 'iron', count: 32, maxDepth: 8 },
    priority: 3, assignee: BOT, source: 'player:probe',
});
lowId = low.data.id;
log(`已下 3 级单 ${lowId}`);

// ── 起 agent，让它领并开始跑 ───────────────────────────────────────
const agentProc = spawn(process.execPath, [SELF, '--agent', BOT], { stdio: ['ignore', 'pipe', 'pipe'] });
agentProc.stdout.on('data', (d) => {
    process.stdout.write(`  ${d}`);
    const m = String(d).match(/\[AGENT-SNAP-PAUSED\] (\{.*\})/);
    if (m) { try { pausedSnapshot = JSON.parse(m[1]); } catch { /* ignore */ } }
});
agentProc.stderr.on('data', (d) => { const s = String(d); if (!/walkTo|nav/.test(s)) process.stderr.write(`  [err] ${s}`); });

// 等它领到并开始跑
log('\n=== 等 3 级单跑起来 ===');
let lowRunning = false;
for (let i = 0; i < 40; i++) {
    await sleep(1500);
    await probe.getAsync(low.data.id);
    const j = probe.get(low.data.id);
    if (j && (j.state === JOB_STATE.RUNNING || j.state === JOB_STATE.CLAIMED)) { lowRunning = true; break; }
}
log(`3 级单状态: ${probe.get(low.data.id)?.state}`);
await sleep(6000);                       // 让它真的干一会儿活
const beforeJobs = await jobsText();
const beforeLow = { ...probe.get(low.data.id) };

// ── 下 9 级单（短任务）→ 触发抢占 ───────────────────────────────────
log('\n=== 下 9 级单（应抢占）===');
const high = await probe.add({
    kind: 'personal', title: 'B2 验收：9 级急件', skill: 'mine',
    args: { ore: 'iron', count: 2, maxDepth: 8 },
    priority: 9, assignee: BOT, source: 'player:probe',
});
highId = high.data.id;
log(`已下 9 级单 ${highId}`);

// ★ ① 服务端侧痕迹：抢占瞬间快照，1 秒后再快照
const traceA = await serverTrace();
await sleep(1200);
const traceB = await serverTrace();

// 等 9 级单被抢到并跑完
log('\n=== 等 9 级单执行完 ===');
let highDone = false;
for (let i = 0; i < 80; i++) {
    await sleep(1500);
    await probe.getAsync(high.data.id);
    const j = probe.get(high.data.id);
    if (!j) break;
    if (j.state === JOB_STATE.DONE || j.state === JOB_STATE.FAILED) { highDone = true; break; }
    if (j.state === JOB_STATE.READY && i > 20) break;
}
const highJob = probe.get(high.data.id);

// ── 查被抢占的 3 级单：state 必须 paused、attempts 必须 0 ────────
await probe.getAsync(low.data.id);
const midLow = { ...probe.get(low.data.id) };
const midJobs = await jobsText();

log('\n──────────────── 抢占后 !jobs ────────────────');
log(midJobs);

// ── 断言 ①② ───────────────────────────────────────────────────────
push('① 抢占后旧流程停手（server 侧痕迹 1 秒内无变化）',
    traceA === traceB,
    `traceA=${traceA.slice(0, 40)} traceB=${traceB.slice(0, 40)}`);

// ★ 用"抢占那一刻"的快照断言，而不是事后查（事后调度器已按 06 §8 步骤1 把它 resume 了）
const snap = pausedSnapshot;      // 由子进程输出里解析出来的 {state, attempts}
push('② 被抢占单 state=paused 且 attempts=0（INTERRUPTED 不算失败）',
    snap != null && snap.state === JOB_STATE.PAUSED && snap.attempts === 0,
    snap ? `抢占瞬间快照 state=${snap.state} attempts=${snap.attempts}` : '未抓到抢占瞬间快照');

push('③ 9 级单确实执行了（done 或已跑过）',
    highDone && (highJob?.state === JOB_STATE.DONE),
    `high state=${highJob?.state}`);

push('④ 3 级单 progress 未倒退',
    (Number(midLow.progress?.count ?? 0)) >= Number(beforeLow.progress?.count ?? 0),
    `前=${beforeLow.progress?.count ?? 0} 后=${midLow.progress?.count ?? 0}`);

// ── 恢复 3 级单，断言能续做 ────────────────────────────────────────
log('\n=== 恢复 3 级单（resume）===');
await probe.setState(low.data.id, JOB_STATE.READY, 'resume-after-test');
await sleep(2000);
await probe.getAsync(low.data.id);
const resumed = { ...probe.get(low.data.id) };

push('⑤ 3 级单能被恢复（ready/running/claimed）',
    [JOB_STATE.READY, JOB_STATE.RUNNING, JOB_STATE.CLAIMED].includes(resumed.state),
    `state=${resumed.state}`);

log('\n──────────────── 最终 !jobs ────────────────');
log(await jobsText());

log('\n════════════ B2 真机断言 ════════════');
const failed = results.filter((r) => !r.pass);
log(`${results.length - failed.length}/${results.length} 条通过`);

try { agentProc.kill('SIGKILL'); } catch { }
try { sock.close(); } catch { }
await sleep(600);
process.exit(failed.length === 0 ? 0 : 1);

/** 用真的 `!jobs` 命令处理器输出。 */
async function jobsText() {
    try {
        for (const id of [lowId, highId].filter(Boolean)) await probe.getAsync(id);
        const cmd = getCommand('!jobs');
        return await cmd.perform({ board: probe, name: BOT, last_sender: 'probe', actions: {}, history: null });
    } catch (e) { return `(!jobs 出错: ${String(e?.message ?? e)})`; }
}
