/**
 * 复合：走到目标 —— **薄适配层**（2026-10-27 架构重写，2026-11-01 改为转调 nav_core）。
 *
 * 历史：这一层原来直接转 `executor.walkTo`。Phase 3 之后，"走哪条引擎"这件事
 * 统一收进 `nav_core.goTo`（3D 库优先、没有就退原生 pathfinder），
 * 所以这里改成转调它 —— **对外契约一行没变**，3 处调用方（!walkTo / task_follow 两处）
 * 都不用改。
 *
 * 为什么还留着这个文件而不是让调用方直接调 nav_core：
 *   ① `hopTo` 这个名字在 3 个调用点里已经稳定，改名只是制造 diff
 *   ② 它是一处**收口**：以后换导航实现，改这一个文件就够
 */
import { ok, fail } from './contract.js';
import { goTo } from './nav_core.js';
import { describeStore } from './executor.js';

/**
 * 走到目标。
 *
 * @param {object} bot
 * @param {{x:number,z:number}} dest 目标（高度由 3D 数据决定，调用方不用给）
 * @param {{mapDir:string, rescan?:boolean, onEvent?:Function, deadlineMs?:number, arriveTol?:number}} opts
 * @returns {Promise<{ok:boolean, code?:string, message?:string, data?:object}>}
 */
export async function hopTo(bot, dest, opts = {}) {
    const { mapDir, onEvent = () => { }, deadlineMs = 300000, arriveTol = 5, rescan = true } = opts;

    if (!mapDir) return fail('INTERNAL', 'hopTo 需要 mapDir');
    if (!dest || !Number.isFinite(dest.x) || !Number.isFinite(dest.z)) {
        return fail('NO_TARGET', 'hopTo 需要有效的目标坐标');
    }
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    // 引擎选择交给 nav_core（给了 mapDir → 走 3D walkTo，与改造前完全一致）
    return goTo(bot, { x: dest.x, z: dest.z }, { mapDir, onEvent, deadlineMs, arriveTol, rescan });
}

/** 3D 库概况（诊断用）。 */
export function describe3dStore(mapDir) {
    return describeStore(mapDir);
}
