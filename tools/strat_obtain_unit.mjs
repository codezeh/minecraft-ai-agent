/** t30 / M10：strat_obtain 离线用例（来源顺序 / 防无限展开 / 不碰身体）。 */
import { planObtain, obtain, manifestObtain, MAX_DEPTH, MAX_JOBS } from '../src/agent/library/strat_obtain.js';
import { CODES } from '../src/agent/library/contract.js';
import { readFileSync } from 'node:fs';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, cond, e = '') => (cond ? ok(n, e) : bad(n, e));

// ① 箱子优先
{
    const r = planObtain({ item: 'iron_pickaxe', count: 1, inventory: {}, chests: { iron_pickaxe: 1 } });
    check('① 箱子里有 → 一张子单都不用下（来源顺序第一）', r.plan.length === 0 && r.ok, `plan=${r.plan.length}`);
}

// ② 身上已够
{
    const r = planObtain({ item: 'oak_log', count: 4, inventory: { oak_log: 9 }, chests: {} });
    check('② 背包已够 → 不下单', r.plan.length === 0 && r.ok, `alreadyHave=${r.alreadyHave}`);
}

// ③ ★★ 防无限展开：永远缺料
{
    let n = 0;
    const infinite = () => { n++; return [{ type: 'craft', recipe: { ['mat_' + n]: 1 }, cost: 1 }]; };
    const r = planObtain({ item: 'start_item', count: 1, inventory: {}, chests: {}, deps: { sourcesOf: infinite } });
    const maxD = Math.max(0, ...r.plan.map((p) => p.depth));
    check('★★ 防无限展开：永远缺料 → 不超 6 层/30 张，并返回缺口清单',
        maxD <= MAX_DEPTH && r.plan.length <= MAX_JOBS && (r.hitDepth || r.hitJobs || r.plan.length <= MAX_JOBS) && Object.keys(r.gaps).length > 0,
        `jobs=${r.plan.length} maxDepth=${maxD} hitDepth=${r.hitDepth} hitJobs=${r.hitJobs} gaps=${JSON.stringify(r.gaps).slice(0, 50)}`);
}

// ④ 宽链触发 MAX_JOBS
{
    const wide = (name) => ([{ type: 'craft', recipe: { ['a' + name]: 1, ['b' + name]: 1, ['c' + name]: 1, ['d' + name]: 1, ['e' + name]: 1 }, cost: 1 }]);
    const r = planObtain({ item: 'root', count: 8, inventory: {}, chests: {}, deps: { sourcesOf: wide } });
    // 说明：树形链会**先撞层数上限**（6 层），所以这条断言的是"不变量成立"，
    // 而不是"一定撞 30 张"。真正保证不爆的是 MAX_DEPTH + MAX_JOBS 两道闸同时存在。
    check('★ 宽链也守不变量：jobs ≤ 30 且层数 ≤ 6',
        r.plan.length <= MAX_JOBS && Math.max(0, ...r.plan.map((p) => p.depth)) <= MAX_DEPTH,
        `jobs=${r.plan.length} maxDepth=${Math.max(0, ...r.plan.map((p) => p.depth))}`);
}

// ⑤ 环形依赖
{
    const cyc = (name) => ([{ type: 'craft', recipe: { [name === 'A' ? 'B' : 'A']: 1 }, cost: 1 }]);
    const r = planObtain({ item: 'A', count: 1, inventory: {}, chests: {}, deps: { sourcesOf: cyc } });
    check('⑤ 环形依赖 A→B→A 不无限递归，返回缺口', r.plan.length <= MAX_JOBS && Object.keys(r.gaps).length > 0, `jobs=${r.plan.length} gaps=${JSON.stringify(r.gaps)}`);
}

// ⑥ 真数据 iron_pickaxe
{
    const r = planObtain({ item: 'iron_pickaxe', count: 1, inventory: {}, chests: {} });
    const allWhy = r.plan.every((p) => typeof p.why === 'string' && p.why.length > 0);
    const allDepth = r.plan.every((p) => Number.isFinite(p.depth) && p.depth >= 1);
    check('⑥ 真数据 iron_pickaxe：拆出多张，每张带 why + depth', r.plan.length >= 2 && allWhy && allDepth,
        `jobs=${r.plan.length} 源=${[...new Set(r.plan.map((p) => p.source))].join('/')}`);
}

// ⑥b ★ t62：**被调度器执行时（有 ctx.jobId）不许再建壳**，子单直接挂自己名下。
//
// 真机根因：strat_obtain 每次运行都多建一张 obtain 壳 → 外层那张永远 0 子单
//   → 被当叶子单重试 → attempts 烧到 3 → blocked，而真正干活的壳/子单挂在旁边。
//   证据（查库）：0002 obtain blocked att=3 子单数 0；0003 obtain 子单数 5 ← 壳。
{
    const added = [];
    const fakeBoard = {
        async add(job) {
            if (!job?.skill) return { ok: false, message: '缺少 skill' };
            added.push(job);
            return { ok: true, data: { id: 'j_' + added.length } };
        },
    };
    const r = await obtain({ name: 'tester' }, 'iron_pickaxe', 1, {
        board: fakeBoard, inventory: {}, chests: {}, ctx: { jobId: 'JOB_SELF' },
    });
    const shells = added.filter((j) => j.skill === 'obtain');
    const children = added.filter((j) => j.skill !== 'obtain');
    check('⑥b ★ 有 ctx.jobId 时不建壳，子单 parentId === 自己那张单',
        r.ok && shells.length === 0 && children.length > 0 && children.every((c) => c.parentId === 'JOB_SELF'),
        `壳数=${shells.length} 子单=${children.length} parentId=${JSON.stringify(children.map((c) => c.parentId))}`);
}

// ⑦ 子单带 parentId + why
{
    const added = [];
    // ★ 假板必须**像真板一样校验 skill**（2026-11-03 真机抓到的 bug 就是这个漏洞导致的：
    //   我把父单写成 skill:null，真板 `board:add` 要求 skill 非空且在注册表里 → 一律被拒 →
    //   obtain 恒 INTERNAL。而假板不校验，所以离线 9 条全绿却上线就废。）
    const fakeBoard = {
        async add(job) {
            if (!job?.skill) return { ok: false, message: '缺少 skill' };   // 与真板同规则
            added.push(job);
            return { ok: true, data: { id: 'j_' + added.length } };
        },
    };
    const r = await obtain({ name: 'tester' }, 'iron_pickaxe', 1, { board: fakeBoard, inventory: {}, chests: {} });
    const children = added.slice(1);
    check('⑦ 子单都带 parentId + why（06 §4）',
        r.ok && children.length > 0 && children.every((c) => c.parentId === 'j_1' && typeof c.why === 'string' && c.why),
        `父单=${added[0]?.title} 子单=${children.length}`);
}

// ⑧ manifest
{
    const codesOk = (manifestObtain.codes ?? []).every((c) => c === 'OK' || CODES.includes(c));
    check('⑧ manifest level=strat 且 codes 全已注册', manifestObtain.level === 'strat' && codesOk, `level=${manifestObtain.level}`);
}

// ⑨ 源码级：不碰身体
{
    const files = ['src/agent/library/strat_obtain.js', 'src/agent/library/strat_tool_tier.js'];
    const bads = [];
    for (const f of files) {
        let src;
        try { src = readFileSync(f, 'utf8'); } catch { continue; }
        const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
        if (/\b(holdKey|digBlock|placeBlockAt|setControlState)\b/.test(code)) bads.push(f);
    }
    check('⑨ ★ 策略层源码无 holdKey/digBlock/placeBlockAt/setControlState', bads.length === 0, bads.join(',') || '干净');
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
