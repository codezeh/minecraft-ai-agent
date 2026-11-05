/**
 * 战棋式地图层：把区块当成「格子」，每格带地形标签 + 通行代价。
 *
 * 为什么要这一层（用户的战棋类比）：
 *   - 她读「一格 = 森林坡地」比读「y=63 h=27 water=0.03」快得多
 *   - 知道「我在第 (-7,-14) 格」，方向感有了锚点
 *   - 移动可以「跳格」：每格内只用精导航走 16 格，搜索空间从几百格降到十几格
 *
 * 注意：直线切区块【不是】最优路线 —— 它会穿湖、翻山、穿房子。
 * 所以这里做的是【带代价的格子 A*】：
 *   水高代价、岩浆禁行、建筑绕行、高差罚分、未探索给中等代价（可试探）。
 */
import { getChunk, findChunkWith, openMapReader } from './chunk_map.js';

// 加权 A* 的启发式权重（Baritone 默认 1.67）。
// 标准 A* 在格子图上搜索量大；加权后明显变快，代价是路线可能略长。
const H_WEIGHT = 1.67;

/** 一格的语义标签。判据来自 chunk_map 的真实统计值。 */
export function classifyChunk(info) {
    if (!info || info.explored === false) return { label: '未探索', key: 'unknown', sym: '?' };
    if (info.lava > 0.05) return { label: '岩浆', key: 'lava', sym: '!' };
    if (info.water > 0.6) return { label: '水面', key: 'water', sym: '~' };
    if (info.built > 0.3) return { label: '建筑区', key: 'built', sym: 'B' };
    if (info.h > 18) return { label: '陡坡', key: 'cliff', sym: '^' };
    if (info.leaves > 0.12) return { label: '树林', key: 'forest', sym: 'T' };
    if (info.h > 8) return { label: '丘陵', key: 'hill', sym: 'n' };
    return { label: '平地', key: 'flat', sym: '.' };
}

/**
 * 通行代价（越大越不想走）。用于格子 A*。
 * 0 = 不能走。未探索给中等代价，让她愿意去探路。
 */
export function tileCost(info) {
    if (!info) return 6;                       // 未探索：可以试，但不优先
    const t = classifyChunk(info);
    switch (t.key) {
        case 'lava': return 0;                  // 禁行
        // 水面：实测 pathfinder 本身会游泳（20 格水面 14 秒走通，四种配置全过）。
        // 原来设 40 导致长规划直接绕开水域，相当于把「能过」变成「永远不过」。
        // 调到 6：能游、但不优先（Baritone 的 maxWaterDist=256 是同一种思路）。
        case 'water': return 6;
        case 'cliff': return 25;                // 陡坡，容易卡
        case 'built': return 18;                // 玩家的建筑，尽量绕
        case 'forest': return 5;                // 树林：树会挡路
        case 'hill': return 4;
        default: return 1;                      // 平地最好走
    }
}

/** 相邻格之间的额外代价：高差越大越贵（爬升比平走累）。 */
function stepPenalty(a, b) {
    if (!a || !b) return 0;
    const dy = Math.abs((a.y ?? b.y) - (b.y ?? a.y));
    return dy > 6 ? dy * 1.5 : dy * 0.3;
}

/**
 * 相邻格能不能走：高差超过 16 格基本不可能（真世界实测相邻区块平均高度差
 * 常在 8~15 格之间，阈值设 8 会直接把整个 A* 走成无解）。
 * 16~30 格的山坡交给细规划去处理（它会挖/搭/绕）；>16 才认为跨不过去。
 */
function crossable(a, b) {
    if (!a || !b) return true;                     // 未探索格不拦，允许试探
    const dy = Math.abs((a.y ?? b.y) - (b.y ?? a.y));
    return dy <= 16;
}

/** 极简二叉堆（按 f 排序）。线性扫在 360 节点时就要 124ms，必须用堆。 */
class MinHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(node) {
        const a = this.a;
        a.push(node);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].f <= a[i].f) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop() {
        const a = this.a;
        const top = a[0];
        const last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l].f < a[m].f) m = l;
                if (r < a.length && a[r].f < a[m].f) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }
}

/**
 * 在格子上跑 A*（8 邻接）。
 * @returns {path:[{cx,cz,label,sym,info}], cost} 无路时 path=[]
 */
/**
 * 在区块图上跑 A*。
 *
 * @returns {{
 *   path: Array,                      // 找到时是从起点到终点的格子序列
 *   cost: number,                     // 总代价（找不到时 Infinity）
 *   nodes: number,                    // 扩展了几个节点
 *   status: 'found'|'exhausted'|'budget'   // ★ 三种结束方式必须分开
 * }}
 *
 * 为什么要 `status`（2026-10-26 重构）：
 *   原来预算用完和真没路都返回 `path: []`，调用方无法区分。
 *   后果：`task_hop` 把"没算完"当成"绕不过去"，直接放弃整段路
 *   —— 明明能去的地方，她说不去。
 *   这和 `atom_move` 里 "Took to long" 被归成 INTERNAL 是同一类错误。
 */
export function tileAStar(baseDir, from, to, { maxNodes = 4000 } = {}) {
    const sx = Math.floor(from.x / 16), sz = Math.floor(from.z / 16);
    const tx = Math.floor(to.x / 16), tz = Math.floor(to.z / 16);

    // 性能关键：getChunk() 每次都要 readFile + JSON.parse，而 A* 每扩展一个节点
    // 要看 8 个邻居，跑下来就是几百次磁盘读（实测 119ms）。
    // 用区域缓存读取器后降到个位数毫秒。
    const reader = openMapReader(baseDir);
    const info = (cx, cz) => reader.chunk(cx, cz);

    const key = (x, z) => `${x},${z}`;
    const h = (x, z) => Math.hypot(x - tx, z - tz);      // 八方向用欧氏启发

    const open = new MinHeap();
    open.push({ x: sx, z: sz, g: 0, f: h(sx, sz), parent: null });
    const seen = new Map([[key(sx, sz), 0]]);
    let nodes = 0;

    while (open.size && nodes < maxNodes) {
        const cur = open.pop();
        nodes++;

        if (cur.x === tx && cur.z === tz) {
            const path = [];
            let n = cur;
            while (n) { path.push(n); n = n.parent; }
            path.reverse();
            return {
                path: path.map(p => {
                    const inf = info(p.x, p.z);
                    const t = classifyChunk(inf);
                    return { cx: p.x, cz: p.z, label: t.label, sym: t.sym, info: inf };
                }),
                cost: cur.g,
                nodes,
                status: 'found',
            };
        }

        const curInfo = info(cur.x, cur.z);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const nx = cur.x + dx, nz = cur.z + dz;
            const ni = info(nx, nz);
            const c = tileCost(ni) * (dx && dz ? 1.414 : 1);   // 斜走略贵
            if (c === 0) continue;                             // 禁行

            // 斜穿墙角检查（2026-10-26）：对角移动必须两个正交邻格都能过。
            // Minecraft 玩家箱体 0.6 宽，斜穿 1 格墙角会卡住；
            // 原来只查对角目标格，会规划出物理上走不通的路。
            if (dx && dz) {
                const sideA = info(cur.x + dx, cur.z);
                const sideB = info(cur.x, cur.z + dz);
                if (tileCost(sideA) === 0 || tileCost(sideB) === 0) continue;
                if (!crossable(curInfo, sideA) || !crossable(curInfo, sideB)) continue;
            }
            // 高差太大 = 跨不过去（细规划必然失败），直接不连边
            if (!crossable(curInfo, ni)) continue;
            const g = cur.g + c + stepPenalty(curInfo, ni);
            const k = key(nx, nz);
            if (seen.has(k) && seen.get(k) <= g) continue;
            seen.set(k, g);
            // 加权 A*：h 乘 1.67（Baritone 的默认 hWeight）。
            // 标准 A* 在格子上搜索量大；加权后明显变快，代价是路线可能略长。
            // 1.67 是 Baritone 实测值，这里沿用。
            open.push({ x: nx, z: nz, g, f: g + h(nx, nz) * H_WEIGHT, parent: cur });
        }
    }
    // 循环结束有两种原因，必须分开报（见函数头说明）
    const status = open.size === 0 ? 'exhausted' : 'budget';
    return { path: [], cost: Infinity, nodes, status };
}

/**
 * 渲染成给模型读的文字格图。
 * 上=北(z小)，右=东(x大)；@ 是她，+ 是目标。
 */
export function renderTileGrid(baseDir, cx, cz, radius = 4, goal = null) {
    const gx = Math.floor(goal ? goal.x / 16 : NaN);
    const gz = Math.floor(goal ? goal.z / 16 : NaN);
    const rows = [];
    for (let dz = -radius; dz <= radius; dz++) {
        let line = '';
        for (let dx = -radius; dx <= radius; dx++) {
            const x = cx + dx, z = cz + dz;
            if (dx === 0 && dz === 0) { line += '@'; continue; }
            if (x === gx && z === gz) { line += '+'; continue; }
            const inf = getChunk(baseDir, x, z);
            line += classifyChunk(inf).sym;
        }
        rows.push(line);
    }
    const legend = '@我  +目标  .平地  T树林  n丘陵  ^陡坡  B建筑  ~水面  !岩浆  ?未探索';
    return { rows, legend, north: '上=北(z 小)，右=东(x 大)，每格 16 格见方' };
}

/** 一行文字总结「我在哪、附近有什么格」。 */
export function describeTile(baseDir, cx, cz) {
    const inf = getChunk(baseDir, cx, cz);
    const t = classifyChunk(inf);
    if (!inf) return `我在格 (${cx},${cz})，这格还没探索过。`;
    return `我在格 (${cx},${cz})：${t.label}（地表 y=${inf.y}，格内高差 ${inf.h}，水 ${inf.water}，建筑 ${inf.built}）。`;
}
