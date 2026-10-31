/**
 * 导航唯一入口：goTo。
 *
 * 为什么要有这一层（REFACTOR_ANALYSIS §5 Phase 3 / §3.2「移动引擎两套」）：
 *   现在"走到某处"至少有三条路，调用方得自己挑：
 *     executor.walkTo      —— 3D 体素 A*（要有 mapDir / terrain3d 库），能爬台阶、挖穿、垫方块
 *     atom_move.moveTo     —— 原生 pathfinder，2D 思路，爬不上高差、不会垫
 *     atom_move.moveToXZ   —— 只要 x/z，高度自己找
 *     path_short.moveToXZEx—— 更旧的短途实现（已列进删除清单）
 *   谁该用哪条、什么时候回退，全靠调用方记。换一次引擎就要全仓库跟着改。
 *
 * 这一层的职责就一句话：**按输入选引擎，把选择集中在一个地方**。
 * 它自己不做任何移动动作、不解析路径、不碰方块。
 *
 * 典型用法：
 *   await goTo(bot, { x, z }, { mapDir, deadlineMs })          // 有 3D 库 → 走 walkTo
 *   await goTo(bot, { kind: 'point', pos: { x, y, z } })       // 没 3D 库 → 走原生 pathfinder
 *
 * 引擎选择（顺序即优先级）：
 *   1. 给了 mapDir（有 3D 库）        → executor.walkTo      （唯一能爬台阶/挖穿/垫方块的）
 *   2. 没给 mapDir 但给了具体 y       → atom_move.moveTo     （原生 pathfinder）
 *   3. 没给 mapDir，只给了 x/z        → atom_move.moveToXZ   （高度让它自己找）
 *
 * 注意：**实体跟随（GoalFollow / followEntity）不在这里**。
 * 它有自己的目标失效、重定位、丢失重找逻辑，硬塞进 goTo 会让两个语义搅在一起。
 * 跟随仍然走 task_follow。
 */
import { ok, fail } from './atom_contract.js';
import { walkTo } from './executor.js';
import { moveTo, moveToXZ } from './atom_move.js';

/** 目标坐标是否可用。 */
function finiteXZ(t) {
    return !!t && Number.isFinite(t.x) && Number.isFinite(t.z);
}

/**
 * 目标归一化：接受 {x,z} / {x,y,z} / {kind:'point', pos:{...}} 三种写法。
 *
 * 为什么容忍三种：调用方一半传裸 {x,z}（老代码），一半传描述对象（原子契约）。
 * 这里做一次归一是**唯一**该容忍的地方——原子层不再接受裸坐标（§6.4）。
 *
 * @returns {{x:number, y:number|null, z:number}|null}
 */
export function normalizeDest(target) {
    if (!target || typeof target !== 'object') return null;
    // {kind:'point', pos:{x,y,z}} / {kind:'point', posXZ:{x,z}}
    if (target.kind === 'point') {
        const p = target.pos ?? target.posXZ ?? null;
        if (!finiteXZ(p)) return null;
        return { x: p.x, y: Number.isFinite(p.y) ? p.y : null, z: p.z };
    }
    // 裸坐标
    if (!finiteXZ(target)) return null;
    return { x: target.x, y: Number.isFinite(target.y) ? target.y : null, z: target.z };
}

/**
 * 走到目标 —— **导航唯一入口**。
 *
 * @param {object} bot
 * @param {object} target {x,z} / {x,y,z} / {kind:'point', pos:{x,y,z}}
 * @param {object} opts
 *   mapDir     有 3D 库就传（决定是否走 walkTo）
 *   deadlineMs 总时限（毫秒）
 *   arriveTol  到达容差（格），默认 5（walkTo）/ 1（pathfinder）
 *   onEvent    时间线回调
 *   rescan     walkTo 每轮是否重扫地形，默认 true
 * @returns ActionResult
 *   ok → data: { engine, distRemaining?, costMs, ...引擎透传 }
 *   fail → code ∈ NO_TARGET / INTERRUPTED / INTERNAL / 引擎透传（NO_PATH / STUCK / NO_REACH …）
 */
export async function goTo(bot, target, opts = {}) {
    const {
        mapDir = null,
        deadlineMs = 300000,
        arriveTol = null,
        onEvent = () => { },
        rescan = true,
    } = opts;

    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const dest = normalizeDest(target);
    if (!dest) return fail('NO_TARGET', '目标坐标无效（需要 {x,z} 或 {kind:"point",pos:{x,y,z}}）');

    // ---- 引擎 1：有 3D 库 → walkTo（唯一能爬台阶 / 挖穿 / 垫方块的）----
    if (mapDir) {
        const r = await walkTo(bot, { x: dest.x, z: dest.z }, {
            mapDir,
            onEvent,
            deadlineMs,
            arriveTol: arriveTol ?? 5,
            rescan,
        });
        return withEngine(r, 'walk3d');
    }

    // ---- 引擎 2/3：没有 3D 库 → 原生 pathfinder ----
    // 给了 y 就用 moveTo（精确点），否则 moveToXZ（高度自己找）
    if (dest.y != null) {
        const r = await moveTo(bot, { kind: 'point', pos: { x: dest.x, y: dest.y, z: dest.z } }, {
            tol: arriveTol ?? 1,
            timeout: deadlineMs,
        });
        return withEngine(r, 'pathfinder3');
    }
    const r = await moveToXZ(bot, { kind: 'point', posXZ: { x: dest.x, z: dest.z } }, {
        tol: arriveTol ?? 2,
        timeout: deadlineMs,
    });
    return withEngine(r, 'pathfinder2');
}

/**
 * 在结果里补上"用的哪个引擎"，方便诊断与基线对比。
 * 只加字段、不改 ok/code/message —— 引擎的选择不该影响上层判断。
 */
function withEngine(r, engine) {
    if (!r || typeof r !== 'object') return r;
    return { ...r, data: { ...(r.data ?? {}), engine } };
}
