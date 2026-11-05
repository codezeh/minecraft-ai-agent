/**
 * L2 复合技能：采集。
 *
 * 结构（见 复合层改造规划 §2）：
 *   planCollect()  只读世界、不改变世界 → 产出步骤序列，可打印、可 diff
 *   runSteps()     按序列执行，报「第几步/哪个原子/什么码」
 *
 * 与 task_collect.collect 的分工：
 *   task（L3）  负责 deadline、黑名单、换目标、进度汇报
 *   skill（L2） 负责"这一轮怎么砍"：选树 → 排序 → 走 → 挖 → 捡 的序列
 *
 * 为什么 plan 只读世界而不是纯函数：
 *   规划必须知道"附近有什么树"，那必须读世界。但**不改变世界**——
 *   这个区别才是关键：可重复调用、可打印、可单测，不会因为调用一次就少一棵树。
 */
import { surveyTrees } from './collect_planner.js';
// 整树感知：一次扫出整棵树、判断自然树、排砍伐顺序
import { scanTree, judgeTree, planFelling } from './query_tree.js';
import { tunnelStep, findDryClimbColumn } from './atom_tunnel.js';
import { classifyLog, isProtected } from './query_classify.js';
import { protectedPlaces } from './landmarks.js';
import { findStandSpot } from './query_stand.js';
import { blockAt } from './query_perceive.js';
import { digBlock } from './act_dig.js';
import { moveTo } from './nav_pathfinder.js';
import { walkTo } from './executor.js';
// 第9条②：直驱 pathfinder 的调用点要进 nav 闸（只包 withNav，不改流程语义）。
import { withNav } from './nav_core.js';
import { collectDrops } from './flow_pickup.js';
import { query } from './query_target.js';
import { planClearObstacles } from './flow_clear.js';
import { ok, fail } from './contract.js';

/**
 * 规划一轮采集：选目标 → 为每个目标算站位 → 产出「走 / 挖 / 捡」序列。
 *
 * 只读世界。不会移动、不会挖、不会捡。
 *
 * @param {object} bot
 * @param {object} opts
 *   blockNames  目标方块名数组（如 ['oak_log']）
 *   want        要多少个
 *   near        参照点（「砍我旁边的树」时传玩家位置）
 *   maxTargets  最多规划几棵树，默认 8
 *   skip        已拉黑的位置 Set（上层维护）
 *
 * @returns ActionResult
 *   ok → data: { steps, planned, skipped: [{pos, why}] }
 *   NO_TARGET → 附近没有可用目标
 */
export function planCollect(bot, opts = {}) {
    const {
        blockNames = [],
        want = 1,
        near = null,
        maxTargets = 8,
        skip = new Set(),
        onEvent = () => { },   // 诊断用：树体判断/砍伐规划的事件
    } = opts;

    if (!Array.isArray(blockNames) || !blockNames.length) {
        return fail('NO_TARGET', '没说要采集什么方块');
    }

    // 1) 侦察：先摸清附近有什么，别走一步看一步
    let plan;
    try {
        plan = surveyTrees(bot, blockNames, { radius: 48, maxTrees: maxTargets * 3, anchor: near });
    } catch (e) {
        return fail('INTERNAL', `侦察失败：${String(e?.message ?? e)}`);
    }
    if (!plan.trees.length) {
        return fail('NO_TARGET', `附近没有 ${blockNames.join('/')}`);
    }

    const steps = [];
    const skipped = [];
    let stepNo = 0;
    let planned = 0;
    let cleared = 0;      // 清掉了多少处挡路方块（给上层看"是不是在清藤蔓"）

    for (const tree of plan.trees) {
        if (planned >= maxTargets) break;

        // ---- 整树感知（用户设计：确定一根木头后扫整棵树，判断是不是自然树）----
        //
        // 原来是对树里的**每一格**各调一次 classifyLog（每次扫几百格找树冠），
        // 一棵 11 格的树要扫 11 遍。现在从底部那根出发扫一次整棵树，
        // 判断一次是不是自然树，再用 planFelling 排出砍伐顺序。
        const seedPos = tree.bottom;
        const scan = scanTree(bot, seedPos);
        if (!scan.ok) {
            skipped.push({ pos: seedPos, why: `scan:${scan.code}` });
            continue;
        }
        const judge = judgeTree(scan);
        if (!judge.isTree) {
            skipped.push({ pos: seedPos, why: `not-tree:${judge.why}` });
            continue;
        }
        onEvent?.({ type: 'tree-judged', trees: plan?.trees?.length ?? 0, logs: scan.logs.length, why: judge.why });

        // 砍伐顺序：优先用 planFelling 的"从底往上"（能站上树桩逐层推进）；
        // 它算不出可用顺序时退回 surveyTrees 的 order（从上往下）。
        const fell = planFelling(scan, { standY: Math.floor(bot.entity.position.y) });
        const ordered = (fell.ok && fell.order.length)
            ? fell.order.flatMap(layer => layer.logs)
            : tree.order.map(p => ({ x: p.x, y: p.y, z: p.z }));
        if (fell.ok) {
            onEvent?.({ type: 'felling-plan', layers: fell.layers, total: fell.total, reachable: fell.reachableFromGround, why: fell.why });
        }

        // 逐格过闸门（保护判定 + 跳过已挖的）
        // 地标只取一次（加载 + 60s 缓存都在数据层 landmarks.protectedPlaces）
        const guardSpots = protectedPlaces(bot);
        const cells = [];
        for (const pos of ordered) {
            const k = `${pos.x},${pos.y},${pos.z}`;
            if (skip.has(k)) continue;

            const guard = isProtected(pos, { spots: guardSpots });
            if (guard.ok && guard.data.protectedBy) {
                skipped.push({ pos, why: 'protected' });
                continue;
            }

            // 方块可能已经被前面的步骤挖掉了 —— 读一下确认它还是原木
            const b = blockAt(bot, pos);
            if (!b || !/_log$|_stem$/.test(b.name)) {
                skipped.push({ pos, why: 'not-log' });
                continue;
            }
            cells.push(pos);
        }
        if (!cells.length) continue;

        // 关键改动（2026-10-24，效率）：
        //   原来「每格一个 moveTo + 每格一次 collectDrops」，
        //   实测 5 轮里 wait-short 累计 128 次（光"等掉落物"就 50+ 秒）。
        //   现在改成「一棵树走一次（必要时补走）+ 挖完统一捡一次」。
        //
        // 为什么可以少走：digBlock 的判据是眼到方块 ≤5.1 格，
        // 树干通常 3~6 格高、站位在旁边就能覆盖大多数格子。
        let standPos = null;
        // 组号 = 规划序号：同一棵树的 moveTo + digBlock 共用一个组。
        // moveTo 失败时 skipGroup 会把这一组的剩余步骤全部跳过（避免连锁失败）。
        const group = planned + 1;

        for (const pos of cells) {
            // 当前位置够得着就不走；够不着才为这一格找站位
            const reachable = standPos
                // rule:R3-01 挖方块实际可到 6.10 格，客户端侧取 5.1 保守值
                ? distEye(bot, standPos, pos) <= 5.1 - 0.3   // 留 0.3 余量
                : false;

            if (!reachable) {
                const stand = findStandSpot(bot, pos);
                if (!stand.ok) {
                    skipped.push({ pos, why: `no-stand:${stand.code}` });
                    continue;
                }
                standPos = stand.data.pos;
                steps.push({
                    step: ++stepNo,
                    atom: 'moveTo',
                    phase: 'move',
                    args: { target: { kind: 'point', pos: standPos }, opts: { tol: 0, timeout: 8000 } },
                    expect: 'arrived',
                    group,
                    onFail: [
                        { code: 'NO_PATH', action: 'skipGroup' },
                        { code: 'TIMEOUT', action: 'skipGroup' },
                        { code: 'INTERRUPTED', action: 'abort' },
                    ],
                });
            }

            // 挖之前先清挡路的藤蔓/树叶。
            // 用户实测：丛林里树被藤蔓包裹时，她就不砍那棵树了——
            // 因为 bot.dig 需要 lookAt 成功，藤蔓贴在树干表面时视线被挡，
            // 表现为"隔着藤蔓砍空气"，dig 一直失败，最后被当成砍不动跳过。
            const clearPlan = planClearObstacles(bot, pos, { maxClear: 3, group });
            if (clearPlan.ok) {
                for (const cs of clearPlan.steps) {
                    steps.push({ ...cs, step: ++stepNo });
                }
                cleared += clearPlan.steps.length;
            }

            steps.push({
                step: ++stepNo,
                atom: 'digBlock',
                phase: 'dig',
                args: { target: { kind: 'block', pos } },
                expect: 'gone',
                pos,
                group,
                onFail: [
                    { code: 'INTERRUPTED', action: 'abort' },
                    { code: 'OUT_OF_REACH', action: 'next' },
                    { code: 'BLOCKED', action: 'next' },
                    { code: 'TIMEOUT', action: 'next' },
                ],
            });
            planned++;
        }

        // 挖完这棵树再统一捡一次（掉落物以树干位置为参照）
        const origin = cells[cells.length - 1];
        steps.push({
            step: ++stepNo,
            atom: 'collectDrops',
            phase: 'pickup',
            args: { origin },
            expect: 'gained',
            pos: origin,
            onFail: [
                { code: 'INTERRUPTED', action: 'abort' },
                { code: '*', action: 'next' },
            ],
        });

        if (planned >= maxTargets) break;
    }


    if (!steps.length) {
        return fail('NO_TARGET', `附近没有能砍的目标（跳过 ${skipped.length} 处）`, { skipped });
    }

    return ok({
        steps,
        planned,
        cleared,
        trees: plan.trees.length,
        skipped,
        // 供上层判断"这次规划够不够用"
        estimated: planned,
        want,
    });
}

/**
 * 原子的处理器表（给 step_runner 用）。
 *
 * 为什么显式列出来而不是动态 import：
 * 拼错原子名会静默失败，显式表在启动时就能发现漏了。
 */
export function makeHandlers(ctx = {}) {
    const { countFn = () => 0, baseCount, onEvent = () => { }, mapDir = null } = ctx;
    return {
        // 接近目标方块。
        //
        // ★ 2026-10-29 修：**优先走 3D 链路（executor.walkTo），失败再回退旧 moveTo**。
        //
        // 为什么：采集目标常在树上/崖上，高差动辄 9~10 格。
        // 旧 moveTo（原生 pathfinder）爬不上去，实测 `!collectBlocks("木头",4)`
        // 第一步 moveTo(-108,72,-214) 15 秒超时、只走 9.4 格，整条采集卡死。
        // 而 walkTo 会用 3D 库规划出台阶/攀爬/绕行。
        //
        // walkTo 只需要 {x,z}（高度由 3D 数据决定），目标方块的高度它自己会处理；
        // 到了之后 digBlock 有 5.1 格够取距离兜底。
        moveTo: async (bot, args) => {
            const opts = args.opts ?? {};
            if (mapDir) {
                const t = args.target;
                const pos = t?.pos ?? t?.posXZ ?? null;
                if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
                    try {
                        const r = (await withNav(bot, () => walkTo(bot, { x: pos.x, z: pos.z }, {
                            mapDir,
                            arriveTol: 3,
                            deadlineMs: Math.min(opts.timeout ?? 30000, 45000),
                            onEvent,
                        }))) ?? fail('BLOCKED', '导航被别的任务占用（walk3d 这一步没做成）', { retryable: true });
                        if (r.ok) return r;
                        onEvent({ type: 'walk3d-failed', code: r.code });

                        // ★ 2026-10-29 新增：**走不到且目标在高处 → 挖台阶上去（掘进）**。
                        //
                        // 实测场景：那棵丛林树的木头在 y=71~81，她站 y=59，
                        // 高差 12 格 —— walkTo 只能绕/放弃，旧 moveTo 更是爬不上。
                        // 但她能挖：用 atom_tunnel 朝目标方向挖台阶，每步都过安全检查
                        // （安全范围内、脚下有地板、四周无液体）。
                        //
                        // 只在"目标明显比自己高"时才掘进，避免平地也乱挖。
                        const wantY = Number(pos.y);
                        const dyUp = Number.isFinite(wantY) ? wantY - bot.entity.position.y : 0;
                        if (dyUp >= 2) {
                            const tunneled = await climbByTunneling(bot, { x: pos.x, z: pos.z }, {
                                targetY: wantY, mapDir, onEvent,
                            });
                            if (tunneled.ok) return tunneled;
                            onEvent({ type: 'tunnel-failed', code: tunneled.code, why: tunneled.message });
                        }
                    } catch (e) {
                        onEvent({ type: 'walk3d-error', message: String(e?.message ?? e).slice(0, 60) });
                    }
                }
            }
            // 第9条②：最后的兜底 moveTo 也要进闸（这是 plan 层最常用的移动步骤）
            return (await withNav(bot, () => moveTo(bot, args.target, opts)))
                ?? fail('BLOCKED', '导航被别的任务占用（moveTo 这一步没做成）', { retryable: true });
        },
        digBlock: async (bot, args) => digBlock(bot, args.target),
        collectDrops: async (bot, args) => {
            const opts = { countFn, onStep: onEvent };
            // 只有调用方显式给了 baseCount 才传：否则让原子自己快照"本次调用前"的数量。
            // 传任务级基准会导致捡过 1 个之后，后续全部判成功而不再真捡（实测 bug）。
            if (Number.isFinite(baseCount)) opts.baseCount = baseCount;
            return collectDrops(bot, args.origin, opts);
        },
        // 备用：查询（暂时 plan 里没产出这类步骤，但保留扩展点）
        query: async (bot, args) => query(bot, args.target),
    };
}

/**
 * 站在 standPos 时，眼睛到 target 的距离。
 *
 * 用途：判断"同一棵树的下一格还用不用再走"。
 * 换成原子的 reachDistanceTo 不行——那个算的是"当前位置"，这里是"假设站在别处"。
 */
function distEye(bot, standPos, target) {
    // rule:R2-01 玩家眼高 1.62（蹲下 1.27）
    const eyeH = bot.entity?.eyeHeight ?? 1.62;
    return Math.hypot(
        (standPos.x + 0.5) - (target.x + 0.5),
        (standPos.y + eyeH) - (target.y + 0.5),
        (standPos.z + 0.5) - (target.z + 0.5),
    );
}


/**
 * 朝目标方向的前几列是不是干燥的（只读）。
 *
 * 用来决定"要不要先绕路"：正前方就是水的话，直接挖必然 LIQUID_RISK，
 * 不如先找旁边干的一列再爬。
 *
 * @returns {boolean} true = 正前方没液体，可以直接挖
 */
function trialDryAhead(bot, target) {
    const p = bot.entity.position;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const dx = target.x - p.x, dz = target.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    for (let step = 1; step <= 3; step++) {
        const cx = Math.floor(p.x + ux * step);
        const cz = Math.floor(p.z + uz * step);
        for (const y of [fy, fy + 1, fy + 2]) {
            const b = blockAt(bot, { x: cx, y, z: cz });
            if (b && /^(water|lava|bubble_column)$/.test(b.name)) return false;
        }
    }
    return true;
}

/**
 * 挖台阶爬上去（掘进版的"往上走"）。
 *
 * 场景：目标（比如树底那根木头）在自己明显高处，walkTo 走不到。
 * 做法：朝目标水平方向逐步掘进；每步若需要上升，就先挖掉头顶/前方的方块再进。
 *
 * 为什么不用 stepUp（垫方块往上）：
 *   垫方块要求背包里有方块。实测她常常只有一把斧头，
 *   于是 `NO_ITEM 没有可垫脚的方块` 直接卡死。
 *   掘进是**减法**（挖掉挡路的），不需要任何材料。
 *
 * 每一步都调 atom_tunnel.tunnelStep，它自带三道安全检查：
 *   安全范围内 / 脚下有地板 / 四周无液体。
 * 所以这里不需要重复判安全，只负责"朝哪挖、爬到够高没有"。
 *
 * @param {object} bot
 * @param {{x:number, z:number}} dest 目标水平位置
 * @param {{targetY?:number, maxSteps?:number, deadlineMs?:number, onEvent?:Function}} opts
 * @returns {Promise<ActionResult>}
 */
export async function climbByTunneling(bot, dest, opts = {}) {
    const {
        targetY = null, maxSteps = 16, deadlineMs = 45000,
        mapDir = null, onEvent = () => { },
    } = opts;

    const t0 = Date.now();
    let steps = 0, dug = 0;
    const stuckGuard = new Map();   // 方向 -> 连续失败次数

    onEvent({ type: 'tunnel-climb-start', dest, targetY, fromY: bot.entity.position.y });

    // ★ 2026-10-29 新增：**先绕开液体，再爬**。
    //
    // 实测场景：她和水沟这岸隔着 6 格水，对岸才是那棵树。
    // 直接朝目标挖 → `LIQUID_RISK (-91,45,-216) 有 water`（她本身还泡在水坑里），
    // 一步都挖不动。
    //
    // 做法：先找一列"从她脚下到目标高度都干燥、且有地板"的位置，
    // 走过去（walkTo，它本来就会绕水），然后从那里往上挖。
    // 找不到就如实说"周围全是水"。
    {
        const directDry = trialDryAhead(bot, dest);
        if (!directDry) {
            onEvent({ type: 'tunnel-need-detour', why: '正前方是液体，先找干燥列' });
            const dry = findDryClimbColumn(bot, dest, { radius: 6, upTo: targetY });
            if (dry.ok) {
                const spot = dry.candidates[0];
                onEvent({ type: 'tunnel-detour', to: { x: spot.x, z: spot.z }, why: `绕到干燥列（离目标 ${Math.round(spot.dToTarget)} 格）` });
                // walkTo 会自己绕开水（水面代价 0.8，能浮着走）
                const mv = (await withNav(bot, () => walkTo(bot, { x: spot.x, z: spot.z }, {
                    mapDir, arriveTol: 1.5, deadlineMs: 20000, onEvent,
                }))) ?? fail('BLOCKED', '导航被别的任务占用（绕到干燥列的 walkTo 没做成）', { retryable: true });
                if (!mv.ok) onEvent({ type: 'tunnel-detour-failed', code: mv.code });
            } else {
                onEvent({ type: 'tunnel-no-dry-column', why: dry.why });
            }
        }
    }

    while (steps < maxSteps && Date.now() - t0 < deadlineMs) {
        if (bot.interrupt_code) {
            return fail('INTERRUPTED', `掘进爬升被中断（${steps} 步）`, { steps, dug });
        }

        const p = bot.entity.position;
        const dx = dest.x - p.x, dz = dest.z - p.z;
        const hDist = Math.hypot(dx, dz);

        // 到位置了：够高、够近
        const highEnough = targetY == null || p.y >= targetY - 2;
        if (hDist <= 2.5 && highEnough) {
            onEvent({ type: 'tunnel-climb-arrived', steps, dug, y: p.y });
            return ok({ steps, dug, to: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } });
        }

        // 选方向。
        //
        // ★ 2026-10-29 修：**要向上爬时，"往上挖"必须排在最前面**。
        //
        // 实测事故：她面对一面 6 格高实心台地，目标原木在台上 y=69。
        // 原代码把 `{dy:1}`（往上挖）放在候选列表**最后一位**，
        // 而前面的水平方向全都能成功 → 永远轮不到它 →
        // 掘进 20 步、挖掉 8 个方块，**高度一直是 y=63，一格没上去**。
        //
        // 现在的顺序按"离目标还差多少"动态决定：
        //   还差 2 格以上高 → 先试往上挖（挖台阶）
        //   高度差不多了   → 再朝目标水平推进
        const sx = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0;
        const sz = sx === 0 ? Math.sign(dz) : 0;
        const needUp = (targetY != null) && (p.y < targetY - 1.5);

        const horizontal = [
            { dx: sx, dz: sz },
            { dx: sx, dz: 0 }, { dx: 0, dz: sz },
            { dx: sx === 0 ? 1 : 0, dz: sx === 0 ? (Math.sign(dz) || 1) : 0 },
            { dx: -sx, dz: 0 }, { dx: 0, dz: -sz },
        ].filter(d => (d.dx || d.dz));

        // 往上挖台阶。
        //
        // ★ 2026-10-29 补：**dy 只到 2 不够**。
        // 实测：台地 y=63~65 已被挖空、y=66~68 还是实心，
        // 她在 y=64 时 `dy:2` 只会站到 y=65（还是空的、没支撑），
        // 必须 `dy:3` 才能挖到 y=66 的实心层上。
        // 所以从 1 到 4 全列出来，由 checkStep 自己筛掉不合法的。
        // 只做**斜上挖台阶**（dx 非 0），不做"原地往上挖"。
        // 原因：原地挖掉头顶后跳上去没有落脚点，会直接掉回来 —— 物理上不成立。
        // 真正能爬的是台阶：挖斜上方那格，她的落点下方仍是原来的实心地面。
        const upward = [];
        for (const dy of [1, 2, 3, 4]) {
            upward.push({ dx: sx, dz: sz, dy });
            upward.push({ dx: sx, dz: 0, dy }, { dx: 0, dz: sz, dy });
        }
        const upwardFiltered = upward.filter(d => Number.isFinite(d.dx) && Number.isFinite(d.dz));

        const tries = (needUp ? [...upwardFiltered, ...horizontal] : [...horizontal, ...upwardFiltered])
            .filter(d => Number.isFinite(d.dx) && Number.isFinite(d.dz));

        let advanced = false;
        const beforePos = bot.entity.position.clone();
        for (const dir of tries) {
            const k = `${dir.dx},${dir.dz},${dir.dy ?? 0}`;
            if ((stuckGuard.get(k) ?? 0) >= 2) continue;    // 这个方向连着失败两次，换一个

            const r = await tunnelStep(bot, dir, { onEvent });
            if (r.ok) {
                // ★ 2026-10-29 修：**"ok" 不等于"有进展"**。
                //
                // 实测事故：她在 (42,63,-300) 与 (42,63,-301) 之间来回横跳 20 步，
                // 每步 dug=0（那两格早就挖空了）、位置原地不动，但 tunnelStep 都返回 ok
                // → 判"有进展" → 一直空转到超时，高度一格没上去。
                //
                // 真正的进展 = 位置真的变了（水平或垂直）。
                const now = bot.entity.position;
                const moved = Math.hypot(now.x - beforePos.x, now.z - beforePos.z)
                    + Math.abs(now.y - beforePos.y);
                const digN = r.data?.dug?.length ?? 0;
                if (moved >= 0.4 || digN > 0) {
                    steps++;
                    dug += digN;
                    stuckGuard.clear();
                    advanced = true;
                    break;
                }
                // 挖了 0 格又没移动：这个方向是"已经通了"，换方向别再试它
                stuckGuard.set(k, 2);
                continue;
            }
            stuckGuard.set(k, (stuckGuard.get(k) ?? 0) + 1);
        }

        if (!advanced) {
            // 所有方向都不行：如实失败（不空转）
            return fail('NO_REACH',
                `挖不上去（已掘进 ${steps} 步，现在 y=${Math.round(bot.entity.position.y)}，目标 y=${targetY ?? '?'}）`,
                { steps, dug });
        }
    }

    // 跑完步数/时间：够近够高就算成功，否则如实报没到
    const p = bot.entity.position;
    const hDist = Math.hypot(dest.x - p.x, dest.z - p.z);
    if (hDist <= 3 && (targetY == null || p.y >= targetY - 2)) {
        return ok({ steps, dug, to: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } });
    }
    return fail('TIMEOUT', `掘进爬升没到目标（${steps} 步，y=${Math.round(p.y)}）`, { steps, dug });
}
