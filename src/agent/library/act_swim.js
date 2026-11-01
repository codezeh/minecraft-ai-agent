/**
 * 动作：水面过河的单步（M6 P1）。**严格照 05_navigation.md 末节「水面过河：单独的 swim 步」实现。**
 *
 *   swimStep(cell)  相邻一格是水面 → lookAt 格心（水平）→ holdKey(['forward','jump'],
 *                   {until: 进格且头在水面上}) → 在那一格浮着
 *
 * 规范原文逐条对应（05 末节）：
 *   ① "落点是 T.WATER 的边一律是 swim（水面上四邻移动、从岸上下水都算）"
 *      → 本动作**只处理"进到相邻那一格水面"**这一步；选哪条边、什么时候该 swim 是 path_3d/executor 的事。
 *   ② "执行：朝目标格水平转头 → 同时按住前进和跳，直到进到那一格 → 松开"
 *      → lookAtPoint(格心，水平：yaw 用当前脚位高度，pitch=0 平视) + holdKey(['forward','jump'])。
 *   ③ "**不交给 pathfinder**：它走的时候每 tick 自己设控制键，会把按住的跳改掉"
 *      → 本动作只调 atom_input_move.holdKey，绝不碰 bot.pathfinder。
 *   ④ "到位判据：水平进格（≤ 0.5）且头在水面之上"
 *      → until 判据就是这两条，阈值取自下面两个常量。
 *   ⑤ "00 §4 的'脚位 = 面位 + 1'只对实心面成立，浮在水里不适用"
 *      → 这里**不比 y 高度**，只用"水平 ≤ 0.5 + 头在水面上"。
 *
 * 为什么"按住跳"：prismarine-physics 里在水面按跳会把人顶到水面并保持不掉下去，
 * 同时"前进"负责水平位移。两者缺一：只按前进会沉底，只按跳会在原地上下浮。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { holdKey } from './atom_input_move.js';
import { lookAtPoint } from './atom_input_mouse.js';

/** 水平到位阈值（05 末节："水平进格（≤ 0.5）"）。 */
export const SWIM_ARRIVE_XZ = 0.5;

/**
 * 头是否在水面之上。
 *
 * 判据用一个**常量近似**：脚位 y + 1.0（脚在水面下一点点时，头仍高出水面）。
 * ⚠️ 不假装这是引擎给的精确值：prismarine 没暴露"头 vs 水面"的直接读数，
 * 这里读的是"脚所在格是不是水"+"上方格是不是空气"，两者都成立就算头在水面上。
 */
function headAboveWater(bot) {
    const p = bot?.entity?.position;
    if (!p) return false;
    const feetY = Math.floor(p.y);
    const at = (dy) => bot.blockAt?.(new Vec3(Math.floor(p.x), feetY + dy, Math.floor(p.z)), false)?.name ?? null;
    const feet = at(0);
    const head = at(1);
    const isWater = (n) => typeof n === 'string' && /water/.test(n);
    const isAir = (n) => n == null || n === 'air' || n === 'cave_air' || n === 'void_air';
    // 脚在水里/水面、头那格是空气 → 头在水面上
    return (isWater(feet) || isWater(head)) && isAir(head);
}

/**
 * 朝相邻那格水面游一步。
 *
 * @param {object} cell {pos:{x,y,z}} 或 Vec3 —— **目标水面格**（不是方向）
 * @param {object} opts { timeoutMs = 8000 }
 * @returns ActionResult
 *   ok        → data: { cell, from, to, costMs }
 *   NO_TARGET 目标格无效 / 那格不是水 —— 与 BLOCKED 的区别：BLOCKED 是"要做但做不成"，
 *             这里是"给错了地方"（本动作只处理水面）
 *   TIMEOUT   按了前进+跳，但没能在时限内进格并浮上水面 —— 与 BLOCKED 的区别：
 *             BLOCKED 是"立刻做不了"（被挡住），TIMEOUT 是"一直在尝试但没到"
 *   INTERRUPTED 被取消
 *
 * 注意：本动作**不判断该不该游**（A6：不做前置判断），也不管落点安全（那是 executor 的落点检查）。
 */
export async function swimStep(bot, cell, opts = {}) {
    const { timeoutMs = 8000 } = opts;
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const raw = cell?.pos ?? cell;
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isFinite(raw.z)) {
        return fail('NO_TARGET', '目标格无效');
    }
    const target = { x: Math.floor(raw.x), y: Math.floor(raw.y), z: Math.floor(raw.z) };
    const blk = bot.blockAt?.(new Vec3(target.x, target.y, target.z), false);
    // 目标格必须是水（05：swim 只走 T.WATER 的边）。读不到方块就不拦（未加载时不该误判）
    if (blk && !/water/.test(blk.name)) {
        return fail('NO_TARGET', `目标格不是水面（${blk.name}）`, { block: blk.name, cell: target });
    }

    const p0 = bot.entity?.position;
    const from = p0 ? { x: p0.x, y: p0.y, z: p0.z } : null;

    // ② 朝目标格**水平**转头：看格心（x+0.5, z+0.5），y 用自己脚位 → pitch≈0 平视水面
    const cx = target.x + 0.5;
    const cz = target.z + 0.5;
    const eyeY = (p0?.y ?? target.y) + 1.0;
    // 转头也走输入原子（bot.look* 只许在 atom_input_* 里出现，02 §5 / A1）
    await lookAtPoint(bot, { x: cx, y: eyeY, z: cz }, { force: true });

    // ④ 到位判据：水平进格（≤ SWIM_ARRIVE_XZ）且头在水面之上
    const held = await holdKey(bot, ['forward', 'jump'], {
        until: () => {
            const p = bot.entity?.position;
            if (!p) return false;
            const inCell = Math.hypot(p.x - cx, p.z - cz) <= SWIM_ARRIVE_XZ;
            return inCell && headAboveWater(bot);
        },
        timeout: timeoutMs,
        intervalMs: 100,
    });

    const p1 = bot.entity?.position;
    const to = p1 ? { x: p1.x, y: p1.y, z: p1.z } : null;
    const costMs = Date.now() - t0;

    if (!held.ok && held.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { cell: target });
    if (!held.ok) {
        const inCell = p1 ? Math.hypot(p1.x - cx, p1.z - cz) <= SWIM_ARRIVE_XZ : false;
        return fail('TIMEOUT', `游了 ${costMs}ms 没进格/没浮上水面（进格=${inCell}）`, {
            cell: target, from, to, inCell, costMs,
        });
    }
    return ok({ cell: target, from, to, costMs });
}
