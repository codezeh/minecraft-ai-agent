/**
 * A1 感知：纯查询，无副作用，永不返回 fail()。
 * 找不到就返回 null / []，由调用方判断——「附近没有橡木」是正常情况，不是错误。
 *
 * 规则见 原子动作规格.md §1 与 §0.3–0.5。
 */
import Vec3 from 'vec3';

/**
 * 「天黑」判据（t39）。**全仓唯一一份实现**。
 *
 * 为什么挪到查询层（原来只在 `strat_first_night.js`）：
 *   需要它的地方不止策略层 —— `board_scheduler` 的空闲第 1 层也要判"天快黑了吗"。
 *   而分层规矩（preflight 的 prefix import 检查）是 **board 只能 import query/infra**，
 *   `board → strat` 是新违规；`strat → query` 合法。所以判据放查询层：
 *   strategy 和 board 都能用，且**只有一份**（同一条规矩两处各写一份是本项目反复踩的坑）。
 *   读 `bot.time.timeOfDay` 是纯读世界状态，无副作用，符合查询层语义。
 *
 * 数值出处：04 §6.3 第一夜（夜 ≈ 13000–23000，提前 2000 就开始准备遮蔽）。
 */
export const NIGHT = Object.freeze({
    START: 13000,      // MC 时间：入夜
    END: 23000,        // MC 时间：天亮前
    DUSK_LEAD: 2000,   // 提前量：12000 起就该准备遮蔽了
});

/**
 * 现在是不是"该准备过夜了"（纯函数，`t` 可注入）。
 *
 * @param {number} t Minecraft timeOfDay（0–24000）
 * @returns {boolean}
 */
export function isNightFalling(t) {
    const n = Number(t);
    if (!Number.isFinite(n)) return false;
    return n >= NIGHT.START - NIGHT.DUSK_LEAD || n >= NIGHT.END;
}

/** 眼睛位置。 */
// ★ Phase R 收尾（2026-11-03）：`vec` / `center` / `eyePosition` / `blockAt` / `findBlocks`
//   的**实现搬到了 `atom_read.js`**（读取原子的真身）。
//   原因：原子层要读方块就得从查询层借 = "下层依赖上层"（前缀违规）。
//   现在反过来 —— 查询层从原子层引入并**原样再导出**，全仓仍只有一份实现，
//   36 个 `from './query_perceive.js'` 的调用方一行都不用改。
//
// ★ 必须是 `import` + `export` 两行的写法，**不能用 `export {...} from`**：
//   后者**不创建本地绑定**，而下面的 `reachDistanceTo` 还要用 `eyePosition`/`center`
//   → 会 ReferenceError（本项目踩过一次：composite_registry 的 mapDirOf）。
import {
    vec, center, eyePosition, blockAt, findBlocks,
} from './atom_read.js';

export {
    vec, center, eyePosition, blockAt, findBlocks,
};

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
