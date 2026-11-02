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

    // ★ 上线后先 tp 到分配的区域（否则她在世界出生点，附近没矿 → mine 直接 NO_TARGET。
    //   第一版就是这么空跑的：两个 bot 都领到了单，但 0 秒就失败。）
    const HOME = JSON.parse(process.env.B3_HOME || 'null');
    if (HOME) {
        await RC(`tp ${NAME} ${HOME.x + 0.5} ${HOME.y} ${HOME.z + 0.5}`);
        await sleep(1200);
    }
    // 每个 bot 给一把镐（不 fill 在自己身上）
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
const procs = BOTS.map((name, i) => {
    const p = spawn(process.execPath, [SELF, '--agent', name], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, B3_HOME: JSON.stringify(cells[i]) },
    });
    p.stdout.on('data', (d) => process.stdout.write(`  ${d}`));
    p.stderr.on('data', (d) => { const s = String(d); if (!/walkTo|nav/.test(s)) process.stderr.write(`  [err] ${s}`); });
    return p;
});
await sleep(9000);

// 每块区域造矿（bot 已 tp 过去了；造完立刻清出她自己那格，不埋人）
for (let i = 0; i < BOTS.length; i++) {
    const c = cells[i];
    await fillSafe(RC, c.x - 7, c.y - 1, c.z - 7, c.x + 7, c.y - 1, c.z + 7, 'stone');   // 地板
    await fillSafe(RC, c.x - 7, c.y, c.z - 7, c.x + 7, c.y + 2, c.z + 7, 'iron_ore');     // 矿
    await RC(`setblock ${Math.floor(c.x)} ${c.y - 1} ${Math.floor(c.z)} stone`).catch(() => { });
    for (let dy = 0; dy <= 2; dy++) await RC(`setblock ${Math.floor(c.x)} ${c.y + dy} ${Math.floor(c.z)} air`).catch(() => { });
}
log('场地已就绪（每块区域一片铁矿）');

// ── 阶段1：两个 bot 领单 + 开采；claims 一律**经 server 查**（不走父进程直连库）──
//
// ★ 第一版失败原因：父进程用自己那条 DatabaseSync 连接 `listClaims(db)` 读，
//   而写是 mindserver 那条连接干的 —— WAL 下两条连接看到的快照不同，
//   于是明明有预约，父进程读到 0 行（②③④ 全挂）。改成走 socket 查服务端真值。
log('\n=== 阶段1：等两个 bot 领单/开采 ===');
const t0 = Date.now();
let done = 0;
let snap1 = null, snap2 = null, snapAt1 = 0;

const claimsVia = async () => {
    const r = await probe.claims();
    return (r.ok ? (r.data?.claims ?? []) : []).map((x) => ({ key: x.key, owner: x.owner, until: x.until }));
};

while (Date.now() - t0 < 600000) {
    await sleep(4000);
    const now = Date.now();
    const allJ = listJobs(db, {});
    done = allJ.filter((j) => j.parentId === parent.id && j.state === JOB_STATE.DONE).length;

    if (!snap1) {
        const c = await claimsVia();
        if (c.length >= 2 && c.some((x) => x.owner === 'b3a') && c.some((x) => x.owner === 'b3b')) {
            snap1 = c; snapAt1 = now;
            log(`  [快照1] ${JSON.stringify(snap1)}`);
        }
    }
    if (snap1 && !snap2 && now - snapAt1 > 14000) {
        snap2 = await claimsVia();
        log(`  [快照2] ${JSON.stringify(snap2)}`);
    }
    if (done >= PARTS) break;
}
log(`阶段1 完成：子单 ${done}/${PARTS}`);

// ── 阶段2：掉线释放演练（单独造一张单让 b3a 领，再 kill 它）──
log('\n=== 阶段2：掉线释放演练 ===');
const offJob = store.addJob(db, {
    kind: 'shared', title: '掉线演练', skill: 'mine',
    args: { ore: 'iron', count: 16, maxDepth: 8 },
    priority: 7, claims: ['area:6200,-60,8100:8'], state: JOB_STATE.READY,
});
let killResult = null;
let killKeys = [];
{
    // 等 b3a 领到它并预约上（查 server）
    let claimed = false;
    for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const c = await claimsVia();
        const mine = c.filter((x) => x.owner === 'b3a' && x.key === 'area:6200,-60,8100:8');
        if (mine.length) { killKeys = mine.map((x) => x.key); claimed = true; break; }
    }
    if (claimed) {
        log(`  b3a 已占 ${killKeys.join(',')}，现在 SIGKILL 掉它`);
        try { procs[0].kill('SIGKILL'); } catch { }
        const killAt = Date.now();
        // 等 TTL（30s）+ 扫描（5s）
        while (Date.now() - killAt < 45000) await sleep(3000);
        const after = await claimsVia();
        const still = after.filter((c) => killKeys.includes(c.key));
        // 再证一步：b3b 现在能不能把这个 key 约上（走 server）
        const tryRes = await probe.reserve(offJob.id, killKeys);
        let canTake = tryRes.ok === true;
        if (canTake) await probe.release(offJob.id, killKeys);
        killResult = { stillHeld: still.map((x) => ({ key: x.key, owner: x.owner })), canTake };
        log(`  [掉线后] 残留=${JSON.stringify(killResult.stillHeld)} 别人能否约到=${canTake}`);
    } else {
        log('  b3a 没领到演练单（可能已退出），跳过');
    }
}

// ── 断言 ───────────────────────────────────────────────────────────
const all = listJobs(db, {});
const kids = all.filter((j) => j.parentId === parent.id);
const c1 = snap1 ?? [];

const assignees = new Set(kids.map((k) => k.assignee).filter(Boolean));
push('① 两个 bot 都参与（不同 assignee，各领不同子单）', assignees.size >= 2,
    `assignee=${JSON.stringify([...assignees])} 子单=${JSON.stringify(kids.map((k) => [k.id.slice(-4), k.assignee]))}`);

const ownersOk = c1.some((c) => c.owner === 'b3a') && c1.some((c) => c.owner === 'b3b');
const untilFuture = c1.length > 0 && c1.every((c) => Number(c.until) > snapAt1);
push('② claims 表真的落了行（两个 owner、until 在未来）', ownersOk && untilFuture,
    `${c1.length} 行 owners=${JSON.stringify([...new Set(c1.map((c) => c.owner))])}`);

let overlaps = [];
for (let i = 0; i < c1.length; i++) {
    for (let j = i + 1; j < c1.length; j++) {
        if (c1[i].owner !== c1[j].owner && claimsConflict(c1[i].key, c1[j].key)) overlaps.push([c1[i].key, c1[j].key]);
    }
}
push('③ 两个 bot 的预约 key 无重叠（不砍同一棵树）', c1.length >= 2 && overlaps.length === 0,
    overlaps.length ? JSON.stringify(overlaps) : `${c1.length} 条互不冲突：${c1.map((c) => c.key).join(' | ')}`);

const renewed = [];
for (const a of c1) {
    const b = (snap2 ?? []).find((x) => x.key === a.key && x.owner === a.owner);
    if (b && Number(b.until) > Number(a.until)) renewed.push(`${a.key}:${a.until}→${b.until}`);
}
push('④ TTL 续期真的在走（until 被 heartbeat 推后）', renewed.length > 0,
    renewed.length ? renewed.join('; ') : '未观察到续期');

push('⑤ 掉线 bot 的预约自动释放（不永久锁地）',
    !!(killResult && (killResult.stillHeld ?? []).length === 0 && killResult.canTake === true),
    killResult ? `残留=${JSON.stringify(killResult.stillHeld)} 别人能约=${killResult.canTake}` : '未触发');

const totalCount = kids.reduce((n, k) => n + Number(k.progress?.count ?? 0), 0);
push('⑥ 合计产出 ≥ 64', totalCount >= TOTAL, `合计=${totalCount}（目标 ${TOTAL}）`);

const parentNow = getJob(db, parent.id);
push('⑦ 父单收敛为 done', parentNow?.state === JOB_STATE.DONE, `parent=${parentNow?.state}`);

log('\n──────── 最终状态 ────────');
for (const k of kids) {
    log(`  ${k.id} [${k.state}] assignee=${k.assignee ?? '-'} claims=${JSON.stringify(k.claims)} progress=${JSON.stringify(k.progress)}`);
}
log(`  parent ${parent.id} [${parentNow?.state}]`);


log('\n════════════ B3 真机断言 ════════════');
const failed = results.filter((r) => !r.pass);
log(`${results.length - failed.length}/${results.length} 条通过`);

for (const p of procs) { try { p.kill('SIGKILL'); } catch { } }
try { sock.close(); } catch { }
await sleep(600);
process.exit(failed.length === 0 ? 0 : 1);
