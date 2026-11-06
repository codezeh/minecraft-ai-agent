/**
 * BOARD-001（2026-11-06 深度检查，P2）—— 先截断 16 张再检查依赖会饿死可执行前置任务。
 *
 * 缺陷原貌（报告 01-完整检查报告.md "### BOARD-001"）：
 *   `board_store.claimFor()` 的候选查询是
 *     `SELECT id FROM jobs WHERE state='ready' ... LIMIT 16`
 *   然后把 16 张**逐张**丢进 `convergeIfSatisfied / meetsRequires / dependsSatisfied`，
 *   全部 `continue` 之后 `return null`。于是：
 *     「前 16 张高优先级单都在等同一张前置单（还没 done）+ 真正可执行的那张前置单排在第 17 位」
 *   → 每轮轮询都捞回**同一批 16 张**、每轮都全被筛掉 → **永久领不出任何单，而且不报错**。
 *   面板看着"有 ready、有活"，调度实际停摆（报告实测：连续两次 claim 均为 null，
 *   前置单始终 ready）。
 *
 * 修复后应成立的判据（报告"回归验收"原文）：
 *   ① 16 / 17 / 100 张阻塞单之后，**仍然能领到那张前置**；
 *   ② 能力过滤不回退（缺物品的单照样不让领）；
 *   ③ 同级顺序不回退（priority DESC、createdAt ASC）；
 *   ④ 原子领单不回退（同一张单不会被两个 bot 各领一次）。
 *
 * 全部离线：临时目录里的真 sqlite 文件（每个进程一个 mkdtemp，跑完不用清），
 * 不连 socket、不连服务器、不起子进程。
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, addJob, getJob, claimFor, finish, JOB_STATE,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const DIR = mkdtempSync(join(os.tmpdir(), 'board001-'));
let dbSeq = 0;
const freshDb = () => openBoard(join(DIR, `db${++dbSeq}`)).db;

const T0 = 1_700_000_000_000;      // 假时钟（不 sleep，不依赖真实时间）

/**
 * 造报告里的那种局面：N 张高优先级单**都在等同一张前置单**，前置单优先级最低（排最后）。
 * @returns {{pre:object, blocked:object[]}}
 */
function makeStarvedBoard(db, n) {
    // 前置单先入库（createdAt 更早），但 priority 最低 —— 排序上排最后
    const pre = addJob(db, { skill: 'mine', title: '前置：先挖到石头', priority: 5 }, { now: T0 });
    const blocked = [];
    for (let i = 0; i < n; i++) {
        blocked.push(addJob(db, {
            skill: 'build', title: `阻塞单 ${i + 1}`, priority: 9, dependsOn: [pre.id],
        }, { now: T0 + 1 + i }));
    }
    return { pre, blocked };
}

// ── ① 报告原样复现：16 张阻塞单 → 必须能领到那张前置 ────────────────────
{
    const db = freshDb();
    const { pre } = makeStarvedBoard(db, 16);
    const got = claimFor(db, 'alpha', { now: T0 + 1000 });
    check('① 16 张阻塞单之后仍能领到前置（修复前恒 null）', got?.id === pre.id,
        `claimed=${got?.id ?? 'null'} want=${pre.id}`);
    check('① 前置单真的被改成 claimed（不是"返回了但没落库"）',
        getJob(db, pre.id)?.state === JOB_STATE.CLAIMED, `state=${getJob(db, pre.id)?.state}`);
}

// ── ② 17 张 / ③ 100 张：同一条判据要有余量（不是"刚好 16 运气好"）────────
for (const n of [17, 100]) {
    const db = freshDb();
    const { pre } = makeStarvedBoard(db, n);
    const got = claimFor(db, 'alpha', { now: T0 + 1000 });
    check(`② ${n} 张阻塞单之后仍能领到前置`, got?.id === pre.id, `claimed=${got?.id ?? 'null'}`);
}

// ── ④ 没有可执行前置时不许"乱领"：16 张都在等 → 必须返回 null ────────────
//    （防止修法变成"把依赖判据整个跳过"那种假修）
{
    const db = freshDb();
    const { pre, blocked } = makeStarvedBoard(db, 16);
    // notBefore 还没到 → 谁都领不到（证明"扫描范围变大"没有顺手跳过别的过滤条件）
    addJob(db, {
        skill: 'mine', title: '还没到点的单', priority: 9, notBefore: T0 + 10_000,
    }, { now: T0 });
    const notYet = claimFor(db, 'nobody', { now: T0 + 1000 });
    check('④ notBefore 未到的单不会被领（notBefore 过滤没被绕过；反而领到的是前置）',
        notYet?.id === pre.id, `claimed=${notYet?.id ?? 'null'} want=${pre.id}`);
    // 现在让前置单进入 claimed（被人占着）→ 16 张阻塞单依旧全都不该被领
    claimFor(db, 'beta', { now: T0 + 1000 });          // beta 领走前置
    const after = claimFor(db, 'alpha', { now: T0 + 2000 });
    check('④ 前置只是 claimed（没 done）时，16 张阻塞单一张都不领', after === null,
        `claimed=${after?.id ?? 'null'} blocked=${blocked.length} pre=${pre.id}`);
}

// ── ⑤ 前置做完之后：阻塞单按"同级最早先领"的顺序放行 ────────────────────
{
    const db = freshDb();
    const { pre, blocked } = makeStarvedBoard(db, 16);
    const claimedPre = claimFor(db, 'alpha', { now: T0 + 1000 });
    check('⑤ 先领到前置', claimedPre?.id === pre.id, `claimed=${claimedPre?.id ?? 'null'}`);
    const done = finish(db, pre.id, { ok: true, code: 'OK', progress: { count: 1, want: 1 } },
        { now: T0 + 1500, bot: 'alpha' });
    check('⑤ 前置被正常收尾成 done', done.ok && done.next === JOB_STATE.DONE,
        `ok=${done.ok} next=${done.next} code=${done.code ?? ''}`);

    const next = claimFor(db, 'alpha', { now: T0 + 2000 });
    check('⑤ 前置 done 后，同级里**最早创建**的阻塞单先放行',
        next?.id === blocked[0].id, `claimed=${next?.id ?? 'null'} want=${blocked[0].id}`);
}

// ── ⑥ 能力过滤不回退：缺物品的单就不该被领（哪怕它排第一）──────────────
{
    const db = freshDb();
    const needTool = addJob(db, {
        skill: 'mine', title: '需要石镐', priority: 9, requires: { items: ['stone_pickaxe'] },
    }, { now: T0 });
    const plain = addJob(db, { skill: 'mine', title: '不需要工具', priority: 5 }, { now: T0 + 1 });

    const empty = claimFor(db, 'alpha', { now: T0 + 1000, items: [] });
    check('⑥ 空背包时跳过"需要石镐"的单，改领普通单', empty?.id === plain.id,
        `claimed=${empty?.id ?? 'null'} want=${plain.id}`);
    check('⑥ 需要石镐的单仍是 ready（没被白占租约）',
        getJob(db, needTool.id)?.state === JOB_STATE.READY, `state=${getJob(db, needTool.id)?.state}`);

    const withTool = claimFor(db, 'alpha', { now: T0 + 2000, items: ['stone_pickaxe'] });
    check('⑥ 带了石镐之后就能领到那张单', withTool?.id === needTool.id,
        `claimed=${withTool?.id ?? 'null'} want=${needTool.id}`);
}

// ── ⑦ 原子领单不回退：同一张单不会被两只 bot 各领一次 ───────────────────
{
    const db = freshDb();
    const only = addJob(db, { skill: 'mine', title: '只有一张', priority: 5 }, { now: T0 });
    const a = claimFor(db, 'alpha', { now: T0 + 1000 });
    const b = claimFor(db, 'beta', { now: T0 + 1001 });
    check('⑦ 原子性：A 领到后 B 拿不到同一张', a?.id === only.id && b?.id !== only.id,
        `A=${a?.id ?? 'null'} B=${b?.id ?? 'null'}`);
}

// ── ⑧ 扫描范围变大但**不会跨过"更该先领的个人单"**（顺序语义不回退）─────
{
    const db = freshDb();
    // 共享单 priority=9（先创建），个人单 priority=1（指派给 alpha）
    addJob(db, { skill: 'mine', title: '共享高优先级', priority: 9, assignee: null }, { now: T0 });
    const mine = addJob(db, { skill: 'mine', title: '我的低优先级', priority: 1, assignee: 'alpha' }, { now: T0 + 1 });
    const got = claimFor(db, 'alpha', { now: T0 + 1000 });
    check('⑧ 个人单优先（assignee=我 排在同级/更高优先级的共享单前面）', got?.id === mine.id,
        `claimed=${got?.id ?? 'null'} want=${mine.id}`);
}

console.log(`\n${fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `HAS FAILURES: ${fail} failed, ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
