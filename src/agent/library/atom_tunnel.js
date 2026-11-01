/**
 * A4 掘进：挖一格、走一格。
 *
 * 单一副作用：沿某个水平方向把挡路的方块挖掉，然后前进一格。
 * 不负责"决定去哪"（那是复合层）——只负责"这一步挖得安全吗、挖完能站吗"。
 *
 * ★ 2026-10-29 新建（用户设计）：
 *   「地表：往前挖一格就再步进一格，但要小心掉到危险的地方，得先规划好动作轨迹。
 *     地下：前面挖上下俩格够过的隧道再步进一格，但还是要提前规划，防止危险。
 *     可以试试在挖之前搞个安全范围，也就是在那个范围内可以随便挖，
 *     相当于我们的战棋格的精细小范围版。」
 *
 * 为什么需要它：
 *   现有 walkTo 靠 pathfinder 走"已有通路"。遇到"树在高 9 格的崖上""前方一堵土墙"，
 *   pathfinder 只会绕路或失败。她能挖，但从没有"挖着往前走"的原语 ——
 *   `dig` 只挖单个方块，`stepUp` 只往上垫一格，都不构成"往前开路"。
 *
 * 三个设计要点（对应上面那段话）：
 *   1) **安全范围（safe zone）**：以一个箱子界定"允许挖的区域"，出界一律拒绝。
 *      这是战棋格的精细化版本 —— 不再是整张地图分格，而是"我身边这一小块"。
 *   2) **先规划后动手**：每一步都先 checkStep() 算出会挖哪几格、挖完站在哪，
 *      确认安全才 dig。绝不"先挖了再看"。
 *   3) **液体是硬红线**：上下左右只要有水/岩浆，这一步直接否决 ——
 *      挖穿水会灌进来，挖穿岩浆会烧死。这是唯一的一票否决。
 */
import { ok, fail } from './atom_contract.js';
import { blockAt } from './atom_perceive.js';
import { digBlock, isDiggable } from './atom_dig.js';
import { moveToXZ } from './atom_move.js';
import { holdKey, releaseAll } from './atom_input_move.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 空气类（挖完变成这些就算通了）。 */
const AIRISH = new Set(['air', 'cave_air', 'void_air']);

/** 绝对不能碰的方块。 */
const FORBIDDEN = /^(bedrock|water|lava|barrier|command_block|end_portal|end_portal_frame|nether_portal|obsidian|crying_obsidian|reinforced_deepslate)$/;

/** 液体（挖穿会灌进来 → 一票否决）。 */
const LIQUID = /^(water|lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;

/** 脚下这些方块可以站（其余像沙子/沙砾会塌，挖穿风险高，也放行但记账）。 */
const STANDABLE = /^(stone|dirt|grass_block|cobblestone|andesite|diorite|granite|deepslate|tuff|calcite|sandstone|netherrack|sand|gravel|clay|podzol|mycelium|moss_block|snow_block|_ore$|_bricks$|_planks$)/;

/** 一步最多挖几格（脚下 1 + 头 1，再留一点余量给台阶）。 */
const MAX_DIG_PER_STEP = 3;

/**
 * 计算安全范围：以她为中心的一个箱子。
 *
 * 「在那个范围内可以随便挖」——这是本模块的核心约束。
 * 出界的方块一律不碰，哪怕它挡路。
 *
 * @param {object} bot
 * @param {{radius?:number, up?:number, down?:number}} opts
 * @returns {{ok:true, x0:number,x1:number,y0:number,y1:number,z0:number,z1:number}}
 */
export function computeSafeZone(bot, opts = {}) {
    const { radius = 4, up = 3, down = 3 } = opts;
    const p = bot.entity.position;
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    return {
        ok: true,
        x0: x - radius, x1: x + radius,
        y0: y - down, y1: y + up,
        z0: z - radius, z1: z + radius,
    };
}

/** 某格是否在安全范围内。 */
export function inSafeZone(zone, pos) {
    if (!zone || !pos) return false;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return x >= zone.x0 && x <= zone.x1
        && y >= zone.y0 && y <= zone.y1
        && z >= zone.z0 && z <= zone.z1;
}

/** 读方块，读不到返回 null（读不到 ≠ 空气）。 */
function at(bot, x, y, z) {
    return blockAt(bot, { x, y, z });
}

/** 这格是不是液体。 */
function isLiquid(b) {
    return !!b && LIQUID.test(b.name);
}

/**
 * 检查"往 dir 方向掘进一格"是否安全可行（**只读，不动手**）。
 *
 * 这是"提前规划"的核心：先算出要挖哪几格、挖完站在哪、周围有没有液体，
 * 全通过才返回 ok。任何一项不过都如实说明原因。
 *
 * 判据（按重要性排序）：
 *   1. 目标格在安全范围内
 *   2. 目标格的脚/头两格可挖（或是空气）
 *   3. 目标格的地板是实心（否则挖完就掉下去）
 *   4. **目标格四周没有液体**（挖穿会灌进来 / 烧死）—— 一票否决
 *   5. 头顶不能是液体（同上）
 *
 * @param {object} bot
 * @param {{dx:number, dz:number, dy?:number}} dir 水平方向（dx/dz ∈ {-1,0,1}）
 * @param {{zone?:object, allowFall?:boolean}} opts
 * @returns {{ok:true, dig:Array<{x,y,z,name:string}>, to:{x,y,z}, floor:string}
 *          | {ok:false, code:string, why:string}}
 */
export function checkStep(bot, dir, opts = {}) {
    const { zone = null, allowFall = false } = opts;
    const p = bot.entity.position;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const dy = dir.dy ?? 0;
    const tx = fx + dir.dx, ty = fy + dy, tz = fz + dir.dz;

    // 1) 安全范围
    if (zone && !inSafeZone(zone, { x: tx, y: ty, z: tz })) {
        return { ok: false, code: 'OUT_OF_ZONE', why: `(${tx},${ty},${tz}) 出了安全范围` };
    }

    // 2) 脚/头两格
    const feetB = at(bot, tx, ty, tz);
    const headB = at(bot, tx, ty + 1, tz);
    if (!feetB || !headB) {
        return { ok: false, code: 'NO_DATA', why: `(${tx},${ty},${tz}) 还没加载，看不到方块` };
    }

    const dig = [];
    for (const [b, yy, label] of [[feetB, ty, '脚'], [headB, ty + 1, '头']]) {
        if (AIRISH.has(b.name)) continue;                 // 已经是空的，不用挖
        if (FORBIDDEN.test(b.name) || isLiquid(b)) {
            return { ok: false, code: 'BLOCKED', why: `${label}位是 ${b.name}，不能挖` };
        }
        if (!isDiggable(b)) {
            return { ok: false, code: 'NO_TOOL', why: `${label}位 ${b.name} 挖不动` };
        }
        dig.push({ x: tx, y: yy, z: tz, name: b.name });
    }
    if (dig.length > MAX_DIG_PER_STEP) {
        return { ok: false, code: 'TOO_MUCH', why: `一步要挖 ${dig.length} 格，超过上限` };
    }

    // 3) 地板必须实心（否则挖完直接掉下去）
    //
    // ★ 2026-10-29 修：**往上挖台阶时，检查的位置不一样**。
    //
    // 水平掘进：挖开 (tx,ty,tz) 后走进去，脚下是 (tx,ty-1,tz) —— 那里必须实心。
    // 往上挖：  (tx,ty,tz) 是**头顶斜上方**的一格，她要先挖掉它再跳上去，
    //           落点支撑是**她当前站的方块**，不是 (tx,ty-1,tz)。
    //           实测事故：面对 6 格高实心台地往上挖台阶，每一步都报
    //           `NO_FLOOR (42,65,-300) 下方是 air` —— 因为台地内部是实心的，
    //           y-1 那格正是她刚挖开的空洞，于是永远挖不上去（20 步 dug=0）。
    const digUp = (dir.dy ?? 0) > 0;

    // 往上挖时两个条件都要满足：
    //   ① 我现在站的方块是实心的（不然起跳都没地方）
    //   ② **目标格本身下方也要实心**（不然跳上去直接掉回来）
    //
    // 实测：台地 y=63~65 被挖空、y=66 才是实心层。她 y=64 时 `dy:2` 会算到
    // "站 y=65"，而 y=65 是空气 —— 跳上去根本没支撑，白跳。
    // 只有 `dy:3`（站 y=66，下方是 y=65… 不对，是 y=66 本身实心）才真的能站住。
    const curFloor = at(bot, fx, fy - 1, fz);
    if (!curFloor) {
        return { ok: false, code: 'NO_DATA', why: `脚下 (${fx},${fy - 1},${fz}) 读不到` };
    }
    if (digUp && AIRISH.has(curFloor.name)) {
        return { ok: false, code: 'NO_FLOOR', why: `我脚下 (${fx},${fy - 1},${fz}) 是空的，没地方起跳` };
    }

    const supportX = digUp ? tx : tx;
    const supportY = ty - 1;
    const supportZ = tz;
    const floorB = at(bot, supportX, supportY, supportZ);
    if (!floorB) {
        return { ok: false, code: 'NO_DATA', why: `(${supportX},${supportY},${supportZ}) 落脚点读不到` };
    }
    // D15（2026-11-01）：原来写成 isLiquid(floorB.name)，传了字符串，isLiquid 读 b.name → 恒为 false，
    // 水 / 岩浆地板被当成实心。地板不在下面"液体一票否决"扫的邻格里，只能靠这里挡。
    const floorSolid = !AIRISH.has(floorB.name) && !isLiquid(floorB);
    if (!floorSolid && !allowFall) {
        return { ok: false, code: 'NO_FLOOR', why: `(${tx},${ty},${tz}) 下方是 ${floorB.name}，站不住` };
    }

    // 4) **液体一票否决**：目标格的水平四邻 + 上方，任一为液体就不挖
    const risky = [
        [tx + 1, ty, tz], [tx - 1, ty, tz], [tx, ty, tz + 1], [tx, ty, tz - 1],   // 四周
        [tx, ty + 2, tz],                                                        // 正上方（挖穿会灌）
        [tx + 1, ty + 1, tz], [tx - 1, ty + 1, tz], [tx, ty + 1, tz + 1], [tx, ty + 1, tz - 1],
    ];
    for (const [x, y, z] of risky) {
        const b = at(bot, x, y, z);
        if (b && LIQUID.test(b.name)) {
            return { ok: false, code: 'LIQUID_RISK', why: `(${x},${y},${z}) 有 ${b.name}，挖了会灌进来` };
        }
    }

    return { ok: true, dig, to: { x: tx, y: ty, z: tz }, floor: floorB.name };
}

/**
 * 掘进一格：先挖（按 checkStep 的结果），再前进。
 *
 * 顺序很重要：**先挖后走**。这样掉落物正好落在她要站的那格，走过去自动捡起
 * ——顺带解决了"挖了方块却捡不到"的老问题（实测 ensureScaffold 挖 6 个捡到 0 个）。
 *
 * @param {object} bot
 * @param {{dx:number, dz:number, dy?:number}} dir
 * @param {{zone?:object, onEvent?:Function, walkTimeout?:number}} opts
 * @returns {Promise<ActionResult>} data: { from, to, dug }
 */
export async function tunnelStep(bot, dir, opts = {}) {
    const { zone = null, onEvent = () => { }, walkTimeout = 6000 } = opts;
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const from = {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
    };

    // 1) 先规划
    const chk = checkStep(bot, dir, { zone });
    if (!chk.ok) {
        onEvent({ type: 'tunnel-refuse', code: chk.code, why: chk.why });
        return fail(chk.code, chk.why);
    }

    // 2) 再挖（一次一格，挖完确认真的没了）
    const dug = [];
    for (const d of chk.dig) {
        const r = await digBlock(bot, { kind: 'block', pos: { x: d.x, y: d.y, z: d.z } });
        if (!r.ok) {
            onEvent({ type: 'tunnel-dig-fail', pos: { x: d.x, y: d.y, z: d.z }, code: r.code });
            return fail(r.code ?? 'DIG_FAIL', `挖 ${d.name} 失败`, { from, dug });
        }
        dug.push({ x: d.x, y: d.y, z: d.z, name: d.name });
        await sleep(120);
    }

    // 3) 进到那一格。
    //
    // ★ 2026-10-29 修：**moveToXZ 只管水平，往上挖的台阶它上不去**。
    //
    // 实测事故：她朝 6 格高台地"往上挖台阶"，目标格 (x+1, y+1) 早已是空气，
    // 于是 dug=0；随后 moveToXZ 只把她水平挪过去（x 一路 38→42），
    // 高度纹丝不动 —— 循环 20 步、dug=0、y 一直是 63。
    //
    // 现在：水平到位后，如果目标格比她高，就按"跳 + 到位"往上走。
    const dyUp = chk.to.y - Math.floor(bot.entity.position.y);
    if (dyUp !== 0) {
        // 先水平对齐
        await moveToXZ(bot, { kind: 'point', posXZ: { x: chk.to.x, z: chk.to.z } },
            { tol: 0.9, timeout: walkTimeout });
        if (dyUp > 0) {
            // 往上：按住 jump，等高度到位（最多 2.5 秒）
            // 2026-11-01（Phase A.1）：按键走 atom_input_move，顺带获得"等待中查中断"。
            const up = await holdKey(bot, 'jump', {
                until: () => Math.floor(bot.entity.position.y) >= chk.to.y,
                timeout: 2500,
                intervalMs: 100,
            });
            if (!up.ok && up.code === 'INTERRUPTED') return up;
            await sleep(120);
            // 还不到位就再朝目标挪一点（贴边跳上去）
            if (Math.floor(bot.entity.position.y) < chk.to.y) {
                await moveToXZ(bot, { kind: 'point', posXZ: { x: chk.to.x, z: chk.to.z } },
                    { tol: 0.6, timeout: 4000 });
            }
        } else {
            // 往下：清空按键让重力带下去
            await releaseAll(bot);
            const down = await holdKey(bot, [], {
                until: () => Math.floor(bot.entity.position.y) <= chk.to.y,
                timeout: 2000,
                intervalMs: 100,
            });
            if (!down.ok && down.code === 'INTERRUPTED') return down;
        }
    } else {
        const mv = await moveToXZ(bot, { kind: 'point', posXZ: { x: chk.to.x, z: chk.to.z } },
            { tol: 0.8, timeout: walkTimeout });
        if (!mv.ok) {
            onEvent({ type: 'tunnel-walk-fail', code: mv.code });
            return fail(mv.code ?? 'NO_MOVE', '挖通了但走不过去', { from, dug });
        }
    }

    const to = {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
    };
    onEvent({ type: 'tunnel-step', from, to, dug: dug.length });
    return ok({ from, to, dug });
}

/**
 * 沿直线方向连续掘进 steps 步。
 *
 * 每步都重新 checkStep（**不是一次性规划到底**）：因为挖开之后脚下/头顶会变，
 * 一开始算好的"后面几步"可能已经不安全了。这也是用户说的"提前规划"——
 * 提前规划的是**每一步**，而不是一条不看的死路线。
 *
 * @param {object} bot
 * @param {{dx:number, dz:number, dy?:number}} dir
 * @param {number} steps
 * @param {{onEvent?:Function, deadlineMs?:number}} opts
 * @returns {Promise<ActionResult>} data: { steps, dug, to }
 */
/**
 * 找一个**干燥的可爬升列**：从她当前高度往上，这一列没有液体。
 *
 * 什么时候用：`climbByTunneling` 想往上挖，但正前方是一片水（`LIQUID_RISK`）。
 *   与其硬挖灌水，不如先横移到旁边没水的一列，再从那里爬。
 *
 * 只读，不挖不走。
 *
 * @param {object} bot
 * @param {{x:number,z:number}} target 目标水平位置（用来给候选列打分）
 * @param {{radius?:number, upTo?:number, maxCandidates?:number}} opts
 *        upTo：要爬到的高度（默认按 target 或她 +8）
 * @returns {{ok:true, candidates:Array<{x,z,score,why}>} | {ok:false, code:string, why:string}}
 */
export function findDryClimbColumn(bot, target, opts = {}) {
    const { radius = 6, upTo = null, maxCandidates = 8 } = opts;
    const p = bot.entity.position;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const topY = Number.isFinite(upTo) ? Math.floor(upTo) : fy + 8;

    if (!Number.isFinite(target?.x) || !Number.isFinite(target?.z)) {
        return { ok: false, code: 'NO_TARGET', why: '目标水平位置无效' };
    }

    const out = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            if (dx === 0 && dz === 0) continue;
            const cx = fx + dx, cz = fz + dz;

            // 1) 逐格看这一列的 [她脚下, topY] 有没有液体
            let wet = false, hasFloor = false, unknown = false;
            const floorB = at(bot, cx, fy - 1, cz);
            if (!floorB) { unknown = true; }
            else if (!AIRISH.has(floorB.name) && !LIQUID.test(floorB.name)) hasFloor = true;

            if (unknown) continue;
            for (let y = fy; y <= topY; y++) {
                const b = at(bot, cx, y, cz);
                if (!b) { unknown = true; break; }
                if (LIQUID.test(b.name)) { wet = true; break; }
            }
            if (unknown || wet || !hasFloor) continue;

            // 2) 打分：离目标越近越好（水平距离），离自己越近越好
            const dToTarget = Math.hypot(cx - target.x, cz - target.z);
            const dToMe = Math.hypot(dx, dz);
            const score = dToTarget + dToMe * 0.5;
            out.push({ x: cx, z: cz, score, dToTarget, dToMe });
        }
    }

    if (!out.length) {
        return { ok: false, code: 'NO_REACH', why: `${radius} 格内没有干燥的可爬列（到处都是水）` };
    }
    out.sort((a, b) => a.score - b.score);
    return { ok: true, candidates: out.slice(0, maxCandidates) };
}
