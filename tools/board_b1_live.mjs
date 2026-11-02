/**
 * M8 B1 真机验收：**重启不丢单、progress 不倒退、不重复计数**。
 *
 * 这不是"看起来对"的演示，是把 captain 的四条断言逐条变成代码：
 *   1) 单还在（同 id）
 *   2) `progress.count` 不倒退
 *   3) **不重复计数**（重启后接着采，最终 count 不等于"两次相加"）
 *   4) `attempts` 没因为这次 kill 而 +1（kill 是异常退出，不是"失败重试"）
 *
 * 做法（真进程、真 socket、真 bot、真 kill）：
 *   父进程：起 mindserver（带任务板）→ 用真 socket 加单 → 起子进程 A 跑 collect
 *          → **SIGKILL 掉子进程 A**（模拟 agent 崩溃）→ 等租约过期 → 起子进程 B 接着跑
 *          → 用**真的 `!jobs` 命令处理器**打印前后对比
 *   子进程：连 25566 的真 bot + 连 mindserver 的 BoardClient → claim → 跑 collect
 *          → 每 2 秒 heartbeat(progress) → 被 kill 时什么都不做（模拟崩溃）
 *
 * 用法：node tools/board_b1_live.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rcon } from './rcon.mjs';
import { openBoard, getJob, listJobs, JOB_STATE } from '../src/agent/library/board_store.js';
import { BoardClient } from '../src/agent/library/board_client.js';
import { getCommand } from '../src/agent/commands/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = join(__dirname, 'board_b1_live.mjs');
const MS_PORT = 18099;
const MC_PORT = 25566;
const RC = (c) => rcon(c, { port: 25576 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ══════════════════════════════════════════════════════════════════════════
// 子进程模式：真 bot + 真板，跑 collect
// ══════════════════════════════════════════════════════════════════════════
if (process.argv[2] === '--agent') {
    const NAME = process.argv[3];
    const JOB_ID = process.argv[4] || null;
    const { io: ioClient } = await import('socket.io-client');
    const mineflayer = (await import('mineflayer')).default;
    const pf = (await import('mineflayer-pathfinder')).default;
    const { installPositionGuard } = await import('../src/sim/position_guard.js');
    const { runSkill } = await import('../src/agent/library/composite_registry.js');

    const sock = ioClient(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });

    const board = new BoardClient({ socket: sock, name: NAME, skills: ['mine'], timeoutMs: 5000 });
    await board.hello();
    await board.refresh({});


    // 真 bot 上线（**先上线、再造场地、再拿工具，最后才领单**——
    //   第一次顺序错了，A 因为镐还没到就开跑，直接 NO_TOOL，跑不到 20 秒就结束了）
    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: MC_PORT, username: NAME, auth: 'offline', version: '1.21.8',
    });
    bot.loadPlugin(pf.pathfinder);
    installPositionGuard(bot);
    bot.on('error', () => { });
    bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 80)));
    await new Promise((res) => bot.once('spawn', res));
    await sleep(1200);

    // ── 先给工具（要在造场地之前：fill 会跑好几秒，工具先到手才不会 NO_TOOL）──
    try {
        for (const [item, re] of [['iron_pickaxe', /_pickaxe$/], ['cobblestone', /^cobblestone$/]]) {
            const have = (bot.inventory?.items?.() ?? []).some((x) => re.test(x?.name ?? ''));
            if (!have) {
                await RC(`give ${NAME} ${item} 32`);
                for (let i = 0; i < 25; i++) {
                    await sleep(200);
                    if ((bot.inventory?.items?.() ?? []).some((x) => re.test(x?.name ?? ''))) break;
                }
            }
        }
        const inv = (bot.inventory?.items?.() ?? []).map((x) => x.name);
        console.log(`AGENT_TOOLS ${JSON.stringify(inv.slice(0, 6))}`);
    } catch (e) { console.log('AGENT_TOOLS_ERR', String(e?.message ?? e).slice(0, 80)); }

    // ★ 场地在**她上线之后**按真实坐标造（父进程那次 fill 可能没覆盖到她的出生点，
    //   而 `tp` 对未上线的玩家是无效的 —— 第一次跑就是这么空过的）。
    try {
        const pp = bot.entity.position;
        const bx = Math.floor(pp.x), by = Math.floor(pp.y), bz = Math.floor(pp.z);
        // 清空、铺地板、在紧邻处放一片原木
        await RC(`fill ${bx - 10} ${by - 2} ${bz - 10} ${bx + 10} ${by + 6} ${bz + 10} air`);
        await RC(`fill ${bx - 10} ${by - 1} ${bz - 10} ${bx + 10} ${by - 1} ${bz + 10} stone`);
        // mine 的目标：铁矿。铺一层在她脚边（含 deepslate 变体位置也放普通的）
        // ★ 关键：矿层要**避开她站的那一格**，否则 /fill 会把她 entomb 在里面 →
        //   窒息死亡 → 服务端清空背包 → mine 读到 items=[] → 假 NO_TOOL。
        await RC(`fill ${bx - 4} ${by} ${bz - 4} ${bx + 4} ${by + 1} ${bz + 4} iron_ore`);
        await RC(`fill ${bx} ${by} ${bz} ${bx} ${by + 1} ${bz} air`);
        await RC(`fill ${bx} ${by - 1} ${bz} ${bx} ${by - 1} ${bz} stone`);
        await sleep(1200);
        console.log(`AGENT_ARENA at ${bx},${by},${bz}`);
    } catch (e) { console.log('AGENT_ARENA_ERR', String(e?.message ?? e).slice(0, 80)); }

    // ── 工具/场地都就绪，**现在**才领单（领了就该能干活）────────────────
    let job = JOB_ID ? board.get(JOB_ID) : null;
    if (!job || (job.state !== JOB_STATE.CLAIMED && job.state !== JOB_STATE.RUNNING)) {
        const r = await board.claim();
        job = r.data?.job ?? null;
    }
    if (!job) { console.log('AGENT_NO_JOB'); process.exit(3); }
    console.log(`AGENT_CLAIMED ${job.id} state=${job.state} attempts=${job.attempts} progress=${JSON.stringify(job.progress)}`);

    // 开跑前把旧镐清干净、给一把全新的（`clear <player> <item>` 不带数量 = 清光）
    try {
        await RC(`clear ${NAME} iron_pickaxe`).catch(() => { });
        await sleep(400);
        await RC(`give ${NAME} iron_pickaxe 1`);
        for (let i = 0; i < 25; i++) {
            await sleep(200);
            const picks = (bot.inventory?.items?.() ?? []).filter((x) => /_pickaxe$/.test(x?.name ?? ''));
            const usable = picks.filter((p) => ((p.maxDurability ?? 0) - (p.durabilityUsed ?? 0)) > 2);
            if (picks.length === 1 && usable.length === 1) break;
        }
        const picks = (bot.inventory?.items?.() ?? []).filter((x) => /_pickaxe$/.test(x?.name ?? ''));
        console.log(`AGENT_PICK count=${picks.length} usable=${picks.filter((p) => ((p.maxDurability ?? 0) - (p.durabilityUsed ?? 0)) > 2).length} dura=${picks.map((p) => (p.maxDurability ?? 0) - (p.durabilityUsed ?? 0)).join(',')}`);
    } catch { /* 尽力 */ }

    const agent = { bot, actions: { runAction: async (_l, fn) => { await fn(); return {}; } } };

    // 后台心跳：每 2 秒把当前进度报上去（真实调度器也是这么做的）
    let lastProgress = job.progress ?? null;
    const hb = setInterval(async () => {
        try {
            if (lastProgress) await board.heartbeat(job.id, lastProgress);
        } catch { /* 被 kill 前尽力而为 */ }
    }, 2000);
    hb.unref?.();

    // 跑 collect（本身会跑一段时间）；用 manifest 的 timeout 上限
    const args = typeof job.args === 'object' && job.args ? job.args : {};
    const argStr = Object.entries(args).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`AGENT_RUN ${job.id} args="${argStr}"`);

    // 包一层：把 runSkill 的中间 progress 抓出来
    const origHearbeat = board.heartbeat.bind(board);
    board.heartbeat = async (id, progress) => { lastProgress = progress ?? lastProgress; return origHearbeat(id, progress); };

    // ★ 这两个必须在 try 外面：下面 finish 回报也要用（第一版写在 try 里 → "want is not defined"）
    const WANT = Number((typeof job.args === 'object' && job.args ? job.args.count : null) ?? 16);
    const DROP = { iron: 'raw_iron', iron_ore: 'raw_iron', gold: 'raw_gold', copper: 'raw_copper' };
    const dropName = DROP[String((job.args ?? {}).ore ?? 'iron')] ?? String((job.args ?? {}).ore ?? 'iron');
    const readCount = () => {
        try {
            const { countItem } = countItemMod;
            return countItem(bot, dropName);
        } catch { return 0; }
    };
    const countItemMod = await import('../src/agent/library/query_perceive.js');

    let result = null;
    try {
        // ★ runSkill 不会自己 heartbeat —— 真实调度器是"每 10 秒把 progress 报上去"。
        //   这里用同一个 ctx 机制：给 bot 挂一个 progress 读取器，定时心跳。
        //   count 从**背包**读（这是 collect 完成判据的口径），不是从流程内部变量读。
        // 计数口径：挖 iron_ore 掉的是 **raw_iron**（方块名≠物品名，M7 踩过这个坑）
        // WANT / dropName / readCount 已在上面 try 外定义（finish 也要用）
        const hb2 = setInterval(async () => {
            try {
                const c = readCount();
                lastProgress = { count: c, want: WANT };
                await board.heartbeat(job.id, lastProgress);
            } catch { /* ignore */ }
        }, 2000);
        hb2.unref?.();

        result = await runSkill(agent, job.skill, argStr);
        clearInterval(hb2);
        // 最后一次：把终值报上去
        lastProgress = { count: readCount(), want: WANT };
        await board.heartbeat(job.id, lastProgress).catch(() => { });
    } catch (e) {
        console.log('AGENT_ERR', String(e?.message ?? e).slice(0, 120));
    }
    clearInterval(hb);
    console.log(`AGENT_DONE ${job.id} ok=${result?.ok} code=${result?.code} data=${JSON.stringify(result?.data ?? {}).slice(0, 200)}`);

    // ★ 真实调度器跑完会 `board:finish(result)` —— 不回报的话单永远挂在 running，
    //   上层看不到"做完了"，租约过期后还会被回收重做（这才是真 bug 的样子）。
    try {
        // progress = 背包里该物品的**总量**（单调递增，跨重启连续）
        // 不是 result.data.count（那是"本次运行新挖多少"的相对量，重启后会变小）
        const prog = { count: Number(result?.data?.count ?? readCount()), want: WANT };
        prog.count = readCount();                       // ← 以背包总量为准
        const fr = await board.finish(job.id, {
            ok: result?.ok === true, code: result?.code ?? 'OK',
            message: result?.message ?? '', progress: prog,
        });
        console.log(`AGENT_FINISH ${job.id} ok=${fr.ok} next=${fr.data?.next} counted=${fr.data?.counted}`);
    } catch (e) {
        console.log('AGENT_FINISH_ERR', String(e?.message ?? e).slice(0, 100));
    }
    try { bot.quit(); } catch { }
    await sleep(300);
    process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// 父进程：起 mindserver → 加单 → 跑 A → kill → 等租约过期 → 跑 B → 对比
// ══════════════════════════════════════════════════════════════════════════
const { createMindServer, getIO } = await import('../src/mindcraft/mindserver.js');
createMindServer(false, MS_PORT);
await sleep(2500);
const { io: ioClient } = await import('socket.io-client');

const sock = ioClient(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
const board = new BoardClient({ socket: sock, name: 'b1probe', skills: ['mine'], timeoutMs: 5000 });
await board.hello();

// ── 场地：给采集目标放一堆原木 ──────────────────────────────────────
//
// ★ 第一次跑是"空过"的（collect 直接 NO_TARGET：没斧头、附近也没有可挖的树），
//   四条断言全 PASS 但 count 一直是 0 —— 那种"全绿"什么也没证明。
//   所以这里必须把**前置条件喂饱**：给斧头、给垫脚石、把原木放在她脚下能看见的地方。
const BOT = 'b1miner';
// 真正的场地在子进程里、bot 上线后按她的真实坐标造（`tp` 对未上线玩家无效，
// 第一次跑就是因为这个空过的）。父进程这里只做"给东西"，给不了也不致命。
await RC(`give ${BOT} iron_pickaxe 1`).catch(() => { });
await RC(`give ${BOT} cobblestone 32`).catch(() => { });
log('已尝试给斧头/垫脚石（场地由子进程按真实坐标生成）');

// ── 加单（走真 socket → 真 store）────────────────────────────────────
const add = await board.add({
    kind: 'personal', title: 'B1 验收：挖铁矿', skill: 'mine',
    args: { ore: 'iron', count: 8, maxDepth: 8 },
    priority: 6, assignee: BOT, state: JOB_STATE.READY,
});
if (!add.ok) { log('加单失败', add.code, add.message); process.exit(1); }
const JOB = add.data.id;
log(`已下单项 ${JOB}`);

/** 用**真的 `!jobs` 命令处理器**打印（不是我自己拼格式）。 */
async function printJobs(tag) {
    // `!jobs` 读的是 `board.list()`（本地镜像）。父进程的镜像按 `mine=自己` 过滤，
    // 不含 b1miner 的单 —— 所以先把它拉进镜像，`!jobs` 才有东西可显示。
    await board.getAsync(JOB).catch(() => { });
    const cmd = getCommand('!jobs');
    const text = await cmd.perform({ board, name: BOT, last_sender: 'probe', actions: {}, history: null });
    log(`\n───── ${tag} ─────`);
    log(text);
    return text;
}

/** 服务端此刻的真相（按 id 拉，不看本地镜像 —— 镜像按 mine=自己 过滤，拉不到别人的单）。 */
async function fresh() {
    try { await board.getAsync(JOB); } catch { /* ignore */ }
    return board.get(JOB);
}

function snapshot(j) {
    return {
        id: j?.id, state: j?.state, attempts: j?.attempts,
        count: j?.progress?.count ?? null, want: j?.progress?.want ?? null,
        checkpoint: j?.checkpoint ?? null,
    };
}

await printJobs('【重启前】!jobs');
const before = snapshot(await fresh());
log('快照(前):', JSON.stringify(before));

// ── 起子进程 A，跑一会儿，然后 SIGKILL（模拟崩溃）──────────────────
log('\n=== 起 agent A，跑到一半强杀（模拟崩溃）===');
const a = spawn(process.execPath, [SELF, '--agent', BOT, JOB], { stdio: ['ignore', 'pipe', 'pipe'] });
a.stdout.on('data', (d) => process.stdout.write(`[A] ${d}`));
a.stderr.on('data', (d) => { const s = String(d); if (!/walkTo|nav/.test(s)) process.stderr.write(`[A!] ${s}`); });

await sleep(20000);                     // 跑 20 秒
log('=== SIGKILL agent A ===');
try { a.kill('SIGKILL'); } catch { }
await sleep(1500);

// 服务端视角：单还挂在 A 名下（租约未过期）
const mid = snapshot(await fresh());
log('快照(杀掉后、租约未过期):', JSON.stringify(mid));

// ── 等租约过期（06 §6：30 秒）→ 服务端扫描回收 ──────────────────────
log('\n=== 等租约过期（30s + 扫描 5s）===');
const waitStart = Date.now();
let recovered = null;
while (Date.now() - waitStart < 50000) {
    await sleep(3000);
    const j = await fresh();
    if (j && (j.state === JOB_STATE.READY || j.state === JOB_STATE.PAUSED)) { recovered = j; break; }
}
const afterExpiry = snapshot(await fresh());
log(`租约回收: ${recovered ? '是 → state=' + recovered.state : '否（仍是 ' + afterExpiry.state + '）'}`);
log('快照(租约过期后):', JSON.stringify(afterExpiry));

// ── 起子进程 B，接着做 ─────────────────────────────────────────────
log('\n=== 起 agent B（重启），接着做同一张单 ===');
const b = spawn(process.execPath, [SELF, '--agent', BOT, JOB], { stdio: ['ignore', 'pipe', 'pipe'] });
b.stdout.on('data', (d) => process.stdout.write(`[B] ${d}`));
b.stderr.on('data', (d) => { const s = String(d); if (!/walkTo|nav/.test(s)) process.stderr.write(`[B!] ${s}`); });
await new Promise((res) => b.on('exit', res));
await sleep(1000);

await board.refresh({});
await printJobs('【重启后】!jobs');
const after = snapshot(await fresh());
log('快照(后):', JSON.stringify(after));

// ══════════════════════════════════════════════════════════════════════════
// 四条断言
// ══════════════════════════════════════════════════════════════════════════
log('\n════════════ B1 四条断言 ════════════');
const checks = [];
const push = (name, pass, detail) => { checks.push({ name, pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name} —— ${detail}`); };

// 1) 单还在（同 id）
push('① 单还在（同 id）', after.id === JOB, `id=${after.id}`);

// 2) progress.count 不倒退
const cBefore = before.count ?? 0;
const cMid = mid.count ?? 0;
const cAfter = after.count ?? 0;
push('② progress.count 不倒退', cAfter >= cMid && cMid >= cBefore,
    `前=${cBefore} 杀后=${cMid} 后=${cAfter}`);

// 3) 不重复计数：**重启不该改变计数**。
//    正确语义：progress.count 是"这张单当前做到多少"（不累加两次运行）。
// ③ 不重复计数
//
// ★ 2026-11-02（t20 验收时改，captain 授权）：
//   原来这里判 `cAfter <= ceil(want*1.6)`（want=8 → 上限 13）。**那个阈值本身定错了**：
//   `mine` 是**成批挖**的（一批里挖几块），单次运行就能到 3×want（实测 want=8 时挖到 24）。
//   于是这条断言在"机制完全正确"的情况下也会红，只能靠运气过 —— 这不是验收，是掷骰子。
//
//   真正该断言的是：**重启前后计数不变**（`cAfter === cMid`）。
//   判据含义：B 重启后要么没领到单（已被收敛成 done），要么接着做但不把 A 的量重算一遍；
//   两种情况都不该让 count 增长。增长 = 重复计数。
//   （单次运行内的超挖是**合法事实**，不归这条管；`!jobs` 会标"超额 N"给人看。）
const wantN = after.want ?? cBefore ?? 1;
const noGrowthAfterRestart = cAfter === cMid;              // ★ 重启不改变计数
const notSummed = !(cMid > 0 && cBefore > 0 && Math.abs(cAfter - (cBefore + cMid)) <= 1 && cAfter > wantN * 1.5);
push('③ 不重复计数（重启后计数不增长）', noGrowthAfterRestart && notSummed,
    `后=${cAfter} 杀后=${cMid} want=${wantN} 前=${cBefore}（判据：后必须 === 杀后）`);

// ③b **防空跑**：如果 count 一直是 0，上面几条"不倒退/不重复"就是废话。
//     必须证明"确实采到了东西"，这次重启验收才有意义。
push('③b 确实采到了（防空跑：count > 0）', cAfter > 0,
    `最终 count=${cAfter}（若为 0 说明前置没喂饱，验收无效）`);

// 1b) 跑完并回报后，状态应该走到 done（规则③：ok 且 count>=want → done）
push('①b 回报后状态到 done（规则③端到端）', after.state === JOB_STATE.DONE,
    `state=${after.state}`);

// 4) attempts 没因为 kill 而 +1
//    kill 是异常退出 → 走"租约过期回收"，**不算失败重试**。
push('④ attempts 未因 kill 而 +1', after.attempts === before.attempts,
    `前=${before.attempts} 后=${after.attempts}`);

// 5) 顺手：无板时 !jobs 说人话（captain 要求的第三条）
const noBoardOut = await getCommand('!jobs').perform({ board: null, name: BOT, actions: {}, history: null });
push('⑤ 无板时 !jobs 说人话（不报错码）',
    typeof noBoardOut === 'string' && /没连上/.test(noBoardOut) && !/INTERNAL|NO_TARGET/.test(noBoardOut),
    noBoardOut.slice(0, 60));

const failed = checks.filter((c) => !c.pass);
log(`\n${checks.length - failed.length}/${checks.length} 条断言通过`);
try { sock.close(); } catch { }
await sleep(500);
process.exit(failed.length === 0 ? 0 : 1);
