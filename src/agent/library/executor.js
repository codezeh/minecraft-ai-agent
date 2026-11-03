/**
 * 导航执行器 —— 唯一的任务层（2026-10-27 架构重写）。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 第一性原理：她只有两种走路原语
 *   ① 水平移动（含跳 1 格、掉落）
 *   ② 改变地形（挖掉挡路的 / 垫出落脚点）
 * 其它一切（路线、代价、分层、地图）都只是为这两件事服务的决策。
 *
 * 旧架构的病：四套规划器（tile_map / path_long / chunk_map / heatmap）
 * 加四条互相兜底的执行链，任何一条失败都落到下一条 ——
 * 于是**永远不知道真正失败的原因**，改 29 次都在把失败点往后挪。
 *
 * 新架构：一条链路，零兜底
 *   扫球 → 3D 规划 → 按 action 分发执行 → 走完重扫重规划
 *   失败就老实返回失败，由上层决定下一步。
 *
 * 数据：terrain3d.db（真 3D 可站立面，每列可能有多个）
 * 规划：path_3d.plan3D（体素 A*，路径每步带真实 y 和 action）
 * 执行：本文件按 action 分发
 * ═══════════════════════════════════════════════════════════════════
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { moveToXZ } from './nav_pathfinder.js';
import { digBlock, isDiggable, canDigWithInventory } from './act_dig.js';
import { climbUp, climbDown, isClimbable } from './act_climb.js';
// 坠落/虚空反射（2026-11-02）：落点下方没支撑就拒绝走过去
import { fallRisk } from './query_safe.js';
import { scanSphere, stats3d, columnSurfaces, T, forgetSurface, noteDugSurface, classifyBlock } from './terrain3d.js';
import { plan3D } from './path_3d.js';
import { ensureTraced } from './trace_bus.js';
import { findScaffoldItem } from './scaffold_blocks.js';
import { movedEnough, realMove } from './query_stuck.js';
import { pillarUpOnce } from './act_pillar.js';
import { pauseGoalModes, restoreGoalModes } from './modes.js';
import { holdKey, releaseAll } from './atom_input_move.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 每轮扫描半径。比规划视距大，保证有数据。 */
const SCAN_R = 36;
/**
 * 规划视距。
 *
 * ★ 2026-10-28 用多地形基准重新定过（tools/bench_lookahead.mjs，
 *   7 种地形 × 6 个距离 × 15 组随机起终点）：
 *
 *     视距  8 → 平均绕路比 1.120   ← 明显差
 *     视距 12 → 1.080
 *     视距 16 → 1.089
 *     视距 24 → 1.081
 *     视距 32 → 1.080
 *     视距 48 → 1.099   ← 反而变差（搜索空间大，启发式偏差增加）
 *
 * 结论：**≥12 就够，超过 32 反而变差**。12~32 之间的差异只有 0.008，
 * 在噪声范围内 —— 所以不要"调"这个值，要按最坏情况选。
 * 取 16：在全部 7 种地形上都不差于均值，且耗时最短（每轮 ~10ms）。
 *
 * 教训：之前把它从 16 调到 24，理由是"在她那张图上绕路比 1.16→1.08"。
 * 那是一次单图测量的偶然结果，多地形基准里 24 的优势只有 0.008。
 */
const LOOK_AHEAD = 16;
/** 最多重规划轮数。 */
const MAX_ROUNDS = 120;

/** 可以拿来垫脚的方块见 scaffold_blocks.js（D8：清单原来散在 4 处且互不一致）。 */

/** 读某格方块（读不到返回 null）。 */
function blockAt(bot, x, y, z) {
    try { return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), false); } catch { return null; }
}

const IS_AIR = new Set(['air', 'cave_air', 'void_air']);
// 液体：不需要"挖"，直接穿过去（游泳/下落）。classifyBlock 里是 T.WATER / T.LAVA
const IS_LIQUID = /^(water|kelp|seagrass|bubble_column|lava)$/;

/**
 * 执行一步路径。
 *
 * @param {object} bot
 * @param {{x,y,z,action}} step 路径点
 * @returns {Promise<{ok:boolean, code?:string, message?:string}>}
 */
/**
 * 执行单步。
 *
 * 导出是为了能单测：D2（挖邻列忽略 x/z）只能在这一层验证——
 * 规划层给出 step.x/z，执行层是否照做，中间没有别的可观察点。
 */
export async function execStep(bot, step, opts = {}) {
    // mapDir：只给下面的落点检查用（D14）；不传就跳过那段检查
    const { onEvent: userOnEvent = () => { }, mapDir = null } = opts;
    // ★ 09 §2 / D10：**trace_bus 只在最外层写一次**。
    // 原来这里自己包一层，而 walkTo 已经把它包好的 onEvent 传下来了 ——
    // 于是 execStep 发出的每个事件都被记两次。现在只调 `ensureTraced()`：
    // 调用方（walkTo / nav_core / ctx.onEvent）包过就原样复用，没包过才在这里补一层。
    const onEvent = ensureTraced(userOnEvent);
    const p = bot.entity.position;
    // ★ D1 修复（2026-10-31）：**y 语义统一为「目标格的脚位」**。
    //
    // 两个不同的 y 一直混着用：
    //   step.y      = 可站立面的 y = **实心方块自己那一格**（terrain3d 存的就是它，
    //                 见 scanSphere 里 `s.ins.run(wx, wz, y, t)`，y 是实心块的 y）
    //   position.y  = 实体脚的高度 = **她脚所在的那格空气**，站在 y=63 的草上时是 64
    //   所以：站在某个面上时  floor(position.y) === step.y + 1
    //
    // 本文件原来两种写法都有：下面"走完校验高度"那段早就用了 `step.y + 1`，
    // 但 dy 计算、垫高判据、攀爬和挖掘分支用的是裸 `step.y`。
    // 后果（都是实测症状）：
    //   - 真的要上 2 格时 dy 被算成 1 → 不进"垫方块"分支 → pathfinder 跳不上 → NO_PATH
    //   - 挖掘循环以 step.y 为终点 → 少挖一格，到不了目标高度
    // 方案 B（见 ARCHITECTURE_REDESIGN §3.4）定的是"以实心方块为准"，
    // 所以统一在**这里做一次换算**，其余一律用 targetFeetY 与身体比。
    const targetFeetY = step.y + 1;
    const dy = targetFeetY - Math.floor(p.y);   // 真实高差（正数=要往上）
    const dxz = Math.hypot(step.x + 0.5 - p.x, step.z + 0.5 - p.z);

    // ---- 挖通（向上）----
    // ---- 攀爬（梯子 / 藤蔓）----
    //
    // 2026-10-28 新增。先让 pathfinder 把 x/z 走到位（藤蔓柱可能不在脚下），
    // 再用 atom_climb 做真正的垂直移动 —— 判定与动作都在原子层，这里只编排。
    if (step.action === 'climb') {
        // 先水平挪到目标列（藤蔓是 1 格宽的柱子）
        if (dxz > 1.2) {
            const mv = await moveToXZ(bot, { kind: 'point', posXZ: { x: step.x, z: step.z } },
                { tol: 0.8, timeout: 15000 });
            if (!mv.ok) return mv;
        }
        const pNow = bot.entity.position;

        // 她可能站在柱子顶端平台上方、而柱子从下面几格才开始（例如平台 y=75，
        // 藤蔓 y=68~74）。这时"当前格是藤蔓"不成立，但往下走一步就能进柱子。
        // 所以判据放宽为：当前格、上方一格、或下方 1~2 格里任一格可攀爬即可。
        const candidates = [
            { x: pNow.x, y: pNow.y, z: pNow.z },
            { x: pNow.x, y: pNow.y + 1, z: pNow.z },
            { x: pNow.x, y: pNow.y - 1, z: pNow.z },
            { x: pNow.x, y: pNow.y - 2, z: pNow.z },
        ];
        const onLadder = candidates.some(c => isClimbable(bot, c));
        if (!onLadder) {
            return {
                ok: false, code: 'NOT_CLIMBABLE',
                message: `(${Math.round(pNow.x)},${Math.round(pNow.y)},${Math.round(pNow.z)}) 附近两格内没有藤蔓/梯子`,
            };
        }

        // 要先落进柱子才能爬：若当前格不是藤蔓而是下方才有，先往下挪一格。
        if (!isClimbable(bot, pNow) && targetFeetY < pNow.y - 0.5) {
            const stepDown = await moveToXZ(bot, { kind: 'point', posXZ: { x: step.x, z: step.z } },
                { tol: 0.8, timeout: 8000 });
            if (!stepDown.ok) return stepDown;
        }

        // 上下由目标脚位决定
        const curY2 = bot.entity.position.y;
        if (targetFeetY > curY2 + 0.5) {
            const r = await climbUp(bot, { steps: Math.max(1, Math.round(targetFeetY - curY2)), onEvent });
            if (!r.ok) return r;
            // 爬到顶后可能还要再走一小段（藤蔓顶端是平台）
            const p2 = bot.entity.position;
            if (Math.abs(p2.x - step.x) > 1 || Math.abs(p2.z - step.z) > 1) {
                await moveToXZ(bot, { kind: 'point', posXZ: { x: step.x, z: step.z } },
                    { tol: 0.8, timeout: 10000 });
            }
            return ok({ climbed: r.data?.climbed ?? 0 });
        }
        if (targetFeetY < curY2 - 0.5) {
            const r = await climbDown(bot, { maxSteps: Math.max(1, Math.round(curY2 - targetFeetY)), onEvent });
            if (!r.ok) return r;
            return ok({ dropped: r.data?.dropped ?? 0 });
        }
        return ok({ climbed: 0 });      // 已经在目标高度
    }

    // 挖之前先确认背包里真有能挖的工具。
    //
    // 2026-10-29：实测空背包时，规划连续给出 `down→andesite`，
    // 执行每轮报 `NO_TOOL 向下挖 andesite 失败`，4 轮后 NO_REACH ——
    // 那条路本来就不可能走通。现在直接判死，让上层立刻换路。
    if (step.action === 'dig' || step.action === 'digdown') {
        const probeB = blockAt(bot, Math.floor(step.x), Math.floor(step.y), Math.floor(step.z));
        // 目标格已经是空气 → 没有"挖不动"这回事，别报 NO_TOOL
        // （旧代码对空气也做工具检查，于是 air → canDigWithInventory=false → NO_TOOL「挖不动 air」）
        if (probeB && !IS_AIR.has(probeB.name) && !canDigWithInventory(bot, probeB)) {
            return { ok: false, code: 'NO_TOOL',
                message: `挖不动 ${probeB.name}（背包里没有合适的工具）` };
        }
    }

    if (step.action === 'dig') {
        // ★ D2 修复（2026-10-31）：**按步骤自己的列挖，不是按当前列挖**。
        //
        // path_3d 会生成"挖邻列"的 dig 边（path_3d.js:427-452，相邻 4 向、落差 ≤40），
        // 但这些步骤的 (step.x, step.z) 是**目标列**。旧代码用的是
        // `Math.floor(p.x) / Math.floor(p.z)`（当前位置 = 自己这一列），
        // 于是：规划要挖邻列 → 实际挖的是自己头顶 → 邻列根本没通，
        // 下一轮又规划同一条边，表现为反复挖同一处、原地不动。
        const bx = Math.floor(step.x), bz = Math.floor(step.z);
        const curX = Math.floor(p.x), curZ = Math.floor(p.z);
        const sameColumn = (bx === curX && bz === curZ);

        let y = Math.floor(p.y);
        // ★★ 2026-11-03（t49）：**邻列（横向隧道）的终点是"脚位 + 2"，不是 `targetFeetY`**。
        //
        //   隧道边（`path_3d` 的 `tunnel: true`）目标 y = `cur.y`（面位）→
        //   `targetFeetY = cur.y + 1` = **她当前脚位** → `while (y < targetY)` 一次都不跑！
        //   于是 `dug = 0`，假成功守卫如实报 `DIG_FAIL 脚位格还是 stone`。
        //
        //   真机证据（t48 的 NAV_DEBUG 逐步行）：
        //     [step] dig→(10000,-61,6000) 结果=DIG_FAIL 现在=(9999.4,-60.0,6000.5)
        //     第1轮 步8 dig 失败: DIG_FAIL 邻列 (10000,-60,6000) 的脚位格还是 stone
        //   → 规划给了 dig 边（index 8/9，在 MAX_STEPS 之内），但执行层一格没挖。
        //
        //   语义：横向钻洞要开出**人形通道高 2**（她身高 1.8）= 脚位格 + 头格。
        //   所以终点是 `脚位 + 2`，循环正好跑两轮（cellY = 脚位、脚位+1）。
        //   **同列分支保持 `targetFeetY` 不变**（"往上挖穿天花板"的语义，digdown 5/5 靠它）。
        const targetY = sameColumn ? targetFeetY : (Math.floor(p.y) + 2);
        let dug = 0;
        let liquidBlocked = false;
        while (y < targetY && dug < 32) {
            // ★★ 2026-11-03（t40）：**邻列要从脚位开始挖**，同列保持 y+1 不变。
            //
            // 为什么（真机 + 离线推演双重证据）：
            //   她身高 1.8，横向钻洞需要 2 格高（脚位格 + 头格）都被挖掉。
            //   而原来的循环 `above = blockAt(bx, y + 1, bz)` **永远挖不到 y 本身**
            //   （她自己脚所在的格）→ "邻列横向挖隧道"永远开不出人形通道
            //   → dig-through 挖 4 格却 NO_PATH（t35 打点定位）。
            //   离线推演四种 step.y：-61→[]、-60→[-59]、-59→[-59,-58]、-56→[-59..-55]，
            //   **没有任何取值能挖掉脚位格** —— 所以在 executor 里改是唯一出路。
            //
            // 为什么不改同列：同列 dig 的语义是"往上挖穿天花板"（挖 y+1 才是对的），
            //   `digdown` 5/5 就靠它。**同列分支一个字节都不许动**（用户明确要求）。
            const cellY = sameColumn ? y + 1 : y;
            const above = blockAt(bot, bx, cellY, bz);
            if (!above) break;
            if (IS_LIQUID.test(above.name)) {
                // 头顶是液体：不该"挖"，该"穿过"。但**不能因此报成功**——
                // 旧代码在这里 break 后照样 return ok({dug})，
                // 上层以为她已经上去了，实际停在原地（"液体头顶假成功"）。
                liquidBlocked = true;
                break;
            }
            if (!IS_AIR.has(above.name)) {
                // 同 digdown：先检查能不能挖，避免无工具时反复失败
                if (!isDiggable(above)) {
                    return { ok: false, code: 'NO_TOOL', message: `挖不动 ${above.name}（没有合适的工具）` };
                }
                const r = await digBlock(bot, { kind: 'block', pos: { x: bx, y: cellY, z: bz } });
                if (!r.ok && !/air/i.test(String(r.message ?? ''))) {
                    return { ok: false, code: r.code ?? 'DIG_FAIL', message: `挖 ${above.name} 失败` };
                }
                dug++;
                // ★★ 2026-11-03（t35）：**挖成功后立刻更新 terrain3d（局部，不整片重扫）**。
                //   真机证据：dig 报 OK、真实世界已变 air，但 `columnSurfaces` 仍说 SOLID
                //   → 下一轮规划看到的还是"墙没动" → 反复挖同一处 → 4 格后库和现实对不上
                //   → plan-fail → NO_PATH。
                updateSurfAfterDig(mapDir, bx, cellY, bz, bot);
                onEvent({ type: 'dig', x: bx, z: bz, y: cellY, name: above.name });
            }
            if (!sameColumn) {
                // 邻列：只负责把那一列挖通，站位交给后续的 walk 步骤。
                // 在这里 stepUp 会把她垫到**自己**这一列上，反而离目标更远。
                y += 1;
                continue;
            }
            // 跳上一层（脚下垫方块）
            const moved = await stepUp(bot, { onEvent });
            if (!moved.ok) return moved;
            y = Math.floor(bot.entity.position.y);
        }

        // ★★ 2026-11-03（t40）：**邻列的假成功守卫**。
        //
        // 旧代码在"循环一次都没跑"时（step.y 使 targetY <= 脚位）直接 `return ok({dug:0})`
        // —— 她脚位那格明明还是实心，却报成功 → 上层以为推进了 → 反复重规划 → **死循环**。
        // 这正是 A5 里刚花力气清除的那一类"假成功"，不许再踩回去。
        //
        // 判据：邻列必须真的把**脚位格**挖成空气，否则如实报失败。
        if (!sameColumn) {
            const feetCell = blockAt(bot, bx, Math.floor(p.y), bz);
            if (feetCell && !IS_AIR.has(feetCell.name)) {
                return {
                    ok: false, code: 'DIG_FAIL',
                    message: `邻列 (${bx},${Math.floor(p.y)},${bz}) 的脚位格还是 ${feetCell.name}（通道没开出来）`,
                    data: { dug, blockedAt: { x: bx, y: Math.floor(p.y), z: bz } },
                };
            }
            // ★★ 2026-11-03（t47）：**隧道挖通了，必须真的走进去**。
            //
            // 为什么（t46 真机数据）：本分支原来 `return ok({dug})` 就结束了，**没把她移进那格**。
            // 而 walkTo 用 `moved = |Δpos|` 判断"有没有推进" → 隧道步 ok 但 moved≈0；
            // 计划里下一条边是按"她已经在隧道格里"规划的 → 实际位置不符 →
            // step-into 失败 → 重规划 → 真机表现 `oscillation:1` + `scan3d:5` + NO_REACH。
            // 所以不是"够不到"，是"挖通了但没走进去"。
            const { stepInto } = await import('./act_step.js');
            const intoCell = { x: bx, y: Math.floor(p.y), z: bz };
            const si = await stepInto(bot, intoCell, { timeoutMs: 1200 });
            if (!si.ok) {
                return {
                    ok: false, code: si.code ?? 'NO_REACH',
                    message: `隧道挖通了但走不进去：${si.message ?? ''}`,
                    data: { dug, cell: intoCell },
                };
            }
        }

        if (sameColumn && y < targetY) {
            // 没到目标高度就别说 ok（假成功会让上层停止重规划并原地卡住）
            if (liquidBlocked) {
                return { ok: false, code: 'BLOCKED', message: `头顶是液体，挖不上去（目标 y=${targetY}，当前 y=${y}）` };
            }
            return { ok: false, code: 'NO_REACH', message: `只挖到 y=${y}（目标 y=${targetY}）` };
        }
        return ok({ dug, column: { x: bx, z: bz } });
    }

    // ---- 向下（挖下去）----
    //
    // ★ 2026-10-28 修：**只有"正下方是实心"才需要挖**。
    // 之前 `dy < -1 && dxz < 1.5` 把"顺着斜坡往下走"也当成挖，
    // 于是走下坡时会去挖脚下的草/水，报 NO_TOOL 或白挖一格。
    //
    // 现在：只有正下方确实有实心方块（需要开洞）才走挖分支，
    // 否则交给 pathfinder —— 它会自己往下走/掉。
    const feetBelow = blockAt(bot, Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
    const needDigDown = feetBelow && !IS_AIR.has(feetBelow.name) && !IS_LIQUID.test(feetBelow.name);
    if (step.action === 'digdown' || (dy < -1 && dxz < 1.5 && needDigDown)) {
        const bx = Math.floor(p.x), bz = Math.floor(p.z);
        let y = Math.floor(p.y);
        const targetY = targetFeetY;   // D1：以脚位为终点，不是方块 y
        let dug = 0;
        while (y > targetY && dug < 32) {
            const below = blockAt(bot, bx, y - 1, bz);
            if (!below) break;
            // ★ 2026-10-28 修：**液体不是"挖"的对象，是"穿过"的对象**。
            // 实测：她走到水边，digdown 试图"挖穿 water" → isDiggable 返回 false
            // → 报 NO_TOOL「挖不动 water」，然后卡住。这完全是逻辑错误。
            // 水下落/游泳交给 pathfinder（它会处理），这里直接跳出循环。
            if (IS_LIQUID.test(below.name)) {
                onEvent({ type: 'liquid-pass', name: below.name, y: y - 1 });
                break;
            }
            if (!IS_AIR.has(below.name)) {
                // 挖之前先检查能不能挖：挖不动就报 NO_TOOL，让规划器换路
                if (!isDiggable(below)) {
                    return { ok: false, code: 'NO_TOOL', message: `挖不动 ${below.name}（没有合适的工具）` };
                }
                const r = await digBlock(bot, { kind: 'block', pos: { x: bx, y: y - 1, z: bz } });
                if (!r.ok && !/air/i.test(String(r.message ?? ''))) {
                    return { ok: false, code: r.code ?? 'DIG_FAIL', message: `向下挖 ${below.name} 失败` };
                }
                dug++;
                if (r.ok) updateSurfAfterDig(mapDir, bx, y - 1, bz, bot);
                onEvent({ type: 'digdown', y: y - 1, name: below.name });
            }
            await sleep(250);
            y = Math.floor(bot.entity.position.y);
            if (y <= targetY) break;
        }
        return ok({ dug });
    }

    // ---- 要跳 2 格以上：pathfinder 跳不上去，得先垫方块 ----
    //
    // ★ 2026-10-27 修：实测她卡在 jump(33,64,-242) —— 要跳 2 格高，
    // pathfinder 的 allow1by1towers 只会叠 1 格，2 格必然 NO_PATH。
    // 这种情况必须用"垫一块再跳"（stepUp），也就是她挖上去时用的同一套动作。
    if (dy >= 2 && dxz < 1.5) {
        let guard = 0;
        // D1：dy 已是真实高差（脚位口径），这里同样按脚位比
        while (Math.floor(bot.entity.position.y) < targetFeetY && guard++ < 6) {
            const up = await stepUp(bot, { onEvent });
            if (!up.ok) return up;
        }
        return ok({ climbed: guard });
    }

    // ---- 落点安全检查：落点那一格是危险面就别去 ----
    //
    // ★ 2026-10-28 加：实测她走到水面上（y=62 水，y=49 才是地面），一脚踩空沉到 y=49，之后连续下坠卡死。
    // 当时的判据是"目标高度附近没有非水、非岩浆的面就拒"。
    //
    // ★ D14（2026-11-01）：这段从加上起**一次都没跑过** —— execStep 里没有 mapDir，
    // 每次 ReferenceError 被空 catch 吞掉。现在由 walkTo 传进来；不传就跳过（单测、直接调用）。
    // ★★★ 2026-11-03（05 §662，补 M6 漏项）：**落点判据按 action 区分**。
    //
    // 规格原文：
    //   「`walk` / `jump` / `down` 落到 `T.WATER` → `UNSAFE`（恢复 10-28 的本意）；
    //     `swim` 落到 `T.WATER` 放行；落到 `T.LAVA` 一律 `UNSAFE`」
    //
    // 为什么现在能定这条了：原来写"水面要不要拦等基线再定"，是因为**游泳能力是死的**
    //   （`swimStep` 存在但没人调、`path_3d` 不产 swim 边）—— 拦了水面她就彻底过不了河。
    //   现在 `path_3d` 会为水面落点产 `swim` 边、executor 有 `swim` 分支，
    //   所以"陆地步落水面"就是**规划器出错**的信号（该产 swim 却产了 walk），必须拦；
    //   而 `swim` 自己落水面是正常的，放行。
    //
    // ⚠️ 千万别把 `swim` 自己拦掉 —— 那等于把唯一能过河的路堵死。
    if (mapDir) {
        try {
            const col = columnSurfaces(mapDir, Math.floor(step.x), Math.floor(step.z));
            const landing = col.find(c => c.y === Math.floor(step.y));
            const isSwim = step.action === 'swim';
            if (landing && landing.t === T.LAVA) {
                onEvent({ type: 'unsafe-landing', x: step.x, y: step.y, z: step.z, why: 'lava' });
                return { ok: false, code: 'UNSAFE', message: `落点 (${step.x},${step.y},${step.z}) 是危险面` };
            }
            // 陆地步（walk/jump/down）落到水面 → 不安全（恢复 10-28 本意）
            if (landing && landing.t === T.WATER && !isSwim) {
                onEvent({
                    type: 'unsafe-landing', x: step.x, y: step.y, z: step.z,
                    why: 'land-step-onto-water', action: step.action ?? null,
                });
                return {
                    ok: false, code: 'UNSAFE',
                    message: `落点 (${step.x},${step.y},${step.z}) 是水面，`
                        + `但这一步是 ${step.action ?? 'walk'}（水面步应该是 swim）`,
                };
            }

            // ★★★ 2026-11-02（用户指出"悬崖等危险区域按理要有条件反射"）：**坠落/虚空反射**。
            //
            // 上面那条只拦岩浆。悬崖和虚空**从来没拦过**，实测吃过两次亏：
            //   ① gap-bridge：沟下面是虚空，她搭不过去就掉出世界摔死
            //      （日志 `ma67453 fell out of the world`），重生在出生点 → 那一轮变成
            //      "从出生点往 10000 格外走"，还被误判成传送失败。
            //   ② digdown 接 stepInto 后：她站 1 格厚盖板上，走出边缘掉下去 → 重规划
            //      → 再走回来 → 无限循环卡死 13 分钟。
            //
            // 判据用 `fallRisk`（query_safe）：从落点往下找最近的**能站**的面，
            // 落差 > maxDrop（默认 4，与 path_3d 的 maxDrop 对齐）或整列无面（虚空）就拒。
            // 注意 CLIMBABLE 不算落脚点（T 的注释里写明它"不是落脚点"）。
            // ★ 2026-11-03：`swim` 步**不做坠落判断**。
            //   浮在水面上时脚下没有"能站的面"（下面全是水），`fallRisk` 会判成
            //   坠落/虚空直接拦掉 —— 但游泳本来就是浮着的，不适用陆地那套判据
            //   （05 §660 也写明"脚位 = 面位 + 1 只对实心面成立，浮在水里不适用"）。
            const risk = isSwim
                ? { ok: true, data: { safe: true, reason: 'swim-step' } }
                : fallRisk(bot, mapDir, { x: step.x, y: targetFeetY, z: step.z });
            if (risk.ok && risk.data && risk.data.safe === false) {
                onEvent({
                    type: 'unsafe-fall', x: step.x, y: step.y, z: step.z,
                    drop: risk.data.drop, voidBelow: risk.data.voidBelow, why: risk.data.reason,
                });
                return {
                    ok: false, code: 'UNSAFE',
                    message: `落点 (${step.x},${step.y},${step.z}) 站不住：${risk.data.reason}`,
                };
            }
            if (!risk.ok) {
                // fallRisk 自己出错（比如 cell 非法）：不拦，但留痕
                onEvent({ type: 'fall-check-error', x: step.x, y: step.y, z: step.z, code: risk.code, msg: risk.message });
            }
        } catch (e) {
            // 查不到就不拦，但要留痕：原来这里是空 catch，D14 就是这么藏住的
            onEvent({ type: 'landing-check-error', x: step.x, y: step.y, z: step.z, error: String(e?.message ?? e).slice(0, 120) });
        }
    }

    // ---- ★ swim：单独处理，**不交给 pathfinder**（05 §660）----
    //
    // 规格原文：「`swim` 分支调动作 `swimStep`：朝目标格水平转头 → 同时按住前进和跳，
    //   直到进到那一格 → 松开。**不交给 pathfinder**：它走的时候每 tick 自己设控制键，
    //   会把按住的跳改掉（上游 `self_preservation` 的水下分支也是 `pathfinder.goal`
    //   为空才按跳，`modes.js:38-42`）」
    //
    // 所以这一步必须在 pathfinder 那段**之前**返回，不能落进去。
    if (step.action === 'swim') {
        const { swimStep } = await import('./act_swim.js');
        const r = await swimStep(bot, { x: step.x, y: step.y, z: step.z });
        onEvent({
            type: 'swim-step', x: step.x, y: step.y, z: step.z,
            ok: r.ok, code: r.code ?? 'OK', costMs: r.data?.costMs ?? null,
        });
        if (!r.ok) return r;
        return ok({ swum: true, ...(r.data ?? {}) });
    }

    // ---- ★ walk：先试 `stepInto`（原子层一步进格），失败**回落** pathfinder ----
    //
    // ★★ 根因记要（2026-11-03，打点定位）：
    //   `stepInto` 要的是**脚位格**（`act_step.js:52` 写明"**脚位**所在的格"，
    //   且它拿 `cell.y - 1` 判"脚下"）。而 `path_3d` 的 `step.y` 是**面位**。
    //   直接把 `step.y` 喂进去 → 它去看 `step.y - 1` = 实心地块 →
    //   一律 `UNSAFE「脚下是 stone」`、位移 0.00（真机打点：每步都这样）。
    //   所以必须用 `targetFeetY`（= step.y + 1，上面已算好）。
    //   ★ 不写第二处 `+1` —— 决策 1B：换算只在 execStep 内部做一次。
    //
    // ★ 只处理 `walk`（同层相邻）。`down`/`jump`/`dig`/`climb` **一律跳过**：
    //   `stepInto` 只会按前进，不会下降也不会往上跳。
    //   （打点实证：digdown 的 `down(6009,-61,8000)` 盖沿 y -58→-61 就是上次被它害死的那一步。）
    //
    // ★★ 为什么**不加**"连续失败 → STUCK"的闸（2026-11-03 用户的结论，记在这里防后人再加）：
    //   `insideCell` 已经要求"脚位格子 == 目标格"（三轴都比），**不可能假成功** ——
    //   而三周前那次死循环的**唯一根因就是假成功**（"水平≤0.5"让她停在边缘也判成功
    //   → stalled 被重置 → 永远到不了 STUCK）。根因已从结构上消除。
    //   实测加过那道闸（N=3/0.1）会**误杀 `gap-bridge`**（5/5→0/5，5 次 STUCK）：
    //   那个场景"站着不动"是在等 pathfinder 搭桥，是正常工作状态，不是卡住。
    //   → **修掉根因之后，为旧根因加的"保险"必须重新评估，否则它变成新的伤害源。**
    //
    //   所以这里只有两步：**成功就走 / 失败就回落**。落回 pathfinder 后若还失败，
    //   交给 `walkTo` 原有的 `stalled` 逻辑处理，**不在这里重试**。
    if (step.action === 'walk') {
        const { stepInto } = await import('./act_step.js');
        const cell = { x: Math.floor(step.x), y: targetFeetY, z: Math.floor(step.z) };
        // ★ timeoutMs：1600 → 500（2026-11-03 实测定的，不是猜的）
        //   真机测：被墙挡住时 stepInto **撞满整个 timeout**（1610/1614/1614ms），
        //   不是立刻返回 UNSAFE；而走得通时只要 114~219ms。
        //   所以 1600 的余量全是白等 —— dig-through 那 6 次失败各白花 ~1.6s
        //   （实测该场景 r2~r5 从 18.4s 涨到 21.0s）。
        //   500ms 对"成功只要 ≤219ms"有 2.3 倍余量。
        const si = await stepInto(bot, cell, { timeoutMs: 500 });
        onEvent({ type: 'step-into', x: cell.x, y: cell.y, z: cell.z, ok: si.ok, code: si.code ?? 'OK' });
        if (si.ok) return si;      // 真进格了（insideCell 保证不是假成功）→ 走这条
        // 失败 → 落下去走 pathfinder（行为与未接入时完全一致）
    }

    // ---- 水平移动（walk / jump / down 都交给 pathfinder）----
    // pathfinder 自己会跳 1 格、会往下掉，所以这三类不需要分开处理。
    // tol: 0.8 —— 水平容差略小于 1 格。
    //
    // 历史（两个坑都要避开）：
    //   tol:1  → moveToXZ 认为"1 格内就算到了"，原地返回成功但不移动，
    //            于是"规划18步 → 位置完全不变"（这是最初"卡死"的根因之一）
    //   tol:0  → 要求精确站到那一格；但 3D 路径点有时是**物理上站不准**的位置，
    //            实测 `walk→(-266,62,-501) 结果=STUCK 现在=(-266.3,63.0,-499.7)`
    //            —— 只差 1.3 格却永远走不到，然后 20 秒判 STUCK。
    //
    // 0.8 的含义：只要水平距离进到 0.8 格内就算到位（玩家碰撞箱宽 0.6，
    // 中心差 0.8 格时身体已经盖住目标格）；同时不会像 tol:1 那样"还没走就说到"。
    // 高度校验在后面单独做（不受这个容差影响）。
    // ★ 2026-11-01 修（基线里 climb-ladder 每次白等 20 秒的根因）：
    // **目标格是可攀爬方块（梯子/藤蔓）时，人已经在格里就直接算到位，别交给 pathfinder。**
    //
    // 实测（10 轮全复现）：爬梯场景规划出一条 walk 步落到梯子脚下那一格，
    // 她本来就在 0.7 格外、高度也对，但 moveToXZ 的 GoalNearXZ(tol=0.8)
    // 在这个"目标格被梯子占着、物理上走不进去"的情形下始终不 resolve →
    // isStalled 等满 20 秒 → STUCK → 才重规划走 climb。
    // 于是整个爬梯场景固定 22 秒，其中 20 秒纯粹是空等。
    //
    // ★★ 触发条件必须**窄**——只看距离会伤到别的场景（血泪教训，已 A/B 验证）：
    //   第一版写成"水平 ≤1.0 就算到位"（相邻格也放行）。结果她没走到目标格就开始
    //   下一步 jump → 跳不上去 → NO_PATH → 白等 20 秒重规划。同一套基线实测：
    //     pillar-up2  无守卫 8369ms → 有守卫 14490~20352ms（双峰：7s×6 / 27s×4）
    //     gap-bridge  出现过"提前到位 → 跳跃落空 → 掉到 y=-181.5（NO_DATA）"
    //   收紧到 0.8 仍复现（该场景她确实会进到 0.8 内）。
    //   → 判据必须限定在"**pathfinder 永远解决不了**"的情形：目标格本身走不进去。
    //     条件 = 目标格可攀爬 + 水平已在格里(≤1.0) + 高度已对。
    //     普通 walk 目标一律照旧交给 pathfinder，行为零变化。
    {
        const nowFeet = Math.floor(bot.entity.position.y);
        const dXZ = Math.hypot(bot.entity.position.x - step.x, bot.entity.position.z - step.z);
        const cellPos = { x: Math.floor(step.x), y: targetFeetY, z: Math.floor(step.z) };
        const cellBlock = blockAt(bot, cellPos.x, cellPos.y, cellPos.z);
        const cellClimbable = !!cellBlock && isClimbable(bot, cellPos);
        if (cellClimbable && dXZ <= 1.0 && nowFeet === targetFeetY) {
            onEvent({ type: 'walk-already-there', x: step.x, y: step.y, z: step.z, dXZ: +dXZ.toFixed(2), why: 'climbable-cell' });
            return ok({ walked: 0, alreadyThere: true, distXZ: +dXZ.toFixed(2) });
        }
    }

    const r = await moveToXZ(bot, { kind: 'point', posXZ: { x: step.x, z: step.z } },
        { tol: 0.8, timeout: 30000 });

    // ---- 走完后校验高度 ----
    //
    // ★ 2026-10-28 修：**下方也要校验**。
    // 实测（NAV_DEBUG 日志）：
    //   [step] down→(-212,56,-349) 结果=ok 现在=(-211.4,62.3,-348.5)
    // 规划要她降到 y=56，她停在 y=62 却报 ok —— 因为 moveToXZ 只管 x/z，
    // 脚下若是空气，pathfinder 不会主动往下跳，位置就停在原高度。
    // 结果：路径上所有 down 步骤都"假成功"，她一直在高处横向滑动，
    //       规划层看到还差很远，就一直重规划 → 38 秒只走 17 格。
    const nowY = Math.floor(bot.entity.position.y);
    if (r.ok && nowY > targetFeetY) {
        // 该往下但没下去：走到目标 x/z 之后主动往下走几步（让 pathfinder 找落点）
        for (let guard = 0; guard < 4 && Math.floor(bot.entity.position.y) > targetFeetY; guard++) {
            const below = blockAt(bot, Math.floor(bot.entity.position.x),
                Math.floor(bot.entity.position.y) - 1, Math.floor(bot.entity.position.z));
            if (below && IS_LIQUID.test(below.name)) {
                // 水里下沉：按住 sneak，不是挖。
                //
                // 地形现场：她要降到 y=58（湖底），但 y=59~62 是 4 格深的水。
                // 把水当"空地"只水平走，她会一直浮在水面 y=62 下不去，
                // 每轮报 `HEIGHT_MISS 该降到 y=58，实际停在 y=62`。
                //
                // 物理事实：**水中不用按任何键就会下沉**，这是重力 + 水的阻尼，
                // 不是"按 shift 才沉"。2026-10-29 实测（15 格深水池，逐秒采样）：
                //     起点 y=65.70
                //     2s → 64.73 / 4s → 63.70 / 6s → 62.70
                //     8s → 61.70 / 10s → 60.68 / 12s → 59.70
                // 即**稳定 1 格/秒**，sneak / 看向下方 / 前进 四种方式速度完全一样
                // （prismarine-physics 的水中分支里没有对 sneak 的特殊处理，
                //  只有梯子分支才有 `sneak ? 0 : -ladderMaxSpeed`）。
                //
                // 所以这里按 shift 只是为了让水平移动变慢（sneakSpeed 0.3）、
                // 免得她边沉边飘走。真正让她下去的是重力。
                //
                // ★ 关键：**等待时间必须按高差算，不能写死 6 秒**。
                // 原来固定 6 秒，而速度是 1 格/秒 —— 高差超过 6 格就永远沉不到，
                // 于是每轮都 break 掉、报 `HEIGHT_MISS 该降到 y=58，实际停在 y=62`。
                const needDrop = Math.floor(bot.entity.position.y) - targetFeetY;
                const diveMs = Math.min(30000, Math.max(4000, needDrop * 1000 + 2500));
                // ★ 2026-11-01（Phase A.1）：按键改由 `atom_input_move` 出手。
                //
                // 改之前这里直接 setControlState('sneak'/'forward')，而且这个最长 30 秒的
                // 下沉循环**一次都不查 interrupt_code**（REFACTOR_ANALYSIS §3.3 第 6 条，
                // 与 D16 同源：喊停了还在按着键往下沉，等沉到底才回来）。
                // holdKey 每 200ms 查一次中断、退出时在 finally 里松键 —— 两个问题一起没了。
                //
                // 判据与原来逐字对应：降到目标高度、或者着底（下方既不是液体也不是空气）。
                await releaseAll(bot, ['forward']);          // pathfinder 可能留下 forward
                const dove = await holdKey(bot, 'sneak', {
                    until: () => {
                        const ny = Math.floor(bot.entity.position.y);
                        if (ny <= targetFeetY) return true;                       // 降到目标附近
                        const nb = blockAt(bot, Math.floor(bot.entity.position.x), ny - 1, Math.floor(bot.entity.position.z));
                        return !!(nb && !IS_LIQUID.test(nb.name) && !IS_AIR.has(nb.name));   // 着底
                    },
                    timeout: diveMs,
                    intervalMs: 200,
                });
                if (!dove.ok && dove.code === 'INTERRUPTED') return dove;
                await sleep(150);
                // 如果沉到底了但还差高度，说明下方是实心：挖下去继续
                const afterDive = Math.floor(bot.entity.position.y);
                if (afterDive > targetFeetY) {
                    const nb2 = blockAt(bot, Math.floor(bot.entity.position.x), afterDive - 1, Math.floor(bot.entity.position.z));
                    if (nb2 && IS_LIQUID.test(nb2.name)) break;         // 还在水里但没沉动 → 放弃这轮
                    if (nb2 && !isDiggable(nb2)) break;
                    if (nb2) {
                        const d = await digBlock(bot, { kind: 'block', pos: { x: Math.floor(bot.entity.position.x), y: afterDive - 1, z: Math.floor(bot.entity.position.z) } });
                        if (!d.ok) break;
                        await sleep(300);
                    }
                }
            } else if (!below || IS_AIR.has(below.name)) {
                // 脚下真的是空气：朝目标 x/z 再走一步，会掉下去
                const rr = await moveToXZ(bot, { kind: 'point', posXZ: { x: step.x, z: step.z } },
                    { tol: 0.8, timeout: 8000 });
                if (!rr.ok) break;
                await sleep(300);
            } else {
                // 脚下实心：往下挖一格
                if (!isDiggable(below)) break;
                const d = await digBlock(bot, { kind: 'block', pos: { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y) - 1, z: Math.floor(bot.entity.position.z) } });
                if (!d.ok) break;
                await sleep(250);
            }
        }
        const after = bot.entity.position;
        if (Math.floor(after.y) > targetFeetY + 1) {   // 容差 1 格
            // 诊断：报错时把周围环境和物理状态记下来（定位"为什么下不去"）
            const fx = Math.floor(after.x), fy = Math.floor(after.y), fz = Math.floor(after.z);
            const bBelow = blockAt(bot, fx, fy - 1, fz);
            const bFeet = blockAt(bot, fx, fy, fz);
            const bBody = blockAt(bot, fx, fy + 1, fz);
            const diag = `脚下=${bBelow?.name ?? 'null'} 脚=${bFeet?.name ?? 'null'} 身=${bBody?.name ?? 'null'} onGround=${bot.entity.onGround} inWater=${bot.entity.isInWater}`;
            console.log(`[height-miss] 目标y=${step.y} 实际y=${after.y.toFixed(2)} | ${diag}`);
            onEvent({ type: 'height-miss', want: step.y, got: Math.round(after.y), diag });
            return { ok: false, code: 'HEIGHT_MISS', message: `该降到 y=${step.y}，实际停在 y=${Math.round(after.y)}（${diag}）` };
        }
    }

    // 走完还差高度 → 再补垫高（pathfinder 只管水平，不管垂直）
    // D1：判据与循环都按脚位（targetFeetY），旧代码用裸 step.y 会少上一格
    if (r.ok && Math.floor(bot.entity.position.y) < targetFeetY - 1) {
        let guard = 0;
        while (Math.floor(bot.entity.position.y) < targetFeetY && guard++ < 6) {
            const up = await stepUp(bot, { onEvent });
            if (!up.ok) break;
        }
    }
    return r;
}

/**
 * 往上走一格：跳 + 半空中垫脚下（用户定的做法，已真机验证）。
 * 这是"挖上去"的配套动作。
 */
async function stepUp(bot, opts = {}) {
    const { onEvent = () => { } } = opts;
    const scaffold = findScaffoldItem(bot);
    if (!scaffold) return fail('NO_ITEM', '没有可垫脚的方块');

    const y0 = bot.entity.position.y;
    const feet = {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
    };

    // ★ 2026-10-27 修：放方块前先清掉脚下格里的**非实体方块**（火把/草/藤蔓）。
    //
    // 实测：她站在 y=55 的 torch 上（自己插的火把），stepUp 往 y=55 放 cobblestone
    // 报 OCCUPIED 放不进去 → 跳不上 y=56 → 整条 dig 路径失败。
    // 火把、草、藤蔓这类"可替换"方块必须先挖掉。
    const feetBlock = blockAt(bot, feet.x, feet.y, feet.z);
    if (feetBlock && !IS_AIR.has(feetBlock.name)) {
        const r = await digBlock(bot, { kind: 'block', pos: feet });
        if (r.ok) await sleep(250);
        onEvent({ type: 'clear-feet', name: feetBlock.name, ok: r.ok });
    }

    // ★ 2026-10-28 修：**跳之前先挖开头顶**。
    //
    // 实测（真机）：jump(-126,63,-206) 失败: STUCK 跳上 y=62 失败（停在 61.0）
    // 她在 y=61 想上到 62，但头顶（y=62、y=63）是实心，
    // 跳起来立刻被顶回去 —— 峰值到不了 0.95 格，placeBlock 永远不触发。
    // 所以"1 格高差也上不去"的真因不是跳跃能力，是**空间不够**。
    // 她身高 1.8、跳 1.25，需要 3 格净空，先挖开头顶两格。
    for (const dy of [1, 2]) {
        const hb = blockAt(bot, feet.x, feet.y + dy, feet.z);
        if (!hb || IS_AIR.has(hb.name) || IS_LIQUID.test(hb.name)) continue;
        if (!isDiggable(hb)) {
            return fail('NO_TOOL', `跳不上去：头顶 y=${feet.y + dy} 是 ${hb.name}，挖不动`);
        }
        const hr = await digBlock(bot, { kind: 'block', pos: { x: feet.x, y: feet.y + dy, z: feet.z } });
        onEvent({ type: 'clear-head', y: feet.y + dy, name: hb.name, ok: hr.ok });
        if (!hr.ok && !/air/i.test(String(hr.message ?? ''))) {
            return fail(hr.code ?? 'DIG_FAIL', `挖头顶 ${hb.name} 失败`);
        }
        await sleep(200);
    }


    // 重试 3 次：每次是一次**原子尝试**（atom_pillar.pillarUpOnce）。
    // 原来这里的起跳/换手/放方块是手写的，而 skill_escape 又抄了一份
    // （等 0.9 格、放完 300ms）——两处细节已经开始不一样。现在只有原子那一份。
    let lastFail = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await pillarUpOnce(bot, { item: scaffold, settleMs: 450 });
        onEvent({ type: 'pillar-attempt', attempt: attempt + 1, ok: r.ok, code: r.code, placeResult: r.data?.placeResult });
        if (r.ok) {
            return ok({ fromY: r.data?.fromY ?? y0, toY: r.data?.toY ?? bot.entity.position.y, attempts: attempt + 1 });
        }
        lastFail = r;
        if (r.code === 'INTERRUPTED') return r;
    }

    return fail('STUCK', `跳上 y=${feet.y + 1} 失败（停在 ${bot.entity.position.y.toFixed(1)}）`, {
        attempts: 3, lastCode: lastFail?.code, lastMessage: lastFail?.message,
    });
}

/**
 * 走到目标（唯一入口）。
 *
 * @param {object} bot
 * @param {{x:number,z:number}} dest
 * @param {{mapDir:string, onEvent?:Function, deadlineMs?:number, arriveTol?:number, rescan?:boolean}} opts
 */
export async function walkTo(bot, dest, opts = {}) {
    const {
        mapDir,
        onEvent: userOnEvent = () => { },
        deadlineMs = 300000,
        arriveTol = 5,
        rescan = true,
    } = opts;

    // ★ 2026-10-30：包装一层，让所有事件同时进 trace_bus（前端诊断面板用）。
    // 这样无论调用方自己传了什么 onEvent，事件都不会再"出了进程就没了"。
    //
    // ★ 2026-11-01（09 §2 / D10）：**walkTo 是最外层**（谁调它谁就不再包），
    //   它包过的 onEvent 原样传给 execStep / climb / stepUp，内层只调不包，
    //   所以每个事件只记一次。幂等靠 `ensureTraced` 的函数记号保证。
    const onEvent = ensureTraced(userOnEvent);

    const t0 = Date.now();
    if (!mapDir) return fail('INTERNAL', 'walkTo 需要 mapDir');
    // 注意：中断检查放到 try 内部（见下），否则会在暂停 mode 之前提前返回，
    // 导致 unstuck 根本没被 pause 就把控制权交回去。

    // ★ 2026-10-29：导航期间**暂停会抢控制权的自主模式**（重点是 unstuck）。
    //
    // 用户原话：「有 unstuck 应该让她躲开，而不是打断」。
    //
    // 实测问题：长规划第 1~7 轮稳定推进 64 格，随后 unstuck 判定"20 秒内移动
    // <2 格"，直接 interrupts:['all'] 打断任务，还 moveAway(5) 把她挪走 ——
    // 结果 hopTo 返回 INTERRUPTED，走了 103 格的前功尽弃。
    //
    // 而她"走不动"这件事 walkTo 本来就会处理：重规划、recordFail 记失败点、
    // 振荡检测换路。unstuck 在上面再插一脚纯属重复，代价是丢掉全部进度。
    //
    // ★ 2026-11-01：mode 清单不再在这里写第二份。
    //
    // 这一段原来硬编码了 6 个 mode 名（item_collecting / torch_placing / idle_staring /
    // hunting / unstuck / elbow_room），而 `task_modes.GOAL_MODES` 里就是同一份清单 ——
    // 正是 §3.2 记的「mode 列表三套」的残留。现在只留一个真相：
    // pauseGoalModes / restoreGoalModes（modes.js）。
    //
    // 为什么要暂停它们（原注释保留）：实测长规划第 1~7 轮稳定推进 64 格，随后 unstuck
    // 判定"20 秒内移动 <2 格"，直接 interrupts:['all'] 打断任务，还 moveAway(5) 把她挪走
    // —— 结果 hopTo 返回 INTERRUPTED，走了 103 格的前功尽弃。而"走不动"walkTo 本来就会
    // 处理（重规划 / recordFail / 振荡检测换路），unstuck 在上面再插一脚纯属重复。
    const pausedModes = pauseGoalModes(bot);
    const restoreModes = () => restoreGoalModes(bot, pausedModes);

    let rounds = 0, scans = 0, stepsDone = 0, distMoved = 0;
    let lastPos = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
    let stalled = 0;
    let lastErr = null;

    // ★ 2026-10-28 新增：**振荡检测**。
    //
    // 实测：她在 (-37,63,-232) 和 (-34,62,-233) 之间来回走了 10 轮
    // （剩 141 → 138 → 141 → 138…）。原因是 A* 有两条代价相同的路，
    // 每轮重规划时起点差半格，就换了一条，于是来回摆。
    //
    // 这种"每轮都在动但净位移为零"的情况，旧判据（位移<2 才叫卡住）抓不到，
    // 会一直振荡到 deadline。所以额外记最近 6 轮的位置，
    // 如果当前点回到 8 格内出现过 ≥3 次，就判定振荡。
    const recentPos = [];
    // 上一轮实际执行的路径（振荡时用来"禁用这条路的特征段"）
    let lastPathKeys = new Set();

    try {
        // 中断检查放在 try 内：保证任何提前返回都会走 finally 恢复 mode。
        if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (bot.interrupt_code) {
            return fail('INTERRUPTED', `停了，走了 ${distMoved.toFixed(0)} 格`,
                { rounds, steps: stepsDone, moved: +distMoved.toFixed(1), costMs: Date.now() - t0 });
        }
        if (Date.now() - t0 > deadlineMs) {
            return fail('TIMEOUT', `走了 ${Math.round((Date.now() - t0) / 1000)} 秒、${distMoved.toFixed(0)} 格`,
                { rounds, steps: stepsDone, moved: +distMoved.toFixed(1), costMs: Date.now() - t0 });
        }

        const p = bot.entity.position;
        const remain = Math.hypot(dest.x - p.x, dest.z - p.z);

        // 振荡检测：同一片区域反复回来 ≥3 次 → 换策略（记失败点并放开一次）
        {
            const same = recentPos.filter(q => Math.hypot(q.x - p.x, q.z - p.z) < 8).length;
            if (same >= 3) {
                console.log(`[walkTo] 检测到振荡：(${p.x.toFixed(0)},${p.z.toFixed(0)}) 附近 6 轮内已来 ${same} 次 → 禁用上轮路径中段`);
                onEvent({ type: 'oscillation', round: rounds, at: { x: Math.round(p.x), z: Math.round(p.z) }, times: same });

                // ★ 2026-10-28 修：**不能只记录"她当前位置"**。
                //
                // 实测：她当前位置本来就在两条路的共同段上，给它加价等于两条路都涨，
                // 规划器照旧在 32 步/36 步之间来回给 —— 振荡检测触发了 5 次，一次都没生效。
                //
                // 正确做法：禁用**上一轮路径的中段**（那条路 1/3~2/3 处的格子），
                // 这才区分得开两条候选路。用 recordFail 记 3 次（加价 4 倍）足够。
                try {
                    const { recordFail } = await import('./terrain3d.js');
                    const keys = [...lastPathKeys];
                    if (keys.length) {
                        const from = Math.floor(keys.length / 3);
                        const to = Math.floor(keys.length * 2 / 3);
                        for (let i = from; i < to; i++) {
                            const [kx, ky, kz] = keys[i].split(',').map(Number);
                            recordFail(mapDir, kx, ky, kz);
                            recordFail(mapDir, kx, ky, kz);
                            recordFail(mapDir, kx, ky, kz);
                        }
                        console.log(`[walkTo] 已禁用上轮路径中段 ${to - from} 格`);
                    }
                } catch { /* ignore */ }
                recentPos.length = 0;         // 清空，给它一次新机会
                stalled = 0;
            }
            recentPos.push({ x: p.x, z: p.z });
            if (recentPos.length > 6) recentPos.shift();
        }

        if (remain <= arriveTol) {
            return ok({
                rounds, scans, steps: stepsDone, moved: +distMoved.toFixed(1),
                distRemaining: +remain.toFixed(1), costMs: Date.now() - t0,
            });
        }

        // 卡住判定：连续 3 轮几乎没动 → 老实失败
        //
        // ★ 2026-10-27 修：**垂直移动也算移动**。
        // 之前只算 Math.hypot(dx, dz)，于是"挖上去 1 格"被判成"没动"，
        // 连续 3 次就误判 NO_REACH —— 而她明明在往上爬（实测 y 55→70 全靠这个）。
        if (round > 0) {
            // 卡住判据改用原子（refactor §5 Phase 2.2）：垂直权重等魔数不再藏在这里
            const mvInfo = movedEnough(lastPos, p);
            const stepMoved = mvInfo.data?.gap ?? 0;
            if (stepMoved < (mvInfo.data?.minMove ?? 2)) {
                stalled++;
                if (stalled >= 3) {
                    return fail('NO_REACH',
                        `连续 3 轮走不动（还差 ${remain.toFixed(0)} 格，最后原因 ${lastErr ?? '未知'}）`,
                        { rounds, steps: stepsDone, moved: +distMoved.toFixed(1), distRemaining: +remain.toFixed(1), costMs: Date.now() - t0 });
                }
            } else {
                stalled = 0;
                // 累计"走了多少"用**真实**位移（不做垂直加权），否则日志数字会虚高
                distMoved += realMove(lastPos, p);
            }
        }
        lastPos = { x: p.x, y: p.y, z: p.z };

        // ---- 1) 扫球 ----
        if (rescan) {
            try {
                const s = scanSphere(bot, mapDir,
                    { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, SCAN_R);
                scans++;
                if (s.cells) onEvent({ type: 'scan3d', cells: s.cells, ms: s.ms, chunks: s.chunks });
            } catch (e) {
                console.log('[walkTo] 3D 扫描失败:', String(e?.message ?? e).slice(0, 60));
            }
        }

        // ---- 2) 3D 规划下一段 ----
        const len = Math.max(1, remain);
        const aim = remain <= LOOK_AHEAD ? { x: dest.x, z: dest.z } : {
            x: p.x + (dest.x - p.x) / len * LOOK_AHEAD,
            z: p.z + (dest.z - p.z) / len * LOOK_AHEAD,
        };

        // ★ D1（2026-10-31）：**传给 plan3D 的 y 必须是「面位」，不是脚位**。
        //
        // path_3d 整个模块工作在"面位"坐标系里：surf 表存的就是实心方块自己的 y
        // （terrain3d.scanSphere 里 s.ins.run(wx, wz, y, t) 的 y），
        // 它自己的 bench 脚本也按 surf 的 y 传参。
        //
        // 但 walkTo 以前传的是 p.y（脚位 = 面位 + 1）：
        //   surf.has(key(tx, ty, tz)) 因此永远命中不了 → 落到"目标附近 4 格找面"的吸附分支。
        // 吸附恰好把 1 格差吸收了，所以"看起来能用"，但实际上：
        //   - 终点是碰巧找对的，列里若同时有 63/65 两个面就可能吸错层
        //   - 启发式里的 |y - ty| 一直带着 1 格固定偏移（h 权重 0.25）
        // 现在显式换算，吸附只作兜底。
        const surfY = Math.floor(p.y) - 1;
        let plan = null;
        try {
            plan = plan3D(mapDir, { x: p.x, y: surfY, z: p.z }, { x: aim.x, y: surfY, z: aim.z },
                { maxNodes: 80000, margin: 24 });
        } catch (e) {
            console.log('[walkTo] 3D 规划异常:', String(e?.message ?? e).slice(0, 80));
        }
        rounds++;

        // 失败就重扫一次再试（数据可能因为她自己垫方块而过时）
        if (!plan || !plan.ok) {
            const code1 = plan?.code ?? 'THREW';
            onEvent({ type: 'plan-fail', round: rounds, code: code1 });
            if (rescan) {
                try {
                    scanSphere(bot, mapDir, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, SCAN_R);
                    scans++;
                } catch { /* ignore */ }
                try {
                    plan = plan3D(mapDir, { x: p.x, y: surfY, z: p.z }, { x: aim.x, y: surfY, z: aim.z },
                        { maxNodes: 80000, margin: 24 });
                } catch { /* ignore */ }
            }
            if (!plan || !plan.ok) {
                lastErr = plan?.code ?? 'THREW';
                // ★ 2026-10-29 修：**保留规划器的真实错误码，别一律压成 NO_PATH**。
                //
                // 原来无论 plan3D 返回 NO_START / NO_DATA / BUDGET，这里都写成 NO_PATH，
                // 真实原因只留在 message 文本里 → 上层无法据此做不同处理，
                // 排查时也只能靠翻日志认字（实测日志里
                // `3D 规划失败（NO_START，7097 个面）` 的 code 其实是 NO_PATH）。
                //
                // NO_PATH 只用于"规划器确实搜了但没找到路"这一种；
                // 其余（起点没数据、起点悬空、预算用完）如实透出。
                const planCode = (lastErr === 'NO_PATH' || lastErr === 'BUDGET')
                    ? 'NO_PATH'
                    : (lastErr === 'NO_START' ? 'NO_START' : 'NO_DATA');
                return fail(planCode,
                    `3D 规划失败（${lastErr}，${plan?.surfaces ?? 0} 个面），还差 ${remain.toFixed(0)} 格`,
                    { rounds, steps: stepsDone, moved: +distMoved.toFixed(1), distRemaining: +remain.toFixed(1), costMs: Date.now() - t0 });
            }
        }

        onEvent({
            type: 'plan3d', round: rounds, steps: plan.path.length,
            cost: Math.round(plan.cost), nodes: plan.nodes, surfaces: plan.surfaces,
        });
        // 记住这一轮的路径，振荡时可用来"禁用这条路"
        lastPathKeys = plan.path.map(p2 => `${p2.x},${p2.y},${p2.z}`);

        // ---- 3) 逐步执行 ----
        //
        // 3D 路径的每一步本来就是**一格**（walk/jump/down/dig），所以一次只走一格。
        // 不要"一次走多格"：跨多格时 pathfinder 中途撞到她自己的柱子会整段 NO_PATH，
        // 而逐格执行时每格之间都能重新判断，局部障碍不会拖死整条路。
        //
        // 每轮最多执行 10 格（=10 步），然后重扫重规划（滚动窗口）。
        const MAX_STEPS = 10;
        const last = Math.min(MAX_STEPS, plan.path.length - 1);
        let anyMoved = false;

        for (let i = 1; i <= last; i++) {
            const step = plan.path[i];
            if (!step) break;
            if (bot.interrupt_code) return fail('INTERRUPTED', '停了');

            const before = bot.entity.position.clone();
            const r = await execStep(bot, step, { onEvent, mapDir });   // mapDir：落点检查要用（D14）
            // 诊断：记录每一步的目标与执行后位置，定位"返回 ok 但没动"的情况
            if (process.env.NAV_DEBUG) {
                const nn = bot.entity.position;
                console.log(`[step] ${step.action}→(${step.x},${step.y},${step.z}) 结果=${r.ok ? 'ok' : r.code} 现在=(${nn.x.toFixed(1)},${nn.y.toFixed(1)},${nn.z.toFixed(1)})`);
            }
            stepsDone++;

            const now = bot.entity.position;
            const moved = Math.hypot(now.x - before.x, now.z - before.z) + Math.abs(now.y - before.y);
            if (!r.ok) {
                lastErr = r.code ?? 'STEP_FAIL';
                console.log(`[walkTo] 第${rounds}轮 步${i} ${step.action}(${step.x},${step.y},${step.z}) 失败: ${lastErr} ${r.message ?? ''}`);

                // ★ 2026-10-28 改：**记失败，不删数据**。
                //
                // 10-27 版是 forgetSurface（直接删掉落点），但实测发现：
                // 下一轮 scanSphere 会把同一格**重新写回** surf 表 ——
                // 日志里出现过同一格被删 3 次、写回 3 次，规划永远给同一个不可达点。
                //
                // 现在改成 recordFail：地形数据不动，单独记一条"这里走过失败"。
                // plan3D 读它来给该格加价（×1+hits），既不封死也不会被扫描覆盖。
                try {
                    const { recordFail } = await import('./terrain3d.js');
                    recordFail(mapDir, step.x, step.y, step.z);
                    console.log(`[walkTo] 已记录失败点 (${step.x},${step.y},${step.z})`);
                } catch (e) {
                    console.log('[walkTo] 记录失败点出错:', String(e?.message ?? e).slice(0, 60));
                }

                break;                    // 这一步失败就跳出，下一轮重新规划
            }
            if (moved > 0.3) anyMoved = true;
        }

        const now = bot.entity.position;
        console.log(`[walkTo] 第${rounds}轮 规划${plan.path.length}步 → 现在(${Math.round(now.x)},${Math.round(now.y)},${Math.round(now.z)}) 剩${Math.hypot(dest.x - now.x, dest.z - now.z).toFixed(0)}格`);

        if (!anyMoved) {
            lastErr = lastErr ?? 'NO_MOVE';
        }
    }

    const pEnd = bot.entity.position;
    const left = Math.hypot(dest.x - pEnd.x, dest.z - pEnd.z);
    return fail('NO_PATH', `跑满 ${MAX_ROUNDS} 轮还没到，还差 ${left.toFixed(0)} 格`,
        { rounds, steps: stepsDone, moved: +distMoved.toFixed(1), distRemaining: +left.toFixed(1), costMs: Date.now() - t0 });
    } finally {
        // 无论怎么退出都要恢复 mode，否则 unstuck 会永久停在 paused，
        // 表现为"她以后再也不脱困"。
        restoreModes();
    }
}

/** 3D 库概况（给诊断命令用）。 */
export function describeStore(mapDir) {
    try {
        const s = stats3d(mapDir);
        return `3D 库：${s.cells} 个可站立面 / ${s.chunks} 个区块`;
    } catch (e) {
        return `3D 库读不到：${e.message}`;
    }
}

/**
 * ★★ 2026-11-03（t35）：挖掉一格后**局部更新 terrain3d**。
 *
 * 真机证据（这是本函数存在的全部理由）：
 *   `dig-through` 场景里 `dig` 报 **OK**、真实世界那格已经 air，
 *   但 `columnSurfaces` 读出来**仍然说 SOLID** → 下一轮规划看到的还是"墙没动"
 *   → 反复挖同一处 → 挖 4 格后库与现实彻底对不上 → `plan-fail` → **NO_PATH**。
 *
 * 为什么是"局部更新"而不是"整片重扫"：
 *   重扫是 O(半径³) 的块操作，每挖一格都重扫太贵；
 *   而且实测**连重扫都救不了**（t35 报告：rescan 后仍 NO_PATH）——
 *   因为重扫写回的是"顶面"，而她要的是"墙身被挖穿"这件事。
 *
 * 失败不影响挖矿本身（更新库是附属动作，不许把它带崩）。
 */
function updateSurfAfterDig(mapDir, x, y, z, bot) {
    if (!mapDir) return;
    try {
        const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
        forgetSurface(mapDir, fx, fy, fz);
        // 挖掉后**下面那格**成为新的落脚面（用真实世界的方块重新分类）
        const below = bot?.blockAt?.(new Vec3(fx, fy - 1, fz), false);
        if (below) {
            const t = classifyBlock(below.name);
            // 空气不算面；其余照实登记
            if (t !== undefined && t !== null && !/^(air|cave_air|void_air)$/.test(below.name)) {
                noteDugSurface(mapDir, fx, fy, fz, t);
            }
        }
    } catch { /* 更新失败不许影响挖矿结果 */ }
}
