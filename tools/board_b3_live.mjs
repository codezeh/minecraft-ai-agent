/**
 * M8 B3 真机验收：**两个 bot 领"采 64 原木"的 4 张子单 → 不砍同一棵树、合计 ≥ 64**（06 §11 B3）。
 *
 * 这是 M8 里唯一需要多实例的验收。做法：
 *   父进程：起 mindserver → 造一片树 → 拆 4 张 shared 子单（**每张预约自己的 area**）
 *   子进程 ×2：各起一个真 bot + 真 BoardScheduler（自动领单、reserve、跑、finish）
 *   断言：① 两 bot 领到**不同**子单 ② claims **无重叠** ③ 合计 ≥ 64 ④ 父单收敛 done
 *
 * 纪律：只碰自己起的 b3a/b3b；造场地不 fill 在 bot 身上（用 keepBotCellClear）。
 *
 * 用法：node tools/board_b3_live.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rcon } from './rcon.mjs';
import { openBoard, getJob, listJobs, listClaims, splitByCount, JOB_STATE } from '../src/agent/library/board_store.js';
import { claimsConflict } from '../src/agent/library/board_claims.js';
import { BoardClient } from '../src/agent/library/board_client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = join(__dirname, 'board_b3_live.mjs');
const MS_PORT = 18096;
const MC_PORT = 25566;
const RC = (c) => rcon(c, { port: 25576 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const BOTS = ['b3a', 'b3b'];
const TOTAL = 64;
const PARTS = 4;

// ══════════════════════════════════════════════════════════════════════════
// 子进程：一个真 bot + 真调度器
// ══════════════════════════════════════════════════════════════════════════
if (process.argv[2] === '--agent') {
    const NAME = process.argv[3];
    const { io: ioClient } = await import('socket.io-client');
    const mineflayer = (await import('mineflayer')).default;
    const pf = (await import('mineflayer-pathfinder')).default;
    const { installPositionGuard } = await import('../src/sim/position_guard.js');
    const { BoardScheduler } = await import('../src/agent/library/board_scheduler.js');
    const { keepBotCellClear } = await import('./arena.mjs');

    const sock = ioClient(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
    const board = new BoardClient({ socket: sock, name: NAME, skills: ['mine', 'collect'], timeoutMs: 5000 });
    await board.hello();

    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: MC_PORT, username: NAME, auth: 'offline', version: '1.21.8',
    });
    bot.loadPlugin(pf.pathfinder);
    installPositionGuard(bot);
    bot.on('error', () => { });
    await new Promise((res) => bot.once('spawn', res));
    await sleep(1200);

    // 每个 bot 给一把镐 + 一堆垫脚石（不 fill 在自己身上）
    await RC(`clear ${NAME}`).catch(() => { });
    await sleep(300);
    await RC(`give ${NAME} iron_pickaxe 1`);
    await sleep(800);
    await keepBotCellClear(RC, bot.entity.position).catch(() => { });
    log(`[${NAME}] 就绪 @${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}`);

    const actions = {
        executing: false, killed: false, stopReason: null, currentJobId: null,
        async stop(r) { this.stopReason = r; try { bot.interrupt_code = r; } catch { } const t0 = Date.now(); while (this.executing && Date.now() - t0 < 10000) await sleep(100); this.executing = false; },
        async runAction(_l, fn) { return fn(); },
    };

    const sched = new BoardScheduler({
        agent: { name: NAME, bot, actions, roles: [] },
        board, actions,
        runSkill: async (_a, skill, argStr) => {
            actions.executing = true;
            try {
                bot.interrupt_code = null;
                const reg = await import('../src/agent/library/composite_registry.js');
                return await reg.runSkill({ bot, name: NAME, actions }, skill, argStr);
            } finally { actions.executing = false; }
        },
        onEvent: (e) => {
            if (['job-claimed', 'job-finished', 'reserved', 'reserve-conflict', 'job-skipped-requires'].includes(e.type)) {
                log(`[${NAME}-EV] ${e.type} ${JSON.stringify(e).slice(0, 150)}`);
            }
        },
    });

    const timer = setInterval(() => { sched.tick().catch(() => { }); }, 3000);
    timer.unref?.();
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
const probe = new BoardClient({ socket: sock, name: 'b3probe', skills: ['mine'], timeoutMs: 5000 });
await probe.hello();

// ── 场地：在几个 bot 附近造一片可以"采"的矿（用 mine 而不是 collect：collect 有 judgeTree 会拒人造树）
const { fillSafe } = await import('./arena.mjs');
const ARENA = { x: 6100, z: 8100, y: -60 };

const results = [];
const push = (name, pass, detail) => { results.push({ name, pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name} —— ${detail}`); };

// 拆 4 张子单，每张**预约自己的一块区域**（互不相邻 → 两个 bot 不会撞）
const store = await import('../src/agent/library/board_store.js');
const { db } = store.openBoard();

// 清掉上一轮的残留单，免得干扰
try { db.exec("DELETE FROM jobs"); db.exec("DELETE FROM claims"); } catch { }

const cells = [];
for (let i = 0; i < PARTS; i++) {
    cells.push({ x: ARENA.x + i * 24, y: ARENA.y, z: ARENA.z });
}
const { parent, children } = splitByCount(db, {
    title: '采 64 原木', skill: 'mine',
    args: { ore: 'iron', count: 16, maxDepth: 8 },
    countKey: 'count', total: TOTAL, parts: PARTS, priority: 5, source: 'player:probe',
    // ★ 每张子单预约自己那块区域 —— 这就是"不砍同一棵树"的机制
    claimsFor: (i) => [`area:${cells[i].x},${cells[i].y},${cells[i].z}:8`],
});
log(`父单 ${parent.id}，子单 ${children.length} 张，每张 count=16`);
for (const c of children) log(`  ${c.id} claims=${JSON.stringify(c.claims)}`);

// ── 起两个 bot ─────────────────────────────────────────────────────
const procs = BOTS.map((name) => {
    const p = spawn(process.execPath, [SELF, '--agent', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => process.stdout.write(`  ${d}`));
    p.stderr.on('data', (d) => { const s = String(d); if (!/walkTo|nav/.test(s)) process.stderr.write(`  [err] ${s}`); });
    return p;
});
await sleep(9000);

// 每个 bot 在自己那块区域造矿（造完立刻 keepBotCellClear，不埋人）
for (let i = 0; i < BOTS.length; i++) {
    const c = cells[i];
    await fillSafe(RC, c.x - 6, c.y, c.z - 6, c.x + 6, c.y + 2, c.z + 6, 'iron_ore');
    // 把她自己那格清出来
    try {
        const posOut = await RC(`data get entity ${BOTS[i]} Pos`);
        const m = String(posOut).match(/\[([-\d.]+)d?, ?([-\d.]+)d?, ?([-\d.]+)d?\]/);
        if (m) {
            const [, px, py, pz] = m;
            await RC(`setblock ${Math.floor(+px)} ${Math.floor(+py) - 1} ${Math.floor(+pz)} stone`);
            for (let dy = 0; dy <= 2; dy++) await RC(`setblock ${Math.floor(+px)} ${Math.floor(+py) + dy} ${Math.floor(+pz)} air`);
        }
    } catch { /* ignore */ }
}
log('场地已就绪（每块区域一片铁矿）');

// ── 等两个 bot 领单并跑完（最多 6 分钟）────────────────────────────
log('\n=== 等两个 bot 领单/开采 ===');
const t0 = Date.now();
let done = 0;
while (Date.now() - t0 < 360000) {
    await sleep(5000);
    const all = listJobs(db, {});
    done = all.filter((j) => j.parentId === parent.id && j.state === JOB_STATE.DONE).length;
    const claimed = all.filter((j) => j.parentId === parent.id && [JOB_STATE.CLAIMED, JOB_STATE.RUNNING].includes(j.state)).length;
    if (done >= PARTS) break;
    if (Date.now() - t0 > 30000 && claimed === 0 && done === 0) {
        log('  （30 秒了还没有人领到单，继续等…）');
    }
}
log(`子单完成 ${done}/${PARTS}`);

// ── 断言 ───────────────────────────────────────────────────────────
const all = listJobs(db, {});
const kids = all.filter((j) => j.parentId === parent.id);
const claims = listClaims(db);

// ① 两个 bot 领到了不同的子单
const assignees = new Set(kids.map((k) => k.assignee).filter(Boolean));
push('① 至少两个 bot 参与（不同 assignee）', assignees.size >= 2,
    `assignee=${JSON.stringify([...assignees])}`);

// ② claims 无重叠（两两不冲突）
let overlaps = [];
for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
        if (claims[i].owner !== claims[j].owner && claimsConflict(claims[i].key, claims[j].key)) {
            overlaps.push([claims[i].key, claims[j].key]);
        }
    }
}
push('② 两个 bot 的预约**无重叠**（不砍同一棵树）', overlaps.length === 0,
    overlaps.length ? JSON.stringify(overlaps) : `${claims.length} 条预约，两两不冲突`);

// ③ 合计 ≥ 64
const totalCount = kids.reduce((n, k) => n + Number(k.progress?.count ?? 0), 0);
push('③ 合计产出 ≥ 64', totalCount >= TOTAL, `合计=${totalCount}（目标 ${TOTAL}）`);

// ④ 父单收敛 done
const parentNow = getJob(db, parent.id);
push('④ 父单收敛为 done', parentNow?.state === JOB_STATE.DONE, `parent=${parentNow?.state}`);

log('\n──────── 最终状态 ────────');
for (const k of kids) {
    log(`  ${k.id} [${k.state}] assignee=${k.assignee ?? '-'} claims=${JSON.stringify(k.claims)} progress=${JSON.stringify(k.progress)}`);
}
log(`  parent ${parent.id} [${parentNow?.state}]`);
log(`  claims: ${JSON.stringify(claims.map((c) => ({ key: c.key, owner: c.owner })))}`);

log('\n════════════ B3 真机断言 ════════════');
const failed = results.filter((r) => !r.pass);
log(`${results.length - failed.length}/${results.length} 条通过`);

for (const p of procs) { try { p.kill('SIGKILL'); } catch { } }
try { sock.close(); } catch { }
await sleep(600);
process.exit(failed.length === 0 ? 0 : 1);
