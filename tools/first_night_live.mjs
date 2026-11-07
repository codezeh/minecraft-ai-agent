/**
 * t32 真机：`!do first_night`
 *   ① 子单原文（parentId / why / dependsOn）—— 验"编排正确"
 *   ② 调度器真的领走/跑了/回报 —— 验"真的跑起来"（两件事，用户明确要求都看）
 *   ③ 夜间注入那轮的 shelter 子单
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { openBoard, listJobs } from '../src/agent/library/board_store.js';
import { BoardClient } from '../src/agent/library/board_client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const MS_PORT = 18095;
const NAME = 'fn' + (Date.now() % 100000);

const { createMindServer } = await import('../src/mindcraft/mindserver.js');
createMindServer(false, MS_PORT);
await sleep(2500);
const { io: ioc } = await import('socket.io-client');
// t23：握手 token 门之后，裸 io(...) 会被 mindserver 拒绝（AUTH_REQUIRED），
// 而这里的 await 会在 connect_error 上 reject —— 补 token 并显式失败。
const { connectMindserver, awaitConnect } = await import('./lib/ms_token.mjs');
const sock = connectMindserver(ioc, MS_PORT);
if (!await awaitConnect(sock, { label: 'first_night_live' })) process.exit(1);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
await new Promise((res) => bot.once('spawn', res));
await sleep(1200);

const reg = await import('../src/agent/library/composite_registry.js');
const board = new BoardClient({ socket: sock, name: NAME, skills: reg.SKILL_NAMES, timeoutMs: 5000 });
await board.hello();
const { db } = openBoard();
try { db.exec('DELETE FROM jobs'); } catch { }

const p = bot.entity.position;
const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
await RC(`fill ${bx - 8} ${by - 1} ${bz - 8} ${bx + 8} ${by - 1} ${bz + 8} stone`);
await RC(`fill ${bx - 8} ${by} ${bz - 8} ${bx + 8} ${by + 5} ${bz + 8} air`);
await RC(`clear ${NAME}`).catch(() => { });
await sleep(300);

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

const { firstNight } = await import('../src/agent/library/strat_first_night.js');
const agent = { bot, name: NAME, board };

// ══ ① 白天：编排（子单原文）════════════════════════════════════
{
    const r = await firstNight(agent, { board, timeOfDay: 1000 });
    console.log(`\n=== ① !do first_night（白天 timeOfDay=1000）===`);
    console.log(`返回: ok=${r.ok} parentId=${r.data?.parentId ?? '-'} 子单=${r.data?.steps?.length ?? 0}`);
    const all = listJobs(db, {});
    const kids = all.filter((j) => j.parentId === r.data?.parentId);
    for (const k of kids) {
        console.log(`  子单 ${k.id} skill=${k.skill} parentId=${k.parentId}`);
        console.log(`       why="${k.why}"  dependsOn=${JSON.stringify(k.dependsOn ?? null)}  args=${JSON.stringify(k.args)}`);
    }
    console.log(`  跳过的步骤: ${(r.data?.skipped ?? []).map((s) => `${s.key}(${s.why})`).join(' | ')}`);

    const hasParent = kids.length > 0 && kids.every((k) => k.parentId === r.data?.parentId);
    const hasWhy = kids.every((k) => typeof k.why === 'string' && k.why.length > 0);
    const stone = kids.find((k) => k.args?.item === 'stone_pickaxe');
    check('① 白天：子单带 parentId + why；石镐子单带 dependsOn（真实 id）',
        r.ok && hasParent && hasWhy && Array.isArray(stone?.dependsOn) && stone.dependsOn.length === 1,
        `子单 ${kids.length} 张, 石镐 dependsOn=${JSON.stringify(stone?.dependsOn)}`);
    check('①b 白天不拆 shelter 子单', !kids.some((k) => k.skill === 'shelter'),
        kids.map((k) => k.skill).join(','));
}

// ══ ② 调度器真的领走/跑/回报（"真的跑起来"）═══════════════════
{
    // 用一个能真的跑通的子单：obtain 1 个 oak_log（场地周围有树吗？没有就换成能吃的最小活）
    // → 这里直接看调度器会不会把 ready 的单领走变成 claimed/running
    const { BoardScheduler } = await import('../src/agent/library/board_scheduler.js');
    const events = [];
    const sched = new BoardScheduler({
        agent: { name: NAME, bot, board },
        boardClient: board,
        onEvent: (e) => events.push(e),
        intervalMs: 200,
    });
    // ★ BoardScheduler 的 API 是 `tick()`，不是 `start()`（第一版写错，现场崩了）
    for (let i = 0; i < 12; i++) {
        try { await sched.tick(); } catch (e) { events.push({ type: 'tick-threw', msg: String(e?.message ?? e) }); }
        await sleep(300);
    }
    const all = listJobs(db, {});
    const states = {};
    for (const j of all) states[j.state] = (states[j.state] ?? 0) + 1;
    console.log(`\n=== ② 调度器 4 秒后各单状态 ===`);
    console.log(`  状态分布: ${JSON.stringify(states)}`);
    console.log(`  调度事件: ${JSON.stringify(events.slice(0, 6))}`);
    // 只要证明"有单被领走/尝试执行"即可（哪怕执行失败，也是真的被派发了）
    const dispatched = events.some((e) => /claim|run|finish|fail/i.test(JSON.stringify(e)))
        || Object.keys(states).some((s) => s !== 'ready');
    check('② 调度器真的派发了子单（不是只躺在 ready）', dispatched,
        `states=${JSON.stringify(states)}`);
}

// ══ ③ 夜间注入 → 有 shelter 子单 ═══════════════════════════════
{
    try { db.exec('DELETE FROM jobs'); } catch { }
    const r = await firstNight(agent, { board, timeOfDay: 14000, hasShelter: false, hasBed: false });
    const all = listJobs(db, {});
    const kids = all.filter((j) => j.parentId === r.data?.parentId);
    const sh = kids.find((k) => k.skill === 'shelter');
    console.log(`\n=== ③ 夜间注入 timeOfDay=14000 ===`);
    for (const k of kids) console.log(`  子单 ${k.id} skill=${k.skill} why="${k.why}" dependsOn=${JSON.stringify(k.dependsOn ?? null)}`);
    check('③ 夜间注入 → 拆出 shelter 子单', !!sh, sh ? `shelter id=${sh.id} why="${sh.why}"` : kids.map((k) => k.skill).join(','));
}

console.log(`\n${pass}/${pass + fails} 条通过`);
try { bot.quit(); } catch { }
try { sock.close(); } catch { }
await sleep(600);
process.exit(fails === 0 ? 0 : 1);
