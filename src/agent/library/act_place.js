/**
 * A4 放置：placeBlockAt。
 *
 * 与旧 placeBlock 的区别（都是踩过的坑）：
 * - 绝不拆已有方块：目标被占就报 OCCUPIED，让它换地方
 * - 不往自己身上放
 * - 放完复核方块真的变了（幽灵方块）
 * - 支撑面按「下 → 四侧 → 上」优先，且不依附箱子/门/床这类可交互方块
 */
import Vec3 from 'vec3';
import { ok, fail, normalizeTarget } from './contract.js';
import { blockAt, canReach, reachDistanceTo } from './query_perceive.js';
import { findItem } from './act_items.js';
import { waitUntil } from './atom_wait.js';
import { lookAtPoint, placeAgainst } from './atom_input_mouse.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const REPLACEABLE = new Set([
    'air', 'cave_air', 'void_air', 'water', 'lava',
    'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
    'snow', 'vine', 'seagrass', 'tall_seagrass',
]);

// 这些方块能放东西上去，但放上去会怪/会坏（箱子打不开、门挡住）
const NO_PLACE_ON = /chest|door|bed|sign|banner|button|lever|trapdoor|fence_gate|anvil|bell|brewing_stand|enchanting_table/;

const FACES = [
    { d: [0, -1, 0], face: [0, 1, 0], name: 'bottom' },   // 放在下面方块上
    { d: [0, 0, -1], face: [0, 0, 1], name: 'north' },
    { d: [0, 0, 1], face: [0, 0, -1], name: 'south' },
    { d: [-1, 0, 0], face: [1, 0, 0], name: 'west' },
    { d: [1, 0, 0], face: [-1, 0, 0], name: 'east' },
    { d: [0, 1, 0], face: [0, -1, 0], name: 'top' },
];

function floorPos(pos) {
    return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
}

export { REPLACEABLE };

/**
 * 在 pos 放一个 item 方块。
 * @returns ActionResult，data: { block, pos, support, existed? }
 */
export async function placeBlockAt(bot, pos, item, opts = {}) {
    const { maxReach = 4.3, verifyMs = 900 } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');
    // 归一化必须在 floorPos 之前：否则 v 拿到的是 {kind,pos} 对象而不是坐标
    const _t = normalizeTarget(pos);
    if (!_t || !_t.pos) return fail('NO_TARGET', '目标位置无效');
    pos = _t.pos;
    const v = floorPos(pos);

    const target = blockAt(bot, v);
    if (!target) {
        // ★★ 2026-11-03（用户查出）：这里原来报 `NO_TARGET`，**码用错了**。
        //
        //   `blockAt` = `bot.blockAt(v, false) ?? null`，而 `bot.blockAt` **只在那个 chunk
        //   没加载时**才返回 null（方块是空气时返回 air 对象，不是 null）。
        //   所以这情况的真相是"**那块还没加载**"，不是"你给的位置不对"。
        //   而 CODES 里**本来就有** `NO_DATA`（第 22 条：目标格未加载，读不到方块）。
        //
        //   两个码对上层的意思完全不同：
        //     NO_TARGET → "位置不对" → 上层会去**改坐标**（越改越远）
        //     NO_DATA   → "还没加载" → 上层会**走近/等它加载**再试
        //   用错就会把上层引到错误的处置上（和 OCCUPIED→BLOCKED 那次同一类）。
        //
        //   注：`force` 试加载由调用方通过 `opts.force` 选择（见下），不在这里偷偷改行为。
        if (opts.force) {
            try {
                const forced = bot.blockAt?.(new Vec3(v.x, v.y, v.z), true);      // true = 尝试加载
                if (forced) {
                    // 加载出来了 → 继续往下走（把 target 当成它）
                    return await placeBlockAt(bot, { kind: 'block', pos: { x: v.x, y: v.y, z: v.z } }, item, { ...opts, force: false });
                }
            } catch { /* 加载失败就按 NO_DATA 如实报 */ }
        }
        return fail('NO_DATA', '那个位置还没加载，读不到方块（走近一点或稍后再试）', {
            pos: { x: v.x, y: v.y, z: v.z },
            reason: 'unloaded',
            // 诊断三件套（用户要求）：force 能不能拿到 + chunk 列在不在
            forceLoaded: (() => { try { return !!bot.blockAt?.(new Vec3(v.x, v.y, v.z), true); } catch { return null; } })(),
            hasColumn: (() => { try { return !!bot.world?.getColumnAt?.(new Vec3(v.x, v.y, v.z)); } catch { return null; } })(),
            botFeet: bot.entity?.position
                ? { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) }
                : null,
        });
    }
    // 幂等分支：字段集必须和正常成功路径一致（support 也要给），
    // 否则上层用同一个读取路径会拿到 undefined（实测测试就挂在"返回 support"这条）
    if (target.name === item) {
        return ok({
            existed: true,
            placedBlock: item,
            pos: { x: v.x, y: v.y, z: v.z },
            support: target.name,
        });
    }
    if (!REPLACEABLE.has(target.name)) {
        return fail('OCCUPIED', `那里已经是 ${target.name} 了`, { occupiedBy: target.name, pos: { x: v.x, y: v.y, z: v.z } });
    }

    const itemStack = findItem(bot, item);
    if (!itemStack) return fail('NO_ITEM', `背包里没有 ${item}`);

    // 不往自己脚下/头上放
    //
    // ★ 2026-11-03（用户要求）：这里原来报 `OCCUPIED`，而 `OCCUPIED` 在别处意味着
    //   "那块被**别的方块**占了"，上层会去 digBlock 然后重试 —— 但"我自己站在那儿"
    //   靠挖是解决不了的，正确做法是**换个站位**。
    //   所以改成 `BLOCKED` + `data.reason='own-body-column'`：
    //     BLOCKED 的语义就是"现在做不了，换个办法"，正是"换个站位"。
    const feet = floorPos(bot.entity.position);
    if (v.x === feet.x && v.z === feet.z && (v.y === feet.y || v.y === feet.y + 1)) {
        return fail('BLOCKED', '我就站在那儿，放不了（换个站位再放）', {
            pos: { x: v.x, y: v.y, z: v.z },
            reason: 'own-body-column',
        });
    }

    // 选支撑面（必须在距离判定之前：目标格是空气，raycast 看不见空气，
    // 所以「能否看见目标格」这条判据对放置不成立——要看支撑面）
    let support = null;
    let faceVec = null;
    let supportName = null;
    for (const f of FACES) {
        const rp = v.offset(f.d[0], f.d[1], f.d[2]);
        const b = blockAt(bot, rp);
        if (!b || REPLACEABLE.has(b.name)) continue;
        if (NO_PLACE_ON.test(b.name)) continue;
        support = b;
        faceVec = new Vec3(f.face[0], f.face[1], f.face[2]);
        supportName = b.name;
        break;
    }
    if (!support) {
        return fail('NO_SUPPORT', '周围没有能依附的方块', { pos: { x: v.x, y: v.y, z: v.z } });
    }

    const dist = reachDistanceTo(bot, v);
    if (dist > maxReach + 1) {
        return fail('OUT_OF_REACH', `够不着，眼睛到目标 ${dist.toFixed(1)} 格`, { distEyeToBlock: dist });
    }
    // 注意：这里不查「能否看见支撑面」。canReach 的 raycast 是从眼到方块中心，
    // 对脚下/身侧这种大角度目标经常误判（实测 3.1 格就判看不见）。
    // 放置只需要距离够 —— 真正的判据是放完复核方块变没变。

    let placeErr = null;
    try {
        await bot.equip(itemStack, 'hand');
        // 转准星（一次输入，不校验）+ 放置（一次输入）都交给 atom_input_mouse。
        // 分类判据保持原样：把里面的失败消息**原样抛出去**，下面的 catch 照旧按
        // `blockUpdate` / `entity|occupied|collide` 分流，行为与改前逐字一致。
        const looked = await lookAtPoint(bot, support.position.offset(0.5, 0.5, 0.5), { force: true });
        if (!looked.ok) throw new Error(looked.message);
        const pr = await placeAgainst(bot, support, faceVec);
        if (!pr.ok) {
            if (pr.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            throw new Error(pr.message);
        }
    } catch (e) {
        // placeBlock 有时在成功的情况下也会抛（实体挡了一下），先记下来，靠复核定性
        placeErr = e;
    }

    // ★ 2026-11-01（D21）：等方块出现的循环放回 `atom_wait.waitUntil` 并把 bot 传进去——
    // 原来的 waitForBlock 自己 while+sleep，**不查 interrupt_code**，取消后还要空等 900ms。
    const placedRes = await waitUntil(() => {
        const b = blockAt(bot, v);
        return (b && b.name === item) ? true : undefined;
    }, { timeoutMs: verifyMs, intervalMs: 80, bot });
    if (placedRes.ok) {
        return ok({ placedBlock: item, pos: { x: v.x, y: v.y, z: v.z }, support: supportName });
    }
    if (placedRes.code === 'INTERRUPTED') {
        return fail('INTERRUPTED', '被取消了', { pos: { x: v.x, y: v.y, z: v.z } });
    }

    if (placeErr) {
        const msg = String(placeErr?.message ?? placeErr);
        // 客户端等 blockUpdate 超时：可能是真没放上，也可能只是这个包丢了（已知竞态）。
        // 先再读一次方块，读到了就算成功；没读到就报可重试的 BLOCKED，不判死。
        if (/blockUpdate|did not fire within timeout/i.test(msg)) {
            const late = blockAt(bot, v);
            if (late?.name === item) {
                return ok({ placedBlock: item, pos: { x: v.x, y: v.y, z: v.z }, support: supportName, lateUpdate: true });
            }
            return fail('BLOCKED', '客户端没收到方块更新（可能丢包），可以重试', { error: msg });
        }
        if (/entity|occupied|collide/i.test(msg)) {
            return fail('OCCUPIED', '有东西挡着，放不进去', { error: msg });
        }
        return fail('INTERNAL', msg, { error: msg });
    }

    const now = blockAt(bot, v);
    return fail('TIMEOUT', `放了但没变成 ${item}（现在是 ${now?.name ?? '空'}）`, {
        occupantNow: now?.name ?? null, pos: { x: v.x, y: v.y, z: v.z },
    });
}
