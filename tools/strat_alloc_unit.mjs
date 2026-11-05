/**
 * `planObtain` 的**库存池统筹分配**（t130 / `fb0a0ad`）—— 算术守卫。
 *
 * 修的 bug：**同一批库存被多个消费者各认领一遍**。
 *   `wooden_pickaxe` = 3 板 + 2 棍，而棍 = 2 板 → **共 5 板**。
 *   旧代码展开到 `oak_planks` 时，为镐算一次（need 3，have 3 → 够）、为棍再算一次
 *   （need 2，have 3 → 够）→ **同一批 3 块板被认领两遍 → 一块都不派**。
 *   修法：维护 `allocated` 账本，`have` 只能用"剩下的"。
 *
 * ★ 核心判据是**结果型**：`应补量 == 需求总量 - 手上可用`
 *   所以它不钉实现（谁改实现都得满足），也不怕 t119 的拆单合并
 *   （同一物品可能合进一张单，所以按 `skill==='craft' && args.item===X` **求和**）。
 *
 * ★ ⑦ 反向验证做法（**不碰 `src/`**）：
 *   把 `strat_obtain.js` 复制到 `tools/.tmp_mut/`、改写两处相对 import、
 *   再把账本那行改成 `alreadyAllocated = 0`（= 回到修前），import 变异体对比。
 *   —— 这是"提取/复制 + 编译/加载"的等价做法，真文件一字未改。
 *
 * ★ 哪几条不能砍（实测标注，见各条的 ）：**②③⑤**。
 *   ①④⑥ 是两种实现都对的用例（变异体也照样通过），删了不心疼；
 *   ②③⑤ 去掉账本就立刻红 —— **精简用例时只许砍 ①④⑥**。
 *
 * 输出：PASS / FAIL，全过退出码 0。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
// ★ T17：动态 import 用绝对 file:// URL（Windows 下盘符绝对路径不被 ESM 接受）
import { pathToFileURL } from 'node:url';
import { planObtain } from '../src/agent/library/strat_obtain.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/** 某物品的"要补多少"（对同物品的多张单**求和** —— t119 会合并单） */
const askedOf = (r, item) => r.plan
    .filter((p) => p.skill === 'craft' && p.args?.item === item)
    .reduce((a, p) => a + Number(p.args?.count ?? 0), 0);

const plan = (inventory, item = 'wooden_pickaxe') => planObtain({ item, count: 1, inventory, chests: {} });

// ══════════════════════════════════════════════════════════════════════════
// ①-⑥ 核心算术：wooden_pickaxe = 3 板 + 2 棍（棍=2 板）→ 共 5 板
// ══════════════════════════════════════════════════════════════════════════
const CASES = [
    { n: '①', inv: { oak_planks: 0 }, want: 5, why: '全缺' },
    // ★鉴别器（去掉账本 → 3 变 1，本条必红）
    { n: '②', inv: { oak_planks: 2 }, want: 3, why: '部分有（旧代码算 1 ← 回归杀手）' },
    // ★鉴别器（去掉账本 → 2 变 0，本条必红）
    { n: '③', inv: { oak_planks: 3 }, want: 2, why: '旧代码算 0 ← 双计最明显' },
    { n: '④', inv: { oak_planks: 5 }, want: 0, why: '刚好够' },
    // ★鉴别器（棍已经够 → 只剩 3 板要补，账本错了这条也会偏）
    { n: '⑤', inv: { oak_planks: 2, stick: 4 }, want: 1, why: '有棍了，只需 3 板 - 2' },
    { n: '⑥', inv: { oak_planks: 10 }, want: 0, why: '超量' },
];
for (const c of CASES) {
    const r = plan(c.inv);
    const got = askedOf(r, 'oak_planks');
    check(`${c.n} 背包 ${JSON.stringify(c.inv)} → 应补木板 ${c.want}（${c.why}）`,
        got === c.want, `asked=${got}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 反向验证：把 `allocated` 账本去掉（= 回到修前）→ ②③ 必须红，①④⑥ 不该红
// ══════════════════════════════════════════════════════════════════════════
// ★★★ T17（并发加固）：变异副本目录**必须每进程一份**。
//
//   原来固定写 `tools/.tmp_mut`，而 96 行收尾会 `rmSync(MUT_DIR)` ——
//   两路 `unit_all` 并行时，A 刚写完变异体、B 把它删掉，A 的 `import` 就报
//   `ENOENT: lstat ... tools\.tmp_mut\strat_obtain_mut.mjs`（随机红、单跑全绿）。
//
//   为什么**只加 pid 后缀**、不搬到 os.tmpdir()：下面把变异体的两处相对 import
//   改写成了 `../../src/...`（相对 `tools/.tmp_mut/` 算的）。挪到别处就会断，
//   而"同深度、只换名字"完全不碰那些改写 —— 最小改动、零风险。
const MUT_DIR = `tools/.tmp_mut-${process.pid}`;
const MUT_FILE = `${MUT_DIR}/strat_obtain_mut.mjs`;
let mutant = null;
try {
    const raw = readFileSync('src/agent/library/strat_obtain.js', 'utf8');
    const fixed = raw
        .replace("from '../../utils/mcdata.js'", "from '../../src/utils/mcdata.js'")
        .replace("from './contract.js'", "from '../../src/agent/library/contract.js'")
        // ★ 变异本体：账本恒 0 = 每个消费者都看到完整库存（修前行为）
        .replace(
            'const alreadyAllocated = Math.max(0, Number(allocated.get(name) ?? 0));',
            'const alreadyAllocated = 0; /* MUTANT: 去掉账本 */',
        );
    if (fixed === raw || !fixed.includes('/* MUTANT: 去掉账本 */')) throw new Error('变异没打上（源码那行变了？）');
    mkdirSync(MUT_DIR, { recursive: true });
    writeFileSync(MUT_FILE, fixed, 'utf8');
    mutant = await import(pathToFileURL(MUT_FILE).href);
} catch (e) {
    check('⑦ 能生成并加载「去掉账本」的变异副本', false, String(e?.message ?? e));
}

if (mutant?.planObtain) {
    const askMut = (inv) => askedOf(mutant.planObtain({ item: 'wooden_pickaxe', count: 1, inventory: inv, chests: {} }), 'oak_planks');
    const m2 = askMut({ oak_planks: 2 });
    const m3 = askMut({ oak_planks: 3 });
    const m1 = askMut({ oak_planks: 0 });
    const m4 = askMut({ oak_planks: 5 });
    check('⑦ 反向验证：去掉账本 → ②（2 板）变成 **1**（旧 bug，② 会红）', m2 === 1, `mutant asked=${m2}（正确=3）`);
    check('⑦ 反向验证：去掉账本 → ③（3 板）变成 **0**（旧 bug，③ 会红）', m3 === 0, `mutant asked=${m3}（正确=2）`);
    check('⑦ 对照：①（0 板）变异体仍是 5 —— 说明"① 不是鉴别器，②③ 才是"', m1 === 5, `mutant asked=${m1}`);
    check('⑦ 对照：④（5 板）变异体仍是 0 —— 同上', m4 === 0, `mutant asked=${m4}`);
    try { rmSync(MUT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 跨物品不误伤：账本不能改变别的物品的拆单
// ══════════════════════════════════════════════════════════════════════════
{
    const ct = planObtain({ item: 'crafting_table', count: 1, inventory: {}, chests: {} });
    const sp = planObtain({ item: 'stone_pickaxe', count: 1, inventory: {}, chests: {} });
    check('⑧ crafting_table 的木板数 = 4（4 板 = 1 原木）', askedOf(ct, 'oak_planks') === 4, `asked=${askedOf(ct, 'oak_planks')}`);
    check('⑧ stone_pickaxe 的木板数 = 2（2 棍 → 2 板）', askedOf(sp, 'oak_planks') === 2, `asked=${askedOf(sp, 'oak_planks')}`);
    // 顺带：两者都别因为账本而多派/少派原木
    const logsOf = (r) => r.plan.filter((p) => p.skill === 'mine' && p.args?.ore === 'oak_log').reduce((a, p) => a + Number(p.args?.count ?? 0), 0);
    check('⑧-b 原木数：crafting_table=1、stone_pickaxe=1',
        logsOf(ct) === 1 && logsOf(sp) === 1, `ct=${logsOf(ct)} sp=${logsOf(sp)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑨ 账本不能"漏账"：同一物品被 **3 个消费者**各要一次
//
//   ★ 能构造：用 `deps.sourcesOf` 注入一张合成图 —— widget 需要 a/b/c，
//     而 a/b/c 各需要 2 板 → 共 6 板（3 个消费者 × 2）。
//     若账本漏账（第二个消费者看不到第一个已划走），应补量会少于 6。
// ══════════════════════════════════════════════════════════════════════════
{
    const G = {
        widget: [{ type: 'craft', item: 'widget', recipe: { a: 1, b: 1, c: 1 }, cost: 10 }],
        a: [{ type: 'craft', item: 'a', recipe: { oak_planks: 2 }, cost: 10 }],
        b: [{ type: 'craft', item: 'b', recipe: { oak_planks: 2 }, cost: 10 }],
        c: [{ type: 'craft', item: 'c', recipe: { oak_planks: 2 }, cost: 10 }],
        oak_planks: [{ type: 'craft', item: 'oak_planks', recipe: { oak_log: 1 }, cost: 10 }],
    };
    const r = planObtain({
        item: 'widget', count: 1, inventory: {}, chests: {},
        deps: { sourcesOf: (n) => G[n] ?? [] },
    });
    check('⑨ 同一物品被 3 个消费者各要 2 → 应补合计 6（账本不漏账）',
        askedOf(r, 'oak_planks') === 6, `asked=${askedOf(r, 'oak_planks')}`);

    // 有库存时同样要按"剩余"算：给 2 板 → 应补 4
    const r2 = planObtain({
        item: 'widget', count: 1, inventory: { oak_planks: 2 }, chests: {},
        deps: { sourcesOf: (n) => G[n] ?? [] },
    });
    check('⑨-b 同上但有 2 板库存 → 应补 4（6 - 2）',
        askedOf(r2, 'oak_planks') === 4, `asked=${askedOf(r2, 'oak_planks')}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
