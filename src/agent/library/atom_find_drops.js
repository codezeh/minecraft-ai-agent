/**
 * A17 查询：找附近的掉落物实体。
 *
 * 为什么单独一个原子（用户判断 2026-10-25：「拆的还不够原子」）：
 *   原来这段逻辑埋在 `collectDrops` 中间（遍历 bot.entities 找 type==='item'），
 *   和"等待""移动""判断成功"混在一起。
 *   结果：掉落物找不到时，只能看到一个 `no-drop-entity` 事件，
 *   分不清是「真的没有」还是「半径太小」还是「实体还没同步到客户端」。
 *
 * 拆分后：**纯查询，不移动、不等待、不改世界**，能单独跑、能单独测。
 */
import { ok, fail } from './atom_contract.js';

/** 默认搜索半径。8 格是服务端拾取半径（约 1 格）之外比较宽松的范围 */
const DEFAULT_RADIUS = 8;

/**
 * 找附近的掉落物实体。
 *
 * @param {object} bot
 * @param {object} opts
 *   near     {x,y,z} 参照点，默认自己脚下
 *   radius   搜索半径，默认 8
 *   limit    最多返回几个，默认 8
 *   name     只找某种物品（如 'oak_log'），可选
 *
 * @returns ActionResult
 *   ok       → data: { items: [{ pos, dist, name, entityId }], count, radius, near }
 *   NO_TARGET → 附近没有掉落物（items 为空，但 radius/near 仍返回，便于判断是不是半径问题）
 */
export function findDrops(bot, opts = {}) {
    const {
        near = null,
        radius = DEFAULT_RADIUS,
        limit = 8,
        name = null,
    } = opts;

    if (bot.interrupt_code) {
        return fail('INTERRUPTED', '被取消了');
    }

    // 参照点：默认自己脚下（掉落物是"离我多远"，不是"离世界原点多远"）
    const self = bot.entity?.position;
    if (!self || !Number.isFinite(self.x)) {
        return fail('INTERNAL', '自己的坐标无效（NaN），无法搜索掉落物');
    }
    const center = near && Number.isFinite(near.x)
        ? { x: near.x, y: near.y, z: near.z }
        : { x: self.x, y: self.y, z: self.z };

    const out = [];
    let totalSeen = 0;

    for (const e of Object.values(bot.entities ?? {})) {
        if (!e) continue;
        // ⚠ 必须按 `name` 判，不能只看 `type`：
        //   实测（mineflayer 4.39 + MC 1.21.8）掉落物的 `type` 是 `'other'`，
        //   `name` 才是 `'item'`。原来两处代码都写 `e.type === 'item'`，
        //   结果**永远找不到掉落物**——采集时"看不到掉落物"就是它。
        //   这里两个都认，兼容不同版本。
        if (e.name !== 'item' && e.type !== 'item') continue;
        if (e.isValid === false) continue;
        const p = e.position;
        if (!p || !Number.isFinite(p.x)) continue;
        totalSeen++;

        const d = Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z);
        if (d > radius) continue;

        // 物品名：mineflayer 在不同版本放在 metadata / displayName 上，取得到就带
        const itemName = e.metadata?.[8]?.itemName ?? e.metadata?.[7]?.itemName ?? null;
        if (name && itemName && itemName !== name) continue;

        out.push({
            pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
            // 保留精确坐标：地板化后常差半格，走路会走不到位
            exactPos: { x: p.x, y: p.y, z: p.z },
            dist: Number(d.toFixed(2)),
            name: itemName,
            entityId: e.id ?? null,
        });
    }

    out.sort((a, b) => a.dist - b.dist);
    const items = out.slice(0, limit);

    if (!items.length) {
        return fail('NO_TARGET',
            totalSeen > 0
                ? `附近 ${radius} 格内没有能捡的掉落物（视野里有 ${totalSeen} 个，都超出范围）`
                : `附近 ${radius} 格内没有任何掉落物实体`,
            { items: [], count: 0, radius, near: center, seenInWorld: totalSeen });
    }

    return ok({
        items,
        count: items.length,
        radius,
        near: center,
        seenInWorld: totalSeen,
        // 最近那个的距离，方便上层决定"值不值得走过去"
        nearestDist: items[0].dist,
    });
}
