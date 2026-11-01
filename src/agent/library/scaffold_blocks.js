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
 * 背包里所有可垫脚方块的 **block id 列表**（给 pathfinder 的 scafoldingBlocks 用）。
 * @param {object} bot mineflayer bot
 * @returns {number[]}
 */
export function scaffoldBlockIds(bot) {
    const ids = [];
    for (const it of bot.inventory?.items?.() ?? []) {
        if (!it || !(it.count > 0) || !isScaffoldBlock(it.name)) continue;
        const id = bot.registry?.blocksByName?.[it.name]?.id;
        if (id != null && !ids.includes(id)) ids.push(id);
    }
    return ids;
}
