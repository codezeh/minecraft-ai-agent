/** t30 / M10：strat_tool_tier 离线用例（不跳档 / 已够直接 ok / 三件工具）。 */
import { planToolTier, toolTier, currentTiers, tierOfItem, manifestToolTier, TOOL_KINDS } from '../src/agent/library/strat_tool_tier.js';
import { CODES } from '../src/agent/library/contract.js';
import { readFileSync } from 'node:fs';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

// ① ★ 不跳档：木镐 → 要铁，必须先石再铁
{
    const r = planToolTier({ target: 'iron', inventory: { wooden_pickaxe: 1 }, kinds: ['pickaxe'] });
    const items = r.plan.map((p) => p.item);
    check('① ★ 不跳档：木镐→铁档 必须先 stone_pickaxe 再 iron_pickaxe',
        items.length === 2 && items[0] === 'stone_pickaxe' && items[1] === 'iron_pickaxe',
        items.join(' → '));
}

// ② 已经是该档或更高 → 直接 ok（不重复做）
{
    const atIron = planToolTier({ target: 'iron', inventory: { iron_pickaxe: 1 }, kinds: ['pickaxe'] });
    const above = planToolTier({ target: 'stone', inventory: { iron_pickaxe: 1 }, kinds: ['pickaxe'] });
    check('② 已是该档 / 更高档 → 计划为空（别重复做）', atIron.plan.length === 0 && above.plan.length === 0,
        `iron→iron=${atIron.plan.length} iron→stone=${above.plan.length}`);
}

// ③ 三件工具都覆盖
{
    const r = planToolTier({ target: 'stone', inventory: {}, kinds: undefined });
    const kinds = new Set(r.plan.map((p) => p.kind));
    check('③ 三件工具（镐/斧/剑）都覆盖', TOOL_KINDS.every((k) => kinds.has(k)) && r.plan.length === 6,
        `${r.plan.length} 张：${r.plan.map((p) => p.item).join(',')}`);
}

// ④ 部分档位：只有石镐，要铁 → 只差 iron_pickaxe（不回头做石的）
{
    const r = planToolTier({ target: 'iron', inventory: { stone_pickaxe: 1 }, kinds: ['pickaxe'] });
    check('④ 已有石镐 → 只差 iron_pickaxe 一张', r.plan.length === 1 && r.plan[0].item === 'iron_pickaxe',
        r.plan.map((p) => p.item).join(','));
}

// ⑤ currentTiers 取最高档
{
    const t = currentTiers({ wooden_pickaxe: 1, stone_pickaxe: 1, iron_axe: 1 });
    check('⑤ currentTiers 取每类最高档', t.pickaxe === 2 && t.axe === 3 && t.sword === 0, JSON.stringify(t));
}

// ⑥ tierOfItem
{
    const a = tierOfItem('stone_pickaxe');
    const b = tierOfItem('diamond_sword');
    check('⑥ tierOfItem 认出三档、不认识的返回 null', a?.tier === 'stone' && a?.kind === 'pickaxe' && b === null, JSON.stringify({ a, b }));
}

// ⑦ toolTier：已够档 → ok 且不调 obtain
{
    let calls = 0;
    const r = await toolTier({}, 'iron', { inventory: { iron_pickaxe: 1, iron_axe: 1, iron_sword: 1 }, obtain: async () => { calls++; return { ok: true }; } });
    check('⑦ 已够档 → ok 且一次 obtain 都不调', r.ok && calls === 0, `calls=${calls}`);
}

// ⑧ toolTier：按顺序调 obtain（不跳档的调用顺序）
{
    const calls = [];
    const r = await toolTier({}, 'iron', {
        inventory: { wooden_pickaxe: 1 }, kinds: ['pickaxe'],
        obtain: async (_a, item) => { calls.push(item); return { ok: true }; },
    });
    check('⑧ toolTier 按 stone→iron 顺序调 obtain', r.ok && calls.join('>') === 'stone_pickaxe>iron_pickaxe', calls.join('>'));
}

// ⑨ 某一步失败 → 报失败码，不假装成功
{
    const r = await toolTier({}, 'iron', {
        inventory: {}, kinds: ['pickaxe'],
        obtain: async (_a, item) => (item === 'stone_pickaxe' ? { ok: true } : { ok: false, code: 'NO_ITEM' }),
    });
    check('⑨ 中间一步失败 → fail(NO_ITEM)，不假装成功', !r.ok && r.code === 'NO_ITEM', r.code);
}

// ⑩ manifest
{
    const codesOk = (manifestToolTier.codes ?? []).every((c) => c === 'OK' || CODES.includes(c));
    check('⑩ manifest level=strat 且 codes 全已注册', manifestToolTier.level === 'strat' && codesOk, `level=${manifestToolTier.level}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
