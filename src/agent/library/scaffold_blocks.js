/**
 * 可垫脚方块的唯一清单。
 *
 * 为什么单独一个文件：清单原本散在 4 处，且**互不一致**——
 *   nav_pathfinder.js:76    GOOD_SCAFFOLD 正则（含 grass_block/*_planks/*_log）
 *   tool_prep.js:88    SCAFFOLD_RE   正则（同上）
 *   executor.js:63     SCAFFOLD      数组（12 项，缺 grass_block/logs/netherrack）
 *   flow_escape.js:35 SCAFFOLD      数组（13 项，缺 grass_block/logs）
 * 后果很实际：`ensureScaffold` 数了 8 个（按正则），`executor` 却认不出其中
 * 的木板/木头 → 判成"没有可垫脚的方块"直接 NO_ITEM 卡住。
 *
 * 现在以**并集**为准（取四处最宽的那份），改名只改这里。
 * 归入 D8「垫脚块清单三处不一致」的修复。
 */

/** 精确匹配的垫脚方块。 */
export const SCAFFOLD_EXACT = new Set([
    'dirt',
    'grass_block',
    'cobblestone',
    'stone',
    'andesite',
    'diorite',
    'granite',
    'deepslate',
    'sand',
    'gravel',
    'netherrack',
]);

/** 后缀匹配的垫脚方块（任意树种）。 */
const SCAFFOLD_SUFFIX = ['_planks', '_log'];

/**
 * 这个名字能不能拿来垫脚？
 * @param {string} name 方块/物品名
 * @returns {boolean}
 */
export function isScaffoldBlock(name) {
    if (typeof name !== 'string' || !name) return false;
    if (SCAFFOLD_EXACT.has(name)) return true;
    return SCAFFOLD_SUFFIX.some((s) => name.endsWith(s));
}

/**
 * 背包里第一个可垫脚的方块名（没有返回 null）。
 * @param {object} bot mineflayer bot
 * @returns {string|null}
 */
export function findScaffoldItem(bot) {
    for (const it of bot.inventory?.items?.() ?? []) {
        if (!it || !(it.count > 0)) continue;
        if (isScaffoldBlock(it.name)) return it.name;
    }
    return null;
}

/**
 * 背包里可垫脚方块**总数**（按 count 累加，不是种类数）。
 * @param {object} bot mineflayer bot
 * @returns {number}
 */
export function countScaffold(bot) {
    let n = 0;
    for (const it of bot.inventory?.items?.() ?? []) {
        if (it && it.count > 0 && isScaffoldBlock(it.name)) n += it.count;
    }
    return n;
}

/**
 * 背包里可垫脚方块的 id 清单 + 被跳过的名字（诊断用）。
 *
 * ★★ 2026-11-05：这里给的必须是 **item id**，不是 block id。
 *
 * 依据（pathfinder 自己的源码，两处都是 itemsByName）：
 *   node_modules/mineflayer-pathfinder/lib/movements.js:86-88
 *       this.scafoldingBlocks.push(registry.itemsByName.dirt.id)
 *       this.scafoldingBlocks.push(registry.itemsByName.cobblestone.id)
 *   node_modules/mineflayer-pathfinder/lib/movements.js:159   ← 计数判据
 *       if (item.type === id) count += item.count      // item.type 是 item id
 *
 * 喂 block id 的后果不是报错，是**静默数不到**：
 *   `countScaffoldingItems()` 返回 0 → A* 的 `remainingBlocks === 0`
 *   （movements.js:346 / :352 / :404 / :567）→ 所有"放方块走过去"的分支直接 return
 *   → 她明明带着木板，遇到沟坎却绕远路 / NO_PATH，而且**不打任何日志**。
 *
 * `stone` 是当年没被发现的原因：1.21.8 里 stone 的 block id 与 item id 巧合都是 1
 * （andesite/diorite/granite 同样巧合相同），于是"有时候能用"。
 *
 * @param {object} bot mineflayer bot
 * @returns {{ids:number[], skipped:string[]}} skipped = 是垫脚料但**没有对应 item** 的名字
 */
export function scaffoldIdReport(bot) {
    const ids = [];
    const skipped = [];
    for (const it of bot.inventory?.items?.() ?? []) {
        if (!it || !(it.count > 0) || !isScaffoldBlock(it.name)) continue;
        const id = bot.registry?.itemsByName?.[it.name]?.id;
        if (id == null) {
            // 只有方块、没有对应物品（例如某些技术方块）→ 她**永远垫不了**，
            // 跳过并记录。绝不退回 block id：那样只会让 pathfinder 静默数到 0，
            // 把"没有这个物品"伪装成"清单里写了却没生效"。
            if (!skipped.includes(it.name)) skipped.push(it.name);
            continue;
        }
        if (!ids.includes(id)) ids.push(id);
    }
    return { ids, skipped };
}

/**
 * 背包里所有可垫脚方块的 **item id 列表**（直接赋给 pathfinder 的 `scafoldingBlocks`）。
 * @param {object} bot mineflayer bot
 * @returns {number[]}
 */
export function scaffoldItemIds(bot) {
    return scaffoldIdReport(bot).ids;
}

/**
 * 旧名字（保留：别再新增调用方）。
 *
 * ★ 它**现在返回的是 item id** —— 2026-11-05 修的正是"名字叫 block、喂的也是 block id"
 *   这件事（pathfinder 按 item.type 比对，block id 只会静默数到 0）。
 *   新代码用 `scaffoldItemIds`；要诊断"哪些垫脚料被跳过"用 `scaffoldIdReport`。
 * @param {object} bot mineflayer bot
 * @returns {number[]}
 */
export function scaffoldBlockIds(bot) {
    return scaffoldItemIds(bot);
}
