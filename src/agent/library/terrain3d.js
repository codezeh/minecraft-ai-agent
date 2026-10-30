/**
 * 真 3D 地形库（terrain3d）——独立数据库，与旧的 chunks.db 完全分开。
 *
 * ★ 2026-10-27 新建。用户决定：走真 3D（方案 A），不污染旧数据。
 *
 * 为什么必须 3D（今晚的实测结论）：
 *   旧的 2.5D（每列只记最上面那层地表）回答不了"我这个角落有没有出口"。
 *   实测：她站在区块 (-9,-15) 里，地图说这块地 72.7% 连通可走、代价 1，
 *   但她实际被 5 格厚的墙夹在一个 5 米宽的角落里，规划=OK 执行=NO_PATH 反复循环。
 *   区块粒度 + 单层地表，天然表达不了洞穴、竖井、悬空平台、多层空间。
 *
 * 实测成本（tools/probe_3d_cost.mjs，9 个区块）：
 *   每列平均 1.8 个边界（不是担心的 4~8 层）
 *   每区块 458 个边界
 *   扫描 27ms/区块（比 2.5D 的 40ms 还快，因为不用反复试）
 *   4095 区块 ≈ 5.4MB / 1.9 分钟
 *
 * 存储设计：
 *   不用区块索引间接查，**直接存世界坐标 (x, z, y)** ——
 *   用户要求「需要什么数据的时候可以直接查」。
 *   区块用四个角的世界坐标登记在 chunk_index，保证精确定位、不会因取整算错块。
 */
import { DatabaseSync } from 'node:sqlite';
import Vec3 from 'vec3';

/** 表面类型（与旧 SURF 保持一致，便于迁移） */
export const T = {
    SOLID: 0,    // 普通可站立实心
    WATER: 1,    // 水面
    LAVA: 2,     // 岩浆（禁行）
    BUILT: 3,    // 玩家建筑（能走但尽量绕）
    LEAVES: 4,   // 树叶（可挖可穿）
    // ★ 2026-10-28 新增：可攀爬（梯子 / 藤蔓）。
    // 语义与其它类型**不同**：它表示"能置身其中并上下移动"，**不是落脚点**。
    // plan3D 见到它只生成 climb 边，不生成 walk 边（不能站上去）。
    CLIMBABLE: 5,
    // ★ 2026-10-29 新增：**沉在水下的地面**。
    //
    // 语义：这确实是可以站立的实心底面，但**上方有水**。
    // 为什么要单独标：她的执行层**没有潜水能力**（按 shift 在深水里无效），
    // 所以"规划让她下到水底"必然失败。实测真实数据：51871 个实心面里
    // 有 24735 个（47.7%）在水下 —— 不能全禁（她本来就常在水边活动，
    // 全禁会无路可走），但必须让她**能不走就不走**。
    //
    // plan3D 对它：照常生成边，但代价极高（只有在别无选择时才走）。
    SUBMERGED: 6,
};

// ★ 2026-10-28：`vine` 已从 AIR 移出（改归 CLIMBABLE），否则扫不到藤蔓。
// 可穿过的方块 = 相当于空气（不构成"可站立面"）。
//
// ★ 2026-10-29 补：原来只列了草/蕨/雪/火把，漏了**竹子、甘蔗、枯木、大蕨**等。
// 后果：它们被 classifyBlock 归成 SOLID，扫描时记出根本不存在的"实心面"，
// 规划器据此规划路径，而 pathfinder 面对真实世界正确拒绝 → 反复 NO_PATH。
// 实测现场（302 格长规划）：(-390,-148) 真实是 air + 旁边 bamboo，
// 库里却记着 y=63 SOLID，她卡在 (-388,-153) 报 `STUCK 差 4.8 格且完全没动`。
const AIR = new Set([
    'air', 'cave_air', 'void_air',
    // 草与矮植物
    'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
    // 甘蔗 / 竹子（甘蔗和竹子都是可穿过的植物）
    'sugar_cane', 'bamboo', 'bamboo_sapling',
    // 水生植物
    'seagrass', 'tall_seagrass',
    // 火把类
    'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch',
    // 其它不挡路的
    'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
    'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
    'red_mushroom', 'brown_mushroom', 'crimson_roots', 'warped_roots',
    'nether_sprouts', 'sweet_berry_bush', 'cobweb',
]);
const WATER_RE = /water|kelp|seagrass|bubble_column/;
const LAVA_RE = /lava|magma_block|^fire$|soul_fire|campfire|cactus/;
const BUILT_RE = /(_planks$|_bricks$|_glass|_wool$|_concrete|_terracotta$|_carpet$|_stairs$|_slab$|_door$|_trapdoor$|_fence|_bed$|_sign$|chest$|barrel$|furnace$|crafting_table$|bookshelf|lantern$|_button$|_lever$|cobblestone_wall|scaffolding)/;
const LEAVES_RE = /_leaves$/;

/**
 * 可攀爬方块（梯子 / 藤蔓）。
 *
 * ★ 2026-10-28：原来 `vine` 在 AIR 集合里 —— 扫描时被当空气跳过，
 * 所以 3D 库里**完全没有藤蔓记录**，规划层根本看不见它（这就是
 * 「藤蔓困扰很久」的根因之一）。
 * 现在把它从 AIR 里拿掉，单独归到 CLIMBABLE。
 *
 * 梯子单独列：自然生成里只有 vine 系列，梯子是人放的。
 */
const CLIMB_RE = /(^|_)ladder$|^vine$|_vines(_plant)?$|cave_vines/;

/** 扫描高度范围（用户定：实际高度就够，不用全高） */
export const Y_MIN = -64;
export const Y_MAX = 320;

/** 打开（必要时创建）3D 库。 */
export function openDb3d(baseDir) {
    const db = new DatabaseSync(`${baseDir}/terrain3d.db`);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 3000;

        -- 每一行 = 一个"可站立面"（实心方块的顶面）
        -- 直接存世界坐标，查任意盒子/列都是普通 WHERE
        CREATE TABLE IF NOT EXISTS surf (
            x INTEGER NOT NULL,
            z INTEGER NOT NULL,
            y INTEGER NOT NULL,
            t INTEGER NOT NULL,
            PRIMARY KEY (x, z, y)
        ) WITHOUT ROWID;

        -- 按 x/z 查列很快；按 y 查"某一层有什么"也有索引
        CREATE INDEX IF NOT EXISTS idx_surf_xz ON surf(x, z);
        CREATE INDEX IF NOT EXISTS idx_surf_y  ON surf(y);

        -- ★ 2026-10-28 新增：失败记忆。
        --
        -- 为什么需要（实测）：执行层发现某格走不到时会 forgetSurface 删掉它，
        -- 但 scanSphere 下一轮又把同一格**写回** surf 表 ——
        -- 于是规划每轮都给出同一个不可达点，执行每轮都失败，无限循环。
        -- （真机日志出现过同一格被删 3 次、写回 3 次）
        --
        -- 失败记忆与地形数据分开存：地形是"那里有什么"，失败是"那里走过走不通"。
        -- 后者的有效期应该比地形短（地形可能被她自己改动），所以带 hits 计数和 last_at。
        CREATE TABLE IF NOT EXISTS fail (
            x INTEGER NOT NULL,
            z INTEGER NOT NULL,
            y INTEGER NOT NULL,
            hits INTEGER NOT NULL DEFAULT 1,
            last_at INTEGER NOT NULL,
            PRIMARY KEY (x, z, y)
        ) WITHOUT ROWID;

        -- 区块登记：**只有长宽**（四个角的 x/z），不含高度。
        -- 区块是 16×16 的平面网格，y 不参与区块归属 ——
        -- y 只是"这一列上有哪些面"，属于 surf 表的事。
        CREATE TABLE IF NOT EXISTS chunk_index (
            cx INTEGER NOT NULL,
            cz INTEGER NOT NULL,
            x0 INTEGER NOT NULL,   -- 西北角 x
            z0 INTEGER NOT NULL,   -- 西北角 z
            x1 INTEGER NOT NULL,   -- 东南角 x
            z1 INTEGER NOT NULL,   -- 东南角 z
            cells INTEGER NOT NULL,
            scanned_at INTEGER NOT NULL,
            PRIMARY KEY (cx, cz)
        ) WITHOUT ROWID;
    `);
    return db;
}

/** 语句缓存（WeakMap，避免每次 prepare） */
const STMTS = new WeakMap();
function stmts(db) {
    let s = STMTS.get(db);
    if (s) return s;
    s = {
        ins: db.prepare('INSERT OR REPLACE INTO surf (x, z, y, t) VALUES (?, ?, ?, ?)'),
        delCol: db.prepare('DELETE FROM surf WHERE x = ? AND z = ?'),
        regChunk: db.prepare(`INSERT OR REPLACE INTO chunk_index
            (cx, cz, x0, z0, x1, z1, cells, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        hasChunk: db.prepare('SELECT cells FROM chunk_index WHERE cx = ? AND cz = ?'),
        col: db.prepare('SELECT y, t FROM surf WHERE x = ? AND z = ? ORDER BY y DESC'),
        box: db.prepare('SELECT x, z, y, t FROM surf WHERE x BETWEEN ? AND ? AND z BETWEEN ? AND ? AND y BETWEEN ? AND ?'),
        at: db.prepare('SELECT 1 AS hit FROM surf WHERE x = ? AND z = ? AND y = ?'),
        cnt: db.prepare('SELECT COUNT(*) AS n FROM surf'),
        failIns: db.prepare(`INSERT INTO fail (x, z, y, hits, last_at) VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(x, z, y) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at`),
        failAll: db.prepare('SELECT x, z, y, hits FROM fail'),
        failClear: db.prepare('DELETE FROM fail WHERE x = ? AND z = ? AND y = ?'),
        chunks: db.prepare('SELECT COUNT(*) AS n FROM chunk_index'),
    };
    STMTS.set(db, s);
    return s;
}

/** 把一个方块名归类成表面类型；不是可站立面就返回 null。 */
export function classifyBlock(name) {
    if (!name) return null;
    // ★ 2026-10-28 修：**统一去掉命名空间前缀**。
    //
    // 实测 bug：她扫描时 bot.blockAt().name 返回 `minecraft:ladder`（带前缀），
    // 而所有分类正则和 AIR 集合都按无前缀写的 → 匹配失败 → 落进 SOLID 默认分支。
    // 后果：6 格梯子在库里变成"实心方块"，规划器看不到攀爬通道。
    // 之前没暴露是因为 stone/dirt 这类默认就走 SOLID，恰好不影响。
    const bare = name.startsWith('minecraft:') ? name.slice(10) : name;

    if (AIR.has(bare)) return null;
    if (LAVA_RE.test(bare)) return T.LAVA;
    if (WATER_RE.test(bare)) return T.WATER;
    if (CLIMB_RE.test(bare)) return T.CLIMBABLE;      // ★ 梯子/藤蔓：能爬，不能站
    if (LEAVES_RE.test(bare)) return T.LEAVES;
    if (BUILT_RE.test(bare)) return T.BUILT;
    return T.SOLID;
}

/**
 * 扫一个**球形范围**（用户要求：以她的脚为中心）。
 *
 * 对球内的每一列 (x,z)，从球顶往下扫，遇到"空气→实心"的边界就记一条。
 * 球形而不是方形：她在洞里时，方形扫描会把大量视距外的方块算进来，
 * 而球形保证"扫描范围内的所有可站立面都拿到"，范围语义清晰。
 *
 * @param {object} bot
 * @param {string} baseDir 3D 库所在目录
 * @param {{x:number,y:number,z:number}} center 球心（一般传她的脚）
 * @param {number} radius 半径（格）
 * @returns {{cells:number, columns:number, ms:number, chunks:number}}
 */
export function scanSphere(bot, baseDir, center, radius = 32) {
    const t0 = Date.now();
    const db = openDb3d(baseDir);
    const s = stmts(db);

    const cx = Math.floor(center.x);
    const cy = Math.floor(center.y);
    const cz = Math.floor(center.z);
    const r = Math.max(2, Math.floor(radius));
    const r2 = r * r;

    let cells = 0, columns = 0;
    const touched = new Map();   // "cx,cz" -> 计数

    db.exec('BEGIN');
    try {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                const d2xz = dx * dx + dz * dz;
                if (d2xz > r2) continue;                 // 水平不在圆内

                const wx = cx + dx, wz = cz + dz;
                // 这一列在球内的 y 跨度（球面会让边缘的列矮一些）
                const dyMax = Math.floor(Math.sqrt(Math.max(0, r2 - d2xz)));
                const yTop = Math.min(Y_MAX, cy + dyMax);
                const yBot = Math.max(Y_MIN, cy - dyMax);

                let prevAir = true;
                let prevLiquid = false;
                let found = 0;
                let loaded = 0, missing = 0;
                // 本列见过的最低（最深）水面 y。从上往下扫，第一个液体就是最高的水面。
                let waterTopY = null;

                // ★ 2026-10-28 修（关键）：**每列扫描前先清空该列旧记录**。
                //
                // 实测根因：同一列同时存在 6 个面（y=69/66/65/64/63），
                // 但复刻内层循环验证过 —— 当前逻辑对该列只会记录 1 条（y=69）。
                // 多出来的是**历史遗留**：早期有 bug 的版本写进去的脏数据，
                // 而 scanSphere 只 INSERT，从不清理 → 脏数据永久留存，
                // 规划器据此认为"那一列有好几个可站立面"，实际走不上去（NO_PATH）。
                //
                // 现在：先删这一列的旧面，再按当前逻辑重写。
                // 语义正确性：扫描 = "我现在看到的这一列是什么样"，就该覆盖旧认识。
                s.delCol.run(wx, wz);

                for (let y = yTop; y >= yBot; y--) {
                    // 用 bot.blockAt(Vec3)：项目里原子层统一这么取（atom_perceive.blockAt 也是）
                    let b;
                    try { b = bot.blockAt(new Vec3(wx, y, wz), false); } catch { b = null; }

                    // ★ 2026-10-27 修：**读不到 ≠ 空气**。
                    //
                    // 旧代码 `if (!b) { prevAir = true; continue; }` 把"没加载"当成空气，
                    // 于是扫到已加载部分的实心时，会误判成"空气→实心"边界，
                    // 记下一个根本不存在的可站立面 —— 这就是"球被墙切掉"的真身，
                    // 是我代码的错，不是游戏机制。
                    //
                    // 用户说得对：「为什么球会被墙切掉？这也不是现实生活吧，你直接扫不就 ok 了？」
                    // 对，直接扫：读不到就**中断这一列**，不记录任何面（宁可少记，不能记错）。
                    if (!b) { missing++; break; }

                    loaded++;
                    const name = String(b.name || '');
                    const isAir = AIR.has(name);

                    // 边界 = 从空气变实心 → 这个实心块的顶面能站。
                    //
                    // 水/岩浆要特殊处理：
                    //   只记这段连续液体的**最上面一格**（那才是真正的"水面/岩浆面"），
                    //   然后继续往下，水下的实心地面也要记（那才是能站的地方）。
                    //   若把水整体当"可穿过"，3 格厚的水会记 3 条水面，
                    //   一列里出现 y=62/61/60 三条水，全部无效。
                    const isLiquid = name && (WATER_RE.test(name) || LAVA_RE.test(name));

                    if (isLiquid) {
                        // 记录这一列最高的水面（第一个液体段的最顶格）
                        if (waterTopY === null && WATER_RE.test(name)) waterTopY = y;
                        // 判据用 prevLiquid（上一格是不是液体），不能用 prevAir ——
                        // 液体段内部 prevAir 一直是 true，会导致每格都记。
                        if (!prevLiquid) {
                            const t = classifyBlock(name);
                            if (t !== null) {
                                s.ins.run(wx, wz, y, t);
                                found++;
                                cells++;
                            }
                        }
                        prevLiquid = true;
                        prevAir = true;      // 液体"可穿过"，让水下地面也能被记录
                        continue;
                    }
                    prevLiquid = false;

                    // ★ 2026-10-28 修：**可攀爬方块要逐格记录，不能只记顶面**。
                    //
                    // 实测 bug：6 格高梯子（y=64..69 全是 ladder），库里只记了 y=69。
                    // 原因：这里是"空气→实心"的边界判定，y=69 记完 prevAir=false，
                    //      下面 y=68..64 的梯子就不再记了。
                    //
                    // 为什么这对攀爬是致命的：规划器要"沿这一列向上爬 N 格"，
                    // 必须知道中间每一格都是可攀爬的。只记顶面 = 整根梯子看不见。
                    //
                    // 处理：CLIMBABLE 每一格都记（它本来就是"通道"语义，不是"地面"语义）。
                    // 液体也保持"可穿过"，让水下的地面能被记录。
                    const tb = isAir ? null : classifyBlock(name);

                    if (tb === T.CLIMBABLE) {
                        s.ins.run(wx, wz, y, T.CLIMBABLE);
                        found++;
                        cells++;
                        // 可攀爬不是"地面"，所以 prevAir 保持 true，
                        // 它下方真正的地面仍然会被记录。
                        prevAir = true;
                        prevLiquid = false;
                        continue;
                    }

                    if (!isAir && prevAir) {
                        if (tb !== null) {
                            // ★ 2026-10-29：沉在水下的地面标成 SUBMERGED。
                            // 判据：这一列见过的最高水面比它高 → 它在水下。
                            // 注意只对 SOLID/BUILT 生效（水面/岩浆本身不标）。
                            let storeT = tb;
                            if (waterTopY !== null && y < waterTopY
                                && (tb === T.SOLID || tb === T.BUILT)) {
                                storeT = T.SUBMERGED;
                            }
                            s.ins.run(wx, wz, y, storeT);
                            found++;
                            cells++;
                        }
                    }
                    prevAir = isAir;
                }
                // 整列都没读到（区块完全没加载）：跳过，不当成"没有面"
                if (loaded === 0) continue;

                if (found > 0) {
                    columns++;
                    const k = `${Math.floor(wx / 16)},${Math.floor(wz / 16)}`;
                    touched.set(k, (touched.get(k) ?? 0) + found);
                }
            }
        }

        // 登记区块四角
        for (const [k, n] of touched) {
            const [pcx, pcz] = k.split(',').map(Number);
            s.regChunk.run(pcx, pcz, pcx * 16, pcz * 16, pcx * 16 + 15, pcz * 16 + 15, n, Date.now());
        }

        db.exec('COMMIT');
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        db.close();
        return { cells: 0, columns: 0, ms: Date.now() - t0, chunks: 0, error: e.message };
    }

    db.close();
    return { cells, columns, ms: Date.now() - t0, chunks: touched.size };
}

/**
 * 查一列的所有可站立面（从高到低）。
 * @returns {Array<{y:number, t:number}>}
 */
export function columnSurfaces(baseDir, x, z) {
    const db = openDb3d(baseDir);
    const rows = stmts(db).col.all(Math.floor(x), Math.floor(z));
    db.close();
    return rows.map(r => ({ y: r.y, t: r.t }));
}

/**
 * 查一个盒子内的所有面。
 * @returns {Array<{x:number,z:number,y:number,t:number}>}
 */
export function boxSurfaces(baseDir, x0, z0, x1, z1, yMin = Y_MIN, yMax = Y_MAX) {
    const db = openDb3d(baseDir);
    const rows = stmts(db).box.all(
        Math.floor(Math.min(x0, x1)), Math.floor(Math.max(x0, x1)),
        Math.floor(Math.min(z0, z1)), Math.floor(Math.max(z0, z1)),
        yMin, yMax);
    db.close();
    return rows;
}

/** 某格有没有表面记录（= 那个位置有可站立面）。 */
export function hasSurface(baseDir, x, y, z) {
    const db = openDb3d(baseDir);
    const hit = stmts(db).at.get(Math.floor(x), Math.floor(z), Math.floor(y));
    db.close();
    return !!hit;
}

/** 统计（给诊断用）。 */
export function stats3d(baseDir) {
    const db = openDb3d(baseDir);
    const s = stmts(db);
    const out = { cells: s.cnt.get().n, chunks: s.chunks.get().n };
    db.close();
    return out;
}

/**
 * 批量写入可站立面（给 .mca 导入用）。
 *
 * 与 scanSphere 的区别：scanSphere 从实时世界扫，这里从磁盘存档读。
 * 两者写同一张表，所以"导入的远距离地形"和"她走过扫的地形"能无缝拼起来。
 *
 * @param {string} baseDir
 * @param {Array<{x:number,z:number,y:number,t:number}>} cells
 * @param {{source?:string}} opts
 * @returns {{cells:number, chunks:number}}
 */
export function saveSurfaces(baseDir, cells, opts = {}) {
    if (!cells || !cells.length) return { cells: 0, chunks: 0 };
    const db = openDb3d(baseDir);
    const s = stmts(db);
    const touched = new Map();

    db.exec('BEGIN');
    try {
        for (const c of cells) {
            s.ins.run(c.x, c.z, c.y, c.t);
            const k = `${Math.floor(c.x / 16)},${Math.floor(c.z / 16)}`;
            touched.set(k, (touched.get(k) ?? 0) + 1);
        }
        for (const [k, n] of touched) {
            const [pcx, pcz] = k.split(',').map(Number);
            s.regChunk.run(pcx, pcz, pcx * 16, pcz * 16, pcx * 16 + 15, pcz * 16 + 15, n, Date.now());
        }
        db.exec('COMMIT');
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        db.close();
        return { cells: 0, chunks: 0, error: e.message };
    }

    db.close();
    return { cells: cells.length, chunks: touched.size };
}

/**
 * 只清一个区块在本库里的面（重导入前用，避免旧数据残留）。
 */
export function clearChunk(baseDir, cx, cz) {
    const db = openDb3d(baseDir);
    db.prepare('DELETE FROM surf WHERE x BETWEEN ? AND ? AND z BETWEEN ? AND ?')
        .run(cx * 16, cx * 16 + 15, cz * 16, cz * 16 + 15);
    db.prepare('DELETE FROM chunk_index WHERE cx = ? AND cz = ?').run(cx, cz);
    db.close();
}

/**
 * 记一次"这里走不通"（失败记忆）。
 *
 * 为什么是"记录"而不是"删除地形"：
 *   删掉地形数据的话，下一轮 scanSphere 会把它原样写回来 → 无限循环。
 *   本函数只记"这里走过失败"，地形数据不动 → 扫描不会覆盖，规划器读它来加价。
 *
 * @param {string} baseDir
 * @param {number} x @param {number} y @param {number} z
 * @param {{now?:number}} opts
 */
export function recordFail(baseDir, x, y, z, opts = {}) {
    const db = openDb3d(baseDir);
    stmts(db).failIns.run(Math.floor(x), Math.floor(z), Math.floor(y), opts.now ?? Date.now());
    db.close();
}

/**
 * 读全部失败记忆（规划器用来给这些格子加价）。
 *
 * 返回 Map<"x,y,z", hits>。过期的不返回：
 * 地形会被她自己改动，一个 10 分钟前的失败不该永久封锁。
 *
 * @param {string} baseDir
 * @param {{ttlMs?:number, now?:number}} opts
 */
export function readFails(baseDir, opts = {}) {
    const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    const now = opts.now ?? Date.now();
    const db = openDb3d(baseDir);
    const rows = stmts(db).failAll.all();
    db.close();
    const out = new Map();
    for (const r of rows) {
        if (now - r.last_at > ttlMs) continue;
        out.set(`${r.x},${r.y},${r.z}`, r.hits);
    }
    return out;
}

/** 清掉一条失败记忆（成功走到之后调用，避免误封锁）。 */
export function clearFail(baseDir, x, y, z) {
    const db = openDb3d(baseDir);
    stmts(db).failClear.run(Math.floor(x), Math.floor(z), Math.floor(y));
    db.close();
}
