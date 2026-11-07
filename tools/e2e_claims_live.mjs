/**
 * E2E 场景「多 bot 抢单争用」—— 与 tools/t37_claims_contention_live.mjs **判据相同**，
 * 但握手走 token（t37 写于 ① 身份门之前，socket 不带 token，现在会被 mindserver 拒绝）。
 *
 * 为什么另起一个文件而不是改 t37：
 *   · t37 是既有工具（本轮约定：`mindcraft/tools/` 只新增、不改既有工具）；
 *   · t37 的 socket 由它自己 `io(url,{transports:['websocket']})` 建，没有 token 位；
 *   · 本文件的判据逐条对齐 t37（①预约 ②冲突 ③没落行 ④反向对照 ⑤实体预约 TTL 回收），
 *     并在每条里注明"与 t37 同判据"，便于两边对照。
 *
 * 用法：node tools/e2e_claims_live.mjs
 * 依赖：MC 测试服已在 25566 跑起来（RCON 25576，凭据走 RCON_PASSWORD/RCON_PORT 环境变量）。
 * 退出码：0 = 全部断言通过；1 = 有失败。
 */
import { rcon } from './rcon.mjs';
import { openBoard, listClaims, CLAIM_TTL_MS } from '../src/agent/library/board_store.js';

const MS_PORT = Number(process.env.E2E_MS_PORT || 18093);
const MC_PORT = Number(process.env.MC_PORT || 25566);
const RC = (c) => rcon(c, { port: Number(process.env.RCON_PORT) || 25576 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// 与 t37 相同的场地（同样的 key 形状，方便两边日志对照）
const BX = 6200, BY = -60, BZ = 8800;

const results = [];
const push = (name, pass, detail) => {
    results.push({ name, pass });
    // detail 可能是对象 —— 一定要 JSON.stringify，否则打印成 [object Object] 看不出原因
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name} —— ${d}`);
};

const { execSync } = await import('node:child_process');
try {
    const raw = execSync('git log -1 --format=%H%n%s', { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname }).trim();
    console.log('═══ 运行版本自证 ═══');
    console.log('  ' + raw.split('\n').join('\n  '));
    console.log('═══════════════════');
} catch { console.log('（取版本失败）'); }

// 1) 起 mindserver（**父进程内**，与 t37 同法），拿本次握手的 token
log('启动 mindserver…');
const mindserver = await import('../src/mindcraft/mindserver.js');
mindserver.createMindServer(false, MS_PORT);
await sleep(5000);
const token = mindserver.getHandshakeToken?.() ?? process.env.MINDSERVER_TOKEN;
if (!token) {
    console.error('拿不到握手 token —— mindserver 没起来或接口变了');
    process.exit(1);
}
log(`握手 token 已取得（长度 ${String(token).length}）`);

// 2) 造场地（forceload + 平台 + 箱子 + 熔炉 + 僵尸）
await RC(`forceload add ${BX - 16} ${BZ - 16} ${BX + 16} ${BZ + 16}`);
await sleep(500);
await RC(`fill ${BX - 6} ${BY - 1} ${BZ - 6} ${BX + 6} ${BY - 1} ${BZ + 6} stone`);
await RC(`fill ${BX - 6} ${BY} ${BZ - 6} ${BX + 6} ${BY + 3} ${BZ + 6} air`);
const CHEST = { x: BX, y: BY, z: BZ };
const FURN = { x: BX + 2, y: BY, z: BZ };
await RC(`setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} chest`);
await RC(`setblock ${FURN.x} ${FURN.y} ${FURN.z} furnace`);
await sleep(800);

// 3) 拿真实体 id（用真 mineflayer bot，和 agent 用的同一个来源）
let entityId = null;
let probeBot = null;
try {
    const mineflayer = (await import('mineflayer')).default;
    const pf = (await import('mineflayer-pathfinder')).default;
    probeBot = mineflayer.createBot({
        host: '127.0.0.1', port: MC_PORT,
        username: 'e2eclaim' + (Date.now() % 10000),
        auth: 'offline', version: '1.21.8',
    });
    probeBot.loadPlugin(pf.pathfinder);
    probeBot.on('error', () => { });
    await new Promise((res) => { const t = setTimeout(res, 30000); probeBot.once('spawn', () => { clearTimeout(t); res(); }); });
    await RC(`tp ${probeBot.username} ${BX + 3} ${BY} ${BZ}`).catch(() => { });
    await sleep(2000);
    await RC(`kill @e[type=zombie]`).catch(() => { });
    await sleep(400);
    await RC(`summon zombie ${BX + 4.5} ${BY} ${BZ + 0.5}`).catch(() => { });
    let z = null;
    for (let i = 0; i < 12; i++) {
        await sleep(1000);
        z = Object.values(probeBot.entities || {}).find((e) => e?.name === 'zombie');
        if (z) break;
    }
    if (z) entityId = String(z.uuid ?? z.id ?? '');
    log(`真实体: name=${z?.name} uuid=${z?.uuid} id=${z?.id} → key 用 ${entityId || '（空）'}`);
} catch (e) {
    log('  bot 侧读实体失败: ' + String(e?.message ?? e).slice(0, 120));
}

// 4) 两个真 socket 的 BoardClient（**带 token** —— 这是本文件与 t37 唯一的实现差异）
const { io } = await import('socket.io-client');
const { BoardClient } = await import('../src/agent/library/board_client.js');
const mk = (name) => {
    const sock = io(`http://localhost:${MS_PORT}`, { transports: ['websocket'], auth: { token } });
    return new BoardClient({ name, skills: ['mine'], socket: sock });
};
const A = mk('claimA');
const B = mk('claimB');
for (const c of [A, B]) { try { await c.hello(); } catch { } }
await sleep(800);

const db = openBoard().db;
const rowsOf = (key) => listClaims(db).filter((c) => c.key === key);

async function contest(label, key, altKey) {
    log(`\n=== ${label}：${key} ===`);
    const r1 = await A.reserve(`jobA-${label}`, [key]);
    const rows1 = rowsOf(key);
    push(`${label} ①A 预约成功且查库有 1 行(owner=A, until 在未来)`,
        r1.ok === true && rows1.length === 1 && rows1[0].owner === 'claimA' && rows1[0].until > Date.now() + 5000,
        { ok: r1.ok, code: r1.code, rows: rows1.map((r) => ({ owner: r.owner, until: r.until })) });

    const r2 = await B.reserve(`jobB-${label}`, [key]);
    const conflicts = r2.data?.conflicts ?? r2.conflicts ?? [];
    push(`${label} ②B 抢同一 key → CLAIM_CONFLICT 且点名该 key`,
        r2.ok === false && r2.code === 'CLAIM_CONFLICT' && (conflicts.includes(key) || conflicts.some((c) => String(c).includes(key))),
        { ok: r2.ok, code: r2.code, conflicts });

    const rows2 = rowsOf(key);
    push(`${label} ③B 没落行（该 key 仍 1 行且 owner=A）`,
        rows2.length === 1 && rows2[0].owner === 'claimA',
        { rows: rows2.map((r) => ({ owner: r.owner })) });

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

// 5) 实体预约泄漏：kill 怪 → 等 TTL → claims 行应被清理（与 t37 ⑤ 同判据）
if (entityId) {
    log('\n=== entity 泄漏检查 ===');
    const key = `entity:${entityId}`;
    await A.reserve('jobA-leak', [key]);
    const before = rowsOf(key);
    await RC(`kill @e[type=zombie,limit=1]`);
    log(`  已 kill 僵尸，等 TTL（${Math.round(CLAIM_TTL_MS / 1000)}s）+ 扫描…`);
    const t0 = Date.now();
    let after = before;
    while (Date.now() - t0 < CLAIM_TTL_MS + 20000) {
        await sleep(3000);
        after = rowsOf(key);
        if (after.length === 0) break;
    }
    push('⑤ entity 预约泄漏：kill 怪后 TTL 到期 claims 行被清理（不永久占用）',
        after.length === 0, { before: before.length, after: after.length });
    try { await A.release('jobA-leak', [key]); } catch { }
}

try { probeBot?.quit?.(); } catch { }
try { A.disconnect?.(); B.disconnect?.(); } catch { }

const ok = results.filter((r) => r.pass).length;
log(`\n──────── 抢单争用：${ok}/${results.length} 条通过 ────────`);
await sleep(300);
process.exit(ok === results.length && results.length > 0 ? 0 : 1);
