/**
 * 任务板三条命令的离线测试（M8 B1，08 §5 + 用户决策①）。
 *
 * 锁四件事：
 *   · 权限：`!addJob` = owner（**只给主人**）；`!jobs` / `!cancelJob` = trusted
 *   · 参数错 → 返回**人话且不带 code**（沿用 !do：带 code 模型会当成失败去重试）
 *   · 没有板时三条命令都**好好说话**，不抛、不报错码（降级路径）
 *   · `!addJob` 用的是和 `!do` **同一个**参数解析器（两个入口规则必须一致）
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { commandLevel } from '../src/agent/permissions.js';
// ★ 必须经 index.js 拿命令，不要直接 import actions.js：
//   actions.js 与本文件存在**既有的**循环引用（baseline 上直接 import 也会
//   "Cannot access 'actionsList' before initialization"），走 index.js（app 的正式入口）才安全。
import { getCommand } from '../src/agent/commands/index.js';
import { getSkill, parseSkillArgs } from '../src/agent/library/composite_registry.js';
import { makeNullBoard, BoardClient } from '../src/agent/library/board_client.js';
import { openBoard, listJobs } from '../src/agent/library/board_store.js';
import { attachBoardServer } from '../src/agent/library/board_server.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const cmd = (name) => getCommand(name);

/** 造一个 agent（board 由参数决定）。 */
const mkAgent = (board) => ({
    board, name: 'alpha', last_sender: 'Zeh',
    actions: { currentJobId: null }, history: null,
});

// ── 1. 三条命令都已注册 ────────────────────────────────────────────
{
    const missing = ['!addJob', '!jobs', '!cancelJob'].filter((n) => !cmd(n));
    if (missing.length === 0) okCase('三条命令都已注册到 actionsList', '!addJob/!jobs/!cancelJob');
    else badCase('命令未注册', missing);
}

// ── 2. 权限：!addJob=owner，!jobs/!cancelJob=trusted（用户决策①）─────
{
    const levels = {
        '!addJob': commandLevel('!addJob'),
        '!jobs': commandLevel('!jobs'),
        '!cancelJob': commandLevel('!cancelJob'),
    };
    const good = levels['!addJob'] === 'owner'
        && levels['!jobs'] === 'trusted'
        && levels['!cancelJob'] === 'trusted';
    if (good) okCase('权限正确：!addJob=owner，!jobs/!cancelJob=trusted', JSON.stringify(levels));
    else badCase('权限不对', levels);
}

// ── 3. 没有板时 !addJob 好好说话（不抛、不带 code）─────────────────
{
    const out = await cmd('!addJob').perform(mkAgent(null), 'collect', 'block=oak_log count=4');
    const good = typeof out === 'string' && /没连上/.test(out) && !/INTERNAL|NO_TARGET|TIMEOUT/.test(out);
    if (good) okCase('无板：!addJob 说人话（提示可用 !do 兜底）', out.slice(0, 46));
    else badCase('无板 !addJob', out);
}

// ── 4. 没有板时 !jobs / !cancelJob 也好好说话 ─────────────────────
{
    const a = await cmd('!jobs').perform(mkAgent(null));
    const b = await cmd('!cancelJob').perform(mkAgent(null), 'j_1');
    const good = typeof a === 'string' && /没连上/.test(a) && typeof b === 'string' && /没连上/.test(b);
    if (good) okCase('无板：!jobs / !cancelJob 说人话', 'ok');
    else badCase('无板 jobs/cancelJob', { a, b });
}

// ── 5. 技能名不存在 → 拒绝且不带 code ─────────────────────────────
{
    const board = makeNullBoard();     // 有对象即可（会在技能校验后被拦）
    const out = await cmd('!addJob').perform(mkAgent(board), 'no_such_skill_xyz', '');
    const good = typeof out === 'string' && /没有叫/.test(out) && /listSkills/.test(out)
        && !/INTERNAL|NO_TARGET/.test(out);
    if (good) okCase('!addJob：技能不存在 → 人话 + 指向 !listSkills（无 code）', out.slice(0, 50));
    else badCase('!addJob 技能不存在', out);
}

// ── 6. ★ 参数不合格 → 报"哪一项不对"且**不带 code**（沿用 !do）──────
{
    // 用真板连上，确保能走到参数校验之后（这里用假 board 也行，重点在返回文本）
    const fakeBoard = { add: async () => ({ ok: true, data: { id: 'j_x' } }) };
    // collect 的 manifest 要求 block?/count?；给个非法 count
    const out = await cmd('!addJob').perform(mkAgent(fakeBoard), 'collect', 'count=999');
    const hasNoCode = typeof out === 'string' && !/\b(INTERNAL|NO_TARGET|TIMEOUT|NO_ITEM)\b/.test(out);
    const explains = typeof out === 'string' && /没执行/.test(out);
    if (explains && hasNoCode) okCase('★ !addJob：args 不合格 → 报哪一项不对且无 code', out.slice(0, 60));
    else badCase('!addJob args 校验', out);
}

// ── 7. !addJob 用的是和 !do 同一个解析器（规则一致）────────────────
{
    const entry = getSkill('collect');
    const viaParser = parseSkillArgs(entry.manifest, 'count=999');
    const fakeBoard = { add: async () => ({ ok: true, data: { id: 'j_x' } }) };
    const out = await cmd('!addJob').perform(mkAgent(fakeBoard), 'collect', 'count=999');
    // 两边必须都判不合格；错误措辞应当一致（同一函数产出）
    const good = viaParser.ok === false && out.includes(viaParser.error);
    if (good) okCase('★ !addJob 与 !do 共用 parseSkillArgs（规则一致）', `error="${viaParser.error.slice(0, 30)}"`);
    else badCase('解析器不一致', { viaParser, out });
}

// ── 8. 全链路：!addJob 真的入库，!jobs 能列出来 ────────────────────
{
    const dir = join('tmp', 'board-cmd-test', 'chain');
    rmSync(join('tmp', 'board-cmd-test'), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const { db } = openBoard(dir);

    // 假 socket 对，把 server 挂上，client 走真事件链
    const handlers = new Map();
    const serverSocket = { on: (e, fn) => handlers.set(e, fn) };
    const clientSocket = {
        on() { },
        emit(e, payload, ack) {
            const h = handlers.get(e);
            if (!h) return ack?.({ ok: false, reason: `no handler ${e}` });
            h(payload, ack);
        },
    };
    const io = { on: (e, fn) => { if (e === 'connection') fn(serverSocket); }, emit() { } };
    attachBoardServer({ io, db, registry: new Map([['collect', {}]]), validateArgs: (s, a) => ({ ok: true, args: a ?? {} }) });

    const board = new BoardClient({ socket: clientSocket, name: 'alpha', skills: ['collect'], timeoutMs: 500 });
    await board.hello();

    const addOut = await cmd('!addJob').perform(mkAgent(board), 'collect', 'block=oak_log count=4');
    const jobsOut = await cmd('!jobs').perform(mkAgent(board));
    const inDb = listJobs(db, {}).length;

    const good = /已下单项/.test(addOut) && inDb === 1 && /!jobs（1 张）/.test(jobsOut) && /collect/.test(jobsOut);
    if (good) okCase('全链路：!addJob 入库 → !jobs 列出', addOut.slice(0, 40));
    else badCase('全链路 addJob/jobs', { addOut, jobsOut, inDb });
}

// ── 9. !cancelJob 真的把单取消掉 ──────────────────────────────────
{
    const dir = join('tmp', 'board-cmd-test', 'cancel');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const { db } = openBoard(dir);
    const handlers = new Map();
    const serverSocket = { on: (e, fn) => handlers.set(e, fn) };
    const clientSocket = { on() { }, emit(e, p, ack) { const h = handlers.get(e); if (!h) return ack?.({ ok: false }); h(p, ack); } };
    const io = { on: (e, fn) => { if (e === 'connection') fn(serverSocket); }, emit() { } };
    attachBoardServer({ io, db, registry: new Map([['collect', {}]]), validateArgs: (s, a) => ({ ok: true, args: a ?? {} }) });

    const board = new BoardClient({ socket: clientSocket, name: 'alpha', skills: ['collect'], timeoutMs: 500 });
    await board.hello();
    // collect 的 manifest 要求 block（必填），只给 count 会被正确拒绝
    const addOut = await cmd('!addJob').perform(mkAgent(board), 'collect', 'block=oak_log count=2');
    const idMatch = /已下单项 (\S+)：/.exec(addOut);
    const id = idMatch?.[1];

    const cancelOut = await cmd('!cancelJob').perform(mkAgent(board), id);
    await board.refresh({});
    const job = board.get(id);
    const good = cancelOut.includes('已取消') && job?.state === 'cancelled';
    if (good) okCase('!cancelJob 真的取消（库里 state=cancelled）', `${id} → ${job?.state}`);
    else badCase('!cancelJob', { cancelOut, state: job?.state });
}

// ── 10. !cancelJob 对不存在的 id 好好说话 ─────────────────────────
{
    const fakeBoard = { get: () => null, setState: async () => ({ ok: true }) };
    const out = await cmd('!cancelJob').perform(mkAgent(fakeBoard), 'j_nope');
    const good = typeof out === 'string' && /没有叫/.test(out) && /!jobs/.test(out);
    if (good) okCase('!cancelJob：id 不存在 → 指向 !jobs（不硬报错）', out.slice(0, 50));
    else badCase('!cancelJob 不存在 id', out);
}

// ── 11. !jobs 空板说人话 ──────────────────────────────────────────
{
    const board = new BoardClient({ socket: null, name: 'alpha' });
    const out = await cmd('!jobs').perform(mkAgent(board));
    const good = typeof out === 'string' && /没有任务单/.test(out) && /!addJob/.test(out);
    if (good) okCase('!jobs：没有单时说人话并提示 !addJob', out.slice(0, 44));
    else badCase('!jobs 空板', out);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
