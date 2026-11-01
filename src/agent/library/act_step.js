/**
 * 动作：单格移动（M6 P1，02 §3.6）。
 *
 *   stepInto(cell)  相邻一格、能站 → lookAt 格心 → holdKey('forward', {until: 进格}) → 脚位在该格
 *
 * 为什么要它（02 §3.6 原话）：
 *   "executor 现在每个单格步骤都调 `moveToXZ`，也就是每走一格都起一次 pathfinder。
 *    爬梯前空等 20 秒是这个结构的一个症状：目标格是梯子，`GoalNearXZ` 永远不 resolve。"
 *
 * ★ 但**不能拿它无脑替换 moveToXZ**（2026-11-02 的取舍，写在这里防止以后有人"顺手全换"）：
 *   pathfinder 会做的事远不止"朝一格按前进"：跨 1 格沟、绕开挡路方块、开门、找落点。
 *   `stepInto` 只按前进 —— 遇到沟、台阶、门、活板门它都只会撞上去然后 TIMEOUT。
 *   所以调用方必须**自己判断"这一格确实能走进去"**（相邻、同层、落点可站、没液体），
 *   剩下的交给 pathfinder。这与 4b4ac1c 的教训同源：**判据要钉在具体成因上，宽判据会伤别的场景**。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { holdKey } from './atom_input_move.js';
import { lookAtPoint } from './atom_input_mouse.js';

/**
 * 进格判据：**脚位格子 == 目标格**。
 *
 * ★ 2026-11-02 修（captain 抓的"假成功死循环"）：
 *   原来用的是「到格心水平距离 ≤ 0.5」—— 她在被方块挡住时会停在 0.5 边缘，
 *   于是**被判定成已经进格**。后果比失败严重得多：
 *   `execStep` 报成功 → `walkTo` 以为这一步推进了 → 从同一位置重新规划 →
 *   `stalled` 计数被"成功"重置 → 永远到不了 `STUCK` → 无日志空转 13 分钟
 *   （实测：接入 stepInto 后 `digdown #2` 卡死）。
 *
 *   **假成功比失败更糟：失败会重规划，假成功会死循环。**
 *   （与 `4b4ac1c` 那条"提前判到位"是同一类错。）
 *
 * 现在改成读**脚位格子**：`Math.floor(位置) === 目标格`，三轴都要对。
 * 她要么真在那一格里，要么就是没进——没有"差不多"。
 */
export function insideCell(p, cell) {
    if (!p || !cell) return false;
    return Math.floor(p.x) === cell.x
        && Math.floor(p.y) === cell.y
        && Math.floor(p.z) === cell.z;
}

/** @deprecated 旧的"水平 0.5"口径，已被 insideCell 取代；保留导出只为不破坏既有调用方。 */
export const STEP_ARRIVE_XZ = 0.5;

/** 一格的水平尺度：只有"相邻一格"才归本动作管。 */
export const STEP_ADJACENT_MAX = 1.5;

/**
 * 朝相邻一格走近并进去。
 *
 * @param {object} cell {pos:{x,y,z}}（**脚位**所在的格）或 Vec3
 * @param {object} opts { timeoutMs = 6000, maxReach = STEP_ADJACENT_MAX }
 * @returns ActionResult
 *   ok        → data: { cell, from, to, costMs }
 *   NO_TARGET 目标格无效
 *   UNSAFE    落点不可站（脚下没实心/是液体）—— 与 BLOCKED 的区别：UNSAFE 是"这格不该去"
 *             （落点检查的语义），BLOCKED 是"这格可以去但走不进去"
 *   TIMEOUT   按着前进但没能进格 —— 与 BLOCKED 的区别：TIMEOUT 是"一直在试但没到"，
 *             BLOCKED 是"立刻判定做不了"
 *   INTERRUPTED 被取消
 */
export async function stepInto(bot, cell, opts = {}) {
    const { timeoutMs = 6000, maxReach = STEP_ADJACENT_MAX } = opts;
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const raw = cell?.pos ?? cell;
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isFinite(raw.z)) {
        return fail('NO_TARGET', '目标格无效');
    }
    const target = { x: Math.floor(raw.x), y: Math.floor(raw.y), z: Math.floor(raw.z) };
    const p0 = bot.entity?.position;
    if (!p0) return fail('NO_TARGET', '读不到自己的坐标');

    const d0 = Math.hypot(target.x + 0.5 - p0.x, target.z + 0.5 - p0.z);
    if (d0 > maxReach) {
        // 不是"相邻一格" —— 那是导航的事，不该由本动作硬走
        return fail('NO_TARGET', `不是相邻一格（水平 ${d0.toFixed(1)} 格）`, { distXZ: d0, cell: target });
    }

    // 落点可站性由调用方判断（本动作不做前置判断，A6）；这里只做"脚下有没有东西"的最后一道保险，
    // 因为"按前进走进空气"会让她掉下去 —— 那是执行不了的，不是可以重试的失败。
    const below = bot.blockAt?.(new Vec3(target.x, target.y - 1, target.z), false);
    if (below) {
        const solid = !/^(air|cave_air|void_air)$/.test(below.name);
        const liquid = /^(water|lava)$/.test(below.name) || /_water$|_lava$/.test(below.name);
        if (!solid && !liquid) {
            return fail('UNSAFE', `落点 ${target.x},${target.y},${target.z} 脚下是 ${below.name}`, {
                cell: target, below: below.name,
            });
        }
    }

    const cx = target.x + 0.5;
    const cz = target.z + 0.5;
    const from = { x: p0.x, y: p0.y, z: p0.z };

    // 朝格心平视（y 用自己脚位 + 1，不抬头也不低头 —— 抬头会让她爬坡，低头会往下钻）
    await lookAtPoint(bot, { x: cx, y: p0.y + 1, z: cz }, { force: true });

    const held = await holdKey(bot, 'forward', {
        until: () => {
            const p = bot.entity?.position;
            if (!p) return false;
            return insideCell(p, target);
        },
        timeout: timeoutMs,
        intervalMs: 100,
    });

    const p1 = bot.entity?.position;
    const to = p1 ? { x: p1.x, y: p1.y, z: p1.z } : null;
    const costMs = Date.now() - t0;

    if (!held.ok && held.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { cell: target });
    if (!held.ok) {
        const d = p1 ? Math.hypot(p1.x - cx, p1.z - cz) : null;
        return fail('TIMEOUT', `按了前进 ${costMs}ms 没进格（还差 ${d == null ? '?' : d.toFixed(1)} 格）`, {
            cell: target, from, to, distXZ: d, costMs,
        });
    }
    // 后置再核一次：`until` 说是进了，但**返回前必须自己确认**。
    // 这一步专门防"谓词口径漂了"——只要谓词有漏洞，这里就会把它变成显式失败，
    // 而不是让 walkTo 拿到一个假成功（假成功会死循环，见 insideCell 注释）。
    if (!insideCell(p1, target)) {
        const d = p1 ? Math.hypot(p1.x - cx, p1.z - cz) : null;
        return fail('TIMEOUT', `谓词判成功但脚位不在目标格（现在 ${p1 ? `${Math.floor(p1.x)},${Math.floor(p1.y)},${Math.floor(p1.z)}` : '?'}，`
            + `目标 ${target.x},${target.y},${target.z}）`, { cell: target, from, to, distXZ: d, costMs });
    }
    return ok({ cell: target, from, to, costMs });
}
