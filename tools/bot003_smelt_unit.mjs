/**
 * BOT-003（2026-11-06 深度检查）—— 批量熔炼只投一个燃料，且原料量不按目标限制。
 *
 * 缺陷原貌（`act_craft.furnaceLoad` ← `flow_smelt.smelt`）：
 *   流程把 `count` 丢在门外，动作层只会「有多少塞多少、燃料固定 1 份」：
 *     `putInput(..., min(have,64))` / `putFuel(..., 1)`
 *   报告复现（假炉 + 虚拟时钟）：16 原料 + 64 煤 → 只炼出 8 件、costMs=600000、
 *   剩 8 原料 / 63 煤；只要求 1 件时也会把最多 64 份原料塞进炉子。
 *
 * 修法（报告给的最小修复）：
 *   · `furnaceLoad(..., { count })` —— 装料量 = min(背包, 本次目标, 64)；
 *   · 燃料按燃烧时长配足（1 煤 = 8 个、1 木板/原木 = 1.5 个）；
 *   · 燃料不足以覆盖目标 → `flow_smelt` **早报 NO_ITEM + missing.fuel**，
 *     不再空转到 10 分钟 deadline 才说"只炼出 8/16"。
 *
 * 全部离线：假炉 + 虚拟时钟（Date.now / setTimeout 都被替换），不连服务器。
 */
import Vec3 from 'vec3';
import fs from 'node:fs';
import { smelt } from '../src/agent/library/flow_smelt.js';
import { furnaceLoad, fuelNeededFor, fuelBurnOf } from '../src/agent/library/act_craft.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/**
 * 假熔炉 bot。
 * 炉子语义照原版：1 份燃料能烧 `burnPerFuel` 个（煤 8 / 木板 1.5→按 1 个计也行，
 * 这里用"每份燃料的燃烧点数"模拟，避免小数）。
 */
function furnaceBot({
    input = 'raw_iron', haveInput = 16, fuel = 'coal', haveFuel = 64,
    occupiedBy = null, output = 'iron_ingot',
} = {}) {
    const stock = {
        [input]: haveInput,
        [fuel]: haveFuel,
        [output]: 0,
    };
    const loads = [];              // 记录每次 putInput / putFuel 的实参
    const furnaceBlock = { name: 'furnace', position: new Vec3(1, 64, 0) };
    const winState = {
        inputCount: 0,        // 炉内原料
        burnPoints: 0,        // 剩余燃烧点数（1 个物品 = 1 点）
        out: 0,               // 已烧好的产物
        occupant: occupiedBy, // 别人的料（有值 → OCCUPIED）
    };
    const burnPerFuel = fuelBurnOf(fuel);   // 煤 8 / 木板 1.5

    const bot = {
        interrupt_code: null,
        entity: { position: new Vec3(0, 64, 0) },
        registry: {
            blocksByName: { furnace: { id: 61 } },
            itemsByName: {
                [input]: { id: 10 }, [fuel]: { id: 11 }, [output]: { id: 12 },
            },
        },
        inventory: {
            items: () => Object.entries(stock)
                .filter(([, n]) => n > 0)
                .map(([name, count]) => ({ name, count, type: 1, slot: 0 })),
            emptySlotCount: () => 30,
        },
        findBlocks: () => [furnaceBlock.position],
        blockAt: (p) => (Math.floor(p.x) === 1 ? furnaceBlock : { name: 'air', position: p }),
        async openFurnace() {
            return {
                inputItem: () => (winState.occupant
                    ? { name: winState.occupant, count: 3 }
                    : (winState.inputCount > 0 ? { name: input, count: winState.inputCount } : null)),
                fuelItem: () => (winState.burnPoints > 0 ? { name: fuel, count: 1 } : null),
                outputItem: () => {
                    // 每被问一次就推进一个"烧炼 tick"（等价于时间流逝）
                    if (winState.inputCount > 0 && winState.burnPoints >= 1) {
                        winState.inputCount -= 1;
                        winState.burnPoints -= 1;
                        winState.out += 1;
                    }
                    return winState.out > 0 ? { name: output, count: winState.out } : null;
                },
                async putInput(_id, _meta, n) {
                    loads.push({ slot: 'input', n });
                    const moved = Math.min(n, stock[input] ?? 0);
                    stock[input] -= moved;
                    winState.inputCount += moved;
                },
                async putFuel(_id, _meta, n) {
                    loads.push({ slot: 'fuel', n });
                    const moved = Math.min(n, stock[fuel] ?? 0);
                    stock[fuel] -= moved;
                    winState.burnPoints += moved * burnPerFuel;
                },
                async takeOutput() {
                    const n = winState.out;
                    winState.out = 0;
                    stock[output] += n;
                    return { name: output, count: n };
                },
                close() { },
            };
        },
    };
    return { bot, loads, stock, winState };
}

/** 虚拟时钟：把 Date.now / setTimeout 换成"按毫秒快进"，让 10 分钟等待瞬时完成。 */
async function withVirtualClock(fn) {
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    let now = realNow();
    Date.now = () => now;
    globalThis.setTimeout = (cb, ms) => {
        now += Number(ms) || 0;
        return realSetTimeout(cb, 0);
    };
    try {
        return await fn(() => now);
    } finally {
        Date.now = realNow;
        globalThis.setTimeout = realSetTimeout;
    }
}

// ── 0. 燃烧预算表（修复前根本没有这张表）──────────────────────────────
{
    check('0 煤 = 8 个/份', fuelBurnOf('coal') === 8, `burn=${fuelBurnOf('coal')}`);
    check('0 木板/原木 = 1.5 个/份',
        fuelBurnOf('oak_planks') === 1.5 && fuelBurnOf('oak_log') === 1.5,
        `${fuelBurnOf('oak_planks')}/${fuelBurnOf('oak_log')}`);
    check('0 烧 16 个要 2 份煤', fuelNeededFor('coal', 16) === 2, `need=${fuelNeededFor('coal', 16)}`);
    check('0 烧 16 个要 11 份木板（向上取整）', fuelNeededFor('oak_planks', 16) === 11,
        `need=${fuelNeededFor('oak_planks', 16)}`);
    check('0 烧 70 个只要 1 块煤块（80 个/份）', fuelNeededFor('coal_block', 70) === 1,
        `need=${fuelNeededFor('coal_block', 70)}`);
}

// ── 1. 报告复现①：16 原料 + 64 煤，目标 16 → 必须真的炼出 16 ────────────
{
    const { bot, loads, stock } = furnaceBot({ haveInput: 16, haveFuel: 64 });
    const r = await withVirtualClock(() => smelt(bot, 'raw_iron', 16));

    const inputLoad = loads.find((l) => l.slot === 'input')?.n;
    const fuelLoad = loads.find((l) => l.slot === 'fuel')?.n;
    check('1 目标 16 时真的炼出 16（修复前只出 8）', r.ok === true && r.data?.count === 16,
        `ok=${r.ok} code=${r.code} count=${r.data?.count}`);
    check('1 装料量 = 目标 16（不是 64/16 混着来）', inputLoad === 16, `inputLoad=${inputLoad}`);
    check('1 燃料配足 2 份（1 份只够 8 个 → 修复前断火）', fuelLoad === 2, `fuelLoad=${fuelLoad}`);
    check('1 煤没被白白扣掉（64 → 62）', stock.coal === 62, `coal=${stock.coal}`);
    check('1 没有占满 10 分钟 deadline（修复前 costMs=600000）',
        (r.data?.costMs ?? Infinity) < 600000, `costMs=${r.data?.costMs}`);
}

// ── 2. 报告复现②：64 原料、只要求 1 个 → 只许装 1 个 ───────────────────
{
    const { bot, loads } = furnaceBot({ haveInput: 64, haveFuel: 8 });
    const r = await withVirtualClock(() => smelt(bot, 'raw_iron', 1));
    const inputLoad = loads.find((l) => l.slot === 'input')?.n;
    const fuelLoad = loads.find((l) => l.slot === 'fuel')?.n;
    check('2 只要求 1 个 → 炉子里只放 1 份原料（修复前放 64）', inputLoad === 1, `inputLoad=${inputLoad}`);
    check('2 燃料也只放 1 份', fuelLoad === 1, `fuelLoad=${fuelLoad}`);
    check('2 结果就是 1 个', r.ok === true && r.data?.count === 1, `count=${r.data?.count}`);
}

// ── 3. 木板烧得比煤少：16 个要 11 份木板 ──────────────────────────────
{
    const { bot, loads } = furnaceBot({ haveInput: 16, haveFuel: 20, fuel: 'oak_planks' });
    const r = await withVirtualClock(() => smelt(bot, 'raw_iron', 16));
    const fuelLoad = loads.find((l) => l.slot === 'fuel')?.n;
    check('3 木板：烧 16 个配 11 份（不是 2 份）', fuelLoad === 11, `fuelLoad=${fuelLoad}`);
    check('3 木板也能炼满 16 个', r.data?.count === 16, `count=${r.data?.count} code=${r.code}`);
}

// ── 4. 燃料不够 → 早报 NO_ITEM + missing.fuel（不再空转到 deadline）────
{
    const { bot, loads } = furnaceBot({ haveInput: 16, haveFuel: 1 });   // 1 煤只够 8 个
    const t0 = Date.now();
    const r = await withVirtualClock(() => smelt(bot, 'raw_iron', 16));
    check('4 燃料不够 → NO_ITEM（不进入烧炼等待）', !r.ok && r.code === 'NO_ITEM',
        `code=${r.code} msg=${r.message}`);
    check('4 带 missing.fuel = 缺口 1', r.data?.missing?.fuel === 1, `missing=${JSON.stringify(r.data?.missing)}`);
    check('4 一份料都没往炉子里放（不浪费非目标资源）', loads.length === 0, `loads=${JSON.stringify(loads)}`);
    check('4 立刻返回（虚拟时钟没被推进太久）', Date.now() - t0 < 1000, `wallMs=${Date.now() - t0}`);
}

// ── 5. 炉内有别人的料 → OCCUPIED，且一次都不放料（不得抢用）────────────
{
    const { bot, loads } = furnaceBot({ haveInput: 16, haveFuel: 16, occupiedBy: 'raw_gold' });
    const r = await withVirtualClock(() => smelt(bot, 'raw_iron', 4));
    check('5 炉里在炼别人的东西 → OCCUPIED', !r.ok && r.code === 'OCCUPIED', `code=${r.code}`);
    check('5 OCCUPIED 时一份料都没放', loads.length === 0, `loads=${JSON.stringify(loads)}`);
}

// ── 6. 动作层直调：count 传下去才算数（不传保持老行为）────────────────
{
    const block = { name: 'furnace', position: new Vec3(1, 64, 0) };
    // 不传 count：仍然"有多少放多少"（向后兼容）
    {
        const { bot, loads } = furnaceBot({ haveInput: 64, haveFuel: 8 });
        const r = await furnaceLoad(bot, block, 'raw_iron', 'coal');
        const inputLoad = loads.find((l) => l.slot === 'input')?.n;
        check('6 不传 count → 保持老语义（有多少放多少，上限 64）',
            r.ok && inputLoad === 64, `inputLoad=${inputLoad} code=${r.code}`);
    }
    // 传 count=5：只放 5 份，燃料按 5 个配 1 份
    {
        const { bot, loads } = furnaceBot({ haveInput: 64, haveFuel: 8 });
        const r = await furnaceLoad(bot, block, 'raw_iron', 'coal', { count: 5 });
        const inputLoad = loads.find((l) => l.slot === 'input')?.n;
        const fuelLoad = loads.find((l) => l.slot === 'fuel')?.n;
        check('6 传 count=5 → 只放 5 份原料', r.ok && inputLoad === 5, `inputLoad=${inputLoad}`);
        check('6 传 count=5 → 燃料 1 份（5 个 ≤ 8/份）', fuelLoad === 1, `fuelLoad=${fuelLoad}`);
        check('6 返回值如实带出装料量/燃料量',
            r.data?.inputCount === 5 && r.data?.fuelCount === 1,
            `data=${JSON.stringify({ i: r.data?.inputCount, f: r.data?.fuelCount })}`);
    }
}

// ── 7. `!smeltItem`（skills.smeltItem）也必须把 num 传下去 ───────────────
//    这条路径和 flow_smelt 是**两个入口、同一套缺陷**：不传 count 时 `furnaceLoad`
//    只会"有多少塞多少 + 1 份燃料"，`!smeltItem raw_iron 16` 同样只出 8 个。
//    这里做接线断言（本仓已有先例：craft_diagnostic_reachability_unit 也断言源码接线）。
{
    const src = fs.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    check('7 skills.smeltItem 把 count=num 传给 furnaceLoad（接线）',
        /furnaceLoad\(bot,\s*furnaceBlock,\s*itemName,\s*null,\s*\{\s*count:\s*num\s*\}\)/.test(src),
        `skills.js 里${/furnaceLoad\(bot,\s*furnaceBlock,\s*itemName,\s*null,\s*\{\s*count:\s*num\s*\}\)/.test(src) ? '已' : '未'}带上 { count: num }`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
