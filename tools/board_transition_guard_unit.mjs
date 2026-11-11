/**
 * R6 #22 回归：状态转移必须**对库里的当前行**判定，不能拿调用方的旧快照。
 *
 * 病根（00-缺陷报告 §3 #22 / findings/control.md 表格 4-5）：
 *   · `finish` 的 `attempts = job.attempts + 1` 来自读快照、UPDATE 没有 state 条件
 *     ⇒ 两次收尾同时到，写同一个 attempts，**丢一次计数**；
 *   · `heartbeat` 的租约归属只在 JS 里 `if (job.lease?.owner !== bot)` 判，
 *     UPDATE 无条件 ⇒ 读的时候是我的、写的时候已被别人接手，仍能续租。
 * 修法：这些前置条件全部进 UPDATE 的 WHERE（`lease_owner=?` / `state=?` / `attempts=?`），
 *   成败只看 `changes`。本用例用**真子进程**制造并发，证明"恰好一个成功、计数不丢"。
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { openBoard, addJob, claimFor, finish, heartbeat, setState, getJob, JOB_STATE } from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, a) => { fail++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'board-transition-'));
const MOD = pathToFileURL(join(process.cwd(), 'src/agent/library/board_store.js')).href;

function child(scriptBody) {
    const f = join(DIR, `c-${Math.random().toString(36).slice(2)}.mjs`);
    const src = `import { openBoard, finish } from ${JSON.stringify(MOD)};\n${scriptBody}`;
    return new Promise((resolve) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (status) => {
            let parsed = null;
            try { parsed = JSON.parse(out); } catch { parsed = null; }
            resolve({ status, parsed, out: out.slice(0, 300), err: err.slice(0, 300) });
        });
    });
}

// ① ★ 两个进程同时 finish 同一张单 → **每次成功的 finish 恰好记一次 attempts**（不许丢计数）
//   并发时两者可能读到同一快照（只有一个 changes=1，另一个 LEASE_STALE），
//   也可能一前一后（各记一次）—— 两种都合法，不变量是 wins === attempts。
{
    for (let round = 1; round <= 3; round++) {
        const dir = join(DIR, `finish-race-${round}`);
        const { db } = openBoard(dir);
        addJob(db, { title: 'k', skill: 'mine', args: {}, state: JOB_STATE.READY, priority: 5 });
        const claimed = claimFor(db, 'A', {});
        db.close();
        const target = claimed.id;
        const body = `const { db } = openBoard(${JSON.stringify(dir)});
const r = finish(db, ${JSON.stringify(target)}, { ok: false, code: 'TIMEOUT', message: 'x', progress: { count: 0, want: 5 } }, { bot: 'A' });
process.stdout.write(JSON.stringify({ ok: r.ok, code: r.code ?? null }));`;
        const [a, b] = await Promise.all([child(body), child(body)]);
        const { db: db2 } = openBoard(dir);
        const after = getJob(db2, target);
        db2.close();
        const wins = [a, b].filter((r) => r.parsed?.ok === true).length;
        const refused = [a, b].filter((r) => r.parsed?.ok === false && r.parsed?.code === 'LEASE_STALE').length;
        if (wins + refused !== 2 || wins < 1 || after?.attempts !== wins) {
            badCase(`① 第 ${round} 轮：成功的 finish 数与 attempts 不一致（丢/多记计数）`,
                { a: a.parsed, b: b.parsed, attempts: after?.attempts, wins, refused });
        } else if (round === 3) {
            okCase('★ ① 两个进程并发 finish：每轮 wins === attempts（一次成功只记一次，失败方 LEASE_STALE）',
                `最后一轮 wins=${wins} attempts=${after?.attempts}`);
        }
    }
}

// ①b ★ 拿**旧尝试**的收尾（陈旧快照/旧租约）必须被拒：attemptSeq 进 SQL 条件，attempts 不变
{
    const dir = join(DIR, 'stale-finish');
    const { db } = openBoard(dir);
    addJob(db, { title: 'k2', skill: 'mine', args: {}, state: JOB_STATE.READY });
    const claimed = claimFor(db, 'A', {});
    const stale = finish(db, claimed.id, { ok: true, code: 'OK', progress: { count: 5, want: 5 } }, { bot: 'A', attemptSeq: 0 });
    const after = getJob(db, claimed.id);
    db.close();
    if (stale.ok === false && stale.code === 'LEASE_STALE' && after.attempts === 0 && after.state !== JOB_STATE.DONE) {
        okCase('★ ①b 旧尝试（attemptSeq=0）的 finish 被拒，attempts/state 一个字段都没写', `state=${after.state}`);
    } else {
        badCase('①b 陈旧收尾没被拦住', { stale, attempts: after.attempts, state: after.state });
    }
}

// ② heartbeat 的租约归属：非持有者续不了租，且 lease_until 真的没被推后
{
    const dir = join(DIR, 'hb');
    const { db } = openBoard(dir);
    addJob(db, { title: 'h', skill: 'mine', args: {}, state: JOB_STATE.READY });
    const claimed = claimFor(db, 'A', { now: 1000 });
    const before = getJob(db, claimed.id).lease.until;
    const wrong = heartbeat(db, claimed.id, 'B', { now: 2000 });
    const stillBefore = getJob(db, claimed.id).lease.until;
    const right = heartbeat(db, claimed.id, 'A', { now: 2000 });
    const afterUntil = getJob(db, claimed.id).lease.until;
    db.close();
    if (wrong.ok === false && wrong.code === 'LEASE_LOST' && stillBefore === before && right.ok && afterUntil > before) {
        okCase('② 非持有者 heartbeat → LEASE_LOST，租约未被推后；持有者续租成功',
            `before=${before} after=${afterUntil}`);
    } else {
        badCase('② heartbeat 租约判据不对', { wrong, before, stillBefore, right: right.ok, afterUntil });
    }
}

// ③ setState 按**当前行**判：拿旧快照硬写会被拒（changes=0 → LEASE_STALE）
{
    const dir = join(DIR, 'setstate');
    const { db } = openBoard(dir);
    addJob(db, { title: 's', skill: 'mine', args: {}, state: JOB_STATE.READY });
    const claimed = claimFor(db, 'A', { now: 1000 });
    const ok1 = setState(db, claimed.id, JOB_STATE.PAUSED, { now: 2000 });
    // 第二次基于"已经变了"的行：paused → paused 不是合法转移（JS 层就拒）或 SQL 条件不匹配
    const stale = setState(db, claimed.id, JOB_STATE.PAUSED, { now: 3000 });
    db.close();
    if (ok1.ok && stale.ok === false) okCase('③ setState 第二次改状态被拒（不按旧快照硬写）', `code=${stale.code ?? '-'}`);
    else badCase('③ setState 陈旧快照没被拦住', { ok1, stale });
}

// ④ 接线守卫：三处前置条件必须真的写进了 SQL（否则只是 JS 里判了一下）
{
    const src = readFileSync('src/agent/library/board_store.js', 'utf8');
    const hbSql = /UPDATE jobs SET lease_until=\?[^`]*WHERE id=\? AND lease_owner=\?/.test(src);
    const finishSql = /WHERE id=\? AND state=\? AND attempts=\?/.test(src);
    const setStateSql = /WHERE id=\? AND state=\?\$\{stGuard\.sql\}/.test(src);
    if (hbSql && finishSql && setStateSql) okCase('④ 接线：heartbeat/finish/setState 的前置条件都落在 SQL 里', 'ok');
    else badCase('④ 有守卫只写在 JS 里', { hbSql, finishSql, setStateSql });
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
