/**
 * 仓储系统：固定仓库区 + 分类箱子 + 记住箱子里装了什么。
 *
 * 设计要点（为什么这么做）：
 *
 * 1. 分类按「用途」而不是物品名，这样模型不用背 100 个物品归哪类：
 *      ores     矿石与矿物      铁/金/钻石/煤/红石/青金石/绿宝石/铜/石英
 *      building 建材            木板/圆石/石砖/砖块/沙子/玻璃/羊毛
 *      wood     木材            原木/木头/树苗/木棍
 *      food     食物            面包/苹果/熟肉/胡萝卜/农作物
 *      tools    工具与装备      镐/斧/铲/剑/弓/头盔/胸甲等
 *      misc     其他杂物        箱子/工作台/火把/杂项
 *
 * 2. 箱子内容会写进 landmarks.json，所以「东西在哪」不用一个个开箱找。
 *    代价是可能过期 —— 所以查询函数会提示调用方验证。
 *
 * 3. 箱子满了不报错，而是溢出到同类下一个箱子；同类全满才报告。
 *    这样一个分类可以横向扩展多个箱子。
 */

import * as landmarks from './landmarks.js';

// ---------------------------------------------------------------------------
// 分类规则
// ---------------------------------------------------------------------------

const CATEGORY_RULES = [
    {
        name: 'ores',
        label: '矿石',
        // 精确名 + 后缀匹配
        exact: new Set([
            'coal', 'charcoal', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'diamond',
            'emerald', 'lapis_lazuli', 'redstone', 'quartz', 'netherite_ingot', 'netherite_scrap',
            'raw_iron', 'raw_gold', 'raw_copper', 'amethyst_shard', 'flint',
        ]),
        suffix: ['_ore', '_ingot', '_nugget', '_scrap'],
    },
    {
        name: 'wood',
        label: '木材',
        exact: new Set(['stick', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
            'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'bamboo']),
        suffix: ['_log', '_wood', '_sapling'],
    },
    {
        name: 'building',
        label: '建材',
        exact: new Set(['cobblestone', 'stone', 'sand', 'gravel', 'clay', 'bricks',
            'glass', 'glass_pane', 'dirt', 'grass_block', 'snow', 'terracotta']),
        suffix: ['_planks', '_bricks', '_slab', '_stairs', '_wall', '_fence', '_door',
            '_trapdoor', '_terracotta', '_concrete', '_wool', '_carpet', '_glass'],
    },
    {
        name: 'food',
        label: '食物',
        exact: new Set(['bread', 'apple', 'carrot', 'potato', 'baked_potato', 'beetroot',
            'melon_slice', 'cookie', 'cake', 'pumpkin_pie', 'golden_apple',
            'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
            'cooked_cod', 'cooked_salmon', 'beef', 'porkchop', 'chicken', 'mutton',
            'cod', 'salmon', 'egg', 'sugar', 'wheat', 'wheat_seeds', 'hay_block']),
        suffix: [],
    },
    {
        name: 'tools',
        label: '工具装备',
        exact: new Set(['shield', 'bow', 'crossbow', 'arrow', 'fishing_rod',
            'flint_and_steel', 'shears', 'bucket', 'water_bucket', 'lava_bucket',
            'compass', 'clock', 'map', 'spyglass', 'elytra', 'totem_of_undying']),
        suffix: ['_pickaxe', '_axe', '_shovel', '_sword', '_hoe', '_helmet',
            '_chestplate', '_leggings', '_boots'],
    },
];

/**
 * 判断一个物品属于哪个分类。
 * @param {string} itemName 物品名，可带或不带 minecraft: 前缀
 * @returns {string} 分类名
 */
export function categorize(itemName) {
    const n = String(itemName || '').replace('minecraft:', '').toLowerCase();
    if (!n) return 'misc';
    for (const rule of CATEGORY_RULES) {
        if (rule.exact.has(n)) return rule.name;
        if (rule.suffix.some(s => n.endsWith(s))) return rule.name;
    }
    return 'misc';
}

/**
 * 所有分类名，用于建箱子的顺序。
 */
export function allCategories() {
    return [...CATEGORY_RULES.map(r => r.name), 'misc'];
}

export function categoryLabel(name) {
    const rule = CATEGORY_RULES.find(r => r.name === name);
    if (rule) return rule.label;
    return name === 'misc' ? '杂物' : name;
}

// ---------------------------------------------------------------------------
// 箱子容量
// ---------------------------------------------------------------------------

export const CHEST_SLOTS = 27; // 单个箱子 27 格

/**
 * 估算某个箱子的剩余空间（按格子算）。
 * containerItems() 返回的是「非空格子」，所以剩余 = 27 - 非空格子数。
 */
export function freeSlotsIn(container) {
    const used = container.containerItems().length;
    return Math.max(0, CHEST_SLOTS - used);
}

/**
 * 统计某个箱子里某种物品的数量。
 */
export function countInChest(container, itemName) {
    const n = String(itemName).replace('minecraft:', '');
    return container.containerItems()
        .filter(i => i.name === n)
        .reduce((a, i) => a + i.count, 0);
}

/**
 * 把容器内容转成 { 物品名: 数量 } 的摘要，用于写进 landmarks。
 */
export function summarizeContainer(container) {
    const out = {};
    for (const i of container.containerItems()) {
        out[i.name] = (out[i.name] || 0) + i.count;
    }
    return out;
}

export { landmarks };
