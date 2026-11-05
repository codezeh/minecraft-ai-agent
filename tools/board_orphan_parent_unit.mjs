/**
 * `convergeOrphanParents`（父单兜底收敛）守卫 —— t140 `bff4e08`。
 *
 * 背景（真机第 59 跑）：`first_night` 父单 **running**、5 张子单**全部 done** —— 父单永不收敛。
 *   根因：`rollupParent` 只在 `board:finish` 事件里调，**事件驱动的收敛缺兜底**，漏一次就永久不一致。
 *   修法：新增 `convergeOrphanParents(db, opts)`，接进 `board_server` 的 `scanTimer`。
 *
 * ★ ④ 的结论**先读码再断言**（任务要求"别猜"）：
 *   `convergeOrphanParents` 的 `terminal` 集合包含 `done/failed/blocked/cancelled`，
 *   所以"3 done + 1 blocked + 1 failed"**会**进入收敛；
 *   但父单**不是变成 done** —— `rollupParent` 的分支顺序是：
 *     allDone?（否，因为有 blocked/failed）→ `blocked.length && !stillAlive` → **父单变 `BLOCKED`**
 *   实测 reason = `children-blocked(1)`。**这就是本条用例真正该断言的东西。**
 *
 * 输出：PASS / FAIL，全过退出码 0。临时库在 `tmp/`，跑完删除。
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    openBoard, addJob, getJob, convergeOrphanParents, rollupParent, JOB_STATE,
} from '../src/agent/library/board_store.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const DIR = join('tmp', 'board-orphan-test');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
let seq = 0;
const freshDb = () => {
    const dir = join(DIR, `db${++seq}`);
    rmSync(dir, { recursive: true, force: true });
    return openBoard(dir);
};

/** 建一张父单（壳，skill=null） */
const mkParent = (db, state = JOB_STATE.RUNNING, title = 'p') =>
    addJob(db, { kind: 'shared', title, skill: null, args: {}, state, priority: 5 });
/** 建一张子单（挂到 parentId） */
const mkKid = (db, parentId, state) =>
    addJob(db, { kind: 'personal', title: 'k', skill: 'collect', args: {}, state, parentId, priority: 5 });

const statesOf = (db, ids) => ids.map((id) => getJob(db, id)?.state);

// ── ① 父 running + 5 子全 done → 收敛 1 个，父变 done ─────────────────
{
    const { db } = freshDb();
    const p = mkParent(db);
    const kids = [0, 1, 2, 3, 4].map(() => mkKid(db, p.id, JOB_STATE.DONE));
    const out = convergeOrphanParents(db, {});
    check('① 父 running + 5 子全 done → 返回 1 个，父变 done',
        out.length === 1 && out[0].id === p.id && getJob(db, p.id).state === JOB_STATE.DONE,
        `out=${out.length} 父状态=${getJob(db, p.id).state} 子=${JSON.stringify(statesOf(db, kids.map((k) => k.id)))}`);
}

// ── ② 幂等：紧接着再调 → 0 ───────────────────────────────────────────
{
    const { db } = freshDb();
    const p = mkParent(db);
    [0, 1].forEach(() => mkKid(db, p.id, JOB_STATE.DONE));
    const first = convergeOrphanParents(db, {});
    const second = convergeOrphanParents(db, {});
    check('② 幂等：连续两次，第二次返回 0（父已终态不再动）',
        first.length === 1 && second.length === 0,
        `first=${first.length} second=${second.length} 父状态=${getJob(db, p.id).state}`);
}

// ── ③ 有活子单（1 running）→ 不收敛 ─────────────────────────────────
{
    const { db } = freshDb();
    const p = mkParent(db);
    [0, 1, 2, 3].forEach(() => mkKid(db, p.id, JOB_STATE.DONE));
    mkKid(db, p.id, JOB_STATE.RUNNING);
    const out = convergeOrphanParents(db, {});
    check('③ 父 running + 4 done + 1 running → 返回 0，父仍 running',
        out.length === 0 && getJob(db, p.id).state === JOB_STATE.RUNNING,
        `out=${out.length} 父状态=${getJob(db, p.id).state}`);
}

// ── ④ 3 done + 1 blocked + 1 failed → **会**收敛，但父单变 BLOCKED ──
//     （不是 done！rollupParent 的 blocked 分支先命中 —— 先读码再断言）
{
    const { db } = freshDb();
    const p = mkParent(db);
    [0, 1, 2].forEach(() => mkKid(db, p.id, JOB_STATE.DONE));
    mkKid(db, p.id, JOB_STATE.BLOCKED);
    mkKid(db, p.id, JOB_STATE.FAILED);
    const out = convergeOrphanParents(db, {});
    check('④ 父 running + 3 done + 1 blocked + 1 failed → 返回 1（blocked/failed 算终态）',
        out.length === 1, `out=${out.length}`);
    check('④-b 父单收敛成 **BLOCKED**（不是 done）—— rollupParent 的 `children-blocked` 分支先命中',
        getJob(db, p.id).state === JOB_STATE.BLOCKED,
        `父状态=${getJob(db, p.id).state}（实测 rollup reason=children-blocked(1)）`);
    // 直接用 rollupParent 复核 reason，证明"父变 blocked"是产品语义而非我的推断
    const { db: db2 } = { db: freshDb().db };
    const p2 = mkParent(db2);
    [0, 1, 2].forEach(() => mkKid(db2, p2.id, JOB_STATE.DONE));
    mkKid(db2, p2.id, JOB_STATE.BLOCKED);
    mkKid(db2, p2.id, JOB_STATE.FAILED);
    const rr = rollupParent(db2, p2.id, {});
    check('④-c 复核 rollupParent 的 reason 以 blocked 为准（不是 failed）',
        rr.changed === true && /children-blocked/.test(String(rr.reason)),
        `reason=${rr.reason}`);
}

// ── ⑤ 父单已 done / cancelled → 不重复处理 ──────────────────────────
{
    const { db } = freshDb();
    const pd = mkParent(db, JOB_STATE.DONE, 'pd');
    const pc = mkParent(db, JOB_STATE.CANCELLED, 'pc');
    mkKid(db, pd.id, JOB_STATE.DONE);
    mkKid(db, pc.id, JOB_STATE.DONE);
    const out = convergeOrphanParents(db, {});
    check('⑤ 父单已 done/cancelled → 返回 0，状态不变',
        out.length === 0
        && getJob(db, pd.id).state === JOB_STATE.DONE
        && getJob(db, pc.id).state === JOB_STATE.CANCELLED,
        `out=${out.length} pd=${getJob(db, pd.id).state} pc=${getJob(db, pc.id).state}`);
}

// ── ⑥ 没有子单的父单（或普通单）→ 不碰 ──────────────────────────────
{
    const { db } = freshDb();
    const p = mkParent(db);                       // 无子单
    const solo = addJob(db, { title: 'solo', skill: 'collect', args: {} });  // 无 parentId
    const out = convergeOrphanParents(db, {});
    check('⑥ 无子单的父单 / 无父的普通单 → 返回 0，状态不变',
        out.length === 0 && getJob(db, p.id).state === JOB_STATE.RUNNING
        && getJob(db, solo.id).state === JOB_STATE.READY,
        `out=${out.length} p=${getJob(db, p.id).state} solo=${getJob(db, solo.id).state}`);
}

// ── ⑦ paused 父单 → 不碰 ────────────────────────────────────────────
{
    const { db } = freshDb();
    const p = mkParent(db, JOB_STATE.PAUSED);
    mkKid(db, p.id, JOB_STATE.DONE);
    const out = convergeOrphanParents(db, {});
    check('⑦ paused 父单 → 返回 0，父仍 paused（只处理 running/ready）',
        out.length === 0 && getJob(db, p.id).state === JOB_STATE.PAUSED,
        `out=${out.length} 父状态=${getJob(db, p.id).state}`);
}

// ── ⑧ 多组混合：只收敛该收敛的那一组 ────────────────────────────────
{
    const { db } = freshDb();
    const pConverge = mkParent(db, JOB_STATE.RUNNING, 'should-converge');
    [0, 1].forEach(() => mkKid(db, pConverge.id, JOB_STATE.DONE));

    const pAlive = mkParent(db, JOB_STATE.RUNNING, 'has-alive-kid');
    mkKid(db, pAlive.id, JOB_STATE.DONE);
    mkKid(db, pAlive.id, JOB_STATE.RUNNING);

    const pTerminal = mkParent(db, JOB_STATE.DONE, 'already-done');
    mkKid(db, pTerminal.id, JOB_STATE.DONE);

    const out = convergeOrphanParents(db, {});
    check('⑧ 混合三组 → 只收敛「该收敛」那一个（返回 1），其余不动',
        out.length === 1 && out[0].id === pConverge.id
        && getJob(db, pAlive.id).state === JOB_STATE.RUNNING
        && getJob(db, pTerminal.id).state === JOB_STATE.DONE,
        `out=${out.length} converge=${getJob(db, pConverge.id).state} alive=${getJob(db, pAlive.id).state} terminal=${getJob(db, pTerminal.id).state}`);
}

// ── ⑨ ★ 反向验证：删掉"活子单保护" → ③ 必须红 ──────────────────────
//
//  ★★ 重要发现（实测后修正任务书的做法）：**只删 `convergeOrphanParents` 里那行
//     `if (kids.some((c) => !terminal.has(c.state))) continue;` 并不会让 ③ 变红。**
//     原因：`rollupParent` 自己也有一道独立防线 ——
//       `allDone = children.every(c => c.state === done)` 为 false，
//       且 `blocked.length`/`failed.length` 都是 0 → 落到 `{changed:false, reason:'in-progress'}`
//     所以父单照样不动，converge 返回 0。
//     → 那行 `kids.some` 其实是**短路优化**（省一次 rollup 调用），不是唯一保护。
//
//   真正让 ③ 变红的变异：**同时**在 `rollupParent` 里把 `allDone` 改成"有子单就算全好"
//   —— 这才是"有人简化了收敛判据"的真实回归。
//   两种变异都保留：A 证明双重防线存在，B 证明 ③ 是有效守卫。
{
    const SRC = readFileSync('src/agent/library/board_store.js', 'utf8');
    const MUT_DIR = join(DIR, 'mut');
    const prep = (src, tag) => {
        const d = join(MUT_DIR, tag);
        mkdirSync(d, { recursive: true });
        const f = join(d, 'board_store_mut.mjs');
        // ★ 用**绝对路径**改写 import —— 别再数 `../` 层数（我数错过两次：3 层/4 层）。
        // Windows 下 ESM 的 import 说明符必须是 file:// URL（不能用盘符绝对路径）
        const libDir = pathToFileURL(join(process.cwd(), 'src', 'agent', 'library')).href;
        writeFileSync(f, src
            .replace(/from '\.\/bot_paths\.js'/g, `from '${libDir}/bot_paths.js'`)
            .replace(/from '\.\/board_claims\.js'/g, `from '${libDir}/board_claims.js'`), 'utf8');
        // ★ 动态 import 的相对路径是**相对本模块文件**（tools/），不是 cwd →
        //   必须用 `pathToFileURL` 转绝对 URL，否则会去找 tools/tmp/...
        return { spec: pathToFileURL(f).href, dbDir: join(d, 'db') };
    };
    /** 建"4 done + 1 running"的父单场景，跑变异体的 converge */
    const runLiveChild = async (spec, dbDir) => {
        const m = await import(spec);
        const { db } = m.openBoard(dbDir);
        const p = m.addJob(db, { kind: 'shared', title: 'p', skill: null, args: {}, state: 'running', priority: 5 });
        for (let i = 0; i < 4; i++) m.addJob(db, { kind: 'personal', title: 'k', skill: 'collect', args: {}, state: 'done', parentId: p.id, priority: 5 });
        m.addJob(db, { kind: 'personal', title: 'k', skill: 'collect', args: {}, state: 'running', parentId: p.id, priority: 5 });
        const out = m.convergeOrphanParents(db, {});
        return { out: out.length, parentState: m.getJob(db, p.id).state };
    };

    // A：只删 converge 的 kids.some（= 任务书指定的那个）
    const A_SRC = SRC.replace(
        'if (kids.some((c) => !terminal.has(c.state))) continue;',
        '/* MUTANT-A: 删掉"有活子单就跳过" */',
    );
    // B：A + 把 rollupParent 的 allDone 改成"有子单就算全好"
    const B_SRC = A_SRC.replace(
        'const allDone = children.every((c) => c.state === JOB_STATE.DONE);',
        'const allDone = children.length > 0; /* MUTANT-B: 简化收敛判据 */',
    );
    check('⑨-0 两个变异点都在源码里（A: kids.some / B: allDone）',
        A_SRC !== SRC && B_SRC !== A_SRC, `A=${A_SRC !== SRC} B=${B_SRC !== A_SRC}`);

    try {
        const a = prep(A_SRC, 'mA');
        const ra = await runLiveChild(a.spec, a.dbDir);
        check('⑨-A 只删 `kids.some` → 父单**仍不动**（③ 不会红）⇒ 证明 rollupParent 还有第二道防线',
            ra.out === 0 && ra.parentState === 'running',
            `变异A out=${ra.out} 父=${ra.parentState}（这正是"两处各算同一件事"的反面案例：两处都在守）`);

        const b = prep(B_SRC, 'mB');
        const rb = await runLiveChild(b.spec, b.dbDir);
        check('⑨ 反向验证：连 `rollupParent` 的 allDone 一起简化 → 有活子单的父单**被收敛了**（③ 必红）',
            rb.out > 0 || rb.parentState !== 'running',
            `变异B out=${rb.out} 父=${rb.parentState}（正确实现应是 out=0 / running）`);
    } catch (e) {
        check('⑨ 能生成并加载变异体', false, String(e?.message ?? e));
    }
}

// ── ⑩ 接线守卫：`convergeOrphanParents` 必须仍在 board_server 的 scanTimer 里 ──
//    （否则"兜底"被摘掉，事件漏了就永久不一致 —— 这正是第 59 跑的病根）
{
    const SRV = readFileSync('src/agent/library/board_server.js', 'utf8');
    const calls = /convergeOrphanParents\s*\(/.test(SRV);
    check('⑩ board_server 仍在调用 convergeOrphanParents（scanTimer 兜底没被摘掉）', calls, `found=${calls}`);
    // 敏感性：内存里把这个调用删掉 → 守卫必须报红
    const broken = SRV.replace(/convergeOrphanParents\s*\(/g, 'noSuchFn(');
    check('⑩-b 反向验证：内存里摘掉该调用 → 守卫报红（⑩ 会红）',
        /convergeOrphanParents\s*\(/.test(broken) === false, `mutantFound=${/convergeOrphanParents\s*\(/.test(broken)}`);
}

// 清理临时库（不留垃圾）
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
