/**
 * A2 移动：moveTo / stopMove / lookAt。
 *
 * 设计要点：
 * - 一次尝试，不重试（重试属于策略层）。
 * - 不挖玩家建筑：canDig 默认 false、不叠柱子。
 * - 每 100ms 检查 interrupt_code，玩家说停必须真停。
 */
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { ok, fail, normalizeTarget } from './atom_contract.js';
import { scaffoldBlockIds } from './scaffold_blocks.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 坐标是否有效。
 *
 * 为什么需要：服务端发来异常位置包（或被踢前一刻）时，`bot.entity.position`
 * 会变成 NaN。NaN 一旦进 `Math.hypot` 就会污染 advanced / 距离 / 日志，
 * 表现为「只前进 NaN 格」「posXZ: {x: null}」这类看不懂的结果。
 * 原子层必须拦住它，不许把 NaN 传出去。
 */
function isFinitePos(p) {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

export function makeMovements(bot, { canDig = false, scaffold = false, allowVineClimb = false } = {}) {
    const m = new pf.Movements(bot);
    m.canDig = canDig;                    // 不许为走路挖穿建筑
    m.allow1by1towers = scaffold;         // 允许向上叠柱子（跨沟/上坎）
    // ★ 2026-10-27：3 → 2。
    // 原来是 3，意思是"往下跳 3 格以内都允许"。实测后果：她为了抄近路往下跳，
    // 掉进 12 格深的洞穴（y=42），头顶 20 格实心岩石，最后靠 skill_escape 挖了半小时才出来。
    // 用户的判断：掉进洞里本身就是规划问题，错误的容忍度要低。
    // 降到 2 之后，超过 2 格的落差一律当成"要绕"，不再主动往下跳。
    m.maxDropDown = 2;
    m.canOpenDoors = true;
    m.dontMineUnderFallingBlock = true;
    m.dontCreateFlow = true;
    // digCost：挖一格等于多走几格的代价。
    //
    // 历史（两条实测，都别丢）：
    //   设 10 → pathfinder 反复评估"挖还是绕"，40 格路直接超时（0/2）
    //   设 1  → 搜索不再空转（2/2，15 秒），**但挖穿比绕路还便宜**，
    //           于是她会主动挖隧道、往地下挖 —— 这就是她掉进洞里出不来的根源。
    // 现在取 5：仍然比"超时"便宜得多（不会让 40 格路空转），
    // 但已经不划算"为了抄近路挖穿山体"。真的走不通时 canDig 还是能用。
    m.digCost = 5;
    // placeCost 保持 1：垫方块是"救命手段"（跨沟、上坎、自救），不该被罚得太贵，
    // 否则她宁可绕远路也不肯垫一块，反而更容易被困住。
    m.placeCost = 1;

    // 游泳：实测 pathfinder 本来就会游（20 格水面 14 秒，4 种配置全过），
    // 但 liquidCost 太高会把它当禁区。Baritone 的 maxWaterDist=256 也是这个思路：
    // 水能过，只是不优先。
    m.liquidCost = 2;

    // 允许冲刺（Baritone 默认 allowSprinting=true，明显更快）
    m.allowSprinting = true;

    // 跨空隙（3 格内的坑能跳过去）。
    // pathfinder 默认就是 true，显式写下来是防止以后被误改成 false ——
    // 这项能力不会报错，只会静默失效，很难发现。
    m.allowParkour = true;

    // 垫脚方块清单：必须按背包里**真实有**的方块来建（2026-10-26 修）。
    //
    // 之前的 bug：这里从不设置 scafoldingBlocks，于是用 pathfinder 默认的
    // [dirt, cobblestone]。而她背包里常见的是木板/原木 —— 不在清单里就等于"没材料"。
    // pathfinder 拿 countScaffoldingItems() 当 A* 的 remainingBlocks 上限
    // （movements.js:346/352/403，remainingBlocks===0 就不许搭），
    // 所以「明明带着木板却搭不了」会让她白白绕开本可以搭过去的地形。
    // skills.js 的 buildMovements 早就按背包实际方块建清单了，这套（path_short/hopTo 走的）
    // 一直漏着 —— 又是「同一件事两个真相」。
    if (scaffold) {
        const ids = scaffoldBlockIds(bot);
        if (ids.length) {
            m.scafoldingBlocks = ids;
        } else {
            // 一个能放的都没有：关掉搭桥，免得 A* 把 placeCost 算进启发式里空转
            m.allow1by1towers = false;
            m.scafoldingBlocks = [];
        }
    }

    // 爬梯子 / 爬藤蔓：**按意图区分**（用户判断 2026-10-25）。
    //
    // 用户原话：
    //   「藤蔓也可以爬呀，要爬的时候当梯子，不爬的时候当空气不就行了？」
    //   「不允许爬藤蔓肯定是不行的，应该是移动规划有问题……
    //     很明显是技能作者把梯子和藤曼的逻辑搞一起了导致碰到藤曼就触发攀爬」
    //
    // 问题有两层，都要按意图处理：
    //   1) **物理层**（prismarine-physics）：`isOnLadder()` 把 ladder 和 vine 当同一种，
    //      触发条件是 `isCollidedHorizontally || jump` —— 路过时横向蹭到树叶就被抬起来。
    //      → 由 `src/sim/vine_physics.js` 按意图处理（走路=空气 / 要爬=梯子）。
    //   2) **规划层**（pathfinder）：默认把 vine 放进 climbables（movements.js:70），
    //      于是它会**主动规划"爬藤蔓"这条路线**。
    //      → 这里按同一个意图开关决定：不爬时把 vine 移出 climbables。
    //
    // 梯子永远保留：梯子是人放的、用来上下，不存在"路过被顶上去"的问题。
    // 意图来源有两处：调用方显式传参，或 bot 上挂的 vinePhysics 开关。
    const wantVineClimb = allowVineClimb === true
        || bot?.vinePhysics?.isClimbing?.() === true;
    if (!wantVineClimb) {
        for (const name of [
            'vine', 'weeping_vines', 'weeping_vines_plant',
            'twisting_vines', 'twisting_vines_plant',
            'cave_vines', 'cave_vines_plant',
        ]) {
            const def = bot.registry?.blocksByName?.[name];
            if (def) m.climbables.delete(def.id);
        }
    }

    return m;
}

/**
 * 走路用的判据常量（2026-10-26 改：从「时间」改成「进展」）。
 *
 * 之前的做法是给每一段算一个时间预算（dist / 估算速度），到点就判超时。
 * 这是错的：估算速度是拍的，地形一变就不准；而且她明明一直在前进，
 * 只因为"慢了"就被打断、切半、重走 —— 实测 115 格按 45 秒预算必然踩线，
 * 上层还把它误报成「我找不到你」（task_follow 的老文案）。
 *
 * 现在的主判据是**有没有在靠近**：
 *   连续 STALL_MS 毫秒，距目标的最好记录没有改善 STALL_DIST 格 → 判定卡住
 * 时间只作为兜底（防止真的死循环），不是主判据。
 *
 * ★ 2026-10-26 又补一个坑（实测踩到）：**思考时间不能算卡住**。
 *   pathfinder 在复杂地形（洞穴、断崖）里算路是要花时间的，而它的 thinkTimeout
 *   默认就是 5000ms。第一版 STALL_MS 也设 5000，于是"她还在算路"就被判"卡住"了 ——
 *   越难的地形越算不完、越早被判死。
 *   真机证据：她在 y=42 的洞里、背包 571 个方块、挖+搭全开，仍然一步不动。
 *   现在：开头 STALL_GRACE_MS 内不判卡住，并且显式把 pathfinder 的思考预算调大。
 */
/** pathfinder 单次搜索预算（默认 5000，复杂地形不够）。 */
export const THINK_TIMEOUT_MS = 15000;

/**
 * 连续多久没靠近就算卡住。
 *
 * ★ 2026-10-28 修：5000 → THINK_TIMEOUT_MS + 5000 = 20000。
 *
 * 实测（真机）：她走到第 4 轮时重新算路，pathfinder 还在搜索（预算 15000ms），
 * 但 STALL_MS 只有 5000 → 5 秒就判「STUCK 连续 5 秒没靠近（还差 0.7 格）」，
 * 而那 0.7 格其实再等几秒就能到。
 *
 * 这是个硬性约束：**判断"卡住"的最短时间不能小于"算一次路的最长时间"**，
 * 否则每次重算路都会被误判成卡住 —— 越难的地形越走不动。
 * 现在 = 思考预算 + 5 秒余量。
 */
export const STALL_MS = THINK_TIMEOUT_MS + 5000;

export const STALL_DIST = 1.0;       // 靠近多少格才算"有进展"
export const FALLBACK_TIMEOUT = 300000;   // 5 分钟兜底：正常情况下永远走不到这里
export const STALL_GRACE_MS = 15000;      // 起步宽限：这段时间内不判卡住（留给 pathfinder 算路）

/**
 * 是否已经卡住（纯函数，方便单测）。
 * @param {number} bestDist 历史最好（最小）距离
 * @param {number} bestAt   刷新最好成绩的时间戳
 * @param {number} now      当前时间戳
 * @param {{stallMs?:number, stallDist?:number, startedAt?:number, graceMs?:number}} opts
 */
export function isStalled(bestDist, bestAt, now, opts = {}) {
    const stallMs = opts.stallMs ?? STALL_MS;
    // 起步宽限：刚开始的那段可能只是"还没算完路"，不算卡住
    if (Number.isFinite(opts.startedAt)) {
        const graceMs = opts.graceMs ?? STALL_GRACE_MS;
        if (now - opts.startedAt < graceMs) return false;
    }
    return (now - bestAt) >= stallMs;
}

/**
 * 走到 (x,y,z)，停在 tol 格内。
 * @returns ActionResult，data: { distFeetToPoint, costMs }
 */
export async function moveTo(bot, target, opts = {}) {
    const { tol = 1, timeout = FALLBACK_TIMEOUT, canDig = false, scaffold = false,
        stallMs = STALL_MS, stallDist = STALL_DIST } = opts;
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    // 目标归一化（原子接口标准 §2.3）：新写法 {kind:'point', pos} 与旧写法 {x,y,z} 都收
    const t = normalizeTarget(target);
    if (!t || (!t.pos && !t.posXZ)) {
        return fail('NO_TARGET', '目标位置无效');
    }
    // 只给了 x/z 时，用自己当前高度（等价于原来的 GoalNearXZ 行为）
    const x = t.pos ? t.pos.x : t.posXZ.x;
    const z = t.pos ? t.pos.z : t.posXZ.z;
    const y = t.pos ? t.pos.y : Math.floor(bot.entity?.position?.y ?? 0);
    const pos = { x, y, z };

    const t0 = Date.now();
    // 位置守卫（同 moveToXZ）：NaN 会污染 advanced / 距离 / 日志
    if (!isFinitePos(bot.entity?.position)) {
        return fail('INTERNAL', '自己的坐标无效（NaN），拒绝移动', { pos: { x, y, z } });
    }
    // partial path 的基准：出发时离目标多远。超时/失败时用它判断「有没有白跑」。
    const goalVec = new Vec3(x, y, z);
    const startDist = bot.entity.position.distanceTo(goalVec);
    bot.pathfinder.setMovements(makeMovements(bot, { canDig, scaffold }));
    // 思考预算：默认 5000ms 对「从洞穴里找出口」这类搜索不够，
    // 会在算完之前抛 "Took to long to decide path"，然后被当成 NO_PATH。
    try { bot.pathfinder.thinkTimeout = THINK_TIMEOUT_MS; } catch { /* 老版本没这个字段 */ }

    let err = null, settled = false;
    // 不 await 这个 promise，改成轮询，这样超时和中断都能立刻生效。
    bot.pathfinder.goto(new pf.goals.GoalNear(x, y, z, tol))
        .then(() => { settled = true; })
        .catch((e) => { err = e; settled = true; });

    // 走了一段：算推进量。判断标准是「确实更靠近了」而不是「走了多久」。
    // 借鉴 Baritone 的 partial path：搜索受限时返回「能到的最好位置」，
    // 让上层从那里继续重规划，而不是整段作废。
    const progress = () => {
        const now = bot.entity.position.distanceTo(goalVec);
        return { now, advanced: startDist - now, startDist };
    };

    // 卡住判定的状态：历史最好（最小）距离，以及它最后一次被刷新的时间
    let bestDist = startDist;
    let bestAt = t0;

    while (!settled) {
        if (bot.interrupt_code) {
            try { bot.pathfinder.stop(); } catch { /* ignore */ }
            return fail('INTERRUPTED', '你让我停下', { pos: { x, y, z } });
        }

        // 主判据：有没有在靠近。一直在动就一直走，不管花多久。
        const cur = progress();
        if (cur.now < bestDist - stallDist) {
            bestDist = cur.now;
            bestAt = Date.now();
        } else if (isStalled(bestDist, bestAt, Date.now(), { stallMs, startedAt: t0 })) {
            try { bot.pathfinder.stop(); } catch { /* ignore */ }
            const p = progress();
            return fail('STUCK', `连续 ${Math.round(stallMs / 1000)} 秒没靠近（还差 ${p.now.toFixed(1)} 格）`,
                { pos: { x, y, z }, distFeetToPoint: p.now, advanced: p.advanced, ...landingReport(bot) });
        }

        // 兜底：防止真的死循环。正常情况下进展判定会先命中。
        if (Date.now() - t0 > timeout) {
            try { bot.pathfinder.stop(); } catch { /* ignore */ }
            const p = progress();
            // ★ 2026-11-01：失败返回也要带落脚状态。
            // 契约（tools/atom_move_landing.mjs 的断言）是"任何返回都要能看出她停在哪、站稳没有"，
            // 但原来只有 STUCK 分支 `...landingReport(bot)`，TIMEOUT / INTERRUPTED 分支漏了 →
            // 调用方拿到 TIMEOUT 时 standable=undefined，判断不了"该补垫脚还是该换路"。
            return fail('TIMEOUT', `走了 ${Math.round((Date.now() - t0) / 1000)} 秒还没到（只前进 ${p.advanced.toFixed(1)} 格）`,
                { pos: { x, y, z }, distFeetToPoint: p.now, advanced: p.advanced, ...landingReport(bot) });
        }
        await sleep(100);
    }

    if (bot.interrupt_code) {
        return fail('INTERRUPTED', '你让我停下', { pos: { x, y, z }, ...landingReport(bot) });
    }

    if (err) {
        const msg = String(err?.message ?? err);
        const p = progress();
        // 同样的 partial 逻辑：失败但已经推进了，也算部分成功
        if (p.advanced >= 3) {
            return ok({ pos: { x, y, z }, partial: true, distFeetToPoint: p.now, advanced: p.advanced,
                costMs: Date.now() - t0, note: `失败(${msg.slice(0, 40)})但在推进`, ...landingReport(bot) });
        }
        if (/nopath|no path|unreachable/i.test(msg)) {
            return fail('NO_PATH', '没有可走的路', { pos: { x, y, z }, costMs: Date.now() - t0 });
        }
        // `Took to long to decide path to goal!` 是 pathfinder 的搜索超时。
        // 本质就是"找不到路"，不是内部错误 —— 之前归成 INTERNAL，
        // 导致上层无法据此降级（2026-10-25 实测：真实丛林里 step1 就报这个，
        // 然后站在原地挖 6.9 格外的方块，全部 OUT_OF_REACH）。
        if (/took to long to decide path|took too long/i.test(msg)) {
            return fail('NO_PATH', '寻路搜索超时（找不到可行路径）', {
                pos: { x, y, z }, costMs: Date.now() - t0, ...landingReport(bot),
            });
        }
        if (/goalchanged|goal changed/i.test(msg)) {
            return fail('BLOCKED', '目标被别的动作改掉了', { pos: { x, y, z } });
        }
        return fail('INTERNAL', msg, { error: msg, pos: { x, y, z } });
    }

    const center = new Vec3(x + 0.5, y + 0.5, z + 0.5);
    const dist = bot.entity.position.distanceTo(center);
    // 出口守卫：坐标变 NaN 时 dist 也是 NaN，而 `NaN > tol + 0.6` 是 false，
    // 会静默判成「到了」——这比报错危险得多（实测：不可达的目标返回 ok）。
    if (!Number.isFinite(dist)) {
        return fail('INTERNAL', '到达判定失败：自己的坐标出现 NaN', { pos: { x, y, z } });
    }
    if (dist > tol + 0.6) {
        return fail('NO_PATH', `停在 ${dist.toFixed(1)} 格外`,
            { pos: { x, y, z }, distFeetToPoint: dist, costMs: Date.now() - t0, ...landingReport(bot) });
    }
    return ok({ pos: { x, y, z }, distFeetToPoint: dist, costMs: Date.now() - t0, ...landingReport(bot) });
}

/**
 * 报告"我最后停在哪、是不是站稳了"。
 *
 * 为什么必须有（用户判断 2026-10-25：「原子技能不够干净」）：
 *   原来的 moveTo 只返回距离，调用方拿到 ok 就以为"到位且站着"。
 *   实测后果：collectDrops 里 moveTo 之后 bot 停在 y=-50（地面 -60），
 *   接着 digBlock 报「现在悬空」—— 而 moveTo 自己说 OK。
 *
 * 为什么不直接信 `bot.entity.onGround`：
 *   交接文档记过，外部瞬移后这个标志会卡在 false（也可能误为 true）。
 *   所以同时给出两个：`onGround`（自报）和 `standable`（按脚下方块判）。
 */
function landingReport(bot) {
    const p = bot.entity?.position;
    if (!isFinitePos(p)) {
        return { landedAt: null, onGround: null, standable: false, groundBlock: null };
    }
    const landedAt = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    let groundBlock = null;
    try {
        const b = bot.blockAt?.(new Vec3(landedAt.x, landedAt.y - 1, landedAt.z), false);
        groundBlock = b?.name ?? null;
    } catch { /* 区块没加载就不知道脚下是什么 */ }
    const solid = !!groundBlock && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(groundBlock);
    return {
        landedAt,
        onGround: bot.entity?.onGround ?? null,
        standable: solid,
        groundBlock,
    };
}

/**
 * 走到某个 x/z（不管 y）。
 *
 * 为什么需要：跳格移动时，粗规划只知道「去哪个格」，格内真实地面高度
 * 常常和区块平均高度差 1~2 格。硬给一个 y 会让 pathfinder 判定「到不了」
 * （实测：y 高 1 格就 NO_PATH，y 对了就 OK）。
 * GoalNearXZ 让 pathfinder 自己找落脚高度，这才是「粗规划 + 细规划」的正确分工。
 */
export async function moveToXZ(bot, target, opts = {}) {
    const { tol = 2, timeout = FALLBACK_TIMEOUT, canDig = false, scaffold = false,
        stallMs = STALL_MS, stallDist = STALL_DIST } = opts;
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const t = normalizeTarget(target);
    if (!t || (!t.pos && !t.posXZ)) return fail('NO_TARGET', '目标位置无效');
    const x = t.pos ? t.pos.x : t.posXZ.x;
    const z = t.pos ? t.pos.z : t.posXZ.z;

    const t0 = Date.now();
    // 位置守卫：服务端位置包异常时 bot.entity.position 会变成 NaN，
    // 不拦住的话 NaN 会一路传进 advanced / posXZ / 日志（实测「只前进 NaN 格」）。
    if (!isFinitePos(bot.entity?.position)) {
        return fail('INTERNAL', '自己的坐标无效（NaN），拒绝移动', { posXZ: null });
    }
    // partial path 基准（同 moveTo）
    const startDist = Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z);
    bot.pathfinder.setMovements(makeMovements(bot, { canDig, scaffold }));
    try { bot.pathfinder.thinkTimeout = THINK_TIMEOUT_MS; } catch { /* 老版本没这个字段 */ }

    let err = null, settled = false;
    // ★ 2026-10-27 修：不能强制最小容差 1。
    //
    // 原来 Math.max(1, tol) 把 tol:0 变成 1 —— 于是"目标就在 1 格内"时
    // pathfinder 立刻认为到达，返回成功但**一步都不走**。
    // 实测就是"规划 18 步 → 位置完全不变"的直接原因之一，
    // 逐格执行（每步 1 格）时这个问题最致命。
    //
    // tol=0 表示"必须站在这一格"，对逐格执行是正确语义。
    // ★ 2026-10-28 修：**不能 Math.floor(tol)**。
    // tol=0.8 被 floor 成 0，等于要求精确到格 —— 与调用方意图相反。
    // GoalNearXZ 的第三个参数是"距离半径"，接受小数，保留原值即可。
    bot.pathfinder.goto(new pf.goals.GoalNearXZ(Math.floor(x), Math.floor(z), Math.max(0, Number(tol) || 0)))
        .then(() => { settled = true; })
        .catch((e) => { err = e; settled = true; });

    const progress = () => {
        const now = Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z);
        return { now, advanced: startDist - now, startDist };
    };
    // 卡住判定的状态（同 moveTo）
    let bestDist = startDist;
    let bestAt = t0;
    const partialOk = () => {
        const p = progress();
        if (p.advanced >= 3) {
            return ok({ posXZ: { x, z }, partial: true, distFeetToPoint: p.now, advanced: p.advanced,
                costMs: Date.now() - t0, note: '在推进' });
        }
        return null;
    };

    while (!settled) {
        if (bot.interrupt_code) {
            try { bot.pathfinder.stop(); } catch { /* ignore */ }
            return fail('INTERRUPTED', '你让我停下', { posXZ: { x, z } });
        }

        // 主判据：有没有在靠近。一直在动就一直走，不管花多久。
        const cur = progress();
        if (cur.now < bestDist - stallDist) {
            bestDist = cur.now;
            bestAt = Date.now();
        } else if (isStalled(bestDist, bestAt, Date.now(), { stallMs, startedAt: t0 })) {
            try { bot.pathfinder.stop(); } catch { /* ignore */ }
            const p = progress();
            return fail('STUCK', `连续 ${Math.round(stallMs / 1000)} 秒没靠近（还差 ${p.now.toFixed(1)} 格）`,
                { posXZ: { x, z }, distFeetToPoint: p.now, advanced: p.advanced, ...landingReport(bot) });
        }

        // 兜底：防止真的死循环。正常情况下进展判定会先命中。
        if (Date.now() - t0 > timeout) {
            try { bot.pathfinder.stop(); } catch { /* ignore */ }
            const p = partialOk();
            if (p) return p;
            return fail('TIMEOUT', `走了 ${Math.round((Date.now() - t0) / 1000)} 秒还没到`,
                { posXZ: { x, z }, ...landingReport(bot) });
        }
        await sleep(100);
    }

    if (err) {
        const msg = String(err?.message ?? err);
        const p = partialOk();
        if (p) return p;
        if (/nopath|no path|unreachable/i.test(msg)) return fail('NO_PATH', '没有可走的路', { posXZ: { x, z }, ...landingReport(bot) });
        if (/goalchanged|goal changed/i.test(msg)) return fail('BLOCKED', '目标被别的动作改掉了', { posXZ: { x, z }, ...landingReport(bot) });
        return fail('INTERNAL', msg, { error: msg, posXZ: { x, z }, ...landingReport(bot) });
    }

    const dx = bot.entity.position.x - x;
    const dz = bot.entity.position.z - z;
    const dist = Math.hypot(dx, dz);
    // 出口守卫（同 moveTo）：NaN 会让「是否到达」静默通过
    if (!Number.isFinite(dist)) {
        return fail('INTERNAL', '到达判定失败：自己的坐标出现 NaN', { posXZ: { x, z } });
    }

    // 到达校验：说到了，还要核对实际距离。
    //
    // pathfinder 的 goto() 会正常 resolve（它认为算出了到 GoalNearXZ 的路线），
    // 但**她的物理位置可能没跟上去**（服务端位置滞后 / 半身卡在方块里）。
    // 而成功分支如果把 ok 直接返回，上层就会看到"每一步都 ok、位置却不变"，
    // 于是反复重规划、永不推进。
    // 实测现场：目标 (-132,-219)，她实际 (-134.5,-218.6)，差 2.5 格却报 ok。
    //
    // 但阈值不能太严：pathfinder 走到 GoalNearXZ 附近后，若目标格被相邻方块
    // 部分遮挡，会停在 2~3 格外，这是**正常停靠精度**（核对过那些点是正常平地）。
    // 所以只抓"差一个身位以上、且完全没动"这一种真卡死。
    const moved = startDist - dist;
    if (dist > 4 && moved < 0.5) {
        return fail('STUCK', `说到了但实际还差 ${dist.toFixed(1)} 格且完全没动（目标 ${Math.floor(x)},${Math.floor(z)}）`,
            { posXZ: { x, z }, distFeetToPoint: dist, advanced: moved, costMs: Date.now() - t0 });
    }
    return ok({ posXZ: { x, z }, distFeetToPoint: dist, costMs: Date.now() - t0 });
}

/**
 * 分两档走到 x/z：先「不破坏」，失败再「允许挖 + 搭」。
 *
 * 借鉴 Baritone 的 break/place Move：真人遇到挡路的会挖、遇到沟会垫。
 * 但放开挖/搭会让搜索空间暴涨（pathfinder 要试每一种可挖方块），
 * 所以只当第一档失败时才启用第二档。
 *
 * @returns ActionResult，data.tier 记录用了哪一档
 */
export async function moveToXZEx(bot, target, opts = {}) {
    const { tol = 2, timeout = 20000, tryBreak = true } = opts;

    const a = await moveToXZ(bot, target, { tol, timeout, canDig: false, scaffold: false });
    if (a.ok) return { ...a, data: { ...a.data, tier: 'walk' } };
    if (a.code === 'INTERRUPTED') return a;

    // 第一档失败但已经在推进：先接受，别为了挖而回退
    if (a.data?.partial && (a.data.advanced ?? 0) >= 8) {
        return { ...a, data: { ...a.data, tier: 'walk-partial' } };
    }
    if (!tryBreak) return a;

    // 第二档：允许挖 + 搭（能不能挖得动由工具决定，pathfinder 自己判断）
    const b = await moveToXZ(bot, target, { tol, timeout, canDig: true, scaffold: true });
    if (b.ok) return { ...b, data: { ...b.data, tier: 'break' } };
    return { ...b, data: { ...b.data, tier: 'break-failed', first: a.code } };
}

/** 立刻停下：清目标 + 清控制键。 */
export async function stopMove(bot) {
    try {
        bot.pathfinder.setGoal(null);
        bot.pathfinder.stop();
    } catch { /* ignore */ }
    try { bot.clearControlStates(); } catch { /* ignore */ }
    await sleep(300);
    return ok({ pos: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } });
}

// ★ 2026-11-01（t6）：这里原有一个 lookAt，与 atom_look.lookAt 是**同一能力的第二份实现**
//   （本文件那份只看坐标、不做 yaw/pitch 后置校验）。转头属于鼠标输入，唯一出口是
//   `atom_input_mouse`（lookAt 转出 atom_look / lookAtPoint 一次性转头），所以删掉这份。
//   原调用方只有两个测试脚本，已改调 atom_input_mouse.lookAtPoint。
