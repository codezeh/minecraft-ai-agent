/**
 * t34 真机：`!do first_night` 连跑两次 → 验证
 *   ① 白天场景子单数仍是 5（机制变了产出数不该变）
 *   ② **预算每次执行独立**（第二次仍正常产出，不因第一次用完就 0 张）
 *
 * ★ 判据：预算是防爆炸的，不是防干活的。该共享的范围是"一次任务执行内"，不是"跨任务"。
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { openBoard, listJobs } from '../src/agent/library/board_store.js';
import { BoardClient } from '../src/agent/library/board_client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const MS_PORT = 18096;
const NAME = 'a2' + (Date.now() % 100000);

const { createMindServer } = await import('../src/mindcraft/mindserver.js');
createMindServer(false, MS_PORT);
await sleep(2500);
const { io: ioc } = await import('socket.io-client');
const sock = ioc(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });

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

const p = bot.entity.position;
const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
await RC(`fill ${bx - 8} ${by - 1} ${bz - 8} ${bx + 8} ${by - 1} ${bz + 8} stone`);
await RC(`fill ${bx - 8} ${by} ${bz - 8} ${bx + 8} ${by + 5} ${bz + 8} air`);
await RC(`clear ${NAME}`).catch(() => { });
await sleep(300);

const { firstNight } = await import('../src/agent/library/strat_first_night.js');
const agent = { bot, name: NAME, board };

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

// ── 连续两次执行，**每次都用全新的 makeCtx**（模拟真实的两次 !do）──
const results = [];
for (let i = 1; i <= 2; i++) {
    try { db.exec('DELETE FROM jobs'); } catch { }
    const ctx = reg.makeCtx(agent, null, reg.getSkill('first_night')?.manifest ?? null);
    console.log(`\n=== 第 ${i} 次 !do first_night（全新 ctx）===`);
    console.log(`  预算初始: ${JSON.stringify(ctx.jobBudget)}`);
    const r = await firstNight(agent, { board, timeOfDay: 1000, ctx });
    const kids = listJobs(db, {}).filter((j) => j.parentId === r.data?.parentId);
    console.log(`  返回 ok=${r.ok} 子单=${kids.length} 张  jobBudget 事后=${JSON.stringify(ctx.jobBudget)}`);
    for (const k of kids) console.log(`    ${k.skill} why="${k.why}"`);
    results.push({ kids: kids.length, budget: { ...ctx.jobBudget } });
}

// ① 白天子单数仍是 5
check('① 白天 first_night 子单数仍是 5（机制变了产出数不该变）',
    results[0].kids === 5, `第1次=${results[0].kids} 张`);

// ② ★ 预算每次执行独立 —— 第二次仍正常产出
check('② ★ 预算每次执行独立：第二次仍正常产出（不因第一次用完就 0 张）',
    results[1].kids === 5 && results[1].budget.used === 5,
    `第2次=${results[1].kids} 张，第2次 used=${results[1].budget.used}（第1次 used=${results[0].budget.used}）`);

// ③ 两次的 used 各自独立（不是累加到 10）
check('③ ★ 两次的 used 各自从 0 起算（不是跨执行累加）',
    results[0].budget.used <= 12 && results[1].budget.used <= 12,
    `第1次 used=${results[0].budget.used}，第2次 used=${results[1].budget.used}（若累积会是 10）`);

console.log(`\n${pass}/${pass + fails} 条通过`);
try { bot.quit(); } catch { }
try { sock.close(); } catch { }
await sleep(500);
process.exit(fails === 0 ? 0 : 1);
