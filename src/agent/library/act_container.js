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
import { windowSlots } from './atom_read.js';
import { closeWindow } from './atom_input_inventory.js';
import { GOAL_LOOK_AT_DEFAULT_REACH } from '../rules/rules.runtime.js';

/**
 * 开窗操作的**代次**（BOT-006）。每次 `openContainer` 领一个新号，
 * 只有"当前这一代"才有权留下窗口 —— 见 openContainer 里的说明。
 *
 * （原来这里有一个 `sleep()` 工具函数，只被"超时 race"用过；BOT-006 把超时改成
 *   可清理的计时器之后它就没有调用方了，一并删掉，不留死代码。）
 */
const _openGen = new WeakMap();

/**
 * ★ T6：没有注入 `reserveNow` 时的**一次性**告警。
 *
 * 语义要准确：**不是**"占位成功"，而是"这次没有做资源协调"。
 * 单机/无板跑本来就该照常工作 —— 所以这里只 warn、不失败；
 * 但在多 bot 同服时，这条 warn 就是你排查"两个 bot 开了同一个箱子"的线索。
 */
const _warnedNoReserve = new Set();
function warnNoReserve(what) {
    if (_warnedNoReserve.has(what)) return;
    _warnedNoReserve.add(what);
    try { console.warn(`[act_${what}] 没有收到 reserveNow 回调：本次**未做资源占位**（单机正常/多机需接线）`); } catch { /* ignore */ }
}

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
    // ★★ BOT-006（2026-11-06 深度检查）：**超时 / 取消必须真的结束这次开窗。**
    //
    //   缺陷原貌：这里原来是 `Promise.race([opener, sleep(timeout)])` —— race 结束后
    //   **原始 opener 既没被取消也没人管**（包已经发出去了，取消不了），它的副作用照样
    //   由 mineflayer 落地：
    //     · 函数已经返回 TIMEOUT，几秒后窗口却突然打开 → 污染下一个任务的 `bot.currentWindow`
    //       （下一个任务看到 BLOCKED / 错窗口）；
    //     · 等待期间 `interrupt_code=true`，opener 回来后函数**仍然报 ok**。
    //   报告验证：TIMEOUT 后 lateOpen=true；interrupt 时开窗结果仍 ok。
    //
    //   修法（报告给的最小修复：代次 + 取消清理 + 成功前复核 + 清计时器）：
    //     · 每次开窗领一个**代次**；被更新的开窗操作顶掉（代次变了）就不再管窗口；
    //     · 自己设的超时计时器自己清掉（原来 `sleep(timeout)` 会一直挂着）；
    //     · 本次尝试**结束之后**才到的窗口，只清"自己拥有"的那个
    //       （当前窗口已经是别人的 → 一律不碰）；
    //     · **成功之前复核取消**：取消了就不许再报 ok。
    const gen = (_openGen.get(bot) ?? 0) + 1;
    _openGen.set(bot, gen);
    const stale = () => (_openGen.get(bot) ?? 0) !== gen;
    let finished = false;
    /** 迟到结果的清理：只关"我们开的、且没被后来的开窗操作接盘"的那个窗口。 */
    const closeLateIfOwned = (w) => {
        if (!w) return;
        if (stale()) return;                       // 更新的开窗操作已经接盘 → 别碰它的窗
        const cur = bot.currentWindow;
        if (cur && cur !== w) return;              // 当前窗口不是我们开的那个 → 别碰
        try { bot.closeWindow?.(cur ?? w); } catch { /* ignore */ }
    };

    let win = null;
    let timer = null;
    // ★★★ T6（架构收敛项 3）：**开窗那一刻按真实目标补占位**。
    //
    //   为什么在这里：`deriveClaims` 只能从单里的 `args.target/pos` 推容器，
    //   而 `flow_store` / `flow_fetch` 是**跑到那儿现选箱子**的（指定的 > 记忆里同类的 > 最近的）
    //   ⇒ 单里常常没有坐标 ⇒ 两个 bot 可能同时开同一个箱子，计数直接对不上。
    //
    //   为什么不传 ctx：`flow_*` 调动作只传 bot（`entry.run(agent?.bot ?? agent, …)`），
    //   动作层拿不到 ctx。沿用本仓既有约定（`bot.board` + `bot.__navJobId`，都由 makeCtx 挂），
    //   见 `board_claims.reserveRealTarget` 的注释。
    //
    //   冲突（`CLAIM_CONFLICT`）**当场返回**，不静默继续 —— 上层据此换目标/重排，
    //   而不是"两个 bot 一起开同一个箱子，各记各的账"。
    //   ★ `opts.skipClaim === true` 可跳过（离线夹具/诊断用）。
    if (opts.skipClaim !== true) {
        // ★ 回调由**调用方注入**（`opts.reserveNow`），或由 ctx 挂在 bot 上的那个
        //   （`bot.__reserveNow`，见 composite_registry.makeCtx）—— `act_*` **不 import
        //   board 任何模块**（分层：动作层不该知道"任务板"存在）。
        //   两处都没有 = 单机/无板场景：跳过并 warn，**不假装协调成功**。
        const reserveNow = opts.reserveNow ?? bot?.__reserveNow ?? null;
        if (typeof reserveNow !== 'function') {
            warnNoReserve('container');
        } else {
            try {
                const key = `container:${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
                const claim = await reserveNow(key);
                if (claim && claim.ok === false && claim.code === 'CLAIM_CONFLICT') {
                    return fail('CLAIM_CONFLICT', `这个容器已被别人占了：${(claim.data?.conflicts ?? []).join(', ')}`, {
                        block: block.name, pos: { x: v.x, y: v.y, z: v.z }, conflicts: claim.data?.conflicts ?? [],
                    });
                }
            } catch { /* 预约层出错不该让开窗失败（协调是增强，不是前置） */ }
        }
    }
    try {
        const opener = USE_OPEN_CONTAINER.has(kind)
            ? bot.openContainer(block)
            : bot.openBlock(block);
        // 结局自己接管：opener 晚到（超时之后才 resolve）时按"迟到结果"清理
        const settled = Promise.resolve(opener).then(
            (w) => { if (finished) closeLateIfOwned(w); return { okWin: true, w }; },
            (e) => ({ okWin: false, e }),
        );
        const timeoutP = new Promise((_, reject) => {
            // ★ 不用 unref：这里**必须**由这一个计时器兜住"开窗一直没有回音"的情况，
            //   而它在 finally 里一定会被 clearTimeout（BOT-006 的"清掉超时计时器"）。
            timer = setTimeout(() => reject(new Error('open-timeout')), timeout);
        });
        const r = await Promise.race([settled, timeoutP]);
        finished = true;                            // 从这里起，迟到的窗口归 closeLateIfOwned 收拾
        if (!r.okWin) throw r.e;
        win = r.w;

        // ★ BOT-006：等待期间被取消 —— 开窗结果回来了也不许报 ok
        if (bot.interrupt_code) {
            closeLateIfOwned(win ?? bot.currentWindow);
            return fail('INTERRUPTED', '被取消了', { block: block.name });
        }
    } catch (e) {
        finished = true;
        const msg = String(e?.message ?? e);
        closeLateIfOwned(bot.currentWindow);
        if (/timeout/.test(msg)) {
            return fail('TIMEOUT', `开了 ${Date.now() - t0}ms 还没开`, { block: block.name, costMs: Date.now() - t0 });
        }
        return fail('INTERNAL', msg, { error: msg, block: block.name });
    } finally {
        // ★ BOT-006：超时计时器必须清掉（原来它会在后台一直跑到底）
        if (timer) { clearTimeout(timer); timer = null; }
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
    // ★ Phase R 收尾（2026-11-03）：实现已搬到 `atom_input_inventory.closeWindow`
    //   （"界面输入只有一个出口"），这里反向复用 → **全仓只有一份实现**。
    return closeWindow(bot);
}

/** 当前窗口里的物品快照（给上层判断"有没有我要的"）。 */
export function windowItems(bot) {
    // ★ Phase R 收尾（2026-11-03）：实现已搬到 `atom_read.windowSlots`（读取原子的真身），
    //   这里反向复用，**全仓只有一份实现**。
    //   语义差异保留：本函数"没有窗口"时返回 `null`（调用方靠它区分"没开窗"和"空箱子"），
    //   而 `windowSlots` 按原子的"读不到就空"规矩统一返回 `[]` —— 所以这里先判 currentWindow。
    if (!bot?.currentWindow) return null;
    return windowSlots(bot);
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

/**
 * 当前窗口**光标**（玩家手上"拎着"的那一叠）有多少个某物。
 *
 * ★★ BOT-009 残留（2026-11-07 真机验收）：**在途物品既不在背包、也不在容器格子里。**
 *   mineflayer 的 `deposit` 是逐次点击：`取起源格 → 放进目标格`。
 *   当目标容器满、最后一次点击被服务端拒绝时，**那一叠已经"取起到光标上"**：
 *     · 它已从 `win.slots` 的背包区间消失（`invCount` 变小）；
 *     · 它还没进容器的任何格子（`winCount` 不变）；
 *     · 它躺在 `win.selectedItem` 上 —— 只有这里能看见它。
 *   真机实测（`docs/真机-20261106/T2/result-B2-deposit-attribution.json`）：
 *     `invBefore=10, invAfter=6, winBefore=0, winAfter=3`，光标上 `{iron_sword×1, slot 56}`。
 *   所以「背包减少量」不能直接当"已存数"，必须**扣掉光标上的在途件**。
 *
 * @returns {number} 光标上该物品的件数（没有光标 / 不是这件 → 0）
 */
function cursorCount(bot, name) {
    const win = bot.currentWindow;
    const held = win?.selectedItem;
    if (!held || held.name !== name) return 0;
    return held.count ?? 0;
}

/**
 * 等这次搬运的计数**收敛**（不是"动了一下"就返回），并且**必须先看到过变化**。
 *
 * ★★ BOT-009 残留（2026-11-06 真机验收）：原来两处谓词都是
 *      `waitCountsSettled(() => invCount < invBefore || winCount > winBefore)`
 *    —— 只要**任一边**变了就立刻返回，于是常常停在"背包已减 4 / 箱子只增 3 / 1 件在光标"
 *   这个中间态上，再拿它去算差就多报 1 件。
 *
 * ★★★ 2026-11-07 复审（第1条）：只加"连续两次相同 + 光标为空"**还不够**。
 *   服务端槽位更新是异步的：如果更新还没到，**两个旧快照也满足条件**，
 *   于是动作在 ~66ms 就返回、把"还没刷新"误判成"零进度"（复审用受控延迟复现：
 *   槽位 180ms 后才更新，函数 66ms 就返回 INVENTORY_FULL/stored:0，随后箱子实际 +3、背包 -3）。
 *
 *   现在的判据分两段：
 *     ① **完成信号**：本次转移相关的计数相对基线发生了变化（`inv`/`win` 相对 `baseline` 变了），
 *        或光标上出现过东西（说明点击已经开始）。没看到任何变化 = 还**没有证据**说明转移发生过；
 *     ② **稳定**：在①成立之后，再要求连续两次读数完全相同且光标为空。
 *   ⇒ 超时且**从未**看到变化时返回 `settled:false, sawChange:false`，
 *     调用方必须把它当"**未确认**"（TIMEOUT），**不许**静默折算成零进度。
 *
 * @param {object} opts.baseline `{inv, win}` 本次转移开始前的读数（必传才能做①判定）
 * @returns {{inv:number, win:number, cursor:number, settled:boolean, sawChange:boolean, waitedMs:number}}
 */
async function settleTransferCounts(bot, name, { baseline = null, timeoutMs = 1200, intervalMs = 50 } = {}) {
    const t0 = Date.now();
    const snap = () => ({
        inv: invCount(bot, name),
        win: winCount(bot, name),
        cursor: cursorCount(bot, name),
    });
    let prev = null;
    let sawChange = false;
    for (;;) {
        const cur = snap();
        // ① 完成信号：相对基线动过，或光标上出现过东西（已开始点击）
        if (baseline && (cur.inv !== baseline.inv || cur.win !== baseline.win)) sawChange = true;
        if (cur.cursor > 0) sawChange = true;

        const sameAsPrev = prev && prev.inv === cur.inv && prev.win === cur.win && prev.cursor === cur.cursor;
        if (sameAsPrev && cur.cursor === 0 && sawChange) {
            return { ...cur, settled: true, sawChange, waitedMs: Date.now() - t0 };
        }
        prev = cur;
        if (Date.now() - t0 >= timeoutMs) {
            // 超时：settled=false。sawChange 决定调用方能否据此下"零进度"的结论。
            return { ...cur, settled: false, sawChange, waitedMs: Date.now() - t0 };
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/**
 * 算"这次真的存进去几件"。**只数真正落进容器格子的物品。**
 *
 * 口径（为什么不是简单的 `invBefore - invAfter`）：
 *   1. **首选直接证据**：`winAfter - winBefore` —— 容器的格子是唯一"东西真的到货"的地方；
 *   2. **扣除在途**：`invBefore - invAfter - cursor` —— 光标上的那叠既不在背包也不算已存，
 *      扣掉它之后背包口径才不会多报；
 *   3. **只在容器计数明显没刷新时**才回退背包口径（`winMoved === 0 && invMoved > 0`），
 *      否则一律以容器增量为准 —— 这样既不会多报（原缺陷），也不会少报（满成功场景）；
 *   4. 最后用 `take` 封顶，防御任何窗口数据异常。
 *
 * 真机判据（同一场景，改前 → 改后）：
 *   改前 `Math.max(invBefore-invAfter, winAfter-winBefore)` = `max(4, 3)` = **4（多报 1）**
 *   改后 `winMoved` = **3**，且 `invMoved`（扣光标后）= `10-6-1` = **3**，两者一致。
 */
function measureStored(bot, item, invBefore, winBefore, take, after) {
    const invMoved = Math.max(0, invBefore - after.inv - after.cursor);
    const winMoved = Math.max(0, after.win - winBefore);
    const rawStored = winMoved > 0 ? winMoved : invMoved;
    const stored = Math.min(take, rawStored);
    return {
        stored,
        invAfter: after.inv,
        winAfter: after.win,
        cursorAfter: after.cursor,
        invMoved,
        winMoved,
        // 两个口径是否一致 —— 不一致时把两边都带回去，便于上层/真机排查，不靠猜
        consistent: invMoved === winMoved,
        settled: after.settled === true,
        settleWaitedMs: after.waitedMs ?? null,
    };
}

/**
 * 把**光标上的在途件**送回它来的那一侧（尽力而为，失败不影响返回结果）。
 *
 * 为什么必须做：`win.selectedItem` 上的那叠东西不属于任何格子。窗口一关，
 * 服务端按"关窗时光标里的物品退回背包、背包满了就掉地上"处理 ——
 * 真机实测（T7 场景③：箱 10 把、背包只剩 3 格、取 10）：
 *   取出 3 件成功、第 4 件停在光标上 → 关窗后背包只有 3 件、箱子少了 4 件、**1 件掉地上**，
 *   守恒从 10 变成 9（`docs/真机-20261106/T7/result-matrix.json` 的 `conservationAfterClose: 9`）。
 * 这不是"账报错"，而是**真丢东西**，而且就发生在本函数刚测完账的那一瞬间。
 *
 * 方向：
 *   · `deposit` 的在途件是从**背包**取起的 → 送回背包（`win.withdraw`）；
 *   · `withdraw` 的在途件是从**容器**取起的 → 送回容器（`win.deposit`）。
 * 送回之后再关窗，光标就是空的，不会掉东西。
 *
 * 只在 `after.cursor > 0` 时调用；任何异常都吞掉（读不到/放不回就保持原行为，不放大问题）。
 *
 * @returns {Promise<boolean>} 真的送回去了没有
 */
async function returnCursorToOrigin(bot, item, cursorCountNow, origin, itemType) {
    if (!(cursorCountNow > 0)) return false;
    const win = bot.currentWindow;
    if (!win) return false;
    try {
        if (origin === 'inventory' && typeof win.withdraw === 'function') {
            await win.withdraw(itemType, null, cursorCountNow);   // deposit 的在途件 → 送回背包
        } else if (origin === 'container' && typeof win.deposit === 'function') {
            await win.deposit(itemType, null, cursorCountNow);    // withdraw 的在途件 → 送回容器
        } else {
            return false;
        }
        return cursorCount(bot, item) < cursorCountNow;
    } catch {
        return false;   // 放不回（对侧也满了）→ 保持原行为，别把异常盖到主流程上
    }
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
        if (/interrupt/i.test(msg)) {
            // ★★ 2026-11-07 复审（第1条·附）：**中断时也要把光标上的东西放回去。**
            //   否则关窗时那叠物品会掉在地上/消失（复审独立复现：底层转移抛 interrupt 后光标残留）。
            //   存款的在途件来自背包 ⇒ 送回背包。
            const cursorNow = cursorCount(bot, item);
            const cursorReturned = await returnCursorToOrigin(bot, item, cursorNow, 'inventory', itemType);
            return fail('INTERRUPTED', '被取消了', { item, cursorAfter: cursorNow, cursorReturned });
        }
        // ★★ BOT-009（2026-11-06 深度检查）：**异常之后必须重新核对真实差值。**
        //
        //   缺陷原貌：mineflayer 的 `win.deposit` 是"逐次点击"实现的（inventory.js 的
        //   transferOne 递归），箱子中途满 / 窗口被关 / 交易被拒时**前面的点击已经搬进去了**，
        //   而这里原来直接 `return fail('INTERNAL')` —— 连 stored 都不带。
        //   流程只好按"一件都没存"处理：跳过共享库存更新、账本按零进度、重试时**重复搬运**。
        //   报告验证：请求存 10，实际已进箱 3（背包 10→7），完整流程却返回 INTERNAL/stored:0。
        //
        //   修法：等计数落定，按**背包真实减少量**（并用箱子真实增加量兜底）算出已搬数量；
        //   有进展 → INVENTORY_FULL + 真实 stored（= "只搬了一部分，剩下的换箱/记账"），
        //   真一件没动 → 才是 INTERNAL。
        //
        // ★★★ BOT-009 残留（2026-11-07 真机验收）：上面的"背包减少量"仍会**多报在途件**。
        //   真机 3/3 复现：请求存 10 把铁剑进只剩 3 空格的箱子 →
        //     旧口径 `Math.max(10-6, 3-0)` = **4**，但真实只进了 **3**（背包 10→7、箱子 +3）；
        //     差的 1 件当时**躺在容器光标上**（`selectedItem = {iron_sword×1, slot 56}`），
        //     关窗后它才回到背包（守恒 7+3=10）。
        //   ⇒ 现在改用 `settleTransferCounts`（等收敛且光标为空）+ `measureStored`
        //     （以容器增量为准、背包口径扣除光标在途件），stored 只数**真的落进格子**的。
        const after = await settleTransferCounts(bot, item, { baseline: { inv: invBefore, win: winBefore } });
        const m = measureStored(bot, item, invBefore, winBefore, take, after);
        // ★ 在途件送回原侧（deposit 的来路是背包），避免关窗时掉地上（见 returnCursorToOrigin）
        const cursorReturned = await returnCursorToOrigin(bot, item, m.cursorAfter, 'inventory', itemType);
        // ★★ 2026-11-07 复审（第1条）：**从未看到任何变化** ⇒ 快照是"未确认"的。
        //   注意：真正的修复是上面"必须看到变化才收敛"（异步更新会在 timeout 内被等到）；
        //   这里只负责**不静默**——把 unconfirmed 显式带给上层，绝不谎称 verified。
        const unconfirmed = !after.settled && !after.sawChange;
        if (unconfirmed) {
            console.warn(`[container] deposit 计数未确认：${after.waitedMs}ms 内无任何变化（保留最后快照，标记 unconfirmed）`);
        }
        if (m.stored > 0) {
            return fail('INVENTORY_FULL', `只存进去 ${m.stored}/${take}（${msg}）`, {
                item, want, stored: m.stored,
                invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
                cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
                partial: true, error: msg, unconfirmed, settled: after.settled,
            });
        }
        return fail('INTERNAL', msg, {
            error: msg, item, want, stored: 0,
            invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
            cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
            unconfirmed, settled: after.settled,
        });
    }

    // ★ 先等计数落定（否则读到旧值 → 假失败）
    // ★★★ BOT-009 残留（2026-11-07）：同上 —— 必须等"收敛 + 光标为空"，且用容器增量口径，
    //   否则满成功场景下若最后一件还在光标上，`invBefore-invAfter` 也会多报。
    const after = await settleTransferCounts(bot, item, { baseline: { inv: invBefore, win: winBefore } });
    const m = measureStored(bot, item, invBefore, winBefore, take, after);
    // ★ 在途件送回原侧（deposit 的来路是背包），避免关窗时掉地上（见 returnCursorToOrigin）
    const cursorReturned = await returnCursorToOrigin(bot, item, m.cursorAfter, 'inventory', itemType);
    const stored = m.stored;

    // 两边计数必须对上（存了多少，背包就少多少、箱子就多多少）
    // ★★ 2026-11-07 复审（第1条）：如果**从未看到任何变化**，快照就是未确认的 ——
    //   显式标出来（`unconfirmed`），并**不许**再谎称 `verified: true`。
    const unconfirmed = !after.settled && !after.sawChange;
    if (unconfirmed) {
        console.warn(`[container] deposit 计数未确认：${after.waitedMs}ms 内无任何变化（保留最后快照，标记 unconfirmed）`);
    }
    if (stored <= 0) {
        // 一个都没动：这时候才可能是"真的满"。但要区分"到点还没刷新"——
        // 已经等过 settle（且**必须看到变化才算收敛**），所以这里按真实读数下结论。
        const chestGrew = m.winAfter > winBefore;
        return fail('INVENTORY_FULL',
            chestGrew ? `只进了 ${m.winAfter - winBefore} 个（背包计数没同步）` : `没能存进去（容器可能满了）`, {
                item, want, stored: 0,
                invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
                cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
                verified: unconfirmed ? false : (chestGrew ? false : true),
                unconfirmed, settled: after.settled,
            });
    }
    if (stored < take) {
        return fail('INVENTORY_FULL', `只存进去 ${stored}/${take}（容器满了）`, {
            item, want, stored,
            invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
            cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
            partial: true, unconfirmed, settled: after.settled,
        });
    }
    return ok({
        item, want, stored,
        invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
        cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
        unconfirmed, settled: after.settled,
    });
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
/**
 * 算"这次真的取出来几件"（`deposit`/`measureStored` 的**镜像**口径）。
 *
 * 为什么不能直接 `winBefore - winAfter`（原 `:652` 的写法）：
 *   取物时物品流是 `容器格子 → 光标 → 背包格子`。最后一次点击把物品从容器取起到光标上、
 *   却因为背包满了**放不进背包**时：
 *     · 容器格已经减了（`winCount` 变小）；
 *     · 背包还没增（`invCount` 不变）；
 *     · 那叠东西在光标上（`win.selectedItem`）。
 *   ⇒ 用 `winBefore - winAfter` 会把"停在光标上、其实没进背包"的 1 件算成已取出（**多报**）；
 *   ⇒ 用 `invAfter - invBefore` 又会在"容器计数刷新慢"时**少报**（`taken=0`，但玩家手里已经拿到了）。
 *
 * 口径（对称于 `measureStored`）：
 *   1. **首选直接证据是"目的地"**：取物的目的地是**玩家背包** ⇒ `invAfter - invBefore`；
 *   2. **在途处理**：光标上的件「已离开容器、还没进背包」，既不该算"已取出到背包"，
 *      也不能算"还在容器里" ⇒ 只在用容器口径兜底时把它扣掉：`winMoved - cursor`；
 *   3. **只有背包计数明显没刷新时**（`invMoved === 0 && winMovedNet > 0`）才回退容器口径；
 *   4. `take` 封顶。
 *
 * 真机判据（箱子 10 件、背包只剩 3 格、请求取 10）：
 *   改前 `taken = winBefore - winAfter` = **4（多报 1）**；改后 `invMoved` = **3**，
 *   且 `winMovedNet = 4 - 1(光标) = 3` —— 两个口径一致。
 */
function measureTaken(bot, item, invBefore, winBefore, take, after) {
    const invMoved = Math.max(0, after.inv - invBefore);
    const winMoved = Math.max(0, winBefore - after.win);
    const winMovedNet = Math.max(0, winMoved - after.cursor);   // 扣掉停在光标上的在途件
    const rawTaken = invMoved > 0 ? invMoved : winMovedNet;
    const taken = Math.min(take, rawTaken);
    return {
        taken,
        invAfter: after.inv,
        winAfter: after.win,
        cursorAfter: after.cursor,
        invMoved,
        winMoved,
        winMovedNet,
        consistent: invMoved === winMovedNet,
        settled: after.settled === true,
        settleWaitedMs: after.waitedMs ?? null,
    };
}

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
        if (/interrupt/i.test(msg)) {
            // ★★ 2026-11-07 复审（第1条·附）：中断时把光标上的在途件送回**容器**（取物的来路）。
            const cursorNow = cursorCount(bot, item);
            const cursorReturned = await returnCursorToOrigin(bot, item, cursorNow, 'container', itemType);
            return fail('INTERRUPTED', '被取消了', { item, cursorAfter: cursorNow, cursorReturned });
        }
        // ★ BOT-009（与 deposit 同一个坑的另一半）：取物抛错时按真实差值报部分进度 ——
        //   原来同样直接 INTERNAL，已经取到手的那几件被当成"一件没取"。
        //
        // ★★★ BOT-009 残留（2026-11-07 中途评审指出的镜像面）：上面这句"真实差值"原来取的是
        //   `Math.max(winBefore-winAfter, invAfter-invBefore)` —— 会把**停在光标上、还没进背包**
        //   的那 1 件算成已取出（多报）。现在与 deposit 对称：等收敛且光标为空，
        //   以**背包增量（目的地）**为准，容器口径只在背包计数没刷新时兜底并扣掉在途件。
        const after = await settleTransferCounts(bot, item, { baseline: { inv: invBefore, win: winBefore } });
        const m = measureTaken(bot, item, invBefore, winBefore, take, after);
        // ★ 在途件送回原侧（withdraw 的来路是容器），避免关窗时掉地上（见 returnCursorToOrigin）
        const cursorReturned = await returnCursorToOrigin(bot, item, m.cursorAfter, 'container', itemType);
        // ★★ 2026-11-07 复审（第1条）：从未看到变化 ⇒ 快照未确认，显式标记（不静默）。
        const unconfirmed = !after.settled && !after.sawChange;
        if (unconfirmed) {
            console.warn(`[container] withdraw 计数未确认：${after.waitedMs}ms 内无任何变化（保留最后快照，标记 unconfirmed）`);
        }
        if (m.taken > 0) {
            return fail('INVENTORY_FULL', `只取出 ${m.taken}/${take}（${msg}）`, {
                item, want, taken: m.taken,
                invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
                cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
                partial: true, error: msg, unconfirmed, settled: after.settled,
            });
        }
        return fail('INTERNAL', msg, {
            error: msg, item, want, taken: 0,
            invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
            cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
            unconfirmed, settled: after.settled,
        });
    }

    // ★ 同样先等计数落定（收敛 + 光标为空，见 settleTransferCounts）
    // ★★★ BOT-009 残留（2026-11-07）：原 `taken = winBefore - winAfter` 会在
    //   "容器已减、背包未增（1 件在光标上）"时多报；改用 measureTaken 的目的地口径。
    const after = await settleTransferCounts(bot, item, { baseline: { inv: invBefore, win: winBefore } });
    const m = measureTaken(bot, item, invBefore, winBefore, take, after);
    // ★ 在途件送回原侧（withdraw 的来路是容器），避免关窗时掉地上（见 returnCursorToOrigin）
    const cursorReturned = await returnCursorToOrigin(bot, item, m.cursorAfter, 'container', itemType);
    const taken = m.taken;

    // ★★ 2026-11-07 复审（第1条）：从未看到变化 ⇒ 快照未确认，显式标记（不静默）。
    const unconfirmed = !after.settled && !after.sawChange;
    if (unconfirmed) {
        console.warn(`[container] withdraw 计数未确认：${after.waitedMs}ms 内无任何变化（保留最后快照，标记 unconfirmed）`);
    }

    if (taken <= 0) {
        const invGrew = m.invAfter > invBefore;
        return fail('INVENTORY_FULL',
            invGrew ? `只取出 ${m.invAfter - invBefore} 个（箱子计数没同步）` : `没能取出来（背包可能满了）`, {
                item, want, taken: 0,
                invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
                cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
                // ★ 复审第1条：未确认时不许谎称 verified
                verified: unconfirmed ? false : (invGrew ? false : true),
                unconfirmed, settled: after.settled,
            });
    }
    if (taken < take) {
        return fail('INVENTORY_FULL', `只取出来 ${taken}/${take}（背包满了）`, {
            item, want, taken,
            invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
            cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
            unconfirmed, settled: after.settled,
        });
    }
    return ok({
        item, want, taken,
        invBefore, invAfter: m.invAfter, winBefore, winAfter: m.winAfter,
        cursorAfter: m.cursorAfter, cursorReturned, invMoved: m.invMoved, winMoved: m.winMoved,
        unconfirmed, settled: after.settled,
    });
}
