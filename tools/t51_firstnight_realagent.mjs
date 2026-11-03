/**
 * t51：用**真 agent 进程**跑 `!do first_night`（重跑第一夜链路，验证 d09bfee 的 count 语义修复）。
 *
 * 为什么要真 agent 进程（captain 定的）：
 *   上一轮我用"裸 bot + 手搭 BoardScheduler"的 harness，自己踩了 4 个接线 bug
 *   （hello 技能声明 / runSkill 签名 / tp 落点 / 路径）—— 手工搭的链路和真实链路太容易不一致。
 *   真 agent 进程测的才是生产路径。
 *
 * 做法：
 *   1. 起真 agent：`MINECRAFT_PORT=25566 MINDSERVER_PORT=18090 node main.js`（bot 名来自 profile = deepseek）
 *   2. 起一个**玩家 bot**（名字 = profile 里的 owner = HEAVENZEH），由它在聊天里发 `!do first_night`
 *      （agent 只认玩家聊天；RCON 的 /msg 是 Server 身份，会被当"非玩家"）
 *   3. 找真实森林 → tp deepseek 过去（先给抗性/缓降，避免自由落体摔死）
 *   4. 盯 board DB 看子单状态，跑够时间或收敛即止
 *
 * 关键新判据（d09bfee 后）：
 *   ★ `obtain` 子单**不能立刻 done** —— 必须是 `count:0, want:8` 之类（进度从 0 开始）
 *     若仍是 8/8 立刻 done → 说明修复不够，立刻报。
 */
import { spawn } from 'node:child_process';
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { join } from 'node:path';
import { rcon } from './rcon.mjs';
import { openBoard, listJobs, getJob, JOB_STATE } from '../src/agent/library/board_store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const MC_PORT = 25566;
const MS_PORT = 18090;
const OWNER = 'HEAVENZEH';        // profile 里的 owner（能下命令）
const AGENT_NAME = 'deepseek';    // profile 里的 bot 名
const WAIT_MS = 12 * 60 * 1000;

let pass = 0, fail = 0;
const chk = (n, c, i) => { if (c) { pass++; console.log('  PASS  ' + n + (i ? '   ' + i : '')); } else { fail++; console.log('  FAIL  ' + n + '   ' + JSON.stringify(i)); } };

// ── 版本自证 ────────────────────────────────────────────────────────
{
    const { execSync } = await import('node:child_process');
    try {
        const raw = execSync('git log -1 --format=%H%n%s', { encoding: 'utf8' }).trim();
        const NL = String.fromCharCode(10);
        console.log('═══ 运行版本自证 ═══');
        console.log('  ' + raw.split(NL).join(NL + '  '));
        console.log('═══════════════════');
    } catch { /* ignore */ }
}

// ── 1) 起真 agent 进程 ──────────────────────────────────────────────
console.log('\n启动真 agent 进程（main.js，MINECRAFT_PORT=' + MC_PORT + '，mindserver=' + MS_PORT + '）…');
const agentProc = spawn(process.execPath, ['main.js'], {
    env: { ...process.env, MINECRAFT_PORT: String(MC_PORT), MINDSERVER_PORT: String(MS_PORT), TRACE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let agentOut = '';
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync('tmp-t59-agent.log', '');
agentProc.stdout.on('data', (b) => {
    const s = String(b);
    agentOut += s;
try { appendFileSync('tmp-t59-agent.log', s); } catch { }
    for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/spawn|joined|登录|任务板|error|失败|需要|deepseek/i.test(t) && t.length < 160) console.log('  [agent] ' + t.slice(0, 150));
    }
});
agentProc.stderr.on('data', (b) => { const s = String(b).trim(); if (s) console.log('  [agent-err] ' + s.slice(0, 150)); });

// 等 agent 的 bot 真的进服
let agentJoined = false;
for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const list = String(await RC('list').catch(() => ''));
    if (new RegExp('\\b' + AGENT_NAME + '\\b').test(list)) { agentJoined = true; break; }
}
chk(`真 agent 的 bot「${AGENT_NAME}」已进服`, agentJoined, agentJoined ? '' : '60 次轮询未进服');
if (!agentJoined) {
    console.log('  agent 输出片段:', agentOut.slice(-600));
    try { agentProc.kill(); } catch { }
    process.exit(1);
}
await sleep(3000);

// ── 2) 找真实森林 → tp agent 过去 ──────────────────────────────────
console.log('\n找真实森林…');
let FOREST = null;
for (const biome of ['minecraft:forest', 'minecraft:birch_forest', 'minecraft:taiga', 'minecraft:dark_forest']) {
    const raw = String(await RC(`execute in minecraft:overworld run locate biome ${biome}`).catch(() => ''));
    const m = raw.match(/(-?\d+)[, ]+(-?\d+)/);
    if (m && !/Could not find/i.test(raw)) { FOREST = { x: Number(m[1]), z: Number(m[2]), biome }; break; }
}
// ★ t60：世界没有森林（locate biome 全部 Could not find），改用 RCON 造的橡树林
//   场地已验证：bot.findBlocks('oak_log', 32格) = 31 个方块（≥20）
if (!FOREST) { FOREST = { x: 6203, z: 8803, biome: '(RCON 手造橡树林 6 棵)' }; }
console.log(`  森林: ${FOREST.x}, ${FOREST.z} [${FOREST.biome}]`);
await RC(`forceload add ${FOREST.x - 48} ${FOREST.z - 48} ${FOREST.x + 48} ${FOREST.z + 48}`).catch(() => { });
await sleep(800);
// 先给抗性/缓降再 tp（避免 y=100 自由落体摔死）
await RC(`effect give ${AGENT_NAME} minecraft:resistance 60 5 true`).catch(() => { });
await RC(`effect give ${AGENT_NAME} minecraft:slow_falling 120 1 true`).catch(() => { });
// ★ 第 14 跑修（captain 批准）：原来 `tp ... 100 ...` + 固定 sleep → 她卡在 y=85 半空
//   （上一轮实测 feetY=85，树在 -59，垂直差 144 格 → findBlocks(32) 永远找不到树）。
//   改成：tp 后**轮询到她真的落到地面**（|y+59| <= 3）才继续；超时就重 tp 一次。
const TARGET_Y = -59;
const TX = FOREST.x, TZ = FOREST.z;

// ★ 第 20 跑（captain 要求）：**先让 tp 说不出谎**
//   ① 打**原始 Pos 串**（不解析），一打就能看出 RCON 回包格式
//   ② 判据改成"和树林坐标比对"，且**不到位就抛错退出**（不再"告警后继续跑"跑出不可用数据）
async function rawPos() {
    const raw = String(await RC(`data get entity ${AGENT_NAME} Pos`).catch(() => ''));
    return raw;
}
function parsePos(raw) {
    // 兼容两种：`[1.0d, 2.0d, 3.0d]` 与 `[1.0, 2.0, 3.0]`
    const m = String(raw).match(/\[\s*(-?[\d.]+)d?\s*,\s*(-?[\d.]+)d?\s*,\s*(-?[\d.]+)d?\s*\]/);
    if (!m) return null;
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

const beforeRaw = await rawPos();
console.log('  [TP] before(raw) = ' + JSON.stringify(beforeRaw).slice(0, 180));

let landed = null;
for (let attempt = 1; attempt <= 3; attempt++) {
    await RC(`tp ${AGENT_NAME} ${TX} ${TARGET_Y + 3} ${TZ}`).catch(() => { });
    await sleep(2200);
    const afterRaw = await rawPos();
    const p2 = parsePos(afterRaw);
    console.log(`  [TP] attempt${attempt} after(raw) = ` + JSON.stringify(afterRaw).slice(0, 180));
    console.log(`  [TP] attempt${attempt} parsed = ` + JSON.stringify(p2));
    if (p2) {
        const atTrees = Math.abs(p2.x - TX) <= 10 && Math.abs(p2.z - TZ) <= 10 && p2.y >= -62 && p2.y <= -56;
        if (atTrees) { landed = p2; break; }
        console.log(`  [TP] 不在树林（要求 ${TX},${TZ} ±10 且 y∈[-62,-56]）→ 重试`);
    } else {
        console.log('  [TP] Pos 串解析失败（上面的 raw 就是证据）→ 重试');
    }
    // 备选：先用 spreadplayers 撒到该带，再补 tp
    await RC(`forceload add ${TX - 10} ${TZ - 10} ${TX + 10} ${TZ + 10}`).catch(() => { });
    await RC(`spreadplayers ${TX} ${TZ} 0 3 false ${AGENT_NAME}`).catch(() => { });
    await sleep(2500);
}

if (!landed) {
    const finalRaw = await rawPos();
    console.error('  🔴 [TP] 三次都没把她送到树林 —— **抛错退出，不跑任务**（避免产出不可用数据）');
    console.error('     final(raw) = ' + JSON.stringify(finalRaw).slice(0, 200));
    try { agentProc.kill('SIGTERM'); } catch { }
    process.exit(9);
}
console.log(`  ★ [TP] 判据通过：Pos=(${Math.round(landed.x)}, ${Math.round(landed.y)}, ${Math.round(landed.z)}) | 树林=(${TX},${TARGET_Y},${TZ}) ±10`);
await RC(`clear ${AGENT_NAME}`).catch(() => { });
await sleep(500);

// ── 3) 玩家 bot（owner）发 !do first_night ─────────────────────────
console.log('\n起玩家 bot「' + OWNER + '」发命令…');
const playerBot = mineflayer.createBot({ host: '127.0.0.1', port: MC_PORT, username: OWNER, auth: 'offline', version: '1.21.8' });
playerBot.loadPlugin(pf.pathfinder);
playerBot.on('error', () => { });
// ★ 监听 agent 的聊天回话 —— 那就是 `!do` 的返回文本，能直接看出它为什么没下单
playerBot.on('chat', (username, message) => {
    if (username === OWNER) return;
    console.log(`  [chat] <${username}> ${String(message).slice(0, 320)}`);
});
await new Promise((res) => { const t = setTimeout(res, 30000); playerBot.once('spawn', () => { clearTimeout(t); res(); }); });
await sleep(2500);
await RC(`tp ${OWNER} ${FOREST.x + 2} 100 ${FOREST.z}`).catch(() => { });
await sleep(2500);

const db = openBoard().db;
const beforeIds = new Set(db.prepare('SELECT id FROM jobs').all().map((r) => r.id));

console.log('  发送: !do first_night');
// ★ 2026-11-03 修（t52 诊断查明的真因，离线可证）：
//   `parseCommandMessage` 的 argRegex 只认 **数字 / true / false / 双引号字符串**，
//   而且 `!do` 的 `args` 参数**没有默认值（必填）**。所以：
//     `!do first_night`        → ERR「missing param 'name'」（裸词不被识别）
//     `!do("first_night")`     → ERR「missing param 'args'」（args 必填）
//     `!do("first_night", "")` → ✅ 正确
//   → 这一条本身是可用性问题（自然写法都失败），已单独报 captain。
playerBot.chat('!do("first_night", "")');
await sleep(15000);
// 若还没父单，再发一次（agent 可能正被 idle 单占着）
{
    // ★ 第 25 跑（captain 要求）：**去掉重发逻辑** —— 上一轮 16_56z 就是它造成的
    //   重复 first_night 父单，抢走 18/19/20 三张子单，让一只 bot 同时应付 4 个 running，
    //   很可能是 STUCK 的诱因之一。现在**只发一次**。
    const dbx = openBoard().db;
    const hasFn = dbx.prepare("SELECT COUNT(*) c FROM jobs WHERE skill='first_night'").get().c > 0;
    console.log('  [确认] 15 秒检查：first_night 父单数 = ' + dbx.prepare("SELECT COUNT(*) c FROM jobs WHERE skill='first_night'").get().c + '（不重发）');
}
await sleep(4000);

// ── 4) 盯任务板 ─────────────────────────────────────────────────────
console.log('\n等子单出现并执行（最多 ' + Math.round(WAIT_MS / 60000) + ' 分钟）…');
let parentId = null;
const t0 = Date.now();
let lastSnap = '';
let obtainFirstSeen = null;   // ★ 记录 obtain 子单第一次出现的进度（关键判据）

let loopErr = null;
while (Date.now() - t0 < WAIT_MS) {
  try {
    const jobs = db.prepare('SELECT * FROM jobs ORDER BY createdAt').all();
    const fresh = jobs.filter((j) => !beforeIds.has(j.id));
    if (!parentId) {
        const p = fresh.find((j) => { try { return JSON.parse(j.args || '{}').maxJobs !== undefined || j.skill === 'first_night'; } catch { return false; } });
        if (p) { parentId = p.id; console.log('  父单: ' + parentId); }
    }
    // ★★ 2026-11-03 修（captain 点名的我的缺陷）：**严格按 parentId 过滤，绝不退化**。
    //   上一版写成 `parentId ? filter : fresh` —— 父单没识别到时退化成"全部新单"，
    //   把 105 张 idle 单当子单反复打印，**把 first_night=0 这个真信号淹没了**。
    //   过滤条件失效时输出看起来更丰富，实际全是噪声（与"测量工具骗自己"同一类）。
    const kids = parentId ? fresh.filter((j) => j.parentId === parentId) : [];

    // ★ 风暴检测：新单数量异常且没有我们的父单 → 立刻停，别等 10 分钟
    if (!parentId && fresh.length >= 15) {
        const bySkill = {};
        for (const j of fresh) { const k = j.skill + ':' + (() => { try { return JSON.parse(j.args || '{}').item ?? ''; } catch { return ''; } })(); bySkill[k] = (bySkill[k] ?? 0) + 1; }
        console.log('  🔴 风暴检测：新单 ' + fresh.length + ' 张且没有 first_night 父单 → 立刻停');
        console.log('     按 skill:item = ' + JSON.stringify(bySkill));
        console.log('     （说明还有第三处 want 漏修，或 idle_planner 仍在抢跑）');
        try { playerBot.quit(); } catch { }
        try { agentProc.kill('SIGTERM'); } catch { }
        process.exit(2);
    }
    // ★ 关键：obtain 子单第一次出现时的进度
    const ob = kids.find((k) => k.skill === 'obtain');
    if (ob && !obtainFirstSeen) {
        const pr = JSON.parse(ob.progress || 'null');
        obtainFirstSeen = { state: ob.state, progress: pr, args: JSON.parse(ob.args || '{}') };
        console.log('  ★ obtain 子单首次出现: state=' + ob.state + ' progress=' + JSON.stringify(pr) + ' args=' + JSON.stringify(obtainFirstSeen.args));
    }
    const snap = kids.map((k) => {
        const pr = JSON.parse(k.progress || 'null');
        const it = (() => { try { return JSON.parse(k.args || '{}').item ?? ''; } catch { return ''; } })();
        return `${k.skill}:${it}:${k.state}:${pr?.count ?? '-'}/${pr?.want ?? '-'}`;
    }).join(' ');
    if (snap !== lastSnap) {
        console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${snap}`);
        lastSnap = snap;
    }
    const par = parentId ? getJob(db, parentId) : null;
    const allTerminal = kids.length > 0 && kids.every((k) => [JOB_STATE.DONE, JOB_STATE.FAILED, JOB_STATE.BLOCKED, JOB_STATE.CANCELLED].includes(k.state));
    // ★ 30 秒仍无父单 → 阻断信号，立刻停并报（captain 第 6 点：先报这个，别再往下堆数据）
    if (!parentId && Date.now() - t0 > 120000) {
        const bySkill = {};
        for (const j of fresh) { const k = j.skill + ':' + (() => { try { return JSON.parse(j.args || '{}').item ?? ''; } catch { return ''; } })(); bySkill[k] = (bySkill[k] ?? 0) + 1; }
        console.log('  🔴 120 秒内没有 first_night 父单 → 阻断信号，停止');
        console.log('     期间新单 ' + fresh.length + ' 张，按 skill:item = ' + JSON.stringify(bySkill));
        try { playerBot.quit(); } catch { }
        try { agentProc.kill('SIGTERM'); } catch { }
        process.exit(3);
    }
    if (par && [JOB_STATE.DONE, JOB_STATE.BLOCKED, JOB_STATE.FAILED].includes(par.state) && allTerminal) {
        console.log('  父单与子单都已终态，提前结束等待');
        break;
    }
  } catch (e) {
    loopErr = String(e?.message ?? e);
    console.log('  ⚠ 轮询异常（继续等）: ' + loopErr.slice(0, 120));
  }
  await sleep(3000);
}
// ★ 打印退出原因（captain 要求：不许静默提前退出）
{
    const waited = Math.round((Date.now() - t0) / 1000);
    const jobs2 = db.prepare('SELECT * FROM jobs ORDER BY createdAt').all();
    const fresh2 = jobs2.filter((j) => !beforeIds.has(j.id));
    const kids2 = parentId ? fresh2.filter((j) => j.parentId === parentId) : [];
    const par2 = parentId ? getJob(db, parentId) : null;
    const st = {};
    for (const k of kids2) st[k.state] = (st[k.state] ?? 0) + 1;
    console.log(`  [退出原因] 等待 ${waited}s / 上限 ${Math.round(WAIT_MS / 1000)}s | parent=${par2?.state ?? '无'} | 子单状态分布=${JSON.stringify(st)} | 循环异常=${loopErr ?? '无'}`);
}

// ── 5) 断言 ─────────────────────────────────────────────────────────
const jobs = db.prepare('SELECT * FROM jobs ORDER BY createdAt').all();
const fresh = jobs.filter((j) => !beforeIds.has(j.id));
const parent = parentId ? getJob(db, parentId) : null;
const kids = parentId ? fresh.filter((j) => j.parentId === parentId) : [];

const parse = (j) => ({ args: JSON.parse(j.args || '{}'), pr: JSON.parse(j.progress || 'null'), res: JSON.parse(j.result || 'null') });
const byItem = (item) => kids.find((k) => parse(k).args.item === item);

console.log('\n=== 子单原文 ===');
for (const k of kids) {
    const { args, pr, res } = parse(k);
    console.log(`  ${k.id.slice(-6)} skill=${k.skill} item=${args.item ?? '-'} state=${k.state} progress=${JSON.stringify(pr)} attempts=${k.attempts}`);
    if (res) console.log(`       result=${JSON.stringify(res).slice(0, 160)}`);
}

console.log('\n=== 判据 ===');
// ★ 关键新判据：obtain 不能立刻 done
const obFinal = kids.find((k) => k.skill === 'obtain');
const obSeen = obtainFirstSeen;
if (obSeen) {
    const pr = obSeen.progress;
    const liars = obSeen.state === JOB_STATE.DONE && (pr?.want == null || Number(pr.count) >= Number(pr.want));
    chk('★ d09bfee 修复：obtain 子单**首次出现时不是"立刻 done + 满进度"**（count 是背包真值）',
        !liars, { 首次: obSeen, note: '应为 count:0 want:8 之类' });
    chk('★ obtain 记录了 want（请求数）而不是 want:null',
        pr?.want != null, { want: pr?.want });
} else {
    chk('★ obtain 子单出现过（能看到它的首次进度）', false, '没捕获到 obtain 子单');
}

// ★★ t57 关键新判据（captain 指定，**查库不看背包**）：obtain:oak_log 的 progress.count > 0
//   背包跨轮保留（bot 名固定 deepseek）→ 看背包永远说不清"这轮到底撸到没有"。
{
    const obOak = kids.find((k) => { try { return JSON.parse(k.args || '{}').item === 'oak_log'; } catch { return false; } });
    const pr = obOak ? JSON.parse(obOak.progress || 'null') : null;
    console.log('  ★ obtain:oak_log 查库：state=' + (obOak?.state ?? '不存在') + ' progress=' + JSON.stringify(pr));
    chk('① obtain:oak_log 子单存在（查库）', !!obOak, { exists: !!obOak });
    chk('★★ obtain:oak_log 的 progress.count > 0（真的撸到木头了 —— 验证 1855dbb）',
        Number(pr?.count ?? 0) > 0, { progress: pr });
}

// 第 1 层
const shelterRefused = (k) => k.skill === 'shelter' && k.state !== JOB_STATE.DONE
    && /NO_TARGET/i.test(JSON.stringify(parse(k).res ?? {})) && /(air|虚空|脚下|支撑)/i.test(JSON.stringify(parse(k).res ?? {}));
const effDone = (k) => k.state === JOB_STATE.DONE || shelterRefused(k);
chk('第1层：所有子单 done（shelter 虚空拒搭算合理）', kids.length > 0 && kids.every(effDone),
    kids.map((k) => `${k.args ? parse(k).args.item ?? k.skill : k.skill}=${k.state}`));
chk('第1层：每张子单 progress.count >= want（不是 0 通）',
    kids.filter((k) => !shelterRefused(k)).every((k) => {
        const pr = parse(k).pr; return pr?.want == null ? true : Number(pr.count) >= Number(pr.want);
    }), kids.map((k) => { const pr = parse(k).pr; return `${parse(k).args.item ?? k.skill}:${pr?.count}/${pr?.want}`; }));
chk('第1层：parent 收敛 done（或 shelter 拒搭时 blocked）',
    parent?.state === JOB_STATE.DONE || (parent?.state === JOB_STATE.BLOCKED && kids.every(effDone)), { parent: parent?.state });

// 第 2 层（用 RCON 查背包真值 + 场上方块）
console.log('\n=== 第 2 层：物理证据（RCON 查 agent 背包真值）===');
const invRaw = String(await RC(`data get entity ${AGENT_NAME} Inventory`).catch(() => ''));
const hasWoodenPick = /wooden_pickaxe/.test(invRaw);
const hasStonePick = /stone_pickaxe|iron_pickaxe/.test(invRaw);
console.log('  背包片段: ' + invRaw.slice(0, 300));
chk('第2层：agent 背包真有 wooden_pickaxe', hasWoodenPick, { hasWoodenPick });
chk('第2层：agent 背包真有 stone_pickaxe（或更好）', hasStonePick, { hasStonePick });

const posStr = String(await RC(`data get entity ${AGENT_NAME} Pos`).catch(() => ''));
const pm = posStr.match(/\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
let tableFound = false;
if (pm) {
    const ax = Math.floor(Number(pm[1])), ay = Math.floor(Number(pm[2])), az = Math.floor(Number(pm[3]));
    for (let dx = -12; dx <= 12 && !tableFound; dx++) {
        for (let dy = -3; dy <= 3 && !tableFound; dy++) {
            for (let dz = -12; dz <= 12 && !tableFound; dz++) {
                const r = String(await RC(`execute if block ${ax + dx} ${ay + dy} ${az + dz} crafting_table`).catch(() => ''));
                if (/passed/i.test(r)) tableFound = true;
            }
        }
    }
}
chk('第2层：场上有 crafting_table（12 格内）', tableFound, { tableFound });

// 反向对照
console.log('\n=== 反向对照：给石镐后再发一次 → 前 4 步不该创建 ===');
{
    await RC(`give ${AGENT_NAME} stone_pickaxe 1`).catch(() => { });
    await RC(`give ${AGENT_NAME} oak_log 16`).catch(() => { });
    await sleep(1500);
    const beforeIds2 = new Set(db.prepare('SELECT id FROM jobs').all().map((r) => r.id));
    playerBot.chat('!do("first_night", "")');
    await sleep(8000);
    const fresh2 = db.prepare('SELECT * FROM jobs ORDER BY createdAt').all().filter((j) => !beforeIds2.has(j.id));
    const p2 = fresh2.find((j) => j.skill === 'first_night');
    const kids2 = p2 ? fresh2.filter((j) => j.parentId === p2.id) : [];
    const items2 = kids2.map((k) => parse(k).args.item ?? k.skill);
    console.log('  子单: ' + JSON.stringify(items2));
    chk('★ 反向对照：已有石镐 → wood/table/wooden_pickaxe/stone_pickaxe 4 步不创建',
        !items2.some((x) => ['oak_log', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe'].includes(x)), { items2 });
}

try { playerBot.quit(); } catch { }
try { agentProc.kill('SIGTERM'); } catch { }
console.log(`\n════════ t51 第一夜断言 ════════`);
console.log(`${pass}/${pass + fail} 条通过`);
await sleep(800);
process.exit(fail ? 1 : 0);
