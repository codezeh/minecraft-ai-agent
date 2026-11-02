/**
 * M9 idle_planner 单测（08 §6.1）—— 锁"空闲三条定义"和"三层顺序"。
 */
import { isIdle, planNeeds, decideIdle, IDLE } from '../src/agent/library/idle_planner.js';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

// ① 空闲三条定义：少一条都不算空闲
{
    const cases = [
        [{ now: 1e6, lastTalkAt: 0 }, true, 'idle', '什么都没发生'],
        [{ now: 1e6, jobBusy: true }, false, 'job-busy', '有任务单'],
        [{ now: 1e6, reflectionBusy: true }, false, 'reflection-busy', '反射在跑'],
        [{ now: 1e6, lastTalkAt: 1e6 - IDLE.QUIET_MS + 1000 }, false, 'recently-talked', '刚说过话(29s)'],
        [{ now: 1e6, lastTalkAt: 1e6 - IDLE.QUIET_MS - 1000 }, true, 'idle', '过了 30 秒'],
        [{ now: 1e6, paused: true }, false, 'player-paused', '玩家 !stop/!stay 之后'],
    ];
    const wrong = cases.filter(([s, idle, why]) => {
        const r = isIdle(s);
        return r.idle !== idle || (why && r.reason !== why);
    });
    if (wrong.length === 0) ok('① 空闲 = 无单 + 无反射 + 30 秒没人说话（三条各自能拦）', `${cases.length} 组`);
    else bad('① 空闲定义', wrong.map(([s, i]) => ({ s, i })));
}

// ② 第 1 层顺序（08 §6.1 表里那一行的顺序：背包满 → 缺工具 → 天黑没地方 → 食物少）
{
    const order = [
        [{ inventoryFull: true, hasBasicTool: false, foodCount: 0 }, 'store'],
        [{ hasBasicTool: false, foodCount: 0 }, 'obtain'],
        [{ nightFalling: true, nearShelter: false, foodCount: 0 }, 'shelter'],
        [{ foodCount: 2 }, 'food'],
    ];
    const wrong = order.filter(([s, skill]) => planNeeds(s)?.skill !== skill);
    if (wrong.length === 0) ok('② 第 1 层按 08 §6.1 的顺序补短板', `${order.length} 步`);
    else bad('② 第 1 层顺序', wrong.map(([s]) => planNeeds(s)));
}

// ③ 第 1 层：没有短板 → null（不硬塞活）
{
    const r = planNeeds({ hasBasicTool: true, foodCount: 10, nightFalling: false, inventoryFull: false });
    if (r === null) ok('③ 没短板 → 不派活（null）', 'null');
    else bad('③ 没短板', r);
}

// ④ 自己找的单：source='self' 且优先级 ≤2（08 §6.1）
{
    const r = decideIdle({ now: 1e6, hasBasicTool: false, availableSkills: ['obtain'] });
    const j = r.job;
    if (r.action === 'job' && j?.source === 'self' && Number(j.priority) <= IDLE.SELF_PRIORITY_MAX) {
        ok('④ 自己找的单 source=self、priority ≤2（玩家一命令就让路）', `priority=${j.priority}`);
    } else bad('④ 自己找的单', r);
}

// ⑤ 流程没写好就**跳过**（不硬塞），落到下一层
{
    const noSkill = decideIdle({ now: 1e6, hasBasicTool: false, availableSkills: [] });
    if (noSkill.action !== 'job') ok('⑤ 第 1 层流程没写好 → 跳过（不硬塞）', noSkill.action);
    else bad('⑤ 该跳过', noSkill);
}

// ⑥ 第 2 层节流：thinkEveryMs 内只问一次模型
{
    const fresh = decideIdle({ now: 1e6, lastThinkAt: 1e6 - 1000, availableSkills: [] });
    const due = decideIdle({ now: 1e6, lastThinkAt: 1e6 - IDLE.THINK_EVERY_MS - 1, availableSkills: [] });
    if (fresh.action !== 'think' && due.action === 'think') {
        ok('⑥ 第 2 层按 thinkEveryMs 节流（5 分钟一次）', `${IDLE.THINK_EVERY_MS}ms`);
    } else bad('⑥ 第 2 层节流', { fresh: fresh.action, due: due.action });
}

// ⑦ 有 !goal 时第 2 层不叫模型（交给 self_prompter）
{
    const r = decideIdle({ now: 1e6, lastThinkAt: 0, hasGoal: true, availableSkills: [] });
    if (r.action !== 'think') ok('⑦ 有 !goal → 第 2 层不叫模型（交给 self_prompter）', r.action);
    else bad('⑦ 有 goal 时不该 think', r);
}

// ⑧ 有单/反射/刚说话 → 三层都不做
{
    const cases = [
        { now: 1e6, jobBusy: true },
        { now: 1e6, reflectionBusy: true },
        { now: 1e6, lastTalkAt: 1e6 - 1000 },
        { now: 1e6, paused: true },
    ];
    const wrong = cases.filter((s) => decideIdle({ ...s, availableSkills: ['obtain'], hasBasicTool: false }).action !== 'nothing');
    if (wrong.length === 0) ok('⑧ 不空闲时三层都不做（nothing）', `${cases.length} 组`);
    else bad('⑧ 不空闲', wrong);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
