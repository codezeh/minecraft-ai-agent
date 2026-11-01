/**
 * 复合：在中心点周围铺一个 3×3 平台。
 *
 * 策略层职责（原子层不做这些）：
 * - 每格最多 3 次尝试，失败不结束任务，而是换个站位再来
 * - 每格先查是否已经是目标方块（幂等，重跑不会重复消耗材料）
 * - deadline + 中断检查，结束只给一行结论
 *
 * 顺序很关键：先放离自己近的、贴地的格子，后面格子就能靠刚放好的方块当侧面支撑。
 */
import { ok, fail } from './contract.js';
import { blockAt } from './query_perceive.js';
import { placeBlockAt } from './act_place.js';
import { moveTo } from './nav_pathfinder.js';
import { pauseGoalModes, restoreGoalModes } from './modes.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 3×3 的九个格子（含中心）。 */
export function platformCells(center) {
    const cells = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            cells.push({ x: center.x + dx, y: center.y, z: center.z + dz });
        }
    }
    return cells;
}

function distTo(bot, p) {
    const b = bot.entity.position;
    return Math.hypot(p.x + 0.5 - b.x, p.y + 0.5 - b.y, p.z + 0.5 - b.z);
}

/** 站到平台外面一点，避免自己占着格子、也避免贴脸放不出来。 */
async function stepAside(bot, center, cell, timeout = 8000) {
    const b = bot.entity.position;
    // 远离中心的那一侧，2 格以外
    const dx = Math.sign(cell.x - center.x) || (b.x >= center.x ? 1 : -1);
    const dz = Math.sign(cell.z - center.z) || (b.z >= center.z ? 1 : -1);
    const spot = { x: center.x + dx * 2.5, y: center.y, z: center.z + dz * 2.5 };
    return await moveTo(bot, { kind: 'point', pos: spot }, { tol: 1, timeout });
}

/**
 * @param {object} center  3×3 的中心格（整数坐标）
 * @param {object} opts    deadlineMs / attempts / onEvent
 * @returns ActionResult   data: { placed, want, cells, failed, costMs }
 */
export async function placePlatform(bot, item, center, opts = {}) {
    const { deadlineMs = 10 * 60 * 1000, attempts = 3, onEvent = () => {} } = opts;
    const start = Date.now();

    if (!center || ![center.x, center.y, center.z].every(Number.isFinite)) {
        return fail('NO_TARGET', '没给平台中心坐标');
    }
    const c = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) };
    const cells = platformCells(c);

    const placedSet = [];
    const failed = [];

    // 放置期间暂停会抢 goal 的 mode（unstuck 会把正在放的她挪走）
    const pausedBefore = pauseGoalModes(bot);
    try {

    // 近的先放：这样后面的格子能靠刚放好的方块当侧支撑
    const order = [...cells].sort((a, b) => distTo(bot, a) - distTo(bot, b));

    for (const cell of order) {
        if (Date.now() - start > deadlineMs) break;
        if (bot.interrupt_code) {
            return fail('INTERRUPTED', `停了，平台放了 ${placedSet.length}/9`, {
                placed: placedSet.length, want: 9, costMs: Date.now() - start,
            });
        }

        // 幂等：已经是目标方块就跳过（重跑不重复消耗材料）
        if (blockAt(bot, cell)?.name === item) {
            placedSet.push(cell);
            continue;
        }

        let last = null;
        for (let i = 0; i < attempts; i++) {
            if (bot.interrupt_code) break;
            const r = await placeBlockAt(bot, { kind: 'block', pos: cell }, item);
            last = r;

            if (r.ok) {
                placedSet.push(cell);
                onEvent({ type: 'placed', pos: cell, try: i + 1 });
                break;
            }

            // 够不着 / 站在格子里 / 没支撑：换个站位再试（这是策略层该干的）
            if (r.code === 'OUT_OF_REACH' || r.code === 'NO_PATH'
                || (r.code === 'OCCUPIED' && /站/.test(r.message))) {
                await stepAside(bot, c, cell);
                await sleep(120);
                continue;
            }
            // 客户端丢 blockUpdate（已知竞态）：等一下重试同一格，不换站位
            if (r.code === 'BLOCKED' || r.code === 'INTERNAL') {
                await sleep(300);
                continue;
            }
            break;   // NO_ITEM / NO_SUPPORT / 其他：换站位也没用，直接记下换下一格
        }

        if (!placedSet.includes(cell)) {
            failed.push({ pos: cell, code: last?.code ?? 'INTERNAL', message: last?.message ?? '' });
            onEvent({ type: 'failed', pos: cell, code: last?.code });
        }
    }

    const costMs = Date.now() - start;
    const data = {
        placed: placedSet.length,
        want: cells.length,
        failed,
        costMs,
    };

    if (placedSet.length === cells.length) return ok(data);
    if (failed.some(f => f.code === 'NO_ITEM')) {
        return fail('NO_ITEM', `材料不够，只放了 ${placedSet.length}/${cells.length}`, data);
    }
    return fail('NO_SUPPORT', `只放了 ${placedSet.length}/${cells.length}`, data);

    } finally {
        restoreGoalModes(bot, pausedBefore);
    }
}
