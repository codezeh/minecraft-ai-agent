#!/usr/bin/env node
/**
 * t131：跨单材料预约（`item:` claim）的用例。
 *
 * 判据三件：
 *   ① 正向：`obtain wooden_pickaxe` 建出的 craft 子单**带 `item:` claim**，且材料名/数量对得上
 *   ② 反向：关掉开关（`deps.materialClaims: false`）→ **必须没有** claim（证明这些 claim 真是新代码加的）
 *   ③ 不误伤：非 craft 子单（mine/collect/fetch）**不带** item claim
 *
 * 另验：`materialClaimsForStep` 的数量口径 —— 要 3 块木板、每次产 4 → 只占 **1 个** oak_log（不是 3 个）。
 * （★ 这正是 t115 那次的单位教训：数量必须按"每次产出"折算）
 */
import { planObtain, materialClaimsForStep, MATERIAL_CLAIMS } from '../src/agent/library/strat_obtain.js';

let pass = 0, fail = 0;
const ok = (n, ev = '') => { pass++; console.log(`  PASS  ${n}${ev ? '  ' + ev : ''}`); };
const bad = (n, a) => { fail++; console.log(`  FAIL  ${n}  ${JSON.stringify(a)}`); };
const chk = (n, cond, ev, actual) => cond ? ok(n, ev) : bad(n, actual ?? ev);

/** 假 board：记录每次 add 的 job，返回递增 id。 */
function fakeBoard() {
    const added = [];
    return {
        added,
        async add(job) {
            added.push(job);
            return { ok: true, code: 'OK', message: '', data: { id: `j${added.length}`, job } };
        },
        list: () => [], get: () => null, update: () => ({ ok: true }), setAutoClaim: () => { },
    };
}

const run = async (item, count, extraDeps = {}) => {
    const board = fakeBoard();
    const agent = { name: 'testbot', bot: {}, board, inventory: { items: () => [] } };
    const r = await planObtain({ item, count, deps: {} }); // 先拿 plan（不下单）
    // 用真 obtain 路径下：直接调 obtain 需要 agent.board；这里用 strat_obtain.obtain
    const { obtain } = await import('../src/agent/library/strat_obtain.js');
    const res = await obtain(agent, item, count, { board, ...extraDeps });
    return { res, board, plan: r };
};

// ── ① 正向：wooden_pickaxe 的 craft 子单带 item claim ──────────────────
{
    chk('开关默认是开的（MATERIAL_CLAIMS === true）', MATERIAL_CLAIMS === true, `MATERIAL_CLAIMS=${MATERIAL_CLAIMS}`);
    const { board } = await run('wooden_pickaxe', 1);
    const crafts = board.added.filter((j) => j.skill === 'craft');
    const withClaims = crafts.filter((j) => Array.isArray(j.claims) && j.claims.length);
    chk('① craft 子单里至少一张带 claims', withClaims.length > 0, `craft 共 ${crafts.length} 张，带 claims 的 ${withClaims.length} 张`,
        { crafts: crafts.map((c) => ({ item: c.args?.item, claims: c.claims })) });
    const allClaimKeys = withClaims.flatMap((j) => j.claims);
    chk('① claim 的 key 形如 `item:<name>:<n>`', allClaimKeys.length > 0 && allClaimKeys.every((k) => /^item:[a-z_]+:\d+$/.test(k)),
        `keys=${JSON.stringify(allClaimKeys)}`, allClaimKeys);
    // 做木镐要木板 3 + 木棍；木板那步应占 oak_log
    const planksJob = crafts.find((j) => j.args?.item === 'oak_planks');
    // ★ 修正预期（第一版写错）：木镐要 planks 3（d2）+ 再 2（d3，给棍）→ plan 里两张
    //   craft:oak_planks 步会被 pushStep 合并成 count=5 → ceil(5/4)=**2** 个 oak_log。
    //   所以这里断言"占的是 oak_log 且数量 = ceil(count/4)"，不再硬编码 1。
    const logClaim = (planksJob?.claims ?? []).find((k) => k.startsWith('item:oak_log:'));
    const nLog = Number(String(logClaim ?? '').split(':')[2] ?? 0);
    const wantPlanks = Number(planksJob?.args?.count ?? 0);
    chk('① craft:oak_planks 占 oak_log，且数量 = ceil(需求/4)',
        !!logClaim && nLog === Math.max(1, Math.ceil(wantPlanks / 4)),
        `planks count=${wantPlanks} → 应占 ${Math.max(1, Math.ceil(wantPlanks / 4))} 个 oak_log，实际 claim=${logClaim}`,
        planksJob?.claims);
}

// ── ② 反向：关掉开关 → 必须没有任何 item claim ────────────────────────
{
    const { board } = await run('wooden_pickaxe', 1, { materialClaims: false });
    const anyItemClaim = board.added.some((j) => (j.claims ?? []).some((k) => String(k).startsWith('item:')));
    chk('② 反向：deps.materialClaims=false → 一个 item claim 都没有', !anyItemClaim,
        `全部 claims=${JSON.stringify(board.added.map((j) => j.claims))}`);
    // 再验：把 helper 的 enabled 直接关掉也返回空
    chk('② 反向：materialClaimsForStep(enabled:false) === []',
        materialClaimsForStep({ skill: 'craft', args: { item: 'oak_planks', count: 3 } }, { enabled: false }).length === 0);
}

// ── ③ 不误伤：非 craft 子单不带 item claim ────────────────────────────
{
    const { board } = await run('wooden_pickaxe', 1);
    const nonCraft = board.added.filter((j) => j.skill !== 'craft');
    const badOnes = nonCraft.filter((j) => (j.claims ?? []).some((k) => String(k).startsWith('item:')));
    chk('③ 非 craft 子单（mine/collect…）不带 item claim', badOnes.length === 0,
        `非 craft ${nonCraft.length} 张，误带 ${badOnes.length} 张`, badOnes.map((j) => j.skill));
}

// ── ④ 数量口径（t115 的单位教训）──────────────────────────────────────
{
    const needsQtyOf = new Map([['oak_planks', { oak_log: 1 }]]);
    const needsPerCraft = new Map([['oak_planks', 4]]);
    const c3 = materialClaimsForStep({ skill: 'craft', args: { item: 'oak_planks', count: 3 } }, { needsQtyOf, needsPerCraft });
    const c8 = materialClaimsForStep({ skill: 'craft', args: { item: 'oak_planks', count: 8 } }, { needsQtyOf, needsPerCraft });
    chk('④ 要 3 块板 → 占 1 个 oak_log（ceil(3/4)=1 次）', c3.includes('item:oak_log:1'), JSON.stringify(c3));
    chk('④ 要 8 块板 → 占 2 个 oak_log（ceil(8/4)=2 次）', c8.includes('item:oak_log:2'), JSON.stringify(c8));
}

console.log(`\n跨单材料预约用例：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
