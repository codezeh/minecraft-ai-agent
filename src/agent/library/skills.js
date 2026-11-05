import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import * as landmarks from "./landmarks.js";
import * as store from "./memory_store.js";   // dangers / tasks 命名空间直读
// 攀爬能力（原子层）与实体跟随（任务层）
import { mapDirOf } from './bot_paths.js';
import { climbUp, climbDown, isClimbable, climbableUp, climbableDown } from './act_climb.js';
// 掘进与树体（2026-10-29 新增能力，要暴露给模型）
// ★ 2026-10-31：原来 import 的是 tunnelAlong（循环长在原子层里）。
// 原子层规范化后原子只做单步，多步循环交回复合层用 runSteps 表达。
import { tunnelStep, computeSafeZone } from './atom_tunnel.js';
import { runSteps } from './step_runner.js';
// ★ 2026-11-01（Phase A.3 / A1）：斜杠命令与按键只许从输入原子出去，本文件不再自己拼 bot.chat('/…')。
import { command } from './atom_input_misc.js';
import { pressKey } from './atom_input_move.js';
// 2026-11-01（t6 遗留清理）：挖/放/右键/挥击/停止挖掘全部改走 atom_input_mouse，本文件不再裸调 bot.* 输入。
import { holdDig, placeAgainst, useOnBlock, useHeld, attackOnce, lookAtPoint, stopDig } from './atom_input_mouse.js';
import { closeWindow as closeWindowAtom } from './atom_input_inventory.js';
// M6（2026-11-02）：合成 / 熔炼 / 进食 的真实实现已上提到 act_* 动作层。
// 下面这些旧函数保留名字与**boolean 返回**（上游 commands/npc 都按 boolean 用），
// 内部改为调动作 —— 这样"谁真的在干活"只有一份真相。
import { craftOnce, furnaceLoad, furnaceCollect } from './act_craft.js';
import { eat as eatAction } from './act_items.js';
// 第21条：攻击目标的"该不该打"判定只有一份真相 —— act_attack.isAttackable。
// 本文件过去零引用它，于是 attackNearest/attackEntity 能打玩家。
import { isAttackable } from './act_attack.js';
// 第10条：`digTunnel` 结尾 `return ok({...})` 一直没 import —— 于是它**正常返回时**
// 抛 ReferenceError: ok is not defined，这个技能从未成功返回过一次。
import { ok } from './contract.js';
// 第9条②：本文件直驱 pathfinder 的点（gotoWithTimeout / goToGoal）要进导航闸。
import { withNav } from './nav_core.js';
import { scanTree, judgeTree, planFelling } from './query_tree.js';
import { followEntity as followEntityTask } from './flow_follow.js';
// ★ 第20条（2026-11-05 R1 收尾）：本文件这三处曾经各有一份判据，于是"同一个问题
//   在原子层和这里给出不同答案"。现在它们的判据**只留原子层一份**，这里只做薄包装：
//     waitUntil    → atom_wait.waitUntil       （false 算不算"完成"只有一种解释）
//     canReach     → query_perceive.reachDistanceTo + rules.runtime.digReach()（5.1）
//     isSafeHere   → query_safe.hostilesNear   （敌对生物要全数，不是"有没有一只"）
import { waitUntil as atomWaitUntil } from './atom_wait.js';
import { eyePosition as atomEyePosition } from './atom_read.js';
import { reachDistanceTo as atomReachDistanceTo } from './query_perceive.js';
import { hostilesNear } from './query_safe.js';
import { digReach } from '../rules/rules.runtime.js';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

/**
 * 等到某个条件**完成**，带超时。**薄包装** —— 唯一实现是原子层 `atom_wait.waitUntil`。
 *
 * ★ 第20条（2026-11-05 R1 收尾）：原来本文件这份写的是 `if (predicate())`，
 *   也就是"谓词返回 `false` = 还没好，继续等"；而原子层那份的约定反过来 ——
 *   **只有 `undefined` / `null` 才是"还没好"**，`false` 算已完成。
 *   同一件事两种解释，模型按名字选到哪份就得到哪份的答案
 *   （报告 13.3 点名：这是三处分叉里最危险的一处）。现在只剩原子层那一种：
 *     返回 undefined / null                → 还没好，继续等
 *     返回其它**任何**值（含 false/0/''）  → 完成，立即返回，`value` 就是它
 *   因此"等它变成 true"的谓词要写 `() => cond || undefined`；
 *   直接写 `() => cond` 会在第一次 false 时立刻判定"完成"。
 *
 * 返回形状仍是本文件的历史契约 `{ ok, waitedMs, reason, label, value }`
 * （上游按 `.ok` 判断，见第22条；`reason` 取值 met / timeout / interrupted / error）。
 * 与原子层的差异只有形状（原子返回 ActionResult），判据本身没有第二份。
 */
export async function waitUntil(bot, predicate, opts = {}) {
    /**
     * Wait until predicate() **finishes**, or time out. Use this instead of writing your own
     * busy-wait loop. The judgement is the atom layer's one:
     * return `undefined` (or nothing) while the condition is NOT met yet, and the value you are
     * waiting for once it is. Returning `false` counts as DONE, not as "keep waiting".
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Function} predicate, () => value | undefined | null, checked repeatedly.
     * @param {Object} opts, { timeoutMs=5000, intervalMs=250, label='condition' }
     * @returns {Promise<Object>} { ok, waitedMs, reason, label, value }
     * @example
     * const r = await skills.waitUntil(bot, () => bot.inventory.emptySlotCount() > 3 || undefined,
     *     { label: 'inventory space' });
     * if (!r.ok) log(bot, `等不到空位（${r.waitedMs}ms）`);
     **/
    const timeoutMs = opts.timeoutMs ?? 5000;
    const intervalMs = opts.intervalMs ?? 250;
    const label = opts.label ?? 'condition';
    const r = await atomWaitUntil(predicate, { timeoutMs, intervalMs, bot });
    if (r.ok) {
        return { ok: true, waitedMs: r.data?.waitedMs ?? 0, reason: 'met', label, value: r.data?.value };
    }
    const reason = r.code === 'TIMEOUT' ? 'timeout'
        : r.code === 'INTERRUPTED' ? 'interrupted'
            : 'error';
    return { ok: false, waitedMs: r.data?.waitedMs ?? 0, reason, label, message: r.message };
}

/**
 * 轻量物料预检：我身上够不够这些东西？
 * 回答「够/不够/缺多少」，不做获取规划（要规划用 planMaterials）。
 * 用在动手之前 —— 先确认有料，再开工，避免干到一半发现缺材料。
 */
export function checkItems(bot, required = {}) {
    /**
     * Check whether the items you are carrying are enough. Answers have/short for each item.
     * Use it right before building or crafting, instead of starting and failing halfway.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} required, e.g. { oak_planks: 40, stick: 8 }
     * @returns {Object} { ok, have, short, missingTotal }
     * @example
     * const c = skills.checkItems(bot, { oak_planks: 40 });
     * if (!c.ok) log(bot, `还缺 ${c.missingTotal} 个材料`);
     **/
    const have = {};
    const short = {};
    let missingTotal = 0;
    for (const [name, need] of Object.entries(required || {})) {
        const got = countInventoryItem(bot, name);
        have[name] = got;
        if (got < need) {
            short[name] = need - got;
            missingTotal += need - got;
        }
    }
    const ok = missingTotal === 0;
    log(bot, ok
        ? `材料够：${Object.entries(have).map(([k, v]) => `${k}x${v}`).join(', ')}`
        : `材料不够，还缺：${Object.entries(short).map(([k, v]) => `${k}x${v}`).join(', ')}`);
    return { ok, have, short, missingTotal };
}

export function log(bot, message) {
    // 实现统一在 outcome.logLine（加固了 bot.output / message 为 undefined 的两种情形），
    // 这里只转发 —— 避免「日志格式」长出第二个真相。
    logLine(bot, message);
}

/**
 * 她面朝哪个方向（中文方位）。只是把 world_model.facingOf 包一层，方便命令层直接调。
 */
export function facingName(bot) {
    return wmFacingOf(bot).name;
}

/**
 * 确保附近有一个可用方块（工作台/熔炉这类），没有就从背包放一个。
 * 这是从 craftRecipe / smeltItem 里抽出来的原子技能 —— 它俩原来各写了一遍
 * 「找方块 -> 没有就 getNearestFreeSpace + placeBlock -> 重新找」，
 * 而且放置失败时只是把变量留成 undefined，外面完全看不出为什么。
 */
export async function ensureNearbyBlock(bot, blockName, range = 16, opts = {}) {
    /**
     * Make sure there is a usable block of this type nearby: find it, or place one from the
     * inventory. Use this before opening a crafting table or furnace.
     * Returns what happened, so you can tell "找不到" from "没材料" from "放失败".
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockName, e.g. "crafting_table" or "furnace".
     * @param {number} range, how far to look. Defaults to 16.
     * @returns {Promise<Object>} { ok, block, placed, reason }
     * @example
     * const t = await skills.ensureNearbyBlock(bot, "crafting_table", 16);
     * if (!t.ok) log(bot, `没有工作台：${t.reason}`);
     **/
    // 1) 附近已有（onlyPlace=true 时跳过这步，强制用背包里的就地放）
    if (!opts.onlyPlace) {
        const near = world.getNearestBlock(bot, blockName, range);
        if (near) {
            return { ok: true, block: near, placed: false, reason: 'found' };
        }
    }
    let block;

    // 2) 背包里有就放
    const have = world.getInventoryCounts(bot)[blockName] || 0;
    if (have <= 0) {
        log(bot, `附近没有 ${blockName}，背包里也没有（需要先合成/获取）。`);
        return { ok: false, block: null, placed: false, reason: 'none_available' };
    }

    const pos = world.getNearestFreeSpace(bot, 1, Math.min(range, 8));
    if (!pos) {
        log(bot, `附近找不到空位放 ${blockName}。`);
        return { ok: false, block: null, placed: false, reason: 'no_free_space' };
    }
    try {
        await placeBlock(bot, blockName, pos.x, pos.y, pos.z);
    } catch (err) {
        log(bot, `放 ${blockName} 失败：${err.message}`);
        return { ok: false, block: null, placed: false, reason: 'place_failed', error: err.message };
    }

    // 3) 重新找（放置后客户端状态可能还没同步，稍等一下）
    block = world.getNearestBlock(bot, blockName, range);
    if (!block) {
        log(bot, `放了 ${blockName} 但重新找不到它（可能没真正放下）。`);
        return { ok: false, block: null, placed: false, reason: 'placed_but_missing' };
    }
    log(bot, `放好了 ${blockName} 在 (${block.position.x},${block.position.y},${block.position.z})。`);
    return { ok: true, block, placed: true, reason: 'placed' };
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {
            log(bot, `放火把失败：${err.message}`);
            return false;
        }
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    // getItemCraftingRecipes 对「不存在的物品」返回 null（不是空数组），
    // 直接 .length 会 TypeError。实测传错名字就炸。
    const knownRecipes = mc.getItemCraftingRecipes(itemName);
    if (!knownRecipes || knownRecipes.length === 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // 找/放工作台：这段原来手写在函数里，失败时只留 undefined，
        // 外面看不出是"没工作台"还是"放失败了"。现在交给原子技能统一处理。
        const table = await ensureNearbyBlock(bot, 'crafting_table', craftingTableRange);
        if (!table.ok) {
            log(bot, `合成 ${itemName} 需要工作台，但没有可用的（${table.reason}）。`);
            return false;
        }
        craftingTable = table.block;
        placedTable = table.placed;
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ')}.`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    // ★ M6（2026-11-02）：真正的"合成一次"已上提到 act_craft.craftOnce
    //   （它自带 配方/料/工作台 的前置判断与 ActionResult 错误码）。
    //   本函数保留**流程职责**：没工作台就放一个、合完再捡回来（02 §3 明写这属于 flow_craft）。
    //
    //   行为差异：原来这里按 `Math.min(craftLimit.num, num)` 合，craftOnce 做同样的事，
    //   所以数量语义不变；不同点是失败时不再"静默 boolean false"，日志里会带错误码
    //   （NO_RECIPE / NO_ITEM / NO_WORKSTATION），便于定位。
    const crafted = await craftOnce(bot, itemName, num);
    if (!crafted.ok) {
        log(bot, `合成 ${itemName} 失败：${crafted.code} ${crafted.message ?? ''}`);
    } else if (crafted.data?.got < crafted.data?.want) {
        log(bot, `Not enough material to craft ${num}, crafted ${crafted.data.got}.`);
    } else {
        log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    }

    if (placedTable) {
        // 背包满的时候收不回来是必然的（没格子放）。
        // 不要因此报错打断流程——工作台留在地上，下次合成还能直接用。
        if (bot.inventory.emptySlotCount() > 0) {
            try {
                await collectBlock(bot, 'crafting_table', 1);
            } catch (err) {
                log(bot, 'Crafting table left in place (could not pick it back up).');
            }
        } else {
            log(bot, 'Crafting table left in place (inventory is full).');
        }
    }

    try {
        bot.armorManager?.equipAll?.();
    } catch { /* 没装插件或没有盔甲，都不影响合成结果 */ }

    // 上游（commands/actions.js、npc/item_goal.js、skills 内部）都按 boolean 用，保持不变
    return crafted.ok;
}


export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}
/**
 * 把一个打开的熔炉当「三格储物箱」来读，而不是当成黑盒。
 * 上格=input(待炼物) 下格=fuel(燃料) 右格=output(产物)。
 * 先看清里面有什么，再决定填什么、取什么 —— 和箱子一样的心智模型。
 */
/**
 * 走到某个已知方块旁边，但**带硬超时**。
 *
 * 动机（实测）：goToGoal 内部有 180 秒硬上限，而 pathfinder 在
 * "Path not found" 之后仍会 `attempting to navigate anyway using destructive
 * movements`。于是她会为了一个墙后/水对面的熔炉原地反复爬坡 90~180 秒，
 * 这期间动作管理器一直 executing，用户看到的就是"她卡住了"。
 *
 * 这里给一个短上限（调用方传 15 秒），超时就停寻路并如实说明，
 * 让上层可以改走"自己就地放一个"的路子。
 *
 * @returns {{ok: boolean, distance: number, reason: string}}
 */
async function goToBlockBounded(bot, block, minDist, timeoutMs) {
    const goal = new pf.goals.GoalNear(block.position.x, block.position.y, block.position.z, minDist);
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try { bot.pathfinder.stop(); } catch (err) { /* ignore */ }
    }, timeoutMs);
    try {
        // goToGoal 可能很晚才返回/抛错 —— 用 race 抢跑，并吞掉它的结果
        await Promise.race([
            goToGoal(bot, goal).catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, timeoutMs + 50)),
        ]);
    } finally {
        clearTimeout(timer);
    }
    const distance = bot.entity.position.distanceTo(block.position);
    const ok = !timedOut && distance <= minDist + 1;
    return {
        ok,
        distance,
        reason: timedOut
            ? `${Math.round(timeoutMs / 1000)} 秒没走到（离目标还有 ${distance.toFixed(1)} 格）`
            : `走到了但离目标 ${distance.toFixed(1)} 格，不够近`,
    };
}


/**
 * GUI 会话是否还有效。
 *
 * 为什么需要：四个 interrupts:['all'] 的保命模式（self_preservation / unstuck /
 * cowardice / self_defense）**会打断**正在进行的 GUI 操作 —— 这是**正确的**
 * （她掉进岩浆了当然该先自救）。但打断之后服务端会把窗口关掉，
 * 技能后续 takeOutput / withdraw 拿到 null，只报一句含糊的 take_failed，
 * 她根本不知道是"没炼好"还是"窗口没了"。
 *
 * 另外实测：开窗后走远（>约 10 格）服务端会**静默关窗**，也不报错。
 * 所以"窗口还在不在"这一条检查同时覆盖了"被保命行为打断"和"走远了"两种情况，
 * 不必再单独算距离。
 *
 * @returns {{ok: boolean, code?: string, message?: string}}
 */
export function checkWindow(bot, win) {
    if (!win) {
        return { ok: false, code: 'WINDOW_CLOSED', message: '没有打开的窗口' };
    }
    if (!bot.currentWindow || bot.currentWindow !== win) {
        return {
            ok: false, code: 'WINDOW_CLOSED',
            message: '窗口已经关了（多半是被自救/脱困行为打断，或者走远了被服务端关掉），需要重新打开',
        };
    }
    return { ok: true };
}


export function furnaceStatus(bot, furnace) {
    /**
     * Read what is inside an opened furnace: input (top), fuel (bottom), output (right).
     * A furnace is just a 3-slot container, so check it before loading anything.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Furnace} furnace, obtained from bot.openFurnace(block).
     * @returns {Object} { input, fuel, output, outputReady }
     **/
    const nameOf = (it) => it ? (mc.getItemName(it.type) || `id:${it.type}`) : null;
    const fmt = (it) => it ? `${it.count}x${nameOf(it)}` : '空';
    const input = furnace.inputItem();
    const fuel = furnace.fuelItem();
    const output = furnace.outputItem();
    const status = {
        input: input ? { name: nameOf(input), count: input.count, type: input.type } : null,
        fuel: fuel ? { name: nameOf(fuel), count: fuel.count, type: fuel.type } : null,
        output: output ? { name: nameOf(output), count: output.count, type: output.type } : null,
        outputReady: !!output,
    };
    log(bot, `熔炉里 —— 上格(加工物) ${fmt(input)}，下格(燃料) ${fmt(fuel)}，右格(产物) ${fmt(output)}。`);
    return status;
}

/**
 * 读一个「行为模式」是否开启。
 *
 * `bot.modes` 是 mindcraft 自己的扩展（modes.js 里挂到 bot 上），
 * 裸 mineflayer bot 没有它。原来 skills.js 里 8 处直接 `bot.modes.isOn(...)`，
 * 一旦在没有 modes 的环境里跑（隔离测试、探针脚本、或者未来别的宿主），
 * 就抛 "Cannot read properties of undefined (reading 'isOn')"——
 * 实测就是它让"放熔炉"直接失败的。
 *
 * 所以统一走这两个访问器：没有 modes 时当作"所有模式都关着"，不崩。
 */
export function modesIsOn(bot, name) {
    return !!(bot?.modes && bot.modes.isOn && bot.modes.isOn(name));
}

/** 恢复一个行为模式（没有 modes 时静默忽略）。 */
export function modesUnpause(bot, name) {
    if (bot?.modes && bot.modes.unpause) bot.modes.unpause(name);
}

/** 暂停一个行为模式（没有 modes 时静默忽略）。 */
export function modesPause(bot, name) {
    if (bot?.modes && bot.modes.pause) bot.modes.pause(name);
}


/**
 * 往熔炉填料：**先下格燃料，再上格加工物**。
 * 顺序不能反 —— 没燃料时放进去的加工物会被退回来，白折腾一趟。
 */
export async function loadFurnace(bot, furnace, opts = {}) {
    /**
     * Load a furnace: fuel into the bottom slot FIRST, then the input into the top slot.
     * Fuel must come first, otherwise the input just gets returned.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Furnace} furnace, obtained from bot.openFurnace(block).
     * @param {Object} opts, { itemName, num }
     * @returns {Promise<Object>} { ok, reason, fuel, input }
     **/
    const itemName = opts.itemName;
    const num = opts.num ?? 1;

    const winOk = checkWindow(bot, furnace);
    if (!winOk.ok) {
        log(bot, `填料失败：${winOk.message}`);
        return { ok: false, reason: 'window_closed', detail: winOk.message };
    }

    let fuelInfo;
    if (!furnace.fuelItem()) {
        const fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, '没有燃料（需要煤/木炭/木头之类的）。');
            return { ok: false, reason: 'no_fuel' };
        }
        const need = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));
        if (fuel.count < need) {
            log(bot, `燃料不够：要 ${need} 个 ${fuel.name}，只有 ${fuel.count} 个。`);
            return { ok: false, reason: 'not_enough_fuel', fuelName: fuel.name, need, have: fuel.count };
        }
        await furnace.putFuel(fuel.type, null, need);
        fuelInfo = { name: fuel.name, count: need };
        log(bot, `下格加了 ${need} 个 ${fuel.name}。`);
    } else {
        const cur = furnace.fuelItem();
        fuelInfo = { name: mc.getItemName(cur.type), count: cur.count, reused: true };
        log(bot, `下格已有燃料 ${fuelInfo.count}x${fuelInfo.name}，直接复用。`);
    }

    await furnace.putInput(mc.getItemId(itemName), null, num);
    log(bot, `上格放了 ${num} 个 ${itemName}。`);
    return { ok: true, reason: 'loaded', fuel: fuelInfo, input: { name: itemName, count: num } };
}

/**
 * 等熔炉出产物（右格出现东西）。轮询 + 硬超时，不会无限等。
 */
export async function waitForSmelt(bot, furnace, opts = {}) {
    /**
     * Wait until the furnace output slot has something in it. Has a hard timeout.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Furnace} furnace, obtained from bot.openFurnace(block).
     * @param {Object} opts, { timeoutMs }
     * @returns {Promise<Object>} { ok, reason, waitedMs }
     **/
    const timeoutMs = opts.timeoutMs ?? 30000;
    const winOk = checkWindow(bot, furnace);
    if (!winOk.ok) {
        return { ok: false, reason: 'window_closed', waitedMs: 0, detail: winOk.message };
    }
    // 谓词按**原子语义**写：没出产物就返回 undefined（继续等），出了返回 true（完成）。
    // 不能写 `() => !!furnace.outputItem()` —— 那在"还没出"时返回 false，原子层会把
    // false 当已完成，于是"等熔炼"变成"立刻返回 true"（报告 13.3 警告的那一幕）。
    const r = await waitUntil(bot, () => !!furnace.outputItem() || undefined,
        { timeoutMs, intervalMs: 250, label: 'furnace output' });
    return { ok: r.ok, reason: r.ok ? 'output_ready' : r.reason, waitedMs: r.waitedMs };
}

/**
 * 取走熔炉产物（右格）。
 */
export async function takeFromFurnace(bot, furnace) {
    /**
     * Take the smelted output out of an opened furnace.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Furnace} furnace, obtained from bot.openFurnace(block).
     * @returns {Promise<Object>} { ok, reason, item, count }
     **/
    const winOk = checkWindow(bot, furnace);
    if (!winOk.ok) {
        log(bot, `取产物失败：${winOk.message}`);
        return { ok: false, reason: 'window_closed', item: null, count: 0, detail: winOk.message };
    }
    if (!furnace.outputItem()) {
        return { ok: false, reason: 'nothing_to_take', item: null, count: 0 };
    }
    const it = await furnace.takeOutput();
    if (!it) {
        return { ok: false, reason: 'take_failed', item: null, count: 0 };
    }
    const name = mc.getItemName(it.type) || `id:${it.type}`;
    log(bot, `取走产物 ${it.count}x${name}。`);
    return { ok: true, reason: 'taken', item: name, count: it.count };
}


export async function smeltItem(bot, itemName, num=1) {
    /**
     * Smelt items in a furnace, step by step: walk to (or place) a furnace, load fuel into the
     * bottom slot first and the input into the top slot, wait for the output, take it out,
     * and finally verify the top slot really is empty (that is the honest "fully smelted" check).
     * If you only want to inspect the furnace, use skills.furnaceStatus() instead.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the raw item to smelt, e.g. "raw_iron".
     * @param {number} num, how many to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true on success, false otherwise.
     * @example
     * const ok = await skills.smeltItem(bot, "raw_iron", 4);
     **/
    if (!mc.isSmeltable(itemName)) {
            log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
            return false;
    }
    const furnaceRange = 16;
    const inv = world.getInventoryCounts(bot);
    if (!inv[itemName] || inv[itemName] < num) {
            log(bot, `身上只有 ${inv[itemName] || 0} 个 ${itemName}，不够炼 ${num} 个。`);
            return false;
    }

    // ---- 第 1 步：找到熔炉（没有就放一个），走过去 ----
    // ---- 第 1 步：找一个「到得了」的熔炉 ----
    // 注意：ensureNearbyBlock 只保证「附近有」，不保证「到得了」。
    // 实测过她为了一个墙后/水对面的遗留熔炉硬闯 90~180 秒原地打转
    // （pathfinder 报 Path not found 后仍 attempting to navigate anyway），
    // 而她背包里明明有熔炉 —— 所以走不到就自己就地放一个。
    let fr = await ensureNearbyBlock(bot, 'furnace', furnaceRange);
    if (!fr.ok) {
            log(bot, `熔炼 ${itemName} 需要熔炉，但没有可用的（${fr.reason}）。`);
            return false;
    }
    let furnaceBlock = fr.block;
    let placedFurnace = fr.placed;
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        const walk = await goToBlockBounded(bot, furnaceBlock, 4, 15000);
        if (!walk) {
            const haveFurnace = (world.getInventoryCounts(bot).furnace || 0) > 0;
            if (haveFurnace) {
                log(bot, `那个熔炉走不到（${walk.reason}），用背包里的就地放一个。`);
                fr = await ensureNearbyBlock(bot, 'furnace', furnaceRange, { onlyPlace: true });
                if (!fr.ok) {
            log(bot, `就地放熔炉也失败了（${fr.reason}）。`);
            return false;
                }
                furnaceBlock = fr.block;
                placedFurnace = fr.placed;
            } else {
            log(bot, `走不到那个熔炉（${walk.reason}），背包里也没有熔炉可用。`);
            return false;
            }
        }
    }
    modesPause(bot, 'unstuck');
    // 转头走输入原子（一次性，无后置校验，与改前 bot.lookAt 默认 force=false 一致）
    await lookAtPoint(bot, { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z }, { force: false });

    // ★ M6（2026-11-02）：真正的**放料 / 取产物**已上提到 act_craft 的
    //   `furnaceLoad` / `furnaceCollect`（它们自己开关窗口）。本函数现在只留流程职责：
    //   找/放熔炉、等烧完、累计产物、收尾。
    //
    //   行为差异（有意为之，写在这里免得以后当 bug）：
    //   · 每次放料/取产物各自开关一次窗口（原来是开一次窗口做完全程）。本地测试服实测
    //     开箱 ~10ms，可以接受；换来的好处是"熔炉怎么用"只有一份实现。
    //   · "熔炉里在炼别人的东西就不抢"这条保护**没有丢** —— 它搬进了
    //     `act_craft.furnaceLoad`（开窗后读一次输入槽，别人的料就返回 OCCUPIED）。
    //     这条一度被我漏掉（furnaceLoad 不看里面有什么），是 captain 抓出来的真 bug，
    //     已修并有离线用例锁住。
    const closeOnly = async () => {
        try { await closeWindowAtom(bot); } catch (e) { /* ignore */ }
        if (placedFurnace) {
            try { await collectBlock(bot, 'furnace', 1); } catch (e) { /* ignore */ }
        }
    };

    // ---- 第 2 步：放料 + 燃料 ----
    const load = await furnaceLoad(bot, furnaceBlock, itemName, null);
    if (!load.ok) {
        log(bot, `填料失败：${load.code} ${load.message ?? ''}。`);
        await closeOnly();
        return false;
    }

    // ---- 第 3 步：等产物 + 取出来 ----
    let total = 0;
    const taken = new Set();
    const deadline = Date.now() + Math.max(30000, num * 12000);
    let lastProgress = Date.now();
    while (total < num && Date.now() < deadline && !bot.interrupt_code) {
        const c = await furnaceCollect(bot, furnaceBlock);
        if (c.ok) {
            total += Number(c.data?.count ?? 0);
            if (c.data?.taken) taken.add(c.data.taken);
            lastProgress = Date.now();
            continue;
        }
        if (c.code === 'NOT_READY') {
            await new Promise(r => setTimeout(r, 1500));
            // 11 秒没新产物就认为炼不动了（燃料不够/原料被拿走）
            if (Date.now() - lastProgress > 11000) break;
            continue;
        }
        if (c.code === 'INVENTORY_FULL') {
            log(bot, `背包满了，产物取不出来。`);
            break;
        }
        break;
    }
    await closeOnly();

    if (total === 0) {
            log(bot, `一个都没炼出来（${itemName}）。`);
            return false;
    }
    if (total < num) {
            log(bot, `只炼出 ${total}/${num} 个 ${[...taken].join('/')}。`);
            return false;
    }
    log(bot, `炼好了 ${total} 个 ${[...taken].join('/')}。`);
            return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    modesPause(bot, 'cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        modesPause(bot, 'self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    // 第21条：**在 find 之前过滤**。玩家 / 盔甲架 / 掉落物不该是攻击目标，
    // 而 attackNearest 是"按名字找最近的"——不过滤就一定会打到玩家。
    // 判据归 act_attack.isAttackable（唯一真相）。
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType && isAttackable(entity));
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true on success, false otherwise.
     * @example
     * await skills.attackEntity(bot, entity);
     **/
    // 第21条：本函数是"打这个实体"的通用入口，调用方可能直接传一个玩家进来
    // （defendSelf / 模型给的实体 / 任务传入）。所以必须在**动手之前**拦。
    // 拦在 equipHighestAttack / pvp.attack 之前 —— 不然"拒绝"也会先换上武器、先挥一下。
    if (!isAttackable(entity)) {
        log(bot, `Refusing to attack ${entity?.name ?? entity?.type ?? 'that'}: not an attackable entity.`);
        log(bot, `FAILED`);
        return false;
    }
    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        // 挥击 = 鼠标输入，走 atom_input_mouse（旧代码是裸 bot.attack，返回值本来也不用）
        await attackOnce(bot, entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                log(bot, `FAILED`);
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    modesPause(bot, 'self_defense');
    modesPause(bot, 'cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await gotoWithTimeout(bot, new pf.goals.GoalFollow(enemy, 3.5), 8000);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await gotoWithTimeout(bot, inverted_goal, 5000);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true on success, false otherwise.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        log(bot, `INVALID_ARG`);
        return false;
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            // 注意：这个回调会被 findBlocks 对每一个候选方块调用一次。
            // 以前这里写了 log(bot, `FAILED`)，于是每扫过一个非目标方块就打一行，
            // 实测一次采集回灌给模型 229,629 字符的假失败。筛选回调必须没有副作用。
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
        
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        // bot.tool 是 mineflayer-tool 插件挂上去的；裸 bot 没有它。
        // 原来直接 bot.tool.equipForBlock() 会抛
        // "Cannot read properties of undefined (reading 'equipForBlock')"，
        // 而这个异常以前被直接吞成 false，看不出真因。
        // 没有插件时跳过自动换工具，继续用当前手持（后面有 canHarvest 兜底）。
        if (bot.tool && bot.tool.equipForBlock) {
            await bot.tool.equipForBlock(block);
        }
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                log(bot, `MISSING_ITEM`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            log(bot, `MISSING_ITEM`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                // 走到之后用「眼到方块中心」核实真够得着（脚比脚会骗人）：
                // 她站在矿上方/下方 1~2 格时脚看着近，眼睛却碰不到，于是 dig 白跑。
                if (!canReach(bot, block.position)) {
                    // 再贴近一次，容差收到 0 格，尽量站到同一层
                    await goToGoal(bot, new pf.goals.GoalNear(
                        block.position.x, block.position.y, block.position.z, 0)).catch(() => {});
                }
                if (!canReach(bot, block.position)) {
                    const d = reachDistanceTo(bot, block.position);
                    log(bot, `够不着 ${blockType}：眼睛到方块还有 ${d.toFixed(1)} 格` +
                        `（挖掘可达距离 ${digReach().toFixed(1)} 格，与 act_dig 同一判据）。方块在 y=${block.position.y}，你在 y=${Math.floor(bot.entity.position.y)}` +
                        `（眼高 ${(bot.entity.eyeHeight ?? 1.62).toFixed(2)}），需要先挖过去/垫上去。`);
                    break;
                }
                // 挖掘走 holdDig（自带超时/中断/stopDigging）。失败就抛出去，由外层 catch 记一条
                // 「Failed to collect …」再 continue —— 与改前 bot.dig 抛错时的行为一致。
                const dug = await holdDig(bot, block, { timeout: 8000 });
                if (!dug.ok) throw new Error(`${dug.code}: ${dug.message}`);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }
    
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    // 外层也要有上限：单件有 8 秒保护，但如果周围不断有物品（自己丢的、水冲来的），
    // 这个 while 会一直转下去，而它被 mode 以 timeout=-1 调用，等于永久占用动作槽。
    const MAX_ITEMS = 16;
    const TOTAL_BUDGET_MS = 45000;
    const startedAt = Date.now();
    while (nearestItem) {
        if (bot.interrupt_code) {
            log(bot, `Pickup interrupted after ${pickedUp} items.`);
            break;
        }
        if (pickedUp >= MAX_ITEMS) {
            log(bot, `Stopping pickup: reached the ${MAX_ITEMS} item limit for one pass.`);
            break;
        }
        if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
            log(bot, `Stopping pickup: time budget of ${TOTAL_BUDGET_MS / 1000}s used up.`);
            break;
        }
        let movements = new pf.Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        // 单个物品最多追 8 秒。掉落物如果卡在墙里/岩浆里/不可达位置，
        // pathfinder 会无限"重置路径-重试"，导致整个动作永久挂死。
        let item_timer;
        const item_timeout = new Promise(resolve => {
            item_timer = setTimeout(() => {
                try { bot.pathfinder.stop(); } catch { /* ignore */ }
                resolve(false);
            }, 8000);
        });
        try {
            await Promise.race([
                goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1)).catch(() => false),
                item_timeout
            ]);
        } finally {
            clearTimeout(item_timer);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * DESTRUCTIVE: permanently breaks (destroys) the block at the given position. Will use the bot's equipped item.
     * WARNING: this removes the block for good. Do NOT use it to "clear space" before building, and never
     * loop it over a region — that destroys structures and terrain. When building, use
     * skills.placeBlockWithoutBreaking (which never destroys anything) or skills.fillAreaSafely.
     * Also never call it on blocks you or the player placed (planks, glass, chests, doors...).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true on success, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    // ---- 第8条 J4 + 第23条：本函数是**唯一通用拆方块出口**，过去零代码判定 ----
    // 判据用 world_model.isPlayerBuiltBlock（人工材料 + 后缀通配），和 placeBlock 里
    // 那道闸是同一份真相。带前缀的方块名（oak_planks / *_stairs）由它自己通配。
    // 闸放在最前面：作弊分支（/setblock … air）也在它后面，两条路都要过闸。
    //
    // ★ 纪律（报告 13.2）：**不要**把这道闸和下面 levelGround 用的 NATURAL_BLOCKS 合并。
    //   两者语义相反：这里问"它像不像玩家建的"（越像越不许拆）；
    //   NATURAL_BLOCKS 问"它是不是天然地形"（是才允许 /fill 按材质清）。
    //   合并成一套判定就会复活 world_model.js 记录过的真实 bug：
    //   cobblestone 既是最常见的天然裸露方岩、又是玩家会用来盖房的材料，两边判据必须分开。
    if (block && wmIsPlayerBuilt(block.name)) {
        log(bot, `Refusing to break ${block.name} at (${x},${y},${z}): looks player-built. Pick natural terrain, or ask the player to remove it.`);
        log(bot, `REFUSED`);
        return false;
    }
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (modesIsOn(bot, 'cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            // 第29条：斜杠命令只许从 atom_input_misc.command() 出去（白名单 + cheat 显式声明）。
            // 原来是 `bot.chat('/setblock … air')` —— 拼串绕过了白名单，preflight 的
            // slash-command-owner 正则也扫不到（它只认字面量 '/'，见交付说明）。
            const r = await command(bot, 'setblock', [Math.floor(x), Math.floor(y), Math.floor(z), 'air'], { cheat: true });
            if (!r.ok) {
                log(bot, `Failed to /setblock ${block.name} to air at ${x}, ${y}, ${z}: ${r.code}.`);
                log(bot, `FAILED`);
                return false;
            }
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
        return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            // ★ 2026-10-29 修：**不要在这里把搭桥/叠柱子关掉**。
            //
            // 原来这里自己 setMovements 并按死 canPlaceOn=false + allow1by1towers=false，
            // 把她"能挖能搭"的能力剥掉了。实测：树在 (-96,71,-209)、她在 (-89,62,-212)，
            // 高差 9 格 —— 不许叠柱子就永远够不到，
            // `!collectBlocks("木头",4)` 于是卡在原地一动不动（背包一个木头都没拿到）。
            //
            // 现在交给 goToGoal 自己的两档策略：先试"少动地形"，
            // 不行再用"可挖可搭"那档 —— 爬树正好属于后者。
            const pos = block.position;
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
        // bot.tool 是 mineflayer-tool 插件挂上去的；裸 bot 没有它。
        // 原来直接 bot.tool.equipForBlock() 会抛
        // "Cannot read properties of undefined (reading 'equipForBlock')"，
        // 而这个异常以前被直接吞成 false，看不出真因。
        // 没有插件时跳过自动换工具，继续用当前手持（后面有 canHarvest 兜底）。
            if (bot.tool && bot.tool.equipForBlock) {
                await bot.tool.equipForBlock(block);
            }
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                log(bot, `MISSING_ITEM`);
                return false;
            }
        }
        // 挖掘走 holdDig；挖不动/超时就按本函数既有的失败样式报 FAILED 并返回 false
        //（旧代码是裸 bot.dig，失败会抛，函数直接炸 — 这里给出同样的"失败"结论但可归因）
        const dug = await holdDig(bot, block, { timeout: 8000 });
        if (!dug.ok) {
            log(bot, `Failed to break ${block.name}: ${dug.code}.`);
            log(bot, `FAILED`);
            return false;
        }
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        log(bot, `FAILED`);
        return false;
    }
        return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * WARNING: if the target position already contains a DIFFERENT block, that block is BROKEN first and then replaced.
     * When building or remodeling, check the existing blocks at each coordinate before placing, or you will demolish the structure instead of building it.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true on success, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (modesIsOn(bot, 'cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                log(bot, `PLACE_FAILED`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        await command(bot, 'setblock', [Math.floor(x), Math.floor(y), Math.floor(z), blockType], { cheat: true });
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            await command(bot, 'setblock', [Math.floor(x), Math.floor(y + 1), Math.floor(z), `${blockType}[half=upper]`], { cheat: true });
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            await command(bot, 'setblock', [Math.floor(x), Math.floor(y), Math.floor(z - 1), `${blockType}[part=head]`], { cheat: true });
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        log(bot, `MISSING_ITEM`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return true; // 已经是目标方块，算作成功（原来返回 false，会让上层循环误判成失败）
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        // break-then-place：目标格有方块时会先拆掉再放。
        // 这是历史上把一整片 5x5x4 木板结构拆光的根源，所以加两道闸：
        //   1) 玩家建筑（木板/玻璃/砖/箱子等）一律拒绝，绝不拆
        //   2) 只有天然地形才允许拆，避免坐标算错时毁掉已有建筑
        // 统一用 world_model.isPlayerBuiltBlock 判定。
        // 原来这里手写一份清单（还带 cobblestone —— 那是最常见的天然方块之一，
        // 用它判建筑会把裸岩层当成玩家建筑），而且和 heatmap 那份不同步，
        // 导致「放置保护」和「热力图禁行」两处对同一块地给出不同结论。
        const isPlayerBuilt = wmIsPlayerBuilt(targetBlock.name);
        if (isPlayerBuilt) {
            log(bot, `Refusing to place ${blockType} at ${targetBlock.position}: ${targetBlock.name} looks player-built. Pick empty space instead.`);
            log(bot, `REFUSED`);
            return false;
        }
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}, breaking it first.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            log(bot, `PLACE_FAILED`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        log(bot, `PLACE_FAILED`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await gotoWithTimeout(bot, inverted_goal, 15000);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            // 扭头 + 放置都走输入原子；放置失败要抛，让下面的 catch 照旧报 PLACE_FAILED
            const eye = buildOffBlock.position.offset(0.5, 0.5, 0.5);
            await lookAtPoint(bot, { x: eye.x, y: eye.y, z: eye.z }, { force: true });
            const placed = await placeAgainst(bot, buildOffBlock, faceVec);
            if (!placed.ok) throw new Error(placed.message);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
        return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        log(bot, `PLACE_FAILED`);
        return false;
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true on success, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            log(bot, `FAILED`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
        return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    // 原来的 while(true) 在 bot.toss 静默失败时会无限循环（物品没减少、discarded 不增加）。
    // 加一个「连续失败就放弃」的保护。
    let failedRounds = 0;
    while (true) {
        if (failedRounds >= 3) {
            log(bot, `Stopping discard: ${itemName} keeps failing to be tossed.`);
            break;
        }
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        try {
            await bot.toss(item.type, null, to_discard);
        } catch (err) {
            failedRounds++;
            continue;
        }
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

/**
 * 找到「当前应该用的那个箱子」并走过去，打开它。
 * 统一入口，保证 putInChest / takeFromChest / prepareForBuilding 用的是同一个箱子，
 * 不会出现"存进 A 箱子、却跑去 B 箱子取"的情况。
 * @returns {Promise<{container:Object, pos:Object}|null>}
 */
async function openKnownChest(bot, range = 32) {
    const known = landmarks.knownChestsNearest(bot, bot.entity.position);
    for (const c of known) {
        const b = bot.blockAt(new Vec3(c.x, c.y, c.z));
        if (!b || b.name !== 'chest') {
            landmarks.forgetChest(bot, c);
            continue;
        }
        try {
            await goToPosition(bot, c.x, c.y, c.z, 2);
            const container = await bot.openContainer(b);
            return { container, pos: { x: c.x, y: c.y, z: c.z } };
        } catch (err) {
            log(bot, `Could not open remembered chest at (${c.x},${c.y},${c.z}), trying another.`);
        }
    }
    // 记录里没有可用的箱子，退回扫描
    const chest = world.getNearestBlock(bot, 'chest', range);
    if (!chest) return null;
    const pos = { x: chest.position.x, y: chest.position.y, z: chest.position.z };
    try {
        await goToPosition(bot, pos.x, pos.y, pos.z, 2);
        const container = await bot.openContainer(chest);
        landmarks.rememberChest(bot, pos, 'scanned');
        return { container, pos };
    } catch (err) {
        log(bot, `Could not open the nearby chest: ${err}`);
        return null;
    }
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * Uses the chest remembered in landmarks first, so items go to the same chest the bot
     * stored things in before (it remembers where its storage chest is).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    const opened = await openKnownChest(bot, 32);
    if (!opened) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    try {
        await opened.container.deposit(item.type, null, to_put);
        log(bot, `Successfully put ${to_put} ${itemName} in the chest at (${opened.pos.x},${opened.pos.y},${opened.pos.z}).`);
        landmarks.touchChest(bot, opened.pos);
        return true;
    } catch (err) {
        log(bot, `Failed to put ${itemName} in the chest: ${err}`);
        return false;
    } finally {
        try { await opened.container.close(); } catch (err) { /* ignore */ }
    }
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * Uses the chest remembered in landmarks first, so it takes from the same chest it stored to.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    const opened = await openKnownChest(bot, 32);
    if (!opened) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    const chestContainer = opened.container;
    
    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * Uses the chest remembered in landmarks first (the bot's own storage chest).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    const opened = await openKnownChest(bot, 32);
    if (!opened) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    const chestContainer = opened.container;
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    // M6：真实实现是 act_items.eat（它补了"饱食度满了就不吃"的前置，
    // 并返回 ActionResult）。这里保留 boolean 返回给上游。
    const r = await eatAction(bot, itemName || null);
    if (!r.ok) {
        log(bot, `没吃成：${r.code} ${r.message ?? ''}`);
        return false;
    }
    log(bot, `Consumed ${r.data?.food ?? itemName}.`);
    return true;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    // 同上：玩家不在 bot.players 里时会抛 undefined.entity
    const gt_target = bot.players[username];
    let player = gt_target ? gt_target.entity : null;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        // 注意：这个循环**不能**简单换成 waitUntil —— 它每 500ms 还会再推一次
        // moveAwayFromEntity(…5)（玩家跟着走过来时要持续拉开）。
        // 纯等待才适合用 waitUntil；带副作用的循环照旧，别为了统一而改坏行为。
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await lookAtPoint(bot, { x: player.position.x, y: player.position.y, z: player.position.z }, { force: false });
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        // 纯等待（given 只由 playerCollect 事件设置，循环里没有副作用）——
        // 这种就该用 waitUntil，比自己写 while+sleep+算超时短且不会漏写退出条件。
        // 谓词按**原子语义**写：没收到就 undefined（继续等），收到才 true（完成）。
        // `() => given` 在"还没收到"时返回 false，原子层会把 false 当已完成。
        const got = await waitUntil(bot, () => given || undefined,
            { timeoutMs: 3000, intervalMs: 500, label: `${username} received ${itemType}` });
        // 第22条：waitUntil 返回的是**对象** { ok, waitedMs, reason }，永远真值。
        // 原来写 `if (got)`，于是"物品已经 toss 到地上、玩家根本没捡"也报成功。
        // 判据必须是 got.ok —— 这才是"等到了"。
        if (got && got.ok) return true;
        // 没等到确认：交给函数末尾统一报「没收到」，这里不再重复打日志
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

/**
 * 带硬超时的 pathfinder.goto，专用于「动态目标」（追踪实体、躲避敌人）。
 * 这类目标会一直移动，goToGoal 那种静态目标超时逻辑不适用，
 * 但如果不设上限，pathfinder 卡在 resetPath 循环里就会永久挂起。
 * @returns {Promise<boolean>} true 表示到达，false 表示超时或失败
 */
async function gotoWithTimeout(bot, goal, timeoutMs) {
    // 第9条②：这是一次直驱 pathfinder.goto（动态目标那种），包进 nav 闸。
    //   null = 别的任务正拿着导航权 → 老实返回 false（没走过去），不抢 goal。
    const ran = await withNav(bot, () => _gotoWithTimeoutInner(bot, goal, timeoutMs));
    return ran === null ? false : ran;
}

async function _gotoWithTimeoutInner(bot, goal, timeoutMs) {
    let timer = null;
    try {
        await Promise.race([
            bot.pathfinder.goto(goal),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    try { bot.pathfinder.stop(); } catch (err) { /* ignore */ }
                    reject(new Error('goto timeout'));
                }, timeoutMs);
            }),
        ]);
        return true;
    } catch (err) {
        // 超时和「本来就没路」是两件事，混成一个 false 外面没法区分。
        // 这里只补日志（函数仍返回 boolean，契约不变）。
        const msg = err && err.message ? err.message : String(err);
        if (msg === 'goto timeout') {
            log(bot, `寻路超时（${Math.round(timeoutMs / 1000)} 秒没走到），已停止。`);
        } else {
            log(bot, `寻路失败：${msg}`);
        }
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 构造寻路用的 Movements —— 把「地形改造」能力全部打开。
 *
 * 之前的状态（这是她绕远路播的主因）：
 *   canDig = false            挖不了
 *   allow1by1towers = false   垫不上去
 *   scafoldingBlocks 只有库默认的 dirt/cobblestone，而且没有数量限制
 * 于是规划器只能"找现成的路"，遇到山/沟就绕，实测绕行比 1.75~2.15
 * （走 2 倍距离）。而这些地形本来挖两格、搭三块就能过去。
 *
 * 现在：
 *   - 挖：打开，digCost 表达"挖 1 格 ≈ 多走几格"，让 A* 自己权衡挖 vs 绕
 *   - 搭桥/垫脚：打开，材料取背包里真实的方块；**背包没有就关掉**
 *     （pathfinder 的 countScaffoldingItems() 从不被 A* 调用，
 *      所以库本身不会因为材料不够而放弃搭桥 —— 必须我们自己判）
 *   - 安全：不许挖玻璃，也不许挖玩家建筑（她自己的房子）
 */
function buildMovements(bot, opts = {}) {
    const m = new pf.Movements(bot);

    // ---- 挖 ----
    m.canDig = opts.canDig !== false;
    // 挖 1 格大约 0.3~1s，走 1 格约 0.2s。digCost=5 约等于"多走 5 格才值得挖一格"，
    // 这样短距离挖穿比绕一大圈划算，长距离挖隧道仍不如绕路。
    m.digCost = opts.digCost ?? 5;
    m.placeCost = opts.placeCost ?? 3;

    // 不挖璃 / 不挖她的建筑（除非调用方明确放开）
    const cantBreak = ['glass', 'glass_pane'];
    if (!opts.allowPlayerBuilt) {
        cantBreak.push('oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
            'acacia_planks', 'dark_oak_planks', 'crimson_planks', 'warped_planks',
            'stone_bricks', 'bricks', 'chest', 'crafting_table', 'furnace',
            'oak_stairs', 'oak_slab', 'oak_door', 'oak_trapdoor', 'oak_fence');
    }
    for (const name of cantBreak) {
        const id = mc.getBlockId(name);   // mcdata 未初始化时返回 null，跳过
        if (id != null) m.blocksCantBreak.add(id);
    }

    // ---- 搭桥 / 垫脚 ----
    m.allow1by1towers = opts.towers !== false;
    const scaffoldIds = [];
    const had = bot.inventory ? bot.inventory.items() : [];
    // 背包里真实存在、且适合当脚手架的实心方块
    const goodScaffold = /^(dirt|grass_block|cobblestone|stone|andesite|diorite|granite|deepslate|sand|gravel|netherrack|_planks|_log|_slab)$|(_planks|_log)$/;
    for (const it of had) {
        if (goodScaffold.test(it.name)) {
            const id = mc.getBlockId(it.name);
            if (id != null && !scaffoldIds.includes(id)) scaffoldIds.push(id);
        }
    }
    // 库默认的泥土/圆石也留着（万一名字没匹配上）
    for (const name of ['dirt', 'cobblestone']) {
        const id = mc.getBlockId(name);
        if (id != null && !scaffoldIds.includes(id)) scaffoldIds.push(id);
    }
    // 关键：背包一个可放方块都没有时，必须把搭桥关掉 ——
    // 否则 A* 会规划一条它永远搭不出来的桥（pathfinder 不检查数量）。
    const haveBlocks = had.some(it => goodScaffold.test(it.name) && it.count > 0);
    if (haveBlocks) {
        m.scafoldingBlocks = scaffoldIds;
    } else {
        m.scafoldingBlocks = [];
        m.allow1by1towers = false;
    }

    // 危险方块一律不走/不踩：直连寻路时会绕过 heatmap，
    // 必须在这里兜住安全 —— 否则"更快"的代价是踩进岩浆/仙人掌。
    const avoid = ['lava', 'fire', 'soul_fire', 'magma_block', 'campfire',
        'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow'];
    for (const name of avoid) {
        const id = mc.getBlockId(name);
        if (id != null) m.blocksToAvoid.add(id);
    }

    if (opts.parkour !== false) m.allowParkour = true;
    m.dontCreateFlow = true;          // 别把水/岩浆放出来
    m.dontMineUnderFallingBlock = true; // 别在沙/砂砾下面挖（会被埋）
    return m;
}

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     **/
    // 第9条②：整个函数就是"这次由我来驱动导航"，所以整体包进 withNav。
    //   拿不到闸（别的任务正在导航）→ 返回 false（没走过去），而不是硬抢 goal。
    //   注意 withNav 结束时会把 goal 清干净（借了导航就还干净）。
    const r = await withNav(bot, () => _goToGoalBody(bot, goal));
    return r === null ? false : r;
}

async function _goToGoalBody(bot, goal) {
    // 两档，都能改地形，但代价不同 —— 先试"尽量少动地形"的那档：
    //   温和档：挖很贵(digCost=25)、不搭桥  -> 有现成路时优先走现成的
    //   改造档：挖便宜(digCost=5)、可搭桥垫脚 -> 需要抄近路时才挖/搭
    // 这样既不会为了抄近路随地破坏，又不会因为"不许挖"而绕出 2 倍距离。
    const gentle = buildMovements(bot, { digCost: 25, placeCost: 8, towers: false });
    gentle.scafoldingBlocks = [];          // 温和档不搭桥
    const modify = buildMovements(bot, { digCost: 5, placeCost: 3, towers: true });

    let final_movements = modify;
    let finalPath = null;

    const pathfind_timeout = 1000;
    const gentleTry = await bot.pathfinder.getPathTo(gentle, goal, pathfind_timeout);
    if (gentleTry.status === 'success') {
        final_movements = gentle;
        finalPath = gentleTry.path;
        log(bot, `Found non-destructive path.`);
    }
    else {
        const modifyTry = await bot.pathfinder.getPathTo(modify, goal, pathfind_timeout);
        if (modifyTry.status === 'success') {
            // 校验搭桥材料够不够：pathfinder 自身**不检查数量**
            // （countScaffoldingItems() 定义了但 A* 从不调用），
            // 所以它会规划一条需要 100 个方块的桥，而她只有 5 个 —— 走到一半卡死。
            const needPlace = (modifyTry.path || []).reduce((n, node) => n + (node.toPlace ? node.toPlace.length : 0), 0);
            const haveBlocks = modify.countScaffoldingItems ? modify.countScaffoldingItems() : 0;
            const needBreak = (modifyTry.path || []).reduce((n, node) => n + (node.toBreak ? node.toBreak.length : 0), 0);
            if (needPlace > 0 && haveBlocks < needPlace) {
                // 料不够：退回"不搭桥"的档，宁可绕路也别规划一条做不到的路
                log(bot, `需要搭 ${needPlace} 格桥，但只有 ${haveBlocks} 个方块 —— 改用不搭桥的路线（会绕远）。`);
                const noBridge = buildMovements(bot, { digCost: 5, placeCost: 3, towers: false });
                noBridge.scafoldingBlocks = [];
                final_movements = noBridge;
                log(bot, `Found path that digs but does not bridge.`);
            } else {
                finalPath = modifyTry.path;
                log(bot, `Found path that digs/bridges (shorter than any existing route): 挖 ${needBreak} 格、放 ${needPlace} 个。`);
            }
        }
        else {
            log(bot, `Path not found, but attempting to navigate anyway using terrain-modifying movements.`);
        }
    }

    const doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    // 兜底：bot.pathfinder.goto() 在目标不可达时（动态目标如追踪掉落物、
    // 物品卡在方块/岩浆里、地形被破坏等）可能永远不返回。
    // 这会让动作管理器永久卡在 executing=true 状态，表现为
    // "waiting for code to finish executing..." 刷屏、所有命令都不执行，
    // 最终被 10 秒看门狗 cleanKill 杀掉进程。
    // 这里加一个硬上限：超时就停止寻路并抛错，让上层正常收尾。
    const GOTO_HARD_LIMIT_MS = 180000;
    let hardLimitTimer;
    let interruptTimer;
    try {
        await Promise.race([
            bot.pathfinder.goto(goal),
            new Promise((_, reject) => {
                hardLimitTimer = setTimeout(() => {
                    try { bot.pathfinder.stop(); } catch { /* ignore */ }
                    reject(new Error(`goToGoal exceeded ${GOTO_HARD_LIMIT_MS / 1000}s hard limit, pathfinding aborted.`));
                }, GOTO_HARD_LIMIT_MS);
            }),
            // ★★ 第33条：**硬超时 180 秒根本不是"可中断"**。
            //   玩家按 !stop 之后，她最长还要走 3 分钟才动一下 —— 这是"不听指挥"。
            //   原来只有两支：goto 自己 + 180s 上限，全程没人看 `bot.interrupt_code`。
            //   现在加第三支：每 200ms 查一次中断标志，一旦为真就停寻路并按 INTERRUPTED 结束。
            new Promise((_, reject) => {
                interruptTimer = setInterval(() => {
                    if (!bot.interrupt_code) return;
                    try { bot.pathfinder.stop(); } catch { /* ignore */ }
                    const e = new Error('goToGoal interrupted by !stop');
                    e.code = 'INTERRUPTED';
                    reject(e);
                }, 200);
            }),
        ]);
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    } finally {
        clearTimeout(hardLimitTimer);
        clearInterval(interruptTimer);
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    // 定时器里不 await（改前也是裸调不 await）；用 useOnBlock 保证仍只有一个出口
                    void useOnBlock(bot, block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

/**
 * 「够得着」的准确判据。
 *
 * 以前判断"到了没"一律比**脚**的位置，但 Minecraft 的交互距离是从**眼睛**算到
 * 方块中心（约 4.5 格）。mineflayer 自己的 digging.js 也是这么算的：
 *   dy = bot.entity.position.y + bot.entity.eyeHeight - (block.position.y + 0.5)
 *
 * 尺寸（1.21.8，实测 bot.entity 可读）：
 *   身高 1.8、眼高 1.62、宽 0.6
 *
 * 为什么重要：她站在矿上方/下方 1~2 格时，脚-脚差看起来"还行"，
 * 但眼睛到底能不能碰到方块完全是另一回事 —— 这正是"挖矿总是差一点"的来源。
 */
export function eyePosition(bot) {
    return atomEyePosition(bot);
}

/** 眼睛到「方块中心」的距离（方块中心 = 坐标 + 0.5）。**判据只有原子层一份**。 */
export function reachDistanceTo(bot, pos) {
    if (!pos) return Infinity;
    return atomReachDistanceTo(bot, pos);
}

/**
 * 能不能够着这个方块。**薄包装** —— 距离和阈值都取自原子层，本文件不再自带数字。
 *
 * ★ 第20条（2026-11-05 R1 收尾）：这里以前写死一个"4.5 格留 0.2 余量"的阈值
 *   （比原子层少 0.8 格），而原子侧两条可达判据都是 **5.1**：
 *     · `query_perceive.canReach`（距离 + 视线，给右键交互用）
 *     · `act_dig.digBlock`（只看距离，5.1 —— R3-01 实测 6.10 仍能挖，取保守值）
 *   于是同一次"够不着吗"会得到两个答案：模型以为还差 0.8 格就够不着，动作层按 5.1 照样挖。
 *
 * 为什么这里用「只看距离」那条：调用方是挖前预检（见 collectBlock）。
 *   加视线检查会把"隔着树叶的目标"误判成够不着 —— `act_dig.digBlock` 里有实测记录。
 *   阈值来自 `rules.runtime.digReach()`（`dig_reach_usable` = 5.1 的唯一出处，挂 R3-01），
 *   距离来自 `query_perceive.reachDistanceTo` —— 两边都不是这里抄的数字。
 *
 * @param {number} max 可覆盖阈值（默认取规则层 5.1）；需要"留余量"的调用方自己传。
 */
export function canReach(bot, pos, max = digReach()) {
    if (!pos) return false;
    return atomReachDistanceTo(bot, pos) <= max;
}

export async function goToPosition(bot, x, y, z, min_distance = 2) {
    /**
     * Navigate to the given position.
     * Returns { ok, code, message } — codes: MISSING_COORDS / NOT_REACHED / PATH_ERROR.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to.
     * @param {number} y, the y coordinate to navigate to.
     * @param {number} z, the z coordinate to navigate to.
     * @param {number} min_distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true on success, false otherwise.
     * @example
     * const r = await skills.goToPosition(bot, 100, 64, -200);
     * if (!r.ok && r.code === 'NOT_REACHED') { ... }
     **/
    if (x == null || y == null || z == null) {
        log(bot, `缺少坐标：x=${x} y=${y} z=${z}`);
        return false;
    }
    if (modesIsOn(bot, 'cheat')) {
        // ★ S38（同族）：command() 会返回 ActionResult —— 不在白名单 / 被中断 / bot.chat 抛错
        //   都可能失败。过去不看结果就说"传送了"，现在如实返回。
        const tp = await command(bot, 'tp', ['@s', x, y, z], { cheat: true });
        if (!tp.ok) {
            log(bot, `传送失败（${tp.code}）：${tp.message ?? ''}`);
            log(bot, `FAILED`);
            return false;
        }
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }

    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                void stopDig(bot);
            }
        }
    };

    const progressInterval = setInterval(checkDigProgress, 1000);
    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance + 1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        log(bot, `没走到 (${x},${y},${z})，还差 ${Math.round(distance)} 格。`);
        return false;
    } catch (err) {
        log(bot, `寻路中断：${err.message}`);
        return false;
    } finally {
        // 用 finally 保证一定清掉进度轮询（原来 reached/failed 分支各清一次，容易漏）
        clearInterval(progressInterval);
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    // ★ S38：过去忽略 goToPosition 返回值、恒 `return true` —— 走不到也报成功，
    //   失败点被推给下一步（下一步只看到"上一步成功了"）。如实返回。
    return await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    // ★ S38：同 goToNearestBlock —— 如实返回"有没有走到"。
    return await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Walk to a player and actually end up looking at them.
     * Unlike a plain GoalFollow, this verifies the player is really in sight at the end
     * (a GoalFollow only checks straight-line distance, so the bot can "arrive" while
     * standing on the player's roof or on the other side of a wall) and turns to face them.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, how close to get. Defaults to 3.
     * @returns {Promise<boolean>} true on success, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (modesIsOn(bot, 'cheat')) {
        const tp = await command(bot, 'tp', ['@s', username], { cheat: true });
        if (!tp.ok) {
            log(bot, `传送失败（${tp.code}）：${tp.message ?? ''}`);
            log(bot, `FAILED`);
            return false;
        }
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    modesPause(bot, 'self_defense');
    modesPause(bot, 'cowardice');
    // 同上：玩家不在 bot.players 里时会抛 undefined.entity
    const gp_target = bot.players[username];
    let player = gp_target ? gp_target.entity : null;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        log(bot, `NOT_FOUND`);
        return false;
    }

    distance = Math.max(distance, 0.5);

    // 最多试 3 轮：GoalFollow 的 isEnd 只看 3D 直线距离，
    // 玩家在头顶/脚下/墙后时也会被判"到达"，所以每轮都要复核。
    for (let attempt = 1; attempt <= 3; attempt++) {
        // 玩家位置可能在走，每轮重新取
        const cur = bot.players[username]?.entity;
        if (!cur) {
            log(bot, `Lost sight of ${username} while walking over.`);
            log(bot, `FAILED`);
            return false;
        }
        await goToGoal(bot, new pf.goals.GoalFollow(cur, distance), true);

        const me = bot.entity.position;
        const pp = cur.position;
        const dxz = Math.hypot(me.x - pp.x, me.z - pp.z);
        const dy = Math.abs(me.y - pp.y);

        // 判定「真的到了」：水平够近 + 高度接近（不隔楼层）
        const horizontallyClose = dxz <= distance + 1.5;
        const verticallyClose = dy <= 1.5;

        if (horizontallyClose && verticallyClose) {
            // 转身看向玩家，这样她抬头就能看到（lookAt 无返回值）
            try {
                const headHeight = cur.height ? cur.height * 0.9 : 1.6;
                await lookAtPoint(bot, { x: pp.x, y: pp.y + headHeight, z: pp.z }, { force: false });
            } catch (err) { /* 看向失败不影响结果 */ }
            log(bot, `Reached ${username} at (${Math.floor(pp.x)},${Math.floor(pp.y)},${Math.floor(pp.z)}), ` +
                `horizontal ${dxz.toFixed(1)} blocks away, height diff ${dy.toFixed(1)}.`);
        return true;
        }

        // 没到位：根据差在哪个方向，说明原因并再试
        if (!verticallyClose) {
            log(bot, `Got within reach but at a different height (${dy.toFixed(1)} blocks). ` +
                `The player may be on another floor or up a hill - trying again (${attempt}/3).`);
        } else {
            log(bot, `Still ${dxz.toFixed(1)} blocks away horizontally - trying again (${attempt}/3).`);
        }
    }

    const pp = bot.players[username]?.entity?.position;
    if (pp) {
        log(bot, `Could not get right next to ${username}. They are around ` +
            `(${Math.floor(pp.x)},${Math.floor(pp.y)},${Math.floor(pp.z)}) - ` +
            `maybe blocked by a wall, or they are on a different floor.`);
    } else {
        log(bot, `Could not get to ${username}.`);
    }
    log(bot, `FAILED`);
    return false;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot actually moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position.clone();
    const goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    const inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (modesIsOn(bot, 'cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length - 1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            await command(bot, 'tp', ['@s', x, y, z], { cheat: true });
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    const moved = pos.distanceTo(new_pos);
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    // 原来无论走没走成都返回 true —— 现在几乎没位移就如实报失败（可能被围住）。
    if (moved < 1) {
        log(bot, `想走开 ${distance} 格，但实际只移动了 ${moved.toFixed(1)} 格（可能被围住）。`);
        return false;
    }
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    // ★ S38：过去忽略 gotoWithTimeout 的布尔结果、恒 `return true`。
    //   走不到（目标不可达 / 超时 / 导航被别的任务占用）也会报"我已经躲开了"，
    //   上层于是以为安全距离已经拉开。如实返回。
    const moved = await gotoWithTimeout(bot, inverted_goal, 15000);
    if (!moved) {
        log(bot, `没能远离 ${entity?.name ?? entity?.type ?? '那个实体'}（寻路失败/超时）。`);
        log(bot, `FAILED`);
    }
    return moved;
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    modesPause(bot, 'self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted.
     *
     * ★ 2026-11-01（M2，07 §3.2）：**不再停 `self_preservation`**。
     * 原来这里把 mode 全停了（含保命反射），于是"站着别动"变成了"站着被烧死"——
     * 用户实测：让她 stay，脚下着火她不躲、溺水不上浮、被沙子埋着不动。
     * 现在 "站着别动" 只包括"别去追怪、别跑开"：
     *   - 停：cowardice / self_defense / unstuck / 空闲行为（hunting / torch_placing / item_collecting …）
     *   - 不停：self_preservation（着火 / 溺水 / 挨打要躲，且躲完自己回位）
     * 自动领单与 idle_planner 的暂停不在这里做（那是调度器的事，见 06 §7、08 §6.1）。
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    modesPause(bot, 'unstuck');
    modesPause(bot, 'cowardice');
    modesPause(bot, 'self_defense');
    modesPause(bot, 'hunting');
    modesPause(bot, 'torch_placing');
    modesPause(bot, 'item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            // 必须接住返回值再取 .position —— getNearestBlock 找不到时返回 null，
            // 原来直接 .position 会在『附近没有门』时抛 TypeError（实测复现过），
            // 而本函数声明是『不传坐标就自动找最近的门 + 返回 boolean』，等于承诺与实现不符。
            const b = world.getNearestBlock(bot, door_type, 16);
            door_pos = b && b.position ? b.position : null;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving() && !bot.interrupt_code) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    // door_block 可能是 null：门被拆了、坐标给错了、或者区块未加载。
    // 直接 ._properties 会抛 TypeError（和上面 getNearestBlock 那个是同一类 null 解引用）。
    let door_block = bot.blockAt(door_pos);
    await lookAtPoint(bot, { x: door_pos.x, y: door_pos.y, z: door_pos.z }, { force: false });
    if (!door_block) {
        log(bot, `这里 (${Math.floor(door_pos.x)},${Math.floor(door_pos.y)},${Math.floor(door_pos.z)}) 没有方块，用不了门。`);
        return false;
    }
    if (!door_block.name || !door_block.name.endsWith('door')) {
        log(bot, `这里不是门，是 ${door_block.name}。`);
        return false;
    }

    const wasOpen = !!(door_block._properties && door_block._properties.open);
    if (!wasOpen) await useOnBlock(bot, door_block);

    // 穿过去
    // 2026-11-01（Phase A.1）：按键走 atom_input_move.pressKey（到时必松，try/finally）
    await pressKey(bot, 'forward', 600);

    // 关门：只有门还在伸手可及范围（4.5 格）才关得动。
    // 原来不看距离就 activateBlock，走过之后超出距离会静默失败 ——
    // 实测现象就是"用完了门一直开着"，和注释写的"开->走过去->再关"不符。
    const still = bot.blockAt(door_pos);
    if (!still || !still.name || !still.name.endsWith('door')) {
        log(bot, `用过门了，但它已经不在了。`);
        return true;
    }
    const reach = bot.entity.position.distanceTo(door_pos);
    if (reach <= 4) {
        await useOnBlock(bot, still);
        // 关完等一会儿再回读：服务端的方块更新不是同步到达的，
        // 立刻读会拿到旧的 open 状态，从而误报"关门没成功"。
        await new Promise((r) => setTimeout(r, 300));
        const final = bot.blockAt(door_pos);
        const nowOpen = !!(final && final._properties && final._properties.open);
        log(bot, `用过门了，${nowOpen ? '但它还开着（关门没成功）' : '已关回去'}。`);
    } else {
        log(bot, `用过门了，门还开着（离了 ${reach.toFixed(1)} 格，够不到去关）。`);
    }
    log(bot, `Used door at ${door_pos}.`);

    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    modesPause(bot, 'unstuck');
    // 第33条：这个 while 过去只看 isSleeping —— 玩家按 !stop 之后照样睡到天亮。
    while (bot.isSleeping && !bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (modesIsOn(bot, 'cheat')) {
        // ★ S39：`seedType` 默认就是 null（JSDoc 明写"Defaults to none, which will only
        //   till the ground"），而这里过去无条件 `seedType.endsWith(...)` →
        //   **按文档的默认用法调用必抛 TypeError: Cannot read properties of null**。
        //   现在 null 就只耕地、不播种，与 JSDoc 承诺一致。
        let to_remove = ['_seed', '_seeds'];
        if (seedType) {
            for (let remove of to_remove) {
                if (seedType.endsWith(remove)) {
                    seedType = seedType.replace(remove, '');
                }
            }
        }
        // ★ 第10条附带的浮空 promise（报告点名的 39 条里属于本文件的 2 条）：
        //   这两句过去**没有 await** —— 于是 `tillAndSow` 在方块还没放上去时就 `return true`，
        //   放失败（没材料 / 没权限 / 位置被占）也完全看不见。
        //   现在逐句 await 并把失败如实报出来。
        if (!(await placeBlock(bot, 'farmland', x, y, z))) {
            log(bot, `Failed to place farmland at ${x}, ${y}, ${z}.`);
            log(bot, `PLACE_FAILED`);
            return false;
        }
        if (!seedType) {
            // 只耕地，不播种 —— 这就是 seedType 缺省时的语义
            log(bot, `Tilled (cheat) at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}, nothing planted.`);
            return true;
        }
        if (!(await placeBlock(bot, seedType, x, y + 1, z))) {
            log(bot, `Failed to plant ${seedType} at ${x}, ${y + 1}, ${z}.`);
            log(bot, `PLACE_FAILED`);
            return false;
        }
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!(await equip(bot, to_equip))) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await useOnBlock(bot, block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await useOnBlock(bot, block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await useOnBlock(bot, block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            modesPause(bot, 'unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            modesUnpause(bot, 'unstuck');
        }
    }
    
    return entity;
}

export async function showVillagerTrades(bot, id) {
    /**
    * Show available trades for a specified villager
    * @param {MinecraftBot} bot - reference to the minecraft bot
    * @param {number} id - the entity id of the villager to show trades for
    * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
    * @example
    * await skills.showVillagerTrades(bot, "123");
     **/
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

export async function tradeWithVillager(bot, id, index, count) {
    /**
    * Trade with a specified villager
    * @param {MinecraftBot} bot - reference to the minecraft bot
    * @param {number} id - the entity id of the villager to trade with
    * @param {number} index - the index (1-based) of the trade to execute
    * @param {number} count - how many times to execute the trade (optional)
    * @returns {Promise<boolean>} true if trade was successful, false otherwise
    * @example
    * await skills.tradeWithVillager(bot, "123", "1", "2");
     **/
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/
    // ★ S41：`bot.blockAt(...)` 在区块没加载时返回 **null**，原来的 `.position` 会直接
    //   TypeError 抛出去。而且下一段把"读不到方块"当成"到世界尽头"并 `return true`——
    //   那是最坏的一种假成功：她其实被困在未加载的区块里，上层却以为已经挖到底了。
    const startBlock = bot.blockAt(bot.entity.position);
    if (!startBlock || !startBlock.position) {
        log(bot, `Cannot dig down: the block under my feet is not loaded (${bot.entity.position}).`);
        log(bot, `FAILED`);
        return false;
    }
    let start_block_pos = startBlock.position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i - 1, 0));

        if (!targetBlock || !belowBlock) {
            // 区分两种原因：真的到世界底部（y<=最低层）还是仅仅"区块没加载"。
            const wantY = start_block_pos.y - i;
            const isWorldFloor = wantY < -64;
            log(bot, isWorldFloor
                ? `Dug down ${i - 1} blocks, reached the bottom of the world (y=${wantY}).`
                : `Dug down ${i - 1} blocks, but the block at y=${wantY} is not loaded (chunk not available) — cannot continue.`);
            log(bot, `FAILED`);
            // 到世界底部算"已经挖到底"（原语义），未加载则如实失败。两者都不再统一报 true。
            return isWorldFloor;
        }

        if (targetBlock.name === 'lava' || targetBlock.name === 'water' ||
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            // 报清楚到底哪一格是危险液体：原来固定报 belowBlock，
            // 如果危险的是 targetBlock 自己，消息就会说成下面那格（实测把 lava 报成 stone）。
            const dangerBlock = (targetBlock.name === 'lava' || targetBlock.name === 'water')
                ? targetBlock : belowBlock;
            log(bot, `Dug down ${i - 1} blocks, but reached ${dangerBlock ? dangerBlock.name : '(lava/water)'}`);
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i - 1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `Going to the surface at y=${y+1}.`);``
        return true;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    // 第28条：原来写 `!bot.game.gameMode === 'creative'` —— `!x` 先算成布尔，
    // 布尔永远不等于字符串 'creative'，整个条件恒假，于是"没有这件工具"的早退永不执行，
    // 后面 equip/useHeld 拿着不存在的物品去用。改成 !== 才是在比较。
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && bot.game.gameMode !== 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await useHeld(bot);
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await lookAtPoint(bot, { x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5 }, { force: false });

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await lookAtPoint(bot, { x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5 }, { force: false });
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await useHeld(bot);
    }
    else {
        await useOnBlock(bot, block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }


// ==================== 建造前准备 + 安全建造 ====================
// 背景：placeBlock 是"先拆后放"，在已有方块上建造会把建筑拆光。
// 下面这组函数只往空气/可替换位置放方块，永不调用 breakBlockAt。

// 建造时可以直接覆盖、不需要拆的方块
const BUILD_REPLACEABLE = new Set([
    'air', 'cave_air', 'void_air', 'water',
    'short_grass', 'tall_grass', 'fern', 'large_fern', 'grass', 'dead_bush', 'snow',
    'vine', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
    'cornflower', 'lily_of_the_valley', 'torch', 'wall_torch', 'redstone_torch'
]);

function countInventoryItem(bot, itemName) {
    let total = 0;
    for (const item of bot.inventory.items()) {
        if (item.name === itemName) total += item.count;
    }
    return total;
}

export async function placeBlockWithoutBreaking(bot, blockType, x, y, z) {
    /**
     * SAFE block placement: places a block ONLY into empty/replaceable space.
     * If something else already occupies the target position, it is SKIPPED, never destroyed.
     * This is the correct choice for building houses, walls, floors and decorating.
     * Use skills.placeBlock only when you actually intend to clear/replace a block.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the block to place, e.g. "oak_planks".
     * @param {number} x, the x coordinate to place at.
     * @param {number} y, the y coordinate to place at.
     * @param {number} z, the z coordinate to place at.
     * @returns {Promise<string>} 'placed' if it was placed and verified, 'exists' if the same block is already there,
     *          'blocked' if another block occupies the spot (nothing was broken), 'failed' if placement failed,
     *          'unknown' if the block could not be read.
     * @example
     * const r = await skills.placeBlockWithoutBreaking(bot, "oak_planks", 100, 64, 200);
     * // r === 'blocked' means something is there; pick another spot instead of destroying it.
     **/
    // 只往空气/可替换方块里放；已有其他方块一律跳过，绝不拆
    const target = bot.blockAt(new Vec3(x, y, z));
    if (!target) return 'unknown';
    if (target.name === blockType) return 'exists';
    if (!BUILD_REPLACEABLE.has(target.name)) {
        log(bot, `Skip (${x},${y},${z}): ${target.name} is in the way, not breaking it.`);
        return 'blocked';
    }
    let ok = false;
    try {
        ok = await placeBlock(bot, blockType, x, y, z, 'bottom');
    } catch (err) {
        return 'failed';
    }
    // placeBlock 返回的是布尔值（true/false）。这里原来写的是 `!ok.ok`，
    // 而 true.ok 是 undefined，于是永远 return 'failed' ——
    // 方块放好了也报失败。这就是「字段不统一」已经造成的真实 bug。
    if (ok !== true) return 'failed';
    await new Promise(resolve => setTimeout(resolve, 60));
    const after = bot.blockAt(new Vec3(x, y, z));
    return (after && after.name === blockType) ? 'placed' : 'failed';
}

// ---------------------------------------------------------------------------
// 储物箱保障：找到 / 造出 / 放下一个可用的箱子
// ---------------------------------------------------------------------------

// 站到方块旁边能放箱子的垂直偏移：优先和她同层，其次上一格
const CHEST_SIDE_OFFSETS = [
    // 侧后方：优先，不挡正前方视线和走位（对应设计里的 3B）
    [-1, 0, 1], [1, 0, 1], [-1, 0, 0], [1, 0, 0],
    [-1, 0, -1], [1, 0, -1], [0, 0, 1], [0, 0, -1],
];

function blockNameAt(bot, pos) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    return b ? b.name : null;
}

function isChestBlock(bot, pos) {
    return blockNameAt(bot, pos) === 'chest';
}

/**
 * 验证一个记录的箱子是否还在原处。返回 true 表示可以放心走过去。
 */
function chestStillValid(bot, pos) {
    const n = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    return !!n && n.name === 'chest';
}

/**
 * 在 bot 侧后方找一个能放箱子的位置。
 * 要求：目标格是空气/可替换、脚下方块实心、且不会把 bot 自己困住。
 * @returns {{x:number,y:number,z:number}|null}
 */
function findChestSpot(bot) {
    const p = bot.entity.position.floored();
    for (const [dx, dy, dz] of CHEST_SIDE_OFFSETS) {
        const tx = p.x + dx, ty = p.y + dy, tz = p.z + dz;
        const target = bot.blockAt(new Vec3(tx, ty, tz));
        if (!target) continue;
        // 放箱子必须是纯空气：草/水/雪这类"可替换"方块会让箱子悬空或被冲掉
        if (target.name !== 'air' && target.name !== 'cave_air') continue;
        // 上方要留一格空气，箱子才放得下（否则会被判定为阻塞）
        const above = bot.blockAt(new Vec3(tx, ty + 1, tz));
        if (above && above.name !== 'air' && above.name !== 'cave_air') continue;
        // 下方必须有实心方块可依附
        const below = bot.blockAt(new Vec3(tx, ty - 1, tz));
        if (!below || below.boundingBox !== 'block') continue;
        return { x: tx, y: ty, z: tz };
    }
    return null;
}

/**
 * 拿到一个可用的箱子。按这个顺序尝试：
 *   1) landmarks 里记录过、且实地验证还在的箱子（最近的优先）
 *   2) 附近 32 格扫描到的箱子
 *   3) 背包里有 chest → 直接放
 *   4) 木板够 → 先做 chest 再放
 *   5) 都不行 → 返回失败原因（不丢弃任何东西）
 *
 * @param {MinecraftBot} bot
 * @param {Object|null} near 参考点（通常是工地），决定"就近优先"
 * @returns {Promise<{ok:boolean, chest?:Object, via?:string, reason?:string}>}
 */
async function ensureChest(bot, near = null) {
    // ---- 1) 已知箱子：先验证方块还在，避免白走一趟 ----
    const known = landmarks.knownChestsNearest(bot, near || bot.entity.position);
    for (const c of known) {
        if (!chestStillValid(bot, c)) {
            log(bot, `Recorded chest at (${c.x},${c.y},${c.z}) is gone, forgetting it.`);
            landmarks.forgetChest(bot, c);
            continue;
        }
        log(bot, `Using remembered chest at (${c.x},${c.y},${c.z}).`);
        return { ok: true, chest: { x: c.x, y: c.y, z: c.z }, via: 'remembered' };
    }

    // ---- 2) 附近扫描 ----
    const scanned = world.getNearestBlock(bot, 'chest', 32);
    if (scanned) {
        const pos = { x: scanned.position.x, y: scanned.position.y, z: scanned.position.z };
        landmarks.rememberChest(bot, pos, 'scanned');
        log(bot, `Found existing chest nearby at (${pos.x},${pos.y},${pos.z}).`);
        return { ok: true, chest: pos, via: 'scanned' };
    }

    // ---- 3) 背包里有 chest，直接放 ----
    let haveChest = countInventoryItem(bot, 'chest') > 0;

    // ---- 4) 没有就现做一个（需要 8 个木板，任意木板都行）----
    if (!haveChest) {
        const plank = bot.inventory.items().find(i => i.name.endsWith('_planks'));
        if (plank) {
            const plankCount = bot.inventory.items()
                .filter(i => i.name.endsWith('_planks'))
                .reduce((a, i) => a + i.count, 0);
            if (plankCount >= 8) {
                log(bot, `No chest in inventory, crafting one from ${plankCount} planks.`);
                const crafted = await craftRecipe(bot, 'chest', 1);
                haveChest = crafted && countInventoryItem(bot, 'chest') > 0;
                if (!haveChest) {
                    return { ok: false, reason: 'craft_failed', detail: '尝试用木板合成箱子但失败了（可能缺工作台或配方不可用）。' };
                }
            } else {
                return {
                    ok: false, reason: 'no_materials_for_chest',
                    detail: `背包里没有箱子，木板也只有 ${plankCount} 个（做箱子需要 8 个）。`
                };
            }
        } else {
            return {
                ok: false, reason: 'no_chest_no_planks',
                detail: '背包里既没有箱子，也没有任何木板，做不出箱子。'
            };
        }
    }

    // ---- 放箱子：选她侧后方，避开正前方 ----
    const spot = findChestSpot(bot);
    log(bot, 'Trying to place a chest next to the build site.');
    let placed = null;
    if (spot) {
        const r = await placeBlockWithoutBreaking(bot, 'chest', spot.x, spot.y, spot.z);
        if (r === 'placed' || r === 'exists') placed = spot;
        else log(bot, `Could not place chest at (${spot.x},${spot.y},${spot.z}): ${r}.`);
    }
    if (!placed) {
        // 退而求其次：用通用自由空间（可能挡路，但总比没有强）
        try {
            const free = world.getNearestFreeSpace(bot, 1, 6);
            if (free) {
                const r2 = await placeBlockWithoutBreaking(bot, 'chest', free.x, free.y, free.z);
                if (r2 === 'placed' || r2 === 'exists') placed = { x: free.x, y: free.y, z: free.z };
            }
        } catch (err) { /* 忽略，下面统一报错 */ }
    }
    if (!placed) {
        return { ok: false, reason: 'no_spot', detail: '找不到能放箱子的位置（周围没有可依附的实心方块或空间不足）。' };
    }

    landmarks.rememberChest(bot, placed, 'placed_by_bot');
    log(bot, `Placed and remembered a new chest at (${placed.x},${placed.y},${placed.z}).`);
    return { ok: true, chest: placed, via: 'placed' };
}

/**
 * 把不需要的材料存进箱子，直到腾出足够格子。
 */
async function stashUnneeded(bot, chestPos, keep, minFreeSlots) {
    await goToPosition(bot, chestPos.x, chestPos.y, chestPos.z, 2);
    const chestBlock = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
    if (!chestBlock || chestBlock.name !== 'chest') {
        return { ok: false, stashed: [], reason: 'chest_gone' };
    }
    let container;
    try {
        container = await bot.openContainer(chestBlock);
    } catch (err) {
        return { ok: false, stashed: [], reason: 'open_failed', detail: String(err) };
    }
    const stashed = [];
    try {
        const items = [...bot.inventory.items()];
        for (const item of items) {
            if (keep.has(item.name)) continue;
            if (bot.inventory.emptySlotCount() >= minFreeSlots) break;
            try {
                // ★ S40：过去**先** push 再 deposit，deposit 失败也照样记账
                //   —— 这是"意图即成功"（第22条 giveToPlayer 那一族的第 4 处）。
                //   现在按**背包实际少掉多少**记账，没真挪走就不算 stash。
                const before = countInventoryItem(bot, item.name);
                await container.deposit(item.type, null, item.count);
                const after = countInventoryItem(bot, item.name);
                const moved = Math.max(0, before - after);
                if (moved > 0) stashed.push(`${moved} ${item.name}`);
            } catch (err) { /* 单件失败不影响整体 */ }
        }
    } finally {
        try { await container.close(); } catch (err) { /* ignore */ }
    }
    landmarks.touchChest(bot, chestPos);
    // ★ S40：`ok` 也要按实际结果。什么都没挪走（箱子满/开不了格）就不是成功。
    return { ok: stashed.length > 0, stashed };
}

export async function prepareForBuilding(bot, required = {}, minFreeSlots = 3, near = null) {
    /**
     * Building pre-check. MUST be called before building a house.
     * Checks materials and inventory space, and when the inventory is too full it
     * automatically finds, crafts or places a chest, stores the unneeded items there,
     * and remembers where that chest is (saved to diskso it survives restarts).
     *
     * Order of actions:
     *   1) report missing materials (does not abort the later steps)
     *   2) if enough free slots -> done
     *   3) otherwise obtain a chest: remembered one -> nearby scan -> place from inventory -> craft -> fail
     *   4) store everything that is NOT in `required`
     * It NEVER throws items away; if there is no chest and no way to make one, it reports why.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} required, materials needed, e.g. { oak_planks: 60, oak_door: 1 }
     * @param {number} minFreeSlots, how many free slots building needs. Defaults to 3.
     * @param {Object} near, optional position of the build site, used to pick the nearest chest.
     * @returns {Promise<Object>} {ok, missing, freeSlots, chest, stashed, reason}
     * @example
     * const r = await skills.prepareForBuilding(bot, { oak_planks: 60 }, 3, {x:-170,y:64,z:-274});
     * if (!r.ok) log(bot, 'Cannot build yet: ' + r.reason);
     **/
    const keep = new Set(Object.keys(required || {}));

    // ---- 步骤 1：清点材料（只记账，不阻断腾格子）----
    const missing = [];
    for (const [name, need] of Object.entries(required || {})) {
        const have = countInventoryItem(bot, name);
        if (have < need) missing.push(`${need - have} more ${name} (have ${have}/${need})`);
    }
    if (missing.length) {
        log(bot, `Not enough materials for the build: ${missing.join(', ')}.`);
    }

    // ---- 步骤 2：格子够就直接放行 ----
    let free = bot.inventory.emptySlotCount();
    log(bot, `Free inventory slots: ${free}.`);
    if (free >= minFreeSlots) {
        return {
            ok: missing.length === 0, missing,
            freeSlots: free, chest: null, stashed: [], reason: missing.length ? 'missing_materials' : 'ready',
        };
    }

    // ---- 步骤 3：需要腾格子，先保证有箱子 ----
    log(bot, `Inventory too full (${free} free slots, need ${minFreeSlots}). Getting a chest.`);
    const chestRes = await ensureChest(bot, near);
    if (!chestRes.ok) {
        log(bot, `Cannot free up inventory space: ${chestRes.detail}`);
        return {
            ok: false, missing, freeSlots: free, chest: null, stashed: [],
            reason: chestRes.reason, detail: chestRes.detail,
        };
    }

    // ---- 步骤 4：存东西 ----
    const stashRes = await stashUnneeded(bot, chestRes.chest, keep, minFreeSlots);
    if (!stashRes.ok) {
        log(bot, `Could not store items in the chest (${stashRes.reason}).`);
        return {
            ok: false, missing, freeSlots: bot.inventory.emptySlotCount(),
            chest: chestRes.chest, stashed: [], reason: stashRes.reason,
        };
    }
    if (stashRes.stashed.length) log(bot, `Stored in the chest: ${stashRes.stashed.join(', ')}.`);

    free = bot.inventory.emptySlotCount();
    log(bot, `Free inventory slots now: ${free}.`);

    if (missing.length) {
        log(bot, `Still missing materials, go gather or craft them first: ${missing.join(', ')}.`);
    }
    return {
        ok: free >= minFreeSlots && missing.length === 0,
        missing,
        freeSlots: free,
        chest: chestRes.chest,
        chestVia: chestRes.via,
        stashed: stashRes.stashed,
        reason: missing.length ? 'missing_materials'
            : (free < minFreeSlots ? 'still_full' : 'ready'),
    };
}

export async function fillAreaSafely(bot, blockType, x1, y1, z1, x2, y2, z2) {
    /**
     * Fill a solid box region with one block type, ONLY into empty or replaceable space.
     * It NEVER breaks blocks: any position already holding a different block is skipped.
     * Use this for floors, walls, roofs and repairs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the block to place, e.g. "oak_planks".
     * @param {number} x1, y1, z1, one corner of the region.
     * @param {number} x2, y2, z2, the opposite corner of the region.
     * @returns {Promise<Object>} counts: {placed, exists, blocked, failed}
     * @example
     * await skills.fillAreaSafely(bot, "oak_planks", -180, 64, -270, -176, 64, -266);
     **/
    const ax = Math.floor(Math.min(x1, x2)), bx = Math.floor(Math.max(x1, x2));
    const ay = Math.floor(Math.min(y1, y2)), by = Math.floor(Math.max(y1, y2));
    const az = Math.floor(Math.min(z1, z2)), bz = Math.floor(Math.max(z1, z2));
    const stats = { placed: 0, exists: 0, blocked: 0, failed: 0 };
    for (let y = ay; y <= by; y++) {
        for (let x = ax; x <= bx; x++) {
            for (let z = az; z <= bz; z++) {
                if (bot.interrupt_code) {
                    log(bot, `Interrupted while filling. ${JSON.stringify(stats)}`);
                    return stats;
                }
                const r = await placeBlockWithoutBreaking(bot, blockType, x, y, z);
                if (stats[r] !== undefined) stats[r]++;
            }
        }
    }
    log(bot, `fillAreaSafely done: ${stats.placed} placed, ${stats.exists} already there, ${stats.blocked} skipped (occupied), ${stats.failed} failed.`);
    return stats;
}

export async function findFlatBuildingSpot(bot, width = 5, depth = 5, height = 2, radius = 12) {
    /**
     * Find a clear, flat place to build a house without having to clear anything.
     * Scans outward from the bot and returns the first spot where EVERY position the house
     * would occupy (floor, walls, roof) is air or a replaceable plant, and the ground below
     * the floor is solid. Use this INSTEAD of breaking blocks to make room.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} width, house size along x. Defaults to 5.
     * @param {number} depth, house size along z. Defaults to 5.
     * @param {number} height, interior wall height. Defaults to 2.
     * @param {number} radius, how far to search. Defaults to 12.
     * @returns {Promise<Object|null>} {x, y, z} of the floor's minimum corner, or null if none found.
     * @example
     * const spot = await skills.findFlatBuildingSpot(bot, 5, 5, 2);
     * if (spot) {
     *     await skills.prepareForBuilding(bot, { oak_planks: 90 });
     *     await skills.buildHouse(bot, "oak_planks", spot.x, spot.y, spot.z, 5, 5, 2);
     * }
     **/
    width = Math.max(3, Math.floor(width));
    depth = Math.max(3, Math.floor(depth));
    height = Math.max(2, Math.floor(height));
    const p = world.getPosition(bot);
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);

    const solidGround = new Set(['air', 'water', 'lava', 'cave_air', 'void_air']);
    const clearCheck = (x, y, z) => {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) return false;
        return BUILD_REPLACEABLE.has(b.name);
    };

    let best = null;
    for (let r = 0; r <= radius && !best; r++) {
        for (let dx = -r; dx <= r && !best; dx++) {
            for (let dz = -r; dz <= r && !best; dz++) {
                // 只扫当前环（由近到远）
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const x0 = bx + dx, z0 = bz + dz;
                // 地板层 y、墙 y+1..y+height、屋顶 y+height+1 全部要空
                let ok = true;
                for (let ix = 0; ix < width && ok; ix++) {
                    for (let iz = 0; iz < depth && ok; iz++) {
                        const g = bot.blockAt(new Vec3(x0 + ix, by - 1, z0 + iz));
                        if (!g || solidGround.has(g.name)) { ok = false; break; }
                        for (let iy = 0; iy <= height + 1 && ok; iy++) {
                            if (!clearCheck(x0 + ix, by + iy, z0 + iz)) ok = false;
                        }
                    }
                }
                if (ok) best = { x: x0, y: by, z: z0 };
            }
        }
    }
    if (best) {
        log(bot, `Found a clear building spot at ${best.x},${best.y},${best.z} (${width}x${depth}, no clearing needed).`);
    } else {
        log(bot, `No clear ${width}x${depth} building spot within ${radius} blocks. Walk somewhere flatter instead of breaking blocks.`);
    }
    return best;
}

export async function findBuildingSite(bot, size = 50, searchRadius = 40) {
    /**
     * Automatically pick the flattest, most open place near the bot to build on.
     * Samples the terrain around the bot and scores each candidate region by how flat
     * its surface is, returning the best spot plus the target ground level.
     * Use this first, then skills.levelGround(...) to flatten it, then skills.buildHouse(...).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} size, side length of the region to evaluate. Defaults to 50.
     * @param {number} searchRadius, how far from the bot to search. Defaults to 40.
     * @returns {Promise<Object|null>} {x, z, y, size, flatness} or null if nothing found.
     * @example
     * const site = await skills.findBuildingSite(bot, 50);
     * await skills.levelGround(bot, site.x, site.z, site.size, site.y);
     **/
    size = Math.max(9, Math.floor(size));
    const p = world.getPosition(bot);
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const step = size > 30 ? 6 : 2;                 // 采样步长，控制开销
    const n = Math.max(4, Math.floor(size / step));
    // 每次扫描让出事件循环，避免长时间占用 CPU 导致 MindServer 心跳超时断线
    const yieldLoop = () => new Promise(resolve => setTimeout(resolve, 0));

    // 取某列的地表高度（从上往下第一个非空气方块）
    const surfaceY = (x, z) => {
        for (let y = by + 10; y >= by - 12; y--) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'water') return y;
        }
        return null;
    };

    const evaluate = (cx, cz) => {
        const heights = [];
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const y = surfaceY(cx + i * step, cz + j * step);
                if (y === null) return null;
                heights.push(y);
            }
        }
        if (!heights.length) return null;
        const sorted = [...heights].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        let within1 = 0;
        for (const h of sorted) if (Math.abs(h - median) <= 1) within1++;
        const flatness = within1 / sorted.length;    // 0..1，1 = 完全平坦
        return { median, flatness };
    };

    const candStep = Math.max(8, Math.floor(size / 2));
    let best = null;
    let evaluated = 0;
    for (let dx = -searchRadius; dx <= searchRadius; dx += candStep) {
        for (let dz = -searchRadius; dz <= searchRadius; dz += candStep) {
            if (bot.interrupt_code) break;
            const cx = bx + dx, cz = bz + dz;
            const res = evaluate(cx, cz);
            evaluated++;
            if (res && (!best || res.flatness > best.flatness)) {
                best = { x: cx, z: cz, y: res.median, size: size, flatness: res.flatness };
            }
            // 每评估一个候选点就让出一次事件循环（关键：防止心跳超时断线）
            if (evaluated % 2 === 0) await yieldLoop();
        }
    }
    if (best) {
        log(bot, `Best building site: center-corner (${best.x}, ${best.z}), ground level y=${best.y}, flatness ${(best.flatness * 100).toFixed(0)}% over ${size}x${size}.`);
    } else {
        log(bot, `Could not evaluate a ${size}x${size} building site nearby.`);
    }
    return best;
}

// 平地时允许拆除的"自然方块"，玩家建筑（木板/玻璃/砖等）不在名单里，绝不会被拆
// ★ 第23条：这张表是**破坏性**的（命中就会被 /fill 清掉），所以判据只能是
//   「生成时就长在地上、玩家不会主动放」。「玩家拿物品/工具摆出来的」一律不进表：
//   - farmland（锄头点出来的农田）—— 玩家的耕地，属于财产
//   - moss_block / moss_carpet（苔藓块/苔藓地毯）—— 装饰用，玩家会主动铺
//   自然植被（草/花/藤/竹/仙人掌/海带等）仍留在表里：它们本来就自然生成，
//   平地要清的就是这些"高出一格"的东西。
//   注意与上面 isPlayerBuiltBlock（J1）**分开**：那条问"像不像玩家建的"，这条问"是不是天然地形"。
    const NATURAL_BLOCKS = new Set([
        // 土类
        'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
        'mud', 'muddy_mangrove_roots',
        // 石类
        'stone', 'cobblestone', 'andesite', 'granite', 'diorite', 'deepslate', 'tuff', 'calcite',
        'dripstone_block', 'pointed_dripstone', 'basalt', 'blackstone', 'obsidian',
        'sandstone', 'red_sandstone', 'smooth_basalt',
        // 松散类
        'sand', 'red_sand', 'gravel', 'clay', 'snow', 'snow_block', 'powder_snow', 'ice',
        // 树叶（所有树种）
        'oak_leaves', 'jungle_leaves', 'spruce_leaves', 'birch_leaves', 'acacia_leaves',
        'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves',
        'flowering_azalea_leaves',
        // 原木（所有树种）
        'oak_log', 'jungle_log', 'spruce_log', 'birch_log', 'acacia_log', 'dark_oak_log',
        'mangrove_log', 'cherry_log', 'stripped_oak_log', 'stripped_spruce_log',
        // 草/花/植物：最常见的"高出一格"元凶
        'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine',
        'bamboo', 'sugar_cane', 'cactus', 'kelp', 'seagrass',
        'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
        'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony',
        'brown_mushroom', 'red_mushroom', 'sweet_berry_bush',
        // 液体
        'water', 'lava',
        // 矿石
        'coal_ore', 'iron_ore', 'copper_ore', 'diamond_ore', 'gold_ore', 'redstone_ore',
        'lapis_ore', 'emerald_ore', 'deepslate_coal_ore', 'deepslate_iron_ore',
        'deepslate_diamond_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore'
    ]);

/**
 * 数一下这个长方体里有多少格空气 —— 也就是 `/fill … keep` 实际会「造」出多少方块。
 *
 * 第23条用：填坑前先问「背包里的 filler 够不够」。只要数到比 have 多就可以停
 * （结论已经确定是"不够"），所以 insuffcient 的情况很便宜。
 * budget 是读取上限：区域太大时不硬扫，返回 truncated=true 让调用方按"无法核对"处理
 * —— 宁可只削高，也不凭猜测刷方块。
 *
 * @returns {{count:number, truncated:boolean}}
 */
function countGapCells(bot, x0, y0, z0, x1, y1, z1, stopAbove = Number.MAX_SAFE_INTEGER, budget = 200000) {
    let count = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            for (let z = z0; z <= z1; z++) {
                if (budget-- <= 0) return { count, truncated: true };
                const b = bot.blockAt(new Vec3(x, y, z));
                if (b && (b.name === 'air' || b.name === 'cave_air')) {
                    count++;
                    if (count > stopAbove) return { count, truncated: false };
                }
            }
        }
    }
    return { count, truncated: false };
}

export async function levelGround(bot, x0, z0, size, targetY, maxOps = 4000) {
    /**
     * Flatten a square patch of ground to one level so a house can sit on it.
     * Breaks terrain that is too high and fills dips that are too low.
     * TWO MODES:
     *  - Large areas (size >= 16) use world-edit commands (/fill), which finish in seconds.
     *    Those commands only replace NATURAL materials, so player buildings are not touched,
     *    and dips are filled with the "keep" mode so existing blocks are never overwritten.
     *  - Small areas dig/place block by block with the bot's hands.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x0, z0, the minimum corner of the square region.
     * @param {number} size, side length of the square region, e.g. 50.
     * @param {number} targetY, the ground level to flatten to.
     * @param {number} maxOps, safety cap for the hand-digging mode. Defaults to 4000.
     * @returns {Promise<Object>} {mode, x0, z0, size, targetY, cleared, placed}
     * @example
     * await skills.levelGround(bot, -200, -300, 50, 64);
     **/
    size = Math.max(3, Math.floor(size));
    const X0 = Math.floor(x0), Z0 = Math.floor(z0), TY = Math.floor(targetY);
    const X1 = X0 + size - 1, Z1 = Z0 + size - 1;

    // 阈值从 16 降到 5：13x13 以下的手工推平实测约 27 秒/列，根本不可用；
    // 而 bot 有 OP，/fill 是秒级的。只有在没有权限时才应该退回手工。
    if (size >= 5) {
        // ---- 快速模式：用 /fill 按材质清理，天然方块之外一律不动 ----
        log(bot, `Leveling ${size}x${size} to y=${TY} using /fill (fast mode). Only natural materials are removed.`);
        const naturalNames = [...NATURAL_BLOCKS].filter(n => n !== 'water' && n !== 'lava');
        const TOP = TY + 12;
        for (const name of naturalNames) {
            if (bot.interrupt_code) break;
            await command(bot, 'fill', [X0, TY + 1, Z0, X1, TOP, Z1, 'air', 'replace', name], { cheat: true });
            // 让服务器处理上一批再发下一批
            await new Promise(resolve => setTimeout(resolve, 120));
        }
        // 用 keep 模式填坑：只填空气，不会覆盖已有方块，建筑安全
        const filler = ['dirt', 'cobblestone', 'stone', 'sand']
            .map(n => bot.inventory.findInventoryItem(n))
            .find(Boolean);
        const fillerName = filler ? filler.name : 'dirt';
        // 填坑深度自适应：原来固定 6 格，遇到深坑填不满，导致"铲平后仍有高差"
        const _depth = 20;   // 固定填 20 格深：足够应付这次遇到的 4~10 格落差，又不会刷屏
        // ★ 第23条：`/fill … <filler> keep` 是**凭空造方块**。
        //   命令不扣背包，所以"填低"这一半等于无中生有 —— 坑被填成一片谁也没付出过的土，
        //   而 bot 背包里可能一块都没有（fillerName 上面还兜底成 'dirt'）。
        //   前置条件：背包里真有 filler，且数量 >= 真正要填的格数。
        //   不够就**只削高、不填低**（宁可留个坑，也不刷方块），并把原因写清楚。
        const haveFiller = countInventoryItem(bot, fillerName);
        let gap = { count: Infinity, truncated: true };
        try { gap = countGapCells(bot, X0, TY - _depth, Z0, X1, TY, Z1, haveFiller); } catch { /* 读不到区块 = 无法核对，按"不够"处理 */ }
        const canFill = !gap.truncated && gap.count <= haveFiller;
        if (canFill) {
            // keep 模式只填空气格；从 TY-20 填到 TY，把深坑补齐
            await command(bot, 'fill', [X0, TY - _depth, Z0, X1, TY, Z1, fillerName, 'keep'], { cheat: true });
        } else {
            log(bot, gap.truncated
                ? `Skipping the fill step: cannot verify how much ${fillerName} the region needs (too large / chunk not loaded). Only trimmed the high parts.`
                : `Skipping the fill step: dips need ${gap.count} ${fillerName}, have ${haveFiller}. Only trimmed the high parts.`);
            log(bot, `MISSING_ITEM`);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        log(bot, `Leveling done (fast mode) at ${X0},${TY},${Z0} .. ${X1},${TY},${Z1}.`);
        return { mode: 'fill', x0: X0, z0: Z0, size: size, targetY: TY, top: TOP, depth: _depth, filled: canFill, filler: fillerName, haveFiller };
    }

    // ---- 手工模式：小面积逐格挖/填 ----
    const total = size * size;
    const stats = { mode: 'dig', broken: 0, placed: 0, skipped: 0, ops: 0, done: 0, total: total };
    log(bot, `Leveling ${size}x${size} (${total} columns) to y=${TY} by hand. Cap: ${maxOps} ops.`);
    const filler = ['dirt', 'cobblestone', 'stone', 'sand', 'gravel']
        .map(n => bot.inventory.findInventoryItem(n))
        .find(Boolean);

    for (let ix = 0; ix < size; ix++) {
        for (let iz = 0; iz < size; iz++) {
            if (bot.interrupt_code || stats.ops >= maxOps) {
                log(bot, `Leveling stopped (interrupt or cap). broken=${stats.broken} placed=${stats.placed} columns=${stats.done}/${total}`);
                return stats;
            }
            const x = X0 + ix, z = Z0 + iz;
            let top = null;
            for (let y = TY + 8; y >= TY - 8; y--) {
                const b = bot.blockAt(new Vec3(x, y, z));
                if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'water') { top = y; break; }
            }
            if (top === null) { stats.done++; continue; }

            if (top > TY) {
                for (let y = top; y > TY; y--) {
                    if (bot.interrupt_code || stats.ops >= maxOps) break;
                    const b = bot.blockAt(new Vec3(x, y, z));
                    if (!b || !NATURAL_BLOCKS.has(b.name)) {
                        stats.skipped++;
                        log(bot, `Keep ${b ? b.name : '?'} at (${x},${y},${z}), not natural terrain.`);
                        continue;
                    }
                    try {
                        await breakBlockAt(bot, x, y, z);
                        stats.broken++;
                        stats.ops++;
                    } catch (err) { stats.skipped++; }
                }
            } else if (top < TY) {
                if (!filler) { stats.skipped++; stats.done++; continue; }
                for (let y = top + 1; y <= TY; y++) {
                    if (bot.interrupt_code || stats.ops >= maxOps) break;
                    try {
                        const ok = await placeBlock(bot, filler.name, x, y, z, 'bottom');
                        if (ok) { stats.placed++; stats.ops++; } else stats.skipped++;
                    } catch (err) { stats.skipped++; }
                }
            }
            stats.done++;
        }
    }
    log(bot, `Leveling finished: broken=${stats.broken}, placed=${stats.placed}, skipped=${stats.skipped}, columns=${stats.done}/${total}.`);
    return stats;
}

export async function prepareBuildingSite(bot, size = 50, searchRadius = 40) {
    /**
     * One-call preparation: automatically choose the flattest nearby place and flatten it
     * so there is a square, level building area of `size` x `size` blocks.
     * Returns the site so you can pass it straight to skills.buildHouse(...).
     * A 50x50 area is a big job; expect several minutes and let it finish.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} size, side length of the flat area needed. Defaults to 50.
     * @param {number} searchRadius, how far to search for the site. Defaults to 40.
     * @returns {Promise<Object|null>} {x, z, y, size} ready for buildHouse, or null.
     * @example
     * const site = await skills.prepareBuildingSite(bot, 50);
     * if (site) await skills.buildHouse(bot, "oak_planks", site.x, site.y + 1, site.z, 5, 5, 2);
     **/
    const site = await findBuildingSite(bot, size, searchRadius);
    if (!site) return null;
    await levelGround(bot, site.x, site.z, site.size, site.y);
    // 记住这块工地，下次可以直接回来（存磁盘，重启不丢）
    landmarks.rememberSite(bot, { x: site.x, y: site.y, z: site.z },
        `build_site_${site.size}x${site.size}`);
    log(bot, `Building site ready at ${site.x},${site.z}, ground level y=${site.y}, ${site.size}x${site.size}. (saved as build site)`);
    return site;
}

export async function buildHouse(bot, blockType, x, y, z, width, depth, height) {
    /**
     * Safely build a hollow house (floor + walls + roof) out of one block type.
     * It NEVER breaks blocks: positions already holding the same block are skipped,
     * and positions holding any other block are skipped too (logged as blocked).
     * A 2-high door opening is left in the front wall (the minimum-z side).
     * DO NOT write your own loop of skills.breakBlockAt to clear the area first - that demolishes
     * existing buildings. Use skills.findFlatBuildingSpot(...) to pick a clear place instead.
     * Call skills.prepareForBuilding(...) BEFORE this to check materials and free slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the building block, e.g. "oak_planks".
     * @param {number} x, x of the floor's minimum corner.
     * @param {number} y, y of the FLOOR layer (the block you stand on top of).
     * @param {number} z, z of the floor's minimum corner.
     * @param {number} width, size along x, at least 3.
     * @param {number} depth, size along z, at least 3.
     * @param {number} height, interior wall height, at least 2.
     * @returns {Promise<Object>} counts: {placed, exists, blocked, failed, doorHole}
     * @example
     * const p = world.getPosition(bot);
     * await skills.prepareForBuilding(bot, { oak_planks: 80 });
     * await skills.buildHouse(bot, "oak_planks", p.x + 2, p.y - 1, p.z + 2, 5, 5, 2);
     **/
    const X0 = Math.floor(x), Y0 = Math.floor(y), Z0 = Math.floor(z);
    width = Math.max(3, Math.floor(width));
    depth = Math.max(3, Math.floor(depth));
    height = Math.max(2, Math.floor(height));

    const doorDx = Math.floor(width / 2);
    const doorHole = `${X0 + doorDx},${Y0 + 1},${Z0}`;
    log(bot, `Building a ${width}x${depth} house (wall height ${height}) of ${blockType} at ${X0},${Y0},${Z0}. Door opening at ${doorHole} (front, -z side).`);

    const positions = [];
    // 地板 + 屋顶
    for (let dx = 0; dx < width; dx++) {
        for (let dz = 0; dz < depth; dz++) {
            positions.push([X0 + dx, Y0, Z0 + dz]);
            positions.push([X0 + dx, Y0 + height + 1, Z0 + dz]);
        }
    }
    // 四面墙
    for (let dy = 1; dy <= height; dy++) {
        for (let dx = 0; dx < width; dx++) {
            for (let dz = 0; dz < depth; dz++) {
                const isEdge = dx === 0 || dx === width - 1 || dz === 0 || dz === depth - 1;
                if (!isEdge) continue;
                // 前墙（z 最小那面）留 2 格高门洞
                if (dz === 0 && dx === doorDx && (dy === 1 || dy === 2)) continue;
                positions.push([X0 + dx, Y0 + dy, Z0 + dz]);
            }
        }
    }

    const stats = { placed: 0, exists: 0, blocked: 0, failed: 0, unknown: 0, doorHole: doorHole };
    for (const [px, py, pz] of positions) {
        if (bot.interrupt_code) {
            log(bot, `Interrupted during building. Progress: ${JSON.stringify(stats)}`);
            return stats;
        }
        const r = await placeBlockWithoutBreaking(bot, blockType, px, py, pz);
        if (stats[r] !== undefined) stats[r]++;
    }
    log(bot, `House finished. ${stats.placed} blocks placed, ${stats.exists} were already there, ${stats.blocked} skipped (occupied by something else), ${stats.failed} failed.`);
    if (stats.blocked > 0) {
        log(bot, `Note: ${stats.blocked} positions were occupied by other blocks, so the house may have gaps. Move to a clear area to build properly.`);
    }
    // 记录这栋房子的位置，方便以后回来加固/改造
    if (stats.placed > 0) {
        landmarks.rememberSite(bot, { x: X0, y: Y0, z: Z0 }, `house_${width}x${depth}`);
    }
    return stats;
}

// ===========================================================================
// 新增能力（第十轮）
// ===========================================================================

export async function surveyInventory(bot) {
    /**
     * Gives a complete picture of what the bot is carrying, grouped so it is easy to reason about.
     * Use this BEFORE planning any multi-step task: it tells you what you can build, what you must
     * gather, and how much free space you have left.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<Object>} {freeSlots, usedSlots, totalItems, materials, tools, food, junk, hasChest, hasPlanks, planksCount}
     * @example
     * const inv = await skills.surveyInventory(bot);
     * log(bot, `free=${inv.freeSlots}, planks=${inv.planksCount}`);
     **/
    const items = bot.inventory.items();
    const materials = {};
    const tools = [];
    const food = [];
    const junk = [];

    const TOOL_SUFFIX = ['_pickaxe', '_axe', '_shovel', '_sword', '_hoe', '_shears', '_flint_and_steel'];
    const FOOD = ['bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
        'baked_potato', 'carrot', 'golden_apple', 'melon_slice', 'cooked_cod', 'cooked_salmon', 'cookie'];

    let total = 0;
    let planksCount = 0;
    for (const it of items) {
        total += it.count;
        if (it.name.endsWith('_planks')) planksCount += it.count;
        if (TOOL_SUFFIX.some(s => it.name.endsWith(s)) || it.name.endsWith('_helmet')
            || it.name.endsWith('_chestplate') || it.name.endsWith('_leggings') || it.name.endsWith('_boots')) {
            tools.push(`${it.name}x${it.count}`);
        } else if (FOOD.includes(it.name)) {
            food.push(`${it.name}x${it.count}`);
        } else if (it.count <= 2) {
            // 零碎小杂物：盖房前优先清出去的就是这些
            junk.push(`${it.name}x${it.count}`);
        } else {
            materials[it.name] = (materials[it.name] || 0) + it.count;
        }
    }

    const result = {
        freeSlots: bot.inventory.emptySlotCount(),
        usedSlots: 36 - bot.inventory.emptySlotCount(),
        totalItems: total,
        materials,
        tools,
        food,
        junk,
        hasChest: countInventoryItem(bot, 'chest') > 0,
        hasPlanks: planksCount > 0,
        planksCount,
    };
    log(bot, `Inventory: ${result.freeSlots} free / ${result.usedSlots} used slots, ${total} items total. ` +
        `Planks: ${planksCount}. Chest in bag: ${result.hasChest}.`);
    if (Object.keys(materials).length) log(bot, `Materials: ${Object.entries(materials).map(([k, v]) => `${k}x${v}`).join(', ')}`);
    if (junk.length) log(bot, `Small junk stacks (candidates to stash): ${junk.join(', ')}`);
    return result;
}

export async function makeRoomForBot(bot, needed = 2) {
    /**
     * Emergency unstick: if the bot is trapped or standing in a 1-block hole, dig out the blocks
     * directly around it so it can move again. Only removes NATURAL terrain, never player buildings.
     * Use this when movement commands keep failing and the bot reports being stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} needed, how many blocks of clearance to open up. Defaults to 2.
     * @returns {Promise<number>} how many blocks were removed.
     * @example
     * const n = await skills.makeRoomForBot(bot, 2);
     **/
    const NATURAL = new Set([
        'dirt', 'grass_block', 'stone', 'cobblestone', 'sand', 'gravel', 'andesite', 'granite',
        'diorite', 'deepslate', 'tuff', 'clay', 'snow', 'snow_block', 'mud', 'podzol', 'mycelium',
        'oak_leaves', 'jungle_leaves', 'spruce_leaves', 'birch_leaves', 'acacia_leaves', 'dark_oak_leaves',
        'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine',
    ]);
    const p = bot.entity.position.floored();
    const offsets = [
        [0, 1, 0],            // 头顶
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    ];
    let removed = 0;
    for (const [dx, dy, dz] of offsets) {
        if (removed >= needed + 1) break;
        const b = bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz));
        if (!b) continue;
        if (b.name === 'air' || b.name === 'cave_air' || b.name === 'water') continue;
        if (!NATURAL.has(b.name)) {
            log(bot, `Not removing ${b.name} at (${b.x},${b.y},${b.z}): looks player-built.`);
            continue;
        }
        try {
            await breakBlockAt(bot, b.position.x, b.position.y, b.position.z);
            removed++;
        } catch (err) { /* 单个失败跳过 */ }
    }
    log(bot, `Cleared ${removed} block(s) around the bot to make room.`);
    return removed;
}

export async function reportStatus(bot) {
    /**
     * Produce a factual status snapshot: position, health, hunger, inventory space, nearby threats
     * and whether a chest is known. Use this to answer "how are you doing" questions truthfully
     * instead of guessing, and before starting a long task to check it is safe to begin.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<Object>} status object
     * @example
     * const s = await skills.reportStatus(bot);
     **/
    const pos = world.getPosition(bot);
    const threats = world.getNearestEntityWhere(bot, e => mc.isHostile(e), 16);
    const knownChest = landmarks.knownChestsNearest(bot, pos)[0] || null;
    const status = {
        position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        health: Math.round(bot.health),
        food: Math.round(bot.food),
        freeSlots: bot.inventory.emptySlotCount(),
        isDay: bot.time.timeOfDay < 13000,
        threat: threats ? `${threats.name} at ${Math.round(pos.distanceTo(threats.position))} blocks` : 'none',
        knownChest: knownChest ? `(${knownChest.x},${knownChest.y},${knownChest.z})` : 'none remembered',
    };
    log(bot, `Status: at (${status.position.x},${status.position.y},${status.position.z}), ` +
        `HP ${status.health}/20, food ${status.food}/20, ${status.freeSlots} free slots, ` +
        `${status.isDay ? 'day' : 'night'}, threat: ${status.threat}, chest: ${status.knownChest}.`);
    return status;
}

/**
 * 读出所有记住的工地（含死亡点），最近用过的在前。
 * @returns {Promise<Array>} [{x,y,z,note,lastUsed}]
 */
export function listKnownSites(bot) {
    /**
     * List every place the bot remembers: building sites, death position, chests, and places
     * saved with !rememberHere. Use this when the player asks "where was the house / where did
     * you die / where is that place I told you to remember" instead of guessing.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Array<Object>} list of {x, y, z, note, source}
     * @example
     * const sites = skills.listKnownSites(bot);
     * log(bot, sites.map(s => `${s.note} at ${s.x},${s.y},${s.z}`).join('; '));
     **/
    const results = [];

    // 1) landmarks（工地、死亡点、箱子）—— 存磁盘
    const data = landmarks.loadLandmarks(bot);
    const sites = [...data.sites].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    for (const s of sites) {
        results.push({
            x: Math.floor(s.x), y: Math.floor(s.y), z: Math.floor(s.z),
            note: s.note || 'site', source: 'landmarks'
        });
    }
    for (const c of data.chests) {
        results.push({
            x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z),
            note: c.note || 'chest', source: 'chest'
        });
    }

    // 2) memory_bank（!rememberHere 存的命名地点）
    // 之前只读 landmarks，导致她存过 testhome 却查不到——两套存储必须合并展示。
    const bank = bot?.memory_bank;
    if (bank && typeof bank.getJson === 'function') {
        const json = bank.getJson() || {};
        for (const [name, pos] of Object.entries(json)) {
            if (Array.isArray(pos) && pos.length >= 3) {
                results.push({
                    x: Math.floor(pos[0]), y: Math.floor(pos[1]), z: Math.floor(pos[2]),
                    note: name, source: 'memory_bank'
                });
            }
        }
    }

    if (!results.length) {
        log(bot, 'No saved places yet (no building site, no death point, nothing remembered).');
        return [];
    }
    log(bot, `Known places: ${results.map(r => `${r.note} at (${r.x},${r.y},${r.z})`).join('; ')}`);
    return results;
}

// ---------------------------------------------------------------------------
// 死亡后捡物品
// ---------------------------------------------------------------------------

// 连续死亡保护：同一位置附近反复死亡就停手，避免无限送死。
// 关键：这个记录必须由「死亡事件」写入（agent.js 的 _handleDeath 调用 recordDeath），
// 不能只由 recoverDeathItems 自己记 —— 否则检查发生在记录之前，保护永远触发不了。
const deathAttempts = [];

export function recordDeath(bot, pos) {
    if (!pos || !bot) return;
    const now = Date.now();
    // 只保留最近 10 分钟的记录
    for (let i = deathAttempts.length - 1; i >= 0; i--) {
        if (now - deathAttempts[i].time > 10 * 60 * 1000) deathAttempts.splice(i, 1);
    }
    deathAttempts.push({ time: now, x: pos.x, y: pos.y, z: pos.z, bot: bot.username });
}

function recordDeathAttempt(bot, pos) {
    recordDeath(bot, pos);
}

function tooManyRecentDeaths(bot, pos, radius = 32) {
    const now = Date.now();
    let count = 0;
    for (const d of deathAttempts) {
        if (d.bot !== bot.username) continue;
        if (now - d.time > 10 * 60 * 1000) continue;
        const dx = d.x - pos.x, dy = d.y - pos.y, dz = d.z - pos.z;
        if (dx * dx + dy * dy + dz * dz <= radius * radius) count++;
    }
    return count >= 2;
}

export async function recoverDeathItems(bot, options = {}) {
    /**
     * Go back to where the bot last died and pick up its dropped items.
     * Safety rules (do not remove them):
     *  - refuses if the death spot is in another dimension
     *  - refuses if it is farther than maxDistance (default 128 blocks) - too long a trip
     *  - refuses if the bot already died twice near that same spot in the last 10 minutes
     *    (prevents an endless "die -> run back -> die again" loop)
     *  - aborts immediately if the bot dies again while travelling
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} options, { maxDistance = 128, dryRun = false }
     * @returns {Promise<Object>} {ok, reason, distance, pickedUp, items}
     * @example
     * const r = await skills.recoverDeathItems(bot);
     * if (!r.ok) log(bot, 'Not recovering: ' + r.reason);
     **/
    const maxDistance = options.maxDistance ?? 128;
    const dryRun = options.dryRun ?? false;

    const saved = landmarks.loadLandmarks(bot).sites.find(s => s.note === 'death_position');
    if (!saved) {
        log(bot, 'No death position recorded, nothing to recover.');
        return { ok: false, reason: 'no_death_position' };
    }
    const target = { x: saved.x, y: saved.y, z: saved.z };
    const me = bot.entity.position;
    const distance = Math.round(me.distanceTo(new Vec3(target.x, target.y, target.z)));

    // 规则 1：太远就不要自动跑
    if (distance > maxDistance) {
        log(bot, `Death spot is ${distance} blocks away (limit ${maxDistance}). Not walking there automatically - ask the player first.`);
        return { ok: false, reason: 'too_far', distance };
    }
    // 规则 2：同一个地方反复死，停手
    if (tooManyRecentDeaths(bot, target)) {
        log(bot, `Died near (${target.x},${target.y},${target.z}) twice recently. Not going back - something there is dangerous.`);
        return { ok: false, reason: 'repeated_deaths', distance };
    }
    if (dryRun) {
        log(bot, `[dry run] Would walk ${distance} blocks to (${target.x},${target.y},${target.z}) to recover items.`);
        return { ok: true, reason: 'dry_run', distance, pickedUp: 0, items: [] };
    }

    recordDeathAttempt(bot, target);
    log(bot, `Walking back ${distance} blocks to recover items at (${target.x},${target.y},${target.z}).`);

    // 记录死亡计数，路上再死就中止
    const deathsBefore = deathAttempts.length;
    const walk = await goToPosition(bot, target.x, target.y, target.z, 2);
    if (deathAttempts.length > deathsBefore) {
        log(bot, 'Died again on the way. Stopping the recovery attempt.');
        return { ok: false, reason: 'died_on_the_way', distance };
    }
    if (!walk) {
        log(bot, `Could not reach the death spot (${target.x},${target.y},${target.z}).`);
        return { ok: false, reason: 'unreachable', distance };
    }

    // 到附近了就捡
    const before = bot.inventory.items().length;
    await pickupNearbyItems(bot);
    const after = bot.inventory.items();
    const items = after.map(i => `${i.name}x${i.count}`);
    log(bot, `Recovered near the death spot. Inventory now holds ${after.length} stacks (${before} before).`);
    return { ok: true, reason: 'recovered', distance, pickedUp: after.length - before, items };
}

// ---------------------------------------------------------------------------
// 按蓝图盖房（litematic / schem）
// ---------------------------------------------------------------------------

/**
 * 把蓝图里的方块状态还原成 /setblock 能用的字符串。
 * 例如 { Name: "minecraft:oak_stairs", Properties: { facing: "north", half: "bottom" } }
 *   -> "minecraft:oak_stairs[facing=north,half=bottom]"
 */
function blockStateToString(block) {
    if (!block) return 'minecraft:air';
    const name = block.name || 'minecraft:air';
    const props = block.properties || {};
    const keys = Object.keys(props);
    if (!keys.length) return name;
    const inner = keys.map(k => `${k}=${props[k]}`).join(',');
    return `${name}[${inner}]`;
}

export async function buildFromSchematic(bot, schematicFile, x, y, z, options = {}) {
    /**
     * Build a structure from a .litematic / .schem blueprint file at the given position.
     * The blueprint is placed so that its minimum corner sits at (x, y, z).
     *
     * Two modes:
     *  - 'command' (default): uses /setblock, requires OP. Fast and reliable (3784 blocks ~ 3 min).
     *  - 'physical': places blocks with the bot's hands, slow (about 27s per column) - only for tiny builds.
     *
     * SAFETY: in 'command' mode it only fills positions the blueprint actually has
     * (air in the blueprint is SKIPPED, so it never clears the area). It also refuses
     * to overwrite player-built blocks unless options.overwrite is true.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} schematicFile, path to the blueprint, e.g. "./schematics/house.litematic".
     * @param {number} x, y, z, where the blueprint's minimum corner should go.
     * @param {Object} options, { mode='command', overwrite=false, maxBlocks=8000, skipAir=true, dryRun=false }
     * @returns {Promise<Object>} { ok, reason, total, placed, skipped, failed, size, tookMs }
     * @example
     * const r = await skills.buildFromSchematic(bot, "./schematics/house.litematic", 100, 64, 200);
     **/
    const mode = options.mode || 'command';
    const overwrite = options.overwrite ?? false;
    const maxBlocks = options.maxBlocks ?? 8000;
    const dryRun = options.dryRun ?? false;

    // 延迟加载，避免每个 bot 启动都解 NBT
    const { readLitematic } = await import('./schematic.js');

    let schem;
    try {
        schem = readLitematic(schematicFile);
    } catch (err) {
        log(bot, `Cannot read blueprint ${schematicFile}: ${err.message}`);
        return { ok: false, reason: 'read_failed', detail: String(err.message) };
    }

    const { size, origin, totalBlocks } = schem;
    log(bot, `Blueprint "${schem.name}": ${size.x}x${size.y}x${size.z}, ${totalBlocks} blocks (${Object.keys(schem.blockCount).length} types).`);
    log(bot, `Placing it at (${x},${y},${z}) so the corner sits there. Mode: ${mode}.`);

    if (totalBlocks > maxBlocks && !overwrite) {
        log(bot, `Refusing: blueprint has ${totalBlocks} blocks, above the ${maxBlocks} limit. Raise maxBlocks if you really want this.`);
        return { ok: false, reason: 'too_large', total: totalBlocks, maxBlocks };
    }
    if (dryRun) {
        log(bot, `[dry run] Would place ${totalBlocks} blocks.`);
        return { ok: true, reason: 'dry_run', total: totalBlocks, size };
    }

    const started = Date.now();
    const stats = { placed: 0, skipped: 0, failed: 0, total: totalBlocks };
    // 统一用 world_model.isPlayerBuiltBlock（它会自己去掉 minecraft: 前缀）。
    // 原来这里还有一份带前缀的短清单，和 placeBlock 里那份、heatmap 那份各自不同步。

    // 命令模式下先把玩家建筑检查一遍（overwrite=false 时）
    if (mode === 'command') {
        for (let bx = 0; bx < size.x; bx++) {
            if (bot.interrupt_code) break;
            for (let bz = 0; bz < size.z; bz++) {
                for (let by = 0; by < size.y; by++) {
                    const worldPos = new Vec3(x + bx, y + by, z + bz);
                    const existing = bot.blockAt(worldPos);
                    if (!existing) continue;
                    if (existing.name === 'air' || existing.name === 'cave_air') continue;

                    // 蓝图里这个位置有没有方块？没有就跳过（不破坏世界）
                    const plan = schem.getBlock(bx, by, bz);
                    if (!plan || plan.name === 'minecraft:air') {
                        // 蓝图这里是空的，但世界里有东西 -> 不动它
                        stats.skipped++;
                        continue;
                    }
                    // 蓝图这里要放东西，但世界已有方块
                    if (!overwrite && wmIsPlayerBuilt(existing.name)) {
                        log(bot, `Refusing to overwrite ${existing.name} at (${worldPos.x},${worldPos.y},${worldPos.z}). Move to an empty area or pass overwrite=true.`);
                        return { ok: false, reason: 'occupied', at: { x: worldPos.x, y: worldPos.y, z: worldPos.z }, detail: existing.name };
                    }
                }
            }
        }
    }

    // 逐个放置
    const commandDelay = options.commandDelay ?? 45;
    for (let bx = 0; bx < size.x; bx++) {
        if (bot.interrupt_code) {
            log(bot, `Interrupted after ${stats.placed} blocks.`);
            break;
        }
        for (let by = 0; by < size.y; by++) {
            for (let bz = 0; bz < size.z; bz++) {
                const plan = schem.getBlock(bx, by, bz);
                if (!plan) { continue; }
                if (plan.name === 'minecraft:air' || plan.name === 'minecraft:cave_air') { continue; }

                const wx = x + bx, wy = y + by, wz = z + bz;

                if (mode === 'command') {
                    // 第29条：走 atom_input_misc.command()（白名单 + 显式 {cheat:true}），
                    // 不再自己拼 /setblock 塞给 bot.chat —— 那是绕过白名单的第二条路。
                    // blockStateToString 产出的是 `minecraft:oak_stairs[facing=east,half=bottom]`
                    // 这种单 token 串（不含空格），按位置参数传进去不会被拆开。
                    try {
                        const r = await command(bot, 'setblock', [wx, wy, wz, blockStateToString(plan)], { cheat: true });
                        if (r.ok) stats.placed++;
                        else stats.failed++;
                    } catch (err) {
                        stats.failed++;
                    }
                    if (stats.placed % 200 === 0) {
                        log(bot, `Progress: ${stats.placed}/${stats.total} blocks placed...`);
                    }
                    await new Promise(r => setTimeout(r, commandDelay));
                } else {
                    // 物理放置：慢，但不需要 OP
                    try {
                        const name = plan.name.replace('minecraft:', '');
                        const r = await placeBlockWithoutBreaking(bot, name, wx, wy, wz);
                        if (r === 'placed' || r === 'exists') stats.placed++;
                        else if (r === 'blocked') stats.skipped++;
                        else stats.failed++;
                    } catch (err) {
                        stats.failed++;
                    }
                }
            }
        }
    }

    const tookMs = Date.now() - started;
    log(bot, `Blueprint build finished: ${stats.placed} placed, ${stats.skipped} skipped, ${stats.failed} failed. Took ${Math.round(tookMs / 1000)}s.`);
    return {
        ok: stats.failed === 0 && stats.placed > 0,
        reason: 'done',
        total: stats.total,
        placed: stats.placed,
        skipped: stats.skipped,
        failed: stats.failed,
        size,
        tookMs,
    };
}

export async function describeSchematic(bot, schematicFile) {
    /**
     * Inspect a blueprint WITHOUT building it: size, block count and a material list.
     * Use this first to check the blueprint is what you expect, and to see what materials it needs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} schematicFile, path to the blueprint.
     * @returns {Promise<Object>} { ok, size, totalBlocks, materials, regions }
     * @example
     * const info = await skills.describeSchematic(bot, "./schematics/house.litematic");
     **/
    const { readLitematic } = await import('./schematic.js');
    try {
        const s = readLitematic(schematicFile);
        const materials = Object.entries(s.blockCount)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({ name: name.replace('minecraft:', ''), count }));
        log(bot, `Blueprint "${s.name}": ${s.size.x}x${s.size.y}x${s.size.z}, ${s.totalBlocks} blocks, ${materials.length} types.`);
        log(bot, `Materials: ${materials.slice(0, 10).map(m => `${m.name}x${m.count}`).join(', ')}${materials.length > 10 ? ' ...' : ''}`);
        return { ok: true, name: s.name, size: s.size, totalBlocks: s.totalBlocks, materials, regions: s.regions };
    } catch (err) {
        log(bot, `Cannot read ${schematicFile}: ${err.message}`);
        return { ok: false, reason: 'read_failed', detail: String(err.message) };
    }
}

export async function listBlueprints(bot, dir = './schematics') {
    /**
     * List all blueprint files available in the schematics folder.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} dir, folder to look in. Defaults to "./schematics".
     * @returns {Promise<Array>} [{ file, sizeBytes }]
     * @example
     * const files = await skills.listBlueprints(bot);
     **/
    const { listSchematics } = await import('./schematic.js');
    const files = listSchematics(dir);
    if (!files.length) {
        log(bot, `No blueprints found in ${dir}.`);
        return [];
    }
    log(bot, `Blueprints in ${dir}: ${files.map(f => f.file).join(', ')}`);
    return files.map(f => ({ file: f.file, sizeBytes: f.sizeBytes }));
}

// ---------------------------------------------------------------------------
// 仓储系统：固定仓库区 + 分类箱子
// ---------------------------------------------------------------------------

import * as storage from './storage.js';
// 2026-10-27 架构重写：heatmap.js 已退役，地形相关职责拆到两个 owner
//   terrain3d   真 3D 面数据（扫球 / 查询）
//   terrain_view 渲染 + 方位工具（纯函数）
// 方块知识（isPlayerBuiltBlock / NOT_GROUND / 危险枚举）统一在 world_model
import { scanSphere, columnSurfaces, stats3d } from './terrain3d.js';
import { sampleTerrain, renderTerrain, summarizeTerrain, compassOf, relativeDirection, summarizeHeights } from './terrain_view.js';
import { facingOf as wmFacingOf, collectHazards as wmCollectHazards,
         mergeHazardBlobs as wmMergeHazardBlobs, isPlayerBuiltBlock as wmIsPlayerBuilt,
         NOT_GROUND as WM_NOT_GROUND } from './world_model.js';
import { plan3D } from './path_3d.js';
import * as worldModel from './world_model.js';
import { logLine } from './outcome.js';

/**
 * 在脚下附近找一个能放箱子的空位（侧后方优先，不挡路）。
 */
export async function setupStorage(bot, x = null, y = null, z = null) {
    /**
     * Mark a place as the bot's main storage area and remember it permanently.
     * After this, skills.createStorageChests() builds the labelled chests there and
     * skills.storeItem() / skills.tidyInventory() send items to the right chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, y, z, where the storage area should be. Defaults to the bot's position.
     * @returns {Promise<Object>} { ok, area }
     * @example
     * await skills.setupStorage(bot);
     **/
    const pos = bot.entity.position.floored();
    const area = {
        x: x ?? Math.floor(pos.x),
        y: y ?? Math.floor(pos.y),
        z: z ?? Math.floor(pos.z),
    };
    landmarks.rememberStorageArea(bot, area, 'main_storage');
    log(bot, `Storage area set at (${area.x},${area.y},${area.z}). Remembered permanently.`);
    return { ok: true, area };
}

export async function createStorageChests(bot, options = {}) {
    /**
     * Kept for compatibility. It now delegates to skills.buildStorageWarehouse(),
     * which builds a proper room (walls, ceiling, door, torches) with chests in neat
     * rows against the walls. The old "scatter chests on any nearby free spot" behaviour
     * was removed because it produced a messy, unlit, unsafe pile of chests.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} options, passed through to buildStorageWarehouse.
     * @returns {Promise<Object>} { ok, created, reused, chests, missingMaterials, warehouse }
     * @example
     * await skills.createStorageChests(bot);
     **/
    const r = await buildStorageWarehouse(bot, options);
    return {
        ok: r.ok,
        created: r.chests || [],
        reused: (r.skipped || []).filter(s => s.reason === 'exists'),
        chests: r.chests || [],
        missingMaterials: (r.skipped || []).filter(s => s.reason !== 'exists').map(s => s.category),
        warehouse: r,
        reason: r.reason,
    };
}

export async function storeItem(bot, itemName, num = -1) {
    /**
     * Put an item into the chest that matches its category.
     * If that chest is full it spills over to another chest of the same category;
     * if they are all full it reports so instead of silently dropping the item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to store, e.g. "iron_ingot".
     * @param {number} num, how many to store. Defaults to all of them.
     * @returns {Promise<Object>} { ok, stored, category, chest, reason }
     * @example
     * await skills.storeItem(bot, "iron_ingot");
     **/
    const cat = storage.categorize(itemName);
    const item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName}.`);
        return { ok: false, reason: 'not_in_inventory', category: cat };
    }
    const wantNum = num === -1 ? item.count : Math.min(num, item.count);

    // 按分类找箱子（可能多个）
    let candidates = landmarks.chestsByCategory(bot, cat);
    if (!candidates.length) {
        log(bot, `No ${storage.categoryLabel(cat)} chest yet. Set one up with skills.createStorageChests().`);
        return { ok: false, reason: 'no_chest_for_category', category: cat };
    }

    let remaining = wantNum;
    let storedTotal = 0;
    const touched = [];

    for (const c of candidates) {
        if (remaining <= 0) break;
        const block = bot.blockAt(new Vec3(c.x, c.y, c.z));
        if (!block || block.name !== 'chest') {
            landmarks.forgetChest(bot, c);
            continue;
        }
        let container;
        try {
            await goToPosition(bot, c.x, c.y, c.z, 2);
            container = await bot.openContainer(block);
        } catch (err) {
            log(bot, `Could not open the chest at (${c.x},${c.y},${c.z}).`);
            continue;
        }
        try {
            // 开箱成功 != 窗口还有效（可能刚开就被保命行为打断，或者走远被服务端关掉）
            const winOk = checkWindow(bot, container);
            if (!winOk.ok) {
                log(bot, `放不进这个箱子：${winOk.message}`);
                continue;
            }
            const free = storage.freeSlotsIn(container);
            if (free <= 0) continue;
            // 每个空格最多放一组(64)，保守按 free*64 算容量
            const capacity = free * 64;
            const put = Math.min(remaining, capacity);
            // ★ S40：过去 `storedTotal += put` —— `put` 是**打算放多少**，不是**真的放进去多少**。
            //   deposit 可能只成功一部分（箱子满、并发抢格、服务端拒收），
            //   于是仓储链上的数字不可信（上游按它算"还差多少材料"就会算错）。
            //   现在用**背包前后差值**当唯一口径：只有真的从背包里少掉了才算存进去。
            const beforeHave = countInventoryItem(bot, itemName);
            await container.deposit(item.type, null, put);
            const afterHave = countInventoryItem(bot, itemName);
            const actuallyMoved = Math.max(0, beforeHave - afterHave);
            remaining -= actuallyMoved;
            storedTotal += actuallyMoved;
            touched.push({ pos: { x: c.x, y: c.y, z: c.z }, contents: storage.summarizeContainer(container), category: cat });
        } catch (err) {
            log(bot, `Failed to deposit into chest at (${c.x},${c.y},${c.z}): ${err}`);
        } finally {
            try { await container.close(); } catch (e) { /* ignore */ }
        }
    }

    // 更新箱子里装了什么，方便以后查询
    for (const t of touched) {
        landmarks.updateChestContents(bot, t.pos, t.contents, t.category);
    }

    if (storedTotal === 0) {
        // ★ S40：失败分支也要带 `stored: 0`。/ 一样，调用方拿到的数字必须**总是可读**——
        //   否则上游 `r.stored ?? ...` 各自兜底，仓储链上的记账口径又分叉了。
        //   另外把"一格都没放进去"和"箱子真的满了"分开说：前者可能是 deposit 静默不生效。
        const why = candidates.length ? 'nothing_moved' : 'chests_full';
        log(bot, `Nothing was actually stored (${why}) - ${itemName} is still in the inventory.`);
        return { ok: false, stored: 0, remaining, reason: why, category: cat };
    }
    log(bot, `Stored ${storedTotal} ${itemName} in the ${storage.categoryLabel(cat)} chest.`);
    return {
        ok: remaining === 0, stored: storedTotal, category: cat,
        partiallyStored: remaining > 0, remaining,
    };
}

export async function findItemInStorage(bot, itemName, opts = {}) {
    /**
     * Look up which remembered chest holds this item.
     * By default this only reads the RECORD and does not open any chest, so the answer can be
     * stale (things were moved, or that chest was never recorded). Pass { verify: true } to
     * actually walk over and check it (uses skills.verifyChest and corrects the record).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to look for.
     * @param {Object} opts, { verify: false }
     * @returns {Promise<Object>} { found, chests, verified, stale? }
     * @example
     * const r = await skills.findItemInStorage(bot, "iron_ingot", { verify: true });
     **/
    const hits = landmarks.findItemInChests(bot, itemName);
    if (!hits.length) {
        log(bot, `记忆里没有哪个箱子记着 ${itemName}。` +
            `（只有存过/整理过的箱子才有内容记录，别处得打开看）`);
        return { found: false, chests: [], verified: false };
    }
    log(bot, `${itemName} 记在：${hits.map(h => `(${h.chest.x},${h.chest.y},${h.chest.z}) x${h.count}`).join(', ')}` +
        `（这是记忆，没实地核对）`);

    // 可选真核对：走过去开箱，修正记录。
    // 默认不做 —— "只是问东西在哪"不该让她跑一趟。
    // 但返回里必须标明这份答案是"记忆"还是"核实过"的，否则又是两个真相：
    // 记录说在 A 箱，实际早被搬走了。
    if (opts.verify) {
        const results = [];
        for (const h of hits) {
            const v = await verifyChest(bot, h.chest);
            results.push({ chest: h.chest, recorded: h.count, verify: v });
        }
        const wasStale = results.some(r => r.verify && r.verify.changed);
        const stillThere = results.filter(r => r.verify && r.verify.ok
            && r.verify.contents && r.verify.contents[itemName]);
        log(bot, wasStale
            ? `核对完：记录不准，已修正。真正还有这个物品的箱子：` +
              (stillThere.length
                  ? stillThere.map(r => `(${r.chest.x},${r.chest.y},${r.chest.z})`).join(', ')
                  : '（一个都没有）')
            : `核对完：记录和实物一致。`);
        return { found: stillThere.length > 0, chests: results, verified: true, stale: wasStale };
    }

    return { found: true, chests: hits, verified: false };
}

export async function tidyInventory(bot, options = {}) {
    /**
     * One-shot tidy: walk to the storage area and file every inventory item into the
     * chest that matches its category. Keeps tools and food with the bot by default.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} options, { keepTools=true, keepFood=true, only=null }
     * @returns {Promise<Object>} { ok, moved, byCategory, skipped }
     * @example
     * await skills.tidyInventory(bot);
     **/
    const keepTools = options?.keepTools ?? true;
    const keepFood = options?.keepFood ?? true;

    const area = landmarks.getStorageArea(bot);
    if (!area) {
        log(bot, 'No storage area set. Call skills.setupStorage() and skills.createStorageChests() first.');
        return { ok: false, reason: 'no_storage_area' };
    }

    const items = [...bot.inventory.items()];
    const byCategory = {};
    let moved = 0;
    const skipped = [];

    for (const item of items) {
        if (bot.interrupt_code) break;
        const cat = storage.categorize(item.name);
        if (keepTools && cat === 'tools') { skipped.push(item.name); continue; }
        if (keepFood && cat === 'food') { skipped.push(item.name); continue; }

        const r = await storeItem(bot, item.name, item.count);
        if (r.ok || (r.stored && r.stored > 0)) {
            byCategory[cat] = (byCategory[cat] || 0) + (r.stored || 0);
            moved += r.stored || 0;
        } else {
            skipped.push(item.name);
        }
    }

    log(bot, `Tidied: ${moved} items filed into storage` +
        (skipped.length ? `, kept ${skipped.length} stacks with me.` : '.'));
    return { ok: moved > 0, moved, byCategory, skipped };
}

export async function listStorage(bot) {
    /**
     * Show the storage layout: every known chest, its category and remembered contents.
     * Use this to answer "where do I keep my ores" without opening anything.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<Array>} [{ category, pos, contents }]
     * @example
     * const s = await skills.listStorage(bot);
     **/
    const data = landmarks.loadLandmarks(bot);
    const area = data.storage;
    if (area) log(bot, `Storage area: (${area.x},${area.y},${area.z})`);
    if (!data.chests.length) {
        log(bot, 'No chests remembered yet.');
        return [];
    }
    const out = data.chests.map(c => ({
        category: c.category || 'unsorted',
        pos: { x: c.x, y: c.y, z: c.z },
        contents: c.contents || {},
    }));
    for (const c of out) {
        const items = Object.entries(c.contents);
        log(bot, `  [${storage.categoryLabel(c.category)}] (${c.pos.x},${c.pos.y},${c.pos.z})` +
            (items.length ? `: ${items.map(([n, v]) => `${n}x${v}`).join(', ')}` : ' (contents unknown)'));
    }
    return out;
}

// ---------------------------------------------------------------------------
// 干活前的三件套：装备体检 / 材料计划 / 背包预警
// ---------------------------------------------------------------------------

// 工具名到用途的映射，用于判断"挖矿要镐、砍树要斧"
const TOOL_PURPOSE = {
    pickaxe: ['_pickaxe'],
    axe: ['_axe'],
    shovel: ['_shovel'],
    sword: ['_sword'],
    hoe: ['_hoe'],
};

// 各用途最适合的材质（越大越好），用于挑最耐用的那把
const TOOL_TIER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

function itemDurabilityLeft(item) {
    if (!item || !item.maxDurability) return null;   // 无耐久概念（如方块）
    const used = item.durabilityUsed ?? 0;
    return Math.max(0, item.maxDurability - used);
}

export async function checkLoadout(bot) {
    /**
     * Health check before starting a long job: is the tool good enough, is there food,
     * is the inventory close to full. Call this BEFORE mining, chopping or building -
     * it is the cheapest way to avoid a tool breaking or starving halfway through.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<Object>} {
     *   tools: { pickaxe, axe, shovel, sword }, each { name, left, max, percent } or null,
     *   food: { count, kinds },       // 可吃的物品总格数/数量
     *   freeSlots, health, hunger,
     *   warnings: [...]               // 人类可读的问题清单
     * }
     * @example
     * const s = await skills.checkLoadout(bot);
     * if (s.warnings.length) log(bot, s.warnings.join(' / '));
     **/
    const items = bot.inventory.items();
    const tools = {};

    for (const [purpose, suffixes] of Object.entries(TOOL_PURPOSE)) {
        const matches = items.filter(i => suffixes.some(s => i.name.endsWith(s)));
        if (!matches.length) { tools[purpose] = null; continue; }
        // 挑材质最好的（同材质里挑耐久最多的）
        matches.sort((a, b) => {
            const ta = TOOL_TIER.findIndex(t => a.name.startsWith(t));
            const tb = TOOL_TIER.findIndex(t => b.name.startsWith(t));
            const ra = ta === -1 ? 99 : ta, rb = tb === -1 ? 99 : tb;
            if (ra !== rb) return ra - rb;
            return (itemDurabilityLeft(b) ?? 0) - (itemDurabilityLeft(a) ?? 0);
        });
        const best = matches[0];
        const left = itemDurabilityLeft(best);
        tools[purpose] = {
            name: best.name,
            left,
            max: best.maxDurability ?? null,
            percent: (left != null && best.maxDurability) ? Math.round(left / best.maxDurability * 100) : null,
        };
    }

    // 可吃的东西：靠食物名判断，比 math 更简单可靠
    const FOOD_NAMES = new Set(['bread', 'apple', 'carrot', 'potato', 'baked_potato', 'beetroot',
        'melon_slice', 'cookie', 'golden_apple', 'cooked_beef', 'cooked_porkchop',
        'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'beef',
        'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'cake', 'pumpkin_pie', 'dried_kelp']);
    const foodItems = items.filter(i => FOOD_NAMES.has(i.name));
    const food = {
        count: foodItems.reduce((a, i) => a + i.count, 0),
        kinds: foodItems.map(i => `${i.name}x${i.count}`),
    };

    const warnings = [];
    if (tools.pickaxe && tools.pickaxe.percent !== null && tools.pickaxe.percent <= 20) {
        warnings.push(`Pickaxe ${tools.pickaxe.name} is nearly broken (${tools.pickaxe.percent}% left) - craft or swap before mining.`);
    }
    if (!tools.pickaxe) warnings.push('No pickaxe in inventory - cannot mine stone or ore.');
    if (food.count === 0) warnings.push('No food in inventory - you will starve during long jobs.');
    else if (food.count < 3) warnings.push(`Only ${food.count} food left - bring more before long trips.`);
    const freeSlots = bot.inventory.emptySlotCount();
    if (freeSlots <= 2) warnings.push(`Only ${freeSlots} free inventory slots - items you collect may be dropped.`);

    log(bot, `Loadout: ` +
        `pickaxe=${tools.pickaxe ? `${tools.pickaxe.name}(${tools.pickaxe.percent}%)` : 'none'}, ` +
        `axe=${tools.axe ? tools.axe.name : 'none'}, ` +
        `food=${food.count}, free=${freeSlots}, ` +
        `HP=${Math.round(bot.health)}/${Math.round(bot.food)}`);
    if (warnings.length) log(bot, `Warnings: ${warnings.join(' | ')}`);

    return { tools, food, freeSlots, health: bot.health, hunger: bot.food, warnings };
}

export async function planMaterials(bot, required = {}) {
    /**
     * Work out whether the required materials are obtainable, and how:
     * split them into "already carrying", "in a chest", "can craft", "must gather".
     * Use this right after skills.describeSchematic() to see what a blueprint still needs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} required, { itemName: count }, e.g. { spruce_planks: 598 }
     * @returns {Promise<Object>} {
     *   ok,                       // 全部凑齐（身上+仓库）?
     *   lines: [{ item, need, have, inStorage, missing, craftFrom, gather }],
     *   mustGather: [{item, count}],   // 需要去采集的原料
     *   shortfall                   // 总缺口数
     * }
     * @example
     * const p = await skills.planMaterials(bot, { spruce_planks: 598 });
     **/
    const entries = Object.entries(required || {}).filter(([, n]) => n > 0);
    if (!entries.length) {
        log(bot, 'No materials requested.');
        return { ok: true, lines: [], mustGather: [], shortfall: 0 };
    }

    const lines = [];
    const mustGather = [];
    let shortfall = 0;

    for (const [itemName, need] of entries) {
        const name = itemName.replace('minecraft:', '');
        const have = countInventoryItem(bot, name);
        // 仓库里有没有（用记录的 contents，可能过期，仅作参考）
        const inChests = landmarks.findItemInChests(bot, name);
        const inStorage = inChests.reduce((a, h) => a + h.count, 0);

        const available = have + inStorage;
        let missing = Math.max(0, need - available);

        let craftFrom = null;
        let gather = null;

        if (missing > 0) {
            // 能不能自己合成？查配方
            let recipe = null;
            try {
                const recipes = mc.getItemCraftingRecipes(name);
                if (recipes && recipes.length) {
                    // 取最简单（材料种类最少）的配方
                    recipe = recipes.sort((a, b) =>
                        Object.keys(a[0] || {}).length - Object.keys(b[0] || {}).length)[0];
                }
            } catch (err) { /* 无配方或 mcdata 未就绪 */ }

            if (recipe && recipe[0]) {
                // recipe 格式是 [[{材料:数量}], {craftedCount: N}] —— 第二个元素是对象，不是数字
                const perCraft = recipe[1]?.craftedCount || 1;   // 一次合成产出几个
                const times = Math.ceil(missing / perCraft);
                craftFrom = {};
                for (const [ing, cnt] of Object.entries(recipe[0])) {
                    craftFrom[ing] = cnt * times;
                }
                // 合成原料本身缺不缺，逐个判断：缺就记为要采集
                for (const [ing, cnt] of Object.entries(craftFrom)) {
                    const haveIng = countInventoryItem(bot, ing);
                    const stillNeed = Math.max(0, cnt - haveIng);
                    if (stillNeed > 0) {
                        gather = gather || {};
                        gather[ing] = stillNeed;
                        mustGather.push({ item: ing.replace('minecraft:', ''), count: stillNeed });
                    }
                }
            } else {
                // 没有配方，只能直接采集
                gather = { [name]: missing };
                mustGather.push({ item: name, count: missing });
            }
        }

        shortfall += missing;
        lines.push({ item: name, need, have, inStorage, missing, craftFrom, gather });

        const parts = [`need ${need}`, `have ${have}`];
        if (inStorage > 0) parts.push(`chest ${inStorage}`);
        if (missing > 0) parts.push(`MISSING ${missing}`);
        log(bot, `  ${name}: ${parts.join(', ')}` +
            (craftFrom ? ` -> craft from ${Object.entries(craftFrom).map(([k, v]) => `${k}x${v}`).join('+')}` : '') +
            (gather ? ` -> gather ${Object.entries(gather).map(([k, v]) => `${k}x${v}`).join('+')}` : ''));
    }

    // 合并重复的采集需求
    const merged = {};
    for (const g of mustGather) {
        const key = g.item.replace('minecraft:', '');
        merged[key] = (merged[key] || 0) + g.count;
    }
    const finalGather = Object.entries(merged).map(([item, count]) => ({ item, count }));

    const ok = shortfall === 0;
    log(bot, ok
        ? 'All required materials are on hand or in storage.'
        : `Shortfall ${shortfall} item(s). To gather: ${finalGather.map(g => `${g.item}x${g.count}`).join(', ') || 'nothing craftable - check the item name'}`);
    return { ok, lines, mustGather: finalGather, shortfall };
}

export async function guardInventory(bot, needSlots = 5) {
    /**
     * Make room BEFORE collecting, so picked-up items are not dropped on the ground.
     * If free slots are below needSlots it walks to the storage chests and files away
     * everything that is not a tool or food.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} needSlots, how many free slots are needed. Defaults to 5.
     * @returns {Promise<Object>} { ok, freeSlots, freed, reason }
     * @example
     * const g = await skills.guardInventory(bot, 8);
     * if (!g.ok) log(bot, 'Not enough room to collect safely.');
     **/
    let free = bot.inventory.emptySlotCount();
    if (free >= needSlots) {
        log(bot, `Inventory has ${free} free slots - enough for collecting (need ${needSlots}).`);
        return { ok: true, freeSlots: free, freed: 0, reason: 'enough_space' };
    }

    log(bot, `Only ${free} free slots, need ${needSlots}. Filing items into storage first.`);
    const area = landmarks.getStorageArea(bot);
    if (!area) {
        log(bot, 'No storage area set, cannot free space. Set one up with skills.setupStorage().');
        return { ok: false, freeSlots: free, freed: 0, reason: 'no_storage_area' };
    }

    const before = free;
    const r = await tidyInventory(bot, { keepTools: true, keepFood: true });
    free = bot.inventory.emptySlotCount();
    const freed = free - before;

    if (free >= needSlots) {
        log(bot, `Freed ${freed} slots, now ${free} free - safe to collect.`);
        return { ok: true, freeSlots: free, freed, reason: 'freed' };
    }
    log(bot, `Still only ${free} free slots after filing. Need ${needSlots} - consider crafting more chests or dropping junk.`);
    return { ok: false, freeSlots: free, freed, reason: 'still_short' };
}

// ---------------------------------------------------------------------------
// 仓库区：整齐排布 + 照明防怪
// ---------------------------------------------------------------------------

/**
 * 从 origin 出发，找一条适合排箱子的一行地面。
 * 要求：连续 width 格都能站；脚下实心；上方两格空气。
 * @returns {{axis:'x'|'z', sign:1|-1, y:number}|null}
 */

// ---------------------------------------------------------------------------
// 仓库：建成一间真正的房间（地板/墙/天花板/门/照明），箱子贴墙成排
// ---------------------------------------------------------------------------

/**
 * 仓库房间尺寸。内部净空 5x5、净高 3 格，是能开箱的最小值：
 *   地板 FLOOR_Y-1 / 箱子与走道 FLOOR_Y / 开箱空间 FLOOR_Y+1 / 天花板 FLOOR_Y+2
 * 箱子上方必须是空气或透明方块才能打开，所以箱子正上方那一格必须留空。
 */
export const WAREHOUSE = {
    innerSize: 7,     // 内部净空 7x7：四面墙各一排，足够 6 个分类且不相邻
    innerHeight: 3,
    get outerSize() { return this.innerSize + 2; },
    get outerHeight() { return this.innerHeight + 2; },
};

/**
 * 是否为不透明实体方块（决定能不能当墙、会不会挡住开箱）。
 */
function isSolidOpaque(block) {
    if (!block) return false;
    const n = block.name;
    if (n === 'air' || n === 'cave_air' || n === 'void_air') return false;
    return block.boundingBox === 'block';
}

/**
 * 该格能否作为「开箱空间」：空气或透明/非完整方块（火把、玻璃、台阶）都算可以。
 */
function isOpenableAbove(block) {
    if (!block) return true;
    const n = block.name;
    if (n === 'air' || n === 'cave_air' || n === 'void_air') return true;
    return block.boundingBox !== 'block';
}

/**
 * 扫描 size x size 区域是否适合建房：地面高差小且上方净空足够。
 */
// 这些虽然不是空气，但**不是地面**：树冠、树干、花草、雪层。
// 原来把它们当成"地面"，一棵树就能让高差虚高 8 格，于是永远整不平。
// NOT_GROUND 的 owner 是 world_model.js（经 heatmap re-export）；
// 这里原来还各有一份，内容和 heatmap 那份不一致（多 15 项），已收敛。
const NOT_GROUND = WM_NOT_GROUND;

/**
 * 找出某一列真正的「地面」高度：从高往低找第一个实体方块，
 * 但跳过树叶/树干/花草这类明显不是地面的东西。
 */
function findGroundY(bot, x, z, fromY, toY) {
    for (let y = fromY; y > toY; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) continue;
        if (NOT_GROUND.has(b.name)) continue;
        if (isSolidOpaque(b)) return y;
    }
    return null;
}

function surveyFlatArea(bot, x0, z0, size, maxHeightDiff = 1) {
    const baseY = bot.entity.position.floored().y;
    const heights = [];
    const reasons = [];
    for (let dx = 0; dx < size; dx++) {
        for (let dz = 0; dz < size; dz++) {
            const x = x0 + dx, z = z0 + dz;
            const groundY = findGroundY(bot, x, z, baseY + 8, baseY - 8);
            if (groundY === null) { reasons.push(`(${x},${z}) 无地面`); continue; }
            heights.push({ x, z, groundY });
        }
    }
    if (!heights.length) return { ok: false, y: null, reasons };
    const ys = heights.map(h => h.groundY).sort((a, b) => a - b);
    const minY = ys[0], maxY = ys[ys.length - 1];
    // 用中位数当目标高度，而不是最低点。最低点意味着要把整片都填上来，土方量最大，
    // 也最容易因为填充深度不够而"铲平后仍有高差"。中位数让挖填量最小。
    const medianY = ys[Math.floor(ys.length / 2)];
    if (maxY - minY > maxHeightDiff) {
        reasons.push(`地面高差 ${maxY - minY} 格`);
        return { ok: false, y: medianY, minY, maxY, medianY, reasons };
    }
    // 统一约定：返回的 y 一律是「地面方块的 y」（人站在 y+1）。
    const y = medianY;
    for (let dy = 1; dy <= WAREHOUSE.outerHeight; dy++) {
        for (const h of heights) {
            const b = bot.blockAt(new Vec3(h.x, y + dy, h.z));
            if (isSolidOpaque(b)) {
                reasons.push(`(${h.x},${y + dy},${h.z}) 上方有 ${b.name}`);
                return { ok: false, y, reasons };
            }
        }
    }
    return { ok: true, y, reasons };
}

/**
 * 放一个方块。优先用 /setblock —— 这是关键：
 * mineflayer 的手动放置需要「依附方块」（placeBlock 内部要找一个能贴的实心面），
 * 而盖房间时地板下面常常是空气，于是报 "nothing to place on"，
 * 结果一个方块都放不上（实测踩过：96 格墙全成了空气）。
 * bot 是 OP，直接用指令最可靠，也已经过 buildFromSchematic（3784 块）验证。
 */
async function safePlace(bot, blockType, x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const name = String(blockType).replace('minecraft:', '');
    const cur = bot.blockAt(new Vec3(fx, fy, fz));
    if (cur && cur.name === name) return 'exists';
    // 保护逻辑：只挡「玩家建筑」，不挡自然地形。
    // 地板本来就要盖在草地上，如果连草也算"已有建筑"，地板永远铺不上（实测 0/81）。
    if (cur && cur.name !== 'air' && cur.name !== 'cave_air' && isSolidOpaque(cur)) {
        const isNaturalTerrain = NATURAL_BLOCKS.has(cur.name) || NOT_GROUND.has(cur.name);
        if (!isNaturalTerrain) return 'blocked';
        // 自然地形允许被覆盖
    }

    try {
        await command(bot, 'setblock', [fx, fy, fz, `minecraft:${name}`], { cheat: true });
        await new Promise(r => setTimeout(r, 60));
        const after = bot.blockAt(new Vec3(fx, fy, fz));
        if (after && after.name === name) return 'placed';
    } catch (err) { /* 落到下面的手动方式 */ }

    // 指令失败才退回手动放置
    try {
        return await placeBlockWithoutBreaking(bot, name, fx, fy, fz);
    } catch (err) {
        return 'failed';
    }
}

/**
 * 放一个指定朝向的箱子。锁扣（facing）朝哪一面，就是玩家从哪一面打开的正面。
 * 用 /setblock 精确控制朝向 —— mineflayer 的普通放置不保证 facing，
 * 会出现锁扣朝墙、正面贴墙的情况，看起来别扭也不像仓库。
 * @param {string} facing 'north'|'south'|'east'|'west'
 */
async function placeChestFacing(bot, x, y, z, facing) {
    const existing = bot.blockAt(new Vec3(x, y, z));
    if (existing && existing.name === 'chest') return 'exists';
    if (existing && existing.name !== 'air' && existing.name !== 'cave_air') return 'blocked';

    // 优先用指令精确指定朝向（bot 有 OP）
    try {
        await command(bot, 'setblock', [Math.floor(x), Math.floor(y), Math.floor(z), `minecraft:chest[facing=${facing}]`], { cheat: true });
        await new Promise(r => setTimeout(r, 120));
        const after = bot.blockAt(new Vec3(x, y, z));
        if (after && after.name === 'chest') return 'placed';
    } catch (err) { /* 指令失败就退回普通放置 */ }

    // 退回普通放置（朝向不保证，但至少有个箱子）
    const r = await safePlace(bot, 'chest', x, y, z);
    log(bot, `  (could not set facing=${facing}, placed without a specific direction)`);
    return r;
}

// ===========================================================================
// 仓库：拆成三个独立技能，每步都能单独验证
//   1) findStorageSite     —— 选址（避水 + 找平地），只读不写
//   2) buildStorageRoom    —— 只建房间外壳（地板/墙/顶/门/灯）
//   3) fillRoomWithChests  —— 只往已有房间里摆分类箱
// 这样某一步失败时，能立刻看出是"选不到地"、"房间没建"还是"箱子没摆"。
// ===========================================================================

export async function findStorageSite(bot, options = {}) {
/**
 * 第 1 步：选一块能建 9x9 仓库的地方。只读世界，不改任何方块。
 * 判据：地面高差 ≤1（忽略树叶/花草）、上方净空足够、附近没有水/岩浆。
 * @returns {Promise<Object>} { ok, center, floorY, reason, warnings }
 **/
    const S = WAREHOUSE.innerSize, OUT = WAREHOUSE.outerSize;
    const baseY = Math.floor(bot.entity.position.y);
    const warnings = [];

    // 从当前位置向外（八方位 × 半径 8..56）找最合适的一处
    const cands = [];
    const p0 = bot.entity.position.floored();
    const seeds = [{ x: p0.x, z: p0.z }];
    for (let rad = 8; rad <= 56; rad += 12) {
        for (let k = 0; k < 8; k++) {
            const ang = (k / 8) * Math.PI * 2;
            seeds.push({ x: Math.round(p0.x + Math.cos(ang) * rad), z: Math.round(p0.z + Math.sin(ang) * rad) });
        }
    }

    for (const seed of seeds) {
        if (bot.interrupt_code) break;
        const x0 = seed.x - Math.floor(S / 2), z0 = seed.z - Math.floor(S / 2);
        const flat = surveyFlatArea(bot, x0, z0, OUT, 1);
        if (!flat.ok) continue;

        // 水量统计：扫一格步长，命中越多越差
        let wet = 0;
        for (let dx = -2; dx <= OUT + 1; dx += 2) {
            for (let dz = -2; dz <= OUT + 1; dz += 2) {
                for (let dy = -1; dy <= 2; dy++) {
                    const b = bot.blockAt(new Vec3(x0 + dx, flat.y + dy, z0 + dz));
                    if (b && (b.name.includes('water') || b.name.includes('lava'))) { wet++; }
                }
            }
        }
        const dist = Math.abs(seed.x - p0.x) + Math.abs(seed.z - p0.z);
        // 打分：水优先（少的最好），其次距离（近的好）
        cands.push({ x: seed.x, z: seed.z, floorY: flat.y, wet, dist, score: wet * 100 + dist });
    }

    if (!cands.length) {
        log(bot, `No suitable site found within 56 blocks (need a flat ${OUT}x${OUT} area). Move somewhere flatter.`);
        return { ok: false, reason: 'no_flat_site' };
    }
    cands.sort((a, b) => a.score - b.score);
    const best = cands[0];
    if (best.wet > 0) warnings.push(`${best.wet} water/lava sample(s) near the site - drainage may be needed.`);

    log(bot, `Best site: (${best.x},${best.z}) floor y=${best.floorY}, ${best.dist} blocks away, ` +
        `${cands.length} candidate(s) evaluated, wet samples=${best.wet}.`);
    return { ok: true, center: { x: best.x, z: best.z }, floorY: best.floorY, warnings, candidates: cands.length };
}

export async function buildStorageRoom(bot, options = {}) {
/**
 * 第 2 步：在选定位置建仓库房间的外壳（地板 + 四面墙 + 天花板 + 门洞 + 火把）。
 * 不摆箱子 —— 箱子由 fillRoomWithChests 负责。
 * @returns {Promise<Object>} { ok, center, floorY, floor, walls, ceiling, torches, door, reason }
 **/
    const S = WAREHOUSE.innerSize, OUT = WAREHOUSE.outerSize;

    // 复用已有仓库区，或者现选一个
    let site = null;
    if (options.x != null && options.z != null) {
        const x0 = Math.floor(options.x) - Math.floor(S / 2);
        const z0 = Math.floor(options.z) - Math.floor(S / 2);
        const flat = surveyFlatArea(bot, x0, z0, OUT, 1);
        if (flat.ok) site = { center: { x: Math.floor(options.x), z: Math.floor(options.z) }, floorY: flat.y };
    }
    if (!site) {
        const r = await findStorageSite(bot, options);
        if (!r.ok) return { ok: false, reason: r.reason };
        site = r;
    }

    const center = site.center;
    const FLOOR_Y = site.floorY;          // 地面方块高度
    const CHEST_Y = FLOOR_Y + 1;          // 箱子/走道所在层（地面上方一层）
    const CEIL_Y = CHEST_Y + WAREHOUSE.innerHeight;
    let x0 = center.x - Math.floor(S / 2), z0 = center.z - Math.floor(S / 2);

    // 材料
    let wallBlock = options.wallBlock || null;
    if (!wallBlock || countInventoryItem(bot, wallBlock) < 20) {
        const cands = bot.inventory.items()
            .filter(i => /planks|log|cobblestone|stone_bricks|bricks|stone$/i.test(i.name))
            .sort((a, b) => b.count - a.count);
        if (cands.length) wallBlock = cands[0].name;
    }
    if (!wallBlock) {
        log(bot, 'No building material (~110 blocks of planks/stone).');
        return { ok: false, reason: 'no_material' };
    }
    log(bot, `Building room at (${center.x},${center.z}), floor y=${FLOOR_Y}, using ${wallBlock} ` +
        `(${countInventoryItem(bot, wallBlock)} available, ~110 needed).`);

    // 地板：铺在 FLOOR_Y（盖住原地表），这样室内高度统一
    let floorN = 0;
    for (let dx = 0; dx < OUT; dx++) {
        if (bot.interrupt_code) break;
        for (let dz = 0; dz < OUT; dz++) {
            if (await safePlace(bot, wallBlock, x0 + dx, FLOOR_Y, z0 + dz) === 'placed') floorN++;
        }
    }
    log(bot, `  floor: ${floorN}/${OUT * OUT}`);

    // 墙：从 FLOOR_Y+1 起，高 innerHeight
    const doorX = x0 + Math.floor(OUT / 2);
    let wallN = 0;
    for (let lv = 1; lv <= WAREHOUSE.innerHeight; lv++) {
        for (let dx = 0; dx < OUT; dx++) {
            if (bot.interrupt_code) break;
            for (let dz = 0; dz < OUT; dz++) {
                const onEdge = dx === 0 || dz === 0 || dx === OUT - 1 || dz === OUT - 1;
                if (!onEdge) continue;
                const x = x0 + dx, z = z0 + dz;
                // 门洞：北墙（z 最小），2 宽 × 2 高
                if (z === z0 && (x === doorX || x === doorX + 1) && lv <= 2) continue;
                if (await safePlace(bot, wallBlock, x, FLOOR_Y + lv, z) === 'placed') wallN++;
            }
        }
    }
    log(bot, `  walls: ${wallN}, door at (${doorX},${z0})`);

    // 天花板
    let ceilN = 0;
    for (let dx = 0; dx < OUT; dx++) {
        if (bot.interrupt_code) break;
        for (let dz = 0; dz < OUT; dz++) {
            if (await safePlace(bot, wallBlock, x0 + dx, CEIL_Y, z0 + dz) === 'placed') ceilN++;
        }
    }
    log(bot, `  ceiling: ${ceilN}/${OUT * OUT}`);

    // 照明：天花板下方，走道位置
    let torchN = 0;
    if (options.light !== false) {
        const spots = [
            { x: x0 + 2, z: z0 + 2 }, { x: x0 + OUT - 3, z: z0 + 2 },
            { x: x0 + 2, z: z0 + OUT - 3 }, { x: x0 + OUT - 3, z: z0 + OUT - 3 },
        ];
        for (const sp of spots) {
            if (bot.interrupt_code) break;
            if (countInventoryItem(bot, 'torch') <= 0) break;
            if (await safePlace(bot, 'torch', sp.x, CEIL_Y - 1, sp.z) === 'placed') torchN++;
        }
        log(bot, `  torches: ${torchN}`);
    }

    landmarks.rememberStorageArea(bot, { x: center.x, y: CHEST_Y, z: center.z }, 'main_storage');
    // ★ S42：原来的成功判据是 `floorN > 0 && wallN > 0 && ceilN > 0` ——
    //   1 块地板 + 1 块墙 + 1 块天花板也算"房间建好了"，于是上层接着去摆箱子，
    //   摆进一个根本没围起来的地方。现在按**期望面积/周长**判定：
    //     地板/天花板：OUT×OUT 格；墙：周长 × innerHeight，扣掉门洞（2 宽 × 2 高）。
    const expectFloor = OUT * OUT;
    const expectCeil = OUT * OUT;
    const expectWalls = (4 * OUT - 4) * WAREHOUSE.innerHeight - 4;   // 周长格数 × 层数 − 门洞 2×2
    // 容差 10%：safePlace 偶尔把"已经是目标方块"记为 exists 不计入 placed，
    // 用硬等号会把一次正常的重建判成失败。
    const enough = (got, want) => want > 0 && got >= Math.ceil(want * 0.9);
    const ok = enough(floorN, expectFloor) && enough(wallN, expectWalls) && enough(ceilN, expectCeil);
    log(bot, `Room ${ok ? 'OK' : 'INCOMPLETE'}: floor=${floorN}/${expectFloor} ` +
        `walls=${wallN}/${expectWalls} ceiling=${ceilN}/${expectCeil} torches=${torchN}. ` +
        `Now run skills.fillRoomWithChests(bot) to place the chests.`);
    return {
        ok, center, floorY: FLOOR_Y, chestY: CHEST_Y, ceilY: CEIL_Y,
        floor: floorN, walls: wallN, ceiling: ceilN, torches: torchN,
        expected: { floor: expectFloor, walls: expectWalls, ceiling: expectCeil },
        door: { x: doorX, z: z0 }, wallBlock,
        reason: ok ? 'built' : 'incomplete',
    };
}

export async function fillRoomWithChests(bot, options = {}) {
/**
 * 第 3 步：往已建好的仓库房间里摆分类箱（贴墙、朝向走道、格子留空）。
 * 先验证房间存在（有地板有墙），再摆箱子。
 * @returns {Promise<Object>} { ok, placed:[{category,pos,facing}], skipped, roomFound, reason }
 **/
    const S = WAREHOUSE.innerSize, OUT = WAREHOUSE.outerSize;
    const cats = options.categories || storage.allCategories();

    const area = landmarks.getStorageArea(bot);
    if (!area) {
        log(bot, 'No storage area recorded. Run skills.buildStorageRoom(bot) first.');
        return { ok: false, reason: 'no_room', placed: [], skipped: [], roomFound: false };
    }
    const center = { x: area.x, z: area.z };
    const CHEST_Y = area.y;
    const x0 = center.x - Math.floor(S / 2), z0 = center.z - Math.floor(S / 2);

    // 验证房间真的在：检查地板和四角墙
    const probe = (x, y, z) => {
        const b = bot.blockAt(new Vec3(x, y, z));
        return b ? b.name : 'unknown';
    };
    // ★ S42：这两个探针位置过去是**硬编码的 4**，把 innerSize=7（OUT=9）钉死在代码里。
    //   改 innerSize 就会探到房间外面去（于是要么把空地说成"房间在"，要么把好房间说成"没房间"）。
    //   现在按几何推导：房间中心格 = floor(OUT/2)（OUT=9 时正好是 4）。
    const probeMid = Math.floor(OUT / 2);
    const floorProbe = probe(x0 + probeMid, CHEST_Y - 1, z0 + probeMid);
    const wallProbe = probe(x0, CHEST_Y, z0 + probeMid);
    const roomFound = floorProbe !== 'unknown' && floorProbe !== 'air'
        && wallProbe !== 'unknown' && wallProbe !== 'air';
    if (!roomFound) {
        log(bot, `No room found at (${center.x},${center.z}) — floor there is "${floorProbe}", wall is "${wallProbe}". ` +
            `Run skills.buildStorageRoom(bot) first.`);
        return { ok: false, reason: 'room_missing', placed: [], skipped: [], roomFound: false,
                 detail: { floorProbe, wallProbe } };
    }

    // 箱子位：贴四面墙内侧，步长 2（留空隔开，避免合并成大箱子）
    const spots = [];
    for (let dx = 1; dx < OUT - 2; dx += 2) {
        spots.push({ x: x0 + dx, y: CHEST_Y, z: z0 + 1, wall: 'north', facing: 'south' });
        spots.push({ x: x0 + dx, y: CHEST_Y, z: z0 + OUT - 2, wall: 'south', facing: 'north' });
    }
    // 东西两侧的箱位：从 z0+3 起、到 OUT-3 结束（跳过南北两排箱位所占的 1..2 与 OUT-2..OUT-1）。
    // 这个 3 是"相对两端的固定偏移"，不是绝对坐标，所以 innerSize 改了仍然正确。
    for (let dz = 3; dz < OUT - 3; dz += 2) {
        spots.push({ x: x0 + 1, y: CHEST_Y, z: z0 + dz, wall: 'west', facing: 'east' });
        spots.push({ x: x0 + OUT - 2, y: CHEST_Y, z: z0 + dz, wall: 'east', facing: 'west' });
    }

    log(bot, `Room found at (${center.x},${center.z}). Placing ${Math.min(cats.length, spots.length)} chest(s) ` +
        `from ${spots.length} spot(s), chest material: ${countInventoryItem(bot, 'chest')}.`);

    const placed = [], skipped = [];
    let ci = 0;
    for (const s of spots) {
        if (bot.interrupt_code) break;
        if (ci >= cats.length) break;
        const cat = cats[ci];

        // 该分类是否已有有效箱子（记录可能过期，逐个验证）
        const old = landmarks.chestsByCategory(bot, cat)
            .filter(c => Math.abs(c.x - center.x) <= OUT + 2 && Math.abs(c.z - center.z) <= OUT + 2);
        let exist = null;
        for (const c of old) {
            const b = bot.blockAt(new Vec3(c.x, c.y, c.z));
            if (b && b.name === 'chest') { exist = c; break; }
            landmarks.forgetChest(bot, c);
        }
        if (exist) { skipped.push({ category: cat, reason: 'exists', pos: exist }); ci++; continue; }

        // 需要箱子
        let have = countInventoryItem(bot, 'chest') > 0;
        if (!have) {
            const planks = bot.inventory.items().filter(i => i.name.endsWith('_planks'))
                .reduce((a, i) => a + i.count, 0);
            if (planks >= 8) have = (await craftRecipe(bot, 'chest', 1)) && countInventoryItem(bot, 'chest') > 0;
        }
        if (!have) { skipped.push({ category: cat, reason: 'no_chest_material' }); ci++; continue; }

        const r = await placeChestFacing(bot, s.x, s.y, s.z, s.facing);
        if (r === 'placed' || r === 'exists') {
            landmarks.rememberChest(bot, s, `storage_${cat}`, { category: cat, contents: {} });
            placed.push({ category: cat, pos: { x: s.x, y: s.y, z: s.z }, facing: s.facing });
            log(bot, `  [${storage.categoryLabel(cat)}] (${s.x},${s.y},${s.z}) facing ${s.facing}`);
        } else {
            skipped.push({ category: cat, reason: r, at: { x: s.x, y: s.y, z: s.z } });
            log(bot, `  [${storage.categoryLabel(cat)}] FAILED at (${s.x},${s.y},${s.z}): ${r}`);
        }
        ci++;
    }

    const ok = placed.length > 0;
    log(bot, `Chests ${ok ? 'placed' : 'NOT placed'}: ${placed.length} ok, ${skipped.length} skipped.`);
    return { ok, placed, skipped, roomFound: true, reason: ok ? 'placed' : 'none_placed', center };
}

/**
 * 一键建仓库：内部依次调用上面三步，便于"我就要个仓库"的场合。
 * 但每一步的结果都会单独打印，方便定位是哪一步出问题。
 **/
export async function buildStorageWarehouse(bot, options = {}) {
    /**
     * One-shot: pick a site, build the room, then fill it with chests.
     * Internally runs findStorageSite -> buildStorageRoom -> fillRoomWithChests
     * and reports each step separately so failures are easy to locate.
     * For finer control call the three steps yourself.
     * @param {MinecraftBot} bot
     * @param {Object} options { x, z, wallBlock, light, categories }
     * @returns {Promise<Object>} { ok, site, room, chests }
     * @example
     * const r = await skills.buildStorageWarehouse(bot);
     */
    log(bot, '=== Storage warehouse: step 1/3 find site ===');
    const site = await findStorageSite(bot, options);
    if (!site.ok) {
        return { ok: false, step: 'site', reason: site.reason, site };
    }

    log(bot, '=== step 2/3 build room ===');
    const room = await buildStorageRoom(bot, { ...options, x: site.center.x, z: site.center.z });
    if (!room.ok) {
        return { ok: false, step: 'room', reason: room.reason, site, room };
    }

    log(bot, '=== step 3/3 place chests ===');
    const chests = await fillRoomWithChests(bot, options);

    const ok = room.ok && chests.ok;
    log(bot, `=== Warehouse ${ok ? 'DONE' : 'PARTIAL'}: room(${room.floor}/${room.walls}/${room.ceiling}) ` +
        `chests(${chests.placed.length}) ===`);
    return { ok, site, room, chests };
}


// ===========================================================================
// 搁置项补齐：箱子核对 / 任务续做 / 危险区记忆
// 注意本项目约定：JSDoc 必须写在函数体内第一行，且以 **/ 闭合，
// 否则 docHelper（skillFunc.toString()）提取不到，模型就看不见这个函数。
// ===========================================================================

export async function verifyChest(bot, chestPos = null) {
    /**
     * Open a chest and tell the truth about what is inside, then correct the saved record.
     * The remembered `contents` can go stale (you put something in by hand, a creeper blew
     * a hole, etc.), so use this before relying on skills.findItemInStorage().
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} chestPos, {x,y,z} of the chest. Defaults to the nearest remembered chest.
     * @returns {Promise<Object>} { ok, pos, contents, changed, reason }
     * @example
     * const v = await skills.verifyChest(bot);
     * log(bot, `chest really holds: ${JSON.stringify(v.contents)}`);
     **/
    let target = chestPos;
    if (!target) {
        const known = landmarks.loadLandmarks(bot).chests;
        if (!known.length) {
            log(bot, 'No chest recorded yet, nothing to verify.');
            return { ok: false, reason: 'no_chest' };
        }
        const me = bot.entity.position;
        known.sort((a, b) => a.distanceTo?.(me) ?? 0);
        // 按实际距离排序，取最近的
        const withDist = known.map(c => ({
            c, d: Math.hypot(c.x - me.x, c.y - me.y, c.z - me.z),
        })).sort((a, b) => a.d - b.d);
        target = withDist[0].c;
    }

    const block = bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!block || block.name !== 'chest') {
        log(bot, `No chest at (${target.x},${target.y},${target.z}) - the record is stale, forgetting it.`);
        landmarks.forgetChest(bot, target);
        return { ok: false, reason: 'chest_gone', pos: target };
    }

    let container;
    try {
        await goToPosition(bot, target.x, target.y, target.z, 2);
        container = await bot.openContainer(block);
    } catch (err) {
        log(bot, `Could not open the chest at (${target.x},${target.y},${target.z}): ${err}`);
        return { ok: false, reason: 'open_failed', pos: target };
    }

    let contents = {};
    try {
        const winOk = checkWindow(bot, container);
        if (!winOk.ok) {
            log(bot, `核对失败：${winOk.message}`);
            return { ok: false, reason: 'window_closed', pos: target, detail: winOk.message };
        }
        contents = storage.summarizeContainer(container);
    } finally {
        try { await container.close(); } catch (e) { /* ignore */ }
    }

    // 对比旧记录，标出差异
    const old = landmarks.loadLandmarks(bot).chests
        .find(c => c.x === target.x && c.y === target.y && c.z === target.z);
    const oldContents = old?.contents || {};
    const changed = JSON.stringify(oldContents) !== JSON.stringify(contents);

    landmarks.updateChestContents(bot, target, contents, old?.category || null);

    const items = Object.entries(contents);
    log(bot, `Verified chest (${target.x},${target.y},${target.z}): ` +
        (items.length ? items.map(([n, v]) => `${n}x${v}`).join(', ') : 'empty') +
        (changed ? '  [record corrected]' : '  [record was already correct]'));

    return { ok: true, pos: target, contents, changed, category: old?.category || null };
}

export async function markDanger(bot, x = null, y = null, z = null, reason = 'unknown', radius = 8) {
    /**
     * Remember that a place is dangerous (lava, a mob pit, a cliff, water you drowned in).
     * Once recorded, skills.isSafeHere() will warn about it and skills.recoverDeathItems()
     * will refuse to walk back blindly. Calling it again for the same area increases its
     * "hits" counter, so repeated trouble can be told apart from a one-off.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, y, z, the danger position. Defaults to the bot's current position.
     * @param {string} reason, short human-readable reason, e.g. "lava pit" / "died here twice".
     * @param {number} radius, how wide the danger zone is. Defaults to 8.
     * @returns {Promise<Object>} { ok, entry }
     * @example
     * await skills.markDanger(bot, null, null, null, 'lava pit', 6);
     **/
    const p = bot.entity.position.floored();
    const pos = {
        x: x == null ? Math.floor(p.x) : Math.floor(x),
        y: y == null ? Math.floor(p.y) : Math.floor(y),
        z: z == null ? Math.floor(p.z) : Math.floor(z),
    };

    const list = store.readStore(bot, 'dangers') || [];
    // 半径内有旧记录就累加 hits，不重复添加
    const near = list.find(d => Math.hypot(d.x - pos.x, d.z - pos.z) <= Math.max(radius, d.radius || 8));
    if (near) {
        near.hits = (near.hits || 1) + 1;
        near.lastHit = Date.now();
        if (reason && reason !== 'unknown') near.reason = reason;
        store.writeStore(bot, 'dangers', list);
        log(bot, `Danger area near (${near.x},${near.y},${near.z}) recorded ${near.hits} time(s): ${near.reason}.`);
        return { ok: true, entry: near, repeated: true };
    }

    const entry = { ...pos, radius, reason, hits: 1, lastHit: Date.now() };
    list.push(entry);
    // 只保留最近 32 条，避免无限增长
    store.writeStore(bot, 'dangers', list.slice(-32));
    log(bot, `Marked danger at (${pos.x},${pos.y},${pos.z}) r=${radius}: ${reason}.`);
    return { ok: true, entry, repeated: false };
}

export async function isSafeHere(bot, x = null, y = null, z = null) {
    /**
     * Check whether a place is safe to work in: looks for remembered danger zones,
     * lava/water right next to the spot, and **all** hostile mobs within 12 blocks
     * (not just the nearest one). The hostile judgement is the same function the
     * atomic layer (`query_safe.isSafe`) uses.
     * Call this before building or storing things somewhere unfamiliar.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, y, z, the position to check. Defaults to the bot's current position.
     * @returns {Promise<Object>} { safe, reasons:[], dangers:[], hazards:[], hostiles }
     * @example
     * const s = await skills.isSafeHere(bot);
     * if (!s.safe) log(bot, 'Not safe: ' + s.reasons.join('; '));
     **/
    const p = bot.entity.position.floored();
    const pos = {
        x: x == null ? Math.floor(p.x) : Math.floor(x),
        y: y == null ? Math.floor(p.y) : Math.floor(y),
        z: z == null ? Math.floor(p.z) : Math.floor(z),
    };
    const reasons = [];

    // ★ 第20条（2026-11-05 R1 收尾）：本函数**故意不整体转发**给 `query_safe.isSafe`，
    //   原因是它多一份原子层没有的信息：地形危险走 `collectHazardsCached`（TTL 缓存 +
    //   store 里的 hazards 记忆合并，见下方 S37 注释），而原子层为了不丢方块名、不把圆心
    //   定在 bot 身上，自己用 findBlocks 枚举。整体转发会同时（a）让这份记忆/缓存重新变成
    //   死代码（S37 修过的正是这个），（b）丢掉"上次扫到、这次没扫到"的历史危险。
    //   所以"同源"落在**判据**上：敌对生物计数 → query_safe.hostilesNear（两边同一个函数）。
    //   危险/液体两条本来就与原子层同规则（先查记忆、再采样、再枚举），不是分叉。

    // 1) 危险：手工标记 + 地形枚举，两份都查（owner 是 world_model.dangersAt）
    //    以前这里只读 dangers（人标的），规划器只读 hazards（枚举），
    //    于是"规划器会绕开的岩浆，安全检查说安全" —— 两个真相。
    const dangerHit = worldModel.dangersAt(bot, pos.x, pos.z);
    const hitDangers = dangerHit.hitDangers;
    const hitHazards = dangerHit.hitHazards;
    for (const r of dangerHit.reasons) reasons.push(r);

    // 2) 附近液体：采样（看得到水）+ 精确枚举（不漏岩浆）
    //    采样只扫 ±4 格、步长 2，5~10 格外的岩浆会被漏掉；
    //    而规划器是靠 findBlocks 枚举的 —— 方法不一致就会得出不同结论。
    //    这里补一次 radius 8 的枚举（很便宜），让安全检查的判据和规划器对齐。
    let liquids = 0;
    for (let dx = -4; dx <= 4; dx += 2) {
        for (let dz = -4; dz <= 4; dz += 2) {
            for (let dy = -2; dy <= 2; dy++) {
                const b = bot.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
                if (b && (b.name.includes('lava') || b.name.includes('water'))) liquids++;
            }
        }
    }
    if (liquids > 0) reasons.push(`${liquids} lava/water block(s) within 4 blocks`);

    let nearHazards = 0;
    try {
        // ★ S37：collectHazardsCached 过去是**死代码**（全树只有定义处 1 命中）——
        //   于是缓存永不填、`resetHazardCache()` 空转（!forgetHazards 清了也不起作用），
        //   而这里每次重枚举一次（半径 64 约 183ms）。现在改成走它：
        //   缓存与记忆（store.hazards）真正生效，`!forgetHazards` 也终于有意义。
        //
        //   ★ 判据必须看 **blobs 里落在这 8 格范围内的块**，不能看"这次新扫到几个"：
        //     命中缓存时 fresh=0，若按 fresh 计数就会把"记得的岩浆"报成"安全"。
        const scan = collectHazardsCached(bot, { radius: 8 });
        nearHazards = (scan.blobs || []).filter(b =>
            b.x0 <= pos.x + 8 && b.x1 >= pos.x - 8 && b.z0 <= pos.z + 8 && b.z1 >= pos.z - 8).length;
        if (nearHazards > 0) {
            reasons.push(`${nearHazards} lava/fire block(s) within 8 blocks (enumerated${scan.fromCache ? ', from memory cache' : ''})`);
        }
    } catch (err) { /* 枚举失败就只靠上面的采样 */ }

    // 3) 附近敌对生物
    // ★ 第20条（2026-11-05 R1 收尾）：这里过去是 `world.getNearestEntityWhere(...)`
    //   —— 拿到最近的那一只就 `hostiles = 1`。于是"被 10 只僵尸围住"和"旁边站 1 只僵尸"
    //   报告得一模一样，而同一个问题问 `query_safe.isSafe` 得到的是**全数**。
    //   现在两边都调 `query_safe.hostilesNear`：认哪些名字、半径多大、怎么数都只有一处。
    let hostiles = 0;
    const hostileHit = hostilesNear(bot, pos, { radius: 12 });
    hostiles = hostileHit.count;
    if (hostiles > 0) {
        reasons.push(`${hostiles} hostile mob(s) within 12 blocks (${hostileHit.names.join(', ')})`);
    }

    const safe = reasons.length === 0;
    log(bot, safe
        ? `(${pos.x},${pos.y},${pos.z}) looks safe.`
        : `(${pos.x},${pos.y},${pos.z}) NOT safe: ${reasons.join('; ')}.`);
    return { safe, reasons, dangers: hitDangers, hazards: hitHazards, liquids, nearHazards, hostiles, pos };
}

export async function recordTaskProgress(bot, taskId, total, done, note = '') {
    /**
     * Save how far a long job has got, so it can be resumed after a restart or interruption.
     * Use it inside long loops: building 3784 blocks, levelling a 50x50 area, mining a vein.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} taskId, a stable id you choose, e.g. "build_house_a".
     * @param {number} total, total number of steps.
     * @param {number} done, how many are finished.
     * @param {string} note, optional free text, e.g. the blueprint path.
     * @returns {Promise<Object>} { ok, task }
     * @example
     * await skills.recordTaskProgress(bot, 'build_house_a', 3784, 1200, './schematics/house.litematic');
     **/
    const tasks = store.readStore(bot, 'tasks') || {};
    tasks[taskId] = {
        title: taskId,
        total: Math.max(0, Math.floor(total)),
        done: Math.max(0, Math.floor(done)),
        note,
        updated: Date.now(),
    };
    store.writeStore(bot, 'tasks', tasks);
    const pct = tasks[taskId].total > 0 ? Math.round(tasks[taskId].done / tasks[taskId].total * 100) : 0;
    log(bot, `Task "${taskId}" progress saved: ${tasks[taskId].done}/${tasks[taskId].total} (${pct}%).`);
    return { ok: true, task: tasks[taskId] };
}

export async function resumeTask(bot, taskId = null) {
    /**
     * Read back how far a long job had got. Call this after a restart to continue where
     * you stopped instead of starting over. With no taskId it lists every unfinished task.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} taskId, the job id to look up. Omit to list all unfinished jobs.
     * @returns {Promise<Object>} { found, task, remaining, unfinished:[] }
     * @example
     * const r = await skills.resumeTask(bot, 'build_house_a');
     * if (r.found) log(bot, `${r.remaining} blocks left to place`);
     **/
    const tasks = store.readStore(bot, 'tasks') || {};
    const unfinished = Object.entries(tasks)
        .filter(([, t]) => t && t.done < t.total)
        .map(([id, t]) => ({ id, ...t }));

    if (!taskId) {
        if (!unfinished.length) {
            log(bot, 'No unfinished tasks recorded.');
            return { found: false, task: null, remaining: 0, unfinished: [] };
        }
        log(bot, `Unfinished tasks: ${unfinished.map(t => `${t.id} ${t.done}/${t.total}`).join('; ')}`);
        return { found: true, task: null, remaining: 0, unfinished };
    }

    const t = tasks[taskId];
    if (!t) {
        log(bot, `No task recorded under "${taskId}".`);
        return { found: false, task: null, remaining: 0, unfinished };
    }
    const remaining = Math.max(0, t.total - t.done);
    const pct = t.total > 0 ? Math.round(t.done / t.total * 100) : 0;
    log(bot, `Task "${taskId}": ${t.done}/${t.total} done (${pct}%), ${remaining} left` +
        (t.note ? `, note: ${t.note}` : '') + '.');
    return { found: true, task: t, remaining, unfinished };
}

export async function clearTask(bot, taskId) {
    /**
     * Remove a finished or abandoned job from the progress list.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} taskId, the job id to remove.
     * @returns {Promise<Object>} { ok, removed }
     * @example
     * await skills.clearTask(bot, 'build_house_a');
     **/
    const tasks = store.readStore(bot, 'tasks') || {};
    if (!tasks[taskId]) {
        log(bot, `No task named "${taskId}".`);
        return { ok: false, removed: false };
    }
    delete tasks[taskId];
    store.writeStore(bot, 'tasks', tasks);
    log(bot, `Cleared task "${taskId}".`);
    return { ok: true, removed: true };
}

/**
 * 危险枚举的内存缓存（短 TTL）。
 *
 * 为什么只缓存枚举、不缓存整张热力图：
 *   - 枚举（findBlocks）是贵的那部分：64 格 183ms
 *   - 建图是便宜的：8~15ms，而且地形高度会随放/拆方块立刻变
 * 所以缓存"缓慢变化的危险"，每次都重算"快速变化的地形"。
 *
 * 键按 8 格取整（走两步不会 miss），TTL 默认 3 秒（同一次任务里的连续调用才命中）。
 * `resetHazardCache()` 供 !forgetHazards 用：清掉记忆后必须让缓存一起失效，
 * 否则下一次调用会拿到已经被删掉的旧结果。
 */
const hazardScanCache = new Map();
const HAZARD_SCAN_TTL_MS = 3000;

export function resetHazardCache() {
    hazardScanCache.clear();
}

/**
 * 带记忆的地形危险枚举：查内存缓存 → 本次枚举 → 合并 → 写回。
 *
 * 为什么要有记忆：`collectHazards` 只能看到当前 64 格范围，而危险是长期存在的。
 * 但危险又会变（岩浆被填掉、水冲走），所以合并规则是：
 *   - 扫到的 → 更新 seenAt
 *   - 范围内没再扫到 → 删（已被清理）
 *   - 范围外 → 保留（这次没查不等于没有）
 *   - 太久没复核 → 失效
 * 见 world_model.mergeHazardBlobs。
 *
 * @returns {{blobs: Array, fresh: number, cached: number, expired: number, fromCache: boolean}}
 */
function collectHazardsCached(bot, opts = {}) {
    const radius = opts.radius ?? 64;
    const p = bot.entity.position;
    const ttl = opts.scanTtlMs ?? HAZARD_SCAN_TTL_MS;

    const key = `${bot.username || 'bot'}|${Math.round(p.x / 8)}|${Math.round(p.z / 8)}|${radius}`;
    const now = Date.now();
    const hit = hazardScanCache.get(key);
    if (hit && now - hit.at < ttl) {
        return { blobs: hit.blobs, fresh: 0, cached: hit.blobs.length, expired: 0, fromCache: true };
    }

    const prev = store.readStore(bot, 'hazards') || [];
    const fresh = wmCollectHazards(bot, { radius });
    const merged = wmMergeHazardBlobs(prev, fresh, {
        ttlMs: opts.ttlMs ?? 10 * 60 * 1000,
        scanned: { cx: Math.floor(p.x), cz: Math.floor(p.z), radius },
    });
    store.writeStore(bot, 'hazards', merged);
    hazardScanCache.set(key, { blobs: merged, at: now });
    // 缓存别无限长大
    if (hazardScanCache.size > 32) {
        const oldest = [...hazardScanCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        hazardScanCache.delete(oldest[0]);
    }

    const keptFromCache = merged.filter(m => !fresh.some(f =>
        f.x0 <= m.x1 && f.x1 >= m.x0 && f.z0 <= m.z1 && f.z1 >= m.z0)).length;
    return {
        blobs: merged, fresh: fresh.length, cached: keptFromCache,
        expired: Math.max(0, prev.length - keptFromCache),
        fromCache: false,
    };
}

/**
 * 探一片地形，生成热力图摘要（只读，不改世界）。
 * 热力图把周围压成代价网格：危险区(岩浆/火/仙人掌)是精确轮廓，水面/悬崖是高价但可走。
 * 用这个先看清周围情况，再决定去哪里、怎么走，比直接瞎跑可靠。
 *
 * 半径默认 64：实测危险枚举 maxDistance=128 要 1000ms（同步阻塞会掉心跳），
 * 64 只要 183ms。而且**地图半径和危险枚举半径必须一致**，否则外圈会显示"安全"
 * 而其实没查过——那是静默失效。
 */
export function surveyArea(bot, radius = 24, opts = {}) {
    /**
     * Scan the terrain around you and report what it looks like: heights, water,
     * lava, buildings, and a small ASCII map. Read-only, changes nothing.
     * The map is downsampled (each character covers several blocks - see blockSize),
     * so use it for direction, not for exact coordinates.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} radius, how far to scan in blocks. Defaults to 24 (hard cap 32).
     *   ★ 第13条：原来默认 64 —— 一次 scanSphere 约 110 万次 blockAt + 12868 次 DELETE，
     *   直接把主线程按住好几秒。默认降到 24，scanSphere 入口再硬夹到 ≤32 兜底。
     * @returns {Object} { ok, radius, cell, summary, stats, ascii, legend, blockSize, covers }
     * @example
     * const s = skills.surveyArea(bot, 24);
     * log(bot, s.summary + '
' + s.ascii);
     **/
    // ★ 2026-10-27：改用 terrain3d（真 3D 面数据）+ terrain_view（渲染）。
    //
    // 差别：
    //   旧 heatmap = 实时扫方块（半径 128 约 1 秒），数据新但慢、且只在身边
    //   现在       = 先按需扫一次球（27ms/区块），再从库渲染，能看见多层空间
    const p = bot.entity.position;
    const mapDir = mapDirOf(bot);

    // 扫一次球，保证数据新鲜（用户定的"走到哪扫到哪"）
    let scanInfo = null;
    try {
        scanInfo = scanSphere(bot, mapDir,
            { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, Math.max(16, radius));
    } catch (e) {
        console.log('[surveyArea] 3D 扫描失败:', String(e?.message ?? e).slice(0, 60));
    }

    const view0 = sampleTerrain(mapDir, { x: p.x, y: p.y, z: p.z }, radius, 4);
    const st = summarizeTerrain(view0);
    const summary = `扫描结果（半径 ${radius} 格）：` +
        `可站立面 ${st.ground} 格、未记录 ${st.unknown} 格；` +
        `水 ${st.water}、岩浆 ${st.lava}、树 ${st.tree}、建筑 ${st.built}` +
        (scanInfo ? `；本次新扫 ${scanInfo.cells} 个面（${scanInfo.ms}ms）` : '') + '。';
    log(bot, `surveyArea @(${Math.floor(p.x)},${Math.floor(p.z)}): ${summary}`);

    // 默认降采样到 9x9：整张图约 110 字符，不会撞上 action_manager 的 500 字符截断。
    const view = renderTerrain(view0, { start: p },
        { maxWidth: opts.maxWidth ?? 9, style: opts.style ?? 'abs' });

    return {
        ok: true, radius, cell: view0.cell,
        summary, hazards: st.lava > 0 ? 1 : 0, stats: st,
        ascii: view.text,
        legend: view.legend,
        style: view.style,
        blockSize: view.blockSize,
        covers: view.covers,
        heightRange: view.heightRange,
        groundStats: view.groundStats,
        position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
        facing: wmFacingOf(bot),
        extent: view.extent,
    };
}


/**
 * 先规划、后行动：算出一条避开危险区的路线，但**不动身**。
 * 返回途经点、动作序列（走/游/垫脚/下落）和风险，让你先看清再决定要不要走。
 */
export function planRoute(bot, x, z, opts = {}) {
    /**
     * Plan a route to (x, z) WITHOUT moving. Returns waypoints and a summary.
     *
     * ★ 2026-10-27：改用 3D 规划（path_3d），不再依赖 heatmap/战棋格。
     *
     * 注意：这个函数只回答"下一段往哪走"，不承诺全程 ——
     * 导航本来就是走 16 格重算一次，给一条 200 格外的假路线反而误导她。
     * @returns {Object} { ok, reason, waypoints, actions, stats, ... }
     * @example
     * const p = skills.planRoute(bot, 100, -200);
     */
    const from = bot.entity.position;
    const mapDir = mapDirOf(bot);
    const dist = Math.hypot(x - from.x, z - from.z);

    if (dist < 3) {
        return {
            ok: true, alreadyThere: true, reason: null,
            waypoints: [], actions: {}, usedFallback: false,
            direction: '原地', startDirection: '原地', why: '',
            hazardHits: 0, stats: { dist: Math.round(dist) },
        };
    }

    // 只规划视距内一段（与 executor 的 LOOK_AHEAD 一致）
    const LOOK = 16;
    const len = Math.max(1, dist);
    const aim = dist <= LOOK ? { x, z } : {
        x: from.x + (x - from.x) / len * LOOK,
        z: from.z + (z - from.z) / len * LOOK,
    };

    let plan = null;
    try {
        plan = plan3D(mapDir, { x: from.x, y: from.y, z: from.z },
            { x: aim.x, y: from.y, z: aim.z }, { maxNodes: 40000, margin: 20 });
    } catch (e) {
        return {
            ok: false, reason: `规划失败：${e.message}`,
            waypoints: [], actions: {}, usedFallback: false,
            direction: compassOf(from, { x, z }), startDirection: null, why: '',
            hazardHits: 0, stats: { dist: Math.round(dist) },
        };
    }

    if (!plan || !plan.ok) {
        return {
            ok: false,
            reason: plan?.code === 'NO_DATA' ? '这一带还没有 3D 数据（先用 !survey 扫一下）'
                : plan?.code === 'NO_START' ? '脚下没有可站立面记录'
                    : '这一段走不通',
            waypoints: [], actions: {}, usedFallback: false,
            direction: compassOf(from, { x, z }), startDirection: null, why: '',
            hazardHits: 0, stats: { dist: Math.round(dist), nodes: plan?.nodes ?? 0 },
        };
    }

    const pts = plan.path.slice(0, 20).map(s => ({
        x: s.x, z: s.z, y: s.y, action: s.action === 'walk' ? 'walk' : s.action,
    }));
    const wantDir = compassOf(from, { x, z });
    const startDir = plan.path[1] ? compassOf(from, plan.path[1]) : wantDir;
    const facing = wmFacingOf(bot);
    const rel = relativeDirection(from, { x, z }, facing.name);
    const digs = plan.path.filter(p => p.action === 'dig' || p.action === 'digdown').length;

    const why = startDir !== wantDir
        ? `目标在${wantDir}方，但第一步要先往${startDir} —— 直线方向上不好走，规划绕开了。`
        : '';

    return {
        ok: true, reason: null,
        origin: { x: Math.floor(from.x), z: Math.floor(from.z), y: Math.floor(from.y) },
        targetY: plan.path[plan.path.length - 1]?.y ?? null,
        facing,
        relativeDirection: rel ? rel.dir : null,
        waypoints: pts,
        actions: { walk: pts.length - digs, ...(digs ? { dig: digs } : {}) },
        usedFallback: false,
        direction: wantDir, startDirection: startDir, why,
        heights: null, heightNote: '', tooSteep: false,
        hazardHits: 0,
        stats: { dist: Math.round(dist), nodes: plan.nodes, remain: Math.round(plan.path[plan.path.length - 1] ? Math.hypot(plan.path[plan.path.length - 1].x - from.x, plan.path[plan.path.length - 1].z - from.z) : 0) },
        note: `这是**下一段**（${plan.path.length} 步，约 ${Math.round(Math.hypot((plan.path[plan.path.length - 1]?.x ?? from.x) - from.x, (plan.path[plan.path.length - 1]?.z ?? from.z) - from.z))} 格）。长距离会边走边重算。`,
    };
}


/**
 * 按规划好的路线走过去（先规划后行动）。会和 planRoute 用同一套图。
 * 遇到危险轮廓会绕开；路线不通时如实返回失败，不会硬闯岩浆。
 */
/**
 * 诊断「高度落差」：2D 热力图看不见 Y，所以走到一半失败时，
 * 很可能是"我在高处、目标在低处"，而 pathfinder 的 maxDropDown 默认只有 4。
 * 返回一句人话解释，不需要解释时返回空串。
 */

/**
 * 走某一段之前，用实时世界检查那个路点是不是已经被封了。
 *
 * 为什么需要：goToPositionPlanned 拿的是规划那一刻的地图。中途地形若变了
 * （路被挖断/堵住、有人倒了岩浆），地图还停在旧状态，她会照着旧路点一头撞过去，
 * 走不动之后才在"失败"里发现。这里先看现场，提前判定"此路不通，重规划"。
 *
 * 只看目的地那一列附近（脚下 ±2 格），够用且便宜。
 * @returns {string|null} 被封的原因；没封返回 null
 */
function legBlockedLive(bot, w) {
    try {
        const x = Math.floor(w.x), z = Math.floor(w.z);
        const baseY = Math.floor(bot.entity.position.y);
        for (let dy = -2; dy <= 2; dy++) {
            const b = bot.blockAt(new Vec3(x, baseY + dy, z));
            if (!b) continue;                       // 未加载：不下结论
            const n = b.name || '';
            if (n === 'lava' || n === 'fire' || n === 'soul_fire') {
                return `路点 (${x},${z}) 现在是 ${n}`;
            }
        }
        // 「身体那层有实心方块」**不等于**封路 —— 一格台阶她抬腿就上去了。
        // 原来这里一刀切判"被封"，实测把普通草地/台阶都算成堵死，
        // 日志里出现"前方被封：路点被 grass_block 堵住了"，然后整条路被放弃。
        // 真正过不去的情况是：往上连续 2 格以上都是实心的（跳/垫都上不去）。
        const solidAt = (dy) => {
            const b = bot.blockAt(new Vec3(x, baseY + dy, z));
            if (!b) return null;                      // 未加载：不下结论
            if (/door|gate|slab|stairs|carpet|fence/.test(b.name || '')) return false;
            return b.boundingBox === 'block';
        };
        const s0 = solidAt(0), s1 = solidAt(1), s2 = solidAt(2);
        if (s0 === null || s1 === null || s2 === null) return null;
        // 只有「脚下、身上、头顶」全都实心，或者连上两层实心，才算真堵
        if (s0 && s1 && s2) {
            return `路点 (${x},${z}) 是被实心方块堆死的（连续 3 格实心）`;
        }
        return null;
    } catch (err) {
        return null;                                // 检查失败当没封，别误判
    }
}



export async function climbLadder(bot, opts = {}) {
    /**
     * Climb up or down a ladder / vine.
     *
     * Use this when the only way between two levels is a vertical ladder or a
     * vine column - walking cannot solve it, and digging is slow.
     * You must already be standing on the climbable block.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} opts, { direction: 'up'|'down', steps: number, allowVine: boolean }
     *   direction defaults to 'up'; steps defaults to 1 for up and 32 for down;
     *   allowVine defaults to true - set false to ignore naturally generated vines,
     *   which can lift you while merely walking past.
     * @returns {Promise<Object>} { ok, fromY, toY, climbed|dropped }
     * @example
     * await skills.climbLadder(bot, { direction: 'up', steps: 3 });
     **/
    const { direction = 'up', steps = null, allowVine = true } = opts;
    if (direction === 'down') {
        const n = steps ?? 32;
        return await climbDown(bot, { maxSteps: n, allowVine });
    }
    const n = steps ?? 1;
    return await climbUp(bot, { steps: n, allowVine });
}

export function canClimbHere(bot, opts = {}) {
    /**
     * Check whether you are standing on a ladder or vine right now, and how far
     * you could climb. Read-only, changes nothing.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Object} opts, { allowVine: boolean } defaults to true.
     * @returns {{ onClimbable: boolean, up: number, down: number, blockName: string|null }}
     * @example
     * const c = skills.canClimbHere(bot);
     * if (c.onClimbable && c.up > 0) log(bot, `can climb up ${c.up} blocks`);
     **/
    const { allowVine = true } = opts;
    const p = bot.entity.position;
    const onClimbable = isClimbable(bot, p, { allowVine });
    if (!onClimbable) return { onClimbable: false, up: 0, down: 0, blockName: null };
    const block = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    return {
        onClimbable: true,
        up: climbableUp(bot, p, { allowVine }),
        down: climbableDown(bot, p, { allowVine }),
        blockName: block?.name ?? null,
    };
}

export async function followEntity(bot, entityName, opts = {}) {
    /**
     * Walk up to and follow a non-player entity, such as a boat or an animal.
     *
     * Why this exists: riding a boat is not supported by this mineflayer build on
     * this Minecraft version, but a boat floats steadily on the water surface.
     * So a boat works as a reusable floating landmark - put one on the far side of
     * a lake and follow it, and you cross the water instead of trying to swim or
     * to dig around it. Unlike following a player, the boat does not wander off,
     * drown, or teleport.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityName, entity name such as 'oak_boat' or 'cow'.
     * @param {Object} opts, { distance: number, timeoutMs: number }
     *   distance is how close to stop, defaults to 3 blocks.
     * @returns {Promise<Object>} { ok, code, distFeetToEntity }
     * @example
     * await skills.followEntity(bot, 'oak_boat', { distance: 2 });
     **/
    const r = await followEntityTask(bot, entityName, {
        distance: opts.distance ?? 3,
        timeoutMs: opts.timeoutMs ?? 120000,
        mapDir: opts.mapDir ?? null,
        onEvent: opts.onEvent ?? (() => { }),
    });
    return r;
}

export async function digTunnel(bot, dx, dz, steps, opts = {}) {
    /**
     * Dig forward one step at a time (a tunnel), moving into each cell you clear.
     *
     * Use this when the way forward is blocked by solid blocks and there is no
     * natural path around: dig through, step in, repeat. Two modes happen
     * automatically: on the surface you usually dig 1 block (your feet level);
     * underground you dig 2 (feet + head) so you can walk through.
     *
     * Safety is built in and will REFUSE rather than flood or fall:
     *   - refuses if the target cell is outside your safe zone
     *   - refuses if the block under the target is not solid (you would fall)
     *   - refuses if any water or lava is next to or above the target
     *     (digging into it would pour liquid onto you)
     * So a refusal is information, not a failure: try a different direction.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} dx, horizontal direction along x (-1, 0 or 1)
     * @param {number} dz, horizontal direction along z (-1, 0 or 1)
     * @param {number} steps, how many cells to tunnel forward
     * @param {Object} opts, { deadlineMs: number }
     * @returns {Promise<Object>} { ok, code, steps, dug }
     * @example
     * await skills.digTunnel(bot, 1, 0, 3);   // dig 3 cells toward +x
     **/
    const { deadlineMs = 60000 } = opts;
    const onEvent = opts.onEvent ?? (() => { });
    const n = Math.max(1, Number(steps) || 1);

    // 原来这里是 tunnelAlong（原子层里的 while 循环）。原子层规范化后：
    //   - 原子只做**一步**（tunnelStep）
    //   - "做 N 步 + 中断 + 时限 + 报第几步失败" 交回复合层的 runSteps
    // 语义等价：每步都重算安全区（她可能已经移动），失败带上第几步。
    const stepsArr = Array.from({ length: n }, () => ({ atom: 'tunnelStep' }));
    const start = {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
    };

    const run = await runSteps(bot, stepsArr, {
        deadlineMs,
        onStep: (e) => { if (e?.type === 'step-failed') onEvent({ type: 'tunnel-step-failed', ...e }); },
        handlers: {
            tunnelStep: async (b) => {
                // 每步重新算安全范围（她可能已经移动了）
                const zone = computeSafeZone(b, { radius: 4, up: 3, down: 3 });
                return tunnelStep(b, { dx, dz }, { zone, onEvent });
            },
        },
    });

    if (!run.ok) return run;

    const to = {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
    };
    onEvent({ type: 'tunnel-done', steps: n, from: start, to });
    return ok({ steps: n, to });
}

export function scanTreeAt(bot, x, y, z) {
    /**
     * Look at one log block and map out the WHOLE tree it belongs to. Read-only.
     *
     * Walks the connected logs (6-directional), then reports the tree's shape,
     * how many leaves it has, and whether it looks like a real tree or a
     * player-built structure. Use this before chopping so you know what you are
     * dealing with - in particular whether the trunk is a tall column, which
     * tells you the logs near the bottom are the ones to reach first.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, @param {number} y, @param {number} z - a log position
     * @returns {Object} { ok, logs, leaves, minY, maxY, spanX, spanZ, isTree, why }
     * @example
     * const t = skills.scanTreeAt(bot, 100, 71, -209);
     * if (t.isTree) log(bot, t.why);
     **/
    const scan = scanTree(bot, { x, y, z });
    if (!scan.ok) return { ok: false, code: scan.code, why: scan.why };
    const judge = judgeTree(scan);
    return {
        ok: true,
        logs: scan.logs.length,
        leaves: scan.leaves,
        minY: scan.minY,
        maxY: scan.maxY,
        spanX: scan.spanX,
        spanZ: scan.spanZ,
        height: scan.maxY - scan.minY + 1,
        isTree: judge.isTree,
        why: judge.why,
    };
}

export function planTreeChop(bot, x, y, z) {
    /**
     * Plan the order to chop a tree, bottom-up. Read-only.
     *
     * Why bottom-up: you can only reach about 4.5 blocks. Chopping the lowest
     * layer first lets you stand on the stump and reach the next layer up - no
     * climbing and no scaffolding needed. Chopping top-down would leave the
     * upper logs unreachable.
     *
     * Also tells you whether the first layer is reachable from where you stand.
     * If it says no, you need to get higher first (see digTunnel / climbLadder).
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, @param {number} y, @param {number} z - a log position
     * @returns {Object} { ok, layers, total, reachableFromGround, order, why }
     * @example
     * const p = skills.planTreeChop(bot, 100, 71, -209);
     * log(bot, p.why);
     **/
    const scan = scanTree(bot, { x, y, z });
    if (!scan.ok) return { ok: false, code: scan.code, why: scan.why };
    const plan = planFelling(scan, { standY: Math.floor(bot.entity.position.y) });
    if (!plan.ok) return { ok: false, code: plan.code, why: plan.why };
    return {
        ok: true,
        layers: plan.layers,
        total: plan.total,
        reachableFromGround: plan.reachableFromGround,
        // 只给每层的 y 和数量，别把整棵树几百个坐标灌给模型
        order: plan.order.map(l => ({ y: l.y, count: l.logs.length })),
        why: plan.why,
    };
}
