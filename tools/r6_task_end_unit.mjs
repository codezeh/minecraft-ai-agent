/**
 * R6 ADR-0001 §10.2-3 —— 「任务**进行中**缺同伙仍会 killAll 关整机」回归（离线）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 缺陷路径（比 R6 #17 更长的一条，一期只堵了开工阶段）：
 *   `tasks.js:isDone()` 进行中发现人数不齐 → 返回 {message:'No other agents found', score:0}
 *   → `agent.checkTaskDone()` 只看返回值真假 → `this.killAll()`
 *   → `mindserver_proxy.shutdown()` → `socket.emit('shutdown')` ⇒ **整套服务退出**。
 *
 * 本用例的硬断言（禁掉修复就会红）：
 *   ① `decideTaskEnd({endReason:'teammates_missing'})` **不是** shutdown_all；
 *   ② `applyTaskEnd(fakeAgent, 缺同伙结果)` ⇒ `killAll` **0 次调用**、`cleanKill(msg, 4)` 1 次；
 *   ③ 只有「任务成功」才允许 shutdown_all（既有正常路径保住）；
 *   ④ 进行中缺同伙 ⇒ 先等（宽限内不判失败），宽限用完才 missing；
 *   ⑤ agent.js 的 checkTaskDone 里不再有 `.killAll(`，且走 applyTaskEnd（源码断言）。
 * ══════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    TASK_END, TASK_END_ACTION, TEAMMATE_STATE, SELF_DETACH_EXIT_CODE,
    decideTaskEnd, applyTaskEnd, teammateState,
} from '../src/agent/tasks/task_end_policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

let pass = 0, fail = 0;
const ok = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const bad = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };
const check = (name, cond, evidence = '', actual = null) => {
    if (cond) ok(name, evidence);
    else bad(name, actual ?? evidence);
};

/** 假 agent：只记录"谁被调了几次"。 */
function makeAgent({ cleanKillThrows = false } = {}) {
    const calls = { killAll: 0, cleanKill: [] };
    return {
        calls,
        killAll() { calls.killAll += 1; },
        cleanKill(msg, code) {
            calls.cleanKill.push({ msg, code });
            if (cleanKillThrows) throw new Error('cleanKill 内部也坏了');
        },
    };
}

// ── ① 判定：只有 success 才关整机 ────────────────────────────────
const cases = [
    [null, TASK_END_ACTION.CONTINUE],
    [false, TASK_END_ACTION.CONTINUE],
    [{ message: 'Task successful', score: 7, endReason: TASK_END.SUCCESS }, TASK_END_ACTION.SHUTDOWN_ALL],
    [{ message: 'No other agents found', score: 0, endReason: TASK_END.TEAMMATES_MISSING }, TASK_END_ACTION.DETACH_SELF],
    [{ message: 'Task timeout reached', score: 0, endReason: TASK_END.TIMEOUT }, TASK_END_ACTION.DETACH_SELF],
    // 老调用方没带 endReason（校验器直接返回）⇒ 默认局部失败，绝不允许关整机
    [{ message: 'whatever', score: 3 }, TASK_END_ACTION.DETACH_SELF],
];
for (const [result, expect] of cases) {
    const got = decideTaskEnd(result);
    check(`① decideTaskEnd(${JSON.stringify(result)}) → ${expect}`, got.action === expect, `→ ${got.action}`);
}

// ── ② 副作用：缺同伙 ⇒ killAll 一次都不许发生 ──────────────────
{
    const agent = makeAgent();
    const out = applyTaskEnd(agent, { message: 'No other agents found', score: 0, endReason: TASK_END.TEAMMATES_MISSING });
    check('★ ② 缺同伙：killAll **0 次**（禁掉修复必红）', agent.calls.killAll === 0, `→ killAll=${agent.calls.killAll}`);
    check('★ ② 缺同伙：cleanKill 1 次，且退出码 = 4（只摘自己）',
        agent.calls.cleanKill.length === 1 && agent.calls.cleanKill[0].code === SELF_DETACH_EXIT_CODE,
        `→ ${JSON.stringify(agent.calls.cleanKill)}`);
    check('② 缺同伙：日志里说清"不关整机"', /不关整机/.test(agent.calls.cleanKill[0]?.msg ?? ''), `→ ${agent.calls.cleanKill[0]?.msg}`);
    check('② 返回里 detached=true（真的走到摘自己）', out.detached === true);
}
{
    // 超时同样局部失败
    const agent = makeAgent();
    applyTaskEnd(agent, { message: 'Task timeout reached', score: 0, endReason: TASK_END.TIMEOUT });
    check('★ ② 超时：killAll 0 次、cleanKill 1 次', agent.calls.killAll === 0 && agent.calls.cleanKill.length === 1,
        `→ ${JSON.stringify(agent.calls)}`);
}
{
    // 成功仍走既有正常路径（一队人跑完 ⇒ 整套退出）
    const agent = makeAgent();
    applyTaskEnd(agent, { message: 'Task successful', score: 9, endReason: TASK_END.SUCCESS });
    check('③ 任务成功：killAll 1 次（既有正常路径不许被误伤）', agent.calls.killAll === 1 && agent.calls.cleanKill.length === 0,
        `→ ${JSON.stringify(agent.calls)}`);
}
{
    // cleanKill 自己坏了也不许把异常抛出去（退出路径不许再抛）
    const agent = makeAgent({ cleanKillThrows: true });
    let threw = false;
    try { applyTaskEnd(agent, { message: 'x', endReason: TASK_END.TEAMMATES_MISSING }); } catch { threw = true; }
    check('② cleanKill 抛错被兜住（不冒到调用方）', threw === false);
}

// ── ④ 进行中缺同伙：先等（宽限），别一发现就判死 ────────────────
{
    const graceMs = 60_000;
    const t0 = 1_000_000;
    const first = teammateState({ now: t0, elapsedSec: 31, present: 1, required: 2, missingSince: null, graceMs });
    check('★ ④ 第一次发现不齐 ⇒ waiting（并记下起始时刻，不判失败）',
        first.state === TEAMMATE_STATE.WAITING && first.missingSince === t0, `→ ${JSON.stringify(first)}`);
    const mid = teammateState({ now: t0 + graceMs - 1, elapsedSec: 91, present: 1, required: 2, missingSince: first.missingSince, graceMs });
    check('④ 宽限内 ⇒ waiting（能等/重试）', mid.state === TEAMMATE_STATE.WAITING, `→ ${JSON.stringify(mid)}`);
    const late = teammateState({ now: t0 + graceMs, elapsedSec: 91, present: 1, required: 2, missingSince: first.missingSince, graceMs });
    check('④ 宽限用完 ⇒ missing（才判失败）', late.state === TEAMMATE_STATE.MISSING, `→ ${JSON.stringify(late)}`);
    const arrived = teammateState({ now: t0 + 5_000, elapsedSec: 36, present: 2, required: 2, missingSince: first.missingSince, graceMs });
    check('④ 晚到的同伙赶上了 ⇒ present，且计时清零（不累积误判）',
        arrived.state === TEAMMATE_STATE.PRESENT && arrived.missingSince === null, `→ ${JSON.stringify(arrived)}`);
    const early = teammateState({ now: t0, elapsedSec: 5, present: 0, required: 2, missingSince: null, graceMs });
    check('④ 开局 minElapsed 内不判缺（给签到留时间）', early.state === TEAMMATE_STATE.WAITING && early.missingSince === null);
    const bigger = teammateState({ now: t0, elapsedSec: 40, present: 3, required: 2, missingSince: null, graceMs });
    check('④ 人比需要的多也算齐（原来用 !== 判，多一个人就误判不齐）', bigger.state === TEAMMATE_STATE.PRESENT);
}

// ── ⑤ 接线断言：checkTaskDone 不许再自己调 killAll ──────────────
{
    const code = fs.readFileSync(path.join(SRC, 'agent', 'agent.js'), 'utf8');
    const start = code.indexOf('async checkTaskDone()');
    // 方法体边界必须用**方法定义**那一行（`\n    killAll() {`），不能用 `killAll()`
    // —— 后者会命中方法体里的 `this.killAll();`，把断言变成"永远看不见它"的假绿。
    const endDef = code.indexOf('\n    killAll() {', start);
    const body = start >= 0 ? code.slice(start, endDef > start ? endDef : start + 1600) : '';
    check('⑤ 找到 checkTaskDone 方法体（判据有效）', start >= 0 && body.length > 50);
    check('★ ⑤ checkTaskDone 里不再有 `.killAll(`（收场交给 applyTaskEnd）',
        !/\.killAll\s*\(/.test(body), `→ ${body.slice(0, 200)}`);
    check('⑤ checkTaskDone 调用 applyTaskEnd（单一判据入口）', /applyTaskEnd\s*\(/.test(body));
}

// ── ⑥ tasks.js 的 isDone 带 endReason，且不再有裸 killAll ────────
{
    const code = fs.readFileSync(path.join(SRC, 'agent', 'tasks', 'tasks.js'), 'utf8');
    const isDoneAt = code.indexOf('isDone() {');
    const body = isDoneAt >= 0 ? code.slice(isDoneAt, isDoneAt + 2400) : '';
    check('⑥ isDone 成功/缺人/超时都带 endReason',
        /endReason:\s*TASK_END\.SUCCESS/.test(body)
        && /endReason:\s*TASK_END\.TEAMMATES_MISSING/.test(body)
        && /endReason:\s*TASK_END\.TIMEOUT/.test(body));
    const codeLines = code.split('\n')
        .map((line, i) => ({ no: i + 1, line }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    const killAllCalls = codeLines.filter(({ line }) => /\.killAll\s*\(/.test(line));
    check('★ ⑥ tasks.js 的**代码**里没有 killAll() 调用', killAllCalls.length === 0,
        killAllCalls.map((x) => `L${x.no}:${x.line.trim()}`).join(' | '));
    check('⑥ isDone 用 teammateState 判"等/缺"（不是自己再写一套）', /teammateState\s*\(/.test(body));
}

console.log('\n============================================');
console.log(fail === 0 ? `ALL PASS: ${pass} passed` : `${pass} passed, ${fail} FAILED`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
