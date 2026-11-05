// t66 用例：nav_core 的"单一驱动者"闸（直接测闸本身，不搭真 bot）
//
// 为什么直接测闸：`goTo` 要真 bot 才能跑通 pathfinder，太重；
// 而"同一时刻只有一个驱动者"是纯逻辑，直接测最准。
//
// 被测模块可用 NAV_CORE_MODULE 覆盖 —— 只为「反向验证」用：
// 把修复前（owner 缺省是常量 'adhoc'）的 nav_core 副本指进来，
// 第 ⑤ 条"两个无任务单的调用必须互斥"必须变红；否则它只证明了"现在不报错"。
const MODULE = process.env.NAV_CORE_MODULE ?? '../src/agent/library/nav_core.js';
const { acquireNav, navLockOwner, withNav, resolveNavOwner } = await import(MODULE);
console.log(`被测 nav_core 模块：${MODULE}`);

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, e) => { fails++; console.log(`FAIL ${n} ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ① 不同 owner 必须串行
{
    const a = await acquireNav('JOB_A');
    const aOk = !!a && navLockOwner() === 'JOB_A';

    // B 在 A 持锁期间进来 → 应该排队（等到超时，因为我们给 200ms）
    const t0 = Date.now();
    const b = await acquireNav('JOB_B', 200);
    const waited = Date.now() - t0;
    const bBlocked = b === null;                      // 等不到 → 返回 null（不是假装拿到）

    a.release();
    // A 释放后 B 应该能拿到
    const b2 = await acquireNav('JOB_B', 500);
    const b2Ok = !!b2 && navLockOwner() === 'JOB_B';
    b2?.release();

    if (aOk && bBlocked && waited >= 180 && b2Ok) {
        ok('① 不同 owner 串行：B 等到超时返回 null，A 释放后 B 能拿到',
            `B 等了 ${waited}ms，blocked=${bBlocked}`);
    } else {
        bad('① 不同 owner 应串行', { aOk, bBlocked, waited, b2Ok });
    }
}

// ② 同一 owner 可重入（流程内部连调 goTo 不该被自己挡死）
{
    const a1 = await acquireNav('JOB_SAME');
    const t0 = Date.now();
    const a2 = await acquireNav('JOB_SAME', 2000);
    const waited = Date.now() - t0;
    const reentrantOk = !!a2 && waited < 500;          // 立刻拿到，不是等满
    a2?.release();
    a1?.release();
    if (reentrantOk && navLockOwner() === null) {
        ok('② 同一 owner 可重入（立刻拿到），两层释放后闸才空', `等了 ${waited}ms`);
    } else {
        bad('② 同一 owner 应可重入', { reentrantOk, waited, owner: navLockOwner() });
    }
}

// ③ 释放不彻底 → 会挡住别人（反向验证：证明闸真的在起作用，不是摆设）
{
    const a = await acquireNav('JOB_LEAK');
    a.release();                                       // 只释放一次（正确）
    const b = await acquireNav('JOB_X', 300);
    const got = !!b;
    b?.release();
    if (got && navLockOwner() === null) ok('③ 正确释放后闸为空，别人能拿到', `owner=${navLockOwner()}`);
    else bad('③ 释放后应为空', { got, owner: navLockOwner() });
}

// ④ 反向验证：**如果不释放**，别人一定拿不到（证明闸不是空转）
{
    const a = await acquireNav('JOB_HOLD');
    const b = await acquireNav('JOB_Y', 250);
    const bBlocked = b === null;
    a.release();
    if (bBlocked) ok('④ ★ 反向验证：持锁不释放时别人拿不到（闸真的在起作用）', '确实挡住了');
    else bad('④ 闸没起作用', { bBlocked });
}

// ⑤（第9条新增）两个「没有任务单」的调用必须互斥 —— 默认 owner 不能相同
//
// 背景（报告第9条，现场日志）：nav_core 的 owner 缺省过去是**常量 'adhoc'**，
// 于是两个互不相干的 ad-hoc 调用在 acquireNav 眼里是"同一个 owner"→ 走可重入分支
// 直接放行 → 闸失效（现场每 150 行撞 2 次 `The goal was changed`）。
//
// 这里守两件事：① 两次不带任务单的 withNav 拿到的 owner **必须不同**；
//             ② 前一次还持有着，后一次就**必须拿不到**（拿到 null），而不是被当成重入。
{
    const bareBot = {};                        // 没有 __navJobId = 没有任务单
    const seenOwners = [];

    // ① owner 唯一性：两次串行调用必须落到不同的 owner
    //    （回调同步、没有要 await 的东西 → 不写 async，返回普通值即可：
    //      withNav 内部是 `await fn()`，非 Promise 也照样成立）
    await withNav(bareBot, () => { seenOwners.push(navLockOwner()); }, 1000);
    await withNav(bareBot, () => { seenOwners.push(navLockOwner()); }, 1000);
    const distinct = seenOwners.length === 2 && seenOwners[0] !== seenOwners[1];

    // ② 互斥性：A 还持锁时，B（同样无任务单）必须被挡住
    let duringOwner = null;
    const p1 = withNav(bareBot, async () => {
        duringOwner = navLockOwner();
        await sleep(400);
        return 'A';
    }, 1000);
    await sleep(60);                                   // 让 A 拿到锁
    const t0 = Date.now();
    const r2 = await withNav(bareBot, () => 'B', 250);
    const waited = Date.now() - t0;
    const r1 = await p1;
    const secondBlocked = r2 === null && waited >= 200;

    if (distinct && secondBlocked && r1 === 'A') {
        ok('⑤ ★ 两个无任务单的调用互斥（默认 owner 每次唯一）',
            `owner=${seenOwners[0]} / ${seenOwners[1]}；B 等 ${waited}ms 后返回 null`);
    } else {
        bad('⑤ 两个无任务单的调用应互斥（默认 owner 不能相同）',
            JSON.stringify({ distinct, seenOwners, secondBlocked, waited, r1, r2, duringOwner }));
    }
}

// ⑥（第9条新增）同一 bot 的**嵌套** withNav 必须真重入（不能自己等自己）
// 这条是给"默认 owner 唯一"打的补丁：12 处直驱点包了 withNav 之后，
// 里面还可能再走进 withNav/goTo —— 若各自生成新 owner 就会互等 20 秒。
{
    const bareBot = {};
    const inner = await withNav(bareBot, async () => {
        const outerOwner = navLockOwner();
        const r = await withNav(bareBot, () => 'inner-ok', 300);
        return { outerOwner, innerResult: r, sameOwner: navLockOwner() === outerOwner };
    }, 1000);
    if (inner?.innerResult === 'inner-ok' && inner.sameOwner && navLockOwner() === null) {
        ok('⑥ 嵌套 withNav 真重入（沿用外层 owner，不自己等自己）', `owner=${inner.outerOwner}`);
    } else {
        bad('⑥ 嵌套 withNav 应真重入', inner);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
