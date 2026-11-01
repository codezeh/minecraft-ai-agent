/**
 * 输入/感知原子：**纯读取** —— 看一眼，没有副作用，永不抛异常。
 *
 * 规矩见 docs/architecture/01_primitives.md §2（A2）与 §3.5：
 *   - 读不到就返回 `null` / `[]`，**不返回 ActionResult、不抛异常**
 *     （读取在热路径上，不该让每个调用方写 try）
 *   - 一次读，不做判断；"能不能站 / 够不够得着"这类组合判断属于查询层（§5）
 *
 * 为什么单独一个文件：同样是"看世界"的代码之前散在 `atom_perceive`（blockAt/
 * findBlocks/playerPos）、`executor`（自己包了一层 blockAt）、`atom_items`
 * （找个物品）、`atom_container`（windowItems）四处，各有各的"读不到返回什么"。
 * 这里只是把读取入口收成一处，**实现仍复用已有函数**，不复制逻辑
 * （Phase R 会把 `atom_perceive` / `atom_container` 的读取正式改名归位）。
 */
import Vec3 from 'vec3';
import { blockAt as _blockAt, findBlocks as _findBlocks } from './query_perceive.js';
import { windowItems as _windowItems } from './act_container.js';

const AIRISH = new Set(['air', 'cave_air', 'void_air']);
/** 空气以外的"空"：水/岩浆算方块，但不算可站的面（查询层再判）。 */
export const isEmptyName = (name) => !!name && AIRISH.has(name);

/**
 * 某格是什么方块。**未加载返回 `null`**（不是 air —— "没数据"≠"是空气"）。
 */
export function blockAt(bot, pos) {
    try { return _blockAt(bot, pos) ?? null; } catch { return null; }
}

/** 按方块名找最近的若干个方块（未注册的名字返回 `[]`）。 */
export function findBlocks(bot, name, opts = {}) {
    const { maxDistance = 32, count = 64 } = opts;
    try { return _findBlocks(bot, name, maxDistance, count) ?? []; } catch { return []; }
}

/** 附近实体（`filter` 可给函数或"类别/名字"字符串）；读不到返回 `[]`。 */
export function entities(bot, filter = null, radius = 32) {
    try {
        const all = Object.values(bot.entities ?? {}).filter(Boolean);
        const self = bot.entity;
        const within = all.filter((e) => e && e !== self
            && Number.isFinite(e.position?.x) && Number.isFinite(e.position?.y) && Number.isFinite(e.position?.z)
            && (self?.position ? e.position.distanceTo(self.position) <= radius : true));
        if (filter == null) return within;
        if (typeof filter === 'function') return within.filter((e) => { try { return !!filter(e); } catch { return false; } });
        const want = String(filter);
        return within.filter((e) => e.name === want || e.type === want || e.username === want);
    } catch { return []; }
}

/** 最近的实体（可选过滤）；没有就 `null`。 */
export function nearestEntity(bot, filter = null, radius = 32) {
    const list = entities(bot, filter, radius);
    if (!list.length) return null;
    const self = bot.entity?.position;
    if (!self) return list[0];
    return list.reduce((best, e) => (
        e.position.distanceTo(self) < best.position.distanceTo(self) ? e : best
    ), list[0]);
}

/** 背包里的物品堆（数组，别改它）；读不到返回 `[]`。 */
export function inventory(bot) {
    try { return bot.inventory?.items?.() ?? []; } catch { return []; }
}

/** 手持物品；空手 `null`。 */
export function heldItem(bot) {
    try { return bot.heldItem ?? null; } catch { return null; }
}

/** 生命 / 饥饿 / 饱和度 / 氧气。 */
export function vitals(bot) {
    try {
        return {
            health: bot.health ?? null,
            food: bot.food ?? null,
            saturation: bot.foodSaturation ?? null,
            oxygenLevel: bot.oxygenLevel ?? null,
        };
    } catch { return { health: null, food: null, saturation: null, oxygenLevel: null }; }
}

/** 位置 / 速度 / 朝向 / 是否着地 / 是否在水里。 */
export function pose(bot) {
    try {
        const p = bot.entity?.position;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
        return {
            pos: { x: p.x, y: p.y, z: p.z },
            feet: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
            velocity: bot.entity.velocity ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z } : null,
            yaw: bot.entity.yaw ?? null,
            pitch: bot.entity.pitch ?? null,
            onGround: bot.entity.onGround === true,
            isInWater: !!bot.entity.isInWater,
        };
    } catch { return null; }
}

/** 时间 / 天气。 */
export function worldState(bot) {
    try {
        return {
            timeOfDay: bot.time?.timeOfDay ?? null,
            isDay: bot.time?.isDay ?? null,
            isRaining: !!bot.isRaining,
            thunderState: bot.thunderState ?? null,
        };
    } catch { return { timeOfDay: null, isDay: null, isRaining: false, thunderState: null }; }
}

/** 准星对着的方块（`maxDist` 内）；没有 `null`。 */
export function cursorBlock(bot, maxDist = 5) {
    try { return bot.blockAtCursor?.(maxDist) ?? null; } catch { return null; }
}

/** 能不能看见这个方块（没有 canSeeBlock 时保守返回 false）。 */
export function canSee(bot, block) {
    try {
        if (!block || typeof bot.canSeeBlock !== 'function') return false;
        return !!bot.canSeeBlock(block);
    } catch { return false; }
}

/** 某格光照等级；读不到 `null`。 */
export function lightAt(bot, pos) {
    try {
        const v = pos instanceof Vec3 ? pos : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
        return bot.blockAt?.(v, false)?.light ?? null;
    } catch { return null; }
}

/** 手持某物时挖这个方块要多久（毫秒）；算不出来 `null`。 */
export function digTimeOf(bot, block, itemId = null) {
    try {
        if (!block || typeof block.digTime !== 'function') return null;
        const id = itemId ?? bot.heldItem?.type ?? null;
        const t = block.digTime(id);
        return Number.isFinite(t) ? t : null;
    } catch { return null; }
}

/** 当前打开的窗口里的格子；没有窗口返回 `[]`。 */
export function windowSlots(bot) {
    try { return _windowItems(bot) ?? []; } catch { return []; }
}
