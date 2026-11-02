/**
 * t31：idle_planner **假时钟**验证（verify 建议的做法）。
 *
 * 不需要真人真等 —— `decideIdle` 是纯函数、`THINK_EVERY_MS`/`QUIET_MS` 都是具名常量，
 * 直接把 `now` 往前推就能验"30 秒没人说话 → 进入闲置规划"和"有单在跑 → 不规划"。
 */
import { decideIdle, isIdle, IDLE } from '../src/agent/library/idle_planner.js';
import { SKILL_NAMES } from '../src/agent/library/composite_registry.js';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

const T0 = 1_000_000;
const skills = SKILL_NAMES;

// ① 假时钟推进：0s / 29s / 31s 三个时刻
{
    const at0 = isIdle({ now: T0, lastTalkAt: T0 });
    const at29 = isIdle({ now: T0 + 29_000, lastTalkAt: T0 });
    const at31 = isIdle({ now: T0 + 31_000, lastTalkAt: T0 });
    check('① 假时钟：刚说完(0s)/29s 不空闲，31s 才空闲（阈值 QUIET_MS=30s）',
        !at0.idle && !at29.idle && at31.idle && IDLE.QUIET_MS === 30000,
        `0s=${at0.reason} 29s=${at29.reason} 31s=${at31.reason}`);
}

// ② 30 秒没人说话 → **进入闲置规划**（真的产出动作，不是只 idle=true）
{
    const v = decideIdle({ now: T0 + 31_000, lastTalkAt: T0, availableSkills: skills });
    check('② 30 秒没人说话 → 进入闲置规划（有明确动作）', v.action !== 'nothing', `action=${v.action} reason=${v.reason}`);
}

// ③ 有单在跑 → **不规划**（即使过了 30 秒）
{
    const v = decideIdle({ now: T0 + 31_000, lastTalkAt: T0, jobBusy: true, availableSkills: skills });
    check('③ 有任务单在跑 → 不规划（nothing / job-busy）', v.action === 'nothing' && v.reason === 'job-busy',
        `action=${v.action} reason=${v.reason}`);
}

// ④ 反射在跑 → 不规划
{
    const v = decideIdle({ now: T0 + 31_000, lastTalkAt: T0, reflectionBusy: true, availableSkills: skills });
    check('④ 反射在跑 → 不规划', v.action === 'nothing' && v.reason === 'reflection-busy', v.reason);
}

// ⑤ 玩家 !stop/!stay 之后 → 不规划（直到下一条命令）
{
    const v = decideIdle({ now: T0 + 999_999, lastTalkAt: 0, paused: true, availableSkills: skills });
    check('⑤ !stop/!stay 之后 → 不规划', v.action === 'nothing' && v.reason === 'player-paused', v.reason);
}

// ⑥ 假时钟推 5 分钟 → 第 2 层"问模型"只触发一次（节流）
{
    // ★ decideIdle 是**无状态纯函数**：节流靠调用方（idleTick）把 lastThinkAt 更新成"刚才"。
    //   第一版我两次都传 lastThinkAt=T0，第二次当然又触发 —— 那是测试写错，不是节流没做。
    const first = decideIdle({ now: T0 + IDLE.THINK_EVERY_MS, lastThinkAt: T0, availableSkills: [] });
    // 模拟 idleTick 真的问完之后把 lastThinkAt 记成"刚才"
    const afterAsking = T0 + IDLE.THINK_EVERY_MS;
    const tooSoon = decideIdle({ now: afterAsking + 1000, lastThinkAt: afterAsking, availableSkills: [] });
    const fiveMinLater = decideIdle({ now: afterAsking + IDLE.THINK_EVERY_MS, lastThinkAt: afterAsking, availableSkills: [] });
    check('⑥ 假时钟：满 5 分钟才问模型；问完记时间后 1 秒再问不触发、再满 5 分钟才再问',
        first.action === 'think' && tooSoon.action !== 'think' && fiveMinLater.action === 'think',
        `满5min=${first.action} 多1s=${tooSoon.action} 再满5min=${fiveMinLater.action}`);
}

// ⑦ 第 1 层优先于第 2 层（需要 > 想做）
{
    const v = decideIdle({ now: T0 + 10 * IDLE.THINK_EVERY_MS, lastThinkAt: 0, hasBasicTool: false, availableSkills: skills });
    check('⑦ 第 1 层"需要"优先于第 2 层"想做"', v.action === 'job', `action=${v.action} skill=${v.job?.skill}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
