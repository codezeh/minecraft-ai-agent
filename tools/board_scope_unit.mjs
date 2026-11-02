/**
 * t23：`refresh({scope})` 的语义边界（captain 指定的 5 条）。
 *
 * 为什么需要：B2 的抢占/残局回收原来只 refresh 了"我的单"，而真实抢占目标是
 * **共享单（assignee=null）/ 别人的单** → 永远看不到 → 功能对真实场景不生效且不报错。
 * 所以这里断言的不是"镜像里有单"，而是**scope 的语义边界**。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as BS from '../src/agent/library/board_store.js';
import { BoardClient } from '../src/agent/library/board_client.js';
import { BoardScheduler } from '../src/agent/library/board_scheduler.js';

let pass = 0, fail = 0;
const chk = (n, c, i) => {
    if (c) { pass++; console.log(`  PASS  ${n}${i ? '   ' + i : ''}`); }
    else { fail++; console.log(`  FAIL  ${n}   ${JSON.stringify(i)}`); }
};

const NAME = 'me';
const dir = mkdtempSync(join(tmpdir(), 't23scope-'));
const b = BS.openBoard(dir);
const db = b.db;

const mk = (id, extra) => ({
    id, skill: 'collect', params: {}, want: 2, owner: 'Zeh', state: 'ready', priority: 5,
    source: 'player', attempts: 0, maxAttempts: 3, progress: { count: 0, want: 2 }, ...extra,
});

/** 真 server 语义的 socket（ack 形状 = 服务端真实形状：字段在顶层，不套 data） */
function mkSock(scopeHook) {
    return {
        on() { },
        emit(ev, p, cb) {
            if (ev === 'board:list') {
                const f = p ?? {};
                if (scopeHook) { const r = scopeHook(f); setTimeout(() => cb(r), 0); return true; }
                const scope = f.scope ?? 'mine';
                let filter;
                if (scope === 'mine') filter = { assignee: f.mine ?? null };
                else if (scope === 'claimable') filter = { claimableFor: f.mine ?? null };
                else if (scope === 'all') filter = {};
                else { setTimeout(() => cb({ ok: false, reason: `未知 scope「${scope}」` }), 0); return true; }
                const jobs = BS.listJobs(db, { states: f.states ?? null, ...filter });
                setTimeout(() => cb({ ok: true, jobs, scope }), 0);
            } else if (ev === 'board:update') {
                const r = BS.updateJob(db, p.id, p.patch ?? {});
                setTimeout(() => cb({ ok: true, job: r.job }), 0);
            } else if (ev === 'board:set-state') {
                const r = BS.setState(db, p.id, p.state, {});
                setTimeout(() => cb({ ok: true, job: r.job }), 0);
            } else if (ev === 'board:claim') {
                const j = BS.claimFor(db, p?.bot ?? NAME);
                setTimeout(() => cb({ ok: !!j, job: j }), 0);
            } else setTimeout(() => cb({ ok: true }), 0);
            return true;
        },
        close() { },
    };
}

// 三种单：mine(ready) / shared(ready, assignee=null) / other(ready, assignee=otherBot)
BS.addJob(db, mk('J-mine', { assignee: NAME, priority: 5 }));
BS.addJob(db, mk('J-shared', { assignee: null, priority: 7 }));
BS.addJob(db, mk('J-other', { assignee: 'otherBot', priority: 6 }));

console.log('=== 1) refresh({scope:"mine"}) → 只有我那张 ===');
{
    const c = new BoardClient({ name: NAME, skills: ['collect'], socket: mkSock() });
    const r = await c.refresh({ scope: 'mine' });
    const ids = c.list({}).map((j) => j.id).sort();
    chk('只拿到 J-mine（不含 shared / other）', JSON.stringify(ids) === JSON.stringify(['J-mine']), { ids });
    chk('ack 里 scope 回显 mine', r.data?.scope === 'mine', { scope: r.data?.scope });
}

console.log('');
console.log('=== 2) refresh({scope:"claimable"}) → 我 + 共享（不该含别人的）===');
{
    const c = new BoardClient({ name: NAME, skills: ['collect'], socket: mkSock() });
    await c.refresh({ scope: 'claimable' });
    const ids = c.list({}).map((j) => j.id).sort();
    chk('拿到 J-mine + J-shared', JSON.stringify(ids) === JSON.stringify(['J-mine', 'J-shared']), { ids });
    chk('**不含** J-other（别人的 ready 单不归我抢）', !ids.includes('J-other'), { ids });
}

console.log('');
console.log('=== 3) refresh({scope:"all"}) → 三张都有（面板/调试用）===');
{
    const c = new BoardClient({ name: NAME, skills: ['collect'], socket: mkSock() });
    await c.refresh({ scope: 'all' });
    const ids = c.list({}).map((j) => j.id).sort();
    chk('三张全在', JSON.stringify(ids) === JSON.stringify(['J-mine', 'J-other', 'J-shared']), { ids });
}

console.log('');
console.log('=== 4) 未知 scope → 必须报错（不许静默当 mine / all）===');
{
    // 4a 客户端本地就拦
    const c = new BoardClient({ name: NAME, skills: ['collect'], socket: mkSock() });
    const r = await c.refresh({ scope: 'claimabl' });      // 拼写错
    chk('客户端：未知 scope 返回 fail（不发请求）', r.ok === false && /未知 scope/.test(String(r.message)), { code: r.code, msg: String(r.message).slice(0, 40) });

    // 4b 服务端也要拦（绕过 client 直接发）
    const c2 = new BoardClient({ name: NAME, skills: ['collect'], socket: mkSock() });
    const r2 = await c2._call('board:list', { scope: 'bogus', mine: NAME, states: null });
    chk('服务端：未知 scope 也返回 fail', r2.ok === false && /未知 scope/.test(String(r2.message ?? '')), { code: r2.code });
}

console.log('');
console.log('=== 5) 端到端：忙在 3 级单上 + 库里一张**共享 9 级** ready 单 → tick 必须抢占 ===');
{
    // 重置库：只留一张 3 级（我的，正在跑）+ 一张共享 9 级
    db.prepare("UPDATE jobs SET state='cancelled'").run();
    BS.addJob(db, mk('J-3', { assignee: NAME, priority: 3 }));
    BS.addJob(db, mk('J-shared9', { assignee: null, priority: 9 }));
    db.prepare("UPDATE jobs SET state='claimed', lease_owner=?, lease_until=? WHERE id='J-3'").run(NAME, Date.now() + 60000);

    const c = new BoardClient({ name: NAME, skills: ['collect'], socket: mkSock() });
    const events = [];
    const sched = new BoardScheduler({
        board: c,
        agent: { board: c, actions: { executing: true, currentJobId: 'J-3', currentPriority: 3 }, bot: { entity: { position: { x: 0, y: 64, z: 0 } } } },
        actions: { executing: true, currentJobId: 'J-3', currentPriority: 3 },
        runSkill: async () => ({ ok: true }),
        now: () => Date.now(),
        onEvent: (e) => events.push(e),
    });
    sched.currentJobId = 'J-3';

    const r = await sched.tick();
    await new Promise((x) => setTimeout(x, 50));
    const types = events.map((e) => e.type);
    chk('tick 触发了抢占（有 preempt-start 事件）', types.includes('preempt-start'), { types });
    chk('被打断的单被记成 paused(preempted)', types.includes('job-paused-preempted') || BS.getJob(db, 'J-3').state === BS.JOB_STATE.PAUSED,
        { j3: BS.getJob(db, 'J-3').state, types });
    chk('抢占目标就是那张**共享** 9 级单', (events.find((e) => e.type === 'preempt-start')?.id) === 'J-shared9',
        { id: events.find((e) => e.type === 'preempt-start')?.id });
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(`合计 ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
