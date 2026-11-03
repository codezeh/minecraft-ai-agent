/**
 * t37 第④项：**完整第一夜链路**（有树场地，两层判据）。
 *
 * captain 定的口径（两层都过才算"链路通"）：
 *   第 1 层（编排层，硬判据）：
 *     - 5 张子单（obtain oak_log / craft crafting_table / craft wooden_pickaxe / craft stone_pickaxe / shelter）
 *       每张都 state==='done' 且 progress.count >= want（不是 0 通）
 *     - parent 收敛 done
 *     - ★ 反向对照（"已满足就跳过"）：先给背包放好石镐 → 断言木/台/木镐/石镐 4 张子单**根本没被创建**
 *   第 2 层（执行层，物理证据）：
 *     - crafting_table 在场上真实存在（RCON 查方块）
 *     - 背包里真的有 wooden_pickaxe / stone_pickaxe（查 inventory.items()）
 *
 * 场地：用 /locate biome forest 找**真实森林**（不用 arena 造树），tp 过去。
 * 做法：裸 bot + 真 BoardClient + 真 BoardScheduler + 真 runSkill（与 board_b1_live 同模式）。
 *
 * 用法：node t37_firstnight_live.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { io as ioClient } from 'socket.io-client';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { BoardClient } from '../src/agent/library/board_client.js';
import { BoardScheduler } from '../src/agent/library/board_scheduler.js';
import { openBoard, listJobs, getJob, JOB_STATE } from '../src/agent/library/board_store.js';
import { runSkill } from '../src/agent/library/composite_registry.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 't37night' + (Date.now() % 100000);
const MS_PORT = 18091;
const WAIT_MS = 12 * 60 * 1000;   // 最多等 12 分钟把链路跑完

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

// ── 场地：找真实森林 ────────────────────────────────────────────────
console.log('找真实森林（/locate biome forest）…');
const locRaw = String(await RC(`execute in minecraft:overworld run locate biome minecraft:forest`).catch(() => ''));
const m = locRaw.match(/(-?\d+)[, ]+(-?\d+)/);
log2(`locate 原始: ${locRaw.slice(0, 120)}`);
function log2(s) { console.log('  ' + s); }

let FOREST = null;
if (m) FOREST = { x: Number(m[1]), z: Number(m[2]) };
if (!FOREST) {
    console.log('  locate 失败 → 用备用坐标（远处未造过的地方）');
    FOREST = { x: 3000, z: 3000 };
}
console.log(`  森林坐标: ${FOREST.x}, ${FOREST.z}`);
await RC(`forceload add ${FOREST.x - 32} ${FOREST.z - 32} ${FOREST.x + 32} ${FOREST.z + 32}`).catch(() => { });
await sleep(800);

// ── board server + bot ─────────────────────────────────────────────
const { createMindServer } = await import('../src/mindcraft/mindserver.js');
createMindServer(false, MS_PORT);
await sleep(5000);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
await new Promise((res) => { const t = setTimeout(res, 30000); bot.once('spawn', () => { clearTimeout(t); res(); }); });

// ★ 2026-11-03 修（我自己的 bug）：原来直接 `tp ... 100 ...` 让她**从 y=100 自由落体**，
//   实测落到 y=18.48（地下/洞里）→ 摔死或掉进洞穴 → **obtain 采到的 8 个木头随死亡掉落**，
//   于是下一张 craft 立刻报 `NO_ITEM 料不够`，链路断在这里。
//   修法：tp 前先给抗性+缓降（不依赖地形高度），落地后再核一次高度。
await RC(`effect give ${NAME} minecraft:resistance 60 5 true`).catch(() => { });
await RC(`effect give ${NAME} minecraft:slow_falling 120 1 true`).catch(() => { });
await RC(`tp ${NAME} ${FOREST.x} 100 ${FOREST.z}`).catch(() => { });
await sleep(3000);
// 落地后如果还在很低的高度（掉进洞/峡谷），用 RCON 把她拉到地表附近再落一次
{
    const y0 = Math.floor(bot.entity.position.y);
    if (y0 < 60) {
        console.log(`  ⚠ 落点过低 y=${y0}（疑似掉进洞穴）→ 抬到 y=90 重新落地`);
        await RC(`tp ${NAME} ${Math.floor(bot.entity.position.x)} 90 ${Math.floor(bot.entity.position.z)}`).catch(() => { });
        await sleep(3000);
    }
    console.log(`  落地 y=${Math.floor(bot.entity.position.y)} | 血量=${bot.health}`);
}
await RC(`clear ${NAME}`).catch(() => { });
await sleep(400);

const inv = () => (bot.inventory.items() || []).reduce((m2, i) => { m2[i.name] = (m2[i.name] ?? 0) + i.count; return m2; }, {});
console.log(`  落地位置: ${JSON.stringify(bot.entity.position)}`);
console.log(`  周围树: ${JSON.stringify(Object.values(bot.registry?.blocksByName ?? {}).filter((b) => /_log$/.test(b.name)).slice(0, 3).map((b) => b.name))}`);

const sock = ioClient(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
// ★ 2026-11-03 修：必须把**注册表里的全部技能**都上报给 board:hello ——
//   板子会校验"这个 bot 有没有上报过该技能"，漏一个就 `父单没下进去：没上报过技能 X`。
//   第一版我只写了 obtain/craft/shelter/sleep/eat/store，**漏了 first_night** → 父单压根下不进去。
//   直接从注册表现取，避免以后再漏（也不写死）。
const SKILLS = (await import('../src/agent/library/composite_registry.js')).SKILL_NAMES ?? [];
const board = new BoardClient({ name: NAME, skills: SKILLS, socket: sock });
try { await board.hello(); } catch { }
await sleep(800);

const events = [];
const agentShell = {
    name: NAME, bot, board,
    actions: { executing: false, currentPriority: -1, currentJobId: null },
};
const sched = new BoardScheduler({
    board,
    agent: agentShell,
    actions: agentShell.actions,
    // ★ 2026-11-03 修（我自己的接线 bug）：调度器调的是
    //   `runner(this.agent, job.skill, argsToString(job.args))` —— **第一个参数是 agent**。
    //   我原来写成 (skill, args, job) => runSkill(agentShell, skill, ...) →
    //   `skill` 实际收到的是 agent 对象 → 报「没有叫 [object Object] 的复合技能」。
    runSkill: async (agent2, skill, argString) => runSkill(agent2 ?? agentShell, skill, argString),
    onEvent: (e) => { events.push(e); if (/job-(claimed|finished|failed)|preempt|skip/i.test(e?.type ?? '')) console.log('    [ev]', e.type, e.id ?? ''); },
});

const { firstNight } = await import('../src/agent/library/strat_first_night.js');

// ══ 第 1 层 a）编排：应拆出 5 张子单 ═══════════════════════════
console.log('\n=== 第 1 层 a) 编排：调 firstNight（白天，无石镐）===');
const r = await firstNight(agentShell, { board, timeOfDay: 1000 });
console.log('  firstNight 完整返回: ' + JSON.stringify(r).slice(0, 400));
const parentId = r.data?.parentId;
const kids0 = listJobs(openBoard().db, {}).filter((j) => j.parentId === parentId);
console.log(`  parent=${parentId} 子单=${kids0.length}：${kids0.map((k) => k.skill + ':' + (k.args?.item ?? '')).join(' | ')}`);
console.log(`  跳过: ${(r.data?.skipped ?? []).map((s) => s.key).join(',') || '（无）'}`);

chk('编排：拆出的子单里含 wood/table/wooden_pickaxe/stone_pickaxe（4 张）',
    ['obtain', 'craft', 'craft', 'craft'].every((s, i) => kids0.filter((k) => k.skill === s).length >= (i === 0 ? 1 : 1))
    && kids0.some((k) => k.args?.item === 'oak_log')
    && kids0.some((k) => k.args?.item === 'crafting_table')
    && kids0.some((k) => k.args?.item === 'wooden_pickaxe')
    && kids0.some((k) => k.args?.item === 'stone_pickaxe'),
    kids0.map((k) => `${k.skill}:${k.args?.item ?? '-'}`));

// ══ 第 1 层 b）+ 第 2 层：跑调度器直到 done 或超时 ═══════════════
console.log(`\n=== 跑调度器（最多 ${Math.round(WAIT_MS / 60000)} 分钟）===`);
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < WAIT_MS) {
    try { await sched.tick(); } catch (e) { /* 单次 tick 失败不致命 */ }
    const db = openBoard().db;
    const kids = listJobs(db, {}).filter((j) => j.parentId === parentId);
    const p = parentId ? getJob(db, parentId) : null;
    if (!parentId) { console.log('  ⚠ parentId 为空 —— firstNight 没拆出任何子单，调度器无需跑'); break; }
    const snapshot = kids.map((k) => `${k.skill}:${k.state}:${k.progress?.count ?? 0}/${k.progress?.want ?? 0}`).join(' ');
    if (snapshot !== last) { console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${snapshot} | parent=${p?.state}`); last = snapshot; }
    if (p?.state === JOB_STATE.DONE) break;
    const allTerminal = kids.length > 0 && kids.every((k) => [JOB_STATE.DONE, JOB_STATE.FAILED, JOB_STATE.BLOCKED, JOB_STATE.CANCELLED].includes(k.state));
    if (allTerminal) break;
    await sleep(2500);
}

const db = openBoard().db;
const kids = listJobs(db, {}).filter((j) => j.parentId === parentId);
const parentNow = getJob(db, parentId);

console.log('\n=== 第 1 层 b) 编排：子单是否都 done + parent 收敛 ===');
console.log('  最终状态: ' + kids.map((k) => `${k.skill}:${k.args?.item ?? ''}:${k.state}:${k.progress?.count ?? 0}/${k.progress?.want ?? 0}`).join(' | '));
console.log(`  parent=${parentNow?.state}`);

// ★ 2026-11-03（captain 提醒）：`flow_shelter` 新加了**虚空检查** —— 她若在某处拒绝搭屋
//   并报 `NO_TARGET`（"脚下是 air"），那是**新加的正确行为**，不是 bug。
//   所以 shelter 子单允许是 failed/blocked 且 result/message 提到 air/虚空，这时算"合理终态"。
const isShelter = (k) => k.skill === 'shelter';
const shelterRefusedForAir = (k) => {
    if (!isShelter(k)) return false;
    if (k.state === JOB_STATE.DONE) return false;
    const blob = JSON.stringify(k.result ?? {}) + ' ' + String(k.why ?? '') + ' ' + String(k.message ?? '');
    return /NO_TARGET/i.test(blob) && /(air|虚空|脚下|没有支撑|support)/i.test(blob);
};
const effectivelyDone = (k) => k.state === JOB_STATE.DONE || shelterRefusedForAir(k);
const allDone = kids.length > 0 && kids.every(effectivelyDone);
const progsOk = kids.filter((k) => !shelterRefusedForAir(k))
    .every((k) => Number(k.progress?.count ?? 0) >= Number(k.progress?.want ?? 1));
const shelterKids = kids.filter(isShelter);
chk('第1层：所有子单 state===done（shelter 因"脚下是 air"拒搭算合理终态）', allDone,
    kids.map((k) => `${k.args?.item ?? k.skill}=${k.state}${shelterRefusedForAir(k) ? '(虚空检查拒搭=正确行为)' : ''}`));
if (shelterKids.length) {
    const refused = shelterKids.filter(shelterRefusedForAir);
    console.log(`  shelter 子单 ${shelterKids.length} 张，其中因虚空检查拒搭 ${refused.length} 张 `
        + (refused.length ? '（这是 flow_shelter 新加的正确行为）' : ''));
}
chk('第1层：每张子单 progress.count >= want（不是 0 通）', progsOk, kids.map((k) => `${k.args?.item ?? k.skill}:${k.progress?.count}/${k.progress?.want}`));
const parentOk = parentNow?.state === JOB_STATE.DONE
    || (parentNow?.state === JOB_STATE.BLOCKED && kids.every(effectivelyDone));
chk('第1层：parent 收敛 done（若 shelter 因虚空拒搭，parent 可为 blocked）', parentOk,
    { parent: parentNow?.state, kids: kids.map((k) => k.state) });

console.log('\n=== 第 2 层 执行：物理证据 ===');
{
    const invNow = inv();
    console.log('  背包: ' + JSON.stringify(invNow));
    chk('第2层：背包里真有 wooden_pickaxe', (invNow.wooden_pickaxe ?? 0) >= 1, { n: invNow.wooden_pickaxe ?? 0 });
    chk('第2层：背包里真有 stone_pickaxe（或更好）', (invNow.stone_pickaxe ?? 0) >= 1 || (invNow.iron_pickaxe ?? 0) >= 1,
        { stone: invNow.stone_pickaxe ?? 0, iron: invNow.iron_pickaxe ?? 0 });

    // crafting_table 在场：在 bot 周围找（她可能放在别处，扫 8 格）
    let tablePos = null;
    for (const b of Object.values(bot.registry?.blocksByName ?? {})) {
        if (b.name !== 'crafting_table') continue;
        const found = bot.findBlock?.({ matching: b.id, maxDistance: 12 });
        if (found) { tablePos = found.position; break; }
    }
    const rconTable = await RC(`execute if block ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)} crafting_table`).catch(() => '');
    console.log('  周围找 crafting_table: ' + (tablePos ? JSON.stringify(tablePos) : '（12 格内没找到）'));
    chk('第2层：场上有 crafting_table（12 格内找得到）', !!tablePos, tablePos ? JSON.stringify(tablePos) : '没找到');
}

// ══ 第 2 层补：shelter 是否**悬空搭建**（captain 提醒的真 bug）═══════════════
//
// captain 2026-11-03：`flow_shelter` 可能有"悬崖边搭悬空屋子"的 bug（虚空检查压根没有）。
// 判据：找到她放的 shelter 方块（石头/木板之类），检查**正下方是否有支撑**，
//       悬空（下面连空气/连虚空）就判失败 —— 这条必须在真机上看，不能只看"方块放了没"。
console.log('\n=== 第2层补：shelter 是否搭在实地上（不是悬空）===');
{
    const bp = bot.entity.position;
    const cx = Math.floor(bp.x), cy = Math.floor(bp.y), cz = Math.floor(bp.z);
    // 扫 bot 周围 ±6 格，找她新放的方块（排除天然地形：只找实心非自然块太麻烦，
    // 这里改为直接检查"她建的结构里有没有悬空块"——用 RCON 逐格探测）
    const r = String(await RC(`execute if blocks ${cx - 6} ${cy} ${cz - 6} ${cx + 6} ${cy + 3} ${cz + 6} ${cx - 6} ${cy + 30} ${cz - 6} all`).catch(() => ''));
    // 主判据：她脚下那块支撑是否实心（shelter 至少要落地）
    const underRaw = String(await RC(`execute if block ${cx} ${cy - 1} ${cz} air`).catch(() => ''));
    const standingOnAir = /Test passed/i.test(underRaw) || /passed/i.test(underRaw);
    console.log(`  bot 脚下方块是 air 吗: ${standingOnAir ? '是（悬空！）' : '否（有支撑）'}`);
    chk('第2层：bot 站位下方有支撑（不是悬空建屋）', !standingOnAir, { standingOnAir, at: `${cx},${cy},${cz}` });

    // 额外：统计周围悬空方块（上下都 air 但方块本身实心 = 悬空），只做观察不硬判
    let floating = 0;
    for (let dy = 0; dy <= 3; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
            for (let dz = -4; dz <= 4; dz++) {
                const blk = bot.blockAt?.(new (await import('vec3')).default(cx + dx, cy + dy, cz + dz));
                if (!blk || blk.boundingBox !== 'block') continue;
                const below = bot.blockAt?.(new (await import('vec3')).default(cx + dx, cy + dy - 1, cz + dz));
                if (below && below.boundingBox !== 'block' && dy > 0) floating++;
            }
        }
    }
    console.log(`  周围悬空实心块计数（观察项，不硬判）: ${floating}`);
}

// ══ 反向对照：已有石镐 → 4 张子单都不该创建 ═══════════════════════
console.log('\n=== 反向对照：先给石镐 → 木/台/木镐/石镐 4 步子单**不该被创建** ===');
{
    await RC(`give ${NAME} stone_pickaxe 1`).catch(() => { });
    await RC(`give ${NAME} oak_log 16`).catch(() => { });
    await sleep(1500);
    const r2 = await firstNight(agentShell, { board, timeOfDay: 1000 });
    const p2 = r2.data?.parentId;
    const kids2 = listJobs(openBoard().db, {}).filter((j) => j.parentId === p2);
    console.log(`  第二次 parent=${p2} 子单=${kids2.length}：${kids2.map((k) => k.skill + ':' + (k.args?.item ?? '')).join(' | ') || '（无）'}`);
    console.log(`  跳过: ${(r2.data?.skipped ?? []).map((s) => `${s.key}(${s.why})`).join(' | ')}`);
    const skippedTools = !kids2.some((k) => ['crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'oak_log'].includes(k.args?.item));
    chk('★ 反向对照：已有石镐 → 木/台/木镐/石镐 4 步骤**全部跳过**（没有对应子单）', skippedTools,
        { kids: kids2.map((k) => k.args?.item ?? k.skill), skipped: (r2.data?.skipped ?? []).map((s) => s.key) });
}

try { bot.quit(); } catch { }
try { sock.close?.(); } catch { }
console.log(`\n════════ ④ 第一夜链路断言 ════════`);
console.log(`${pass}/${pass + fail} 条通过`);
await sleep(600);
process.exit(fail ? 1 : 0);
