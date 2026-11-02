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
    summary: '天黑前搭一个能过夜的小屋（3×3 封闭壳：墙+顶+地板，中间留 1 格）',
    params: {
        block: 'string?',        // 用什么材料，默认 cobblestone（拿不到会自动挑）
        radius: 'int 2..8 = 3',  // 半边长：3 → 3×3
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
export function shelterBlueprint(feet, material, half = 1) {
    const cx = Math.floor(feet.x), cy = Math.floor(feet.y), cz = Math.floor(feet.z);
    const out = [];
    const put = (x, y, z) => out.push({ x, y, z, name: material });

    // 地板（y-1）
    for (let dx = -half; dx <= half; dx++) {
        for (let dz = -half; dz <= half; dz++) put(cx + dx, cy - 1, cz + dz);
    }
    // 墙：两层（y、y+1）的外圈
    for (const y of [cy, cy + 1]) {
        for (let dx = -half; dx <= half; dx++) {
            for (let dz = -half; dz <= half; dz++) {
                const edge = Math.abs(dx) === half || Math.abs(dz) === half;
                if (!edge) continue;                 // 中间留空（她要站在里面）
                put(cx + dx, y, cz + dz);
            }
        }
    }
    // 顶（y+2）—— ★ **四边先放、正中最后放**（2026-11-03 用户要求）。
    //
    //   为什么顺序重要：`flow_build` 的支撑判据条件 C 要求"四邻里**已经落地**的实心方块"。
    //   屋顶正中那格底下是空的（她要站里面），所以它只能靠 C 成立。
    //   先把四边 8 格放好 → 正中放的时候 4 邻必然已落地 → C 成立 → 能封顶。
    //   如果按原来的遍历顺序，正中可能排在四边之前 → C 不成立 → NO_SUPPORT（真机就是这么失败的）。
    const roof = [];
    for (let dx = -half; dx <= half; dx++) {
        for (let dz = -half; dz <= half; dz++) roof.push([cx + dx, cy + 2, cz + dz]);
    }
    const isCenter = ([x, , z]) => x === cx && z === cz;
    for (const [x, y, z] of roof.filter((c) => !isCenter(c))) put(x, y, z);   // 四边先
    for (const [x, y, z] of roof.filter(isCenter)) put(x, y, z);              // 正中最后
    return out;
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

    const material = pickMaterial(bot, opts.block ?? null);
    if (!material) {
        return fail('NO_ITEM', '没有能当墙的材料（先弄点圆石/木头）', { missing: { cobblestone: 20 } });
    }

    const half = Math.max(1, Math.min(3, Math.floor(Number(opts.radius) || 1)));
    const blocks = shelterBlueprint(feet, material, half);

    // 材料够不够？先粗算（flow_build 还会再精算一次，双保险）
    const need = blocks.length;
    const have = countItem(bot, material);
    if (have <= 0) {
        return fail('NO_ITEM', `没有 ${material} 了`, { missing: { [material]: need } });
    }

    // 交给 flow_build：它负责排序/站位/防踩空/读回校验
    const r = await build(bot, blocks, { ctx });
    if (r.ok) {
        return ok({
            material,
            placed: r.data?.placed ?? need,
            want: need,
            note: '小屋搭好了（3×3 封闭壳）',
        });
    }

    // 透传 build 的码；但把"材料不够"说清楚（那是上层该去 obtain 的信号）
    if (r.code === 'NO_ITEM') {
        return fail('NO_ITEM', `材料不够搭小屋：${r.message ?? ''}`, {
            material, missing: r.data?.missing ?? { [material]: need }, want: need,
        });
    }
    return fail(r.code ?? 'INTERNAL', r.message ?? '搭小屋失败', { material, want: need, ...(r.data ?? {}) });
}
