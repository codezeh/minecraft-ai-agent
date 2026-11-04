/**
 * 「`craft` 失败时 `data` 必须带 `act_craft` 的完整诊断」—— 结果型守卫（t86）。
 *
 * 背景（今晚第 4 例「防护装了但没生效」）：
 *   `act_craft` 里有一整套 `diag()`（`inv`/`limit`/`limitUsed`/`requiresTable`/
 *   `tableBlockUsed`/`windowOpen`/`invBefore`/`invAfter`/`precheck`），
 *   但真机上 `craft` 失败的 `data` **只有 4 个键** `{item, want, got, missing}`
 *   —— 因为 `flow_craft` 在自己那层先 `return fail(...)` 了，**`act_craft` 从没被调用**。
 *
 * ★ 本文件同时**发现了一个未修的同类点**（如实记录）：
 *   `flow_craft` 有**两道**前置检查，`6146d22` 只拆了第二道（`:225` 附近，`if (!recipes.length)`）；
 *   **第一道（`:141-150`，"料不够"那条）仍在 return**，且它正是真机上最常见的那条失败：
 *   `fail('NO_ITEM', '料不够合 X', { item, want, got: 0, missing })` ← 就是那 4 个键。
 *   所以 ① 现在是 **XFAIL（已知 bug，带指纹）**：指纹 = 恰好 `{item,want,got,missing}` 四键。
 *
 * 输出：PASS / FAIL / XFAIL(已知bug) / XPASS(已修好)，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import mcDataFactory from 'minecraft-data';
import { craft as craftFlow } from '../src/agent/library/flow_craft.js';
import { craftOnce } from '../src/agent/library/act_craft.js';
import { makeFakeBot, assertPointLike } from './fixtures/fake_bot.mjs';

const REG = mcDataFactory('1.21.8');
const ID = (n) => REG.itemsByName[n]?.id;
const FLOW_SRC = readFileSync('src/agent/library/flow_craft.js', 'utf8');
const ACT_SRC = readFileSync('src/agent/library/act_craft.js', 'utf8');

let pass = 0, fail = 0, xfail = 0, xpass = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/** 造一个假 bot：配方由 `recipes(id, tableArg)` 决定 */
function mkBot({ recipes, findBlock = null, items = [] } = {}) {
    const slots = items.map((it, i) => ({ count: 1, slot: i, ...it }));
    return makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        items: slots,
        registry: { itemsByName: REG.itemsByName, blocksByName: REG.blocksByName },
        world: new Map(),
        unloaded: 'null',
        stubs: {
            recipesFor: (id, _meta, _n, tableArg) => (typeof recipes === 'function' ? recipes(id, tableArg) : recipes),
            findBlock: () => findBlock,
            craft: async () => { },
            blockAt: (v, dflt) => { assertPointLike(v); return typeof dflt === 'function' ? dflt(null) : null; },
        },
    });
}

/** 取某段源码（从 anchor 起 400 字符），用于源码级守卫 */
const sliceFrom = (src, anchor, len = 400) => {
    const i = src.indexOf(anchor);
    return i < 0 ? null : src.slice(i, i + len);
};

// ══════════════════════════════════════════════════════════════════════════
// ① ★ 核心：flow_craft 失败时，data 必须含 act_craft 的诊断键
// ══════════════════════════════════════════════════════════════════════════
{
    const bot = mkBot({ recipes: () => [] });
    const r = await craftFlow(bot, 'wooden_pickaxe', 1);
    const keys = Object.keys(r.data ?? {});
    const hasInv = r.data?.inv !== undefined && r.data?.inv !== null;
    const hasPrecheck = 'precheck' in (r.data ?? {});
    const legacyShape = keys.length === 4 && keys.includes('missing') && keys.includes('got');

    // ★ t126 之后：这道早退**保留**（料不够就该早停），但把诊断字段补齐了 ——
    //   所以判据是"data 够全"，不是"有没有 precheck"（precheck 只在 act_craft 那条路上有）。
    check('① flow_craft 失败时 data 里有完整诊断（inv 存在）',
        r.ok === false && hasInv, `keys=${JSON.stringify(keys)}`);
    // ★ t132 之后：`flow_craft` 里两道预检都删了，失败信息全部来自 `act_craft` 的 `diag()`。
    //   `data` 形状变成 `{item, want, inv, precheck, missing, ...}`（由 `:299` 的
    //   `{ ...r.data, ...base }` 透传）。**判据改成"含 act_craft 的 diag 标记"**，
    //   比"键数 ≥ 6"稳定（键数会随 diag 增减而变，而标记语义不变）。
    check('①-b data 含 act_craft 的 diag 标记（inv 或 precheck）—— 证明走的是下层诊断',
        hasInv || hasPrecheck, `keys=${keys.length}：${JSON.stringify(keys)}`);
    check('①-c 不再是旧形状的 4 键', !legacyShape, `legacyShape=${legacyShape} hasPrecheck=${hasPrecheck}`);
}

// ①-反向验证（源码级 + 内存变异）：两道前置检查都在 = ① 必红
{
    // ★ t132：**两道预检都删了**，`act_craft` 是"能不能合"的唯一 owner。
    //   守卫改成断言"`flow_craft` 里不再有 NO_ITEM 预检"——
    //   如果谁又把"料够不够"写回来（那是今晚反复复发的那一族），这条立刻红。
    const guard = (src) => {
        // ★ t132：`t132` 之后这一段带了大段注释，默认 400 字符窗口切不到 `needTable`，
        //   变异插入点会落在窗口外 → 反向验证会**假绿**（我第一版就踩了这个）。
        const a = sliceFrom(src, 'if (!recipes.length) {', 3000);    // 第一道（原 :141-150）
        const b = sliceFrom(src, 'if (!withTable.length) {', 400);   // 第二道（原 :225）
        const noItemPrecheck = (x) => !!x && /return fail\('NO_ITEM'/.test(x);
        return { first: noItemPrecheck(a), second: noItemPrecheck(b) };
    };
    const g = guard(FLOW_SRC);
    check('①-反向 源码：第一道预检（原 :141-150）**不再** return fail(NO_ITEM)（t132 删）',
        g.first === false, `first=${g.first}`);
    check('①-反向 源码：第二道预检（原 :225）**不再** return fail(NO_ITEM)（t123 已删）',
        g.second === false, `second=${g.second}`);

    // 反向验证：把预检写回去 → 守卫必须报红
    // ★ 关键：src/ 是 CRLF —— 用 LF 拼锚点永远匹配不到（今晚第 3 次栽在换行上）。
    const NL = String.fromCharCode(13, 10);
    const reintroduced = FLOW_SRC.replace(
        '        needTable = true;' + NL + '    }',
        "        if (!withTable.length) { return fail('NO_ITEM', 'x', {}); }" + NL + '        needTable = true;' + NL + '    }',
    );
    check('①-反向验证：把 NO_ITEM 预检写回去 → 守卫报红（① 会立刻红）',
        guard(reintroduced).first === true || guard(reintroduced).second === true,
        `mutant first=${guard(reintroduced).first} second=${guard(reintroduced).second}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ② 3×3 配方 + 4 格内无工作台 → NO_WORKSTATION（且带诊断）
// ══════════════════════════════════════════════════════════════════════════
{
    const bot = mkBot({
        recipes: (id, tableArg) => (tableArg === null ? [] : [{
            result: { id: ID('wooden_pickaxe'), count: 1 }, requiresTable: true,
            inShape: [[{ id: ID('oak_planks'), count: 3 }]],
        }]),
        findBlock: null,
    });
    const r = await craftOnce(bot, 'wooden_pickaxe', 1);
    check('② 3×3 配方 + 无工作台 → NO_WORKSTATION', r.ok === false && r.code === 'NO_WORKSTATION', `code=${r.code}`);
    check('②-b 同时带完整诊断（inv + want 在）',
        r.data?.inv !== undefined && r.data?.want !== undefined, `keys=${JSON.stringify(Object.keys(r.data ?? {}))}`);
}

// ②-反向验证（源码级 + 内存变异）
{
    const guard = (src) => {
        const t = sliceFrom(src, 'if (!tableBlock) {', 200);
        return t ? /return fail\('NO_WORKSTATION'/.test(t) : false;
    };
    const real = guard(ACT_SRC);
    const broken = ACT_SRC.replace('if (!tableBlock) {', 'if (false) {');
    check('②-反向 源码：`if (!tableBlock)` → `return fail(\'NO_WORKSTATION\')` 在', real === true, `guard=${real}`);
    check('②-反向验证：把条件改成 `if (false)` → 守卫报红（会掉到"台旁也合不出"→ NO_ITEM，② 必红）',
        guard(broken) === false, `mutantGuard=${guard(broken)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ `requiresTable && !tableBlock` → NO_WORKSTATION + reason='needs-table-but-none'
//
//   ★ **可以构造**：用"自相矛盾的配方源" —— 让 `recipesFor(id,null,1,null)`（空表查询）
//     返回一条 `requiresTable: true` 的配方 → `recipes` 非空 → 跳过找表 → `tableBlock` 仍是 null
//     → 命中 t121 那道**防御性**守卫。真 mineflayer 不会这么返回，所以生产上它是"防御"而非主路径；
//     但守卫的意义正是"配方源自相矛盾时别静默降级到 2x2"。
// ══════════════════════════════════════════════════════════════════════════
{
    const bot = mkBot({
        recipes: () => [{
            result: { id: ID('wooden_pickaxe'), count: 1 }, requiresTable: true,
            inShape: [[{ id: ID('oak_planks'), count: 3 }]],
        }],
        findBlock: null,
    });
    const r = await craftOnce(bot, 'wooden_pickaxe', 1);   // 不传 knownTable
    check('③ requiresTable 但 tableBlock 为空 → NO_WORKSTATION + reason=needs-table-but-none',
        r.ok === false && r.code === 'NO_WORKSTATION' && r.data?.reason === 'needs-table-but-none',
        `code=${r.code} reason=${r.data?.reason}`);
}

// ③-反向验证（源码级 + 内存变异）
{
    const guard = (src) => {
        const t = sliceFrom(src, 'if (requiresTable && !tableBlock) {', 260);
        return t ? /reason: 'needs-table-but-none'/.test(t) : false;
    };
    const real = guard(ACT_SRC);
    const broken = ACT_SRC.replace('if (requiresTable && !tableBlock) {', 'if (false) {');
    check('③-反向 源码：`requiresTable && !tableBlock` 守卫 + reason 都在', real === true, `guard=${real}`);
    check('③-反向验证：改成 `if (false)` → 守卫报红（会静默走到 bot.craft，③ 必红）',
        guard(broken) === false, `mutantGuard=${guard(broken)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 诊断键"名字带口径"：不许再出现 `matCounts` / `recipesForCount`（承接 t111/t112）
// ══════════════════════════════════════════════════════════════════════════
{
    const bot = mkBot({ recipes: () => [] });
    const r = await craftOnce(bot, 'wooden_pickaxe', 1);
    const d = r.data ?? {};
    check('④ act_craft 的 data 里**不存在**旧名字 matCounts / recipesForCount',
        !('matCounts' in d) && !('recipesForCount' in d), `keys=${JSON.stringify(Object.keys(d))}`);
    check('④-b 新名字在（precheck —— 名字带口径）', 'precheck' in d, `keys=${JSON.stringify(Object.keys(d))}`);
}

console.log('============================================');
console.log(`${pass} PASS / ${fail} FAIL / ${xfail} XFAIL(已知bug) / ${xpass} XPASS`);
if (xfail) console.log('注意：XFAIL 那条是已知未修点（flow_craft:141-150 第一道前置检查），已报 captain。');
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
