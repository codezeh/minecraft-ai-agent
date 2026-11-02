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
    if (!board?.sharedPut) return;                       // 没板就不写（不退回本地文件）
    try {
        const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
        const cur = await board.sharedGet('chest', key);
        const prev = cur?.ok ? (cur.data?.item?.value ?? null) : null;
        const items = { ...(prev?.items ?? {}) };
        for (const [name, n] of Object.entries(delta ?? {})) {
            const next = (items[name] ?? 0) + n;
            if (next > 0) items[name] = next;
            else delete items[name];
        }
        await board.sharedPut('chest', key, {
            pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
            items,
            owner: board.name ?? bot?.username ?? null,
            at: Date.now(),
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

    for (const chest of chests) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;

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
            const r = await deposit(bot, item, target);
            if (r.ok) {
                await rememberChest(bot, chest.position, { [item]: Number(r.data?.stored ?? 0) });
                return ok({ item, want, stored: Number(r.data?.stored ?? 0), chest: chest.position });
            }
            if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            if (r.code === 'INVENTORY_FULL') {
                // 这个箱子满了 → replan 换下一个（可恢复）
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

    // 全都试过了：箱子满 → INVENTORY_FULL（abort）；否则报最后那个码
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

    for (const chest of chests) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;

        let win = null;
        for (let attempt = 0; attempt < 2 && !win; attempt++) {
            const opened = await ensureOpen(bot, chest, ctx);
            if (opened.ok) { win = opened.data.window; break; }
            if (opened.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            lastCode = opened.code;
        }
        if (!win) continue;

        try {
            const r = await withdraw(bot, item, want);
            if (r.ok) {
                await rememberChest(bot, chest.position, { [item]: -Number(r.data?.taken ?? 0) });
                return ok({ item, want, taken: Number(r.data?.taken ?? 0), chest: chest.position });
            }
            if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            if (r.code === 'INVENTORY_FULL') {
                // ★ 与 store 不同：取的时候背包满，换箱子也没用 → 直接 abort
                return fail('INVENTORY_FULL', '背包满了，取出来没地方放（先腾背包）', {
                    item, want, taken: 0,
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

    return fail(lastCode === 'WINDOW_CLOSED' ? 'WINDOW_CLOSED' : 'NO_ITEM',
        `箱子里没找到 ${want} 个 ${item}`, { item, want, taken: 0 });
}
