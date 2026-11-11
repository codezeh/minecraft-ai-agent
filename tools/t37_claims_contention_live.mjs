/**
 * t37 第②项：三种预约 key（container / station / entity）的多 bot 真机争用。
 *
 * 判据（captain 批准，每条四/五个都要满足，缺一不算过）：
 *   1. 正向：A 预约 → ok:true，且**查库** claims 有 1 行（key 完全相等 / owner=A / until 在未来）
 *   2. 冲突：B 抢同一 key → ok:false 且 code==='CLAIM_CONFLICT'，conflicts 里点名该 key
 *   3. 查库证明 B 没落行：该 key 仍只有 1 行且 owner 是 A
 *   4. ★ 反向对照：B 换一个**不同坐标**的同类 key → 必须 ok:true（防止"永远返回冲突"也能过）
 *   5. ★ entity 泄漏（captain 补）：kill 那只怪 → 等 TTL → 断言 claims 行被清理
 *
 * 做法：1 个真 mineflayer bot（只为拿**真实体 id** + 造箱子/熔炉），2 个 BoardClient 连真 board server。
 *       claims 一律**直连 sqlite 查库**，不看接口返回。
 *
 * 用法：node t37_claims_contention_live.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rcon } from './rcon.mjs';
import { openBoard, listClaims, reserve, release, CLAIM_TTL_MS } from '../src/agent/library/board_store.js';
import { boardDirOf } from '../src/agent/library/bot_paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = join(__dirname, 't37_claims_contention_live.mjs');
const MS_PORT = 18093;
const MC_PORT = 25566;
const RC = (c) => rcon(c, { port: 25576 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// 场地：离 bench 的 10000,6000 很远
const BX = 6200, BY = -60, BZ = 8800;

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

// ── 主流程 ────────────────────────────────────────────────────────
    const results = [];
    const push = (n, pass, d) => {
        results.push({ n, pass, d });
        // d 可能是对象；直接插值会打 [object Object]，把真实原因（ok/code/conflicts）盖掉
        const shown = typeof d === 'string' ? d : JSON.stringify(d);
        log(`${pass ? 'PASS' : 'FAIL'} ${n} —— ${shown}`);
    };

    // 1) 起 mindserver（**父进程内**启动，与 board_b4_live 同法）
    log('启动 mindserver…');
    const { createMindServer } = await import('../src/mindcraft/mindserver.js');
    createMindServer(false, MS_PORT);
    await sleep(5000);

    // 2) 造场地 + 真实体
    await RC(`forceload add ${BX - 16} ${BZ - 16} ${BX + 16} ${BZ + 16}`);
    await sleep(500);
    await RC(`fill ${BX - 6} ${BY - 1} ${BZ - 6} ${BX + 6} ${BY - 1} ${BZ + 6} stone`);
    await RC(`fill ${BX - 6} ${BY} ${BZ - 6} ${BX + 6} ${BY + 3} ${BZ + 6} air`);
    const CHEST = { x: BX, y: BY, z: BZ };
    const FURN = { x: BX + 2, y: BY, z: BZ };
    await RC(`setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} chest`);
    await RC(`setblock ${FURN.x} ${FURN.y} ${FURN.z} furnace`);
    await RC(`summon zombie ${BX + 4} ${BY} ${BZ + 0.5}`);
    await sleep(1200);

    // 真实体 id：用**真 mineflayer bot** 读（这才是 agent 实际会用的来源；
    // RCON `data get entity` 的输出会被截断，拿不到 UUID）
    let entityId = null;
    let probeBot = null;
    try {
        const mineflayer = (await import('mineflayer')).default;
        const pf = (await import('mineflayer-pathfinder')).default;
        const { installPositionGuard } = await import('../src/sim/position_guard.js');
        probeBot = mineflayer.createBot({ host: '127.0.0.1', port: MC_PORT, username: 't37ent' + (Date.now() % 10000), auth: 'offline', version: '1.21.8' });
        probeBot.loadPlugin(pf.pathfinder);
        installPositionGuard(probeBot);
        probeBot.on('error', () => { });
        await new Promise((res) => { const t = setTimeout(res, 25000); probeBot.once('spawn', () => { clearTimeout(t); res(); }); });
        await RC(`tp ${probeBot.username} ${BX + 3} ${BY} ${BZ}`).catch(() => { });
        await sleep(2500);
        // bot 落地后**重新**summon 到它眼前（先前那只可能已 despawn / 区块未加载）
        await RC(`kill @e[type=zombie]`).catch(() => { });
        await sleep(400);
        await RC(`summon zombie ${BX + 4.5} ${BY} ${BZ + 0.5}`).catch(() => { });
        // 轮询等它进视野（最多 12 秒）
        let z = null;
        for (let i = 0; i < 12; i++) {
            await sleep(1000);
            z = Object.values(probeBot.entities || {}).find((e) => e?.name === 'zombie');
            if (z) break;
        }
        if (z) entityId = String(z.uuid ?? z.id ?? '');
        log(`真实体: name=${z?.name} uuid=${z?.uuid} id=${z?.id} → key 用 ${entityId || '（空）'}`);
    } catch (e) {
        log('  bot 侧读实体失败: ' + String(e?.message ?? e).slice(0, 100));
    }

    // 3) 两个 BoardClient（真 socket 连真 server）
    // ★ t23（2026-11-08）：**必须带握手 token**。① 身份门（auth_gate 的 io.use）之后，
    //   裸 `io(url,{transports})` 一律被拒（AUTH_REQUIRED），于是下面 12 条断言全红、
    //   而脚本仍可能 exit 0 —— 这就是"看起来跑了、其实没跑"。
    //   取 token 走仓库统一的 tools/lib/ms_token.mjs（env → .mindserver-token），不另写一套。
    const { io } = await import('socket.io-client');
    const { BoardClient } = await import('../src/agent/library/board_client.js');
    const { connectMindserver, awaitConnect } = await import('./lib/ms_token.mjs');
    // ★ 真机验收发现：t37 在**父进程内** createMindServer，而它会把自己的 env 换成
    //   "无 agentName 的 agent 凭据"（mindserver.js 里 agentToken 那段）。于是这里用
    //   ms_token 的 env 优先拿到 agent 角色，又没 login-agent ⇒ board:hello 要 agentName 戳
    //   ⇒ 12 条争用断言全 NO_PERMISSION。
    //   正确做法：本脚本是**面板级**驱动（它本来就直接查库、造场景），显式用面板凭据连。
    const { getHandshakeToken } = await import('../src/mindcraft/mindserver.js');
    const panelToken = getHandshakeToken();
    const mk = (name) => {
        const sock = connectMindserver(io, MS_PORT, { auth: (cb) => cb({ token: panelToken }) });
        return { sock, client: new BoardClient({ name, skills: ['mine'], socket: sock }) };
    };
    const { sock: sockA, client: A } = mk('claimA');
    const { sock: sockB, client: B } = mk('claimB');
    // 连不上就**明确失败**：否则 12 条断言全红、脚本还可能 exit 0
    if (!await awaitConnect(sockA, { label: 't37-claims/A' })) process.exit(1);
    if (!await awaitConnect(sockB, { label: 't37-claims/B' })) process.exit(1);
    for (const c of [A, B]) { try { await c.hello(); } catch { } }
    await sleep(800);

    const db = openBoard(boardDirOf(), { readOnly: true }).db;

    // 直连查库：某 key 的行
    const rowsOf = (key) => listClaims(db).filter((c) => c.key === key);

    // ── 单个 key 的完整四步 ──────────────────────────────────────────
    async function contest(label, key, altKey) {
        log(`\n=== ${label}：${key} ===`);
        // 1) A 预约
        const r1 = await A.reserve(`jobA-${label}`, [key]);
        const rows1 = rowsOf(key);
        push(`${label} ①A 预约成功且查库有 1 行(owner=A, until 在未来)`,
            r1.ok === true && rows1.length === 1 && rows1[0].owner === 'claimA' && rows1[0].until > Date.now() + 5000,
            { ok: r1.ok, rows: rows1.map((r) => ({ key: r.key, owner: r.owner, until: r.until })), code: r1.code });

        // 2) B 抢同一个 → 冲突
        const r2 = await B.reserve(`jobB-${label}`, [key]);
        const conflicts = r2.data?.conflicts ?? r2.conflicts ?? [];
        push(`${label} ②B 抢同一 key → CLAIM_CONFLICT 且点名该 key`,
            r2.ok === false && r2.code === 'CLAIM_CONFLICT' && (conflicts.includes(key) || conflicts.some((c) => String(c).includes(key))),
            { ok: r2.ok, code: r2.code, conflicts });

        // 3) 查库：仍然只有 A 那一行（B 没偷偷写进去）
        const rows2 = rowsOf(key);
        push(`${label} ③B 没落行（该 key 仍 1 行且 owner=A）`,
            rows2.length === 1 && rows2[0].owner === 'claimA',
            { rows: rows2.map((r) => ({ key: r.key, owner: r.owner })) });

        // 4) ★ 反向对照：B 换不同坐标的同类 key → 必须成功
        const r4 = await B.reserve(`jobB-${label}-alt`, [altKey]);
        push(`${label} ④反向对照：B 用**不同坐标**的同类 key → 必须成功（防"恒冲突"假通过）`,
            r4.ok === true, { ok: r4.ok, code: r4.code, altKey });
        try { await B.release(`jobB-${label}-alt`, [altKey]); } catch { }
        try { await A.release(`jobA-${label}`, [key]); } catch { }
        await sleep(400);
    }

    await contest('container', `container:${CHEST.x},${CHEST.y},${CHEST.z}`, `container:${CHEST.x + 5},${CHEST.y},${CHEST.z}`);
    await contest('station', `station:furnace@${FURN.x},${FURN.y},${FURN.z}`, `station:furnace@${FURN.x + 5},${FURN.y},${FURN.z}`);
    if (entityId) {
        await contest('entity', `entity:${entityId}`, `entity:${entityId}-other`);
    } else {
        push('entity 争用', false, '拿不到真实体 id，未执行（如实标）');
    }

    // 5) ★ entity 预约泄漏：A 约住怪 → kill 怪 → 等 TTL → claims 应被清理
    if (entityId) {
        log('\n=== entity 泄漏检查（captain 补）===');
        const key = `entity:${entityId}`;
        await A.reserve('jobA-leak', [key]);
        const before = rowsOf(key);
        await RC(`kill @e[type=zombie,limit=1]`);
        log('  已 kill 僵尸，等 TTL（' + Math.round(CLAIM_TTL_MS / 1000) + 's）+ 扫描…');
        const t0 = Date.now();
        let after = before;
        while (Date.now() - t0 < CLAIM_TTL_MS + 12000) {
            await sleep(3000);
            after = rowsOf(key);
            if (after.length === 0) break;
        }
        push('⑤ entity 预约泄漏：kill 怪后 TTL 到期 claims 行被清理（不永久占用）',
            after.length === 0, { before: before.length, after: after.length });
        try { await A.release('jobA-leak', [key]); } catch { }
    }

    // 收尾
    try { probeBot?.quit?.(); } catch { }
    try { A.disconnect?.(); B.disconnect?.(); } catch { }

    const ok = results.filter((r) => r.pass).length;
    log(`\n════════ ② 争用断言 ════════`);
    log(`${ok}/${results.length} 条通过`);
    await sleep(500);
process.exit(ok === results.length ? 0 : 1);
