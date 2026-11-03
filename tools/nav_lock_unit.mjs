// t66 用例：nav_core 的"单一驱动者"闸（直接测闸本身，不搭真 bot）
//
// 为什么直接测闸：`goTo` 要真 bot 才能跑通 pathfinder，太重；
// 而"同一时刻只有一个驱动者"是纯逻辑，直接测最准。
import { acquireNav, navLockOwner } from '../src/agent/library/nav_core.js';

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

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
