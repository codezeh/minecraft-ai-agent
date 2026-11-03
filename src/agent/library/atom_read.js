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

const AIRISH = new Set(['air', 'cave_air', 'void_air']);
/** 空气以外的"空"：水/岩浆算方块，但不算可站的面（查询层再判）。 */
export const isEmptyName = (name) => !!name && AIRISH.has(name);

// ───────────────────────────────────────────────────────────────────────────
// 坐标与"看世界"的原语（Phase R 收尾，2026-11-03 从 query_perceive 搬下来）
//
// 为什么搬：原子层要读方块就得 `import` 查询层 = "下层依赖上层"（前缀违规）。
// 读方块本来就是**最底层的读**，该住在原子层；查询层反过来复用。
// ───────────────────────────────────────────────────────────────────────────

/** 接受 Vec3 或 {x,y,z}，统一成 Vec3。 */
export function vec(pos) {
    if (pos instanceof Vec3) return pos;
    return new Vec3(pos.x, pos.y, pos.z);
}

/** 方块坐标（整数）→ 方块中心（含 .5）。 */
export function center(pos) {
    const v = vec(pos);
    return new Vec3(v.x + 0.5, v.y + 0.5, v.z + 0.5);
}

/** 眼睛位置。读不到就 `null`（原子的"读不到不抛"规矩）。 */
export function eyePosition(bot) {
    try {
        const p = bot?.entity?.position;
        if (!p) return null;
        return p.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    } catch { return null; }
}

/**
 * 某格是什么方块。**未加载返回 `null`**（不是 air —— "没数据"≠"是空气"）。
 */
export function blockAt(bot, pos) {
    try { return bot.blockAt(vec(pos), false) ?? null; } catch { return null; }
}

/**
 * 按方块名找最近的若干个方块（未注册的名字返回 `[]`）。
 *
 * ★ 签名兼容两种既有调用方式（搬家时不能改调用方）：
 *   - `findBlocks(bot, name, { maxDistance, count })`   ← 原子层习惯
 *   - `findBlocks(bot, name, radius, limit)`            ← 查询层旧签名（36 个调用方在用）
 * 用 `找出最近的一批并排序` 实现；回调式 `server-side matching` 反而会在每个候选上执行，
 * 所以用方块 id 匹配，不用回调。
 */
export function findBlocks(bot, name, optsOrRadius = {}, maybeLimit) {
    let maxDistance = 32;
    let count = 64;
    if (typeof optsOrRadius === 'number') {
        maxDistance = optsOrRadius;
        if (Number.isFinite(maybeLimit)) count = maybeLimit;
    } else {
        maxDistance = optsOrRadius?.maxDistance ?? 32;
        count = optsOrRadius?.count ?? 64;
    }
    try {
        const def = bot?.registry?.blocksByName?.[name];
        if (!def) return [];
        const positions = bot.findBlocks({ matching: def.id, maxDistance, count });
        const eye = eyePosition(bot);
        const list = positions.map(p => bot.blockAt(p, false)).filter(Boolean);
        if (eye) {
            list.sort((a, b) => a.position.distanceTo(eye) - b.position.distanceTo(eye));
        }
        return list.slice(0, count);
    } catch { return []; }
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
    try {
        // ★ Phase R 收尾（2026-11-03）：**实现搬到这里**（读取原子的真身），
        //   原来只转发 `act_container.windowItems` → 原子层反向依赖动作层（前缀违规）。
        //   现在 `act_container.windowItems` 反向复用本函数，全仓仍只有一份实现。
        const win = bot?.currentWindow;
        if (!win) return [];
        return (win.slots || [])
            .map((it, i) => (it && it.name ? { slot: i, name: it.name, count: it.count } : null))
            .filter(Boolean);
    } catch { return []; }
}
