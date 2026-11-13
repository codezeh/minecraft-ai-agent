/**
 * 流程：存进 / 取出箱子（M7 P0，04 §6.1 卡片 `flow_store` / `flow_fetch`）。
 *
 * 卡片原文：
 *   plan：选箱子（指定的 > 记忆里同类的 > 最近的）→ `reserve container:…` → `goTo`
 *         → `openContainer` → 逐项 `deposit` / `withdraw` → `finally` 里 `closeContainer`
 *         → 更新箱子记忆（**B4 起搬进任务板库**，见下）
 *   onFail：存时箱子满（`INVENTORY_FULL`）→ replan 换下一个箱子，都满了才 abort；
 *           取时背包满 → abort 带 `{count, want}`；没有箱子 → `NO_TARGET`
 *   完成：两边计数对上
 *
 * 两个"可恢复失败" vs "该 abort 的失败"（本文件的核心判断）：
 *   · `WINDOW_CLOSED` → **可恢复**：重开箱子再来一次（restep）。
 *     窗口会因为走开、被挤、服务端清理而关闭，这不是"做不到"，是"再打开一次"。
 *   · `INVENTORY_FULL` → **看方向**：
 *       存的时候容器满 → 可恢复（换下一个箱子；都满了才 abort）
 *       取的时候背包满 → **abort**（再换箱子也没用，得先腾背包，那是上层的事）
 *   · `NO_TARGET`（附近没箱子）/ 参数错 → **abort**
 *   · `INTERRUPTED` → 立刻返回，不重试
 *
 * 路径/存储（B4，06 §9.3）：箱子内容现在写在**任务板库**（mindserver 侧唯一写库），
 *   经 `board_client.sharedPut('chest', ...)` 读写 —— 这样**别的 bot 也能看到**
 *   （B4 验收："A 存进箱子的东西，B 不开箱就知道在哪个箱子"）。
 *   ★ 旧实现是这里自己 `readFileSync/writeFileSync` 写 `bots/<name>/memory/chests.json`，
 *     而 `landmarks.js` 也管同一个文件、但用的是**另一种数据形状**（数组 vs 这里用的 map）——
 *     两个写者会互相覆盖。B4 把这一路彻底删掉，不再有第二个真相。
 *   ★ 没有任务板时（mindserver 都没连上）**不写**：宁可少一条记忆，也不要再长出第二份文件。
 *
 * ★★★ R6 #19（2026-11-10）：**B4 当时只改了一半。**
 *   本文件的注释写着"不再有第二个真相"，但 `landmarks.js` 的 rememberChest /
 *   updateChestContents / findItemInChests 仍在读写 `memory/chests.json`，
 *   而 `!putInChest` / `!viewChest` / `verifyChest` / `storeItem` / `findItemInStorage` /
 *   `tidyInventory` 全走那一路 —— 于是 A 用 !putInChest 存的 64 个原木，
 *   B 用 `findItemInSharedChests` **看不到**（两个账本各记各的）。
 *   现在 `landmarks.js` 的箱子域也改成板库 `shared(kind='chest')` 的适配器
 *   （旧文件不读不写，只留作升级时的一次性迁移源），两边共用同一张表：
 *     · 本文件写**增量**（`sharedMerge`：存 +N / 取 -N）—— 多次合并不会互相覆盖；
 *     · `landmarks.js` 写**观测值**（打开箱子看到的真实内容）与档案字段（note/category）。
 *   谁都不是"第二个账本"：**板库的 chest 命名空间是唯一真相**，两边只是两个写入口径。
 */
// B4：不再直接读写 chests.json（那是第二个真相），走任务板。
import { ok, fail } from './contract.js';
import { openContainer, closeContainer, deposit, withdraw } from './act_container.js';
import { countItem, blockAt } from './query_perceive.js';
import { mapDirOf } from './bot_paths.js';
import { goTo } from './nav_core.js';

/** 存/取共用的 manifest 字段（两个技能各有一份，避免"共用对象被改"的坑）。 */
function manifestOf(name, summary, extraCodes) {
    return {
        name,
        level: 'flow',
        summary,
        params: {
            item: 'item',
            count: 'int 1..64 = 1',
        },
        needs: { items: [], near: [] },
        // R6 #67：这里原来是个死常量 claim（只写了 container 种类、没有 x,y,z → 非法 key），已删。
        // 容器预约改由 act_container 开窗时按真实坐标补占位，deriveClaims 也会从 args 推。
        codes: ['NO_TARGET', 'NO_ITEM', 'WINDOW_CLOSED', 'INVENTORY_FULL', 'OUT_OF_REACH', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL', ...extraCodes],
        resumable: false,
        timeoutMs: 3 * 60 * 1000,
    };
}

export const manifestStore = manifestOf('store', '把背包里的东西存进箱子', []);
export const manifestFetch = manifestOf('fetch', '从箱子里取出东西', []);

/** 找这只 bot 手上的任务板（没有就 null —— 没板时不写任何记忆，见文件头）。 */
function boardOf(bot) {
    return bot?.agent?.board ?? bot?.board ?? null;
}

/**
 * 更新箱子内容记忆（B4：写进任务板库，**全 bot 共享**）。
 *
 * 语义：`delta` 是增量（存 +N / 取 -N）。先读板上的现值再叠加，
 * 避免把别的 bot 记进去的其它物品覆盖掉。
 *
 * 尽力而为：写不进去不影响本次存取结果（记忆是优化，不是交易的成败条件）。
 */
async function rememberChest(bot, pos, delta) {
    const board = boardOf(bot);
    // ★★★ T31 第16条：**必须走服务端原子合并**。
    //
    //   原来这里写的是「`sharedGet` → 本地叠加 → `sharedPut`」，跨**两次 socket 往返**。
    //   两个 bot 同时往同一个箱子存东西时：
    //     A 读 {oak_log:5} → B 读 {oak_log:5} → A 写 {oak_log:5, stone:3} → B 写 → **A 那次没了**。
    //   现在只发**增量**，读-改-写在 mindserver（唯一写者）的一个事务里完成。
    //
    //   ★ 不再保留"本地读-改-写"这条老路：留着它等于留第二条实现，
    //     而两条实现一定会漂移（这个仓里已经因为"两处各叫一个名字"栽过很多次）。
    if (!board?.sharedMerge) return;                     // 没板/老接口 → 不写（不退回本地文件）
    try {
        const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
        await board.sharedMerge(key, delta ?? {}, {
            x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z),
        });
    } catch { /* 记忆写不进不影响主流程 */ }
}

/**
 * 开箱后把窗口里的**真实内容**强刷进库存缓存（ADR D7-1）。
 * 尽力而为：写不进不影响本次存取（缓存不是交易的成败条件）。
 */
async function refreshInventoryCache(bot, pos) {
    const board = boardOf(bot);
    if (typeof board?.inventoryCacheRefresh !== 'function') return;      // 无板/老接口 → 不写
    const w = bot?.currentWindow;
    if (!w || typeof w.containerItems !== 'function') return;
    try {
        const items = {};
        for (const it of w.containerItems() ?? []) {
            const n = Number(it?.count ?? 0);
            if (n > 0 && it?.name) items[it.name] = (items[it.name] ?? 0) + n;
        }
        await board.inventoryCacheRefresh({
            x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), items,
        });
    } catch { /* 缓存刷新失败不改变存取结果 */ }
}

/** 取用失败 ⇒ 标脏（D7-1）：内容不再确定，下一次开箱强刷回来；同样尽力而为。 */
async function markInventoryDirty(bot, pos, reason) {
    const board = boardOf(bot);
    if (typeof board?.inventoryMarkDirty !== 'function') return;
    try {
        await board.inventoryMarkDirty({
            x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z),
            reason: reason == null ? null : String(reason),
        });
    } catch { /* 标脏失败不改变主流程 */ }
}

/** 附近所有箱子（按距离从近到远）。 */
function chestsNearby(bot, maxDistance = 32) {
    try {
        const id = bot.registry?.blocksByName?.chest?.id;
        if (id == null) return [];
        const pos = bot.findBlocks?.({ matching: id, maxDistance, count: 8 }) ?? [];
        const p = bot.entity?.position;
        return pos
            .map((q) => bot.blockAt?.(q, false))
            .filter(Boolean)
            .sort((a, b) => d2(p, a) - d2(p, b));
    } catch {
        return [];
    }
}

function d2(self, block) {
    const q = block?.position;
    if (!self || !q) return Infinity;
    return Math.hypot(q.x + 0.5 - self.x, q.z + 0.5 - self.z);
}

/**
 * 打开某个箱子并走到够得着的位置。
 * @returns ActionResult（ok 时 data.window 是窗口对象）
 */
async function ensureOpen(bot, chest, ctx) {
    const tp = chest.position;
    const self = bot.entity?.position;
    if (self && Math.hypot(tp.x + 0.5 - self.x, tp.z + 0.5 - self.z) > 3) {
        const moved = await goTo(bot, { kind: 'point', pos: { x: tp.x, y: tp.y, z: tp.z } }, {
            mapDir: mapDirOf(bot),
            deadlineMs: Math.max(4000, Math.min((ctx?.deadline ?? Date.now() + 30000) - Date.now(), 60000)),
            arriveTol: 2,
        });
        if (!moved.ok) {
            if (moved.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            return fail('OUT_OF_REACH', `走不到箱子（${moved.code}）`, { pos: { x: tp.x, y: tp.y, z: tp.z } });
        }
    }
    const opened = await openContainer(bot, { kind: 'block', pos: { x: tp.x, y: tp.y, z: tp.z } }, {});
    if (!opened.ok) {
        // 开不了箱子：多半是够不着/被占；转成可重试的 WINDOW_CLOSED 或直接报原码
        return fail(opened.code === 'INTERRUPTED' ? 'INTERRUPTED' : 'WINDOW_CLOSED',
            `打不开箱子：${opened.code} ${opened.message ?? ''}`, { pos: { x: tp.x, y: tp.y, z: tp.z } });
    }
    await refreshInventoryCache(bot, tp);
    return ok({ window: bot.currentWindow });
}

// ═══════════════════════════════════════════════════════════════════════════
// 共享库存（D7 闭环，**显式 opt-in**：`opts.shared === true`）
//
// 为什么必须 opt-in：`!do store/fetch` 与真机 E2E 走的都是"本地搬运"语义（不预占、不记账），
// 把它们改成默认走板会同时改掉两条路的行为。长解释与取舍见 docs/audit-r6/fixes4/wiring-flow.md。
// ═══════════════════════════════════════════════════════════════════════════

const isShared = (opts) => opts?.shared === true;

/** 方块 → 整数坐标（服务端只认三个整数，不做四舍五入替调用方决定）。 */
function posOf(block) {
    const p = block?.position;
    if (!p) return null;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/**
 * 观测性开箱：只把真实内容刷进缓存，**一件都不搬**。
 * 为什么要它：`container_cache` 没观测过就等于"已知库存 0"，预占会被一律拒（D7 的"未知即 0"）。
 */
async function observeContainers(bot, chests, ctx) {
    const seen = [];
    for (const chest of chests) {
        if (bot?.interrupt_code) break;
        if (Date.now() >= (ctx?.deadline ?? Infinity)) break;
        const opened = await ensureOpen(bot, chest, ctx);
        if (opened.ok) seen.push(posOf(chest));
        try { closeContainer(bot); } catch { /* ignore */ }
    }
    return seen;
}

/**
 * 存入的账本（只在 `opts.shared` 下）：走 `inventory:store` 写 `reason='store'`（**不是** reconcile ——
 * 对账那行的语义是"账实不符、以真实为准修正"，正常存入写成它会让对账统计静默变错）。
 * 顺带把刚看到的真实内容交给服务端强刷缓存（D7-1）；记账失败不改变存取成败。
 */
async function recordStoreLedger(bot, pos, item, qty) {
    const board = boardOf(bot);
    if (typeof board?.inventoryStore !== 'function') return { recorded: false, reason: 'no-board' };
    const w = bot?.currentWindow;
    if (!w || typeof w.containerItems !== 'function') return { recorded: false, reason: 'no-window' };
    const pt = posOf({ position: pos });
    if (!pt) return { recorded: false, reason: 'bad-pos' };
    try {
        const observed = {};
        for (const it of w.containerItems() ?? []) {
            const n = Number(it?.count ?? 0);
            if (n > 0 && it?.name) observed[it.name] = (observed[it.name] ?? 0) + n;
        }
        const r = await board.inventoryStore({ item, qty, chestKey: pt, observed });
        if (!r?.ok) return { recorded: false, reason: r?.data?.boardCode ?? r?.code ?? 'store-failed', ...pt };
        return { recorded: true, delta: Number(r?.data?.ledger?.delta ?? qty), cache: r?.data?.cache ?? null, ...pt };
    } catch {
        return { recorded: false, reason: 'throw', ...pt };   // 记账失败不改变存取的成败（记忆/账本是优化项）
    }
}

/**
 * 把 item 存 count 个进箱子。
 *
 * @returns ActionResult
 *   ok            → data: { item, want, stored, chest }
 *   NO_TARGET     附近没有箱子（abort）
 *   NO_ITEM       背包里没有这件东西（abort）
 *   INVENTORY_FULL 所有箱子都满了（abort —— 换箱子也没用）
 *   WINDOW_CLOSED 重开多次仍失败（abort）
 */
export async function store(bot, item, count = 1, opts = {}) {
    const want = Math.max(1, Math.floor(Number(count) || 1));
    const ctx = opts.ctx ?? { deadline: Date.now() + manifestStore.timeoutMs };
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!item) return fail('NO_TARGET', '没说要存什么');

    const have = countItem(bot, item);
    if (have <= 0) return fail('NO_ITEM', `背包里没有 ${item}`, { item });
    const target = Math.min(want, have);

    const chests = chestsNearby(bot);
    if (!chests.length) return fail('NO_TARGET', '附近没有箱子', { item });

    let lastCode = null;
    let storefull = 0;
    // ★★ BOT-009（2026-11-06 深度检查）：**跨箱累计已搬数量。**
    //
    //   缺陷原貌：`deposit` 抛错时动作层直接 INTERNAL、不带 stored，这里又把
    //   `r.data.stored ?? 0` 一律当 0 —— 实际存进去的几件既没进共享库存
    //   （`rememberChest` 只在 ok 分支调用），也没进返回账本；上层按零进度重试 → 重复搬运。
    //   报告验证：请求存 10、实际进箱 3，完整流程返回 INTERNAL/stored:0。
    //
    //   修法：每搬成一部分就**记账 + 累计**，按剩余数量接着存；收尾如实报 partial。
    let storedTotal = 0;
    // ★ 共享存入（opt-in）：存完立即入账；不传 shared 时 `ledger` 恒为空、行为与原来一致
    const shared = isShared(opts);
    const ledger = [];
    const remember = async (chest, n) => {
        if (!(n > 0)) return;
        storedTotal += n;
        await rememberChest(bot, chest.position, { [item]: n });
        if (shared) ledger.push(await recordStoreLedger(bot, chest.position, item, n));
    };

    for (const chest of chests) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;
        if (storedTotal >= target) break;              // 已经存够了（上一箱只收了一部分）

        // 打开（WINDOW_CLOSED / OUT_OF_REACH → 换下一个箱子）
        let win = null;
        for (let attempt = 0; attempt < 2 && !win; attempt++) {
            const opened = await ensureOpen(bot, chest, ctx);
            if (opened.ok) { win = opened.data.window; break; }
            if (opened.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            lastCode = opened.code;
        }
        if (!win) continue;

        try {
            // ★ S（真机验收发现）：store 的账目原来**只信客户端**：箱内已有同类物品时，
            //   物理搬了 16 却自报 stored=9 且 ok=false。fetch 早已用服务端真值修正过，
            //   store 没跟上。这里同样取"存入前后箱内该物品总数的差值"当真值。
            const countInChest = () => {
                // 必须整体兜住：窗口可能已关/已被换掉，containerItems() 会抛；
                // 让异常穿出去会改变外层（"距离过远应失败"那条反证就是这样被带偏的）。
                try {
                    const w = bot.currentWindow;
                    if (!w || typeof w.containerItems !== 'function') return null;
                    return w.containerItems().filter((i) => i?.name === item).reduce((n, i) => n + (i.count ?? 0), 0);
                } catch {
                    return null;
                }
            };
            const chestBefore = countInChest();

            const r = await deposit(bot, item, target - storedTotal);   // ★ 只补剩下的

            // 服务端真值优先（读不到就退回客户端报数，不改变原有行为）
            let delivered = Number(r?.data?.stored ?? 0);
            const chestAfter = countInChest();
            if (chestBefore !== null && chestAfter !== null) {
                const serverStored = chestAfter - chestBefore;
                if (serverStored >= 0) delivered = serverStored;
            }
            if (r.ok) {
                await remember(chest, delivered);
                return ok({ item, want, stored: storedTotal, chest: chest.position, ...(shared ? { ledger } : {}) });
            }
            if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            if (r.code === 'INVENTORY_FULL') {
                // 这个箱子满了（或者只收了一部分）→ 先记下真的搬进去的那几件，再换下一个
                await remember(chest, delivered);
                if (storedTotal >= target) {
                    return ok({ item, want, stored: storedTotal, chest: chest.position, ...(shared ? { ledger } : {}) });
                }
                storefull++;
                lastCode = 'INVENTORY_FULL';
                continue;                              // finally 会关窗
            }
            if (r.code === 'WINDOW_CLOSED') { lastCode = 'WINDOW_CLOSED'; continue; }
            lastCode = r.code;
        } finally {
            // 卡片要求 finally 里关窗
            try { closeContainer(bot); } catch { /* ignore */ }
        }
    }

    // 全都试过了：有部分进度就如实报（partial），一件没搬才算彻底失败
    if (storedTotal > 0) {
        return fail(storefull > 0 ? 'INVENTORY_FULL' : (lastCode ?? 'INVENTORY_FULL'),
            `只存进去 ${storedTotal}/${target}`, { item, want, stored: storedTotal, partial: true, ...(shared ? { ledger } : {}) });
    }
    if (storefull > 0) {
        return fail('INVENTORY_FULL', `箱子都存不下了（试了 ${storefull} 个）`, { item, want, stored: 0 });
    }
    return fail(lastCode === 'WINDOW_CLOSED' ? 'WINDOW_CLOSED' : (lastCode ?? 'NO_TARGET'),
        '没能存进去', { item, want, stored: 0 });
}

/**
 * 取用入口。`opts.shared === true` ⇒ 先预占 → 取用 → 结算；不传 ⇒ 与原来**完全一致**
 * （`!do fetch` 与真机 E2E 都走那条路）。
 */
export async function fetch(bot, item, count = 1, opts = {}) {
    if (isShared(opts)) return fetchShared(bot, item, count, opts);
    return fetchLocal(bot, item, count, opts);
}

/**
 * 共享库存取用（D7 的闭环缺口）：预占 → 真取 → 结算（取到多少结多少）。
 * 拿不到预占就**不取**；一件都没取到 ⇒ 当场还券，额度立即回池（不白占、不等 5 分钟 TTL）。
 * 取舍与边界见 docs/audit-r6/fixes4/wiring-flow.md。
 */
async function fetchShared(bot, item, count, opts) {
    const want = Math.max(1, Math.floor(Number(count) || 1));
    const ctx = opts.ctx ?? { deadline: Date.now() + manifestFetch.timeoutMs };
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!item) return fail('NO_TARGET', '没说要取什么', { shared: true });

    const board = boardOf(bot);
    if (typeof board?.inventoryReserve !== 'function' || typeof board?.inventorySettle !== 'function') {
        // 没有板就没有券：宁可不取，也不"先取了再靠对账吸收"（那正是 D7 要消灭的做法）
        return fail('INTERNAL', '共享库存取用需要任务板：没有板就不预占、也不取用', {
            item, want, shared: true, took: 0, boardCode: 'NO_BOARD', noBoard: true,
        });
    }

    const chests = chestsNearby(bot);
    if (!chests.length) return fail('NO_TARGET', '附近没有箱子', { item, want, shared: true, took: 0 });
    const containers = chests.map(posOf).filter(Boolean);

    let resv = await board.inventoryReserve({ item, qty: want, containers });
    // 缓存从没观测过这些箱子（未知即 0）⇒ 开箱只看一眼再预占，绝不"先取了再说"
    if (!resv?.ok && resv?.data?.boardCode === 'INSUFFICIENT_STOCK' && Number(resv?.data?.known ?? -1) === 0) {
        // 一个都打不开就别再预占了（省一次往返，也免得把"够不着箱子"误报成"库存不足"）
        const observed = await observeContainers(bot, chests, ctx);
        if (observed.length) resv = await board.inventoryReserve({ item, qty: want, containers });
    }
    if (!resv?.ok) return refuseReservation(item, want, resv);

    const reservation = resv?.data?.reservation ?? null;
    // 访客（服务端判定）：只留审计、不落券 ⇒ 不结算也不释放（不然会对着空券报错）
    const visitor = resv?.data?.visitor === true || !reservation?.id;

    const r = await fetchLocal(bot, item, want, opts);
    const taken = Math.max(0, Number(r?.data?.taken ?? 0));
    const base = {
        item, want, taken, shared: true,
        reservationId: reservation?.id ?? null, reservedQty: reservation?.qty ?? want,
    };
    if (visitor) return withReservation(r, { ...base, visitor: true, settled: false, released: false });

    if (taken > 0) {
        // 取到多少结多少：没用掉的额度随 consumed 一起回池（结算幂等，重复结只返回第一次）
        const settled = await board.inventorySettle({
            reservationId: reservation.id, qty: taken, container: r?.data?.chest ?? null,
        });
        if (!settled?.ok) {
            // 物理上已经搬走了、账却没落 ⇒ 缓存不能再当账（否则下一次对账会把它再扣一遍）
            await markInventoryDirty(bot, r?.data?.chest ?? chests[0].position, `settle-failed:${settled?.code ?? 'null'}`);
        }
        return withReservation(r, {
            ...base,
            settled: settled?.ok === true,
            released: false,
            settleCode: settled?.ok ? null : (settled?.data?.boardCode ?? settled?.code ?? null),
            settledQty: settled?.ok ? taken : 0,
            ...(settled?.ok ? {} : { settleMessage: settled?.message ?? '' }),
        });
    }

    // 一件都没取到（开窗前就失败 / withdraw 全失败）⇒ 还券，别白占着额度
    const released = typeof board.inventoryRelease === 'function'
        ? await board.inventoryRelease({ reservationId: reservation.id, reason: r?.code ?? null })
        : null;
    return withReservation(r, {
        ...base,
        settled: false,
        released: released?.ok === true,
        releaseCode: released?.ok ? null : (released?.data?.boardCode ?? released?.code ?? 'NO_RELEASE'),
        ...(released?.ok ? {} : { releaseReason: released?.message ?? '任务板没有 inventoryRelease，券只能等 TTL 作废' }),
    });
}

/** 预占没拿到 ⇒ 不取用；库存不足要把"已知/已预占/可用/请求"四个数说清。 */
function refuseReservation(item, want, resv) {
    const d = resv?.data ?? {};
    const boardCode = d.boardCode ?? d.code ?? null;
    if (boardCode === 'INSUFFICIENT_STOCK') {
        const known = d.known ?? null;
        const reservedQty = d.reserved ?? null;
        const available = d.available ?? null;
        const requested = d.requested ?? want;
        return fail('NO_ITEM',
            `共享库存不足：已知 ${known}、已预占 ${reservedQty}、可用 ${available}，需要 ${requested}（没预占到就不取用）`,
            { item, want, took: 0, shared: true, boardCode, known, reserved: reservedQty, available, requested });
    }
    return fail(resv?.code ?? 'INTERNAL',
        `共享库存预占失败：${resv?.message ?? boardCode ?? '原因未知'}（没预占到就不取用）`,
        { item, want, took: 0, shared: true, boardCode, ...(d.known == null ? {} : { known: d.known, reserved: d.reserved ?? null, available: d.available ?? null }) });
}

/** 把"取用结果"与"券的收尾情况"合成一个 ActionResult：取用失败的真实原因不许被释放/结算的失败盖掉。 */
function withReservation(r, extra) {
    const data = { ...(r?.data ?? {}), ...extra };
    if (r?.ok) return ok(data);
    return fail(r?.code ?? 'INTERNAL', r?.message ?? '取用失败', data);
}

/** 原取用路径（非共享）：**行为一个字都没改** —— 已有 E2E 与 !do 命令依赖它。
 *
 * @returns ActionResult
 *   ok            → data: { item, want, taken, chest }
 *   NO_TARGET     附近没有箱子 / 箱子里没有这件东西
 *   INVENTORY_FULL **背包满 → abort**（换箱子没用，得先腾背包 —— 这是与 store 不同的处置）
 *   WINDOW_CLOSED 重开多次仍失败
 */
async function fetchLocal(bot, item, count = 1, opts = {}) {
    const want = Math.max(1, Math.floor(Number(count) || 1));
    const ctx = opts.ctx ?? { deadline: Date.now() + manifestFetch.timeoutMs };
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!item) return fail('NO_TARGET', '没说要取什么');

    const chests = chestsNearby(bot);
    if (!chests.length) return fail('NO_TARGET', '附近没有箱子', { item });

    let lastCode = null;
    // ★ BOT-009 的另一半：取物也要跨箱累计（原来取到一半抛错，已到手的那几件被当零进度）
    let takenTotal = 0;
    const remember = async (chest, n) => {
        if (!(n > 0)) return;
        takenTotal += n;
        await rememberChest(bot, chest.position, { [item]: -n });
    };

    for (const chest of chests) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;
        if (takenTotal >= want) break;

        let win = null;
        for (let attempt = 0; attempt < 2 && !win; attempt++) {
            const opened = await ensureOpen(bot, chest, ctx);
            if (opened.ok) { win = opened.data.window; break; }
            if (opened.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            lastCode = opened.code;
        }
        if (!win) continue;

        try {
            // ★★★ T38 跨层真值：先记下开窗前容器里有多少，withdraw 之后再**重开窗口**读一次，
            //   用服务端下发的 containerItems() 差值当 taken 的真值（客户端快照会晚一拍，不能用来报数）。
            const countInChest = () => {
                const w = bot.currentWindow;
                if (!w || typeof w.containerItems !== 'function') return 0;
                return w.containerItems().filter((i) => i?.name === item).reduce((n, i) => n + (i.count ?? 0), 0);
            };
            const chestBefore = countInChest();

            let r = await withdraw(bot, item, want - takenTotal);

            // 关窗 → 重开 → 读服务端真值（openWindow 包会带全部槽位，这一读是权威的）
            // ★ 兼容：假 bot（单测的 fake window）没有 bot.clickWindow ⇒ 跳过这段，保持原有行为。
            try {
                if (typeof bot?.clickWindow !== 'function') throw new Error('fake-bot: skip server truth');
                try { closeContainer(bot); } catch { /* ignore */ }
                await new Promise((res) => setTimeout(res, 200));
                const reopened = await ensureOpen(bot, chest, ctx);
                if (reopened.ok) {
                    const chestAfter = countInChest();
                    const serverTaken = Math.max(0, Math.min(want - takenTotal, chestBefore - chestAfter));
                    const clientTaken = Number(r?.data?.taken ?? 0);
                    if (serverTaken !== clientTaken) {
                        // 以服务端真值为准修正账目（对外字段语义不变，只把 taken 改准）
                        r = {
                            ...r,
                            ok: serverTaken > 0 ? r.ok : r.ok,
                            data: { ...(r.data ?? {}), taken: serverTaken, takenSource: 'server', tookClient: clientTaken },
                        };
                        // 服务端说取到了、客户端却说失败 ⇒ 按成功处理（物理事实优先）
                        if (serverTaken > 0 && !r.ok) r = { ...r, ok: true, code: 'OK', message: '' };
                        if (serverTaken === 0 && r.ok) r = { ...r, ok: false, code: 'NO_ITEM', message: '' };
                    } else if (r?.data) {
                        r = { ...r, data: { ...r.data, takenSource: 'server' } };
                    }
                }
            } catch { /* 复核失败就按原结果，不假装成功 */ }

            if (r.ok) {
                await remember(chest, Number(r.data?.taken ?? 0));   // remember 内部已累加 takenTotal
                return ok({ item, want, taken: takenTotal, chest: chest.position, takenSource: r.data?.takenSource });
            }

            // ★ D7-1：这一箱没取全 ⇒ 缓存不能当账了（可能少了几件、也可能被别人动过）
            await markInventoryDirty(bot, chest.position, r.code);

            if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            if (r.code === 'INVENTORY_FULL') {
                // ★ 与 store 不同：取的时候**背包真的满**（一件都没取到）→ 换箱子没用，直接 abort。
                //   但 BOT-009：已经取到手的那几件必须记账；而且"取了一部分"说明不是背包满
                //   （是这个箱子给不全了）→ 换下一个箱子接着取，别把进度丢掉。
                const moved = Number(r.data?.taken ?? 0);
                await remember(chest, moved);
                if (takenTotal >= want) return ok({ item, want, taken: takenTotal, chest: chest.position });
                if (moved > 0) { lastCode = 'INVENTORY_FULL'; continue; }
                return fail('INVENTORY_FULL', '背包满了，取出来没地方放（先腾背包）', {
                    item, want, taken: takenTotal, partial: takenTotal > 0,
                });
            }
            if (r.code === 'NO_ITEM') {
                // 这个箱子里没有 → 换下一个箱子找（可恢复）
                lastCode = 'NO_ITEM';
                continue;
            }
            if (r.code === 'WINDOW_CLOSED') { lastCode = 'WINDOW_CLOSED'; continue; }
            lastCode = r.code;
        } finally {
            try { closeContainer(bot); } catch { /* ignore */ }
        }
    }

    if (takenTotal > 0) {
        return fail(lastCode === 'WINDOW_CLOSED' ? 'WINDOW_CLOSED' : 'NO_ITEM',
            `只取到 ${takenTotal}/${want} 个 ${item}`, { item, want, taken: takenTotal, partial: true });
    }
    return fail(lastCode === 'WINDOW_CLOSED' ? 'WINDOW_CLOSED' : 'NO_ITEM',
        `箱子里没找到 ${want} 个 ${item}`, { item, want, taken: 0 });
}
