/**
 * t14：furnaceLoad 的 OCCUPIED 保护 —— 独立用例（不复用 atoms 的写法）。
 *
 * 重点两个方向：
 *   A) 别人的料 → OCCUPIED 且一次都不许放料（防"又丢了保护"）
 *   B) "修过头"：同种料 / 输入槽空 / 读不到输入槽 / 槽里 count=0 / 只有燃料不同 —— 都不许误判 OCCUPIED
 *
 * 我自造的预置状态用的是**第三种物品**（raw_copper / 我放 raw_gold），
 * 与官方用例（raw_gold 占位、我放 raw_iron）不同，避免"只跑它写的用例"。
 */
import { furnaceLoad } from './src/agent/library/act_craft.js';
import Vec3 from 'vec3';

let pass = 0, fail = 0;
const chk = (name, cond, info) => {
    if (cond) { pass++; console.log(`  ✅ ${name}  ${info ?? ''}`); }
    else { fail++; console.log(`  ❌ ${name}  ${JSON.stringify(info)}`); }
};

/** 造 bot：背包里给我要的料 + 燃料；熔炉就在脚边。 */
function makeBot(items, opts = {}) {
    const log = { putInput: 0, putFuel: 0, close: 0, opened: 0 };
    const win = {
        slots: opts.slots ?? [],
        inputItem: opts.inputItem === 'throw'
            ? () => { throw new Error('stub: 读不到'); }
            : (opts.inputItem === undefined ? () => null : () => opts.inputItem),
        putInput: async () => { log.putInput++; },
        putFuel: async () => { log.putFuel++; },
        close: () => { log.close++; },
    };
    const bot = {
        username: 'probe',
        interrupt_code: null,
        entity: { position: new Vec3(0, 64, 0) },
        inventory: {
            items: () => items,
            slots: [],
            emptySlotCount: () => 10,
        },
        registry: {
            blocksByName: {}, itemsByName: {}, foodsByName: {},
            items: { coal: { id: 1 }, raw_iron: { id: 2 }, raw_gold: { id: 3 }, raw_copper: { id: 4 } },
            itemsByName_: {},
        },
        openFurnace: async () => { log.opened++; return win; },
        blockAt: () => null,
    };
    return { bot, log };
}
const furnace = { position: new Vec3(0, 64, 1), name: 'furnace' };
const MINE = [{ name: 'raw_gold', type: 3, count: 5, slot: 0 }, { name: 'coal', type: 1, count: 9, slot: 1 }];

console.log('=== A) 反向：熔炉里是别人的料（第三种物品）→ 必须 OCCUPIED 且零放料 ===');
{
    // 熔炉里炼 raw_copper（第三种），我要放 raw_gold
    const { bot, log } = makeBot(MINE, { inputItem: { name: 'raw_copper', count: 7 } });
    const r = await furnaceLoad(bot, furnace, 'raw_gold', 'coal');
    chk('raw_copper 占位 → OCCUPIED', !r.ok && r.code === 'OCCUPIED', { code: r.code });
    chk('  且 putInput/putFuel 一次都没调', log.putInput === 0 && log.putFuel === 0, log);
    chk('  报告里说清占位者与数量', r.data?.occupantNow === 'raw_copper' && r.data?.occupantCount === 7, r.data);
    chk('  开过的窗口要关掉（不占着别人的窗口）', log.close >= 1, log);
    chk('  返回是冻结 ActionResult', Object.isFrozen(r) === true, null);
}

console.log('\n=== B1) 同种料 → 正常续料（不许误判 OCCUPIED）===');
{
    const { bot, log } = makeBot(MINE, { inputItem: { name: 'raw_gold', count: 2 } });
    const r = await furnaceLoad(bot, furnace, 'raw_gold', 'coal');
    chk('同种 → ok', r.ok === true, { code: r.code, msg: r.message });
    chk('  放料 + 放燃料各 1 次', log.putInput === 1 && log.putFuel === 1, log);
}

console.log('\n=== B2) 输入槽空（inputItem() 返回 null）→ 必须放行 ===');
{
    const { bot, log } = makeBot(MINE, { inputItem: null });
    const r = await furnaceLoad(bot, furnace, 'raw_gold', 'coal');
    chk('空槽 → ok', r.ok === true, { code: r.code });
    chk('  放料 1 次', log.putInput === 1, log);
}

console.log('\n=== B3) 输入槽空 但 slots[0] 有东西 → 走 fallback 也应拦住 ===');
{
    const { bot, log } = makeBot(MINE, { inputItem: null, slots: [{ name: 'raw_copper', count: 2 }] });
    const r = await furnaceLoad(bot, furnace, 'raw_gold', 'coal');
    chk('fallback 读到 slots[0] → OCCUPIED', !r.ok && r.code === 'OCCUPIED', { code: r.code });
    chk('  零放料', log.putInput === 0, log);
}

console.log('\n=== B4) 读输入槽抛异常 → 当"没有"处理，不许崩也不许误判 ===');
{
    const { bot, log } = makeBot(MINE, { inputItem: 'throw' });
    const r = await furnaceLoad(bot, furnace, 'raw_gold', 'coal');
    chk('读不到 → 放行（ok）', r.ok === true, { code: r.code, msg: r.message });
    chk('  放料 1 次', log.putInput === 1, log);
}

console.log('\n=== B5) 槽里同种但 count=0 → 不算占位 ===');
{
    const { bot, log } = makeBot(MINE, { inputItem: { name: 'raw_gold', count: 0 } });
    const r = await furnaceLoad(bot, furnace, 'raw_gold', 'coal');
    chk('count=0 同种 → ok', r.ok === true, { code: r.code });
}

console.log('\n=== B6) 输出槽/燃料槽有别的物品，但输入槽是空的 → 不算占位 ===');
{
    const { bot, log } = makeBot(MINE, {
        inputItem: null,
        slots: [null, { name: 'charcoal', count: 3 }, { name: 'iron_ingot', count: 5 }],
    });
    const r = await furnaceLoad(bot, furnace, 'raw_gold', 'coal');
    chk('只燃料/输出有货 → 不该 OCCUPIED', r.ok === true, { code: r.code, msg: r.message });
}

console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
