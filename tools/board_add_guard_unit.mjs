/**
 * R6 #20 / #67 回归：`board:add` 不再放行 state/parentId/assignee/maxAttempts/claims。
 *
 * 反例来自报告 00-缺陷报告.md §3 #20（伪造 state:'done' 污染统计、parentId 指向任意父单、
 * maxAttempts:999 绕过失败上限）与 #67（`container:chest` 缺坐标的非法 claim key）。
 * 正例必须覆盖**现有合法调用**：ready / running(+assignee) / maxAttempts 1..10 / 合法 parentId。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openBoard, getJob, JOB_STATE } from '../src/agent/library/board_store.js';
import { attachBoardServer, validateAddFields } from '../src/agent/library/board_server.js';
import { BoardClient } from '../src/agent/library/board_client.js';

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, a) => { fail++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'board-add-guard-'));
let seq = 0;
function makeBoard(role = 'panel') {
    const { db } = openBoard(join(DIR, `db${++seq}`));
    const handlers = new Map();
    const serverSocket = { on(ev, fn) { handlers.set(ev, fn); }, data: { role } };
    const clientSocket = { on() {}, emit(ev, payload, ack) { const h = handlers.get(ev); if (!h) { ack?.({ ok: false, reason: `no handler ${ev}` }); return; } h(payload, ack); } };
    const io = { on(ev, fn) { if (ev === 'connection') fn(serverSocket); }, emit() {} };
    attachBoardServer({
        io, db, registry: new Map([['collect', {}]]),
        validateArgs: (s, a) => ({ ok: true, args: a ?? {} }),
    });
    const c = new BoardClient({ socket: clientSocket, name: 'alpha', skills: ['collect'], timeoutMs: 500 });
    return { db, c };
}
const addRaw = (c, job) => c.add(job);

// ① 合法：不带 state（默认 ready）— 现有 !addJob 之外的常态调用
{
    const { c, db } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: { count: 1 }, assignee: 'alpha' });
    const job = r.ok ? getJob(db, r.data.id) : null;
    if (r.ok && job?.state === JOB_STATE.READY && job?.maxAttempts === 3) okCase('① 不带 state → 默认 ready、maxAttempts 默认 3', `${job?.state}/${job?.maxAttempts}`);
    else badCase('① 合法默认调用被打死', { r, job });
}

// ② 合法：state:'ready'（!addJob / strat_obtain 子单）
{
    const { c } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', state: 'ready', maxAttempts: 2 });
    if (r.ok) okCase('② 合法：state=ready + maxAttempts=2 放行', r.data.id);
    else badCase('② 合法 ready 被打死', r);
}

// ③ 合法：state:'running' + assignee（strat_obtain / strat_first_night 的壳父单）
{
    const { c, db } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', state: 'running', maxAttempts: 1 });
    const job = r.ok ? getJob(db, r.data.id) : null;
    if (r.ok && job?.state === 'running') okCase('③ 合法：state=running 带 assignee（壳父单）放行', job.id);
    else badCase('③ 合法 running 父单被打死', { r, job });
}

// ④ 反例：伪造历史 state
for (const st of ['done', 'failed', 'cancelled', 'claimed', 'paused', 'blocked']) {
    const { c } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', state: st });
    if (!r.ok && /state/.test(r.message)) okCase(`④ 反例：state=${st} 被拒`, r.message.slice(0, 30));
    else badCase(`④ state=${st} 没被拦住`, r);
}

// ⑤ 反例：running 但没有 assignee（无主的 running 单）
{
    const { c } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: {}, state: 'running' });
    if (!r.ok && /assignee/.test(r.message)) okCase('⑤ 反例：running 无 assignee 被拒', r.message.slice(0, 40));
    else badCase('⑤ running 无 assignee 没被拦住', r);
}

// ⑥ 反例：maxAttempts 越界（999 绕过失败上限 / 0 / 小数）
for (const v of [999, 0, -1, 2.5]) {
    const { c } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', maxAttempts: v });
    if (!r.ok && /maxAttempts/.test(r.message)) okCase(`⑥ 反例：maxAttempts=${v} 被拒`, r.message.slice(0, 40));
    else badCase(`⑥ maxAttempts=${v} 没被拦住`, r);
}

// ⑦ 反例：parentId 指向不存在的单
{
    const { c } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', parentId: 'j_nope' });
    if (!r.ok && /不存在/.test(r.message)) okCase('⑦ 反例：parentId 不存在 → NO_TARGET', `${r.code} ${r.message.slice(0, 30)}`);
    else badCase('⑦ 幽灵 parentId 没被拦住', r);
}

// ⑧ 反例：parentId 指向终态单（伪造"父单完成了"）
{
    const { c, db } = makeBoard();
    await c.hello();
    const p = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha' });
    const { setState } = await import('../src/agent/library/board_store.js');
    setState(db, p.data.id, JOB_STATE.DONE, {});
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', parentId: p.data.id });
    if (!r.ok && /终态/.test(r.message)) okCase('⑧ 反例：parentId 指向终态单被拒', r.message.slice(0, 40));
    else badCase('⑧ 终态 parentId 没被拦住', r);
}

// ⑨ 合法：parentId 指向存在且未终结的单（strat_obtain 的子单）
{
    const { c, db } = makeBoard();
    await c.hello();
    const p = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', state: 'running' });
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', parentId: p.data.id, state: 'ready' });
    const kid = r.ok ? getJob(db, r.data.id) : null;
    if (r.ok && kid?.parentId === p.data.id) okCase('⑨ 合法：parentId 落库（子单挂在未终结父单下）', kid.parentId);
    else badCase('⑨ 合法 parentId 被打死', { r, kid });
}

// ⑩ #67 反例：非法 claim key（`container:chest` 缺坐标）→ 拒，不给下游制造 INTERNAL
{
    const { c, db } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', claims: ['container:chest'] });
    const any = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    if (!r.ok && /claims/.test(r.message) && Number(any) === 0) okCase('⑩ 反例：claims=[\'container:chest\'] 被拒（非法 key 不进库）', r.message.slice(0, 50));
    else badCase('⑩ 非法 claim key 没被拦住', { r, any });
}

// ⑪ #67 正例：合法 container key（带坐标）放行，且落库
{
    const { c, db } = makeBoard();
    await c.hello();
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', claims: ['container:1,64,2'] });
    const job = r.ok ? getJob(db, r.data.id) : null;
    if (r.ok && Array.isArray(job?.claims) && job.claims[0] === 'container:1,64,2') okCase('⑪ 正例：合法 container key 放行并落库', JSON.stringify(job.claims));
    else badCase('⑪ 合法 claims 被打死', { r, job });
}

// ⑫ #67：flow_store 的 manifest 不再带死的非法 claim；deriveClaims 之外由运行时按真实坐标补占位
{
    const src = readFileSync('src/agent/library/flow_store.js', 'utf8');
    const hasDead = /claims:\s*\[\s*'container:chest'\s*\]/.test(src);
    const { manifestStore } = await import('../src/agent/library/flow_store.js');
    if (!hasDead && manifestStore.claims === undefined) okCase('⑫ flow_store 的非法 claims 占位已删除（不是常量数组）', 'ok');
    else badCase('⑫ 非法 claims 占位还在', { hasDead, claims: manifestStore.claims });
}

// ⑭ #67：client 侧先拦（带 warning），非法 claim key 连 socket 都不发
{
    const { c, db } = makeBoard();
    await c.hello();
    const warned = [];
    const oldWarn = console.warn;
    console.warn = (...a) => { warned.push(a.join(' ')); };
    const r = await addRaw(c, { skill: 'collect', args: {}, assignee: 'alpha', claims: ['entity:'] });
    console.warn = oldWarn;
    const n = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    if (!r.ok && warned.some((w) => /claims/.test(w)) && Number(n) === 0) {
        okCase('⑭ client 侧先拒并留日志：非法 claim 不发 socket、不进库', warned[0]?.slice(0, 44));
    } else {
        badCase('⑭ client 侧没拦住', { r, warned, n });
    }
}

// ⑬ validateAddFields 独立可用（服务端逻辑与 socket 解耦，便于单测/复用）
{
    const bad = validateAddFields({ state: 'done' });
    const good = validateAddFields({ state: 'ready', maxAttempts: 5, claims: ['item:oak_log:2'] });
    if (!bad.ok && good.ok && good.fields.maxAttempts === 5) okCase('⑬ validateAddFields 独立可用（纯函数）', 'ok');
    else badCase('⑬ validateAddFields', { bad, good });
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
