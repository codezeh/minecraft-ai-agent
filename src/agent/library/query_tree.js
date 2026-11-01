/**
 * A5 树体：扫出整棵树、判断是不是自然树、排出砍伐顺序。
 *
 * 单一副作用：无。**全部是只读查询**——它不挖、不走、不改任何东西，
 * 只回答"这棵树长什么样、该怎么砍"。动手是复合层的事。
 *
 * ★ 2026-10-29 新建（用户设计）：
 *   「确定一个木头之后扫描联系的所有木头（扫描整个树体，看看是不是自然树），
 *     然后规划砍树方案」
 *
 * 为什么不能靠 pathfinder 硬爬：
 *   实测那棵丛林树是 **11 格高的竖直原木柱**（x/z 跨度都是 1 格，y=71~81），
 *   她站在 y=62，**高差 9 格**。pathfinder 爬不上去，绕 25 秒一个木头都砍不到。
 *
 * 为什么"知道整棵树"就能解决：
 *   只要知道它是柱子，就可以**从底部砍起**：砍掉 y=71 后站上树桩，
 *   往上 4.5 格内的 y=72~75 都在够取范围内，逐层推进即可 —— 根本不用爬。
 *
 * 三个职责（对应上面那句话）：
 *   1) scanTree()   从一个木头出发，6 向 flood fill 扫出整棵树
 *   2) judgeTree()  判断是不是自然树（有树冠、不是人造结构、形状像树）
 *   3) planFelling()排出砍伐顺序（从底往上，保证每步都在够取范围内）
 */
import { blockAt } from './query_perceive.js';

/** 原木/菌柄。 */
const LOG_RE = /_log$|_stem$/;
/** 树叶。 */
const LEAF_RE = /_leaves$/;
/** 一看就是人造的东西（用来判断"这棵树是不是玩家搭的"）。 */
const ARTIFICIAL_RE = /(_planks$|_bricks$|_glass|_wool$|_concrete|_terracotta$|_carpet$|_stairs$|_slab$|_door$|_trapdoor$|_fence|_bed$|_sign$|chest$|barrel$|furnace$|crafting_table$|bookshelf|lantern$|_button$|_lever$|torch$|_wall$)/;

/** 6 个方向（flood fill 用）。 */
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** 单棵树上最多存多少根木头（防止把整片森林连成一片时爆内存）。 */
const MAX_LOGS = 400;
/** 扫整棵树的搜索半径（水平）。 */
const SCAN_RADIUS = 12;
/** 扫整棵树的搜索高度（相对种子木头）。 */
const SCAN_DOWN = 12;
const SCAN_UP = 40;

const key = (x, y, z) => `${x},${y},${z}`;

function at(bot, x, y, z) {
    return blockAt(bot, { x, y, z });
}

/**
 * 从一个原木位置出发，6 向 flood fill 扫出**连通的整棵树**。
 *
 * 为什么用 6 向连通而不是"半径内所有原木"：
 *   半径扫描会把旁边第二棵树也算进来（实测丛林里树挨得很近），
 *   于是"11 根的柱子"变成"30 根的森林"，砍伐顺序全乱。
 *   6 向连通只认真正挨着的，才是"一棵树"。
 *
 * 只读，不挖。
 *
 * @param {object} bot
 * @param {{x,y,z}} seed 已知的一根原木
 * @param {{maxLogs?:number, radius?:number, down?:number, up?:number}} opts
 * @returns {{ok:true, logs:Array<{x,y,z,name:string}>, leaves:number, artificial:number,
 *            minY:number, maxY:number, spanX:number, spanZ:number, truncated:boolean}
 *          | {ok:false, code:string, why:string}}
 */
export function scanTree(bot, seed, opts = {}) {
    const {
        maxLogs = MAX_LOGS, radius = SCAN_RADIUS,
        down = SCAN_DOWN, up = SCAN_UP,
    } = opts;

    if (!seed || !Number.isFinite(seed.x)) {
        return { ok: false, code: 'NO_TARGET', why: '种子位置无效' };
    }
    const sx = Math.floor(seed.x), sy = Math.floor(seed.y), sz = Math.floor(seed.z);
    const seedB = at(bot, sx, sy, sz);
    if (!seedB) return { ok: false, code: 'NO_DATA', why: `(${sx},${sy},${sz}) 未加载` };
    if (!LOG_RE.test(seedB.name)) {
        return { ok: false, code: 'NO_TARGET', why: `(${sx},${sy},${sz}) 是 ${seedB.name}，不是原木` };
    }

    // ---- 6 向 flood fill ----
    const logs = [];
    const seen = new Set([key(sx, sy, sz)]);
    const queue = [{ x: sx, y: sy, z: sz }];
    let truncated = false;

    while (queue.length) {
        if (logs.length >= maxLogs) { truncated = true; break; }
        const cur = queue.pop();
        const b = at(bot, cur.x, cur.y, cur.z);
        if (!b || !LOG_RE.test(b.name)) continue;
        logs.push({ x: cur.x, y: cur.y, z: cur.z, name: b.name });

        for (const [dx, dy, dz] of DIRS6) {
            const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
            // 范围限制：防止一片大森林被连成无穷大
            if (Math.abs(nx - sx) > radius || Math.abs(nz - sz) > radius) continue;
            if (ny < sy - down || ny > sy + up) continue;
            const k = key(nx, ny, nz);
            if (seen.has(k)) continue;
            seen.add(k);
            const nb = at(bot, nx, ny, nz);
            if (nb && LOG_RE.test(nb.name)) queue.push({ x: nx, y: ny, z: nz });
        }
    }

    if (!logs.length) return { ok: false, code: 'NO_TARGET', why: '扫不到原木' };

    // ---- 扫树冠与人造材料（判断自然树用）----
    const ys = logs.map(l => l.y);
    const xs = logs.map(l => l.x);
    const zs = logs.map(l => l.z);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);

    // 树冠与人造材料分开扫，半径不同。
    //
    // ★ 2026-10-29 修：原来两者共用 radius=12，结果把她**12 格外**放的
    // 69 个 oak_planks 也算进"这棵树的人造材料"，于是自然树被误判成建筑
    // （实测：11 根笔直树干 + 123 片叶，却因为 69 个远处木板判成"不是树"）。
    //
    // 语义上本来就该分开：
    //   树冠可以伸得远（大树树冠半径 3~5 格，垂直再上去 8~10 格）→ 用 radius
    //   人造材料只关心"这棵树本身是不是玩家搭的" → 只看贴身的 NEAR_R
    const NEAR_R = 3;
    let leaves = 0, artificial = 0;
    const yTop = Math.min(up, maxY - sy + 8);

    // 树冠：大范围（它也用来确认"这是棵树"）
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -4; dy <= yTop; dy++) {
                const b = at(bot, sx + dx, sy + dy, sz + dz);
                if (b && LEAF_RE.test(b.name)) leaves++;
            }
        }
    }
    // 人造材料：只看贴身 3 格（"这棵树本身是不是搭的"）
    for (let dx = -NEAR_R; dx <= NEAR_R; dx++) {
        for (let dz = -NEAR_R; dz <= NEAR_R; dz++) {
            for (let dy = -2; dy <= Math.min(yTop, 6); dy++) {
                const b = at(bot, sx + dx, sy + dy, sz + dz);
                if (b && ARTIFICIAL_RE.test(b.name)) artificial++;
            }
        }
    }

    return {
        ok: true,
        logs,
        leaves,
        artificial,
        minY, maxY,
        spanX: maxX - minX + 1,
        spanZ: maxZ - minZ + 1,
        minX, maxX, minZ, maxZ,
        truncated,
    };
}

/**
 * 判断扫出来的这棵"树"是不是**自然树**（而不是玩家用木板/原木搭的东西）。
 *
 * 判据（阈值参考 atom_classify.classifyLog 里基于 7594 根真实原木的统计）：
 *   1. 有树冠：树叶 >= 3 片（人造结构通常没有叶子）
 *   2. 人造材料不占主导：artificial <= 6（玩家搭的结构周围会有一堆方块）
 *   3. 形状像树：不是又宽又矮的一大片（那种更像堆料）
 *
 * @param {object} scan scanTree() 的结果
 * @returns {{ok:boolean, isTree:boolean, why:string}}
 */
export function judgeTree(scan) {
    if (!scan?.ok) return { ok: false, isTree: false, why: scan?.why ?? '没扫到树' };

    const { logs, leaves, artificial, minY, maxY, spanX, spanZ, truncated } = scan;
    const n = logs.length;

    if (truncated) {
        return { ok: true, isTree: false, why: `连通的木头超过上限（${n} 根），可能是树连着树，不当单棵树处理` };
    }
    if (leaves < 3) {
        return { ok: true, isTree: false, why: `没有树冠（${leaves} 片叶），像玩家搭的或已剥光的树干` };
    }
    if (artificial > 6) {
        return { ok: true, isTree: false, why: `周围人造材料太多（${artificial} 个），像建筑不是树` };
    }
    // 又宽又矮：水平跨度很大但很矮 → 更像堆料
    const height = maxY - minY + 1;
    if (Math.max(spanX, spanZ) > 8 && height < 4) {
        return { ok: true, isTree: false, why: `又宽又矮（${spanX}×${spanZ}，高 ${height}），不像树` };
    }

    const shape = Math.max(spanX, spanZ) === 1 ? '笔直树干' : `树干 ${spanX}×${spanZ}`;
    return { ok: true, isTree: true, why: `自然树：${n} 根木头、高 ${height} 格（y${minY}~${maxY}）、${shape}、${leaves} 片叶` };
}

/**
 * 排出砍伐顺序：**从底部往上**，一层一层砍。
 *
 * 为什么从底往上：
 *   她站在地面（树底下方），够取距离约 4.5 格。砍掉最底一层后，
 *   可以站上树桩继续够上面一层 —— 全程不需要爬树、不需要垫方块。
 *   反过来从顶往下砍，她够不到顶。
 *
 * @param {object} scan scanTree() 的结果
 * @param {{reach?:number, standY?:number}} opts
 *        reach：够取距离（默认 4.5，与 atom_dig 的 maxReach 一致）
 *        standY：她开始站的高度（用来算第一层能不能够到）
 * @returns {{ok:true, order:Array<{y:number, logs:Array}>, layers:number, reachableFromGround:boolean, why:string}
 *          | {ok:false, code:string, why:string}}
 */
export function planFelling(scan, opts = {}) {
    const { reach = 4.5, standY = null } = opts;
    if (!scan?.ok) return { ok: false, code: 'NO_TARGET', why: scan?.why ?? '没扫到树' };

    // 按 y 分组
    const byY = new Map();
    for (const l of scan.logs) {
        if (!byY.has(l.y)) byY.set(l.y, []);
        byY.get(l.y).push(l);
    }
    const order = [...byY.keys()].sort((a, b) => a - b).map(y => ({
        y,
        logs: byY.get(y).sort((a, b) => (a.x - b.x) || (a.z - b.z)),
    }));

    // 第一层（最低）能不能够到：她站在树底下方，够取 reach 格
    const lowestY = order[0].y;
    const baseY = standY ?? (lowestY - 1);
    const firstReach = lowestY - baseY;      // 她脚在 baseY，眼高约 +1.6
    const reachableFromGround = firstReach <= reach;

    return {
        ok: true,
        order,
        layers: order.length,
        total: scan.logs.length,
        reachableFromGround,
        why: reachableFromGround
            ? `${order.length} 层、共 ${scan.logs.length} 根；从底部砍起，第一层距地 ${firstReach} 格（够取 ${reach} 格内）`
            : `${order.length} 层、共 ${scan.logs.length} 根；但第一层距地 ${firstReach} 格，超出够取范围（${reach} 格），需要先垫高`,
    };
}
