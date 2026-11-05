#!/usr/bin/env node
/**
 * t142：`reopenOrphanBlocked` 的离线证伪 + 正向验证。
 *
 * 证伪两件事：
 *   ① **LIMIT 被历史垃圾占满**：造 250 组「已完成父子对」+ 1 张「blocked 且依赖已 done」的单。
 *      · 若 SQL 不带状态过滤、只 `SELECT id FROM jobs WHERE ... LIMIT 200`（错误写法）
 *        → 目标单排在 250 组之后，**排在 LIMIT 外** → 0 个被重开（**永久卡住且不报错**）。
 *      · 修复版（`WHERE state='blocked' ORDER BY rowid DESC`）→ **1 个被重开**。
 *   ② 正向：重开后 `state=ready`、`checkpoint.reopenedOnce=true`，且**第二次扫不会再重开**（防死循环）。
 *
 * ★ 这个用例本身就是对 captain 判据的落实：
 *   **"说没法离线证伪之前，先问能不能造出那个边界的数据"。** —— 5 行 SQL 就能造。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBoard, addJob, reopenOrphanBlocked, getJob, JOB_STATE } from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const ok = (n, ev = '') => { pass++; console.log(`  PASS  ${n}${ev ? '  ' + ev : ''}`); };
const bad = (n, a) => { fail++; console.log(`  FAIL  ${n}  ${JSON.stringify(a)}`); };
const chk = (n, cond, ev, actual) => cond ? ok(n, ev) : bad(n, actual ?? ev);

const dir = mkdtempSync(join(tmpdir(), 't142-'));
const { db, close } = (() => {
    const r = openBoard(dir);
    return { db: r.db, close: () => { try { r.db?.close?.(); } catch { /* ignore */ } } };
})();

try {
    // ── 造 250 组「已完成父子对」当历史垃圾 ──────────────────────────
    const N = 250;
    for (let i = 0; i < N; i += 1) {
        const parent = addJob(db, { skill: 'obtain', args: { item: `junk_${i}`, count: 1 }, state: 'done', title: `junk-parent-${i}` });
        const pid = parent.id ?? parent.data?.id;
        addJob(db, { skill: 'craft', args: { item: `junk_${i}`, count: 1 }, parentId: pid, state: 'done' });
    }
    // ── 1 张目标单：blocked，且它的依赖已经 done ─────────────────────
    const dep = addJob(db, { skill: 'craft', args: { item: 'oak_planks', count: 4 }, state: 'done' });
    const depId = dep.id ?? dep.data?.id;
    const target = addJob(db, {
        skill: 'craft', args: { item: 'crafting_table', count: 1 }, state: 'blocked',
        dependsOn: [depId], title: 'target-blocked-with-satisfied-dep',
    });
    const targetId = target.id ?? target.data?.id;

    const total = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
    const blocked = db.prepare("SELECT COUNT(*) c FROM jobs WHERE state='blocked'").get().c;
    console.log(`  造数：jobs ${total} 张（其中 blocked ${blocked} 张），distinct parentId ` +
        `${db.prepare('SELECT COUNT(DISTINCT parentId) c FROM jobs WHERE parentId IS NOT NULL').get().c}`);
    chk('① 造数到位：>200 组历史父子对 + 1 张 blocked 目标单', total > 2 * N && blocked === 1, `jobs=${total} blocked=${blocked}`);

    // ── 证伪 A：错误的写法（无状态过滤，纯 LIMIT）会漏掉目标单 ──────
    {
        // 模拟"没有状态过滤"的旧式查询：把 blocked 单塞进"按插入顺序前 200 个"里
        const naive = db.prepare('SELECT id FROM jobs LIMIT 200').all().map((r) => r.id);
        chk('② 证伪：裸 LIMIT 200 取不到那张 blocked 目标单（这就是"永久卡住"的机制）',
            !naive.includes(targetId), `naive 命中目标=${naive.includes(targetId)}（共 ${naive.length} 个）`);
    }

    // ── 正向：修复版扫一次 → 目标单被重开 ────────────────────────────
    {
        const reopened = reopenOrphanBlocked(db, { now: Date.now() });
        const after = getJob(db, targetId);
        chk('③ 正向：修复版扫到并重开了目标单', reopened.length === 1 && after.state === JOB_STATE.READY,
            `reopened=${reopened.length} state=${after?.state}`, { reopened: reopened.length, state: after?.state });
        chk('④ 重开时打了 `reopenedOnce` 标记（防死循环）', after.checkpoint?.reopenedOnce === true,
            `checkpoint=${JSON.stringify(after.checkpoint)}`);
    }

    // ── 反向：再扫一次不应再重开（一次性）────────────────────────────
    {
        // 先把它弄回 blocked 模拟"又失败了"
        db.prepare("UPDATE jobs SET state='blocked' WHERE id=?").run(targetId);
        const again = reopenOrphanBlocked(db, { now: Date.now() });
        const after = getJob(db, targetId);
        chk('⑤ 反向：`reopenedOnce` 之后即使再次 blocked 也不再重开（防死循环）',
            again.length === 0 && after.state === JOB_STATE.BLOCKED,
            `reopened=${again.length} state=${after?.state}`);
    }

    // ── 反向：依赖没满足的单不该被重开 ──────────────────────────────
    {
        const dep2 = addJob(db, { skill: 'craft', args: { item: 'oak_log', count: 1 }, state: 'ready' });
        const dep2Id = dep2.id ?? dep2.data?.id;
        const t2 = addJob(db, { skill: 'craft', args: { item: 'stick', count: 2 }, state: 'blocked', dependsOn: [dep2Id] });
        const t2Id = t2.id ?? t2.data?.id;
        reopenOrphanBlocked(db, { now: Date.now() });
        chk('⑥ 反向：依赖仍 ready（未 done）的 blocked 单**不**被重开', getJob(db, t2Id).state === JOB_STATE.BLOCKED,
            `state=${getJob(db, t2Id)?.state}`);
    }
} finally {
    close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nreopenOrphanBlocked 用例：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
