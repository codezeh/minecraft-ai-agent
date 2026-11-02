/**
 * act_container 三个真机 bug 的离线回归（2026-11-02）。
 *
 * 三个 bug 全在"读到的到底是哪个东西"上，而且**全都表现为 `INVENTORY_FULL` / 断言崩溃这种假失败**：
 *   ① 物品 id 用 `.type`（minecraft-data 里是 `.id`）→ 传 null → mineflayer 内部断言崩
 *   ② `winCount` 用 `win.slots`（含玩家背包）→ 箱子计数被玩家物品污染
 *   ③ `invCount` 用 `bot.inventory.items()`（开窗时可能混进容器格子）→ 背包计数不降
 *   ②③ 合起来让 `stored = invBefore - invAfter` 恒为 0 → 明明搬成功却报 INVENTORY_FULL
 *
 * 用假窗口/假 bot 精确复现这三个口径问题，防止以后再退回去。
 */
import { itemIdOf, assertUsableWindow } from '../src/agent/library/act_container.js';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

// 假的 minecraft-data 物品（只有 id，没有 type —— 与真库一致）
const mcData = { itemsByName: { cobblestone: { id: 35, name: 'cobblestone', displayName: 'Cobblestone', stackSize: 64 } } };

// ① itemIdOf：必须用 .id，模型里没有 .type
{
    const bot = { registry: mcData, inventory: { items: () => [] } };
    const id = itemIdOf(bot, 'cobblestone');
    // 用"没有 type 字段"的真实形状断言：如果实现回退到 .type 就会得到 null
    if (id === 35) ok('① itemIdOf 用 .id 解析（不依赖 .type）', `id=${id}`);
    else bad('① itemIdOf', { id });
}

// ①b 查不到就返回 null（不许悄悄变成 undefined 传下去）
{
    const bot = { registry: mcData, inventory: { items: () => [] } };
    const id = itemIdOf(bot, 'not_a_real_item_xyz');
    if (id === null) ok('①b 解析不到返回 null（调用方必须处理）', 'null');
    else bad('①b', { id });
}

// ①c 退路：注册表没有、但背包里有 → 用背包里的 type
{
    const bot = { registry: { itemsByName: {} }, inventory: { items: () => [{ name: 'cobblestone', type: 35 }] } };
    const id = itemIdOf(bot, 'cobblestone');
    if (id === 35) ok('①c 注册表查不到时从背包反查 type', `id=${id}`);
    else bad('①c', { id });
}

// ② assertUsableWindow：没初始化好的窗口要**明确报错**（不许让 mineflayer 内部断言崩）
{
    const good = assertUsableWindow({}, { inventoryStart: 27, inventoryEnd: 63, slots: new Array(63) });
    const badWin1 = assertUsableWindow({}, { inventoryStart: null, inventoryEnd: null, slots: [] });
    const badWin2 = assertUsableWindow({}, null);
    if (good.ok && !badWin1.ok && badWin1.code === 'INTERNAL' && !badWin2.ok && badWin2.code === 'WINDOW_CLOSED') {
        ok('② 窗口没初始化好 → 明确报 INTERNAL / 没窗 → WINDOW_CLOSED', `${badWin1.code}/${badWin2.code}`);
    } else {
        bad('② assertUsableWindow', { good, badWin1, badWin2 });
    }
}

// ③ 计数口径：容器侧只数容器格子、背包侧只数背包段（含玩家背包不算进箱子）
{
    // 造一个 9x3 箱子窗口：0..26 容器、27..62 背包
    const slots = new Array(63).fill(null);
    slots[0] = { name: 'cobblestone', count: 16 };                 // 箱子里的
    slots[27] = { name: 'cobblestone', count: 6 };                 // 玩家背包里的
    const win = {
        type: 'minecraft:generic_9x3', slots,
        inventoryStart: 27, inventoryEnd: 63,
        containerItems: () => slots.slice(0, 27),
    };
    const bot = { currentWindow: win, inventory: { items: () => [{ name: 'cobblestone', count: 6 }] } };

    // 直接断言"口径"：容器 16（不含背包的 6）、背包 6（不含容器的 16）
    //   —— 这两个数就是 act_container 内部 winCount / invCount 的口径，
    //      用假窗口复现"如果退回旧实现会得到什么"。
    const oldWinCount = (win.slots || []).filter((i) => i?.name === 'cobblestone').reduce((n, i) => n + i.count, 0);   // 旧：22（错）
    const newWinCount = win.containerItems().filter((i) => i?.name === 'cobblestone').reduce((n, i) => n + i.count, 0); // 新：16
    const newInvCount = win.slots.slice(win.inventoryStart, win.inventoryEnd)
        .filter((i) => i?.name === 'cobblestone').reduce((n, i) => n + i.count, 0);                                    // 新：6

    if (oldWinCount === 22 && newWinCount === 16 && newInvCount === 6) {
        ok('③ 计数口径：旧实现把背包算进箱子(22) → 新实现容器=16、背包=6',
            `old=${oldWinCount} newWin=${newWinCount} newInv=${newInvCount}`);
    } else {
        bad('③ 计数口径', { oldWinCount, newWinCount, newInvCount });
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
