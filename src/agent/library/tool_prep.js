/**
 * 采集前的工具准备：没有斧头就造一把。
 *
 * 用户要求：「每次砍树时检查有没有工具，没有工具则尽量造个工具」。
 *
 * 顺序（从省到费）：
 *   1. 背包已有斧头 → 直接用（stone > iron > diamond > wooden）
 *   2. 有材料 → 造石斧（3 圆石 + 2 木棍）
 *   3. 有木头没圆石 → 造木斧（3 木板 + 2 木棍）
 *   4. 都没有 → 如实说「没工具也没材料」，用手砍（速度慢但能砍）
 */
import { countItem } from './atom_perceive.js';
import Vec3 from 'vec3';                 // bot.blockAt 必须传 Vec3（交接文档 §7.2 记过）
import pf from 'mineflayer-pathfinder';  // 捡掉落物时要用 GoalNear
import { countScaffold } from './scaffold_blocks.js';

export { countScaffold };

const AXE_PRIORITY = [
    'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe', 'netherite_axe',
];

/**
 * 检查并（必要时）准备斧头。
 * @returns {{ok:boolean, axe:string|null, made:boolean, why:string}}
 */
export async function ensureAxe(bot, opts = {}) {
    const { craft = true } = opts;

    // 1) 已有斧头
    for (const a of AXE_PRIORITY) {
        if (countItem(bot, a) > 0) {
            return { ok: true, axe: a, made: false, why: `已有 ${a}` };
        }
    }
    if (!craft) return { ok: false, axe: null, made: false, why: '没有斧头' };

    // 2) 造石斧：3 圆石 + 2 木棍
    const sticks = countItem(bot, 'stick');
    const cobble = countItem(bot, 'cobblestone');
    if (cobble >= 3 && sticks >= 2) {
        const r = await tryCraft(bot, 'stone_axe', 1);
        if (r) return { ok: true, axe: 'stone_axe', made: true, why: '用 3 圆石 + 2 木棍造了石斧' };
    }

    // 3) 造木斧：3 木板（任意）+ 2 木棍
    if (sticks >= 2) {
        const plank = findAnyPlank(bot);
        if (plank) {
            const r = await tryCraft(bot, 'wooden_axe', 1);
            if (r) return { ok: true, axe: 'wooden_axe', made: true, why: '用 3 木板 + 2 木棍造了木斧' };
        }
    }

    // 4) 连木棍都没有：先造木棍（2 木板 → 4 木棍）
    //    注意：木棍是 2×1 配方，需要工作台。工作台本身（4 木板 2×2）不用工作台。
    //    所以完整链路是：木板 → 工作台 → 放下来 → 木棍 → 木斧。
    const plank = findAnyPlank(bot);
    if (plank && countItem(bot, plank) >= 2) {
        // 4a) 先确保有工作台可用（背包有就放，没有就用 4 木板造一个）
        const hasTable = (bot.inventory?.items() ?? []).some(i => i.name === 'crafting_table');
        if (!hasTable && countItem(bot, plank) >= 4) {
            await tryCraft(bot, 'crafting_table', 1);
        }
        // 4b) 造木棍
        const r = await tryCraft(bot, 'stick', 4);
        if (r) {
            const r2 = await tryCraft(bot, 'wooden_axe', 1);
            if (r2) return { ok: true, axe: 'wooden_axe', made: true, why: '先造木棍再造了木斧' };
        }
    }

    return { ok: false, axe: null, made: false, why: '没有斧头，也没有材料（圆石/木板/木棍）' };
}

// ---------------------------------------------------------------------------
// 垫脚方块准备（2026-10-26 新增）
//
// 用户定的最后一道规划：「到不了目标高度的可以试试搭方块上去」。
//
// 但实测踩到一个死结：她**背包里一块可放方块都没有**（只有一把铁镐），
// 于是 pathfinder 的 allow1by1towers 被正确关掉了 → 永远搭不了 → 永远出不来。
// 真机证据：她掉进 y=63 的地下，四周地表 y=79~83（高 16~20 格），
// 只靠挖（只能往下/往水平）永远开不出向上的通道，两轮 goToPlayer 一步没动。
//
// 所以"搭方块"必须配一个前置："没方块就先去挖"。
// 她有铁镐，挖石头是最擅长的事 —— 这比"放弃"合理得多。
// ---------------------------------------------------------------------------

/** 可以拿来垫脚的方块见 scaffold_blocks.js（D8：清单原来散在 4 处且互不一致）。 */

/**
 * 保证背包里有至少 need 个可垫脚方块；不够就**就地挖**。
 *
 * 挖的顺序（从最容易到手到最费）：
 *   1. 脚下/附近的地表方块（dirt / grass_block / stone / sand …）
 *   2. 实在挖不到就如实返回失败，让上层说真话（别假装能上去）
 *
 * 注意：这里不负责"爬上去"，只负责**把材料弄到手**。
 * 真正的搭是由 pathfinder 的 allow1by1towers 做的。
 *
 * @param {object} bot
 * @param {{need?:number, maxMs?:number, onEvent?:Function}} opts
 * @returns {Promise<{ok:boolean, have:number, got:number, why:string}>}
 */
export async function ensureScaffold(bot, opts = {}) {
    const { need = 8, maxMs = 25000, onEvent = () => { } } = opts;
    const startHave = countScaffold(bot);
    if (startHave >= need) {
        return { ok: true, have: startHave, got: 0, why: `已有 ${startHave} 个方块` };
    }

    if (!bot.blockAt || !bot.dig) {
        return { ok: false, have: startHave, got: 0, why: '当前 bot 不能挖方块' };
    }

    const t0 = Date.now();
    let got = 0;
    const p = bot.entity.position;

    // 采样附近的地表：从脚下往外一圈圈找可挖的实心方块
    const CANDIDATES = /^(dirt|grass_block|stone|cobblestone|andesite|diorite|granite|deepslate|sand|gravel|netherrack|short_grass|tall_grass|fern)$/;
    const SKIP = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bedrock',
        'chest', 'crafting_table', 'furnace', 'barrel', 'sign', 'torch']);

    while (got < need - startHave && Date.now() - t0 < maxMs) {
        if (bot.interrupt_code) return { ok: false, have: countScaffold(bot), got, why: '被中断' };
        const haveBefore = countScaffold(bot);

        // 找一块最近的、可挖的固体方块
        let target = null, bestD = Infinity;
        for (let r = 1; r <= 6 && !target; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    for (let dy = -3; dy <= 1; dy++) {
                        const b = bot.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz));
                        if (!b || SKIP.has(b.name)) continue;
                        if (!CANDIDATES.test(b.name)) continue;
                        // 别挖脚下的支撑（会掉下去）
                        if (dx === 0 && dz === 0 && dy === -1) continue;
                        // ★ 2026-10-29：优先**水平紧邻**的方块。
                        // 实测挖远处方块时掉落物在 2~3 格外，自动吸附够不到，
                        // 于是"挖了 6 个、背包 0 个"。紧邻格掉落物必然落在身边。
                        const horiz = Math.max(Math.abs(dx), Math.abs(dz));
                        const d = horiz * 1 + Math.abs(dy) * 3;
                        if (d < bestD) { bestD = d; target = b; }
                    }
                }
                if (target) break;
            }
            if (target) break;
        }

        if (!target) {
            return { ok: false, have: countScaffold(bot), got, why: '附近找不到可挖的方块' };
        }

        try {
            // D12：挖也可能永不返回（服务端不回确认/被实体卡住），给个上限。
            const dug = await withTimeout(bot.dig(target), 8000);
            if (dug.timedOut) {
                onEvent({ type: 'scaffold-dig-fail', block: target.name, message: 'dig 超时 8000ms' });
                if (got === 0) {
                    return { ok: false, have: countScaffold(bot), got, why: `挖 ${target.name} 超时` };
                }
                break;
            }
            if (dug.error) throw dug.error;
            got++;
            // ★ 2026-10-29 修：**挖完要走过去把掉落物捡起来**。
            //
            // 原来挖完只 got++，方块掉在地上就走了 → 实测"挖了 4 个，背包只有 1 个"。
            // 而且光"原地等自动吸附"也不保险（实测 got:3 / have:0）：
            // 掉落物可能落在 1~2 格外、或被地形挡住吸引不到。
            //
            // 做法：等一会儿看有没有自己吸进来；没有就走到掉落物旁边再等一次。
            // 每次最多花 ~3 秒，捡不到就继续挖下一个（不无限等）。
            // 先多等一会儿：实测挖掘后掉落物 0.6~1.2 秒才吸完
            for (let w = 0; w < 8; w++) {
                await new Promise(r => setTimeout(r, 250));
                if (countScaffold(bot) > haveBefore) break;
            }
            if (countScaffold(bot) <= haveBefore) {
                try {
                    const drop = bot.nearestEntity?.(e =>
                        e.name === 'item' && e.position && bot.entity.position.distanceTo(e.position) < 4);
                    if (drop) {
                        // D12：捡掉落物的 goto 原来没有上限，会挂死整条链路。
                        const walked = await withTimeout(bot.pathfinder.goto(new pf.goals.GoalNear(
                            drop.position.x, drop.position.y, drop.position.z, 1)), 4000);
                        if (walked.timedOut) stopPathfinder(bot);   // 不复位的话下次 goto 直接报错
                        for (let w = 0; w < 8; w++) {
                            await new Promise(r => setTimeout(r, 200));
                            if (countScaffold(bot) > haveBefore) break;
                        }
                    }
                } catch { /* 捡不到就算了，继续挖下一个 */ }
            }
            onEvent({ type: 'scaffold-dig', block: target.name, got, need });
        } catch (e) {
            // 挖不动（太硬/没镐/被挡），换个位置再试一次，连续失败就退出
            onEvent({ type: 'scaffold-dig-fail', block: target.name, message: String(e?.message ?? e).slice(0, 60) });
            if (got === 0) {
                return { ok: false, have: countScaffold(bot), got, why: `挖不动 ${target.name}（${String(e?.message ?? e).slice(0, 40)}）` };
            }
            break;
        }
    }

    const have = countScaffold(bot);
    return {
        ok: have >= need,
        have, got,
        why: have >= need ? `挖了 ${got} 个，现在有 ${have} 个` : `只凑到 ${have} 个（需要 ${need}）`,
    };
}

/**
 * 给任意 Promise 套一个上限时间（D12）。
 *
 * 为什么需要：`bot.pathfinder.goto()` 和 `bot.dig()` 都可能**永不返回**——
 * 目标被别的实体挡住、区块卸载、服务端不回 `dig` 确认……都会挂在那里。
 * 原来的代码两个都直接 await，于是 `ensureScaffold` 有可能永远不返回，
 * 连带砍树任务整条链卡死（外层只有 deadline，进不到循环里就没人检查）。
 *
 * 超时后**必须**调 `pathfinder.stop()`：pathfinder 被中途打断时不会自己复位，
 * 下一次 `goto` 会直接报 "Path was stopped"。
 *
 * @param {Promise} p 要等的 Promise
 * @param {number} ms 上限（毫秒）
 * @returns {Promise<{timedOut:boolean, value?:any, error?:Error}>}
 */
function withTimeout(p, ms) {
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
    });
    const wrapped = Promise.resolve(p).then(
        (value) => ({ timedOut: false, value }),
        (error) => ({ timedOut: false, error }),
    );
    return Promise.race([wrapped, timeout]).finally(() => clearTimeout(timer));
}

/** 让 pathfinder 停下来并复位（超时/中断后必须调，否则下次 goto 报 "Path was stopped"）。 */
function stopPathfinder(bot) {
    try { bot.pathfinder?.stop?.(); } catch { /* 没有 pathfinder 就算了 */ }
}

function findAnyPlank(bot) {
    const kinds = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
        'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'];
    for (const p of kinds) if (countItem(bot, p) > 0) return p;
    return null;
}

/** 用 mineflayer 的 craft 能力造东西；失败返回 false，不抛。 */
async function tryCraft(bot, itemName, count = 1) {
    if (!bot.craft) return false;
    try {
        const item = bot.registry?.itemsByName?.[itemName];
        if (!item) return false;

        // 先试「不用工作台」（1×1 配方，如木板→木棍其实是 2×1，需要工作台）
        let recipes = bot.recipesFor ? bot.recipesFor(item.id, null, 1, null) : [];
        if (recipes.length) {
            try {
                // D12：craft 同样可能永不返回（窗口没开完/服务端不回包）
                const c = await withTimeout(bot.craft(recipes[0], count, null), 6000);
                if (c.timedOut) throw new Error('craft 超时 6000ms');
                return true;
            } catch { /* 落下去试工作台 */ }
        }

        // 需要工作台：先找附近现成的
        let table = bot.findBlock?.({
            matching: bot.registry.blocksByName?.crafting_table?.id,
            maxDistance: 8,
        });
        if (table) {
            recipes = bot.recipesFor(item.id, null, 1, table);
            if (recipes.length) {
                const c = await withTimeout(bot.craft(recipes[0], count, table), 6000);
                if (!c.timedOut && !c.error) return true;
            }
        }

        // 没有工作台：自己放一个（背包有工作台的话）
        const haveTable = ['crafting_table'].some(n => (bot.inventory?.items() ?? []).some(i => i.name === n));
        if (haveTable) {
            try {
                const { Vec3 } = await import('vec3');
                const p = bot.entity.position.floored();
                const spot = new Vec3(p.x + 2, p.y, p.z);
                const ground = bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z));
                if (ground) {
                    await bot.equip(bot.inventory.items().find(i => i.name === 'crafting_table'), 'hand');
                    await bot.placeBlock(ground, new Vec3(0, 1, 0));
                    await new Promise(r => setTimeout(r, 400));
                    const t2 = bot.blockAt(spot);
                    if (t2?.name === 'crafting_table') {
                        const r3 = bot.recipesFor(item.id, null, 1, t2);
                        if (r3.length) {
                            await bot.craft(r3[0], count, t2);
                            return true;
                        }
                    }
                }
            } catch { /* 放工作台失败就算了 */ }
        }

        return false;
    } catch (e) {
        if (process.env.COLLECT_DEBUG) console.log(`[craft] ${itemName} 失败:`, e.message);
        return false;
    }
}
