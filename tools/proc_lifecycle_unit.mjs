/**
 * F-EXEC-102 回归测试（2026-11-06）
 *
 * 守什么：子进程生命周期三件事都**真的**做到（不是"发个信号就算停"）：
 *   ① `stopChildAndWait` 要等 `exit` 真的发生；SIGINT 不行就 SIGKILL；强杀后仍不退要**如实上报 still-alive**
 *      （`kill()` 返回 true 只代表信号送达，不代表进程已死 —— 这是最容易被假修骗过的一步）；
 *   ② `makeParentWatcher` 在父进程消失时必须回调 `onOrphan`（**枪2：父被 SIGKILL 时唯一有效的兜底**）；
 *   ③ `isProcessAlive` 的三态：活着 / ESRCH 不存在 / EPERM（存在但没权限 ⇒ 仍算活着，不能误判成"死了"）。
 *
 * 环境说明（诚实）：本会话**不能 spawn 子进程**（`spawnSync` = EPERM），所以这里用**假 child**
 * （EventEmitter + kill 记录器）+ 短真实定时器驱动。这证明的是**决策与等待逻辑**，
 * 不等于"真机上杀进程验证过"。真机三枪（正常 shutdown / 父被 SIGKILL / Ctrl-C）见 manifest 的复现步骤。
 */
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isProcessAlive, makeParentWatcher, stopChildAndWait } from '../src/process/proc_lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 假子进程：记录 kill 的顺序；可选择"收到某信号后多久算退出"。 */
function makeFakeChild({ dieOn = 'SIGINT', dieDelayMs = 5 } = {}) {
    const child = new EventEmitter();
    child.kills = [];
    child.pid = 12345;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = (sig) => {
        child.kills.push(sig);
        child.killed = true;
        if (sig === dieOn) {
            setTimeout(() => { child.exitCode = 0; child.emit('exit', 0, null); }, dieDelayMs);
            return true;
        }
        return true;   // 信号送达但进程不退
    };
    return child;
}

// ── ① isProcessAlive 三态 ────────────────────────────────────────
{
    check('活着 → true', isProcessAlive(1234, () => { }) === true);
    const esrch = () => { const e = new Error('no'); e.code = 'ESRCH'; throw e; };
    check('ESRCH（不存在）→ false', isProcessAlive(1234, esrch) === false);
    const eperm = () => { const e = new Error('no'); e.code = 'EPERM'; throw e; };
    check('EPERM（存在但无权限）→ true（不能误判成死了）', isProcessAlive(1234, eperm) === true);
    check('非法 pid → false', isProcessAlive(0, () => { }) === false && isProcessAlive('x', () => { }) === false);
}

// ── ② 父进程消失 → onOrphan（枪2 的核心）────────────────────────
{
    let orphanCalls = 0, gotPid = null;
    const fakeTimer = { id: 1 };
    const w = makeParentWatcher({
        parentPid: 999999,
        intervalMs: 1000,
        killFn: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; },  // 父已死
        setIntervalFn: () => fakeTimer,
        clearIntervalFn: () => { },
        onOrphan: (pid) => { orphanCalls++; gotPid = pid; },
    });
    check('父已死 → onOrphan 被调用', w.checkNow() === true && orphanCalls === 1, `calls=${orphanCalls}`);
    check('onOrphan 收到父 pid', gotPid === 999999, String(gotPid));
    check('重复检查不会重复回调（幂等）', w.checkNow() === true && orphanCalls === 1, `calls=${orphanCalls}`);
}
{
    let orphanCalls = 0;
    const w = makeParentWatcher({
        parentPid: 4242,
        killFn: () => { },                       // 父还活着
        setIntervalFn: () => ({}),
        clearIntervalFn: () => { },
        onOrphan: () => { orphanCalls++; },
    });
    check('父还活着 → 不触发 onOrphan', w.checkNow() === false && orphanCalls === 0);
}
{
    let orphanCalls = 0;
    const w = makeParentWatcher({ parentPid: undefined, onOrphan: () => { orphanCalls++; } });
    check('没有 MINDSERVER_PID ⇒ 不装监视器（手动调试仍可跑）', w.checkNow() === false && orphanCalls === 0);
}

// ── ③ stopChildAndWait：等 exit / 升级强杀 / 如实上报 ─────────────
{
    const child = makeFakeChild({ dieOn: 'SIGINT' });
    const r = await stopChildAndWait(child, { graceMs: 50, killGraceMs: 50 });
    check('收到 SIGINT 就正常退出 → exited / 未升级',
        r.exited === true && r.escalated === false && r.reason === 'exited', JSON.stringify(r));
    check('第一步发的是 SIGINT', child.kills[0] === 'SIGINT', JSON.stringify(child.kills));
}
{
    // 只认 SIGKILL 的"顽固进程"
    const child = makeFakeChild({ dieOn: 'SIGKILL' });
    const r = await stopChildAndWait(child, { graceMs: 30, killGraceMs: 50 });
    check('无视 SIGINT → 升级 SIGKILL 并退出',
        r.exited === true && r.escalated === true && r.reason === 'killed', JSON.stringify(r));
    check('kill 顺序 = [SIGINT, SIGKILL]', JSON.stringify(child.kills) === '["SIGINT","SIGKILL"]', JSON.stringify(child.kills));
}
{
    // 连 SIGKILL 都不退：必须如实上报 still-alive，不能假装成功
    const child = makeFakeChild({ dieOn: 'NEVER' });
    const r = await stopChildAndWait(child, { graceMs: 20, killGraceMs: 20 });
    check('强杀后仍无 exit → 如实上报 still-alive（不假装成功）',
        r.exited === false && r.escalated === true && r.reason === 'still-alive', JSON.stringify(r));
}
{
    const r = await stopChildAndWait(null, {});
    check('没有子进程 → 立即返回 no-child', r.exited === true && r.reason === 'no-child', JSON.stringify(r));
}
{
    // 已经在退出中的 child（exitCode 有值）不该再等
    const child = makeFakeChild({ dieOn: 'NEVER' });
    child.exitCode = 0;
    const t0 = Date.now();
    const r = await stopChildAndWait(child, { graceMs: 500, killGraceMs: 500 });
    check('已退出的 child 立即返回（不白等 500ms）',
        r.exited === true && Date.now() - t0 < 100, `${Date.now() - t0}ms`);
}

// ── ④ 接线检查：这三件事必须真的被调用（防"写了没人用"）─────────────
{
    const read = (p) => readFileSync(path.join(__dirname, p), 'utf8');
    const ms = read('../src/mindcraft/mindserver.js');
    const mc = read('../src/mindcraft/mindcraft.js');
    const ap = read('../src/process/agent_process.js');
    const ia = read('../src/process/init_agent.js');

    check('mindserver 有 shutdownOnce（唯一入口）', /function shutdownOnce/.test(ms));
    check('mindserver 注册了 SIGINT/SIGTERM', /SIGINT', 'SIGTERM'/.test(ms));
    check('mindserver 的 shutdown 事件走 shutdownOnce（不再 setTimeout→exit）',
        // 实测 handler 到调用点是 227 字符（中间是解释注释），所以窗口给 400 而不是 200
        /socket\.on\('shutdown'[\s\S]{0,400}shutdownOnce\(/.test(ms));
    check('mindserver 不再有"发信号 + 2 秒后退出"的老形态', !/wait 2 seconds/.test(ms));
    check('mindcraft.shutdownAndWait 存在且调用 stopAndWait',
        /export async function shutdownAndWait/.test(mc) && /stopAndWait/.test(mc));
    check('agent_process 调 stopChildAndWait', /stopChildAndWait/.test(ap));
    check('agent_process 把 MINDSERVER_PID 传给子进程', /MINDSERVER_PID/.test(ap));
    check('init_agent 装了父进程监视器（孤儿自杀）', /makeParentWatcher\(/.test(ia));
    check('init_agent 孤儿处理里会断开 board（停续租）', /board\?\.socket\?\.disconnect/.test(ia));
}

console.log(`\n${fail ? 'FAIL' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
