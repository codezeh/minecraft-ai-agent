/**
 * 流程：天黑前搭一个能过夜的小屋（M10，04 §6.1/§6.3 的 `flow_shelter`）。
 *
 * 04 §6.1 对它的全部描述只有一句：「`flow_shelter` | 天黑前搭一个能过夜的小屋 | P1 | 🆕」。
 * 所以本文件按"能过夜"这个唯一硬需求定义行为：
 *   **一个 3×3 的封闭壳**（墙 + 顶 + 地板），中间留 1 格空气给她站着。
 *   3×3 是能塞下一个人、又只用 20 来块材料的最小尺寸。
 *
 * ★ 为什么**不自己放方块**，而是交给 `flow_build`：
 *   `flow_build` 已经做过这几件事且都有用例：先算材料（不够一块都不建）、
 *   自下而上排序、`findStandSpot` 找站位、**`query_safe.fallRisk` 防踩空**、逐格读回校验。
 *   在 `flow_shelter` 里重写一遍就是第二套真相（本项目反复踩的坑）。
 *   所以这里只干"**把屋子算成一份蓝图**"这一件事。
 *
 * ★ 一定要能被打断：`flow_build` 每格都查 `bot.interrupt_code`，所以天黑搭一半被玩家叫停
 *   会如实返回 INTERRUPTED（而不是硬撑着搭完）。
 */
import { ok, fail } from './contract.js';
import { build } from './flow_build.js';
import { blockAt } from './query_perceive.js';
import { countItem } from './query_perceive.js';
import { findStandSpot } from './query_stand.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'shelter',
    level: 'flow',
    summary: '天黑前搭一个能过夜的小屋（默认 3×3、1 层墙 + 顶 ≈17 格，够挡视线和怪）',
    params: {
        block: 'string?',        // 用什么材料，默认 cobblestone（拿不到会自动挑）
        size: 'int 3..7 = 3',    // 边长：3 → 3×3（内空 1 格）。想要更大的显式传
        floor: 'string?',        // 'auto'（默认）= 脚下不是实心才补地板；'always' / 'never'
    },
    needs: { items: ['建筑材料 ≥20'], near: [] },
    claims: ['area:<自己周围>'],
    codes: ['NO_ITEM', 'NO_TARGET', 'NO_SUPPORT', 'UNSAFE', 'OUT_OF_REACH', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: true,
    timeoutMs: 5 * 60 * 1000,
};

/** 挑一种她手上有的建筑材料（优先结实、再退到任何方块）。 */
const PREFERRED = ['cobblestone', 'stone', 'oak_planks', 'birch_planks', 'dirt', 'oak_log', 'birch_log'];
function pickMaterial(bot, want) {
    if (want && countItem(bot, want) > 0) return want;
    for (const m of PREFERRED) if (countItem(bot, m) > 0) return m;
    // 退一步：背包里任何"看起来能当方块"的（排除工具/食物这类明显不是方块的）
    const items = bot?.inventory?.items?.() ?? [];
    const bad = /(_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|_seeds?$|apple|bread|_ingot$|_nugget$|coal|stick|torch|bone_meal|string|feather|leather|_dye$)/;
    const hit = items.find((i) => i?.name && !bad.test(i.name) && (i.count ?? 0) > 0);
    return hit?.name ?? null;
}

/**
 * 算一份 3×3 小屋蓝图（**纯计算，不放方块**）。
 *
 * 形状（y = 脚位层）：
 *   · 地板：y-1 的 3×3（她已经站的那格多半已有）
 *   · 墙：  y、y+1 两层的**外圈 8 格**（中间 (0,0) 留空给她站）
 *   · 顶：  y+2 的 3×3 全覆盖
 * 合计 9 + 8 + 8 + 9 = 34 格，但**已存在的方块会被 build 跳过**（它逐格读回校验），
 * 实际用料通常 20 出头。
 *
 * @param {{x:number,y:number,z:number}} feet 她的脚位
 * @param {string} material
 * @param {number} half 半边长（1 → 3×3）
 * @returns {Array<{x:number,y:number,z:number,name:string}>}
 */
export function shelterBlueprint(feet, material, size = 3, opts = {}) {
    const cx = Math.floor(feet.x), cy = Math.floor(feet.y), cz = Math.floor(feet.z);
    const n = Math.max(3, Math.min(7, Math.floor(Number(size) || 3)));
    const half = Math.floor(n / 2);
    const out = [];
    const put = (x, y, z) => out.push({ x, y, z, name: material });

    // ── 地板（可选）─────────────────────────────────────────────────
    // ★ 默认**不铺**：脚下通常已经是地面，铺 9 块纯属浪费（第一夜要快）。
    //   `floor:'always'` 才铺满；`'auto'` 只在脚下那格不是实心时补 1 块。
    const floorMode = String(opts.floor ?? 'auto');
    if (floorMode === 'always') {
        for (let dx = -half; dx <= half; dx++) {
            for (let dz = -half; dz <= half; dz++) put(cx + dx, cy - 1, cz + dz);
        }
    } else if (floorMode === 'auto') {
        const under = opts.underBlockName ?? null;      // 调用方传"脚下那格是什么"
        const solid = under && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(under);
        if (!solid) put(cx, cy - 1, cz);               // 只在需要时补 1 块
    }

    // ── 墙：**1 层**（y）的外圈 ────────────────────────────────────
    //   原来是 2 层（y、y+1）；缩到 1 层是为了进预算（第一夜挡一下，不盖房）。
    //   1 层墙 + 顶仍然挡视线、挡怪进不来。
    for (let dx = -half; dx <= half; dx++) {
        for (let dz = -half; dz <= half; dz++) {
            const edge = Math.abs(dx) === half || Math.abs(dz) === half;
            if (!edge) continue;                       // 中间留空（她要站在里面）
            put(cx + dx, cy, cz + dz);
        }
    }

    // ── 顶（y+1）的四边 ──────────────────────────────────────────
    const roof = [];
    for (let dx = -half; dx <= half; dx++) {
        for (let dz = -half; dz <= half; dz++) roof.push([cx + dx, cy + 1, cz + dz]);
    }
    const isCenter = ([x, , z]) => x === cx && z === cz;
    for (const [x, y, z] of roof.filter((c) => !isCenter(c))) put(x, y, z);
    return out;
}

/**
 * 最后要"出门才能封"的那一格：屋顶正中（正好在她头顶那列）。
 *
 * ★ 为什么要单独拿出来（2026-11-03）：`act_place.js` 明确拒绝往**自己身体所在列**
 *   （`feet.y` 或 `feet.y+1`）放方块 —— 这是正确的安全规则（往身上放会把方块卡进身体，
 *   B1 那次"活埋→窒息→背包清空→假 NO_TOOL"就是这类事故）。
 *   而 3×3 带 1×1 内空时，屋顶正中**必然**在她头顶列 → **站在屋里永远封不上**。
 *   所以流程必须：搭完墙+顶圈 → **走到屋外相邻一格** → 封正中 → 再回屋。
 */
export function capCell(feet, size = 3) {
    const cy = Math.floor(feet.y), cx = Math.floor(feet.x), cz = Math.floor(feet.z);
    return { x: cx, y: cy + 1, z: cz };
}

/**
 * 搭一个能过夜的小屋。
 *
 * @param {object} opts { block, radius, ctx }
 * @returns ActionResult
 *   ok          → data: { material, placed, want }
 *   NO_ITEM     没有建筑材料（abort：先 strat_obtain 砖石/木头）
 *   NO_TARGET   脚下读不到方块（没加载）
 *   NO_SUPPORT / UNSAFE / OUT_OF_REACH  由 flow_build 透传
 */
export async function shelter(bot, opts = {}) {
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const feet = bot?.entity?.position;
    if (!feet || !Number.isFinite(feet.x)) return fail('NO_TARGET', '读不到自己的位置');
    // 脚下要读得到（否则是没加载，别在虚空里搭屋子）
    const below = blockAt(bot, { x: Math.floor(feet.x), y: Math.floor(feet.y) - 1, z: Math.floor(feet.z) });
    if (!below) return fail('NO_TARGET', '脚下那格读不到（区块没加载？）');

    const t0 = Date.now();
    const material = pickMaterial(bot, opts.block ?? null);
    if (!material) {
        return fail('NO_ITEM', '没有能当墙的材料（先弄点圆石/木头）', { missing: { cobblestone: 20 } });
    }

    // size 默认 3（内空 1 格）；要更大的显式传
    const size = Math.max(3, Math.min(7, Math.floor(Number(opts.size) || 3)));
    const blocks = shelterBlueprint(feet, material, size, {
        floor: opts.floor ?? 'auto',
        underBlockName: below?.name ?? null,
    });

    // 材料够不够？先粗算（flow_build 还会再精算一次，双保险）
    const need = blocks.length;
    const have = countItem(bot, material);
    if (have <= 0) {
        return fail('NO_ITEM', `没有 ${material} 了`, { missing: { [material]: need } });
    }

    // 交给 flow_build：它负责排序/站位/防踩空/读回校验
    const r = await build(bot, blocks, { ctx });

    // ── ★ 先出后封（2026-11-03 用户选定的方案）──────────────────────
    //
    // 墙 + 顶圈放完，最后剩**屋顶正中**那一格 —— 它正好在她头顶列，
    // `act_place` 会（正确地）拒绝。所以：
    //   ① 走到**屋外相邻一格**
    //   ② 确认真的出格了（不是"看起来走开了"）
    //   ③ 封正中 + 逐格读回校验
    //   ④ 走回屋里（进屋是普通移动，不必再校验）
    //
    // 只在"墙+顶圈都成了、就差正中"时才走这条路；其它失败原样透传。
    const cap = capCell(feet, size);
    const capDone = (() => {
        const cur = blockAt(bot, cap);
        return !!cur && cur.name !== 'air' && !['cave_air', 'void_air'].includes(cur.name);
    })();

    let capped = capDone;
    let capNote = capDone ? 'already-sealed' : null;
    if (!capDone && placedCount0(r) >= blocks.length - 1) {
        const seals = await sealRoofCenter(bot, cap, material, ctx);
        capped = seals.ok;
        capNote = seals.ok ? 'sealed-outside' : seals.reason;
        if (seals.ok) {
            // ★ 封上了：虽然 build 那一步是"17 缺 1"，但整体已经达成"能过夜"的目标。
            //   所以这里返回 ok，并在 data 里如实写清"正中是先出后封补上的"。
            return ok({
                material,
                placed: placedCount0(r) + 1,
                want: need, total: need,
                sealedBy: 'exit-then-cap',
                note: '墙 + 顶圈 + 正中全部就位（正中是先走到屋外再封的）',
                costMs: Date.now() - t0,
            });
        }
        if (!seals.ok) {
            // 封不上就如实报，不假装成功
            return fail(seals.code ?? 'BLOCKED', `墙和顶圈搭好了，但屋顶正中封不上：${seals.message ?? ''}`, {
                material, want: need, total: need,
                placed: placedCount0(r) + (seals.placed ?? 0),
                remaining: seals.ok ? 0 : 1,
                reason: seals.reason ?? null,
                costMs: Date.now() - t0,
            });
        }
    }
    if (r.ok) {
        return ok({
            material,
            placed: r.data?.placed ?? need,
            want: need,
            note: '小屋搭好了（3×3 封闭壳）',
        });
    }

    // ★ 把"预算不够"变成可观测的（2026-11-03 用户要求）：
    //   `placed/total/costMs` 一眼看出是"没放完"（placed 接近 total、costMs 顶到 timeout）
    //   还是"卡住了"（placed 很小但时间用光 / 频繁失败）。
    const costMs = Date.now() - t0;
    const placedCount = Number(r.data?.placed ?? 0);
    const observable = {
        material, want: need, total: need,
        placed: placedCount, costMs,
        remaining: Math.max(0, need - placedCount),
        ...(r.data ?? {}),
    };

    // 透传 build 的码；但把"材料不够"说清楚（那是上层该去 obtain 的信号）
    if (r.code === 'NO_ITEM') {
        return fail('NO_ITEM', `材料不够搭小屋：${r.message ?? ''}`, {
            ...observable,
            missing: r.data?.missing ?? { [material]: need },
        });
    }
    if (r.code === 'TIMEOUT') {
        return fail('TIMEOUT',
            `小屋没搭完：${placedCount}/${need} 块，用了 ${Math.round(costMs / 1000)} 秒`
            + `（${placedCount >= need - 2 ? '差一点没放完' : '中途卡住了'}）`, observable);
    }
    return fail(r.code ?? 'INTERNAL', r.message ?? '搭小屋失败', observable);
}

/** 从 build 的返回里数"放上了几块"（ok 或失败都可能带）。 */
function placedCount0(r) {
    return Number(r?.data?.placed ?? 0);
}

/**
 * 走到屋外相邻一格 → 封屋顶正中 → 读回校验 → 走回屋里。
 *
 * 只做这一格，不碰别的。走出去会**确认真的出格了**（不是"看起来走开了"）。
 */
async function sealRoofCenter(bot, cap, material, ctx) {
    const feet = bot.entity.position;
    const cx = Math.floor(feet.x), cy = Math.floor(feet.y), cz = Math.floor(feet.z);

    // ① 选一个"屋外相邻"的落脚点：墙外一格（3×3 的墙在 ±1，所以外面是 ±2）
    const outs = [
        { x: cx + 2, y: cy, z: cz }, { x: cx - 2, y: cy, z: cz },
        { x: cx, y: cy, z: cz + 2 }, { x: cx, y: cy, z: cz - 2 },
    ].filter((p) => {
        const b = blockAt(bot, p);
        return b && ['air', 'cave_air', 'void_air'].includes(b.name);   // 站得下
    });
    if (!outs.length) return { ok: false, code: 'OUT_OF_REACH', reason: 'no-outside-spot', message: '找不到能站的屋外格子' };

    const spot = outs[0];
    const { goTo } = await import('./nav_core.js');
    const { mapDirOf } = await import('./bot_paths.js');
    const mv = await goTo(bot, { kind: 'point', pos: spot }, {
        mapDir: mapDirOf(bot),
        deadlineMs: Math.max(3000, Math.min((ctx?.deadline ?? Date.now() + 15000) - Date.now(), 15000)),
        arriveTol: 0.8,
    });

    // ② **确认真的出格了**（不能只看 goTo 说 ok）
    const nowFeet = bot.entity.position;
    const outX = Math.floor(nowFeet.x), outZ = Math.floor(nowFeet.z);
    const stillInside = (Math.abs(outX - cx) <= 1) && (Math.abs(outZ - cz) <= 1);
    if (!mv.ok || stillInside) {
        return { ok: false, code: 'OUT_OF_REACH', reason: 'still-inside', message: '没能走到屋外（还在屋里）' };
    }

    // ③ 封正中
    const { placeBlockAt } = await import('./act_place.js');
    const put = await placeBlockAt(bot, cap, material, {});

    // ④ 读回校验
    const cur = blockAt(bot, cap);
    const sealed = !!cur && cur.name !== 'air' && !['cave_air', 'void_air'].includes(cur.name);

    // ⑤ 走回屋里（普通移动，不必再校验）
    try {
        await goTo(bot, { kind: 'point', pos: { x: cx + 0.5, y: cy, z: cz + 0.5 } }, {
            mapDir: mapDirOf(bot),
            deadlineMs: Math.max(2000, Math.min((ctx?.deadline ?? Date.now() + 10000) - Date.now(), 10000)),
            arriveTol: 0.8,
        });
    } catch { /* 回不去也不影响"封上了"这个事实 */ }

    return {
        ok: put.ok && sealed,
        code: put.ok ? 'BLOCKED' : (put.code ?? 'BLOCKED'),
        reason: put.ok ? 'readback-failed' : (put.data?.reason ?? null),
        message: put.ok ? '放下去了但读回不是目标方块' : (put.message ?? ''),
        placed: sealed ? 1 : 0,
    };
}
