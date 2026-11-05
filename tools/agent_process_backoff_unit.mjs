/**
 * 第7条（自动重启）与第19条（单个 agent 退出不许拖垮整套服务）—— 离线。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 第7条 缺陷原貌（现场日志实证）：
 *   `agent_process.js` 的 `if (Date.now() - last_restart < 10000) { ...不会重启 }`
 *   → **Paper 重启要 20~60 秒**，这期间 agent 连不上、起来马上就退（< 10 秒）
 *   → 正好落在打击范围内 → 打印一句 "will not be restarted" → **agent 永久死亡且不自愈**。
 *   修法：指数退避 `min(2^n * 2s, 60s)`；只有**连续** MAX_QUICK_EXITS 次起不来才放弃。
 *
 * 第19条 缺陷原貌：
 *   `if (code > 1) { console.log('Ending task'); process.exit(code); }`
 *   触发源 `agent.js:496 cleanKill(..., 4)`（缺玩家/缺 bot）
 *   → **缺一个人就让整个 mindserver 退出**（其他 bot、面板、任务板一起没了）。
 *   修法：只摘掉**这个** agent（注销 + 从 agent_processes 删除自己），不碰进程。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS / FAIL，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import {
    AgentProcess, planExit, backoffDelayMs,
    QUICK_EXIT_MS, MAX_QUICK_EXITS, BACKOFF_MAX_MS,
} from '../src/process/agent_process.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

/** 造一个"不 spawn 真进程"的 AgentProcess（只测退出决策） */
function makeProc() {
    const p = new AgentProcess('tester', 8080);
    const timers = [];
    p._setTimeout = (fn, ms) => { const t = { fn, ms, cleared: false, unref() { } }; timers.push(t); return t; };
    p.starts = [];
    p.start = (...args) => { p.starts.push(args); p.running = true; p._spawnedAt = Date.now(); };
    p.unregistered = 0;
    p.unregister = () => { p.unregistered += 1; };
    return { p, timers };
}

// ══════════════════════════════════════════════════════════════════════════
// ① 退避序列：2s / 4s / 8s / 16s / 32s / 60s(封顶) —— 验收要的那条
// ══════════════════════════════════════════════════════════════════════════
{
    const seq = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n));
    const expect = [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000];
    const good = JSON.stringify(seq) === JSON.stringify(expect);
    if (good) okCase('★ ① 退避序列 = 2s/4s/8s/16s/32s/60s(封顶)：' + seq.map((n) => `${n / 1000}s`).join('/'),
        `cap=${BACKOFF_MAX_MS / 1000}s`);
    else badCase('① 退避序列不对', { seq, expect });
}

// ══════════════════════════════════════════════════════════════════════════
// ② ★★ 第7条核心：**连续快速退出**不再等于"永久死亡"
//    这个场景就是现场：Paper 重启 20~60 秒，agent 每次都起不到 10 秒
// ══════════════════════════════════════════════════════════════════════════
{
    const { p, timers } = makeProc();
    const plans = [];
    // 连崩 4 次（每次都"活了 3 秒"）
    for (let i = 0; i < 4; i++) {
        p._spawnedAt = Date.now() - 3000;
        plans.push(p._onChildExit(1, null));
    }
    const allRestart = plans.every((x) => x.action === 'restart');
    const delays = plans.map((x) => x.delayMs);
    const good = allRestart && JSON.stringify(delays) === JSON.stringify([2000, 4000, 8000, 16000]);
    if (good) {
        okCase('★ ② 连崩 4 次（每次活了 3 秒）→ **仍然重启**，退避 2s→4s→8s→16s（改之前第 1 次就永久放弃）',
            `delays=${delays.join(',')} quickExits=${p._quickExits}`);
    } else {
        badCase('② 快速退出被当成了"永久不重启"（第7条回归）', { plans, delays });
    }
    // 计时器真的排上了（用注入的收集器，不真等）
    const pending = timers.filter((t) => !t.cleared);
    if (pending.length === 4) okCase('②-b 每次都排了重启定时器（不是"打印一句就完事"）', `timers=${timers.length}`);
    else badCase('②-b 没有排重启定时器', { timers: timers.length });
}

// ③ 只有**连续** MAX_QUICK_EXITS 次才放弃（真正的"它起不来"）
{
    const { p } = makeProc();
    let last = null;
    for (let i = 0; i < MAX_QUICK_EXITS; i++) {
        p._spawnedAt = Date.now() - 1000;
        last = p._onChildExit(1, null);
    }
    const gaveUp = last.action === 'unregister' && p.unregistered === 1;
    // 再验一次"放弃之前一次仍然会重启"（不是提前放弃）
    const { p: p2 } = makeProc();
    let before = null;
    for (let i = 0; i < MAX_QUICK_EXITS - 1; i++) {
        p2._spawnedAt = Date.now() - 1000;
        before = p2._onChildExit(1, null);
    }
    if (gaveUp && before.action === 'restart') {
        okCase(`③ 放弃的门槛是"连续 ${MAX_QUICK_EXITS} 次"：第 ${MAX_QUICK_EXITS - 1} 次仍重启，第 ${MAX_QUICK_EXITS} 次才摘掉`,
            `giveUp=${last.action} unregister=${p.unregistered}`);
    } else {
        badCase('③ 放弃门槛不对（要么太早、要么永不放弃）', { last, before, unregistered: p.unregistered });
    }
}

// ④ 活过 10 秒后退出的 → 计数清零（下次仍从 2s 起步）
{
    const { p } = makeProc();
    p._spawnedAt = Date.now() - 1000;
    const quick = p._onChildExit(1, null);                 // 1 次快速退出
    p._spawnedAt = Date.now() - (QUICK_EXIT_MS + 5000);
    const normal = p._onChildExit(1, null);                // 活够了 → 清零
    const quickAgain = (() => { p._spawnedAt = Date.now() - 1000; return p._onChildExit(1, null); })();
    const good = quick.delayMs === 2000 && normal.delayMs === 2000
        && quickAgain.delayMs === 2000 && p._quickExits === 1;
    if (good) okCase('④ 活过 10 秒→计数清零，退避回到 2s（不会因为久远的历史一路涨到 60s）',
        `quick=${quick.delayMs} normal=${normal.delayMs} again=${quickAgain.delayMs}`);
    else badCase('④ 计数没有清零', { quick: quick.delayMs, normal: normal.delayMs, again: quickAgain.delayMs, qe: p._quickExits });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★★ 第19条：退出码 > 1 **只摘掉这个 agent**，绝不碰进程
// ══════════════════════════════════════════════════════════════════════════
{
    const { p, timers } = makeProc();
    p._spawnedAt = Date.now() - 5000;
    const plan = p._onChildExit(4, null);                  // cleanKill(..., 4) 的退出码
    const good = plan.action === 'unregister' && p.unregistered === 1
        && timers.length === 0 && p.starts.length === 0;
    if (good) {
        okCase('★ ⑤ 退出码 4（缺玩家/缺 bot）→ 只摘掉这个 agent，不重启、不退出进程',
            `action=${plan.action} unregister=${p.unregistered}`);
    } else {
        badCase('⑤ 退出码>1 没有按"只摘自己"处理', { plan, unregistered: p.unregistered, timers: timers.length });
    }
}

// ⑥ 源码守卫：agent_process.js 里**不许再出现** process.exit
{
    const src = readFileSync('src/process/agent_process.js', 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    const hasExit = /process\.exit\s*\(/.test(code);
    if (!hasExit) okCase('⑥ agent_process.js 代码里已无 process.exit（第19条的关键判据）', 'found=0');
    else badCase('⑥ 还有 process.exit —— 单个 agent 仍能拉掉整个 mindserver', { hasExit });
}

// ⑦ 正常结束 / 被人为停掉 → 不重启（保持原语义，别把 SIGINT 也当崩溃）
{
    const { p, timers } = makeProc();
    p._spawnedAt = Date.now() - 1000;
    const a = p._onChildExit(0, null);
    p._spawnedAt = Date.now() - 1000;
    const b = p._onChildExit(null, 'SIGINT');
    const good = a.action === 'none' && b.action === 'none' && timers.length === 0;
    if (good) okCase('⑦ code=0 / SIGINT → 不重启（人为停掉不许被当成崩溃）', `a=${a.action} b=${b.action}`);
    else badCase('⑦ 正常结束被当成了崩溃', { a: a.action, b: b.action, timers: timers.length });
}

// ⑧ ★ 反向：stop() 必须取消"退避中的重启"（否则用户点停，它过几秒又活过来）
{
    const { p, timers } = makeProc();
    p._spawnedAt = Date.now() - 1000;
    p._onChildExit(1, null);                               // 排在 2s 后重启
    const pending = timers[0];
    p.running = false;
    p.stop();                                              // 用户明确要停
    pending.fn();                                          // 就算定时器已经到期触发
    const good = p._stoppedByUser === true && p.starts.length === 0;
    if (good) okCase('⑧ stop() 之后即使退避定时器触发也不重启（_stoppedByUser 闸）', 'starts=0');
    else badCase('⑧ stop() 没能阻止退避重启', { stoppedByUser: p._stoppedByUser, starts: p.starts.length });
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
