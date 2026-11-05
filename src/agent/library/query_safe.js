/**
 * A14 安全：这里危不危险。
 *
 * 为什么单独一个原子（见 原子层缺口清单 缺口 3）：
 *   收敛前有四处各自判断危险，标准不一：
 *     skills.isSafeHere      手工标记 + 液体采样 + 敌对生物
 *     skills.markDanger      写入危险记忆
 *     heatmap.collectHazards 枚举岩浆/火焰（给寻路用）
 *     modes.js:79            低血量 + 刚受伤
 *   最严重的问题不是重复，是**两个真相**：规划器靠枚举 hazard 绕开岩浆，
 *   而安全检查只扫 ±4 格采样 —— 5~10 格外的岩浆会被判成"安全"。
 *
 * 重要定位：这是【预检】，不是【保证】。
 *   它回答"就我知道的信息看，这里危不危险"，覆盖三种已知信号：
 *     1) 记住的危险点（home/lava/被怪杀过）
 *     2) 附近的岩浆/水（采样 + 枚举两条路都走，避免两个真相）
 *     3) 附近的敌对生物
 *   它**不**覆盖：脚下会不会塌、会不会被活塞推、水下呼吸、掉落物砸中。
 *   所以调用方不能把 safe:true 当成"绝对安全"，只能当"没有已知风险"。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { blockAt } from './query_perceive.js';
import * as worldModel from './world_model.js';
// 坠落反射要用地形库的列查询与类型常量（2026-11-02）
import { columnSurfaces, T } from './terrain3d.js';
// 危险方块白名单（用注册表名，不写死数字 id）
const HAZARD_BLOCK_NAMES = [
    'lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire',
];

/** 把这些方块算作"液体危险"（水单独算：落水不致命但要记） */
const LIQUID = /lava|water/;
/** 这些算真正的致命 hazard */
const HAZARD = /lava|fire|magma|campfire|soul_fire/;

/** 敌对生物名（不依赖 mcdata 的 isHostile，避免多一层依赖） */
const HOSTILE = new Set([
    'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'spider', 'cave_spider',
    'creeper', 'enderman', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager',
    'phantom', 'blaze', 'ghast', 'magma_cube', 'slime', 'silverfish', 'endermite',
    'guardian', 'elder_guardian', 'shulker', 'hoglin', 'zoglin', 'piglin_brute',
    'wither_skeleton', 'wither', 'ender_dragon', 'vex', 'breeze', 'bogged',
]);

/**
 * 某个位置附近的敌对生物：**数全部**，不是"有没有一只"。
 *
 * 为什么要单独导出来（第20条，2026-11-05 R1 收尾）：
 *   `skills.isSafeHere` 过去自己实现了一遍，用的是
 *   `world.getNearestEntityWhere(...)` —— 拿到最近的一只就 `hostiles = 1`，
 *   于是"围上来 10 只怪"和"旁边站 1 只怪"给出同一个答案，
 *   而同一个问题问 `query_safe.isSafe` 却是全数。两个答案，模型只知道其中一个。
 *   现在两边都走这里：**数几只、半径多大、认哪些名字**都只有这一处。
 *
 * @param {object} bot
 * @param {{x:number,y:number,z:number}} pos 圆心（方块坐标即可）
 * @param {object} opts
 *   radius       半径，默认 12（与 isSafe 的 hostileRadius 默认值同一个数）
 *   nameLimit    最多带回几个名字（只用于日志/原因，不影响计数），默认 3
 * @returns {{count:number, names:string[], radius:number}}
 */
export function hostilesNear(bot, pos, opts = {}) {
    const { radius = 12, nameLimit = 3 } = opts;
    let count = 0;
    const names = [];
    try {
        for (const e of Object.values(bot.entities || {})) {
            if (!e || e.isValid === false || !e.position) continue;
            if (!HOSTILE.has(e.name)) continue;
            const d = Math.hypot(e.position.x - pos.x, e.position.y - pos.y, e.position.z - pos.z);
            if (d <= radius) {
                count++;
                if (names.length < nameLimit) names.push(e.name);
            }
        }
    } catch { /* 实体读不到就当 0 只 —— 与 isSafe 原有的降级一致，不当成"安全"的证明 */ }
    return { count, names, radius };
}

/**
 * 检查某处是否有已知风险。
 *
 * @param {object} bot
 * @param {object} target { kind:'point', pos } —— 不传则查自己脚下
 * @param {object} opts
 *   liquidRadius  液体采样半径，默认 4
 *   hazardRadius  致命方块枚举半径，默认 8（与寻路规划器对齐）
 *   hostileRadius 敌对生物半径，默认 12
 *
 * @returns ActionResult
 *   ok  → data: { safe, reasons[], dangers, hazards, liquids, hostiles, pos }
 *   注意：safe:false 也是 ok（"危险"是正常结论，不是错误）
 */
export function isSafe(bot, target = null, opts = {}) {
    const {
        liquidRadius = 4,
        hazardRadius = 8,
        hostileRadius = 12,
    } = opts;

    const me = bot.entity?.position;
    if (!me || !Number.isFinite(me.x)) {
        return fail('INTERNAL', '自己的坐标无效（NaN），无法判断安全');
    }

    // 目标位置：不传就查自己脚下
    let pos;
    if (target == null) {
        pos = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
    } else if (target.kind === 'point' && target.pos) {
        pos = {
            x: Math.floor(target.pos.x),
            y: Math.floor(target.pos.y),
            z: Math.floor(target.pos.z),
        };
    } else {
        return fail('NO_TARGET', '目标必须是 { kind:"point", pos }');
    }

    const reasons = [];

    // 1) 记住的危险点（手工标记 + 历史 hazard）
    let dangers = [], hazards = [];
    try {
        const hit = worldModel.dangersAt(bot, pos.x, pos.z);
        dangers = hit.hitDangers ?? [];
        hazards = hit.hitHazards ?? [];
        for (const r of hit.reasons ?? []) reasons.push(r);
    } catch { /* 记忆读不到就不判这一项，但不能当成"安全" */ }

    // 2) 液体：采样 + 枚举两条路都走。
    //    只采样会漏 5~10 格的岩浆（实测：规划器绕开了，检查说安全 → 两个真相）
    let liquids = 0;
    for (let dx = -liquidRadius; dx <= liquidRadius; dx += 2) {
        for (let dz = -liquidRadius; dz <= liquidRadius; dz += 2) {
            for (let dy = -2; dy <= 2; dy++) {
                const b = blockAt(bot, { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz });
                if (b && LIQUID.test(b.name)) liquids++;
            }
        }
    }
    if (liquids > 0) reasons.push(`附近 ${liquidRadius} 格内有 ${liquids} 个岩浆/水方块`);

    let nearHazards = 0;
    let lethalHazards = 0;
    try {
        // 不用 heatmap.collectHazards：它有两个不适合当安全判据的问题
        //   1) 返回的 type 固定是 'hazard'，丢了方块名（分不出水和岩浆）
        //   2) findBlocks 以 bot 自身为圆心，查远处位置时会答错
        // 这里自己枚举，圆心用目标位置，并且保留方块名。
        const ids = [...new Set([...HAZARD_BLOCK_NAMES]
            .map(n => bot.registry?.blocksByName?.[n]?.id)
            .filter(id => id != null))];
        if (ids.length) {
            const found = bot.findBlocks({
                matching: ids,
                maxDistance: hazardRadius,
                count: 256,
                point: new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5),
            }) || [];
            nearHazards = found.length;
            for (const p of found) {
                const b = blockAt(bot, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
                if (b && HAZARD.test(b.name)) lethalHazards++;
            }
        }
        if (nearHazards > 0) {
            reasons.push(`附近 ${hazardRadius} 格内有 ${nearHazards} 个危险方块${lethalHazards ? `（其中 ${lethalHazards} 个致命）` : ''}`);
        }
    } catch { /* 枚举失败就只靠上面的采样；这是降级，不是安全证明 */ }

    // 3) 敌对生物（计数与判定都走 hostilesNear —— skills.isSafeHere 用的是同一个函数）
    const hostileHit = hostilesNear(bot, pos, { radius: hostileRadius });
    const hostiles = hostileHit.count;
    if (hostiles > 0) {
        reasons.push(`附近 ${hostileRadius} 格内有 ${hostiles} 个敌对生物（${hostileHit.names.join('、')}）`);
    }

    return ok({
        safe: reasons.length === 0,
        reasons,
        dangers: dangers.length,
        hazards: hazards.length,
        liquids,
        nearHazards,
        hostiles,
        pos,
        // 明示这是预检：调用方不能把 safe:true 当绝对安全
        note: reasons.length === 0
            ? '没有已知风险（预检，不等于保证）'
            : '有已知风险',
    });
}

/**
 * 「站上去会不会掉下去」—— 坠落/虚空反射。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 为什么补这个（2026-11-02，用户指出"悬崖等危险区域按理要有条件反射"）
 *
 * 实测吃过两次亏，都是这一类完全没检查造成的：
 *   ① `gap-bridge` 场景：沟挖到 y=G 而下面是虚空，她搭不过去就**掉出世界摔死**
 *      （服务器日志 `ma67453 fell out of the world`），重生在出生点，
 *      于是那一轮变成"从出生点往 10000 格外走"，被误判成传送失败。
 *   ② `digdown` 场景接入 `stepInto` 后：她站在 1 格厚盖板上，按 forward 走出边缘
 *      掉下去 → 重新规划 → 再走回来 → 无限循环（卡死 13 分钟）。
 *
 * 原来只有 `executor` 里那条落点检查，而它**只拦岩浆**（T.LAVA），
 * 悬崖和虚空根本没拦；`isSafe()` 的文档也明写"不覆盖：脚下会不会塌"。
 *
 * 定位同样重要：**这是反射，不是规划**。它只回答"这一格能不能站"，
 * 不负责找替代路线——找路是 path_3d 的事。所以判据要保守但便宜。
 * ═══════════════════════════════════════════════════════════════════
 *
 * @param {object} bot
 * @param {string} mapDir terrain3d 库目录
 * @param {{x:number,y:number,z:number}} cell 目标"脚位"格子
 * @param {object} opts
 *   maxDrop      允许的最大下落深度（格），默认 4 —— 与 path_3d 的 maxDrop 对齐
 * @returns {ActionResult}
 *   ok → data: { safe, drop, voidBelow, reason }
 *   `drop` = 从该格往下到最近支撑面的距离（0 = 脚下就是实心）
 */
export function fallRisk(bot, mapDir, cell, opts = {}) {
    const { maxDrop = 4 } = opts;
    if (!mapDir) return fail('INTERNAL', 'fallRisk 需要 mapDir（没有地形库就不做坠落判断）');
    if (!cell || !Number.isFinite(cell.x) || !Number.isFinite(cell.y) || !Number.isFinite(cell.z)) {
        return fail('NO_TARGET', 'fallRisk 的 cell 必须是 {x,y,z} 数字');
    }

    const x = Math.floor(cell.x), y = Math.floor(cell.y), z = Math.floor(cell.z);
    let surfaces;
    try {
        surfaces = columnSurfaces(mapDir, x, z);
    } catch (e) {
        // 查不到就不拦（与落点检查的既有口径一致），但要留痕
        return ok({ safe: true, drop: null, voidBelow: false, reason: '地形库读不到，跳过坠落判断', unknown: true });
    }
    if (!surfaces.length) {
        // ★ 「这列没有数据」≠「下面是虚空」。
        //   区块没加载 / 还没扫描过的列，`columnSurfaces` 同样返回空数组。
        //   把"不知道"当成"确定是虚空"，会把所有未扫描区域的移动全拦死 ——
        //   这正是今晚反复出现的同一类错（"不知道"被当成"知道它坏"，
        //   与 vine 补丁 `installed:false` vs `undefined` 是同族）。
        //   所以：无数据 → 不拦，但显式标记 unknown，让上层能区分。
        return ok({
            safe: true, drop: null, voidBelow: false, unknown: true,
            reason: `(${x},${z}) 这列没有地形数据（可能未加载/未扫描）—— 不做坠落判断`,
        });
    }

    // 该格下方最近的"能站"的面。CLIMBABLE **不是落脚点**（见 T 的注释），排除。
    // WATER / SUBMERGED 能落（会掉进水里），算"有支撑"但记下类型供上层参考。
    const standable = surfaces.filter((s) => s.t !== T.CLIMBABLE && s.y < y);
    if (!standable.length) {
        return ok({ safe: false, drop: null, voidBelow: true, reason: `(${x},${y},${z}) 下方没有可落的面 —— 虚空` });
    }
    const nearest = standable.reduce((a, b) => (b.y > a.y ? b : a));
    const drop = y - 1 - nearest.y;   // 脚位 y 的下方一格开始算

    if (drop > maxDrop) {
        return ok({
            safe: false, drop, voidBelow: false, supportType: nearest.t, supportY: nearest.y,
            reason: `从 (${x},${y},${z}) 掉下去是 ${drop} 格（上限 ${maxDrop}），支撑面在 y=${nearest.y}`,
        });
    }
    // ★ 2026-11-02：这里原来还有一条 `drop > probeDepth → 当虚空`。
    //   删掉它：既然**已经找到了支撑面**，落差多少就是 maxDrop 一个判据的事；
    //   再叠一条 probeDepth 会变成"更严但没有理由"的第二重限制 ——
    //   maxDrop=20 时 9 格落差照样被 probeDepth=8 判成虚空（单测用例 9 抓到）。
    //   probeDepth 只在"完全找不到支撑面"时才有意义，那种情况上面已经 return 了。
    //   两个判据说同一件事就容易互相打脸，这是本项目的老毛病。
    return ok({ safe: true, drop, voidBelow: false, supportType: nearest.t, supportY: nearest.y, reason: '有支撑，落差不超上限' });
}
