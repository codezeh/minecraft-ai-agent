/**
 * 给模型读的地形查询（!map）—— 2026-10-27 改用真 3D 库（terrain3d）。
 *
 * 与 !survey 的分工：
 *   !survey  → 现场扫球（terrain3d.scanSphere），看"我这周围长什么样"
 *   !map     → 读库里已积累的 3D 面数据，回答「附近有什么 / 目标在哪个方向 /
 *              哪里还没去过」（不重扫，范围大，有记忆）
 *
 * 为什么重写：
 *   旧版读 chunks.db（2.5D 单层地表），它回答不了"这一层能不能走"。
 *   实测她站在一个面上、四周 3 格内都没有同层面的位置，旧地图显示"72% 连通可走"。
 *   新库每列可以有多个面（洞穴地面/天花板/悬空平台），才说得清这件事。
 *
 * 不重扫是刻意的：!map 要能被频繁调用而不卡住主线程。
 * 需要刷新时用 `!map refresh`（会扫一次球）。
 */
import { mapDirOf } from './bot_paths.js';
import { scanSphere, boxSurfaces, columnSurfaces, stats3d, T } from './terrain3d.js';
import { loadLandmarks } from './landmarks.js';

// 2026-11-02：不再自己拼路径，统一走 bot_paths.mapDirOf（零依赖 infra）
const BASE_DIR = (bot) => mapDirOf(bot);

const TYPE_NAME = { [T.SOLID]: '实心', [T.WATER]: '水', [T.LAVA]: '岩浆', [T.BUILT]: '建筑', [T.LEAVES]: '树叶' };

/** 把方向换成八个方位词，模型更容易懂。 */
function compass(dx, dz) {
    if (Math.abs(dx) < 16 && Math.abs(dz) < 16) return '就在附近';
    const ns = Math.abs(dz) < 4 ? '' : (dz > 0 ? '南' : '北');
    const ew = Math.abs(dx) < 4 ? '' : (dx > 0 ? '东' : '西');
    return (ns + ew) || '附近';
}

/**
 * 生成地图摘要。
 * @param {object} bot
 * @param {object} opts { radius=4(区块), refresh=false, goal=null }
 */
export function mapSummary(bot, opts = {}) {
    const { radius = 4, refresh = false, goal = null } = opts;
    const dir = BASE_DIR(bot);
    const p = bot.entity.position;
    const cx = Math.floor(p.x / 16);
    const cz = Math.floor(p.z / 16);
    const spanBlocks = radius * 16;

    const lines = [];
    lines.push(`我在 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})，区块 (${cx},${cz})。`);

    // ---- 一、刷新（可选）----
    if (refresh) {
        const r = scanSphere(bot, dir, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
            Math.max(16, spanBlocks));
        lines.push(`刚扫了半径 ${Math.max(16, spanBlocks)} 格的球：新增 ${r.cells} 个可站立面` +
            `（${r.columns} 列 / ${r.chunks} 区块），用时 ${r.ms}ms。`);
    }

    // ---- 二、库里有什么 ----
    let st = { cells: 0, chunks: 0 };
    try { st = stats3d(dir); } catch { /* 库读不到就当空 */ }
    lines.push(`3D 库共记录 ${st.cells} 个可站立面 / ${st.chunks} 个区块。`);

    // ---- 三、她脚下这一列有几个面（关键：2.5D 看不见的能力）----
    try {
        const col = columnSurfaces(dir, Math.floor(p.x), Math.floor(p.z));
        if (col.length) {
            const desc = col.slice(0, 5).map(c => `y=${c.y}(${TYPE_NAME[c.t] ?? c.t})`).join('、');
            lines.push(`我这一列有 ${col.length} 个可站立面：${desc}。`);
        } else {
            lines.push('我这一列还没有记录（用 !map refresh 扫一下）。');
        }
    } catch { /* ignore */ }

    // ---- 四、这一层能不能走（真 3D 才回答得了）----
    try {
        const hy = Math.floor(p.y);
        const near = boxSurfaces(dir, Math.floor(p.x) - 8, Math.floor(p.z) - 8,
            Math.floor(p.x) + 8, Math.floor(p.z) + 8, hy - 2, hy + 2);
        const sameLevel = near.filter(f => Math.abs(f.y - hy) <= 1).length;
        if (near.length === 0) {
            lines.push(`周围 8 格内这一层没有可站立面（可能需要挖/搭出去）。`);
        } else {
            lines.push(`周围 8 格内、和我同层（±1 格）的可站立面有 ${sameLevel} 个` +
                (sameLevel < 3 ? ' —— 空间很窄，可能被围住。' : '。'));
        }
    } catch { /* ignore */ }

    // ---- 五、附近地形分布（按类型统计，不假设"一层"）----
    try {
        const hy = Math.floor(p.y);
        const box = boxSurfaces(dir, Math.floor(p.x) - spanBlocks, Math.floor(p.z) - spanBlocks,
            Math.floor(p.x) + spanBlocks, Math.floor(p.z) + spanBlocks, hy - 24, hy + 24);
        if (box.length) {
            const cnt = { water: 0, lava: 0, built: 0, leaves: 0, solid: 0 };
            let minY = Infinity, maxY = -Infinity;
            for (const f of box) {
                if (f.t === T.WATER) cnt.water++;
                else if (f.t === T.LAVA) cnt.lava++;
                else if (f.t === T.BUILT) cnt.built++;
                else if (f.t === T.LEAVES) cnt.leaves++;
                else cnt.solid++;
                if (f.y < minY) minY = f.y;
                if (f.y > maxY) maxY = f.y;
            }
            lines.push(`附近 ${spanBlocks * 2} 格见方（高 ±24）：实心 ${cnt.solid}、水 ${cnt.water}、` +
                `岩浆 ${cnt.lava}、建筑 ${cnt.built}、树叶 ${cnt.leaves}；高度 y=${minY}~${maxY}。`);

            // 最近的水
            const water = box.filter(f => f.t === T.WATER)
                .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
            if (water) {
                lines.push(`最近的水在 ${compass(water.x - p.x, water.z - p.z)}方向，约 ${Math.round(Math.hypot(water.x - p.x, water.z - p.z))} 格（y=${water.y}）。`);
            }
            // 最近的高处平地（y 和她接近、周围面多）
            const flatish = box.filter(f => f.t === T.SOLID && Math.abs(f.y - hy) <= 3)
                .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
            if (flatish) {
                lines.push(`最近同层实心面在 ${compass(flatish.x - p.x, flatish.z - p.z)}方向，约 ${Math.round(Math.hypot(flatish.x - p.x, flatish.z - p.z))} 格（y=${flatish.y}）。`);
            }
        } else {
            lines.push(`附近 ${spanBlocks * 2} 格见方还没有 3D 记录。`);
        }
    } catch { /* ignore */ }

    // ---- 六、记住的地点（家 / 仓库 / 箱子）——真正的方向感锚点 ----
    try {
        const lm = loadLandmarks(bot);
        const anchors = [];
        const asPos = (o) => (o && Number.isFinite(o.x) && Number.isFinite(o.z)) ? o : null;
        for (const c of (lm.chests || []).slice(0, 3)) {
            const pos = asPos(c);
            if (pos) anchors.push([`箱子${c.note ? '(' + c.note + ')' : ''}`, pos]);
        }
        const storagePos = asPos(lm.storage);
        if (storagePos) anchors.push(['仓库', storagePos]);
        for (const s of (lm.sites || []).slice(0, 4)) {
            const pos = asPos(s);
            if (pos) anchors.push([s.note || '地点', pos]);
        }
        if (anchors.length) {
            // 聚成「一片」再说：三个箱子都在北西 60 格外时，说「仓库区」比列三行有用。
            const groups = [];
            for (const [label, pos] of anchors) {
                const d = Math.round(Math.hypot(pos.x - p.x, pos.z - p.z));
                const dirWord = compass(pos.x - p.x, pos.z - p.z);
                const bucket = groups.find(g => g.dir === dirWord && Math.abs(g.d - d) < 24);
                if (bucket) { bucket.items.push(label); bucket.d = Math.min(bucket.d, d); }
                else groups.push({ dir: dirWord, d, dy: Math.round(pos.y - p.y), items: [label] });
            }
            groups.sort((a, b) => a.d - b.d);
            const top = groups.slice(0, 3).map(g => {
                const what = g.items.length > 1
                    ? `${g.items[0].replace(/\(.*?\)/, '')}等 ${g.items.length} 处`
                    : g.items[0];
                const hi = Math.abs(g.dy) > 2 ? `，高差 ${g.dy > 0 ? '+' : ''}${g.dy}` : '';
                return `${what}在 ${g.dir} 约 ${g.d} 格外${hi}`;
            });
            const more = groups.length > 3 ? `（另有 ${groups.length - 3} 处在更远处）` : '';
            lines.push(`我记得：${top.join('；')}${more}。`);
        }
    } catch { /* 没有地标就不说 */ }

    // ---- 七、未探索的方向 ----
    try {
        const unexplored = [];
        for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]]) {
            const qx = Math.floor(p.x) + dx * spanBlocks;
            const qz = Math.floor(p.z) + dz * spanBlocks;
            const probe = boxSurfaces(dir, qx - 4, qz - 4, qx + 4, qz + 4,
                Math.floor(p.y) - 16, Math.floor(p.y) + 16);
            if (!probe.length) unexplored.push(compass(dx * 16, dz * 16));
        }
        if (unexplored.length) {
            lines.push(`还没去过：${[...new Set(unexplored)].join('、')}（朝那边走能补全地图）。`);
        }
    } catch { /* ignore */ }

    // ---- 八、指定目标时的可达性提示（不再假装能算出全程）----
    if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.z)) {
        const d = Math.round(Math.hypot(goal.x - p.x, goal.z - p.z));
        lines.push(`去 (${Math.floor(goal.x)},${Math.floor(goal.z)}) 直线约 ${d} 格。` +
            `导航是走一段重算一段（每段约 16 格），所以只能边走边看。`);
    }

    return lines.join('\n');
}
