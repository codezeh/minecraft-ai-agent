/**
 * BOARD-002（2026-11-06 深度检查，P2）—— 背包物品没有随领单请求上报，物品资格任务无法领取。
 *
 * 缺陷原貌（报告 01-完整检查报告.md "### BOARD-002"）：
 *   `board_client.claim()` 只发 `{ bot }`；`board_server` 的 `board:claim` 里
 *   `items: payload.items ?? []` → `board_store.meetsRequires()` 面对
 *   `requires.items = ['stone_pickaxe']` 的单**先按空背包拒绝** ⇒ 这张单永远领不出来。
 *   而调度器 `_claimNext()` 里那次"真实背包复核"发生在**领到之后**，根本没机会执行。
 *   报告实测：client 发 `{bot:'worker'}` 拿到 null；同一个库直接传
 *   `items:['stone_pickaxe']` 就能领到同一张单。
 *
 * 修复后应成立的判据（报告"回归验收"原文 + 任务书第 7 条）：
 *   ① 有/无所需物品两种情形分别可领/不可领（并断言**实际传输载荷**里有 items）；
 *   ② 只上报**最小必要字段**：物品名数组，去重、限长，不把整个背包塞进请求；
 *   ③ 调度器**现读一次真实库存**并随 claim 提交（读一次，不是每张单读一次）；
 *   ④ 库存中途变化 → 开工前复核照样把单退回 ready（不让它带着不满足的单跑）。
 *
 * 全部离线：假 socket 对（client.emit → server handler → ack 回 client）+ 临时目录里的
 * 真 sqlite 文件；不连 socket.io、不连服务器、不起子进程。
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, addJob, getJob, JOB_STATE,
} from '../src/agent/library/board_store.js';
import { attachBoardServer } from '../src/agent/library/board_server.js';
import { BoardClient } from '../src/agent/library/board_client.js';
import { BoardScheduler } from '../src/agent/library/board_scheduler.js';
import { normalizeReportedItems, MAX_REPORTED_ITEMS } from '../src/agent/library/board_claims.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const DIR = mkdtempSync(join(os.tmpdir(), 'board002-'));
let dbSeq = 0;
const freshDb = () => openBoard(join(DIR, `db${++dbSeq}`)).db;

const T0 = 1_700_000_000_000;

/**
 * 假 socket 对（与 board_iface_unit 同款）：client.emit → 服务端 handler → ack 回 client。
 * `sent` 记录 client 真正发出去的 payload —— 报告要求"断言实际传输载荷"。
 */
function makeFakePair() {
    const handlers = new Map();
    const sent = [];
    const serverSocket = { on(event, fn) { handlers.set(event, fn); } };
    const clientSocket = {
        sent,
        on() { /* client 侧的 board:changed 监听忽略 */ },
        emit(event, payload, ack) {
            sent.push({ event, payload });
            const h = handlers.get(event);
            if (!h) { ack?.({ ok: false, reason: `no handler for ${event}` }); return; }
            h(payload, ack);
        },
    };
    const io = {
        on(event, fn) { if (event === 'connection') fn(serverSocket); },
        emit() { /* board:changed 广播，测试不关心 */ },
    };
    return { io, clientSocket, sent };
}

const server = (db, pair) => attachBoardServer({
    io: pair.io, db, registry: null, validateArgs: null, now: () => T0,
});

// ── ① 协议层：没有 items → 物品资格单领不到；带上物品 → 能领到 ────────────
{
    const db = freshDb();
    const pair = makeFakePair();
    const srv = server(db, pair);
    const needTool = addJob(db, {
        skill: 'mine', title: '需要石镐', priority: 5, requires: { items: ['stone_pickaxe'] },
    }, { now: T0 });

    const c = new BoardClient({ socket: pair.clientSocket, name: 'worker' });
    const blind = await c.claim();                      // 老形状：只发 bot（= 缺陷原貌）
    check('① 不带背包上报时，物品资格单领不到（缺陷原貌，修复前恒为此形态）',
        blind.ok === true && !blind.data?.job, `job=${blind.data?.job?.id ?? 'null'}`);
    check('① 这一轮没有把单白占走（仍是 ready）',
        getJob(db, needTool.id)?.state === JOB_STATE.READY, `state=${getJob(db, needTool.id)?.state}`);

    const armed = await c.claim({ items: ['stone_pickaxe'] });
    check('① 带上 items 之后同一张单就能领到（核心修复）',
        armed.ok === true && armed.data?.job?.id === needTool.id,
        `job=${armed.data?.job?.id ?? 'null'} want=${needTool.id}`);
    srv.stop();
}

// ── ② 断言**实际传输载荷**：只有物品名、去重、限长 ───────────────────────
{
    const db = freshDb();
    const pair = makeFakePair();
    const srv = server(db, pair);
    addJob(db, { skill: 'mine', title: '普通单', priority: 5 }, { now: T0 });

    const c = new BoardClient({ socket: pair.clientSocket, name: 'worker' });
    // 故意传"整个背包"（带 count/durability 的对象数组 + 重复名 + 非字符串）
    await c.claim({
        items: [
            { name: 'stone_pickaxe', count: 1, durability: 130 },
            { name: 'stone_pickaxe', count: 2 },
            'oak_log', 'oak_log', null, '', 42,
        ],
    });
    const payload = pair.sent.find((s) => s.event === 'board:claim')?.payload ?? {};
    check('② board:claim 载荷里有 items', Array.isArray(payload.items),
        `keys=${Object.keys(payload).join(',')}`);
    check('② items 只含去重后的物品名（不是整个背包对象）',
        JSON.stringify(payload.items) === JSON.stringify(['stone_pickaxe', 'oak_log']),
        `items=${JSON.stringify(payload.items)}`);
    check('② 载荷里没有 count/durability 这类多余字段',
        !JSON.stringify(payload).includes('durability') && !JSON.stringify(payload).includes('"count"'),
        `payload=${JSON.stringify(payload).slice(0, 120)}`);
    srv.stop();
}

// ── ③ 归一化函数本身：去重 / 限长 / 容错（老客户端不带这个字段也不能崩）──
{
    check('③ 非数组 → 空数组（老客户端不带 items）',
        JSON.stringify(normalizeReportedItems(undefined)) === '[]'
        && JSON.stringify(normalizeReportedItems({ a: 1 })) === '[]', '');
    check('③ 字符串数组原样保留（顺序不变）',
        JSON.stringify(normalizeReportedItems(['a', 'b'])) === JSON.stringify(['a', 'b']), '');
    check('③ 对象数组取 name、去重',
        JSON.stringify(normalizeReportedItems([{ name: 'a' }, { name: 'a' }, { name: 'b' }]))
        === JSON.stringify(['a', 'b']), '');
    const many = Array.from({ length: MAX_REPORTED_ITEMS + 50 }, (_, i) => `item_${i}`);
    const capped = normalizeReportedItems(many);
    check(`③ 大背包限长到 ${MAX_REPORTED_ITEMS}（不整包上传）`,
        capped.length === MAX_REPORTED_ITEMS, `len=${capped.length}`);
}

// ── ④ 调度器：现读一次真实库存并随 claim 提交 ────────────────────────────
{
    const jobNeedTool = {
        id: 'J-NEED-TOOL', skill: 'mine', priority: 5, state: JOB_STATE.READY,
        requires: { items: ['stone_pickaxe'] }, args: {}, checkpoint: {},
    };
    const calls = { claim: [], setState: [], inventoryReads: 0 };
    const fakeBoard = {
        claim: async (who) => { calls.claim.push(who); return { ok: true, data: { job: { ...jobNeedTool } } }; },
        setState: async (id, state, reason) => { calls.setState.push({ id, state, reason }); return { ok: true }; },
        list: () => [],
        get: () => null,
    };
    const agent = {
        name: 'worker',
        roles: [],
        bot: {
            inventory: {
                items: () => {
                    calls.inventoryReads++;
                    return [{ name: 'stone_pickaxe', count: 1 }, { name: 'oak_log', count: 4 }];
                },
            },
        },
    };
    const sched = new BoardScheduler({ agent, board: fakeBoard, now: () => T0, onEvent: () => { } });
    const claimed = await sched._claimNext();

    check('④ 调度器把真实库存随 claim 一起提交',
        Array.isArray(calls.claim[0]?.items) && calls.claim[0].items.includes('stone_pickaxe'),
        `claimArg=${JSON.stringify(calls.claim[0] ?? null)}`);
    check('④ 库存读取次数有界（claim 一次 + 开工前复核一次，不随单数增长）',
        calls.inventoryReads >= 1 && calls.inventoryReads <= 2, `reads=${calls.inventoryReads}`);
    check('④ 资格满足 → 领到单', claimed?.id === 'J-NEED-TOOL', `claimed=${claimed?.id ?? 'null'}`);
}

// ── ⑤ 库存中途变化：开工前复核把单退回 ready（不让它带着不满足的单跑）─────
{
    const jobNeedTool = {
        id: 'J-NEED-TOOL-2', skill: 'mine', priority: 5, state: JOB_STATE.READY,
        requires: { items: ['diamond_pickaxe'] }, args: {}, checkpoint: {},
    };
    const calls = { claim: [], setState: [] };
    const fakeBoard = {
        // 服务端按"上报时"的库存放行了，但本地此刻已经没那把镐了
        claim: async (who) => { calls.claim.push(who); return { ok: true, data: { job: { ...jobNeedTool } } }; },
        setState: async (id, state, reason) => { calls.setState.push({ id, state, reason }); return { ok: true }; },
        list: () => [],
        get: () => null,
    };
    const agent = {
        name: 'worker',
        roles: [],
        bot: { inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] } },
    };
    const events = [];
    const sched = new BoardScheduler({ agent, board: fakeBoard, now: () => T0, onEvent: (e) => events.push(e) });
    const claimed = await sched._claimNext();

    check('⑤ 库存不满足时调度器不接单（返回 null）', claimed === null, `claimed=${claimed?.id ?? 'null'}`);
    check('⑤ 单被退回 ready（不占着租约）',
        calls.setState.some((c) => c.id === 'J-NEED-TOOL-2' && c.state === JOB_STATE.READY
            && c.reason === 'requires-unmet'),
        JSON.stringify(calls.setState));
    check('⑤ 留了 job-skipped-requires 事件（可诊断，不是静默）',
        events.some((e) => e.type === 'job-skipped-requires'), JSON.stringify(events.map((e) => e.type)));
}

// ── ⑥ 多机器人能力差异：同一张单，有镐的能领、没镐的领不到 ───────────────
{
    const db = freshDb();
    const pair = makeFakePair();
    const srv = server(db, pair);
    const job = addJob(db, {
        skill: 'mine', title: '需要石镐（共享单）', priority: 5, assignee: null,
        requires: { items: ['stone_pickaxe'] },
    }, { now: T0 });

    const poor = new BoardClient({ socket: pair.clientSocket, name: 'poor' });
    const rich = new BoardClient({ socket: pair.clientSocket, name: 'rich' });
    const r1 = await poor.claim({ items: ['oak_log'] });
    const r2 = await rich.claim({ items: ['stone_pickaxe', 'oak_log'] });
    check('⑥ 没工具的那只领不到、有工具的那只领到（能力差异生效）',
        !r1.data?.job && r2.data?.job?.id === job.id,
        `poor=${r1.data?.job?.id ?? 'null'} rich=${r2.data?.job?.id ?? 'null'}`);
    srv.stop();
}

console.log(`\n${fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `HAS FAILURES: ${fail} failed, ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
