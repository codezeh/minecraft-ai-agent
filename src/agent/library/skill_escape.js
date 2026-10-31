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
 * 正确做法：**用已有的 7 个原子组合**。这个文件一行底层能力都不新增：
 *   digBlock(头顶)          → 挖开
 *   equipItem(垫脚方块)      → 拿在手上
 *   placeBlockAt(脚下偏移)   → 垫一块
 *   setControlState('jump')  → 跳上去（物理按键，同 atom_dig:70 的既有做法）
 *   canStand(某格)          → 判断能不能站
 *
 * 它的分工（同 skill_collect）：
 *   planEscape()  只读世界，产出步骤序列 —— 可打印、可单测、不改世界
 *   runEscape()   按序列调原子执行，报「第几步/哪个原子/什么码」
 *
 * 什么时候用：原地检测到自己被围住（头顶/四周实心、或长时间没位移）。
 */
import { ok, fail } from './atom_contract.js';
import { digBlock, isDiggable } from './atom_dig.js';
import { placeBlockAt } from './atom_place.js';
import { equipItem } from './atom_items.js';
import { canStand } from './atom_stand.js';
import { moveTo } from './atom_move.js';
import { blockAt } from './atom_perceive.js';
import { findScaffoldItem } from './scaffold_blocks.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 可以拿来垫脚的方块见 scaffold_blocks.js（D8：清单原来散在 4 处且互不一致）。 */

/** 挖不动的（别白试）。 */
const UNBREAKABLE = new Set([
    'bedrock', 'barrier', 'command_block', 'end_portal_frame', 'obsidian', 'reinforced_deepslate',
]);

/** pos 那格是不是空的（能穿过去）。 */
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
 *   为什么每层要垫脚：her 跳高 1.25 格，挖掉头顶那格后脚下没有支撑，必须先垫一块。
 *
 * @param {object} bot
 * @param {{targetY?:number, maxBlocks?:number}} opts
 * @returns {{ok:boolean, code?:string, steps:Array, fromY:number, planToY:number, why:string}}
 */
export function planEscape(bot, opts = {}) {
    const { targetY = null, maxBlocks = 24 } = opts;

    const p = bot.entity.position;
    const fy = Math.floor(p.y);
    let fx = Math.floor(p.x), fz = Math.floor(p.z);   // 斜向楼梯会移动，必须可变

    // 已经在地表以上就别挖了
    if (targetY != null && fy >= targetY) {
        return { ok: true, steps: [], fromY: fy, planToY: fy, why: '已经到目标高度了' };
    }


    // 垂直挖上去（用户定的做法，2026-10-27 第三次改）：
    //
    //   1. 挖掉头顶那格      (x, y+1, z)
    //   2. 跳起来
    //   3. **在半空中**往脚下垫方块   (x, y, z) ← 她跳起来后脚下这格是空的，能放
    //   4. 落回方块上，净上升 1 格
    //
    // 之前我把这条判断错了：我以为"站着她把方块"放不进 y+1（她的碰撞箱）。
    // 对，但她根本不需要放在 y+1 —— **她放在 y（自己原来站的脚下）**，
    // 而 y 在她跳起来的那一刻是空的，所以放得进去。
    // 这就解释了为什么之前斜向楼梯绕了一大圈还走不上去。
    //
    // 每层 3 步：dig(y+1) → jump → place(y)
    const steps = [];

    for (let i = 0; i < maxBlocks; i++) {
        const y = fy + i;
        if (targetY != null && y >= targetY) break;

        // ★ 2026-10-27 第五次修：要挖**两格**，不是一格。
        //
        // 原因（实测日志）：在 y=64 连续 3 次「没离地」，跳不起来。
        //   她身高 1.8、跳跃 1.25 → 跳起来头顶要够到 y+3 附近，
        //   只挖 y+1 的话，y+2 的方块正好卡住她的头，jump 被顶回来。
        //   所以每次挖 y+1 和 y+2 两格，保证有足够空间起跳。
        for (const dy of [1, 2]) {
            const at = { x: fx, y: y + dy, z: fz };
            if (isAirAt(bot, at)) continue;
            const b = blockAt(bot, at);
            if (!b || !isDiggable(b) || UNBREAKABLE.has(b.name)) {
                // 第二格挖不动不致命（只是空间矮一点），第一格挖不动才必须停
                if (dy === 1) {
                    return {
                        ok: false, code: 'BLOCKED',
                        steps, fromY: fy, planToY: y,
                        why: `头顶是 ${b?.name ?? '未知'}，挖不动`,
                    };
                }
                break;
            }
            steps.push({ act: 'dig', pos: at, name: b.name });
        }

        // 2) 跳 + 半空垫脚下
        steps.push({ act: 'jumpPlace', at: { x: fx, y, z: fz }, item: 'scaffold' });
    }

    const planToY = fy + steps.filter(s => s.act === 'jumpPlace').length;
    return {
        ok: steps.length > 0,
        code: steps.length ? undefined : 'BLOCKED',
        steps, fromY: fy, planToY,
        why: steps.length ? `计划挖 ${steps.filter(s => s.act === 'dig').length} 格、垫 ${steps.filter(s => s.act === 'jumpPlace').length} 格，上到 y≈${planToY}` : '没有可执行的步骤',
    };
}

/**
 * 执行 planEscape 产出的步骤。
 * 每一步都调**现有原子**，不写任何新底层逻辑。
 *
 * @returns {{ok:boolean, code?:string, doneSteps:number, failedStep:number|null, fromY:number, toY:number, message:string}}
 */
export async function runEscape(bot, plan, opts = {}) {
    const { onEvent = () => { }, targetY = null, maxLayers = 40 } = opts;
    const fromY = bot.entity.position.y;

    // ★ 2026-10-27 第十四次修：**每升一格就重新规划**，不再一次性算完所有层。
    //
    // 实测踩的坑：planEscape 按"规划那一刻的世界"一次性算出 40 层，
    // 但执行中世界在变 —— 她自己垫的方块、挖开的方块都改变了后续层的判断。
    //   规划时：y=48，头顶 49/50 都是空气 → 只记录"不需要挖"
    //   实际执行到 y=49：头顶 50 空、51 是 diorite，**跳起来顶头，跳不动**
    //   日志就是「没离地（y=49.00）」连续 3 次
    //
    // 所以改成滚动式：每次只规划"当前这一层"，执行完再规划下一层。
    // 这也是用户早先定的滚动窗口思路在技能层的同一应用。
    const scaffold = findScaffoldItem(bot);
    if (!scaffold) {
        return { ok: false, code: 'NO_ITEM', doneSteps: 0, failedStep: null, fromY, toY: fromY, message: '没有可垫脚的方块（需要泥土/圆石/木板）' };
    }

    let done = 0;
    let failed = null;

    for (let layer = 0; layer < maxLayers; layer++) {
        if (bot.interrupt_code) {
            return { ok: false, code: 'INTERRUPTED', doneSteps: done, failedStep: failed, fromY, toY: bot.entity.position.y, message: '被取消了' };
        }

        const y0 = bot.entity.position.y;
        if (targetY != null && y0 >= targetY) break;

        // 只规划当前这一层（maxBlocks=1）
        const one = planEscape(bot, { targetY: targetY ?? undefined, maxBlocks: 1 });
        if (!one.ok && !one.steps.length) {
            failed = one.code ?? 'BLOCKED';
            onEvent({ type: 'escape-blocked', code: failed, why: one.why });
            break;
        }

        let lifted = false;
        let placed = false;

        for (const st of one.steps) {
            if (bot.interrupt_code) break;

            if (st.act === 'dig') {
                const r = await digBlock(bot, { kind: 'block', pos: st.pos });
                const already = /air/i.test(String(r.message ?? ''));
                console.log(`[escape] 挖 (${st.pos.x},${st.pos.y},${st.pos.z}) ${st.name} -> ${r.ok ? 'OK' : (already ? '已是空气' : r.code)}`);
                if (!r.ok && !already) { failed = r.code; break; }
                onEvent({ type: 'escape-dig', y: st.pos.y, done });

            } else if (st.act === 'jumpPlace') {
                // 以下实际位置为准，不用规划值
                const yBefore = bot.entity.position.y;
                const feet = {
                    x: Math.floor(bot.entity.position.x),
                    y: Math.floor(bot.entity.position.y),
                    z: Math.floor(bot.entity.position.z),
                };

                for (let attempt = 0; attempt < 3; attempt++) {
                    bot.setControlState('jump', true);
                    // 等接近跳跃顶点（脚要抬过 y+1，方块那格才真空出来）
                    for (let w = 0; w < 16; w++) {
                        await sleep(25);
                        if (bot.entity.position.y > yBefore + 0.95) { lifted = true; break; }
                    }
                    if (lifted) {
                        const eq = await equipItem(bot, scaffold);
                        if (eq.ok) {
                            const pr = await placeBlockAt(bot, { kind: 'block', pos: feet }, scaffold);
                            console.log(`[escape] 跳垫(第${attempt + 1}次): 起跳y=${yBefore.toFixed(2)} 放${scaffold}到(${feet.x},${feet.y},${feet.z}) -> ${pr.ok ? 'OK' : pr.code}`);
                            placed = pr.ok;
                        }
                    } else {
                        console.log(`[escape] 跳垫(第${attempt + 1}次): 没离地（y=${bot.entity.position.y.toFixed(2)}）`);
                    }
                    bot.setControlState('jump', false);
                    await sleep(450);
                    if (planted2(bot, yBefore)) break;
                }

                const yAfter = bot.entity.position.y;
                console.log(`[escape] 本层结果: ${yBefore.toFixed(2)} -> ${yAfter.toFixed(2)}（离地=${lifted} 垫成=${placed}）`);
                onEvent({ type: 'escape-jump', from: +yBefore.toFixed(1), to: +yAfter.toFixed(1), lifted, placed });

                if (yAfter < yBefore + 0.7) {
                    failed = 'STUCK';
                    break;
                }
            }
        }

        if (failed) break;
        done++;
    }

    const toY = bot.entity.position.y;
    const climbed = toY - fromY;
    if (climbed < 1) {
        return { ok: false, code: failed ?? 'STUCK', doneSteps: done, failedStep: failed, fromY, toY, message: `一步都没上去（y ${fromY.toFixed(1)} → ${toY.toFixed(1)}）` };
    }
    return { ok: true, doneSteps: done, failedStep: null, fromY, toY, message: `上去了 ${climbed.toFixed(1)} 格（y ${fromY.toFixed(0)} → ${toY.toFixed(0)}${failed ? '，中途 ' + failed : ''}）` };
}

/** 已经比起点高了 0.7 格就算这一层成功。 */
function planted2(bot, y0) {
    return bot.entity.position.y > y0 + 0.7;
}


/**
 * 一步到位：规划 + 执行。天花板是"被围住时的自救"。
 *
 * @returns 同 runEscape，外加 code 用于区分 BLOCKED / NO_ITEM / STUCK
 */
export async function escapeUp(bot, opts = {}) {
    const { onEvent = () => { }, targetY = null, maxBlocks = 24 } = opts;
    const plan = planEscape(bot, { targetY, maxBlocks });
    onEvent({ type: 'escape-plan', ok: plan.ok, code: plan.code, steps: plan.steps.length, why: plan.why });

    if (!plan.ok && !plan.steps.length) {
        return fail(plan.code ?? 'BLOCKED', plan.why, { fromY: plan.fromY });
    }
    // 把 targetY 传下去：runEscape 现在自己按层重规划，必须知道要挖到哪
    return runEscape(bot, plan, { onEvent, targetY, maxLayers: maxBlocks });
}
