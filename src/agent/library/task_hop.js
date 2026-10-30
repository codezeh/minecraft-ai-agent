/**
 * 复合：走到目标 —— **薄适配层**（2026-10-27 架构重写）。
 *
 * 真正的执行逻辑全在 `executor.walkTo`（唯一任务层）。
 * 这里只做两件事：
 *   ① 保持对外的 `hopTo` 契约不变（goToPlayer / walkTo 都调它）
 *   ② 校验参数、转调 executor
 *
 * 为什么保留这一层而不是直接让调用方调 executor：
 *   外面还有 3 处调用 `hopTo`（task_follow 两处、actions.js 一处），
 *   保留同名入口可以把"导航实现换掉了"这件事**限制在一个文件里**，
 *   调用方一行都不用改。
 *
 * 旧实现（567 行、四条互相兜底的链路）已删，备份在分支 nav-legacy-backup。
 */
import { ok, fail } from './atom_contract.js';
import { walkTo, describeStore } from './executor.js';

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

    return walkTo(bot, { x: dest.x, z: dest.z }, { mapDir, onEvent, deadlineMs, arriveTol, rescan });
}

/** 3D 库概况（诊断用）。 */
export function describe3dStore(mapDir) {
    return describeStore(mapDir);
}
