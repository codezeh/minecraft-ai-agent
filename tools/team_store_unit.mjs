/**
 * 队伍（ADR 阶段 3 / D6 / D13）离线测试：team / team_member / team_chest。
 *
 * 锁六件事（每条都能红 —— 用例都写成"必须被拒/必须只有一个赢家"）：
 *   ① 建队：建队者是队长，三张表都落库；同存档重名 ⇒ 拒（不同存档同名 ⇒ 允许）
 *   ② 一 avatar 同时只在一个队（建队/加入两条路径都拒）
 *   ③ 加入：幂等 + 支持按 id / 队名；不存在的队 ⇒ 拒
 *   ④ 离队：队长走了转给最早入队者；最后一人走 ⇒ 队解散且共享仓坐标一起删
 *   ⑤ 权限：队员不能登记共享仓，非成员看不到别人的共享仓清单
 *   ⑥ **没有存档维度 ⇒ 拒**（绝不退化成"单库单世界"）
 * 另加 socket 层两条：身份只认服务端裁决（payload.avatar 被忽略）、worldIdOf 抛错时
 * 一条队伍都不许建。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, createTeam, joinTeam, leaveTeam, listTeams, listTeamChest, addTeamChest,
    teamOfAvatar, BOARD_SCHEMA_VERSION, TEAM_ROLE, TEAM_NAME_MAX,
} from '../src/agent/library/board_store.js';
import { attachBoardServer } from '../src/agent/library/board_server.js';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// 每个进程一个独立目录（同 board 其它 unit：两路并发不会互删 fixture）
const DIR = mkdtempSync(join(os.tmpdir(), 'team-store-test-'));
let seq = 0;
const freshDb = () => {
    const dir = join(DIR, `db${++seq}`);
    rmSync(dir, { recursive: true, force: true });
    return openBoard(dir).db;
};
const teamRows = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM team').get()?.n ?? 0);

// ══════════════════════════════════════════════════════════════════════════
// 1. 结构：schema 版本 + 三张表 + 两个唯一约束
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    const want = ['team', 'team_member', 'team_chest'];
    const missing = want.filter((t) => !tables.includes(t));
    const uv = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? -1);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => String(r.name));
    const needIdx = ['uq_team_member_avatar', 'idx_team_world'];
    const missIdx = needIdx.filter((i) => !idx.includes(i));
    if (!missing.length && !missIdx.length && uv === BOARD_SCHEMA_VERSION) {
        okCase('① schema 升到 v' + BOARD_SCHEMA_VERSION + '，team/team_member/team_chest 与唯一索引都在', `uv=${uv}`);
    } else {
        badCase('① 队伍表/索引/版本号不齐', { missing, missIdx, uv, want: BOARD_SCHEMA_VERSION });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 2. 建队：建队者是 leader；同存档重名拒；不同存档同名允许
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const a = createTeam(db, { worldId: 'w1', name: '矿工队', avatar: 'alpha' });
    const held = teamOfAvatar(db, 'alpha');
    const memberRows = db.prepare('SELECT avatar_id, role FROM team_member WHERE team_id = ?').all(a.team?.id ?? 'x');
    const dup = createTeam(db, { worldId: 'w1', name: '矿工队', avatar: 'beta' });
    const otherWorld = createTeam(db, { worldId: 'w2', name: '矿工队', avatar: 'beta' });
    const blank = createTeam(db, { worldId: 'w1', name: '   ', avatar: 'gamma' });
    const longName = createTeam(db, { worldId: 'w1', name: 'x'.repeat(TEAM_NAME_MAX + 1), avatar: 'gamma' });
    const ok = a.ok === true
        && a.role === TEAM_ROLE.LEADER
        && held?.team?.id === a.team.id && held.role === TEAM_ROLE.LEADER
        && memberRows.length === 1 && String(memberRows[0].role) === TEAM_ROLE.LEADER
        && dup.ok === false && dup.code === 'CLAIM_CONFLICT'
        && otherWorld.ok === true
        && blank.ok === false && blank.code === 'NO_TARGET'
        && longName.ok === false && longName.code === 'TOO_MUCH';
    if (ok) okCase('② 建队=队长入库；重名拒(CLAIM_CONFLICT)；换存档同名可建；空名/超长拒', `dup=${dup.code} 空名=${blank.code} 超长=${longName.code}`);
    else badCase('② 建队/重名/限长行为不对', { a, held, memberRows, dup, otherWorld, blank, longName });
}

// ══════════════════════════════════════════════════════════════════════════
// 3. 一 avatar 同时只在一个队（建队 + 加入两条路径都拒）
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const t1 = createTeam(db, { worldId: 'w1', name: '甲队', avatar: 'alpha' });
    const t2 = createTeam(db, { worldId: 'w1', name: '乙队', avatar: 'beta' });
    const again = createTeam(db, { worldId: 'w1', name: '丙队', avatar: 'alpha' });
    const crossJoin = joinTeam(db, { worldId: 'w1', teamId: t2.team.id, avatar: 'alpha' });
    const seats = db.prepare('SELECT COUNT(*) AS n FROM team_member WHERE avatar_id = ?').get('alpha');
    if (again.ok === false && again.code === 'OCCUPIED'
        && crossJoin.ok === false && crossJoin.code === 'OCCUPIED'
        && Number(seats.n) === 1 && t1.ok && t2.ok) {
        okCase('③ 一 avatar 只在一个队：再建队/跨队加入都 OCCUPIED，库里只有一行座位', `seats=${seats.n}`);
    } else {
        badCase('③ 唯一队伍没挡住', { again, crossJoin, seats, t1: t1.ok, t2: t2.ok });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 4. 加入：按 id / 按队名 / 幂等 / 不存在的队
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const t = createTeam(db, { worldId: 'w1', name: '甲队', avatar: 'alpha' });
    const byId = joinTeam(db, { worldId: 'w1', teamId: t.team.id, avatar: 'beta' });
    const againById = joinTeam(db, { worldId: 'w1', teamId: t.team.id, avatar: 'beta' });
    const byName = joinTeam(db, { worldId: 'w1', name: '甲队', avatar: 'gamma' });
    const ghost = joinTeam(db, { worldId: 'w1', teamId: 'no-such-team', avatar: 'delta' });
    const ghostName = joinTeam(db, { worldId: 'w1', name: '不存在队', avatar: 'delta' });
    const wrongWorld = joinTeam(db, { worldId: 'w9', teamId: t.team.id, avatar: 'delta' });
    const seats = db.prepare('SELECT avatar_id, role FROM team_member WHERE team_id = ? ORDER BY joined_at ASC, avatar_id ASC').all(t.team.id);
    const ok = byId.ok && byId.role === TEAM_ROLE.MEMBER
        && againById.ok && againById.already === true
        && byName.ok && byName.role === TEAM_ROLE.MEMBER
        && ghost.ok === false && ghost.code === 'NO_TARGET'
        && ghostName.ok === false && ghostName.code === 'NO_TARGET'
        && wrongWorld.ok === false && wrongWorld.code === 'NO_TARGET'
        && seats.length === 3;
    if (ok) okCase('④ 加入：按 id/队名都行、重复加入幂等、幽灵队/跨存档队拒', `seats=${seats.length} ghost=${ghost.code}`);
    else badCase('④ 加入行为不对', { byId, againById, byName, ghost, ghostName, wrongWorld, seats });
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 离队：队长转交；最后一人离队 ⇒ 解散且共享仓坐标一起删
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const t = createTeam(db, { worldId: 'w1', name: '甲队', avatar: 'alpha' });
    addTeamChest(db, { worldId: 'w1', avatar: 'alpha', x: 10, y: 64, z: 20 });
    joinTeam(db, { worldId: 'w1', teamId: t.team.id, avatar: 'beta' });
    const leftLeader = leaveTeam(db, { avatar: 'alpha' });
    const betaSeat = db.prepare('SELECT role FROM team_member WHERE avatar_id = ?').get('beta');
    const leftLast = leaveTeam(db, { avatar: 'beta' });
    const chestLeft = Number(db.prepare('SELECT COUNT(*) AS n FROM team_chest').get()?.n ?? -1);
    const teamsLeft = teamRows(db);
    const notInTeam = leaveTeam(db, { avatar: 'beta' });
    const ok = leftLeader.ok && leftLeader.disbanded === false && leftLeader.promoted === 'beta'
        && String(betaSeat?.role) === TEAM_ROLE.LEADER
        && leftLast.ok && leftLast.disbanded === true
        && chestLeft === 0 && teamsLeft === 0
        && notInTeam.ok === false && notInTeam.code === 'NO_TARGET';
    if (ok) okCase('⑤ 离队：队长转交最早入队者；最后一人离队解散并清共享仓；不在队里 ⇒ NO_TARGET', `promoted=${leftLeader.promoted} chestLeft=${chestLeft}`);
    else badCase('⑤ 离队行为不对', { leftLeader, betaSeat, leftLast, chestLeft, teamsLeft, notInTeam });
}

// ══════════════════════════════════════════════════════════════════════════
// 6. 权限：只有队长能登记；非成员看不到别人的共享仓；坐标必须整数
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const t = createTeam(db, { worldId: 'w1', name: '甲队', avatar: 'alpha' });
    joinTeam(db, { worldId: 'w1', teamId: t.team.id, avatar: 'beta' });
    const byMember = addTeamChest(db, { worldId: 'w1', avatar: 'beta', x: 1, y: 64, z: 1 });
    const byLeader = addTeamChest(db, { worldId: 'w1', avatar: 'alpha', x: 1, y: 64, z: 1 });
    const dup = addTeamChest(db, { worldId: 'w1', avatar: 'alpha', x: 1, y: 64, z: 1 });
    const float = addTeamChest(db, { worldId: 'w1', avatar: 'alpha', x: 1.5, y: 64, z: 1 });
    const nan = addTeamChest(db, { worldId: 'w1', avatar: 'alpha', x: 'a', y: 64, z: 1 });
    const outsiderList = listTeamChest(db, { worldId: 'w1', teamId: t.team.id, avatar: 'gamma' });
    const ownList = listTeamChest(db, { worldId: 'w1', avatar: 'beta' });
    const noTeamList = listTeamChest(db, { worldId: 'w1', avatar: 'gamma' });
    const ok = byMember.ok === false && byMember.code === 'NO_PERMISSION'
        && byLeader.ok === true
        && dup.ok === false && dup.code === 'OCCUPIED'
        && float.ok === false && float.code === 'NO_TARGET'
        && nan.ok === false && nan.code === 'NO_TARGET'
        && outsiderList.ok === false && outsiderList.code === 'NO_PERMISSION'
        && ownList.ok === true && ownList.chests.length === 1
        && noTeamList.ok === false && noTeamList.code === 'NO_PERMISSION';
    if (ok) okCase('⑥ 权限：队员登记被拒、非成员看别人队被拒、坐标非整数被拒、重复坐标被拒', `member=${byMember.code} outsider=${outsiderList.code}`);
    else badCase('⑥ 权限/坐标校验不对', { byMember, byLeader, dup, float, nan, outsiderList, ownList, noTeamList });
}

// ══════════════════════════════════════════════════════════════════════════
// 7. 没有存档维度 ⇒ 全部拒（绝不退化成"单库单世界"）
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const results = {
        create: createTeam(db, { worldId: '  ', name: '甲队', avatar: 'alpha' }),
        join: joinTeam(db, { worldId: '', teamId: 'whatever', avatar: 'alpha' }),
        list: listTeams(db, { worldId: '' }),
        chestAdd: addTeamChest(db, { worldId: '', avatar: 'alpha', x: 0, y: 64, z: 0 }),
        chestList: listTeamChest(db, { worldId: '', avatar: 'alpha' }),
    };
    const notRejected = Object.entries(results).filter(([, r]) => r.ok !== false || r.code !== 'NO_BOARD').map(([k]) => k);
    const rows = teamRows(db);
    if (!notRejected.length && rows === 0) {
        okCase('⑦ world_id 为空 ⇒ 五个入口一律 NO_BOARD，且一行队伍都没建（不退化）', 'NO_BOARD×5');
    } else {
        badCase('⑦ 没存档维度时退化/写库了', { notRejected, rows, results });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 8. socket 层：身份只认服务端裁决（payload.avatar 被忽略）
// ══════════════════════════════════════════════════════════════════════════
function makePair(serverData, worldIdOf) {
    const handlers = new Map();
    const serverSocket = {
        on(event, fn) { handlers.set(event, fn); },
        data: { ...serverData },
    };
    const clientSocket = {
        on() { /* 忽略广播 */ },
        emit(event, payload, ack) {
            const h = handlers.get(event);
            if (!h) { ack?.({ ok: false, reason: `no handler for ${event}` }); return; }
            h(payload, ack);
        },
    };
    const io = { on(event, fn) { if (event === 'connection') fn(serverSocket); }, emit() { /* 广播不关心 */ } };
    return { io, clientSocket, serverSocket };
}

const call = (clientSocket, event, payload) => new Promise((resolve) => {
    let done = false;
    clientSocket.emit(event, payload, (a) => { if (done) return; done = true; resolve(a); });
    setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: 'timeout' }); } }, 1000);
});

{
    const db = freshDb();
    const { io, clientSocket } = makePair({ role: 'agent', agentName: 'alpha' }, () => 'w1');
    const server = attachBoardServer({ io, db, worldIdOf: () => 'w1' });
    try {
        const hello = await call(clientSocket, 'board:hello', { bot: 'alpha', skills: [] });
        // ★ 关键：payload 里自称 beta，服务端必须按 stamp（alpha）落库
        const created = await call(clientSocket, 'team:create', { name: '甲队', avatar: 'beta', bot: 'alpha' });
        const holder = teamOfAvatar(db, 'alpha');
        const hijack = teamOfAvatar(db, 'beta');
        const ok = hello.ok === true && created.ok === true
            && holder?.team?.id === created.team?.id && hijack === null;
        if (ok) okCase('⑧ socket：队伍归服务端裁决的 alpha，payload 自称 beta 无效', `team=${created.team?.id}`);
        else badCase('⑧ 客户端自称身份被采信了', { hello, created, holder, hijack });
    } finally {
        server.stop();
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 9. socket 层：worldIdOf 拿不到存档 ⇒ 拒，且一行都不许写
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const { io, clientSocket } = makePair({ role: 'agent', agentName: 'alpha' }, null);
    const server = attachBoardServer({ io, db, worldIdOf: () => { throw new Error('没有 world_store'); } });
    try {
        await call(clientSocket, 'board:hello', { bot: 'alpha', skills: [] });
        const created = await call(clientSocket, 'team:create', { name: '甲队', bot: 'alpha' });
        const listed = await call(clientSocket, 'team:list', { bot: 'alpha' });
        const rows = teamRows(db);
        const ok = created.ok === false && created.code === 'NO_BOARD'
            && listed.ok === false && listed.code === 'NO_BOARD'
            && rows === 0;
        if (ok) okCase('⑨ socket：解析不出存档 ⇒ team:create / team:list 都 NO_BOARD，库零行（明确失败）', `rows=${rows}`);
        else badCase('⑨ 拿不到存档维度时没有明确失败', { created, listed, rows });
    } finally {
        server.stop();
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 10. socket 层：未握手的 agent 连接 ⇒ NO_PERMISSION（不能借面板默认值蒙过去）
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const { io, clientSocket } = makePair({ role: 'agent' }, null);
    const server = attachBoardServer({ io, db, worldIdOf: () => 'w1' });
    try {
        const created = await call(clientSocket, 'team:create', { name: '甲队', bot: 'alpha' });
        const rows = teamRows(db);
        if (created.ok === false && created.code === 'NO_PERMISSION' && rows === 0) {
            okCase('⑩ socket：agent 连接没握手就想建队 ⇒ NO_PERMISSION，库零行', `code=${created.code}`);
        } else {
            badCase('⑩ 未握手连接被放行了', { created, rows });
        }
    } finally {
        server.stop();
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 11. ★ 真接线（不注入 worldIdOf）：库在 `_worlds/<id>/_board/` ⇒ 用 world_store 反解
//     库在旧位置 `_board/` ⇒ 必须 NO_BOARD（旧位置没有存档维度，拒绝而不是退化）
// ══════════════════════════════════════════════════════════════════════════
{
    const mkBoardAt = (rel) => {
        const dir = join(DIR, rel);
        rmSync(dir, { recursive: true, force: true });
        return openBoard(dir);
    };

    // ① 按存档的位置
    const worldBoard = mkBoardAt(join('_worlds', 'w_demo', '_board'));
    {
        const { io, clientSocket } = makePair({ role: 'agent', agentName: 'alpha' }, null);
        const server = attachBoardServer({ io, db: worldBoard.db });
        try {
            await call(clientSocket, 'board:hello', { bot: 'alpha', skills: [] });
            const created = await call(clientSocket, 'team:create', { name: '甲队', bot: 'alpha' });
            const listed = await call(clientSocket, 'team:list', { bot: 'alpha' });
            const rows = worldBoard.db.prepare('SELECT world_id FROM team').all();
            const ok = created.ok === true && created.worldId === 'w_demo'
                && listed.ok === true && listed.teams.length === 1
                && rows.length === 1 && String(rows[0].world_id) === 'w_demo';
            if (ok) okCase('⑪ 真接线：库在 _worlds/w_demo/_board/ ⇒ world_id 由 world_store 反解，队伍落在 w_demo', `world=${created.worldId}`);
            else badCase('⑪ 真接线（按存档的库）没跑通', { created, listed, rows });
        } finally { server.stop(); }
    }

    // ② 旧位置（bots/_board）：没有存档维度 ⇒ 明确拒
    const legacyBoard = mkBoardAt(join('_board'));
    {
        const { io, clientSocket } = makePair({ role: 'agent', agentName: 'beta' }, null);
        const server = attachBoardServer({ io, db: legacyBoard.db });
        try {
            await call(clientSocket, 'board:hello', { bot: 'beta', skills: [] });
            const created = await call(clientSocket, 'team:create', { name: '乙队', bot: 'beta' });
            const rows = teamRows(legacyBoard.db);
            if (created.ok === false && created.code === 'NO_BOARD' && rows === 0) {
                okCase('⑫ 真接线：旧位置 bots/_board 的库 ⇒ NO_BOARD（旧位置没有存档维度，拒绝而不是退化）', `code=${created.code}`);
            } else {
                badCase('⑫ 旧位置的库被当成有存档维度了', { created, rows });
            }
        } finally { server.stop(); }
    }
}

// ── 收尾 ────────────────────────────────────────────────────────────────
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 临时目录删不掉也不影响结论 */ }
console.log(`\n${pass} pass / ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
