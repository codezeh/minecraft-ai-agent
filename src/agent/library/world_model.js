/**
 * 世界知识的唯一 owner。
 *
 * 为什么单独抽出来：这个项目反复出现「同一件事有两个真相」——
 *   - 玩家建筑清单曾在 skills.js 里有两份（一份带 minecraft: 前缀、一份不带）+ heatmap 一份，
 *     三份不同步，于是「放置保护」和「热力图禁行」会对同一块地给出不同结论
 *   - 地面判定 NOT_GROUND 有两份，skills 那份比 heatmap 多 15 项
 *     （bamboo / sugar_cane / cactus / water / lava / torch / rail ...），
 *     也就是说同一个方块在两处会被判成不同东西
 *   - 危险源分成 dangers（人标的点和半径）和 hazards（枚举出来的矩形团块），
 *     各自的读取散落在各处
 *
 * 这些都是「一个 5000 行的 skills.js 里没有单一 owner」的必然产物。
 * 所以把这三类知识集中到这里：谁要判断，就调这里，别再各写一份。
 *
 * 依赖方向（单向，无环）：
 *   memory_store -> world_model -> heatmap -> skills
 */

import * as store from './memory_store.js';

// ---------------------------------------------------------------------------
// 1) 方块分类
// ---------------------------------------------------------------------------

export const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

export const WATER_BLOCKS = new Set([
    'water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
]);

/** 危险液体/致伤方块（规划器要躲的那些） */
export const LAVA_BLOCKS = new Set([
    'lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus',
]);

/**
 * 不算「地面」的方块：树叶、原木、花草、竹子、甘蔗、雪……
 * 找地表时要跳过它们，否则一棵树就会被当成「地面抬高 8 格」
 * （README B3 踩过：高差虚高，永远找不到平地）。
 *
 * 注意是两份历史清单的**并集**（heatmap 40 项 + skills 55 项）。
 * 取并集是刻意的：分支里两份各自在跑，任何一侧少了都会改变现有行为。
 */
export const NOT_GROUND = new Set([
    // 树叶
    'oak_leaves', 'jungle_leaves', 'spruce_leaves', 'birch_leaves', 'acacia_leaves',
    'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves',
    'flowering_azalea_leaves', 'mangrove_roots', 'mangrove_propagule',
    // 原木
    'oak_log', 'jungle_log', 'spruce_log', 'birch_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log', 'stripped_oak_log', 'stripped_spruce_log',
    // 草/花/植物
    'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine',
    'bamboo', 'sugar_cane', 'cactus', 'kelp', 'seagrass', 'snow', 'moss_carpet',
    'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
    'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony',
    'brown_mushroom', 'red_mushroom', 'sweet_berry_bush',
    // 液体（不是"地面"，但也不是空气，各自有专门判定）
    'water', 'lava',
    // 小型装饰（会被 findGroundY 撞到但站不上去）
    'torch', 'wall_torch', 'rail',
]);

/** 人工材料（判「玩家建筑」用）。 */
/**
 * 判断一个方块名算不算「地形地面」（可站立/可放置的地表）。
 */
export function isGroundBlock(name) {
    if (!name) return false;
    const n = String(name).replace('minecraft:', '');
    return !AIR_BLOCKS.has(n) && !NOT_GROUND.has(n) && !WATER_BLOCKS.has(n);
}

// ---------------------------------------------------------------------------
// 2) 玩家建筑判定
// ---------------------------------------------------------------------------

/**
 * 人工材料。**不要把 cobblestone / stone / dirt 放进来** —— 它们是最常见的天然方块，
 * 实测把 cobblestone 算成建筑后，4 处天然裸露岩层（周围 36~63 格全是圆石、零木板）
 * 被误判成"玩家建筑"并标为禁行。也**不要放原木**：天然树木也是原木，整片森林都会中招。
 */
const PLAYER_MATERIALS = new Set([
    'planks', 'stone_bricks', 'bricks', 'glass', 'glass_pane',
    'chest', 'trapped_chest', 'crafting_table', 'furnace', 'blast_furnace', 'smoker',
    'barrel', 'bookshelf', 'torch', 'lantern', 'door', 'trapdoor', 'fence',
    'fence_gate', 'stairs', 'slab', 'bed', 'hopper', 'iron_bars', 'ladder',
]);

/**
 * 这个方块像不像玩家盖的（人工材料）。
 * 方块名是 oak_planks / oak_stairs 这种带前缀的，所以必须用后缀通配。
 */
export function isPlayerBuiltBlock(name) {
    if (!name) return false;
    const n = String(name).replace('minecraft:', '');
    if (PLAYER_MATERIALS.has(n)) return true;
    return /(_planks$|_bricks$|_glass|_wool$|_concrete|_terracotta$|_carpet$|_stairs$|_slab$|_door$|_trapdoor$|_fence$|_fence_gate$|_bed$|_sign$)/.test(n);
}

// ---------------------------------------------------------------------------
// 3) 危险：手工标记 + 地形枚举，统一读取
// ---------------------------------------------------------------------------

/** 手工标记的危险（她自己 markDanger 记的「点 + 半径」）。 */
export function readDangers(bot) {
    try { return store.readStore(bot, 'dangers') || []; } catch (e) { return []; }
}

/** 地形危险团块（findBlocks 枚举出来的「矩形」）。 */
export function readHazards(bot) {
    try { return store.readStore(bot, 'hazards') || []; } catch (e) { return []; }
}

/** 某个团块是否覆盖某点（含外扩 margin 格）。 */
export function hazardBlobAt(blobs, x, z, margin = 1) {
    for (const b of blobs || []) {
        if (!b) continue;
        if (x >= b.x0 - margin && x <= b.x1 + margin
            && z >= b.z0 - margin && z <= b.z1 + margin) return b;
    }
    return null;
}

/**
 * 统一问一句：这个位置危不危险？**两份来源都查**。
 *
 * 之前 isSafeHere 只读 dangers（手工标记），规划器只读 hazards（枚举），
 * 于是"规划器会绕开的岩浆，安全检查说安全"。谁要用危险判断，都走这里。
 *
 * @returns {{hitDangers: Array, hitHazards: Array, dangerous: boolean, reasons: string[]}}
 */
export function dangersAt(bot, x, z, opts = {}) {
    const radiusSlack = opts.radiusSlack ?? 0;   // 手工危险的半径额外放宽
    const hazardMargin = opts.hazardMargin ?? 1; // 团块外扩
    const px = Math.floor(x), pz = Math.floor(z);

    const hitDangers = readDangers(bot).filter((d) => {
        const r = (d.radius || 8) + radiusSlack;
        return Math.hypot((d.x ?? 0) - px, (d.z ?? 0) - pz) <= r;
    });
    const hitHazards = readHazards(bot).filter((h) => hazardBlobAt([h], px, pz, hazardMargin));

    const reasons = [];
    for (const d of hitDangers) {
        reasons.push(`known danger here (${d.reason || 'mark'}, ${d.hits || 1}x)`);
    }
    for (const h of hitHazards) {
        const n = h.count || ((h.x1 - h.x0 + 1) * (h.z1 - h.z0 + 1));
        reasons.push(`terrain hazard here (${h.type || 'lava/fire'}, ${n} blocks)`);
    }
    return { hitDangers, hitHazards, dangerous: reasons.length > 0, reasons };
}


// ---------------------------------------------------------------------------
// 2026-10-27 从 heatmap.js 搬来：这些是「方块/朝向知识」，跟热力图算法无关。
// 热力图要删掉，但它们还有用（skills.js 的朝向名、危险枚举、危险团块记忆）。
// 放在 world_model 是因为它本来就是方块知识的唯一 owner。
// ---------------------------------------------------------------------------

export const DEFAULT_HAZARD_BLOCKS = [
    'lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus',
    'sweet_berry_bush', 'powder_snow',
];


export function facingOf(bot) {
    const raw = bot?.entity?.yaw ?? 0;
    const deg = ((Math.round(raw * 180 / Math.PI) % 360) + 360) % 360;
    const table = [
        { name: '北', en: 'north', front: 'z 减小方向' },
        { name: '西', en: 'west', front: 'x 减小方向' },
        { name: '南', en: 'south', front: 'z 增大方向' },
        { name: '东', en: 'east', front: 'x 增大方向' },
    ];
    const idx = Math.round(deg / 90) % 4;
    const f = table[idx];
    // 右手边：yaw 是 0->90->180->270 对应 北->西->南->东，也就是**逆时针**转，
    // 所以朝右（顺时针转 90°）要看 yaw **减小**的方向，即 idx-1。
    // 一开始写成 idx+1，结果"面朝北，右手边是西"—— 反了。
    const right = table[(idx + 3) % 4];
    const pitchDeg = Math.round((bot?.entity?.pitch ?? 0) * 180 / Math.PI);
    return {
        name: f.name, en: f.en, yawDeg: deg, pitchDeg,
        frontIs: f.front, rightIs: right.name,
        text: `面朝${f.name}（右手边是${right.name}）`,
    };
}

export function collectHazards(bot, opts = {}) {
    const radius = opts.radius ?? 64;
    const mergeGap = opts.mergeGap ?? 2;
    const names = opts.blocks || DEFAULT_HAZARD_BLOCKS;
    let ids;
    try {
        ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined);
    } catch (e) {
        return [];
    }
    if (!ids.length) return [];

    let found = [];
    try {
        found = bot.findBlocks({
            matching: ids,
            maxDistance: radius,
            count: opts.maxCount ?? 512,
            point: bot.entity?.position,
        }) || [];
    } catch (e) {
        return [];
    }

    // 单点 → 团块；相邻（含 mergeGap 容差）的合并成矩形
    // 注意用并查集式的一趟合并：先按 z 排序，避免 O(n²) 在大片岩浆上退化
    const blobs = [];
    const sorted = found.slice().sort((a, b) => a.z - b.z || a.x - b.x);
    for (const p of sorted) {
        const x = Math.floor(p.x), z = Math.floor(p.z);
        const y = Math.floor(p.y);
        let merged = null;
        for (const b of blobs) {
            if (x >= b.x0 - mergeGap && x <= b.x1 + mergeGap && z >= b.z0 - mergeGap && z <= b.z1 + mergeGap) {
                merged = b; break;
            }
        }
        if (merged) {
            merged.x0 = Math.min(merged.x0, x); merged.x1 = Math.max(merged.x1, x);
            merged.z0 = Math.min(merged.z0, z); merged.z1 = Math.max(merged.z1, z);
            // 保留 y 范围：地下岩浆和地表岩浆要能区分开。
            // 不记 y 的话，挖矿时见到的深层岩浆会被拍平到地表图上，
            // 表现就是"她站在木地板上，图里却是一片禁行"（实测 26 个岩浆全在地下 11~38 格）。
            merged.yMin = Math.min(merged.yMin ?? merged.yMax ?? y, y);
            merged.yMax = Math.max(merged.yMax ?? merged.yMin ?? y, y);
            merged.count++;
        } else {
            blobs.push({ x0: x, x1: x, z0: z, z1: z, yMin: y, yMax: y, type: 'hazard', count: 1 });
        }
    }
    return blobs;
}

export function mergeHazardBlobs(prev = [], fresh = [], opts = {}) {
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;      // 默认 10 分钟没复核就失效
    const scanned = opts.scanned;

    const inside = (b) => {
        // 没给扫描范围时**不能**当成"已全部重扫过"去删旧记忆 ——
        // 那会把调用方没声明范围的所有旧知识静默清空。
        // 保守做法：范围未知 = 当作"这次没查过"，旧记忆保留（靠 ttl 自然失效）。
        if (!scanned) return false;
        const r = scanned.radius ?? 64;
        // 团块中心到扫描中心的距离（矩形按外接半径算，宁可多保留也不少留）
        const bx = (b.x0 + b.x1) / 2, bz = (b.z0 + b.z1) / 2;
        const half = Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2;
        return Math.hypot(bx - scanned.cx, bz - scanned.cz) + half <= r;
    };
    const overlaps = (a, b) =>
        a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0;

    const out = [];
    // 1) 本次观测：更新或新增
    for (const f of fresh) {
        const hit = prev.find(p => overlaps(p, f));
        out.push({
            x0: Math.min(f.x0, hit?.x0 ?? f.x0), x1: Math.max(f.x1, hit?.x1 ?? f.x1),
            z0: Math.min(f.z0, hit?.z0 ?? f.z0), z1: Math.max(f.z1, hit?.z1 ?? f.z1),
            type: f.type || hit?.type || 'hazard',
            count: f.count ?? hit?.count ?? 1,
            seenAt: now,
            hits: (hit?.hits ?? 0) + 1,
        });
    }
    // 2)+3) 旧记忆：范围内的且没被重新观测 → 已经不在（被清理了），丢弃；
    //       范围外的 → 保留
    for (const p of prev) {
        if (out.some(o => overlaps(o, p))) continue;          // 已被本次观测覆盖
        if (inside(p)) continue;                              // 范围内却没再看到 = 没了
        // 缺 seenAt（老数据/旧版本）时按"刚见过"处理并盖章：
        // 两个失败方向里，"忘掉岩浆"会导致走进岩浆，"多记一条危险"只是多绕路。
        // 所以宁可先保留；盖章之后若一直没再观测到，TTL 到期照常失效，不会永久封锁。
        const seenAt = p.seenAt ?? now;
        if (now - seenAt > ttlMs) continue;                   // 太久没复核
        out.push({ ...p, seenAt });
    }
    return out;
}

