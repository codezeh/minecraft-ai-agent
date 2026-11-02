/**
 * 流程：收一轮庄稼（M7 P0，04 §6.1 卡片 `flow_farm`）。
 *
 * 卡片原文：
 *   plan：扫区域 → 成熟的 `harvestCrop` → 空耕地 `plantSeed` → 裸泥土 `tillSoil`
 *         → 可选 `boneMeal` → `pickup`
 *   **一次调用只做一轮**，不在内部循环；要定期收由策略层或玩家再下单
 *   onFail：`NOT_READY` → `skip`；种子用完（`NO_ITEM`）→ 后面的种植步骤 `skip`，收割照做
 *   完成：返回 `{harvested, planted}`
 *
 * 注意"一次只做一轮"——这不是偷懒，是卡片的规定：定期收割应该由策略层决定节奏，
 * 流程里再套 while 会让"一轮多久"变得不可预测，也没法被调度器打断。
 */
import { ok, fail } from './contract.js';
import { harvestCrop, plantSeed, tillSoil } from './act_farm.js';
import { blockAt, countItem } from './query_perceive.js';
import { mapDirOf } from './bot_paths.js';
import { goTo } from './nav_core.js';
import { collectDrops } from './flow_pickup.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'farm',
    level: 'flow',
    summary: '收一轮庄稼：成熟的收掉、空耕地补种、裸土翻耕（一次只做一轮）',
    params: {
        area: 'area',
        crop: 'string?',
        seed: 'item?',
    },
    needs: { items: ['种子', '锄?'], near: [] },
    claims: [],
    codes: ['NO_TARGET', 'NO_ITEM', 'NO_TOOL', 'NOT_READY', 'OUT_OF_REACH', 'OCCUPIED', 'BLOCKED', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: false,
    timeoutMs: 4 * 60 * 1000,
};

/** 默认收哪些作物（卡片参数 crop 可覆盖）。 */
const CROPS = ['wheat', 'carrots', 'potatoes', 'beetroots'];
const MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };

/** 作物 → 种子名。 */
const SEED_OF = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' };

/** 扫区域内所有方块坐标（水平半径 radius、上下各 2 格）。 */
function scanArea(bot, center, radius) {
    const out = [];
    const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -2; dy <= 2; dy++) {
                const p = { x: cx + dx, y: cy + dy, z: cz + dz };
                const b = blockAt(bot, p);
                if (b) out.push(b);
            }
        }
    }
    return out;
}

/** 走到目标附近（够不着才走）。返回是否到位。 */
async function approach(bot, pos, ctx, tol = 3) {
    const self = bot.entity?.position;
    if (!self) return false;
    const d = Math.hypot(pos.x + 0.5 - self.x, pos.z + 0.5 - self.z);
    if (d <= tol) return true;
    const walked = await goTo(bot, { kind: 'point', pos: { x: pos.x, y: pos.y, z: pos.z } }, {
        mapDir: mapDirOf(bot),
        deadlineMs: Math.max(4000, Math.min((ctx?.deadline ?? Date.now() + 30000) - Date.now(), 30000)),
        arriveTol: 2,
    });
    return walked.ok;
}

/**
 * 收一轮庄稼。
 *
 * @param {object} area {x,y,z,radius}（`!do` 的 area 记法会带 radius）
 * @returns ActionResult
 *   ok        → data: { harvested, planted, tilled, skipped, want, count }
 *   NO_TARGET 区域里什么都没有 / 没给区域
 *   NO_ITEM   种子用完了（但**收割照做**，只是不再补种 —— 这时返回 ok 带 planted:0）
 */
export async function farm(bot, area, opts = {}) {
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!area || !Number.isFinite(area.x) || !Number.isFinite(area.z)) {
        return fail('NO_TARGET', '没给区域（area=x,y,z:半径）');
    }
    const radius = Math.max(1, Math.min(16, Math.floor(Number(area.radius) || 4)));
    const crops = (opts.crop ? [String(opts.crop)] : CROPS);

    const blocks = scanArea(bot, area, radius);
    if (!blocks.length) return fail('NO_TARGET', '区域里读不到方块（未加载？）', { area: { ...area, radius } });

    let harvested = 0, planted = 0, tilled = 0, skipped = 0;
    let seedsLeft = true;

    // ① 先收成熟的（按卡片：收割优先，种子没了也要收）
    for (const b of blocks) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { harvested, planted, want: 0, count: harvested });
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;
        if (!crops.includes(b.name)) continue;

        const age = Number(b.getProperties?.()?.age ?? -1);
        const max = MAX_AGE[b.name];
        if (max == null || age < max) continue;                 // 没熟 → 跳过（卡片：NOT_READY → skip）

        await approach(bot, b.position, ctx);
        const r = await harvestCrop(bot, { pos: { x: b.position.x, y: b.position.y, z: b.position.z } });
        if (r.ok) { harvested++; continue; }
        if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { harvested, planted, want: 0, count: harvested });
        skipped++;                                              // NOT_READY / OCCUPIED / 其它 → 跳过这一棵
    }

    // ② 再补种：空耕地（上方是空气的 farmland）→ plantSeed
    for (const b of blocks) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { harvested, planted, want: 0, count: harvested });
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;
        if (b.name !== 'farmland') continue;

        const above = blockAt(bot, { x: b.position.x, y: b.position.y + 1, z: b.position.z });
        const empty = !above || ['air', 'cave_air', 'void_air'].includes(above.name);
        if (!empty) continue;                                   // 已经有作物了

        if (!seedsLeft) { skipped++; continue; }

        // 选种子：opts.seed 优先，否则按"背包里有的"挑
        const seed = opts.seed && countItem(bot, opts.seed) > 0
            ? opts.seed
            : Object.values(SEED_OF).find((s) => countItem(bot, s) > 0);
        if (!seed) {
            // 种子用完 → 后面的种植步骤 skip（卡片明确要求），收割照做
            seedsLeft = false;
            skipped++;
            continue;
        }

        await approach(bot, b.position, ctx);
        const r = await plantSeed(bot, { pos: { x: b.position.x, y: b.position.y, z: b.position.z } }, seed);
        if (r.ok) { planted++; continue; }
        if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { harvested, planted, want: 0, count: harvested });
        if (r.code === 'NO_ITEM') seedsLeft = false;
        skipped++;
    }

    // ③ 可选：裸泥土翻耕（只在有锄的时候做；没有就跳过，不报错）
    const hasHoe = (bot.inventory?.items?.() ?? []).some((i) => /_hoe$/.test(i?.name ?? ''));
    if (hasHoe && Date.now() < (ctx.deadline ?? Infinity)) {
        for (const b of blocks) {
            if (bot?.interrupt_code) break;
            if (!/^(dirt|grass_block)$/.test(b.name)) continue;
            // 只翻"上方是空气"的（真正能当地的地）
            const above = blockAt(bot, { x: b.position.x, y: b.position.y + 1, z: b.position.z });
            if (above && !['air', 'cave_air', 'void_air'].includes(above.name)) continue;
            await approach(bot, b.position, ctx);
            const r = await tillSoil(bot, { pos: { x: b.position.x, y: b.position.y, z: b.position.z } });
            if (r.ok) tilled++;
            if (r.code === 'INTERRUPTED') break;
        }
    }

    // ④ 捡走掉在地上的作物（卡片列在最后一步）
    if (harvested > 0) {
        try {
            await collectDrops(bot, { x: area.x, y: area.y, z: area.z }, {
                radius: radius + 2,
                deadlineMs: Math.max(2000, Math.min((ctx.deadline ?? Date.now() + 4000) - Date.now(), 8000)),
            });
        } catch { /* 捡不到不影响收割结果 */ }
    }

    // 完成判据：返回 {harvested, planted}（卡片原文）
    return ok({
        harvested,
        planted,
        tilled,
        skipped,
        want: 0,
        count: harvested,
        area: { ...area, radius },
        costMs: Date.now() - t0,
    });
}
