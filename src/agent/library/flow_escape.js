/**
 * L2 复合技能：从被困的地方挖一条路出去。
 *
 * ★ 2026-10-27 —— 用户的原话：
 *   「我不是设的原子技能吗，直接困住就调用复合层能力不就好了？你不会到现在还是在自造轮子吧」
 *
 * 这句话是对的，而且指出我一直犯的错：
 *   我一直在调 pathfinder 的参数（digCost / allow1by1towers / maxDropDown），
 *   指望它的内部实现替我挖出一条向上的通道。那是自造轮子，而且造得很差。
 *
 * 正确做法：**用已有的原子组合**。这个文件一行底层能力都不新增。
 *
 * 分工（同 skill_collect）：
 *   planEscape()  只读世界，产出步骤序列 —— 可打印、可单测、不改世界
 *   runEscape()   按序列调原子执行，报「第几步/哪个原子/什么码」
 *
 * 什么时候用：原地检测到自己被围住（头顶/四周实心、或长时间没位移）。
 *
 * ═══ 2026-11-01 严格按规范整改（REFACTOR_ANALYSIS §3.1 / ARCHITECTURE_REDESIGN §6）═══
 * 1) **删掉重复的跳垫实现**：原来这里手写"起跳→等顶点→换手→placeBlockAt"，
 *    与 executor.stepUp 是两份（等 0.95 vs 0.9、沉降 450 vs 300）。
 *    现在统一走原子 `atom_pillar.pillarUpOnce`（单次尝试），
 *    **重试 3 次留在本层**（复合层才允许重试，§6.1）。
 * 2) **返回契约改用 ok()/fail()**：原来手搓 `{ ok, code, why, fromY, doneSteps, failedStep }`，
 *    还出现 `code: undefined` 这种逃过码表的写法。现在统一信封，
 *    code 只能取自 31 条白名单，计划/进度放 data。
 * 3) **删掉自建的「挖不动」清单**：原来 `UNBREAKABLE` 又列了一遍基岩/黑曜石，
 *    与 `atom_dig.isDiggable` 是第二个真相。现在统一用 isDiggable + canDigWithInventory。
 */
import { ok, fail } from './contract.js';
import { digBlock, isDiggable } from './act_dig.js';
import { blockAt } from './query_perceive.js';
import { pillarUpOnce } from './act_pillar.js';
import { findScaffoldItem } from './scaffold_blocks.js';

/** 复合技能 manifest（04 §4.1）：垂直自救（被埋/掉坑里往上脱困）。 */
export const manifest = {
    name: 'escape',
    level: 'flow',
    summary: '被埋住或掉进坑里时，往上挖/垫脱困',
    params: {
        timeoutMs: 'int 1000..600000 = 120000',
    },
    needs: { items: [], near: [] },
    claims: [],
    codes: ['NO_TARGET', 'NO_TOOL', 'STUCK', 'NO_ITEM', 'TIMEOUT', 'INTERRUPTED'],
    resumable: false,
    timeoutMs: 2 * 60 * 1000,
};


/** 可以拿来垫脚的方块见 scaffold_blocks.js（D8：清单原来散在 4 处且互不一致）。 */

/** pos 那格是不是空的（能穿过去）。水/草也算"能穿"，但不算"有支撑"。 */
function isAirAt(bot, pos) {
    const b = blockAt(bot, pos);
    return !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'
        || b.name === 'water' || b.name === 'short_grass' || b.name === 'tall_grass');
}

/**
 * 规划一条向上的通道。**只读世界**，不动任何方块。
 *
 * 策略（最省的那种）：
 *   站在洞底，一格一格往上「挖头顶 → 垫脚下 → 跳上去」。
 *   为什么不做螺旋楼梯：垂直挖 1×2 最简单、步数最少、也最容易验证。
 *   为什么每层要垫脚：她跳高 1.25 格，挖掉头顶那格后脚下没有支撑，必须先垫一块。
 *
 * @param {object} bot
 * @param {{targetY?:number, maxBlocks?:number}} opts
 * @returns ActionResult
 *   ok  → data: { steps, fromY, planToY, digCount, pillarCount }
 *   fail(BLOCKED) → 头顶第一格挖不动
 *   data.steps 里每步：{ act:'dig', pos, name } 或 { act:'pillar', at }
 */
export function planEscape(bot, opts = {}) {
    const { targetY = null, maxBlocks = 24 } = opts;

    const p = bot.entity.position;
    const fy = Math.floor(p.y);
    const fx = Math.floor(p.x), fz = Math.floor(p.z);

    // 已经在地表以上就别挖了 —— 空计划是**成功**，不是失败
    if (targetY != null && fy >= targetY) {
        return ok({ steps: [], fromY: fy, planToY: fy, digCount: 0, pillarCount: 0 });
    }

    // 垂直挖上去（用户定的做法，2026-10-27 第三次改）：
    //   1. 挖掉头顶那格      (x, y+1, z)
    //   2. 跳起来
    //   3. **在半空中**往脚下垫方块   (x, y, z) ← 她跳起来后脚下这格是空的，能放
    //   4. 落回方块上，净上升 1 格
    //
    // 之前我把这条判断错了：我以为"站着她把方块"放不进 y+1（她的碰撞箱）。
    // 对，但她根本不需要放在 y+1 —— **她放在 y（自己原来站的脚下）**，
    // 而 y 在她跳起来的那一刻是空的，所以放得进去。
    const steps = [];
    const scaffoldItem = findScaffoldItem(bot);

    for (let i = 0; i < maxBlocks; i++) {
        const y = fy + i;
        if (targetY != null && y >= targetY) break;

        // ★ 2026-10-27 第五次修：要挖**两格**，不是一格。
        //
        // 原因（实测日志）：在 y=64 连续 3 次「没离地」，跳不起来。
        //   她身高 1.8、跳跃 1.25 → 跳起来头顶要够到 y+3 附近，
        //   只挖 y+1 的话，y+2 的方块正好卡住她的头，jump 被顶回来。
        for (const dy of [1, 2]) {
            const at = { x: fx, y: y + dy, z: fz };
            if (isAirAt(bot, at)) continue;
            const b = blockAt(bot, at);
            // 「挖不挖得动」只有一处真相：atom_dig.isDiggable（方块层面：基岩/水/岩浆等）。
            // ⚠️ 这里**不查**"背包有没有合适的工具"——那是原子的前置断言
            //   （digBlock 会返回 NO_TOOL），规划层复制一遍会让"没带镐"直接规划不出计划，
            //   而规划本身是只读世界的，不该依赖背包此刻的状态。
            const unbreakable = !b || !isDiggable(b);
            if (unbreakable) {
                // 第二格挖不动不致命（只是空间矮一点），第一格挖不动才必须停
                if (dy === 1) {
                    return fail('BLOCKED', `头顶 y=${at.y} 是 ${b?.name ?? '未知'}，挖不动`, {
                        fromY: fy, pos: at, steps,
                    });
                }
                break;
            }
            steps.push({ act: 'dig', pos: at, name: b.name });
        }

        // 2) 跳 + 半空垫脚下（执行时调 atom_pillar.pillarUpOnce）
        steps.push({ act: 'pillar', at: { x: fx, y, z: fz }, item: scaffoldItem });
    }

    const pillarCount = steps.filter(s => s.act === 'pillar').length;
    const digCount = steps.filter(s => s.act === 'dig').length;
    if (!steps.length) {
        return fail('BLOCKED', '没有可执行的步骤', { fromY: fy, steps: [], digCount, pillarCount });
    }
    return ok({ steps, fromY: fy, planToY: fy + pillarCount, digCount, pillarCount });
}

/**
 * 执行 planEscape 产出的步骤。
 * 每一步都调**现有原子**，不写任何新底层逻辑。
 *
 * @returns ActionResult
 *   ok  → data: { doneSteps, step, fromY, toY, climbed }
 *   fail → data: { doneSteps, step, failed:[{pos,code,message}], fromY, toY }
 *          code ∈ NO_ITEM / INTERRUPTED / BLOCKED / STUCK / 原子透传的码
 */
export async function runEscape(bot, plan, opts = {}) {
    const { onEvent = () => { }, targetY = null, maxLayers = 40 } = opts;
    const t0 = Date.now();
    const fromY = bot.entity.position.y;
    const failed = [];

    // ★ 2026-10-27 第十四次修：**每升一格就重新规划**，不再一次性算完所有层。
    //
    // 实测踩的坑：planEscape 按"规划那一刻的世界"一次性算出 40 层，
    // 但执行中世界在变 —— 她自己垫的方块、挖开的方块都改变了后续层的判断。
    //   规划时：y=48，头顶 49/50 都是空气 → 只记录"不需要挖"
    //   实际执行到 y=49：头顶 50 空、51 是 diorite，**跳起来顶头，跳不动**
    //   日志就是「没离地（y=49.00）」连续 3 次
    //
    // 所以改成滚动式：每次只规划"当前这一层"，执行完再规划下一层。
    const scaffold = findScaffoldItem(bot);
    if (!scaffold) {
        return fail('NO_ITEM', '没有可垫脚的方块（需要泥土/圆石/木板）', {
            doneSteps: 0, step: 0, fromY, toY: fromY, costMs: Date.now() - t0,
        });
    }

    let done = 0;
    let lastCode = null;

    for (let layer = 0; layer < maxLayers; layer++) {
        if (bot.interrupt_code) {
            return fail('INTERRUPTED', '被取消了', {
                doneSteps: done, step: done + 1, failed,
                fromY, toY: bot.entity.position.y, costMs: Date.now() - t0,
            });
        }

        const y0 = bot.entity.position.y;
        if (targetY != null && y0 >= targetY) break;

        // 只规划当前这一层（maxBlocks=1）
        const one = planEscape(bot, { targetY: targetY ?? undefined, maxBlocks: 1 });
        if (!one.ok) {
            lastCode = one.code;
            onEvent({ type: 'escape-blocked', code: one.code, message: one.message });
            break;
        }

        let layerFailed = null;

        for (const st of one.data.steps) {
            if (bot.interrupt_code) break;

            if (st.act === 'dig') {
                const r = await digBlock(bot, { kind: 'block', pos: st.pos });
                const already = /air/i.test(String(r.message ?? ''));
                if (!r.ok && !already) {
                    layerFailed = { pos: st.pos, code: r.code, message: r.message };
                    break;
                }
                onEvent({ type: 'escape-dig', y: st.pos.y, code: r.code });

            } else if (st.act === 'pillar') {
                // ★ 重试归复合层（原子只做一次）。3 次沿用实测值。
                let attemptOk = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const r = await pillarUpOnce(bot, { item: scaffold, settleMs: 450 });
                    onEvent({
                        type: 'escape-pillar', attempt, ok: r.ok, code: r.code,
                        from: +(r.data?.fromY ?? y0).toFixed(1),
                        to: +(r.data?.toY ?? bot.entity.position.y).toFixed(1),
                    });
                    if (r.ok) { attemptOk = true; break; }
                    if (r.code === 'INTERRUPTED') {
                        return fail('INTERRUPTED', '被取消了', {
                            doneSteps: done, step: done + 1, failed,
                            fromY, toY: bot.entity.position.y, costMs: Date.now() - t0,
                        });
                    }
                    lastCode = r.code;
                }
                if (!attemptOk) {
                    layerFailed = {
                        pos: st.at, code: 'STUCK',
                        message: `跳垫 3 次没上去（停在 y=${bot.entity.position.y.toFixed(1)}）`,
                    };
                }
            }
        }

        if (layerFailed) {
            failed.push(layerFailed);
            lastCode = layerFailed.code;
            break;
        }
        done++;
    }

    const toY = bot.entity.position.y;
    const climbed = toY - fromY;
    const data = {
        doneSteps: done, step: done + 1, fromY, toY, climbed,
        failed, costMs: Date.now() - t0,
    };

    if (climbed < 1) {
        return fail(lastCode ?? 'STUCK', `一步都没上去（y ${fromY.toFixed(1)} → ${toY.toFixed(1)}）`, data);
    }
    return ok(data);
}

/**
 * 一步到位：规划 + 执行。天花板是"被围住时的自救"。
 *
 * @returns ActionResult（同 runEscape；code 可区分 BLOCKED / NO_ITEM / STUCK / INTERRUPTED）
 */
export async function escapeUp(bot, opts = {}) {
    const { onEvent = () => { }, targetY = null, maxBlocks = 24 } = opts;
    const plan = planEscape(bot, { targetY, maxBlocks });
    onEvent({
        type: 'escape-plan', ok: plan.ok, code: plan.code,
        steps: plan.data?.steps?.length ?? 0, message: plan.message,
    });

    if (!plan.ok) {
        return fail(plan.code, plan.message, { ...plan.data, doneSteps: 0, step: 0 });
    }
    if (!plan.data.steps.length) {
        // 已经够高：不是失败
        return ok({ doneSteps: 0, step: 0, fromY: plan.data.fromY, toY: bot.entity.position.y, climbed: 0, failed: [] });
    }
    // 把 targetY 传下去：runEscape 现在自己按层重规划，必须知道要挖到哪
    return runEscape(bot, plan, { onEvent, targetY, maxLayers: maxBlocks });
}
