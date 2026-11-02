/**
 * 流程：熔炼 N 个（M7 P0，04 §6.1 卡片 `flow_smelt`）。
 *
 * 卡片原文：
 *   plan：找附近熔炉并 `reserve station:furnace@…`，没有就放（背包没有先 `flow_craft` 一个，8 圆石）
 *         → `goTo` → `furnaceLoad` → **每 10 秒** `furnaceCollect`，到够数或到 deadline
 *   燃料：默认顺序 煤 > 木炭 > 木板 > 原木（1 煤烧 8 个，1 木板烧 1.5 个）
 *   onFail：`NOT_READY` → 等 10 秒 `retry`；`NO_ITEM`（燃料或原料）→ abort 带 `missing`；
 *           `INVENTORY_FULL` → abort，上层先 `flow_store`
 *
 * ★ 等待策略（本文件最要紧的一处）
 *   烧一个物品约 10 秒，所以"等"是这个流程的核心职责 —— 但它**不能死等**：
 *     · 每次轮询间隔 `POLL_MS`（10 秒，对齐卡片"每 10 秒 furnaceCollect"）
 *     · **每一次等待前都拿 `ctx.deadline` 算剩余时间**：`Math.min(POLL_MS, deadline - now)`，
 *       剩余不足就立刻收尾返回（带着已炼出来的数量），绝不越过 deadline 继续睡
 *     · `NOT_READY` 是"还没烧完"，是**正常过程**，不是错误 → 继续等；
 *       但如果 deadline 已经到了还是 NOT_READY，报 TIMEOUT（这才叫"等太久"）
 *   M6 已经把"放料"和"取产物"拆成 `furnaceLoad` / `furnaceCollect` 两个动作，
 *   它们各自只做一次操作、不做等待 —— 等是这里的事（04 §4.4 第 4 条：循环必须有时间上限）。
 *
 * ★ 不抢别人的熔炉
 *   `furnaceLoad` 里已有 `OCCUPIED` 保护（输入槽里有别人的料就拒绝）。
 *   流程把 `OCCUPIED` 当作**换一个熔炉**（可恢复），不是 abort —— 为别人的料让路是正常协作。
 */
import { ok, fail } from './contract.js';
import { furnaceLoad, furnaceCollect, craftOnce } from './act_craft.js';
import { placeBlockAt } from './act_place.js';
import { findItem } from './act_items.js';
import { countItem, blockAt } from './query_perceive.js';
import { mapDirOf } from './bot_paths.js';
import { goTo } from './nav_core.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'smelt',
    level: 'flow',
    summary: '把 N 个原料熔成成品（会自己找或放熔炉、备燃料）',
    params: {
        input: 'item',
        count: 'int 1..64 = 1',
        fuel: 'item?',
    },
    needs: { items: ['<input>', '燃料'], near: [] },
    claims: ['station:furnace'],
    codes: ['NO_ITEM', 'NO_WORKSTATION', 'NOT_READY', 'INVENTORY_FULL', 'OUT_OF_REACH', 'OCCUPIED', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: false,
    timeoutMs: 10 * 60 * 1000,
};

/** 轮询间隔：卡片说"每 10 秒 furnaceCollect"（一个物品约烧 10 秒）。 */
export const POLL_MS = 10000;

/** 燃料优先级（卡片：煤 > 木炭 > 木板 > 原木）。 */
const FUEL_ORDER = ['coal', 'charcoal', 'oak_planks', 'oak_log'];

/** 依次挑一样背包里有的燃料。 */
function pickFuel(bot, preferred) {
    if (preferred) return countItem(bot, preferred) > 0 ? preferred : null;
    for (const f of FUEL_ORDER) if (countItem(bot, f) > 0) return f;
    return null;
}

/** 附近所有熔炉（按距离从近到远）。找不到返回 []。 */
function furnacesNearby(bot, maxDistance = 24) {
    try {
        const id = bot.registry?.blocksByName?.furnace?.id;
        if (id == null) return [];
        const pos = bot.findBlocks?.({ matching: id, maxDistance, count: 8 }) ?? [];
        return pos
            .map((p) => bot.blockAt?.(p, false))
            .filter(Boolean)
            .sort((a, b) => dist2(bot, a) - dist2(bot, b));
    } catch {
        return [];
    }
}

function dist2(bot, block) {
    const p = bot.entity?.position;
    const q = block?.position;
    if (!p || !q) return Infinity;
    return Math.hypot(q.x + 0.5 - p.x, q.z + 0.5 - p.z);
}

/** 睡着等一会儿，但**绝不越过 deadline**。返回实际等了多久。 */
async function sleepWithinDeadline(ctx, ms) {
    const left = (ctx?.deadline ?? 0) - Date.now();
    if (left <= 0) return 0;
    const wait = Math.max(0, Math.min(ms, left));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return wait;
}

/**
 * 熔炼 count 个 input。
 *
 * @returns ActionResult
 *   ok        → data: { input, count, want, got, fuel, costMs }
 *   NO_ITEM   原料或燃料不够，`data.missing` 说明缺哪样 —— abort（先 flow_store / strat_obtain）
 *   NO_WORKSTATION 没有熔炉也放不出一个
 *   INVENTORY_FULL 背包满，产物取不出来 —— abort（上层先 flow_store）
 *   NOT_READY 到 deadline 了还没烧完（带着已炼数量）
 *   TIMEOUT   整体超时
 *   OCCUPIED  所有找到的熔炉都在炼别人的东西
 */
export async function smelt(bot, input, count = 1, opts = {}) {
    const want = Math.max(1, Math.floor(Number(count) || 1));
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!input) return fail('NO_TARGET', '没说要熔什么');

    // ── 前置：原料够不够（不够直接 abort，卡片要求带 missing）──
    const have = countItem(bot, input);
    if (have < want) {
        return fail('NO_ITEM', `只有 ${have} 个 ${input}，不够炼 ${want} 个`, {
            input, count: 0, want, missing: { [input]: want - have },
        });
    }

    // ── 前置：燃料（卡片给了优先级；没燃料就 abort，别烧到一半停下）──
    const fuel = pickFuel(bot, opts.fuel ?? null);
    if (!fuel) {
        return fail('NO_ITEM', '没有燃料', {
            input, count: 0, want, missing: { fuel: 1 },
        });
    }

    const before = countItem(bot, outputOf(bot, input));

    // ── 找熔炉；没有就放一个（背包没有熔炉就先合，8 圆石）──
    let furnaces = furnacesNearby(bot);
    let placedFurnace = false;
    if (!furnaces.length) {
        if (countItem(bot, 'furnace') === 0) {
            const made = await craftOnce(bot, 'furnace', 1);
            if (!made.ok) {
                return fail(made.code === 'NO_ITEM' ? 'NO_ITEM' : 'NO_WORKSTATION',
                    `需要熔炉，背包里没有、也合不出来（${made.message ?? ''}）`, { input });
            }
        }
        const p = bot.entity?.position;
        const spot = p ? { x: Math.floor(p.x) + 1, y: Math.floor(p.y), z: Math.floor(p.z) } : null;
        const stack = findItem(bot, 'furnace');
        if (!spot || !stack) return fail('NO_WORKSTATION', '没有可放的熔炉/位置', { input });
        try {
            if (bot.heldItem?.name !== 'furnace') await bot.equip(stack, 'hand');
        } catch { /* 由 placeBlockAt 报 */ }
        const placed = await placeBlockAt(bot, { kind: 'block', pos: spot }, 'furnace', {});
        if (!placed.ok) {
            return fail('NO_WORKSTATION', `放不下熔炉：${placed.code}`, { input, spot });
        }
        placedFurnace = true;
        furnaces = [blockAt(bot, spot)].filter(Boolean);
        if (!furnaces.length) return fail('NO_WORKSTATION', '熔炉放下去但读不到', { input });
    }

    // ── 挑一个熔炉 + 走近（OCCUPIED 就换下一个）──
    let furnace = null;
    let lastOccupied = false;
    for (const f of furnaces) {
        const d = dist2(bot, f);
        if (d > 3) {
            const tp = f.position;
            const moved = await goTo(bot, { kind: 'point', pos: { x: tp.x, y: tp.y, z: tp.z } }, {
                mapDir: mapDirOf(bot),
                deadlineMs: Math.max(4000, Math.min(ctx.deadline - Date.now(), 60000)),
                arriveTol: 2,
            });
            if (!moved.ok) {
                if (moved.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
                continue;                             // 走不到这个就换下一个
            }
        }

        const loaded = await furnaceLoad(bot, f, input, fuel);
        if (loaded.ok) {
            furnace = f;
            break;
        }
        if (loaded.code === 'OCCUPIED') {
            // 别人在炼 —— 换一个熔炉（可恢复，不是 abort）
            lastOccupied = true;
            continue;
        }
        if (loaded.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
        if (loaded.code === 'NO_ITEM') {
            return fail('NO_ITEM', loaded.message ?? '料或燃料不够', { input, count: 0, want, missing: { [input]: want } });
        }
        // OUT_OF_REACH / 其它：换下一个熔炉试试
    }

    if (!furnace) {
        return fail(lastOccupied ? 'OCCUPIED' : 'NO_WORKSTATION',
            lastOccupied ? '找到的熔炉都在炼别人的东西' : '没有可用熔炉', { input, count: 0, want });
    }

    // ── 轮询取产物：每 POLL_MS 一次，**每次都不越过 deadline** ──
    let got = 0;
    let sawNotReady = false;
    while (got < want) {
        const left = ctx.deadline - Date.now();
        if (left <= 0) break;                          // 到点了就收尾（不死等）
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { input, count: got, want });

        // 先等一轮（刚从 load 出来时产物一定是空的，别空转）
        const waited = sawNotReady ? await sleepWithinDeadline(ctx, POLL_MS) : await sleepWithinDeadline(ctx, 500);
        if (waited === 0) break;

        const c = await furnaceCollect(bot, furnace);
        if (c.ok) {
            got += Number(c.data?.count ?? 0);
            sawNotReady = false;
            continue;
        }
        if (c.code === 'NOT_READY') {
            // 还没烧完 —— 这是正常过程，继续等（不是失败）
            sawNotReady = true;
            continue;
        }
        if (c.code === 'INVENTORY_FULL') {
            return fail('INVENTORY_FULL', '背包满了，产物取不出来（先 store）', { input, count: got, want });
        }
        if (c.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { input, count: got, want });
        if (c.code === 'OUT_OF_REACH') {
            // 被挤开了：走近再取一次
            const tp = furnace.position;
            await goTo(bot, { kind: 'point', pos: { x: tp.x, y: tp.y, z: tp.z } }, {
                mapDir: mapDirOf(bot),
                deadlineMs: Math.max(3000, Math.min(ctx.deadline - Date.now(), 20000)),
                arriveTol: 2,
            });
            continue;
        }
        break;                                        // 其它码：收尾报数
    }

    const produced = countItem(bot, outputOf(bot, input)) - before;
    const done = Math.max(got, produced);
    const costMs = Date.now() - t0;

    if (done >= want) {
        return ok({ input, count: done, want, got: done, fuel, placedFurnace, costMs });
    }
    // 没到够数：deadline 到了算 NOT_READY（"还没烧完，等会再来"），否则算 TIMEOUT
    const expired = Date.now() >= ctx.deadline;
    return fail(expired ? 'NOT_READY' : 'TIMEOUT',
        `只炼出 ${done}/${want} 个${expired ? '（到时间上限了）' : ''}`,
        { input, count: done, want, got: done, fuel, costMs });
}

/**
 * 某原料熔出来的成品名。
 *
 * mineflayer/minecraft-data 里没有"输入→输出"的现成表，这里用命名规则近似：
 * `raw_iron` → `iron_ingot`、`raw_gold` → `gold_ingot`、`cobblestone` → `stone` …
 * 读不准就返回 null（调用方退回"只数 furnaceCollect 的 count"，不编造）。
 */
function outputOf(bot, input) {
    const guess = String(input ?? '')
        .replace(/^raw_/, '')
        .replace(/^(iron|gold|copper)$/, '$1_ingot');
    const MAP = {
        cobblestone: 'stone',
        sand: 'glass',
        clay_ball: 'brick',
        kelp: 'dried_kelp',
        porkchop: 'cooked_porkchop',
        beef: 'cooked_beef',
        chicken: 'cooked_chicken',
        mutton: 'cooked_mutton',
        cod: 'cooked_cod',
        salmon: 'cooked_salmon',
    };
    return MAP[input] ?? guess ?? null;
}
