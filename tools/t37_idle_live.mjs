/**
 * t37 第③项：idle_planner **真机真空闲** 2 分钟观察（M9 遗留）。
 *
 * 判据（captain 批准，按 action 分开判，不混算总数）：
 *   - think     ≤ 3（预期 0–1；THINK_EVERY_MS=300000 → ceil(120/300)+2）
 *   - job       ≤ 1（下完单 jobBusy 立刻为真，不该重复下）
 *   - idle-mode ≤ 拍数（41）—— 单独记为"日志噪声"观察项
 *   + 不空跑：idle-plan 总次数 ≥ 1
 *   + 第 1 层补短板：造"食物不足" → 应出现 action:'job' 且 reason 以 need: 开头
 *
 * 做法：真 bot + 真 board server + **照搬 agent.js 的调度节奏**（每 3000ms 一次 tick()），
 *       跑 120 秒，收集 onEvent 里的 idle-plan。
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { io as ioClient } from 'socket.io-client';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { BoardClient } from '../src/agent/library/board_client.js';
import { BoardScheduler } from '../src/agent/library/board_scheduler.js';
import { IDLE } from '../src/agent/library/idle_planner.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 't37idle' + (Date.now() % 100000);
const MS_PORT = 18092;
const TICK_MS = 3000;          // 与 agent.js:56 `const EVERY = 3000` 一致
const DURATION_MS = 125000;    // 2 分钟多一点

// ── 版本自证（captain 要求：报告必须能证明是在哪个提交上跑的）──────
{
    const { execSync } = await import('node:child_process');
    try {
        const raw = execSync('git log -1 --format=%H%n%s', { encoding: 'utf8' }).trim();
        console.log('═══ 运行版本自证 ═══');
        const NL = String.fromCharCode(10);
        console.log('  ' + raw.split(NL).join(NL + '  '));
console.log('═══════════════════');
    } catch (e) { console.log('（取版本失败：' + String(e?.message ?? e).slice(0, 60) + '）'); }
}

let pass = 0, fail = 0;
const chk = (n, c, i) => { if (c) { pass++; console.log('  PASS  ' + n + (i ? '   ' + i : '')); } else { fail++; console.log('  FAIL  ' + n + '   ' + JSON.stringify(i)); } };

// 1) board server（父进程内）
const { createMindServer } = await import('../src/mindcraft/mindserver.js');
createMindServer(false, MS_PORT);
await sleep(5000);

// 2) 真 bot
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
await new Promise((res) => { const t = setTimeout(res, 30000); bot.once('spawn', () => { clearTimeout(t); res(); }); });
await sleep(1500);

// 造个干净落脚点
const p = bot.entity.position;
const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
await RC(`fill ${bx - 6} ${by - 1} ${bz - 6} ${bx + 6} ${by - 1} ${bz + 6} stone`).catch(() => { });
await RC(`fill ${bx - 6} ${by} ${bz - 6} ${bx + 6} ${by + 4} ${bz + 6} air`).catch(() => { });
await sleep(400);

// 3) 真 BoardClient + 真调度器（照搬 agent.js 节奏）
// t23：握手 token 门之后裸连会被拒（AUTH_REQUIRED）；取 token 走统一的 tools/lib/ms_token.mjs
const { connectMindserver, awaitConnect } = await import('./lib/ms_token.mjs');
const sock = connectMindserver(ioClient, MS_PORT);
if (!await awaitConnect(sock, { label: 't37-idle' })) process.exit(1);
const board = new BoardClient({ name: NAME, skills: ['mine', 'collect', 'store'], socket: sock });
try { await board.hello(); } catch { }
await sleep(800);

const idleEvents = [];
const allEvents = [];
const agentShell = {
    name: NAME, bot, board,
    actions: { executing: false, currentPriority: -1, currentJobId: null },
    _lastTalkAt: 0,
    bot: bot,
};
const sched = new BoardScheduler({
    board,
    agent: agentShell,
    actions: agentShell.actions,
    runSkill: async () => ({ ok: true }),
    onEvent: (e) => {
        allEvents.push(e);
        if (e?.type === 'idle-plan') idleEvents.push({ ...e, at: Date.now() });
    },
});

// ★ 必须先清空任务板：② 的残留单会让 jobsBusy=true -> isIdle=false -> 压根不是"真空闲"
//   （2026-11-03 第一版没清，结果 126 秒只有 1 条 think、0 条 idle-mode，差点误判节流失效）
{
    const { openBoard } = await import('../src/agent/library/board_store.js');
    const db = openBoard().db;
    const before = (db.prepare('SELECT COUNT(*) c FROM jobs').get()?.c) ?? 0;
    db.exec('DELETE FROM jobs');
    try { db.exec('DELETE FROM claims'); } catch { }
    console.log('  已清空任务板（原有 ' + before + ' 张单）-> 才能真正空闲');
}
try { await board.refresh({ scope: 'all' }); } catch { }

console.log(`\n=== 真空闲 ${Math.round(DURATION_MS / 1000)} 秒观察（每 ${TICK_MS}ms 一拍）===`);
console.log(`THINK_EVERY_MS=${IDLE.THINK_EVERY_MS}（${IDLE.THINK_EVERY_MS / 1000}s）→ think 上限 ceil(120/300)+2 = ${Math.ceil(120000 / IDLE.THINK_EVERY_MS) + 2}`);

const t0 = Date.now();
let ticks = 0;
const tickReasons = {};
while (Date.now() - t0 < DURATION_MS) {
    try {
        const r = await sched.tick();
        const k = r?.reason ?? '?';
        tickReasons[k] = (tickReasons[k] ?? 0) + 1;
    } catch { tickReasons.threw = (tickReasons.threw ?? 0) + 1; }
    ticks++;
    await sleep(TICK_MS);
}
console.log('  tick 返回值分布: ' + JSON.stringify(tickReasons));
const elapsed = Date.now() - t0;

// 4) 统计
const byAction = {};
for (const e of idleEvents) byAction[e.action] = (byAction[e.action] || 0) + 1;
console.log(`\n实际 ${Math.round(elapsed / 1000)}s / ${ticks} 拍`);
console.log('idle-plan 按 action 统计: ' + JSON.stringify(byAction));
console.log('idle-plan 总条数: ' + idleEvents.length);
if (idleEvents.length) {
    console.log('前 5 条: ' + JSON.stringify(idleEvents.slice(0, 5).map((e) => ({ a: e.action, r: e.reason }))));
    console.log('后 3 条: ' + JSON.stringify(idleEvents.slice(-3).map((e) => ({ a: e.action, r: e.reason }))));
}

const maxThink = Math.ceil(elapsed / IDLE.THINK_EVERY_MS) + 2;
chk('★ 前置：绝大多数 tick 返回 reason=idle（真的处于真空闲，不是被单/反射挡住）',
    (tickReasons.idle ?? 0) >= Math.floor(ticks * 0.8), tickReasons);
chk('不空跑：idle-plan >= 1 条（她真的进了 idle 分支）', idleEvents.length >= 1, { n: idleEvents.length });
chk(`think ≤ ${maxThink}（节流生效）`, (byAction.think ?? 0) <= maxThink, { think: byAction.think ?? 0, maxThink });
chk(`job ≤ 1（下完单就不再算空闲，不重复下）`, (byAction.job ?? 0) <= 1, { job: byAction.job ?? 0 });
chk(`idle-mode ≤ 拍数 ${ticks}（心跳，逐拍一条）`, (byAction['idle-mode'] ?? 0) <= ticks, { idleMode: byAction['idle-mode'] ?? 0, ticks });

// 5) 第 1 层补短板：食物不足 → 应出 action:'job'
console.log('\n=== 第 1 层"补短板"：造食物不足（FOOD_MIN=' + IDLE.FOOD_MIN + '）===');
{
    await RC(`clear ${NAME}`).catch(() => { });
    await sleep(300);
    const before = idleEvents.length;
    // 再跑 6 拍看有没有 job
    for (let i = 0; i < 6; i++) { try { await sched.tick(); } catch { } await sleep(TICK_MS); }
    const newJobs = idleEvents.slice(before).filter((e) => e.action === 'job');
    console.log('  新增 idle-plan（后 6 拍）: ' + JSON.stringify(idleEvents.slice(before).map((e) => ({ a: e.action, r: e.reason }))));
    // ★ 2026-11-03 修：原判据要求"再造一次不足 → 应再下一张单"，**设计错了** ——
    //   第一张 job 一下单，`jobsBusy` 立刻为真 → 她不再算空闲 → 后面永远不会再来第二张。
    //   正确判据：整轮观察里**出现过** reason 以 `need:` 开头的 job（那才是第 1 层的证据）。
    const anyNeedJob = idleEvents.filter((e) => e.action === 'job' && String(e.reason).startsWith('need:'));
    chk('第 1 层"补短板"真的会下 need: 单（整轮观察里出现过 action=job 且 reason 以 need: 开头）',
        anyNeedJob.length >= 1, { needJobs: anyNeedJob.map((e) => e.reason), 后6拍新增: newJobs.length });
}

try { bot.quit(); } catch { }
try { sock.close?.(); } catch { }
console.log(`\n════════ ③ 真空闲断言 ════════`);
console.log(`${pass}/${pass + fail} 条通过`);
await sleep(600);
process.exit(fail ? 1 : 0);
