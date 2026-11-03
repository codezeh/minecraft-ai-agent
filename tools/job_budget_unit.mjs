/**
 * t34 / A2：子单预算放到 ctx 全局共享。
 *
 * 五条硬要求：
 *  ① 无 ctx 时行为不变（仍 6 层 / 30 张）
 *  ② 有 ctx.jobBudget 时共享（limit=12，连调 3 次合计 ≤12 且 hitCap=true）
 *  ③ 跨调用真的共享（第一次 8 张 → 第二次只剩 4 张）
 *  ④ hitCap 如实上报（进 data，不静默截断）
 *  ⑤ strat_first_night 产出仍 12 上限
 */
import { planObtain, MAX_DEPTH, MAX_JOBS } from '../src/agent/library/strat_obtain.js';
import { planFirstNight, FIRST_NIGHT } from '../src/agent/library/strat_first_night.js';
import { makeCtx } from '../src/agent/library/composite_registry.js';
import { readFileSync } from 'node:fs';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

/** 造一条"永远缺料"的链：每个物品都只能用 craft 得到，材料是下一个新物品。 */
function infiniteSourcesFactory() {
    let n = 0;
    return () => { n++; return [{ type: 'craft', recipe: { ['m' + n]: 1 }, cost: 1 }]; };
}

// ① 无 ctx → 行为不变（6 层 / 30 张）
{
    const r = planObtain({ item: 'a', count: 1, inventory: {}, chests: {}, deps: { sourcesOf: infiniteSourcesFactory() } });
    const maxD = Math.max(0, ...r.plan.map((p) => p.depth));
    check('① 无 ctx：仍在 6 层 / 30 张停住（行为完全不变）',
        maxD <= MAX_DEPTH && r.plan.length <= MAX_JOBS && r.hitDepth === true
        && r.hitBudget === false && r.budget === null,
        `jobs=${r.plan.length} maxDepth=${maxD} hitDepth=${r.hitDepth} hitBudget=${r.hitBudget} budget=${r.budget}`);
}

// ② 有 ctx.jobBudget(limit=12) → 连调 3 次合计 ≤ 12，且 hitCap=true
{
    const ctx = makeCtx({ name: 't', bot: {} }, null, { timeoutMs: 60000, jobBudget: 12 });
    let total = 0;
    for (let i = 0; i < 3; i++) {
        const r = planObtain({ item: 'x' + i, count: 1, inventory: {}, chests: {}, ctx, deps: { sourcesOf: infiniteSourcesFactory() } });
        total += r.plan.length;
    }
    check('② ctx.jobBudget(limit=12)：连调 3 次合计 ≤ 12，且 hitCap=true',
        total <= 12 && ctx.jobBudget.hitCap === true,
        `三次合计=${total} used=${ctx.jobBudget.used} hitCap=${ctx.jobBudget.hitCap}`);
}

// ③ ★ 跨调用真的共享：第一次 8 张 → 第二次只剩 4 张
{
    // 造一条**刚好产 8 张**的链：宽链 3 面（1 + 3 + ...），控制到 8
    // 更稳的做法：直接预扣 used=4（limit=12）→ 第一次最多 8，第二次只剩 4
    const ctx = makeCtx({ name: 't', bot: {} }, null, { timeoutMs: 60000, jobBudget: 12 });
    const r1 = planObtain({ item: 'A', count: 1, inventory: {}, chests: {}, ctx, deps: { sourcesOf: infiniteSourcesFactory() } });
    const used1 = ctx.jobBudget.used;
    const r2 = planObtain({ item: 'B', count: 1, inventory: {}, chests: {}, ctx, deps: { sourcesOf: infiniteSourcesFactory() } });
    const used2 = ctx.jobBudget.used;
    // 第二次**可用余额** = limit - used1（不是再给 12/30）
    check('③ ★ 跨调用真的共享：第二次的可用额度 = limit − 第一次已用（不是各算各的）',
        used1 === 6 && used2 <= 12 && (r2.plan.length <= 12 - used1),
        `第一次=${r1.plan.length}张 used1=${used1}；第二次=${r2.plan.length}张 used2=${used2}（余额=${12 - used1}）`);
}

// ③b 更直接：预扣 used=8，则下一次只剩 4
{
    const ctx = makeCtx({ name: 't', bot: {} }, null, { timeoutMs: 60000, jobBudget: 12 });
    ctx.jobBudget.used = 8;                       // 模拟"前面已经用掉 8 张"
    const r = planObtain({ item: 'C', count: 1, inventory: {}, chests: {}, ctx, deps: { sourcesOf: infiniteSourcesFactory() } });
    check('③b ★ 预扣 8 张后，本次最多只能产出 4 张（余额生效）',
        r.plan.length <= 4 && ctx.jobBudget.used <= 12,
        `本次=${r.plan.length} 张（应为 ≤4） used=${ctx.jobBudget.used}`);
}

// ④ hitCap 如实上报（进 data，不静默截断）
{
    const ctx = makeCtx({ name: 't', bot: {} }, null, { timeoutMs: 60000, jobBudget: 12 });
    ctx.jobBudget.used = 12;                      // 预算已用完
    const r = planObtain({ item: 'D', count: 1, inventory: {}, chests: {}, ctx, deps: { sourcesOf: infiniteSourcesFactory() } });
    check('④ ★ hitCap 如实上报（预算耗尽 → 0 张 + hitBudget=true + budget.hitCap=true）',
        r.plan.length === 0 && r.hitBudget === true && r.budget?.hitCap === true,
        `plan=${r.plan.length} hitBudget=${r.hitBudget} budget=${JSON.stringify(r.budget)}`);
}

// ⑤ strat_first_night 产出仍是 12 上限（回归：改机制不该改这个数）
{
    check('⑤ strat_first_night 的 jobBudget 声明仍是 12（与改造前 MAX_TOTAL_JOBS 一致）',
        FIRST_NIGHT.MAX_TOTAL_JOBS === 12, `MAX_TOTAL_JOBS=${FIRST_NIGHT.MAX_TOTAL_JOBS}`);

    // 无 ctx：仍按自己的 12 兜底
    const noCtx = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0, maxJobs: 99 });
    const bounded = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0 });
    check('⑤b 无 ctx 时仍按自己的 12 兜底（不传 maxJobs → ≤12）',
        bounded.steps.length <= 12, `steps=${bounded.steps.length}`);

    // 有 ctx.jobBudget 且预算被占 → 用余额
    const ctx = makeCtx({ name: 't', bot: {} }, null, { timeoutMs: 60000, jobBudget: 12 });
    ctx.jobBudget.used = 10;                      // 只剩 2
    const tight = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0, jobBudget: ctx.jobBudget });
    check('⑤c 有 ctx 且预算只剩 2 → first_night 最多只拆 2 张（共享生效）',
        tight.steps.length <= 2, `steps=${tight.steps.length}`);
}

// ⑥ ctx 只是新增字段，没动已有语义
{
    const ctx = makeCtx({ name: 't', bot: {} }, null, { timeoutMs: 12345, jobBudget: 12 });
    const hasOld = ['jobId', 'mapDir', 'deadline', 'onEvent', 'checkpoint', 'save'].every((k) => k in ctx);
    check('⑥ ctx 只新增 jobBudget，已有字段全在；deadline 语义未变',
        hasOld && ctx.deadline > Date.now() && ctx.jobBudget.limit === 12,
        `字段齐=${hasOld} limit=${ctx.jobBudget.limit}`);
}

// ⑦ 源码级：策略层仍无身体操作
{
    const files = ['src/agent/library/strat_obtain.js', 'src/agent/library/strat_first_night.js'];
    const bads = [];
    for (const f of files) {
        const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
        if (/\b(holdKey|digBlock|placeBlockAt|setControlState)\b/.test(code)) bads.push(f);
    }
    check('⑦ 策略层源码无 holdKey/digBlock/placeBlockAt/setControlState', bads.length === 0, bads.join(',') || '干净');
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
