/**
 * t31 真机：`!do obtain` 拆单原文 + `!do shelter` 方块证据 + idle-plan 观察。
 */
import { openTempBoard } from './temp_board.mjs';
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
// t23：握手 token 门之后，裸 io(...) 会被 mindserver 拒绝（AUTH_REQUIRED），
// 而这里的 await 会在 connect_error 上 reject —— 补 token 并显式失败。
const { connectMindserver, awaitConnect } = await import('./lib/ms_token.mjs');
const sock = connectMindserver(ioc, MS_PORT);
if (!await awaitConnect(sock, { label: 'm10_do_live' })) process.exit(1);

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
const { db } = openTempBoard('m10');
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
    const shelterMod = await import('../src/agent/library/flow_shelter.js');
    const { shelter } = shelterMod;

    // ★★ 证据探针：**按蓝图坐标数，不用"她当前位置"当圆心**
    //   （2026-11-03 自我纠正：之前的探针以她的当前位置为圆心，
    //    而每轮结束时她位置不同 → 数出来的 4/16、8/9 毫无意义。
    //    **判据：证据的坐标系必须是固定的、与被测对象的当前状态无关。**）
    const V3 = (await import('vec3')).default;
    const ANCHOR = { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) };
    /** 按固定蓝图基准数：返回 {wallOk, roofOk, missing[]} */
    const auditByBlueprint = () => {
        const plan = shelterMod.shelterBuildOrder(ANCHOR, 'cobblestone', 3, { floor: 'never', doorSide: '+x' });
        const airish = new Set(['air', 'cave_air', 'void_air']);
        const missing = plan.filter((b) => {
            const cur = bot.blockAt(new V3(b.x, b.y, b.z), false);
            return !cur || airish.has(cur.name);
        });
        const wallTotal = plan.filter((b) => ['wall1', 'wall2'].includes(b.phase)).length;
        const roofTotal = plan.filter((b) => ['roofRing', 'cap'].includes(b.phase)).length;
        const wallMissing = missing.filter((b) => ['wall1', 'wall2', 'sealDoor'].includes(b.phase)).length;
        const roofMissing = missing.filter((b) => ['roofRing', 'cap'].includes(b.phase)).length;
        return {
            wallOk: wallTotal - wallMissing, wallTotal,
            roofOk: roofTotal - roofMissing, roofTotal,
            missing: missing.map((b) => ({ x: b.x, y: b.y, z: b.z, phase: b.phase })),
            anchor: ANCHOR,
        };
    };

    // 封 cap 前的三个数（用户要求）
    {
        const f = bot.entity.position;
        const capProbe = shelterMod.capCell({ x: f.x, y: f.y, z: f.z });
        const vv = new V3(capProbe.x, capProbe.y, capProbe.z);
        const noForce = (() => { try { return bot.blockAt(vv, false); } catch (e) { return 'THREW'; } })();
        const withForce = (() => { try { return bot.blockAt(vv, true); } catch (e) { return 'THREW'; } })();
        const col = (() => { try { return bot.world?.getColumnAt?.(vv) ?? null; } catch (e) { return 'THREW'; } })();
        console.log(`  [诊断①] 脚位=(${Math.floor(f.x)},${Math.floor(f.y)},${Math.floor(f.z)}) cap=(${capProbe.x},${capProbe.y},${capProbe.z})`);
        console.log(`  [诊断②] blockAt(false)=${noForce?.name ?? 'null'}  blockAt(true)=${withForce?.name ?? 'null'}`);
        console.log(`  [诊断③] getColumnAt=${col ? '有' : 'null'}`);
    }

    const r = await shelter(bot, { block: 'cobblestone', radius: 1, ctx: { deadline: Date.now() + 180000 } });
    console.log(`\n=== ② !do shelter ===`);
    console.log(`返回: ok=${r.ok} code=${r.code} material=${r.data?.material} placed=${r.data?.placed}/${r.data?.want}`);

    // ★ 方块证据：数周围是不是真的多了一圈墙 + 顶
    const p2 = bot.entity.position;
    const cx = Math.floor(p2.x), cy = Math.floor(p2.y), cz = Math.floor(p2.z);
    // ★ 按**固定蓝图基准**数（ANCHOR 是 shelter 开始前的脚位，与被测对象当前状态无关）
    const audit = auditByBlueprint();
    console.log(`   方块证据（按固定蓝图基准 anchor=${JSON.stringify(audit.anchor)}）: `
        + `墙(含门) ${audit.wallOk}/${audit.wallTotal}，顶(含cap) ${audit.roofOk}/${audit.roofTotal}`);
    if (audit.missing.length) console.log(`   缺的块: ${JSON.stringify(audit.missing)}`);
    console.log(`   可观测数据：placed=${r.data?.placed}/${r.data?.total} costMs=${r.data?.costMs} sealed=${r.data?.sealed} inside=${r.data?.insideAfter}`);
    console.log(`   [诊断] reason=${r.data?.reason ?? '(null)'} code=${r.code}`);

    check('② !do shelter 真的搭起来了（ok=true + 墙16/16 + 顶9/9 + 门已封）',
        r.ok && walls === 16 && roof === 9 && r.data?.sealed === true && r.data?.insideAfter === true,
        `墙=${walls}/16 顶=${roof}/9 placed=${r.data?.placed}/${r.data?.total} 门已封=${r.data?.sealed} 人在屋里=${r.data?.insideAfter}`);
}

console.log(`\n${pass}/${pass + fails} 条通过`);
try { bot.quit(); } catch { }
try { sock.close(); } catch { }
await sleep(600);
process.exit(fails === 0 ? 0 : 1);
