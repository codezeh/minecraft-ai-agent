/**
 * L2 复合技能：清除障碍物。
 *
 * 场景（用户实测反馈）：「丛林里树被藤蔓包裹时，她就不砍那棵树了」。
 *
 * 为什么之前不砍 —— 两个原因叠加：
 *   1) `bot.dig()` 需要先 `lookAt` 成功。藤蔓贴在树干表面时视线被挡，
 *      表现为"隔着藤蔓砍空气"，dig 失败。
 *   2) 藤蔓在 pathfinder 的 climbables 里 → 她尝试"爬"而不是清掉 → 卡住/放弃。
 *
 * 这个技能的职责：在挖目标之前，产出「先挖掉挡路方块」的步骤序列。
 *
 * 设计（遵循 L2 契约，见 复合层改造规划 §2）：
 *   - 只产出步骤，不执行（执行交给 step_runner）
 *   - 读世界但不改变世界（可重复调用、可打印）
 *
 * 与旧 `vine_clear.js` 的区别：
 *   旧实现只沿「眼睛→目标」采样——而藤蔓是**贴着树干长**的，
 *   视线根本不穿过它，所以永远找不到（这就是"包裹就不砍"的第二个原因）。
 *   这里改成两路都扫：视线采样 + 目标周围一圈。
 */
import { blockAt, eyePosition } from './query_perceive.js';
import { EYE_HEIGHT } from '../rules/rules.runtime.js';

/** 算作"软障碍"、值得先清掉的方块 */
const SOFT_OBSTACLE = /_vine$|^vine$|_leaves$|^cobweb$|^kelp$|^kelp_plant$|^short_grass$|^tall_grass$|^fern$|^large_fern$/;
/** 藤蔓类（围绕树干生长，必须扫四周） */
const VINE = /_vine$|^vine$/;

/**
 * 找出挡在「眼睛 → 目标」之间的软障碍。
 *
 * 注意：采样步长 1/3 格。步长太大（如 1 格）会漏掉 1 格厚的藤蔓。
 */
export function blockersOnSightLine(bot, target, opts = {}) {
    const { maxBlocks = 8 } = opts;
    const eye = eyePosition(bot);
    const t = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
    const dx = t.x - eye.x, dy = t.y - eye.y, dz = t.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return [];

    const steps = Math.min(30, Math.ceil(dist * 3));
    const seen = new Set();
    const out = [];
    for (let i = 1; i < steps; i++) {
        const f = i / steps;
        const p = {
            x: Math.floor(eye.x + dx * f),
            y: Math.floor(eye.y + dy * f),
            z: Math.floor(eye.z + dz * f),
        };
        const k = `${p.x},${p.y},${p.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        // 别把目标自己当成障碍
        if (p.x === target.x && p.y === target.y && p.z === target.z) continue;
        const b = blockAt(bot, p);
        if (!b) continue;
        if (SOFT_OBSTACLE.test(b.name)) out.push({ pos: p, name: b.name });
        if (out.length >= maxBlocks) break;
    }
    return out;
}

/**
 * 找出紧贴目标的软障碍（藤蔓/树叶）。
 *
 * 为什么必须单独扫：藤蔓/树叶是"贴"在方块侧面的，视线从眼睛到方块中心
 * 可能完全不经过它，但它确实挡住了 `lookAt` 判定。
 * 所以要把目标周围的 5 个面都看一遍（上下左右 + 上面）。
 */
export function vinesAround(bot, target, opts = {}) {
    const { maxBlocks = 6, alsoAbove = true } = opts;
    // 水平四面必有；上面也可能挂藤蔓；下面一般不挡视线
    const dirs = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        ...(alsoAbove ? [[0, 1, 0]] : []),
    ];
    const out = [];
    for (const [dx, dy, dz] of dirs) {
        if (out.length >= maxBlocks) break;
        const p = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
        const b = blockAt(bot, p);
        if (!b) continue;
        // 不只是藤蔓：树叶同样会贴住/包住树干，一样挡 lookAt。
        // 实测（skill_clear 测试）：只认 vine 时，12 处叶子包围只识别出 1 处。
        if (SOFT_OBSTACLE.test(b.name)) out.push({ pos: p, name: b.name });
    }
    return out;
}

/**
 * 判断目标是不是"被软障碍包住"。
 *
 * 用途：`planCollect` 在决定"要不要砍这棵树"之前，先用它判断
 * 「是包住了（该清）」还是「根本没戏（该跳过）」。
 *
 * @returns {{blocked:boolean, blockers:Array<{pos,name}>, vines:number, leaves:number, why:string}}
 */
export function inspectObstacles(bot, target, opts = {}) {
    const sight = blockersOnSightLine(bot, target, opts);
    const around = vinesAround(bot, target, opts);

    // 合并去重：同一格可能既在视线上、又是贴着的藤蔓
    const map = new Map();
    for (const b of [...around, ...sight]) {
        map.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b);
    }
    const blockers = [...map.values()];
    const vines = blockers.filter(b => VINE.test(b.name)).length;
    const leaves = blockers.filter(b => /_leaves$/.test(b.name)).length;

    let why;
    if (!blockers.length) why = '没有挡路方块';
    else if (vines) why = `${vines} 处藤蔓挡着${leaves ? `，另有 ${leaves} 处树叶` : ''}`;
    else why = `${leaves} 处树叶挡着`;

    return { blocked: blockers.length > 0, blockers, vines, leaves, why };
}

/**
 * 规划「清除障碍」的步骤序列。
 *
 * @param {object} bot
 * @param {{x,y,z}} target 要清理的目标方块（比如树干）
 * @param {object} opts { maxClear=4, group }
 * @returns {{ok:boolean, steps:Array, blockers:Array, why:string}}
 */
export function planClearObstacles(bot, target, opts = {}) {
    const { maxClear = 4, group = null } = opts;
    const info = inspectObstacles(bot, target, { maxBlocks: maxClear });

    if (!info.blocked) {
        return { ok: false, steps: [], blockers: [], why: info.why };
    }

    let stepNo = 0;
    const steps = info.blockers.slice(0, maxClear).map(b => ({
        // 注意：step 序号由 planCollect 统一重编，这里只给临时序号
        step: ++stepNo,
        atom: 'digBlock',
        phase: 'clear',
        args: { target: { kind: 'block', pos: b.pos } },
        expect: 'gone',
        pos: b.pos,
        group,
        // 清障碍失败不致命：可能这格其实不挡路，或者挖不动（比如硬方块）。
        // 失败就继续，让后面的 digBlock 自己去报真实原因。
        onFail: [
            { code: 'INTERRUPTED', action: 'abort' },
            { code: '*', action: 'next' },
        ],
        obstacleOf: { x: target.x, y: target.y, z: target.z },
        obstacleName: b.name,
    }));

    return { ok: true, steps, blockers: info.blockers, why: info.why };
}
