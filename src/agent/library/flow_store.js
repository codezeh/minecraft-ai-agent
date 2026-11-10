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
        claims: ['container:chest'],
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
    return ok({ window: bot.currentWindow });
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
    const remember = async (chest, n) => {
        if (!(n > 0)) return;
        storedTotal += n;
        await rememberChest(bot, chest.position, { [item]: n });
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
            const r = await deposit(bot, item, target - storedTotal);   // ★ 只补剩下的
            if (r.ok) {
                await remember(chest, Number(r.data?.stored ?? 0));
                return ok({ item, want, stored: storedTotal, chest: chest.position });
            }
            if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            if (r.code === 'INVENTORY_FULL') {
                // 这个箱子满了（或者只收了一部分）→ 先记下真的搬进去的那几件，再换下一个
                await remember(chest, Number(r.data?.stored ?? 0));
                if (storedTotal >= target) {
                    return ok({ item, want, stored: storedTotal, chest: chest.position });
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
            `只存进去 ${storedTotal}/${target}`, { item, want, stored: storedTotal, partial: true });
    }
    if (storefull > 0) {
        return fail('INVENTORY_FULL', `箱子都存不下了（试了 ${storefull} 个）`, { item, want, stored: 0 });
    }
    return fail(lastCode === 'WINDOW_CLOSED' ? 'WINDOW_CLOSED' : (lastCode ?? 'NO_TARGET'),
        '没能存进去', { item, want, stored: 0 });
}

/**
 * 从箱子里取 item count 个。
 *
 * @returns ActionResult
 *   ok            → data: { item, want, taken, chest }
 *   NO_TARGET     附近没有箱子 / 箱子里没有这件东西
 *   INVENTORY_FULL **背包满 → abort**（换箱子没用，得先腾背包 —— 这是与 store 不同的处置）
 *   WINDOW_CLOSED 重开多次仍失败
 */
export async function fetch(bot, item, count = 1, opts = {}) {
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
