/**
 * t31 真机：`!do obtain` 拆单原文 + `!do shelter` 方块证据 + idle-plan 观察。
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { openBoard, listJobs } from '../src/agent/library/board_store.js';
import { BoardClient } from '../src/agent/library/board_client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const MS_PORT = 18094;
const NAME = 'm10b' + (Date.now() % 100000);

// ── 起 mindserver（带任务板）──────────────────────────────────────
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

// ★ 必须报**全部**注册技能 —— 与 agent.js 的 _registeredSkills() 一致。
//   第一版我只报了 ['obtain','shelter']，于是 board:add 的安全校验①b
//   （"该 bot 没上报过这个技能"）把需要的 craft/mine 等子单全拒了 →
//   父单（skill=obtain）成功、子单 0 张。这是我 harness 的错，不是产品 bug。
const reg = await import('../src/agent/library/composite_registry.js');
const board = new BoardClient({ socket: sock, name: NAME, skills: reg.SKILL_NAMES, timeoutMs: 5000 });
await board.hello();
const { db } = openBoard();
try { db.exec('DELETE FROM jobs'); } catch { }

const p = bot.entity.position;
const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
await RC(`fill ${bx - 6} ${by - 1} ${bz - 6} ${bx + 6} ${by - 1} ${bz + 6} stone`);
await RC(`fill ${bx - 6} ${by} ${bz - 6} ${bx + 6} ${by + 6} ${bz + 6} air`);
await RC(`clear ${NAME}`).catch(() => { });
await sleep(300);

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

// ══ ① !do obtain：贴拆出的子单原文（要 parentId + why）════════════
{
    const { obtain, planObtain } = await import('../src/agent/library/strat_obtain.js');
    const agent = { bot, name: NAME, board };

    // ★ 先看 planObtain 到底出了几张（区分"没规划出来" vs "规划了但没下出去"）
    const inv = {};
    for (const it of (bot.inventory?.items?.() ?? [])) inv[it.name] = (inv[it.name] ?? 0) + it.count;
    const plan = planObtain({ item: 'iron_pickaxe', count: 1, inventory: inv, chests: {} });
    console.log(`  [诊断] planObtain 张数=${plan.plan.length} gaps=${JSON.stringify(plan.gaps)} 背包物品数=${Object.keys(inv).length}`);
    console.log(`  [诊断] 计划: ${plan.plan.map((p) => p.skill + ':' + (p.args?.item ?? p.args?.ore)).join(', ')}`);

    const r = await obtain(agent, 'iron_pickaxe', 1, { board });
    console.log(`\n=== ① !do obtain "item=iron_pickaxe count=1" ===`);
    console.log(`返回: ok=${r.ok} code=${r.code} parentId=${r.data?.parentId ?? '-'} 子单数=${r.data?.jobs?.length ?? 0}`);
    const all = listJobs(db, {});
    const parent = all.find((j) => j.id === r.data?.parentId);
    const kids = all.filter((j) => j.parentId === r.data?.parentId);
    console.log(`父单: ${parent?.id} title="${parent?.title}"`);
    for (const k of kids) {
        console.log(`  子单 ${k.id} skill=${k.skill} parentId=${k.parentId} why="${k.why}" args=${JSON.stringify(k.args)}`);
    }
    const hasParentId = kids.length > 0 && kids.every((k) => k.parentId === r.data?.parentId);
    const hasWhy = kids.length > 0 && kids.every((k) => typeof k.why === 'string' && k.why.length > 0);
    check('① !do obtain 拆出带 parentId + why 的子单', r.ok && hasParentId && hasWhy,
        `子单 ${kids.length} 张，全部带 parentId 与 why`);
}

// ══ ② !do shelter：贴方块证据（不只接口 ok）══════════════════════
{
    await RC(`give ${NAME} cobblestone 64`); await sleep(1200);
    const { shelter } = await import('../src/agent/library/flow_shelter.js');
    const r = await shelter(bot, { block: 'cobblestone', radius: 1, ctx: { deadline: Date.now() + 180000 } });
    console.log(`\n=== ② !do shelter ===`);
    console.log(`返回: ok=${r.ok} code=${r.code} material=${r.data?.material} placed=${r.data?.placed}/${r.data?.want}`);

    // ★ 方块证据：数周围是不是真的多了一圈墙 + 顶
    const p2 = bot.entity.position;
    const cx = Math.floor(p2.x), cy = Math.floor(p2.y), cz = Math.floor(p2.z);
    let walls = 0, roof = 0;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const edge = Math.abs(dx) === 1 || Math.abs(dz) === 1;
            if (!edge) continue;
            for (const y of [cy, cy + 1]) {
                const b = bot.blockAt(new (await import('vec3')).default(cx + dx, y, cz + dz));
                if (b && b.name !== 'air') walls++;
            }
            const rb = bot.blockAt(new (await import('vec3')).default(cx + dx, cy + 2, cz + dz));
            if (rb && rb.name !== 'air') roof++;
        }
    }
    console.log(`   方块证据：外圈墙 ${walls}/16 格非空气，顶 ${roof}/9 格非空气`);
    check('② !do shelter 真的搭起来了（墙 + 顶方块证据）', r.ok && walls >= 12 && roof >= 7,
        `墙=${walls}/16 顶=${roof}/9`);
}

console.log(`\n${pass}/${pass + fails} 条通过`);
try { bot.quit(); } catch { }
try { sock.close(); } catch { }
await sleep(600);
process.exit(fails === 0 ? 0 : 1);
