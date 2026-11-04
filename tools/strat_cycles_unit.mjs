#!/usr/bin/env node
/**
 * t73：`cycles` 独立诊断字段的用例。
 *
 * 目的：证明「成环」和「真缺料」是**两个出口**。
 *   - 正向：构造一个必然成环的场景 → `cycles` 有值，且 `gaps` 也保留（兼容上层）
 *   - 反向：正常链（wooden_pickaxe / stone_pickaxe / crafting_table / furnace）→ `cycles === {}`
 *           （**这条最重要** —— 否则会出现"假环警报"，比不报更坏）
 *   - 回归：第一夜四件的 `plan` 必须逐字不变
 *
 * ★ 为什么正向要自己构造环：`iron_*` 已被 t103/t104 修好，真实数据不再产生环，
 *   所以用 `deps.sourcesOf` 注入一对"互相需要"的假物品 A ⇄ B。
 */
import { planObtain } from '../src/agent/library/strat_obtain.js';

let pass = 0, fail = 0;
const ok = (name, ev = '') => { pass++; console.log(`  PASS  ${name}${ev ? '  ' + ev : ''}`); };
const bad = (name, actual) => { fail++; console.log(`  FAIL  ${name}  ${JSON.stringify(actual)}`); };
const check = (name, cond, ev, actual) => cond ? ok(name, ev) : bad(name, actual ?? ev);

// ── 正向：A ⇄ B 互相需要 → 必然成环 ──────────────────────────────────────
{
    // A 只能从 B 合成；B 只能从 A 合成。planObtain('A') 展开：
    //   A → craft{A} → 需要 B → craft{B} → 需要 A → seen 命中 → cycles
    const fakeSources = (name) => {
        if (name === 'A') return [{ type: 'craft', recipe: { B: 1 }, craftedCount: 1, cost: 1 }];
        if (name === 'B') return [{ type: 'craft', recipe: { A: 1 }, craftedCount: 1, cost: 1 }];
        return [];
    };
    const p = planObtain({ item: 'A', count: 1, deps: { sourcesOf: fakeSources } });
    const cycles = p.cycles ?? null;
    const gaps = p.gaps ?? {};
    check('① 正向：A⇄B 成环 → cycles 非空', !!cycles && Object.keys(cycles).length > 0, `cycles=${JSON.stringify(cycles)}`, cycles);
    check('① 正向：cycles 里出现了环上的物品（A 或 B）',
        !!cycles && (Object.prototype.hasOwnProperty.call(cycles, 'A') || Object.prototype.hasOwnProperty.call(cycles, 'B')),
        `cycles=${JSON.stringify(cycles)}`, cycles);
    check('① 正向：gaps **仍然保留**（兼容上层，不是替换）',
        !!gaps && Object.keys(gaps).length > 0, `gaps=${JSON.stringify(gaps)}`, gaps);
    check('① 正向：ok 为 false（成环时计划不可执行）', p.ok === false, `ok=${p.ok}`, p.ok);
}

// ── 反向：正常链不应产生任何"假环警报" ──────────────────────────────────
{
    const p = planObtain({ item: 'wooden_pickaxe', count: 1 });
    const cycles = p.cycles ?? null;
    check('② 反向：wooden_pickaxe 的 cycles 是空对象', !!cycles && Object.keys(cycles).length === 0,
        `cycles=${JSON.stringify(cycles)}`, cycles);
    check('② 反向：wooden_pickaxe 可执行（gaps 空、ok true）',
        Object.keys(p.gaps ?? {}).length === 0 && p.ok === true, `ok=${p.ok} gaps=${JSON.stringify(p.gaps)}`);
}

// ── 回归：第一夜四件 plan 逐字不变 ──────────────────────────────────────
{
    const sig = (p) => (p.plan ?? []).map((s) => `${s.depth}|${s.skill}|${s.args?.item ?? ''}|${s.args?.count ?? ''}|${s.source}`).join(';');
    // 期望值来自 t103/t104 之后的实测（captain 报告 + control 独立复验一致）
    const expect = {
        wooden_pickaxe: '1|craft|wooden_pickaxe|1|craft;2|craft|oak_planks|5|craft;3|mine||1|collect;2|craft|stick|2|craft;4|mine||1|collect',
        stone_pickaxe: '1|craft|stone_pickaxe|1|craft;2|mine||3|collect;2|craft|stick|2|craft;3|craft|oak_planks|2|craft;4|mine||1|collect',
        crafting_table: '1|craft|crafting_table|1|craft;2|craft|oak_planks|4|craft;3|mine||1|collect',
    };
    for (const [item, want] of Object.entries(expect)) {
        const got = sig(planObtain({ item, count: 1 }));
        check(`③ 回归：${item} 的 plan 逐字不变`, got === want, '', { got, want });
    }
    const furnace = planObtain({ item: 'furnace', count: 1 });
    check('③ 回归：furnace 可执行且无环',
        Object.keys(furnace.gaps ?? {}).length === 0 && Object.keys(furnace.cycles ?? {}).length === 0,
        `gaps=${JSON.stringify(furnace.gaps)} cycles=${JSON.stringify(furnace.cycles)}`);
}

// ── 语义检查：真实数据里的"真缺料"应当 cycles 空、gaps 非空 ──────────────
{
    const p = planObtain({ item: 'golden_apple', count: 1 });
    const gaps = p.gaps ?? {};
    const cycles = p.cycles ?? {};
    check('④ 语义：golden_apple 缺 apple 是**真缺料**（gaps 非空、cycles 空）',
        Object.keys(gaps).length > 0 && Object.keys(cycles).length === 0,
        `gaps=${JSON.stringify(gaps)} cycles=${JSON.stringify(cycles)}`, { gaps, cycles });
}

console.log(`\ncycles 字段用例：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
