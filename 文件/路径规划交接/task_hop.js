/**
 * 复合：分两层移动（长规划 + 短规划）。
 *
 * 用户定的分工：
 *   长规划（path_long）：区块地图上定 2~4 个路点，避开岩浆/水面/陡坡
 *   短规划（path_short）：每个路点之间用 pathfinder 走真实地形，失败就对半切
 *
 * 为什么这么分（实测依据）：
 *   - pathfinder 单次调用约 13~15 秒，与距离关系不大 → 路点要少、失败要切段
 *   - digCost 从 10 调到 1 后，40 格从「超时 0/2」变成「15 秒 2/2」
 *   - 区块扫描 27~41ms，可以每步重扫
 */
import { ok, fail } from './atom_contract.js';
import { tileAStar } from './tile_map.js';
import { planLong } from './path_long.js';
import { walkSegment } from './path_short.js';
import { scanArea } from './chunk_map.js';
import { pauseGoalModes, restoreGoalModes } from './task_modes.js';

/**
 * 分两层走到目标。
 * @param {object} bot
 * @param {{x:number,z:number}} dest
 * @param {object} opts
 *   mapDir    区块地图目录（必填）
 *   rescan    每步是否重扫周围（默认 true）
 *   onEvent   进度回调
 */
export async function hopTo(bot, dest, opts = {}) {
    const { mapDir, rescan = true, onEvent = () => { } } = opts;
    const start = Date.now();
    if (!mapDir) return fail('INTERNAL', 'hopTo 需要 mapDir');
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const pausedBefore = pauseGoalModes(bot);
    let scans = 0, segments = 0, splits = 0, waypointsUsed = 0;

    try {
        // 先保证地图有数据：她身边和目的地各扫一遍。
        // 否则长规划看到的全是「未探索」，路点等于瞎选——
        // 实测在空白地图上，36 格的目标她跑到了 757 格外。
        const pInit = bot.entity.position;
        if (rescan) {
            const s1 = scanArea(bot, mapDir, Math.floor(pInit.x / 16), Math.floor(pInit.z / 16), 3);
            const s2 = scanArea(bot, mapDir, Math.floor(dest.x / 16), Math.floor(dest.z / 16), 2);
            scans += 2;
            onEvent({ type: 'scan', scanned: s1.scanned + s2.scanned, ms: s1.ms + s2.ms, phase: 'init' });
        }

        // 长规划：一次算出全部路点
        const p0 = bot.entity.position;
        const plan = planLong(mapDir, { x: p0.x, z: p0.z }, dest);
        onEvent({ type: 'plan', waypoints: plan.waypoints.length, straight: Math.round(plan.straightDist), avoided: plan.avoided });

        // 保险：长规划给出的路点如果全都远离目标（方向错了），直接用目标点
        const last = plan.waypoints[plan.waypoints.length - 1];
        if (last && Math.hypot(last.x - dest.x, last.z - dest.z) > 64) {
            onEvent({ type: 'plan-fallback', reason: '路点偏离目标' });
            plan.waypoints = [{ x: Math.round(dest.x), z: Math.round(dest.z), label: '目标', cost: 0 }];
        }

        for (let i = 0; i < plan.waypoints.length; i++) {
            if (bot.interrupt_code) {
                return fail('INTERRUPTED', `停了，走了 ${waypointsUsed}/${plan.waypoints.length} 段`,
                    { waypoints: waypointsUsed, costMs: Date.now() - start });
            }

            const wp = plan.waypoints[i];
            waypointsUsed++;

            // 短规划：走这一段（内部失败会切半）
            const seg = await walkSegment(bot, { x: bot.entity.position.x, z: bot.entity.position.z }, wp, {
                timeout: 20000,
                onEvent: (e) => {
                    if (e.type === 'segment') segments++;
                    if (e.type === 'split') splits++;
                    onEvent(e);
                },
            });

            if (seg.code === 'INTERRUPTED') {
                return fail('INTERRUPTED', `停了，走了 ${waypointsUsed}/${plan.waypoints.length} 段`,
                    { waypoints: waypointsUsed, splits, costMs: Date.now() - start });
            }

            if (!seg.ok) {
                // 这一段彻底走不通：用 A* 在区块图上重新规划一次（绕开这片区域）
                onEvent({ type: 'reroute', at: { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) } });
                if (rescan) {
                    const p = bot.entity.position;
                    const s = scanArea(bot, mapDir, Math.floor(p.x / 16), Math.floor(p.z / 16), 3);
                    scans++;
                    if (s.scanned) onEvent({ type: 'scan', scanned: s.scanned, ms: s.ms });
                }
                const route = tileAStar(mapDir, { x: bot.entity.position.x, z: bot.entity.position.z }, dest);
                if (!route.path.length || route.path.length < 2) {
                    return fail('NO_PATH', `走到第 ${i + 1}/${plan.waypoints.length} 段走不通，绕不过去`,
                        { waypoints: waypointsUsed, splits, costMs: Date.now() - start });
                }
                const t = route.path[1];
                plan.waypoints.push({ x: t.cx * 16 + 8, z: t.cz * 16 + 8, label: t.label, cost: 0 });
                continue;
            }

            // 到达一个路点后顺手更新地图
            if (rescan) {
                const p = bot.entity.position;
                const s = scanArea(bot, mapDir, Math.floor(p.x / 16), Math.floor(p.z / 16), 2);
                scans++;
                if (s.scanned) onEvent({ type: 'scan', scanned: s.scanned, ms: s.ms });
            }
        }

        const pEnd = bot.entity.position;
        const d = Math.hypot(pEnd.x - dest.x, pEnd.z - dest.z);
        if (d <= 4) {
            return ok({ waypoints: waypointsUsed, segments, splits, scans, costMs: Date.now() - start, dist: +d.toFixed(1) });
        }
        return fail('NO_PATH', `走到 ${d.toFixed(0)} 格就过不去了`,
            { waypoints: waypointsUsed, segments, splits, scans, costMs: Date.now() - start, dist: +d.toFixed(1) });
    } finally {
        restoreGoalModes(bot, pausedBefore);
    }
}
