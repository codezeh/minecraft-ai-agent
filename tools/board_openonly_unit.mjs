/**
 * `listJobs({ openOnly })`：**200 张历史单不许把调度器视野占满**（报告第14条）—— 离线，真 sqlite。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 病根：`listJobs` 是 `ORDER BY priority DESC, createdAt ASC LIMIT 200`
 *   （同优先级取**最老**），而 `jobs` 表**从不删除**（全仓无 `DELETE FROM jobs`）。
 *   → 累计超过 200 张单后，最老的 200 张把窗口占满，
 *     **新单根本进不了调度器视野** → `refresh({scope:'claimable'})` 拉不到它
 *     → 抢占 / 残局回收**静默失效**（不报错，就是不发生）。
 *   这和 t141/t142 在 `convergeOrphanParents` 上踩的是同一个坑。
 *
 *   修法：`openOnly` 把「未终结」过滤**放进 SQL**（`state NOT IN ('done','failed','cancelled')`），
 *   结果集天然小，LIMIT 永远不会被历史垃圾占满。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS / FAIL，全过退出码 0。临时库在 tmp/，跑完删除。
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBoard, addJob, listJobs, JOB_STATE } from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = join('tmp', 'board-openonly-test');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); return openBoard(d); };

const BOT = 'alpha';

/** 造 250 张高优先级的历史单（done）+ 1 张低优先级的**新**待办单 */
function makeBacklog(db) {
    let t = 1000000;
    for (let i = 0; i < 250; i++) {
        addJob(db, {
            title: `历史${i}`, skill: 'mine', priority: 9,
            state: JOB_STATE.DONE,
        }, { now: t++ });
    }
    const fresh = addJob(db, {
        title: '新单（该被看见）', skill: 'mine', priority: 1, state: JOB_STATE.READY,
    }, { now: t + 1000 });
    return fresh;
}

// ══════════════════════════════════════════════════════════════════════════
// ① 复现病根：不带 openOnly → 新单被 200 张历史单挤出窗口（**这就是缺陷本身**）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshDb();
    const fresh = makeBacklog(db);
    const seen = listJobs(db, { claimableFor: BOT });
    const visible = seen.some((j) => j.id === fresh.id);
    const allDone = seen.every((j) => j.state === JOB_STATE.DONE);
    if (seen.length === 200 && !visible && allDone) {
        okCase('★ ① 复现病根：不带 openOnly 时窗口被 200 张 done 占满，新单看不见',
            `返回=${seen.length} 新单可见=${visible}`);
    } else {
        badCase('① 没能复现"窗口被历史单占满"（场景构造有问题，后续用例不能算数）', {
            返回: seen.length, 新单可见: visible, 全done: allDone,
        });
    }

    // ② 修好之后：带 openOnly → 新单立刻可见
    const opened = listJobs(db, { claimableFor: BOT, openOnly: true });
    const ok2 = opened.some((j) => j.id === fresh.id)
        && opened.every((j) => ![JOB_STATE.DONE, JOB_STATE.FAILED, JOB_STATE.CANCELLED].includes(j.state));
    if (ok2) {
        okCase('★ ② 带 openOnly → 新单进得了视野，且结果集里没有任何终态单',
            `返回=${opened.length} 新单可见=true`);
    } else {
        badCase('② openOnly 没把新单捞出来', { 返回: opened.length, ids: opened.map((j) => j.title) });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ openOnly 的判据逐状态核对：done/failed/cancelled 排除，其余全留
//    （★ 不能把 blocked/paused 也排掉 —— 残局回收正要看它们）
// ══════════════════════════════════════════════════════════════════════════
{
    const { db } = freshDb();
    const make = (state, name) => addJob(db, { title: name, skill: 'mine', priority: 5, state }, { now: 2000000 });
    const ids = {
        ready: make(JOB_STATE.READY, 'r').id,
        blocked: make(JOB_STATE.BLOCKED, 'b').id,
        paused: make(JOB_STATE.PAUSED, 'p').id,
        pending: make(JOB_STATE.PENDING, 'pd').id,
        done: make(JOB_STATE.DONE, 'd').id,
        failed: make(JOB_STATE.FAILED, 'f').id,
        cancelled: make(JOB_STATE.CANCELLED, 'c').id,
    };
    const got = listJobs(db, { claimableFor: BOT, openOnly: true }).map((j) => j.id);
    const want = [ids.ready, ids.blocked, ids.paused, ids.pending];
    const unwanted = [ids.done, ids.failed, ids.cancelled];
    const missing = want.filter((id) => !got.includes(id));
    const leaked = unwanted.filter((id) => got.includes(id));
    if (!missing.length && !leaked.length) {
        okCase('③ openOnly 判据：done/failed/cancelled 排除，ready/blocked/paused/pending 保留',
            `返回=${got.length}`);
    } else {
        badCase('③ openOnly 的状态判据不对', { 少: missing, 多: leaked });
    }
}

// ④ openOnly 与 states 过滤可以叠加（两个条件都在 SQL 里）
{
    const { db } = freshDb();
    const done = addJob(db, { title: 'd', skill: 'mine', state: JOB_STATE.DONE }, { now: 3000000 });
    const ready = addJob(db, { title: 'r', skill: 'mine', state: JOB_STATE.READY }, { now: 3000001 });
    const got = listJobs(db, { states: [JOB_STATE.DONE, JOB_STATE.READY], openOnly: true }).map((j) => j.id);
    const good = got.includes(ready.id) && !got.includes(done.id);
    if (good) okCase('④ openOnly 与 states 叠加生效（都在 SQL 里）', `返回=${got.length}`);
    else badCase('④ 叠加条件不生效', { got, done: done.id, ready: ready.id });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 接线：两处必须真的把 openOnly 传下去（否则"挂在参数上但没人用"）
//    ★ 与 ⑩/⑰ 同一手法：读源码断言 + 内存里摘掉反证守卫有敏感性。
// ══════════════════════════════════════════════════════════════════════════
{
    const client = readFileSync('src/agent/library/board_client.js', 'utf8');
    const server = readFileSync('src/agent/library/board_server.js', 'utf8');

    const clientWired = client.includes("if (scope === 'claimable')")
        && client.includes('payload.openOnly = true');
    const serverWired = server.includes("openOnly: f.openOnly === true || scope === 'claimable'");
    if (clientWired && serverWired) {
        okCase('⑤ 接线：client 的 refresh(claimable) 必带 openOnly，server 侧也把它并进 listJobs',
            'client=1 server=1');
    } else {
        badCase('⑤ 接线缺失（参数传不上去等于没修）', { clientWired, serverWired });
    }

    // 反证：把 client 那行摘掉 → 守卫必须报红
    const broken = client.replace('payload.openOnly = true', 'void 0');
    const stillOk = broken.includes('payload.openOnly = true');
    if (stillOk === false) okCase('⑤-b 反向验证：内存里摘掉 payload.openOnly → 守卫报红（⑤ 会红）', 'mutantFound=false');
    else badCase('⑤-b 反向验证失效（守卫不看这一行）', { stillOk });
}

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
