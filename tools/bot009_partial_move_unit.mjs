/**
 * BOT-009（2026-11-06 深度检查）—— 箱子搬运部分成功后异常，返回零进度并漏记共享库存。
 *
 * 缺陷原貌（`act_container.deposit/withdraw` ← `flow_store.store/fetch`）：
 *   mineflayer 的 `win.deposit` 是"逐次点击"实现的（lib/plugins/inventory.js 的
 *   transferOne 递归），箱子中途满 / 窗口被关 / 交易被拒时**前面的点击已经搬进去了**。
 *   而动作层直接 `return fail('INTERNAL')`（连 stored 都不带），流程又把
 *   `r.data.stored ?? 0` 一律当 0 → 实际存进去的几件既没进共享库存（rememberChest 只在
 *   ok 分支调用），也没进返回账本，上层按零进度重试 → **重复搬运**。
 *   报告复现：请求存 10、实际进箱 3（背包 10→7），完整流程返回 INTERNAL/stored:0。
 *
 * 修法（报告给的最小修复）：
 *   · catch 里**重新核对本次背包/容器差值**，返回真实 partial；
 *   · destination full 映射为 INVENTORY_FULL；
 *   · 流程按剩余数量换箱，并**累计**已搬数量、逐箱记账。
 *
 * 全部离线：假窗口 / 假 bot，不连服务器。
 */
import Vec3 from 'vec3';
import { deposit, withdraw } from '../src/agent/library/act_container.js';
import { store, fetch } from '../src/agent/library/flow_store.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/**
 * 造一个 bot + 若干个箱子。
 *
 * @param {object} opts
 *   chests        箱子位置数组（默认 1 个）
 *   inChest       初始箱内存量
 *   inv          初始背包存量
 *   depositImpl(win, n, chestIndex) 自定义"点击"行为（抛错即模拟中途失败）
 */
function makeStoreBot({
    chests = 1, inChest = 0, inv = 10,
    depositImpl = null, withdrawImpl = null,
} = {}) {
    const state = { inv, chest: inChest };
    const positions = Array.from({ length: chests }, (_, i) => new Vec3(i + 1, 64, 0));
    const merged = [];                    // 记录 sharedMerge 的增量（= 共享库存记账）
    let currentChestIndex = 0;

    const makeWindow = (over = {}) => {
        const win = {
            slots: new Array(63).fill(null),
            inventoryStart: 27,
            inventoryEnd: 63,
            title: `chest-${currentChestIndex}`,
            containerItems() {
                return state.chest > 0 ? [{ name: 'stone', type: 1, count: state.chest }] : [];
            },
            // ★ 真实客户端开窗时会把玩家背包镜像进 [inventoryStart..inventoryEnd)；
            //   产品读"背包有多少"正是读这一段（act_container.invCount），不镜像就会假 NO_ITEM。
            mirror() {
                for (let i = 27; i < 63; i++) win.slots[i] = null;
                if (state.inv > 0) win.slots[27] = { name: 'stone', type: 1, count: state.inv, slot: 0 };
            },
            deposit: async (_t, _m, n) => {
                const r = over.deposit
                    ? await over.deposit(win, n, currentChestIndex, state)
                    : undefined;
                win.mirror();
                return r;
            },
            withdraw: async (_t, _m, n) => {
                const r = over.withdraw
                    ? await over.withdraw(win, n, currentChestIndex, state)
                    : undefined;
                win.mirror();
                return r;
            },
        };
        win.mirror();
        return win;
    };

    const bot = {
        username: 'audit',
        interrupt_code: null,
        entity: { position: new Vec3(0, 64, 0), height: 1.8 },
        registry: {
            blocksByName: { chest: { id: 54 } },
            itemsByName: { stone: { id: 1 } },
        },
        inventory: { items: () => (state.inv > 0 ? [{ name: 'stone', type: 1, count: state.inv, slot: 0 }] : []) },
        currentWindow: null,
        findBlocks: () => positions,
        blockAt: (p) => (Math.floor(p.x) >= 1 ? { name: 'chest', position: p } : { name: 'air', position: p }),
        async openContainer(target) {
            // 按坐标选箱子序号（流程是按就近顺序遍历 chestsNearby 的结果）。
            //   ★ 注意：act_container.openContainer 是把**方块对象**喂进来的（`block`），
            //   所以坐标既可能在 `target.pos`，也可能在 `target.position`。
            const wantX = Math.floor(target?.pos?.x ?? target?.position?.x ?? positions[0].x);
            const idx = positions.findIndex((q) => Math.floor(q.x) === wantX);
            currentChestIndex = idx >= 0 ? idx : 0;
            const win = makeWindow({ deposit: depositImpl, withdraw: withdrawImpl });
            bot.currentWindow = win;
            return win;
        },
        __makeWindow: (over) => makeWindow(over),
        closeWindow() { bot.currentWindow = null; },
        // 共享库存（B4）：流程记账走 board.sharedMerge
        board: {
            async sharedMerge(key, delta) { merged.push({ key, delta }); return { ok: true }; },
        },
    };
    return { bot, state, merged, positions };
}

// ══════════════════════════════════════════════════════════════════════
// ① 报告复现：动作层存 10、实际进 3 后 "destination full"
// ══════════════════════════════════════════════════════════════════════
{
    const { bot, state } = makeStoreBot({ inv: 10 });
    bot.currentWindow = bot.__makeWindow({
        deposit: async (_win, n, _idx, st) => {
            // 逐次点击：先真的搬 3 个进去，然后满
            const moved = Math.min(3, n);
            st.inv -= moved; st.chest += moved;
            throw new Error('destination full');
        },
    });
    const r = await deposit(bot, 'stone', 10);
    check('① 动作层：部分成功后抛错 → INVENTORY_FULL（不是 INTERNAL）',
        r.ok === false && r.code === 'INVENTORY_FULL', `code=${r.code} msg=${r.message}`);
    check('① 动作层：如实报已搬进度 stored=3（修复前没有 stored）',
        r.data?.stored === 3, `stored=${r.data?.stored}`);
    check('① 动作层：标了 partial 便于上层判断',
        r.data?.partial === true, `data=${JSON.stringify(r.data)}`);
    check('① 动作层：物理事实没被改写（背包 10→7、箱内 0→3）',
        state.inv === 7 && state.chest === 3, `inv=${state.inv} chest=${state.chest}`);
}

// ══════════════════════════════════════════════════════════════════════
// ② 报告复现（完整流程）：store 10 → 实际 3，返回真实进度且记账
// ══════════════════════════════════════════════════════════════════════
{
    const { bot, state, merged } = makeStoreBot({
        chests: 1, inv: 10,
        depositImpl: async (_win, n, _idx, st) => {
            const moved = Math.min(3, n);
            st.inv -= moved; st.chest += moved;
            throw new Error('destination full');
        },
    });
    const r = await store(bot, 'stone', 10);
    check('② 流程：返回 INVENTORY_FULL（修复前 INTERNAL）', r.code === 'INVENTORY_FULL', `code=${r.code}`);
    check('② 流程：stored 报真实 3（修复前 0）', r.data?.stored === 3, `stored=${r.data?.stored}`);
    check('② 流程：共享库存真的记了 +3（修复前跳过 rememberChest）',
        merged.length === 1 && merged[0].delta?.stone === 3,
        `merged=${JSON.stringify(merged)}`);
}

// ══════════════════════════════════════════════════════════════════════
// ③ 换箱继续：第一箱只收 3，第二箱收剩下 7 → 整体 ok 且累计 10
// ══════════════════════════════════════════════════════════════════════
{
    const { bot, state, merged } = makeStoreBot({
        chests: 2, inv: 10,
        depositImpl: async (_win, n, idx, st) => {
            if (idx === 0) {                       // 第一个箱子只收 3 个就满
                const moved = Math.min(3, n);
                st.inv -= moved; st.chest += moved;
                throw new Error('destination full');
            }
            // 第二个箱子收下剩余（不超过请求量）
            st.inv -= n; st.chest += n;
        },
    });
    const r = await store(bot, 'stone', 10);
    check('③ 两箱接力 → 整体 ok', r.ok === true, `code=${r.code} msg=${r.message}`);
    check('③ 累计搬了 10（不是 7 也不是 3）', r.data?.stored === 10, `stored=${r.data?.stored}`);
    check('③ 物理事实：背包空、箱内 10', state.inv === 0 && state.chest === 10,
        `inv=${state.inv} chest=${state.chest}`);
    const totalMerged = merged.reduce((a, m) => a + (m.delta?.stone ?? 0), 0);
    check('③ 记账也累计到 10（逐箱真实增量）', totalMerged === 10,
        `merges=${JSON.stringify(merged.map((m) => m.delta?.stone))}`);
}

// ══════════════════════════════════════════════════════════════════════
// ④ 取物同一坑的另一半：withdraw 部分成功后抛错也要报真实 taken
// ══════════════════════════════════════════════════════════════════════
{
    const { bot, state } = makeStoreBot({ inChest: 10, inv: 0 });
    bot.currentWindow = bot.__makeWindow({
        withdraw: async (_win, n, _idx, st) => {
            const moved = Math.min(3, n);
            st.chest -= moved; st.inv += moved;
            throw new Error('transaction rejected');
        },
    });
    const r = await withdraw(bot, 'stone', 10);
    check('④ 取物部分成功 → INVENTORY_FULL 且 taken=3（修复前 INTERNAL/0）',
        r.code === 'INVENTORY_FULL' && r.data?.taken === 3,
        `code=${r.code} taken=${r.data?.taken}`);
    check('④ 物理事实：箱 10→7、背包 0→3', state.chest === 7 && state.inv === 3,
        `chest=${state.chest} inv=${state.inv}`);
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ 一件都没搬成功 → 仍然是 INTERNAL/stored:0（不许把失败报成进度）
// ══════════════════════════════════════════════════════════════════════
{
    const { bot, state, merged } = makeStoreBot({
        inv: 10,
        depositImpl: async () => { throw new Error('window closed mid-transfer'); },
    });
    const r = await store(bot, 'stone', 10);
    check('⑤ 零进度 → 不谎报 stored', (r.data?.stored ?? 0) === 0, `stored=${r.data?.stored} code=${r.code}`);
    check('⑤ 零进度 → 不写共享库存', merged.length === 0, `merged=${JSON.stringify(merged)}`);
    check('⑤ 背包没变（物理事实）', state.inv === 10, `inv=${state.inv}`);
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ fetch 完整流程：部分取出后换箱继续，累计到目标
// ══════════════════════════════════════════════════════════════════════
{
    const { bot, state, merged } = makeStoreBot({
        chests: 2, inChest: 20, inv: 0,
        withdrawImpl: async (_win, n, idx, st) => {
            if (idx === 0) {
                const moved = Math.min(3, n);
                st.chest -= moved; st.inv += moved;
                throw new Error('transaction rejected');
            }
            st.chest -= n; st.inv += n;
        },
    });
    const r = await fetch(bot, 'stone', 10);
    check('⑥ 两箱接力取物 → 整体 ok', r.ok === true, `code=${r.code} msg=${r.message}`);
    check('⑥ 累计取到 10', r.data?.taken === 10, `taken=${r.data?.taken}`);
    check('⑥ 记的是负增量（箱子变少）',
        merged.every((m) => (m.delta?.stone ?? 0) < 0),
        `merges=${JSON.stringify(merged.map((m) => m.delta?.stone))}`);
    check('⑥ 物理事实：背包 10、箱内 10', state.inv === 10 && state.chest === 10,
        `inv=${state.inv} chest=${state.chest}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
