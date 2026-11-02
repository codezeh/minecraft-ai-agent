/**
 * M8 B2 真机验收（第 2 部分）：`requeueStaleBrief()` —— brief 单超 60 秒没人认领 → 退回 ready。
 *
 * captain 2026-11-02 要求真机验一次：造一个"被打断且悬着"的单，等 60 秒，
 * 断言调度器把它退回 `ready`。
 *
 * 做法：起 mindserver + 一个真 bot（带真调度器），
 *   直接在库里造一张 `running` + `interrupted.at = 现在-61秒` 的单（模拟"被打断很久了"），
 *   然后**让调度器自己**（不是我在父进程手动调）在下一个 tick 把它捡回 ready。
 *   这样验的是"接线是否真的在跑"，不是"函数本身对不对"（那离线已经验过）。
 *
 * 用法：node tools/board_b2_brief_live.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rcon } from './rcon.mjs';
import { JOB_STATE, BRIEF_REQUEUE_MS } from '../src/agent/library/control.js';
import { BoardClient } from '../src/agent/library/board_client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = join(__dirname, 'board_b2_brief_live.mjs');
const MS_PORT = 18097;
const MC_PORT = 25566;
const RC = (c) => rcon(c, { port: 25576 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ══════════════════════════════════════════════════════════════════════════
// 子进程：真 bot + 真调度器（它会自己调 requeueStaleBrief）
// ══════════════════════════════════════════════════════════════════════════
if (process.argv[2] === '--agent') {
    const NAME = process.argv[3];
    const { io: ioClient } = await import('socket.io-client');
    const mineflayer = (await import('mineflayer')).default;
    const pf = (await import('mineflayer-pathfinder')).default;
    const { installPositionGuard } = await import('../src/sim/position_guard.js');
    const { BoardScheduler } = await import('../src/agent/library/board_scheduler.js');

    const sock = ioClient(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
    const board = new BoardClient({ socket: sock, name: NAME, skills: ['mine'], timeoutMs: 5000 });
    await board.hello();

    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: MC_PORT, username: NAME, auth: 'offline', version: '1.21.8',
    });
    bot.loadPlugin(pf.pathfinder);
    installPositionGuard(bot);
    bot.on('error', () => { });
    await new Promise((res) => bot.once('spawn', res));
    await sleep(1000);

    const actions = {
        executing: false, killed: false, stopReason: null,
        async stop(r) { this.stopReason = r; this.executing = false; },
        async runAction(_l, fn) { return fn(); },
    };

    const sched = new BoardScheduler({
        agent: { name: NAME, bot, actions, roles: [] },
        board, actions,
        runSkill: async () => ({ ok: true, code: 'OK', data: { count: 1, want: 1 } }),
        onEvent: (e) => {
            if (['brief-requeued', 'job-resumed', 'job-claimed'].includes(e.type)) {
                log(`[AGENT-EV] ${e.type} ${JSON.stringify(e).slice(0, 140)}`);
            }
        },
    });

    // ★ 关键：**关掉自动领单**，这样它不会去领活儿干，只做"收拾残局"。
    //   这同时验证了"开关关着时 requeueStaleBrief 仍然生效"这条设计。
    sched.setAutoClaim(false);

    const timer = setInterval(() => { sched.tick().catch(() => { }); }, 3000);
    timer.unref?.();
    log(`[AGENT] ${NAME} 就绪（autoClaim=false，只收拾残局）`);
    await new Promise(() => { });
}

// ══════════════════════════════════════════════════════════════════════════
// 父进程
// ══════════════════════════════════════════════════════════════════════════
const { createMindServer } = await import('../src/mindcraft/mindserver.js');
createMindServer(false, MS_PORT);
await sleep(2500);
const { io: ioClient } = await import('socket.io-client');

const sock = ioClient(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
const probe = new BoardClient({ socket: sock, name: 'briefprobe', skills: ['mine'], timeoutMs: 5000 });
await probe.hello();
const BOT = 'briefbot';

// ── 起 agent（autoClaim=false，只收拾残局）──────────────────────────
const agentProc = spawn(process.execPath, [SELF, '--agent', BOT], { stdio: ['ignore', 'pipe', 'pipe'] });
agentProc.stdout.on('data', (d) => process.stdout.write(`  ${d}`));
agentProc.stderr.on('data', (d) => { const s = String(d); if (!/walkTo|nav/.test(s)) process.stderr.write(`  [err] ${s}`); });
await sleep(4000);

const results = [];
const push = (name, pass, detail) => { results.push({ name, pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name} —— ${detail}`); };

// ── 造一张"被打断 61 秒、悬在 running"的单 ─────────────────────────
//
// ★ 第一版是"add 之后 update 成 running+interrupted"，结果是**空跑**：
//   状态机不允许 ready→running，update 被合法拒绝，单其实还是 ready、interrupted=null，
//   于是"退回 ready"的断言从一开始就没意义。
//   现在直接走**真 store**（同一个库文件）造，并**断言造出来的确实是 running + 旧 interrupted**。
const store = await import("../src/agent/library/board_store.js");
const { db } = store.openBoard();
const seeded = store.addJob(db, {
    title: "B2 验收：brief 悬单", skill: "mine", args: { ore: "iron", count: 4 },
    priority: 5, assignee: BOT,
});
const id = seeded.id;
store.claimFor(db, BOT);
store.heartbeat(db, id, BOT, { progress: { count: 1, want: 4 } });   // claimed → running
store.updateJob(db, id, { interrupted: { at: Date.now() - BRIEF_REQUEUE_MS - 1000, reason: "brief" } });

await probe.getAsync(id);
const before = { ...probe.get(id) };
log(`
造好悬单 ${id}: state=${before.state} interrupted.at=${before.interrupted?.at ?? "null"}`);
log(`（阈值 BRIEF_REQUEUE_MS=${BRIEF_REQUEUE_MS}ms，已超过 1 秒）`);
push("① 悬单确实造出来了（running + 过期的 interrupted）",
    before.state === JOB_STATE.RUNNING && Number.isFinite(before.interrupted?.at),
    `state=${before.state} interrupted.at=${before.interrupted?.at ?? "null"}`);

// ── 等**调度器自己**的 tick 把它捡回 ready（每 3 秒一拍）───────────
log('\n=== 等调度器 tick 收拾残局（最多 20 秒）===');
let moved = null;
for (let i = 0; i < 14; i++) {
    await sleep(1500);
    await probe.getAsync(id);
    const j = probe.get(id);
    if (j && (j.state === JOB_STATE.READY || j.state === JOB_STATE.CLAIMED)) { moved = { ...j }; break; }
}

push('② requeueStaleBrief 在真机生效（悬单被退回 ready）',
    moved != null && moved.state === JOB_STATE.READY,
    moved ? `state=${moved.state}（原 running）` : `20 秒内未变化，仍是 ${probe.get(id)?.state}`);

push('③ autoClaim=false 时仍然收拾残局（设计如此：收残局≠领新单）',
    moved?.state === JOB_STATE.READY,
    `moved=${moved?.state ?? 'null'}`);

log('\n════════════ brief 真机断言 ════════════');
const failed = results.filter((r) => !r.pass);
log(`${results.length - failed.length}/${results.length} 条通过`);

try { agentProc.kill('SIGKILL'); } catch { }
try { sock.close(); } catch { }
await sleep(600);
process.exit(failed.length === 0 ? 0 : 1);
