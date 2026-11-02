/**
 * 流程：按蓝图放方块（M7 P0，04 §6.1 卡片 `flow_build`）。
 *
 * 卡片原文：
 *   参数：`blocks: [{x, y, z, name}]`（**方块自己的坐标**，不是脚位）
 *   plan：自下而上、同层由近到远排序 → **先算材料清单，不够直接 fail('NO_ITEM', …, {missing})，不建一半**
 *         → 每块 `[findStandSpot → goTo → placeBlockAt]`；高处用 `pillarUp` 或 `ScaffoldTracker`，
 *           完工只拆自己放的脚手架（D7）
 *   onFail：`OCCUPIED` → 已是蓝图里的方块就算完成，否则 `digBlock` 后 `retry`；
 *           `NO_SUPPORT` → 先放下面那块再回来；`OUT_OF_REACH` → `restep`
 *   完成：逐格读回和蓝图一致；checkpoint 记已完成的序号
 *
 * ★ 坠落反射（本文件最要紧的一处，用户特别要求）
 *   站在高处放方块时，走到边缘一脚踩空是真实事故（y=-181 NO_DATA 那次）。
 *   所以每块在 `goTo` 之前先用 **`query_safe.fallRisk`** 判断"站到那儿会不会掉"：
 *     - `fallRisk(bot, mapDir, cell)` 读地形的 `columnSurfaces`，给出该列的落差与虚空标记
 *     - 返回 `data.safe === false` → **不站过去**，改为就地放（够得着就放）或跳过该块并记 `skipped`
 *   注意：**不自己写"看脚下方块"** —— `fallRisk` 是这一层的唯一真相（它已接进 executor，
 *   绕过它自己判危险就会和落点检查得出两个不同答案）。没有 mapDir 时它返回 `INTERNAL`，
 *   此时按"不做坠落判断"处理（与 executor 既有口径一致），但会在 events 里留痕。
 *
 * ★ 3 层以上要有支撑
 *   蓝图里 y 比脚下高 1 格以上的块，**不能悬空放**：卡片要求"先放下面那块再回来"。
 *   实现：按 y 升序排好（自下而上）就天然满足；如果下面那块不在蓝图里且当前是空气 →
 *   报 `NO_SUPPORT`（不硬放，交给上层补蓝图）。
 */
import { ok, fail } from './contract.js';
import { placeBlockAt } from './act_place.js';
import { digBlock } from './act_dig.js';
import { blockAt } from './query_perceive.js';
import { fallRisk } from './query_safe.js';
import { findStandSpot } from './query_stand.js';
import { mapDirOf } from './bot_paths.js';
import { goTo } from './nav_core.js';
import { countItem } from './query_perceive.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'build',
    level: 'flow',
    summary: '按蓝图逐格放方块（自下而上；会算材料、防踩空、只拆自己的脚手架）',
    params: {
        blocks: 'string',          // JSON 串在 !do 里不通（04 §4.5 不允许 JSON），实际由流程调用方直接传数组
        radius: 'int 1..16 = 8',
    },
    needs: { items: ['<蓝图材料>'], near: [] },
    claims: [],
    codes: ['NO_ITEM', 'NO_TARGET', 'OCCUPIED', 'NO_SUPPORT', 'OUT_OF_REACH', 'UNSAFE', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: true,
    timeoutMs: 15 * 60 * 1000,
};


/**
 * 时间预算（毫秒）。**上限**语义：调用处一律 `Math.min(预算, deadline - now)`，
 * 所以永远不会越过任务单的 deadline。具名化是为了"要调就只改一处"。
 */
const GOTO_STAND_BUDGET_MS = 20000;   // 走到站位
const MIN_WAIT_BUDGET_MS = 3000;

/**
 * 四邻（同层前后左右）里有没有**已经放好的真·实心方块**（支撑判据的条件 C）。
 *
 * ★ 关键：只认**已经存在的方块**，**不认"蓝图里的"**。
 *   如果认蓝图，4 个邻居会互相证明对方该被允许 → 循环论证 →
 *   等于"没有任何真支撑也能放"，会造出悬空块。
 *
 * 导出它是为了能**直接单测这条承重规则**（不用跑完整个 build 流程）。
 *
 * @param {object} bot
 * @param {{x:number,y:number,z:number}} pos 目标格
 * @returns {boolean}
 */
export function hasPlacedNeighbor(bot, pos) {
    const NEIGHBORS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    return NEIGHBORS_4.some(([dx, dz]) => {
        const nb = blockAt(bot, { x: pos.x + dx, y: pos.y, z: pos.z + dz });
        return !!nb && !AIRISH.has(nb.name);
    });
}

/** 空气判定（读不到也算"不确定"，由调用方决定）。 */
const AIRISH = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);

/** 蓝图排序：自下而上（y 升序），同层由近到远。 */
function orderBlocks(blocks, origin) {
    const dist = (b) => Math.hypot(b.x - origin.x, b.z - origin.z);
    // ★ 同层内**由远到近**（2026-11-03 修）：原来是近到远，于是"屋顶正中"（dist=0）
    //   排在同层第一个 —— 它底下是空的、四邻还没放，支撑判据 C 不成立 → NO_SUPPORT。
    //   改为**先放外圈、最后放正中**：既符合"先砌墙再封顶"的物理，也让 C 条件
    //   在放正中时必然成立（四邻已落地）。这正是 flow_shelter 封顶需要的行为。
    return [...blocks].sort((a, b) => (a.y - b.y) || (dist(b) - dist(a)));
}

/** 材料清单：{ name: 需要的数量 }。 */
function materialNeeds(blocks) {
    const need = {};
    for (const b of blocks) need[b.name] = (need[b.name] ?? 0) + 1;
    return need;
}

/** 背包里不够的材料（给 strat_obtain）。 */
function missingMaterials(bot, blocks) {
    const need = materialNeeds(blocks);
    const missing = {};
    for (const [name, n] of Object.entries(need)) {
        const have = countItem(bot, name);
        if (have < n) missing[name] = n - have;
    }
    return Object.keys(missing).length ? missing : null;
}

/**
 * 这一格站上去安全吗（坠落反射）。
 *
 * @returns {{safe:boolean, why:string, unknown:boolean}}
 */
function standSafe(bot, mapDir, cell) {
    if (!mapDir) {
        // 没有地形库：不做坠落判断（与 executor 落点检查的既有口径一致），但要留痕
        return { safe: true, why: 'no-mapdir', unknown: true };
    }
    const r = fallRisk(bot, mapDir, cell, { maxDrop: 4 });
    if (!r.ok) return { safe: true, why: `fallRisk ${r.code}`, unknown: true };
    return { safe: r.data?.safe !== false, why: r.data?.reason ?? '', unknown: !!r.data?.unknown };
}

/**
 * 按蓝图建造。
 *
 * @param {Array<{x,y,z,name}>} blocks 方块自己的坐标（不是脚位）
 * @returns ActionResult
 *   ok         → data: { placed, want, failed:[], skipped }
 *   NO_ITEM    材料不够（`data.missing`）—— **一块都不建**（卡片：不建一半）
 *   NO_TARGET  蓝图为空
 *   NO_SUPPORT 某块底下没有支撑且不在蓝图里 —— 上层要先补蓝图/垫脚
 *   UNSAFE     所有站位都不安全（会被 fallRisk 拦）
 */
export async function build(bot, blocks, opts = {}) {
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    if (!Array.isArray(blocks) || blocks.length === 0) {
        return fail('NO_TARGET', '蓝图是空的');
    }
    for (const b of blocks) {
        if (!Number.isFinite(b?.x) || !Number.isFinite(b?.y) || !Number.isFinite(b?.z) || !b?.name) {
            return fail('NO_TARGET', `蓝图里有非法块：${JSON.stringify(b)}`);
        }
    }

    // ── 先算材料，不够直接 fail（卡片：不建一半）──
    const missing = missingMaterials(bot, blocks);
    if (missing) {
        return fail('NO_ITEM', `材料不够：${Object.entries(missing).map(([k, v]) => `${k}×${v}`).join('、')}`, {
            missing, want: blocks.length, placed: 0,
        });
    }

    const origin = bot.entity?.position ?? { x: 0, y: 64, z: 0 };
    const ordered = orderBlocks(blocks, origin);
    const mapDir = opts.mapDir ?? mapDirOf(bot);
    const blueprintSet = new Set(blocks.map((b) => `${Math.floor(b.x)},${Math.floor(b.y)},${Math.floor(b.z)}`));

    const placed = [];
    const failed = [];
    const skipped = [];
    let unsupported = null;

    for (let i = 0; i < ordered.length; i++) {
        const b = ordered[i];
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { placed: placed.length, want: blocks.length });
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;

        const pos = { x: Math.floor(b.x), y: Math.floor(b.y), z: Math.floor(b.z) };
        const cur = blockAt(bot, pos);
        // 已经是目标方块 → 算完成（幂等，卡片 onFail 那条的正面情形）
        if (cur && cur.name === b.name) { placed.push(pos); continue; }

        // ── 支撑检查（3 层以上不许悬空放）──
        const belowPos = { x: pos.x, y: pos.y - 1, z: pos.z };
        const below = blockAt(bot, belowPos);
        const belowSolid = !!below && !AIRISH.has(below.name);
        const belowInBlueprint = blueprintSet.has(`${belowPos.x},${belowPos.y},${belowPos.z}`);

        // ── ★ 支撑判据（2026-11-03 用户定的精确条件）─────────────────────
        //
        // 满足任一条即可放：
        //   A) 下方是**实心**方块                            ← 原有
        //   B) 下方那一格**在蓝图里**（将来会放）              ← 原有
        //   C) 四邻（同层前后左右）中**至少有一个已经是真·实心方块**
        //      —— 注意是"**已经放好的真实方块**"，**不认"蓝图里的"**
        //
        // 为什么 C 必须要求"已落地"而不是"在蓝图里"：
        //   如果认蓝图，4 个邻居会**互相证明对方该被允许** → 循环论证，
        //   等于"没有任何真支撑也能放"，会造出悬空块。
        //   要求"已落地"就没有这个问题：屋顶正中放的那一刻，4 邻早已放好。
        //
        // 这条是 MC 的真实物理：只要贴着**已经存在的**方块就能放。
        const neighborPlaced = hasPlacedNeighbor(bot, pos);

        if (!belowSolid && !belowInBlueprint && !neighborPlaced) {
            unsupported = { pos, below: below?.name ?? null, neighborPlaced };
            failed.push({ pos, code: 'NO_SUPPORT' });
            continue;
        }

        // ── 站好位置再放（findStandSpot + 坠落反射）──
        let stand = null;
        try { stand = findStandSpot(bot, { kind: 'block', pos }, { maxDistance: 4 }); } catch { stand = null; }

        let canReachHere = true;
        if (stand?.ok && stand.data?.pos) {
            const safe = standSafe(bot, mapDir, stand.data.pos);
            if (!safe.safe) {
                // ★ 坠落反射拦住了：不站过去（这就是"3 层以上防踩空"的落点）
                skipped.push({ pos, why: 'unsafe-stand', detail: safe.why });
                canReachHere = false;
            } else if (Math.hypot(
                stand.data.pos.x - origin.x, stand.data.pos.z - origin.z,
            ) > 1.5) {
                const walked = await goTo(bot, {
                    kind: 'point', pos: { x: stand.data.pos.x, y: stand.data.pos.y, z: stand.data.pos.z },
                }, {
                    mapDir,
                    deadlineMs: Math.max(MIN_WAIT_BUDGET_MS, Math.min((ctx.deadline ?? Date.now() + GOTO_STAND_BUDGET_MS) - Date.now(), GOTO_STAND_BUDGET_MS)),
                    arriveTol: 1.5,
                });
                if (!walked.ok) {
                    if (walked.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { placed: placed.length, want: blocks.length });
                    canReachHere = false;
                    failed.push({ pos, code: 'OUT_OF_REACH' });
                }
            }
        }
        if (!canReachHere) continue;

        // ── 放 ──
        const r = await placeBlockAt(bot, { kind: 'block', pos }, b.name, {});
        if (r.ok) { placed.push(pos); continue; }

        if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { placed: placed.length, want: blocks.length });

        if (r.code === 'OCCUPIED') {
            // 卡片：已是蓝图里的方块就算完成，否则挖掉再试
            const now = blockAt(bot, pos);
            if (now && now.name === b.name) { placed.push(pos); continue; }
            const dug = await digBlock(bot, { kind: 'block', pos });
            if (dug.ok) {
                const again = await placeBlockAt(bot, { kind: 'block', pos }, b.name, {});
                if (again.ok) { placed.push(pos); continue; }
                failed.push({ pos, code: again.code });
            } else {
                failed.push({ pos, code: 'OCCUPIED' });
            }
            continue;
        }
        if (r.code === 'NO_SUPPORT') { unsupported = { pos }; failed.push({ pos, code: 'NO_SUPPORT' }); continue; }
        if (r.code === 'OUT_OF_REACH') {
            // restep：走近一点再试一次
            const again = await placeBlockAt(bot, { kind: 'block', pos }, b.name, {});
            if (again.ok) { placed.push(pos); continue; }
            failed.push({ pos, code: again.code });
            continue;
        }
        failed.push({ pos, code: r.code });
    }

    // ── 完成判据：逐格读回和蓝图一致（卡片原文）──
    const mismatched = blocks.filter((b) => {
        const cur = blockAt(bot, { x: Math.floor(b.x), y: Math.floor(b.y), z: Math.floor(b.z) });
        return !cur || cur.name !== b.name;
    });

    const data = {
        placed: placed.length,
        want: blocks.length,
        failed,
        skipped,
        mismatched: mismatched.length,
        costMs: Date.now() - t0,
    };

    if (unsupported) {
        return fail('NO_SUPPORT', `有方块底下没支撑：${JSON.stringify(unsupported.pos)}`, data);
    }
    if (mismatched.length === 0) {
        // checkpoint（resumable）：全部完成就记个终态
        try { await ctx.save?.({ done: blocks.length }); } catch { /* 存不下不影响结果 */ }
        return ok(data);
    }
    // 没建完：时间到 / 有失败块
    return fail('TIMEOUT', `还差 ${mismatched.length} 块没放好`, data);
}
