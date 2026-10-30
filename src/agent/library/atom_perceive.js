/**
 * A1 感知：纯查询，无副作用，永不返回 fail()。
 * 找不到就返回 null / []，由调用方判断——「附近没有橡木」是正常情况，不是错误。
 *
 * 规则见 原子动作规格.md §1 与 §0.3–0.5。
 */
import Vec3 from 'vec3';

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

/** 眼睛位置。 */
export function eyePosition(bot) {
    return bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
}

export function blockAt(bot, pos) {
    return bot.blockAt(vec(pos), false) ?? null;
}

/**
 * 按名字找最近的方块。
 * 用方块 id 匹配，不用回调——回调会对每个候选方块执行一次，不能有副作用。
 */
export function findBlocks(bot, name, radius = 32, limit = 64) {
    const def = bot.registry.blocksByName[name];
    if (!def) return [];
    const positions = bot.findBlocks({ matching: def.id, maxDistance: radius, count: limit });
    const eye = eyePosition(bot);
    return positions
        .map(p => bot.blockAt(p, false))
        .filter(Boolean)
        .sort((a, b) => a.position.distanceTo(eye) - b.position.distanceTo(eye))
        .slice(0, limit);
}

/** 眼睛到方块中心的距离（格）。 */
export function reachDistanceTo(bot, pos) {
    return eyePosition(bot).distanceTo(center(pos));
}

/**
 * 够不够得着（距离 + 视线）。
 *
 * 注意：挖掘**不需要**视线——实测中间挡一层树叶，raycast 命中树叶，
 * 但 bot.dig 照样把后面的原木挖掉了（服务端不校验视线）。
 * 这个函数保留视线检查，只适用于要看着某个方块的场景（如右键交互）。
 * 挖方块请用 digBlock，它只判距离。
 *
 * 阈值 5.1 的依据：mineflayer 的 canDigBlock 用 5.1；
 * 实测 Paper 服务端 6.11 格也能挖成功（服务端更松）。
 */
export function canReach(bot, pos, max = 5.1) {
    if (reachDistanceTo(bot, pos) > max) return false;
    const block = blockAt(bot, pos);
    if (!block) return false;
    if (typeof bot.canSeeBlock === 'function') {
        try { return bot.canSeeBlock(block); } catch { return false; }
    }
    return true;
}

/** 向下找第一个非空气方块，最多看 maxDepth 格。 */
export function blockBelow(bot, pos, maxDepth = 6) {
    const v = vec(pos);
    for (let dy = 1; dy <= maxDepth; dy++) {
        const b = bot.blockAt(new Vec3(v.x, v.y - dy, v.z), false);
        if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') return b;
    }
    return null;
}

/** 背包里某物品的总数。 */
export function countItem(bot, name) {
    const items = bot.inventory?.items?.() ?? [];
    return items.filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0);
}

/** 玩家实体位置；不在线返回 null。 */
export function playerPos(bot, name) {
    const p = bot.players?.[name];
    if (!p || !p.entity) return null;
    return p.entity.position;
}
