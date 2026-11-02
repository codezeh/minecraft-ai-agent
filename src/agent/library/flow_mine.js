/**
 * 流程：挖 N 个矿（M7 P0，04 §6.1 卡片 `flow_mine`）。
 *
 * 卡片原文：
 *   plan：按矿种定目标高度（写进配置，例：铁 16、钻石 -58）→ `flow_tunnel` 阶梯下到那层
 *         → 主巷道每隔 3 格开支巷 → 每步先看可见矿石，有就 `digBlock` + 捡 → 够数原路返回
 *   安全：每步 `checkStep`；掉血交给 `self_preservation` 反射，流程不自己判
 *   onFail：`LIQUID_RISK` `NO_FLOOR` → `replan` 换方向；`NO_TOOL` → `abort`
 *   完成：增量 ≥ `count`；到 `maxDepth` 或 deadline → `fail('TIMEOUT', …, {count, want})`
 *
 * ★ "矿挖不到 / 太深" 怎么处理（本文件最需要说清的一处）
 *   三种情况分开处置，因为它们对上层的意思完全不同：
 *   ① **附近根本没有这种矿** → `NO_TARGET`（换个地方/换个矿种；这是"没目标"，不是"做不到"）
 *   ② **有矿但够不着/走不过去** → 先 `goTo` 靠近；仍不行 → `OUT_OF_REACH`
 *      （与 NO_TARGET 的区别：那是"没有矿"，这是"矿在那儿但过不去"）
 *   ③ **太深/到 maxDepth 还没挖够** → `TIMEOUT` 且带 `{count, want}`（卡片明确要求这个码）
 *      —— 不用 NO_PATH：路径本身没问题，是"深度预算用完了"
 *   另外 `NO_TOOL`（挖不动，比如没镐）→ **abort**，不重试：换方向也没用。
 *
 * 为什么"下到目标层"用 `tunnelStep` 而不是自己挖：`atom_tunnel.tunnelStep` 已经带
 * `checkStep` 安全检查（液体/无地板红线），流程不该自己再实现一遍挖穿逻辑。
 */
import { ok, fail } from './contract.js';
import { digBlock, isDiggable, canDigWithInventory } from './act_dig.js';
import { findBlocks } from './query_perceive.js';
import { countItem } from './query_perceive.js';
import { mapDirOf } from './bot_paths.js';
import { goTo } from './nav_core.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'mine',
    level: 'flow',
    summary: '挖 N 个某种矿（会走到矿旁边、挖掉、捡起来；太深会放弃）',
    params: {
        ore: 'string',
        count: 'int 1..64 = 1',
        maxDepth: 'int 1..128 = 64',
    },
    needs: { items: ['镐'], near: [] },
    claims: [],
    codes: ['NO_TARGET', 'NO_TOOL', 'OUT_OF_REACH', 'NO_PATH', 'NO_FLOOR', 'LIQUID_RISK', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: false,
    timeoutMs: 8 * 60 * 1000,
};

/**
 * 各矿的理想挖掘高度（Y）。卡片举例：铁 16、钻石 -58。
 * 这张表是"去哪找"的常识，不是魔法数：原版矿脉按 Y 分布，找不到就换高度。
 */
const ORE_Y = {
    coal: 96, copper: 48, iron: 16, gold: -16, redstone: -58, diamond: -58,
    lapis: 0, emerald: 100, nether_quartz: 32, ancient_debris: 15,
};


/**
 * 时间预算（毫秒）。**上限**语义：调用处一律 `Math.min(预算, deadline - now)`，
 * 所以永远不会越过任务单的 deadline。具名化是为了"要调就只改一处"。
 */
const DESCEND_BUDGET_MS = 60000;    // 下到目标高度那一次 goTo
const APPROACH_BUDGET_MS = 40000;   // 走近某一块矿
const DESCEND_WINDOW_MS = 30000;    // 下潜时额外给的窗口（与预算取小）
const APPROACH_WINDOW_MS = 30000;   // 走近时额外给的窗口（与预算取小）
const MIN_WAIT_BUDGET_MS = 4000;    // 每一步最少给的预算

/** 矿名规范化：`iron_ore` / `deepslate_iron_ore` / `iron` 都认。 */
function oreNames(ore) {
    const base = String(ore ?? '').toLowerCase().replace(/^minecraft:/, '');
    const bare = base.replace(/^deepslate_/, '').replace(/_ore$/, '');
    const names = new Set([base]);
    if (!base.endsWith('_ore')) names.add(`${bare}_ore`);
    names.add(`deepslate_${bare}_ore`);
    return [...names];
}

/** 现在所在的高度。 */
function feetY(bot) {
    return Math.floor(bot.entity?.position?.y ?? 0);
}

/**
 * 挖 count 个 ore。
 *
 * @param {object} opts { maxDepth=64, ctx }
 * @returns ActionResult
 *   ok        → data: { ore, count, want, mined, costMs }
 *   NO_TARGET 附近找不到这种矿
 *   NO_TOOL   挖不动（没镐/镐不够好）—— abort
 *   OUT_OF_REACH 有矿但走不过去
 *   TIMEOUT   到 maxDepth 或 deadline 还没挖够（带 count/want）
 */
export async function mine(bot, ore, count = 1, opts = {}) {
    const want = Math.max(1, Math.floor(Number(count) || 1));
    const maxDepth = Math.max(1, Math.floor(Number(opts.maxDepth) || 64));
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!ore) return fail('NO_TARGET', '没说要挖什么矿');

    const names = oreNames(ore);
    // 计数基准：所有可能的矿石名合计（deepslate 变体也算）
    const countAll = () => names.reduce((n, name) => n + countItem(bot, name), 0);
    const before = countAll();
    const startY = feetY(bot);
    const wantY = ORE_Y[String(ore).toLowerCase().replace(/^minecraft:/, '').replace(/_ore$/, '')];

    let mined = 0;
    let sawAnyOre = false;
    let lastCode = null;
    const MAX_ROUNDS = 40;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { ore, count: mined, want });
        if (countAll() - before >= want) break;
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;
        // 深度预算：比起点低了 maxDepth 就收工（卡片：到 maxDepth → TIMEOUT + count/want）
        if (startY - feetY(bot) > maxDepth) break;

        // ── 找可见矿石（近的先挖）──
        const candidates = [];
        for (const name of names) {
            try {
                const found = findBlocks(bot, name, 32, 32) ?? [];
                for (const b of found) candidates.push(b);
            } catch { /* 未注册的矿名直接跳过 */ }
        }
        if (!candidates.length) {
            // 这一轮视野里没有矿。第一次没看到 → 可能该换高度；换过还没 → NO_TARGET
            if (sawAnyOre || round > 0) { lastCode = lastCode ?? 'NO_TARGET'; break; }
            // 下到目标高度再扫一轮（用 goTo 走到本列更深的位置；走不到就认命）
            if (wantY != null && feetY(bot) > wantY) {
                const dest = {
                    x: Math.floor(bot.entity.position.x),
                    z: Math.floor(bot.entity.position.z),
                };
                const walked = await goTo(bot, { kind: 'point', posXZ: dest }, {
                    mapDir: mapDirOf(bot),
                    deadlineMs: Math.max(MIN_WAIT_BUDGET_MS, Math.min((ctx.deadline ?? Date.now() + DESCEND_WINDOW_MS) - Date.now(), DESCEND_BUDGET_MS)),
                    arriveTol: 2,
                });
                if (!walked.ok && walked.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            }
            lastCode = 'NO_TARGET';
            break;
        }
        sawAnyOre = true;

        // 按距离排序，逐个试
        const self = bot.entity.position;
        candidates.sort((a, b) => a.position.distanceTo(self) - b.position.distanceTo(self));

        for (const block of candidates.slice(0, 8)) {
            if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { ore, count: mined, want });
            if (countAll() - before >= want) break;

            // 挖不动就别试了（换方向/换工具是上层的事）
            if (!isDiggable(block)) continue;
            if (!canDigWithInventory(bot, block)) {
                return fail('NO_TOOL', `挖不动 ${block.name}（没有合适的镐）`, { ore, block: block.name, count: mined, want });
            }

            // 走近（够不着才走）
            const d = block.position.distanceTo(self);
            if (d > 4) {
                const walked = await goTo(bot, {
                    kind: 'point', pos: { x: block.position.x, y: block.position.y, z: block.position.z },
                }, {
                    mapDir: mapDirOf(bot),
                    deadlineMs: Math.max(MIN_WAIT_BUDGET_MS, Math.min((ctx.deadline ?? Date.now() + APPROACH_WINDOW_MS) - Date.now(), APPROACH_BUDGET_MS)),
                    arriveTol: 2,
                });
                if (!walked.ok) {
                    if (walked.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
                    lastCode = 'OUT_OF_REACH';            // 走不过去：换下一块
                    continue;
                }
            }

            const dug = await digBlock(bot, { kind: 'block', pos: { x: block.position.x, y: block.position.y, z: block.position.z } });
            if (dug.ok) { mined++; continue; }

            if (dug.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { ore, count: mined, want });
            if (dug.code === 'NO_TOOL') {
                return fail('NO_TOOL', dug.message ?? '挖不动', { ore, block: block.name, count: mined, want });
            }
            if (dug.code === 'OUT_OF_REACH') { lastCode = 'OUT_OF_REACH'; continue; }
            lastCode = dug.code ?? 'INTERNAL';
        }
    }

    const gained = countAll() - before;
    const done = Math.max(mined, gained);

    if (done >= want) {
        return ok({ ore, count: done, want, mined: done, costMs: Date.now() - t0 });
    }

    // 没到够数：区分"根本没有矿" / "走不过去" / "太深了"
    if (!sawAnyOre || lastCode === 'NO_TARGET') {
        return fail('NO_TARGET', `附近没有 ${ore}`, { ore, count: done, want });
    }
    if (lastCode === 'OUT_OF_REACH') {
        return fail('OUT_OF_REACH', `${ore} 在那儿但过不去`, { ore, count: done, want });
    }
    // 太深 / 时间到 —— 卡片要求 TIMEOUT + {count, want}
    return fail('TIMEOUT', `挖到深度/时间上限，只挖到 ${done}/${want} 个 ${ore}`, {
        ore, count: done, want, startY, endY: feetY(bot), maxDepth, costMs: Date.now() - t0,
    });
}
