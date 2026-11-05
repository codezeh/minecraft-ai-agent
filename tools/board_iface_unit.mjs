/**
 * board_client / board_server 接口契约测试（M8 B1，06 §14 + 设计 §3.2/§3.3）。
 *
 * 锁两件事：
 *   ① **client 必须实现控制层已经在调的那 5 个方法**，且 `list`/`get` 是**同步**的
 *      （control.js 里 `board.list(...) ?? []`、`board.get?.(id) ?? null` 都没 await。
 *       返回 Promise 会让控制层静默走降级，而调度器走真板 → 两套行为）
 *   ② **服务端三道安全校验**：skill 必须是注册名、args 按 manifest.params、服务端再校验一遍
 *
 * 用**假 socket + 真 db**，不连 mindserver、不起网络。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { ok, isResult, CODES } from '../src/agent/library/contract.js';
import { openBoard, addJob, getJob, listJobs, JOB_STATE } from '../src/agent/library/board_store.js';
import { attachBoardServer, validateIncomingJob } from '../src/agent/library/board_server.js';
import { BoardClient, makeNullBoard, ACK_TIMEOUT_MS } from '../src/agent/library/board_client.js';

let pass = 0, fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// ★ T15（并发加固）：**每个进程一个独立目录**。
//   原来用固定的 `tmp/<name>` 且开跑第一件事就是 rmSync 掉它 ——
//   同机两路 unit_all（或两路并发跑测试）会互删对方的 fixture，
//   表现为「整跑随机变红、单跑全绿」。mkdtempSync 让两路各拿各的目录。
const DIR = mkdtempSync(join(os.tmpdir(), 'board-iface-test-'));

/**
 * 假 socket：两端用同一个对象连通（client.emit → server 的 handler → ack 回到 client）。
 * 这样能测"整条事件链"，但不起网络。
 */
function makeFakePair() {
    const handlers = new Map();      // event → handler
    const serverSocket = {
        on(event, fn) { handlers.set(event, fn); },
    };
    const clientSocket = {
        on() { /* client 侧的 board:changed 监听忽略 */ },
        emit(event, payload, ack) {
            const h = handlers.get(event);
            if (!h) { ack?.({ ok: false, reason: `no handler for ${event}` }); return; }
            h(payload, ack);
        },
    };
    // 让 attachBoardServer 能挂到这个"socket 连接"上
    const io = {
        on(event, fn) {
            if (event === 'connection') fn(serverSocket);       // 立即"连上"
        },
        emit() { /* board:changed 广播，测试不关心 */ },
    };
    return { io, clientSocket, serverSocket, handlers };
}

// ── 1. client 实现了控制层契约的 5 个方法 ──────────────────────────
{
    const c = new BoardClient({ socket: null, name: 'alpha' });
    const has = ['list', 'get', 'update', 'add', 'setAutoClaim'].filter((m) => typeof c[m] !== 'function');
    if (has.length === 0) okCase('client 实现控制层 5 个契约方法', 'list/get/update/add/setAutoClaim');
    else badCase('client 缺少契约方法', has);
}

// ── 2. ★ list / get 必须是**同步**返回（control.js 不 await）──────────
//    断言要**两条都测**（captain 2026-11-02 要求加强）：
//      a) 返回值不是 Promise、是真正的数组
//      b) **镜像为空时也返回 `[]`，不是 `undefined`**
//         —— 因为控制层写的是 `board.list?.(...) ?? []`：`?.` 只挡 undefined 方法，
//            挡不住"方法在、但返回 undefined"。返回 undefined 会让 `?? []` 生效看起来没事，
//            但 `board.list({}).find(...)`（resolveJob 就是这样）会直接 TypeError。
{
    const c = new BoardClient({ socket: null, name: 'alpha' });

    // (a) 同步 + 是数组
    const l = c.list({ states: [JOB_STATE.RUNNING] });
    const g = c.get('nope');
    const lIsPromise = l !== null && typeof l === 'object' && typeof l.then === 'function';
    const gIsPromise = g !== null && typeof g === 'object' && typeof g.then === 'function';
    const isArray = Array.isArray(l);

    // (b) 空镜像也必须是 []；get 必须是 null（不是 undefined）
    const emptyIsArray = Array.isArray(l) && l.length === 0;
    const getIsNull = g === null;

    // 控制层真实写法（resolveJob / jobsBusy 都是这么用的）：能不能直接 .find / .length
    let controlStyleWorks = true;
    try {
        const running = c.list({ states: [JOB_STATE.CLAIMED, JOB_STATE.RUNNING] });
        running.find((j) => j?.skill === 'collect');
        const n = c.list({}).length;
        if (!Number.isFinite(n)) controlStyleWorks = false;
    } catch { controlStyleWorks = false; }

    if (!lIsPromise && !gIsPromise && isArray && emptyIsArray && getIsNull && controlStyleWorks) {
        okCase('★ list/get 同步：非 Promise + 空镜像返回 []（不是 undefined）+ 控制层写法可直接用',
            `Array.isArray=${isArray} length=${l.length} get=${g === null ? 'null' : typeof g}`);
    } else {
        badCase('★ list/get 必须同步且空镜像返回 []', {
            lIsPromise, gIsPromise, isArray, emptyIsArray, getIsNull, controlStyleWorks,
        });
    }
}

// ── 2b. ★ 直接断言"返回值 !== Promise 实例"，并用真实控制层函数跑一遍 ──
//     这一条是上一条的加强版：拿 control.js 的 jobsBusy() 真的调一次，
//     证明它拿到的是数组而不是 Promise（否则 jobsBusy 会恒 false → 静默降级）。
{
    const { jobsBusy, resolveJob } = await import('../src/agent/library/control.js');
    const c = new BoardClient({ socket: null, name: 'alpha' });
    const ret = c.list({});
    const notPromise = !(ret instanceof Promise) && typeof ret?.then !== 'function';
    const agent = { board: c, actions: { currentJobId: null }, history: null };
    const busy = jobsBusy(agent);                       // 空板 → false，但不该抛
    const resolved = resolveJob({ board: c, label: 'action:collect' });   // 空板 → null，不该抛
    if (notPromise && busy === false && resolved === null) {
        okCase('★ list() 不是 Promise 实例；control.js 的 jobsBusy/resolveJob 直接可用不抛', 'ok');
    } else {
        badCase('list() 不是 Promise / control 可直接用', { notPromise, busy, resolved });
    }
}

// ── 3. update / add / setAutoClaim 即使不 await 也不抛（控制层只 try）──
{
    const c = new BoardClient({ socket: null, name: 'alpha' });
    let threw = false;
    try {
        c.update('x', { state: JOB_STATE.READY });       // 故意不 await
        c.add({ skill: 'collect', args: {} });           // 故意不 await
        c.setAutoClaim(false);                           // 故意不 await
    } catch { threw = true; }
    if (!threw) okCase('update/add/setAutoClaim 不 await 也不抛（控制层只 try）', 'ok');
    else badCase('不 await 时抛错', { threw });
}

// ── 4. 无 socket 时返回可重试的 INTERNAL（断线语义）────────────────
{
    const c = new BoardClient({ socket: null, name: 'alpha' });
    const r = await c.hello();
    if (isResult(r) && !r.ok && r.code === 'INTERNAL' && r.data?.retryable === true) {
        okCase('无 socket → INTERNAL + retryable（06 §14 断线可重试）', r.code);
    } else badCase('无 socket 的返回', r);
}

// ── 5. ack 超时 → TIMEOUT（用短超时，不 sleep 5 秒）───────────────
{
    const deadSocket = { on() { }, emit() { /* 永不回 ack */ } };
    const c = new BoardClient({ socket: deadSocket, name: 'alpha', timeoutMs: 120 });
    const t0 = Date.now();
    const r = await c.setState('j1', JOB_STATE.CANCELLED);
    const ms = Date.now() - t0;
    if (isResult(r) && !r.ok && r.code === 'TIMEOUT' && r.data?.retryable === true && ms < 1000) {
        okCase('ack 超时 → TIMEOUT（默认 5000ms，测试用短超时）', `${ms}ms (ACK_TIMEOUT_MS=${ACK_TIMEOUT_MS})`);
    } else badCase('ack 超时', { code: r.code, ms });
}

// ── 6. 全链路：hello → add → list → claim → heartbeat → finish ────
{
    const dir = join(DIR, 'chain');
    const { db } = openBoard(dir);
    const { io, clientSocket } = makeFakePair();
    const registry = new Map([['collect', { name: 'collect' }]]);
    attachBoardServer({
        io, db, registry,
        validateArgs: (skill, args) => ({ ok: true, args: args ?? {} }),
    });

    const c = new BoardClient({ socket: clientSocket, name: 'alpha', skills: ['collect'], timeoutMs: 500 });
    const hello = await c.hello();
    const add = await c.add({ title: '采木头', skill: 'collect', args: { block: 'oak_log' }, assignee: 'alpha', priority: 7 });
    await c.refresh();
    const listed = c.list({ states: [JOB_STATE.READY] });          // 同步读缓存
    const claim = await c.claim();
    const hb = await c.heartbeat(claim.data?.job?.id, { count: 3, want: 10 });
    const fin = await c.finish(claim.data?.job?.id, { ok: true, code: 'OK', progress: { count: 10, want: 10 } });

    const good = hello.ok && add.ok && listed.length === 1
        && claim.ok && claim.data?.job?.id === add.data.id
        && hb.ok && hb.data?.job?.state === JOB_STATE.RUNNING
        && fin.ok && fin.data?.next === JOB_STATE.DONE;
    if (good) {
        okCase('全链路 hello→add→list→claim→heartbeat→finish', `id=${add.data.id} → ${fin.data.next}`);
    } else {
        badCase('全链路', { hello: hello.ok, add: add.ok, listed: listed.length, claim: claim.ok, hb: hb.ok, fin: fin.data });
    }
}

// ── 6b. ★ getAsync 必须真的取到单（board:get payload 形状 bug 的回归）──
//   真机验收抓到的坑：server 端 handler 写成 `(id, cb)`（要裸 id），
//   而 client 发 `{ id }` → `String({id})` = "[object Object]" → 恒返回 null。
//   症状极隐蔽：`board.get()` 永远 null → 控制层 resolveJob 恒走降级，
//   看起来和"没有板"一模一样，但板其实是好的。
{
    const dir = join(DIR, 'getbyid');
    const { db } = openBoard(dir);
    const { io, clientSocket } = makeFakePair();
    attachBoardServer({ io, db, registry: new Map([['collect', {}]]), validateArgs: () => ({ ok: true, args: {} }) });
    const c = new BoardClient({ socket: clientSocket, name: 'alpha', skills: ['collect'], timeoutMs: 500 });
    await c.hello();
    const add = await c.add({ skill: 'collect', args: { count: 2 }, assignee: 'alpha' });

    // 直接走 getAsync（服务端往返），再走同步 get（读镜像）
    const r = await c.getAsync(add.data.id);
    const syncJob = c.get(add.data.id);
    const good = r.ok && r.data?.job?.id === add.data.id && syncJob?.id === add.data.id && syncJob?.skill === 'collect';
    if (good) {
        okCase('★ getAsync 能按 id 真的取到单（payload 形状 bug 回归）', `${add.data.id}`);
    } else {
        badCase('★ getAsync 取不到单', { rOk: r.ok, rJob: r.data?.job?.id, syncJob: syncJob?.id });
    }
}

// ── 7. 安全①：skill 不在注册表 → 服务端拒绝 ──────────────────────
{
    const { db } = openBoard(join(DIR, 'sec1'));
    const { io, clientSocket } = makeFakePair();
    attachBoardServer({ io, db, registry: new Map([['collect', {}]]), validateArgs: () => ({ ok: true, args: {} }) });
    // 注意：① 和 ①b 是**两条独立防线**，要分别测：
    //   · ①b 管"这只 bot 有没有上报过这个技能"（client 构造时传 skills）
    //   · ①  管"整个注册表里有没有这个技能"
    // 不传 skills 时 hello 上报的是空集，任何技能都会被 ①b 先拦下 —— 那测不到 ①。
    const c = new BoardClient({ socket: clientSocket, name: 'alpha', skills: ['collect'], timeoutMs: 500 });
    await c.hello();                                    // 上报 collect（合法技能）
    const r = await c.add({ skill: 'evilFunction', args: {}, assignee: 'alpha' });
    if (isResult(r) && !r.ok && /不在注册表/.test(r.message)) {
        okCase('安全①：skill 不在注册表 → 拒绝', r.message.slice(0, 50));
    } else badCase('安全① skill 校验', r);
}

// ── 8. 安全①b：skill 不在该 bot 上报的清单里 → 拒绝 ─────────────
{
    const { db } = openBoard(join(DIR, 'sec1b'));
    const { io, clientSocket } = makeFakePair();
    attachBoardServer({ io, db, registry: new Map([['collect', {}], ['build', {}]]), validateArgs: () => ({ ok: true, args: {} }) });
    const c = new BoardClient({ socket: clientSocket, name: 'alpha', skills: ['collect'], timeoutMs: 500 });
    await c.hello();                                     // 只上报了 collect
    const r = await c.add({ skill: 'build', args: {}, assignee: 'alpha' });
    if (isResult(r) && !r.ok && /没上报过/.test(r.message)) {
        okCase('安全①b：bot 没上报过的 skill → 拒绝', r.message.slice(0, 50));
    } else badCase('安全①b', r);
}

// ── 9. 安全②③：args 不合格 → 服务端拒绝且**不进库** ────────────
{
    const dir = join(DIR, 'sec2');
    const { db } = openBoard(dir);
    const { io, clientSocket } = makeFakePair();
    attachBoardServer({
        io, db, registry: new Map([['collect', {}]]),
        validateArgs: (skill, args) => (args?.count > 64
            ? { ok: false, error: 'count 要 1..64' }
            : { ok: true, args }),
    });
    const c = new BoardClient({ socket: clientSocket, name: 'alpha', timeoutMs: 500 });
    const bad = await c.add({ skill: 'collect', args: { count: 999 }, assignee: 'alpha' });
    const n = listJobs(db, {}).length;
    if (isResult(bad) && !bad.ok && /参数不合格/.test(bad.message) && n === 0) {
        okCase('安全②③：args 不合格 → 拒绝且不进库', `库里有 ${n} 张单`);
    } else badCase('安全②③ args 校验', { bad, n });
}

// ── 10. 安全③：priority 越界（别人可以绕过 client 直接发）──────────
{
    const { db } = openBoard(join(DIR, 'sec3'));
    const { io, clientSocket } = makeFakePair();
    attachBoardServer({ io, db, registry: new Map([['collect', {}]]), validateArgs: () => ({ ok: true, args: {} }) });
    const c = new BoardClient({ socket: clientSocket, name: 'alpha', timeoutMs: 500 });
    const r = await c.add({ skill: 'collect', args: {}, priority: 999, assignee: 'alpha' });
    if (isResult(r) && !r.ok && /priority/.test(r.message)) {
        okCase('安全③：priority 越界 → 拒绝', r.message.slice(0, 40));
    } else badCase('安全③ priority', r);
}

// ── 11. 服务端 LEASE_LOST 透传给 client（不吞成 INTERNAL）──────────
{
    const { db } = openBoard(join(DIR, 'lease'));
    const { io, clientSocket } = makeFakePair();
    attachBoardServer({ io, db, registry: new Map([['collect', {}]]), validateArgs: () => ({ ok: true, args: {} }) });
    const c1 = new BoardClient({ socket: clientSocket, name: 'alpha', timeoutMs: 500 });
    const c2 = new BoardClient({ socket: clientSocket, name: 'beta', timeoutMs: 500 });
    const add = await c1.add({ skill: 'collect', args: {}, assignee: null });
    const claimed = await c1.claim();
    const r = await c2.heartbeat(add.data.id, { count: 1, want: 5 });     // beta 不是 owner
    if (isResult(r) && !r.ok && r.code === 'LEASE_LOST') {
        okCase('LEASE_LOST 透传到 client（不吞成 INTERNAL）', r.code);
    } else badCase('LEASE_LOST 透传', r);
}

// ── 12. validateIncomingJob 独立可用（服务端再校验一遍的入口）──────
{
    const registry = new Map([['collect', {}]]);
    const bad1 = validateIncomingJob({ skill: 'nope' }, { registry });
    const bad2 = validateIncomingJob({ skill: 'collect', priority: 99 }, { registry });
    const good = validateIncomingJob({ skill: 'collect', priority: 7 }, { registry });
    if (!bad1.ok && !bad2.ok && good.ok && good.job.priority === 7) {
        okCase('validateIncomingJob：缺 skill / priority 越界被拒，合法放行', 'ok');
    } else {
        badCase('validateIncomingJob', { bad1, bad2, good: good.ok });
    }
}

// ── 13. makeNullBoard：5 个方法齐全且行为与"没有板"一致 ───────────
{
    const nb = makeNullBoard();
    const has = ['list', 'get', 'update', 'add', 'setAutoClaim'].filter((m) => typeof nb[m] !== 'function');
    const l = nb.list({ states: ['ready'] });          // 必须能直接当数组用
    const g = nb.get('x');
    const upd = await nb.update('x', {});
    const good = has.length === 0 && Array.isArray(l) && l.length === 0 && g === null
        && isResult(upd) && !upd.ok && upd.data?.noBoard === true;
    if (good) okCase('makeNullBoard：契约齐全、list=[]/get=null、写操作报 noBoard', 'ok');
    else badCase('makeNullBoard', { has, l, g, upd });
}

// ── 14. 所有 client 方法返回合法 ActionResult ──────────────────────
{
    const { db } = openBoard(join(DIR, 'results'));
    const { io, clientSocket } = makeFakePair();
    attachBoardServer({ io, db, registry: new Map([['collect', {}]]), validateArgs: () => ({ ok: true, args: {} }) });
    const c = new BoardClient({ socket: clientSocket, name: 'alpha', timeoutMs: 500 });
    const add = await c.add({ skill: 'collect', args: {}, assignee: 'alpha' });
    const results = await Promise.all([
        c.hello(), c.refresh(), c.add({ skill: 'collect', args: {}, assignee: 'alpha' }),
        c.claim(), c.heartbeat(add.data.id, { count: 1, want: 2 }),
        c.checkpoint(add.data.id, { s: 1 }), c.setState(add.data.id, JOB_STATE.CANCELLED),
        c.finish(add.data.id, { ok: false, code: 'INTERRUPTED' }),
        c.getAsync(add.data.id),
    ]);
    const bad = results.filter((r) => !isResult(r) || !CODES.includes(r.code));
    if (bad.length === 0) okCase('client 全部方法返回合法 ActionResult', `${results.length} 个方法`);
    else badCase('非法 ActionResult', bad.map((b) => b?.code));
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
// T15：并发安全后也**不留垃圾**；清理失败不许让测试变红
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fails === 0 ? 0 : 1);
