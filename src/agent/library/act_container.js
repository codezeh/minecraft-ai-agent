/**
 * A6 容器：openContainer / closeContainer / 存取的薄封装。
 *
 * 单一副作用：打开一个容器窗口（或关掉），或者在**已经打开的**窗口里存取一样东西。
 *
 * M6（2026-11-02）补了 `deposit` / `withdraw`：02 §3 明确它们"以窗口已开为前置，**不自己开**"——
 * 开窗、存取、关窗串起来是流程 flow_store / flow_fetch 的事。所以这两个动作不调 openContainer
 * （那会变成动作调动作），只看 `bot.currentWindow`。
 *
 * 实现原则（见 原子动作规格-v2.md §5）：
 *   - 开窗动作**直接复用 mineflayer 的 bot.openContainer**，本文件只补它缺的三件：
 *     前置断言（是不是容器 / 距离）、后置校验（窗口真的开了吗）、错误码归一
 *   - 容器判定按注册表 + 名字模式，不写死长名单（版本升级会漏）
 */
import Vec3 from 'vec3';
import { ok, fail, normalizeTarget } from './contract.js';
import { blockAt, reachDistanceTo } from './query_perceive.js';
import { GOAL_LOOK_AT_DEFAULT_REACH } from '../rules/rules.runtime.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 名字 → 容器类别。用模式匹配，注册表里出现新变体也能覆盖。 */
const CONTAINER_PATTERNS = [
    { re: /^chest$|^trapped_chest$/, kind: 'chest' },
    { re: /^ender_chest$/, kind: 'ender_chest' },
    { re: /^barrel$/, kind: 'barrel' },
    { re: /^hopper$/, kind: 'hopper' },
    { re: /^dropper$/, kind: 'dropper' },
    { re: /^dispenser$/, kind: 'dispenser' },
    { re: /_shulker_box$|^shulker_box$/, kind: 'shulker' },
    { re: /^furnace$|^lit_furnace$/, kind: 'furnace' },
    { re: /^smoker$/, kind: 'smoker' },
    { re: /^blast_furnace$/, kind: 'blast_furnace' },
    { re: /^brewing_stand$/, kind: 'brewing_stand' },
    { re: /^enchanting_table$/, kind: 'enchanting_table' },
    { re: /^crafting_table$/, kind: 'crafting_table' },
    { re: /^anvil$|^chipped_anvil$|^damaged_anvil$/, kind: 'anvil' },
    { re: /^stonecutter$/, kind: 'stonecutter' },
    { re: /^smithing_table$/, kind: 'smithing_table' },
    { re: /^loom$/, kind: 'loom' },
    { re: /^cartography_table$/, kind: 'cartography_table' },
    { re: /^grindstone$/, kind: 'grindstone' },
    { re: /^lectern$/, kind: 'lectern' },
];

/**
 * 这个方块是不是容器（能开窗）。
 * @returns {string|null} kind，不是容器返回 null
 */
export function containerKindOf(bot, name) {
    const def = bot?.registry?.blocksByName?.[name];
    if (!def) return null;
    for (const p of CONTAINER_PATTERNS) {
        if (p.re.test(name)) return p.kind;
    }
    return null;
}

/** 容器自身的槽位数（不含玩家背包）。注意 window.slots 是「容器 + 背包 + 快捷栏」总和。 */
const CONTAINER_SLOTS = {
    chest: 27, trapped_chest: 27, barrel: 27, ender_chest: 27,
    hopper: 5, dropper: 9, dispenser: 9,
    furnace: 3, smoker: 3, blast_furnace: 3, brewing_stand: 5,
    enchanting_table: 2, crafting_table: 10, stonecutter: 2, smithing_table: 4,
    loom: 4, cartography_table: 3, grindstone: 3, lectern: 1,
};

/** 玩家背包 + 快捷栏固定占 36 格（27 + 9），无论容器多大。 */
const PLAYER_SLOTS = 36;

/**
 * 实际的槽位构成（实测，不是猜的）。
 *
 * 2026-10-24 测试服实测：打开 chest 后 `window.slots.length = 63`，
 * 因为它是「27 容器 + 27 背包 + 9 快捷栏」。所以不能拿 27 去断言。
 * 这里只做**如实记录 + 一致性校验**（containerSlots 必须等于 CONTAINER_SLOTS 里声明的值），
 * 不拿它当失败判据——版本差异会让总和变，但"容器部分多大"是稳定的。
 */
function slotLayout(kind, slotsLen) {
    const expected = CONTAINER_SLOTS[kind] ?? null;
    if (expected == null || slotsLen == null) return { containerSlots: null, expected: null, consistent: null };
    const containerSlots = slotsLen - PLAYER_SLOTS;
    return { containerSlots, expected, consistent: containerSlots === expected };
}

/**
 * 打开 pos 处的容器。
 *
 * @returns ActionResult，data: { containerKind, pos, slots, title }
 */
export async function openContainer(bot, pos, opts = {}) {
    const { maxReach = GOAL_LOOK_AT_DEFAULT_REACH, timeout = 4000 } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');
    const _t = normalizeTarget(pos);
    if (!_t || !_t.pos) return fail('NO_TARGET', '目标位置无效');
    pos = _t.pos;

    const v = pos instanceof Vec3
        ? new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
        : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));

    // ---- 前置断言 ----
    const block = blockAt(bot, v);
    if (!block) return fail('NO_TARGET', '那个位置没有方块');

    const kind = containerKindOf(bot, block.name);
    if (!kind) return fail('NO_TARGET', `${block.name} 不是容器`, { block: block.name });

    const dist = reachDistanceTo(bot, v);
    if (dist > maxReach) {
        return fail('OUT_OF_REACH', `够不着，眼睛到容器 ${dist.toFixed(1)} 格`,
            { distEyeToBlock: dist, block: block.name });
    }

    // 已经开着别的窗口：先关，别叠着开（叠着开会让服务端忽略第二次 open）
    if (bot.currentWindow) {
        return fail('BLOCKED', `已经有窗口开着（${bot.currentWindow.title ?? '未命名'}），先关掉`,
            { block: block.name });
    }

    // ---- 执行（复用 mineflayer，不自己发包）----
    //
    // 两个 API 分工（实测 2026-10-24，见 mineflayer/lib/plugins/chest.js:14）：
    //   bot.openContainer 只接受白名单（箱子/漏斗/投掷器/潜影盒/末影箱），
    //     对工作台/熔炉/铁砧会抛 "containerToOpen is neither a block nor an entity"
    //   bot.openBlock 是底层通用入口，不查白名单
    // 所以：箱子类走 openContainer（它会额外校验窗口类型），其余走 openBlock。
    const USE_OPEN_CONTAINER = new Set(['chest', 'trapped_chest', 'ender_chest', 'barrel',
        'hopper', 'dropper', 'dispenser', 'shulker']);
    const t0 = Date.now();
    let win = null;
    try {
        const opener = USE_OPEN_CONTAINER.has(kind)
            ? bot.openContainer(block)
            : bot.openBlock(block);
        win = await Promise.race([
            opener,
            sleep(timeout).then(() => { throw new Error('open-timeout'); }),
        ]);
    } catch (e) {
        const msg = String(e?.message ?? e);
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { /* ignore */ }
        if (/timeout/.test(msg)) {
            return fail('TIMEOUT', `开了 ${Date.now() - t0}ms 还没开`, { block: block.name, costMs: Date.now() - t0 });
        }
        return fail('INTERNAL', msg, { error: msg, block: block.name });
    }

    // ---- 后置校验：窗口真的开了吗（读 bot 状态，不信返回值）----
    const opened = bot.currentWindow ?? win;
    if (!opened) {
        return fail('TIMEOUT', `openContainer 返回了但窗口没开`, { block: block.name, costMs: Date.now() - t0 });
    }

    const slots = opened.slots?.length ?? null;
    const layout = slotLayout(kind, slots);

    // 槽位数不判失败（版本/背包大小会变），但如实带回去：
    // consistent=false 说明「容器部分」与声明不符，值得上层或测试注意到。
    return ok({
        containerKind: kind,
        pos: { x: v.x, y: v.y, z: v.z },
        slots,
        containerSlots: layout.containerSlots,
        expectedSlots: layout.expected,
        slotConsistent: layout.consistent,
        title: opened.title ?? '',
        distEyeToBlock: dist,
        costMs: Date.now() - t0,
    });
}

/** 关掉当前窗口（幂等：没开窗也返回 ok）。 */
export function closeContainer(bot) {
    if (!bot.currentWindow) return ok({ closed: false });
    try {
        bot.closeWindow(bot.currentWindow);
        return ok({ closed: true });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e));
    }
}

/** 当前窗口里的物品快照（给上层判断"有没有我要的"）。 */
export function windowItems(bot) {
    const win = bot.currentWindow;
    if (!win) return null;
    return (win.slots || [])
        .map((it, i) => (it && it.name ? { slot: i, name: it.name, count: it.count } : null))
        .filter(Boolean);
}

// ───────────────────────────────────────────────────────────────────────────
// deposit / withdraw：在**已打开**的窗口里存取（02 §3）
// ───────────────────────────────────────────────────────────────────────────

/** 背包里有多少个某物（动作层自己算，不借道别的动作）。 */
/**
 * 玩家背包里有多少个某物。
 *
 * ★★ 与 `winCount` 同一个坑的另一半（2026-11-02 真机）：**开着容器窗口时**，
 *   `bot.inventory.items()` 读出来的可能已经混进容器格子（不同 mineflayer 版本行为不同）。
 *   实测：存了 16 个进箱子后 `bot.inventory` 仍报 16（其实背包已经空了），
 *   于是 `stored = 16-16 = 0` → 假失败。
 *
 *   做法：**窗口开着**就按官方语义从 `win.slots` 的 `inventoryStart..inventoryEnd`
 *   那一段数（那一段就是玩家背包）；窗口没开才用 `bot.inventory`。
 */
function invCount(bot, name) {
    const win = bot.currentWindow;
    if (win && Number.isFinite(win.inventoryStart) && Array.isArray(win.slots)) {
        const end = Number.isFinite(win.inventoryEnd) ? win.inventoryEnd : win.slots.length;
        return (win.slots.slice(win.inventoryStart, end) || [])
            .filter((i) => i?.name === name)
            .reduce((n, i) => n + (i.count ?? 0), 0);
    }
    return (bot.inventory?.items?.() ?? [])
        .filter((i) => i?.name === name)
        .reduce((n, i) => n + (i.count ?? 0), 0);
}

/**
 * 当前窗口**容器那一侧**有多少个某物。
 *
 * ★★ 2026-11-02 真机查明的**第三个** bug：原来用的是 `win.slots`（整个窗口 0..62），
 *   而箱子窗口的布局是 `[0..26]=箱子格子, [27..62]=玩家背包`。
 *   于是"箱子里有多少圆石"把**玩家背包里的**也数进去了 →
 *   存取之后 `stored = invBefore - invAfter` 恒为 0 或被污染 →
 *   明明搬成功了却报 `INVENTORY_FULL`（假失败）。
 *
 *   正确读法是 `win.containerItems()` —— mineflayer 专门给"容器自己的格子"的接口，
 *   不含玩家背包。用 `win.type === 'minecraft:generic_9x3'` 也能算区间，但直接用官方接口最稳。
 */
function winCount(bot, name) {
    const win = bot.currentWindow;
    if (!win) return 0;
    let list;
    try {
        // 优先官方接口：只返回容器自己的格子
        list = typeof win.containerItems === 'function' ? win.containerItems() : null;
    } catch { list = null; }
    if (!Array.isArray(list)) {
        // 退路：按 inventoryStart 切出容器区间（不含玩家背包）
        const start = Number.isFinite(win.inventoryStart) ? win.inventoryStart : 0;
        list = (win.slots || []).slice(0, start);
    }
    return list
        .filter((i) => i?.name === name)
        .reduce((n, i) => n + (i.count ?? 0), 0);
}

/**
 * 把背包里的 item 存 n 个进当前打开的容器。
 *
 * @returns ActionResult
 *   ok            → data: { item, want, stored, invBefore, invAfter, winBefore, winAfter }
 *   WINDOW_CLOSED 没有打开的窗口 —— 与 NOT_READY 的区别：这个要"先开箱"，不是"等一会"
 *   NO_ITEM       背包里没有这件东西
 *   INVENTORY_FULL 容器放不下了（存进去的比要存的少）
 */
/**
 * 等"背包/容器计数"落定（服务端回包是异步的，`await win.deposit()` 回来时**还没刷新**）。
 *
 * ★★ 这是修 `.type`→`.id` 之后暴露的**第二个** bug（2026-11-02 真机）：
 *   转移其实**成功了**（实测箱内 0→16），但紧接着读 `invCount/winCount` 拿到的是
 *   **旧值** → `stored = invBefore - invAfter = 0` → 被判成 `INVENTORY_FULL`
 *   （"没能存进去（容器可能满了）"）—— **假失败**。
 *   这正是 M6 立的那条："后置判据读的是引擎真的提供的数据吗"。
 *
 * 做法：短轮询（不睡死），一旦读到的计数符合预期就返回；超时则把最后一次读到的值返回，
 * 由调用方按**真实**读数判断（而不是按"没变"就断定失败）。
 *
 * @param {() => boolean} isSettled 判定"已经落定"的条件
 * @param {object} opts { timeoutMs=800, intervalMs=50 }
 * @returns {Promise<boolean>} 是否在超时前落定
 */
export async function waitCountsSettled(isSettled, opts = {}) {
    const { timeoutMs = 800, intervalMs = 50 } = opts;
    const t0 = Date.now();
    for (;;) {
        try { if (isSettled()) return true; } catch { /* 读不到就再等 */ }
        if (Date.now() - t0 >= timeoutMs) return false;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/**
 * 把物品名解析成**minecraft-data 的数字 id**。
 *
 * ★★ 2026-11-02 真机查明的根因（`deposit`/`withdraw` 从 B1 起就是废的）：
 *   原来这里写的是 `bot.registry?.itemsByName?.[item]?.type` —— 但 minecraft-data 的
 *   物品对象只有 `{id, name, displayName, stackSize}`，**没有 `type` 字段**
 *   → `?.type` 恒为 `undefined` → `?? null` → `win.deposit(null, null, n)`。
 *   于是 mineflayer 在 `findItemRange(..., itemType=null)` 里一个都找不到，
 *   `window.selectedItem` 一直是 null，最后撞上它内部的断言
 *   `assert.notStrictEqual(window.selectedItem.type, null)` ——
 *   报出来的错是 `Expected "actual" to be strictly unequal to: null`。
 *
 *   **注意这个错报得很误导**：字面上像是"窗口没开好"，实际是**物品 id 传成了 null**。
 *   我也是先按"窗口"方向查过（`inventoryStart` 实测是 27，完全正常）才定位到这里的。
 *
 * @returns {number|null} 数字 id；查不到返回 null（调用方必须处理，不许硬传）
 */
export function itemIdOf(bot, item) {
    const name = String(item ?? '');
    if (!name) return null;
    const byName = bot?.registry?.itemsByName?.[name];
    if (byName) {
        // 兼容两种形状：minecraft-data 用 id；个别地方暴露的是 type（旧版/别的包装）
        const id = byName.id ?? byName.type;
        if (Number.isFinite(id)) return id;
    }
    // 退路：从**背包**或**当前打开的容器**里正在显示的那个物品反查 id。
    //   （取东西时物品在容器里、不在背包里，所以窗口也要查。）
    try {
        const inv = bot?.inventory?.items?.() ?? [];
        const hitInv = inv.find((i) => i?.name === name);
        if (hitInv && Number.isFinite(hitInv.type)) return hitInv.type;
    } catch { /* ignore */ }
    try {
        const slots = bot?.currentWindow?.slots ?? [];
        const hitWin = slots.find((i) => i?.name === name);
        if (hitWin && Number.isFinite(hitWin.type)) return hitWin.type;
    } catch { /* ignore */ }
    return null;
}

/**
 * 校验"这个窗口真的可以搬东西"（M6 那条：**没开成不许当成开成了**）。
 *
 * mineflayer 的 `inventoryStart/inventoryEnd` 是它按窗口类型算出来的；
 * 为 null 说明窗口没被正确初始化。与其等它内部 assert 崩掉（报一个看不出所以然的错），
 * 不如在这里明确报错。
 *
 * @returns {{ok:true} | {ok:false, code:string, message:string}}
 */
export function assertUsableWindow(bot, win) {
    if (!win) return { ok: false, code: 'WINDOW_CLOSED', message: '没有打开的容器（先开箱）' };
    const start = win.inventoryStart;
    const end = win.inventoryEnd;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Array.isArray(win.slots)) {
        return {
            ok: false, code: 'INTERNAL',
            message: `窗口没被正确初始化（inventoryStart=${start}, inventoryEnd=${end}, `
                + `slots=${win.slots?.length ?? 'n/a'}）—— 这个容器可能不是标准箱子`,
        };
    }
    return { ok: true };
}

export async function deposit(bot, item, n = 1) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!item) return fail('NO_TARGET', '没说要存什么');
    const win = bot.currentWindow;
    if (!win) return fail('WINDOW_CLOSED', '没有打开的容器（先开箱再存）', { item });
    if (typeof win.deposit !== 'function') {
        return fail('INTERNAL', '这个窗口不支持 deposit（不是容器？）', { item });
    }
    // ★ 先确认窗口真的可用（没开成就别往下走，别让 mineflayer 内部 assert 崩）
    const usable = assertUsableWindow(bot, win);
    if (!usable.ok) return fail(usable.code, usable.message, { item });
    // ★ 物品 id 必须解析得到（原来是 `.type` → 恒 null → deposit 必然失败）
    const itemType = itemIdOf(bot, item);
    if (itemType == null) {
        return fail('NO_ITEM', `解析不出物品 id（${item} 不在注册表里？）`, { item });
    }

    const want = Math.max(1, Math.floor(Number(n) || 1));
    const invBefore = invCount(bot, item);
    if (invBefore <= 0) return fail('NO_ITEM', `背包里没有 ${item}`, { item });

    const take = Math.min(want, invBefore);
    const winBefore = winCount(bot, item);
    try {
        await win.deposit(itemType, null, take);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { item });
        return fail('INTERNAL', msg, { error: msg, item });
    }

    // ★ 先等计数落定（否则读到旧值 → 假失败）
    await waitCountsSettled(() => invCount(bot, item) < invBefore || winCount(bot, item) > winBefore);
    const invAfter = invCount(bot, item);
    const winAfter = winCount(bot, item);
    const stored = invBefore - invAfter;

    // 两边计数必须对上（存了多少，背包就少多少、箱子就多多少）
    if (stored <= 0) {
        // 一个都没动：这时候才可能是"真的满"。但要区分"到点还没刷新"——
        // 已经等过 settle，所以这里按真实读数下结论，并标 verified 便于上层判断。
        const chestGrew = winAfter > winBefore;
        return fail('INVENTORY_FULL',
            chestGrew ? `只进了 ${winAfter - winBefore} 个（背包计数没同步）` : `没能存进去（容器可能满了）`, {
                item, want, stored: 0, invBefore, invAfter, winBefore, winAfter,
                verified: chestGrew ? false : true,
            });
    }
    if (stored < take) {
        return fail('INVENTORY_FULL', `只存进去 ${stored}/${take}（容器满了）`, {
            item, want, stored, invBefore, invAfter, winBefore, winAfter,
        });
    }
    return ok({ item, want, stored, invBefore, invAfter, winBefore, winAfter });
}

/**
 * 从当前打开的容器里取 n 个 item。
 *
 * @returns ActionResult
 *   ok            → data: { item, want, taken, invBefore, invAfter, winBefore, winAfter }
 *   WINDOW_CLOSED 没有打开的窗口
 *   NO_ITEM       容器里没有这件东西
 *   INVENTORY_FULL 背包放不下（取出来的比要取的少）
 */
export async function withdraw(bot, item, n = 1) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!item) return fail('NO_TARGET', '没说要取什么');
    const win = bot.currentWindow;
    if (!win) return fail('WINDOW_CLOSED', '没有打开的容器（先开箱再取）', { item });
    if (typeof win.withdraw !== 'function') {
        return fail('INTERNAL', '这个窗口不支持 withdraw（不是容器？）', { item });
    }
    // ★ 与 deposit 同样的两道：窗口真的可用 + 物品 id 解析得到
    //   （withdraw 走的是同一套 transfer，`.type` 那个错的同一个根因）
    const usable = assertUsableWindow(bot, win);
    if (!usable.ok) return fail(usable.code, usable.message, { item });
    const itemType = itemIdOf(bot, item);
    if (itemType == null) {
        return fail('NO_ITEM', `解析不出物品 id（${item} 不在注册表里？）`, { item });
    }

    const want = Math.max(1, Math.floor(Number(n) || 1));
    const winBefore = winCount(bot, item);
    if (winBefore <= 0) return fail('NO_ITEM', `容器里没有 ${item}`, { item });

    const take = Math.min(want, winBefore);
    const invBefore = invCount(bot, item);
    try {
        await win.withdraw(itemType, null, take);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { item });
        return fail('INTERNAL', msg, { error: msg, item });
    }

    // ★ 同样先等计数落定
    await waitCountsSettled(() => winCount(bot, item) < winBefore || invCount(bot, item) > invBefore);
    const invAfter = invCount(bot, item);
    const winAfter = winCount(bot, item);
    const taken = winBefore - winAfter;

    if (taken <= 0) {
        const invGrew = invAfter > invBefore;
        return fail('INVENTORY_FULL',
            invGrew ? `只取出 ${invAfter - invBefore} 个（箱子计数没同步）` : `没能取出来（背包可能满了）`, {
                item, want, taken: 0, invBefore, invAfter, winBefore, winAfter,
                verified: invGrew ? false : true,
            });
    }
    if (taken < take) {
        return fail('INVENTORY_FULL', `只取出来 ${taken}/${take}（背包满了）`, {
            item, want, taken, invBefore, invAfter, winBefore, winAfter,
        });
    }
    return ok({ item, want, taken, invBefore, invAfter, winBefore, winAfter });
}
