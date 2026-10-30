/**
 * 「木头」是一个类别，不是一个方块。
 *
 * 用户说「砍点木头」时，橡木、白桦、云杉、丛林、金合欢、深色橡木、红树、樱花
 * 都算木头。她需要：听到类别 → 展开成具体方块 → 看到哪种砍哪种。
 *
 * 同时保留精确指定：「砍橡木」只砍 oak_log，「砍丛林木」只砍 jungle_log。
 */

/** 类别名 → 方块列表（按常见程度排序） */
export const WOOD_TYPES = [
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
    'pale_oak_log',
    'crimson_stem',
    'warped_stem',
];

/** 别名 → 具体方块（中文、英文、常见简称） */
const ALIASES = {
    // 类别
    wood: 'wood', log: 'wood', logs: 'wood', tree: 'wood', timber: 'wood',
    木头: 'wood', 木材: 'wood', 原木: 'wood', 树: 'wood', 砍树: 'wood',
    // 具体树种
    oak: 'oak_log', 橡木: 'oak_log', 橡树: 'oak_log',
    birch: 'birch_log', 白桦: 'birch_log', 桦木: 'birch_log',
    spruce: 'spruce_log', 云杉: 'spruce_log',
    jungle: 'jungle_log', jungle_wood: 'jungle_log', 丛林: 'jungle_log', 丛林木: 'jungle_log',
    acacia: 'acacia_log', 金合欢: 'acacia_log',
    dark_oak: 'dark_oak_log', darkoak: 'dark_oak_log', 深色橡木: 'dark_oak_log',
    mangrove: 'mangrove_log', 红树: 'mangrove_log',
    cherry: 'cherry_log', 樱花: 'cherry_log',
    // 其他常见采集目标
    stone: 'stone', 石头: 'stone', 圆石: 'cobblestone', cobblestone: 'cobblestone',
    dirt: 'dirt', 泥土: 'dirt', sand: 'sand', 沙子: 'sand', gravel: 'gravel', 沙砾: 'gravel',
    coal: 'coal_ore', 煤: 'coal_ore', 煤炭: 'coal_ore',
    iron: 'iron_ore', 铁: 'iron_ore', 铁矿: 'iron_ore',
    copper: 'copper_ore', 铜: 'copper_ore', 铜矿: 'copper_ore',
    gold: 'gold_ore', 金: 'gold_ore', 金矿: 'gold_ore',
    diamond: 'diamond_ore', 钻石: 'diamond_ore', 钻石矿: 'diamond_ore',
    leaves: 'leaves', 树叶: 'leaves',
    wool: 'wool', 羊毛: 'wool',
};

/**
 * 把一个名字解析成「要采集的方块列表」。
 *
 * @param {string} raw 用户/模型给的名称
 * @param {object} registry bot.registry（用于校验和展开）
 * @returns {{kind:'single'|'category', names:string[], echo:string}|null}
 *          无法识别时返回 null
 */
export function resolveCollectTarget(raw, registry) {
    if (!raw) return null;
    const key = String(raw).trim().toLowerCase().replace(/\s+/g, '_');

    // 1) 已经是精确方块 ID
    if (registry?.blocksByName?.[key]) {
        return { kind: 'single', names: [key], echo: key };
    }
    // 2) 别名表
    const mapped = ALIASES[key] ?? ALIASES[String(raw).trim()];
    if (!mapped) return null;

    // 3) 类别：展开成「这个 bot 的注册表里真实存在的所有木头」
    if (mapped === 'wood') {
        const names = WOOD_TYPES.filter(n => registry?.blocksByName?.[n]);
        if (!names.length) return null;
        return { kind: 'category', names, echo: '木头' };
    }
    if (mapped === 'leaves') {
        const names = Object.keys(registry?.blocksByName || {}).filter(n => n.endsWith('_leaves'));
        return names.length ? { kind: 'category', names, echo: '树叶' } : null;
    }
    if (mapped === 'wool') {
        const names = Object.keys(registry?.blocksByName || {}).filter(n => n.endsWith('_wool'));
        return names.length ? { kind: 'category', names, echo: '羊毛' } : null;
    }
    if (registry?.blocksByName?.[mapped]) {
        return { kind: 'single', names: [mapped], echo: mapped };
    }
    return null;
}

/** 给模型看的一句话说明（进命令文档）。 */
export const CATEGORY_HINT = 'type 可以是精确方块名（oak_log），也可以是类别：木头/wood（所有原木）、树叶/leaves、羊毛/wool，或中文名（橡木/丛林木/白桦/云杉/石头/铁矿…）。';
