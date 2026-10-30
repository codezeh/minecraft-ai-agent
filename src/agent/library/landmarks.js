import * as store from './memory_store.js';

/**
 * 地标持久化：把箱子、工地这类"精确坐标"写进文件，而不是放进模型记忆。
 *
 * 为什么不用 memory.json：
 * memory.json 的内容由模型自己的总结器反复改写，坐标这种精确数据放在里面迟早会漂移丢失
 * （之前已经出现过调试用的计分板命令被写进长期记忆的情况）。
 *
 * 存储位置（按领域拆成独立文件，一个技能一份，互不干扰）：
 *   bots/<agent>/memory/chests.json    箱子 + 分类 + 装了什么
 *   bots/<agent>/memory/sites.json     工地 / 死亡点 / 房子
 *   bots/<agent>/memory/storage.json   仓库区
 *
 * 拆分的好处：新增技能只要 registerNamespace 一个新名字，不用改这里；
 * 某一份文件损坏也不会连累其他数据；每次只重写自己那份，文件不会越滚越大。
 *
 * 旧版把所有东西塞在 bots/<agent>/landmarks.json 里，会自动迁移过来
 * （见 memory_store.migrateFromLegacyLandmarks）。
 */

const MAX_ENTRIES = 24; // 防止单个领域无限膨胀

// 第一次用到时把旧的 landmarks.json 迁移成分域文件（幂等）
const migratedFor = new Set();
function ensureMigrated(bot) {
    const name = bot?.username || 'agent';
    if (migratedFor.has(name)) return;
    migratedFor.add(name);
    try {
        store.migrateFromLegacyLandmarks(bot);
    } catch (err) {
        console.warn('[landmarks] 迁移失败:', err.message);
    }
}

function emptyStore() {
    return { chests: [], sites: [], storage: null };
}

export function loadLandmarks(bot) {
    ensureMigrated(bot);
    const chests = store.readStore(bot, 'chests');
    const sites = store.readStore(bot, 'sites');
    const storage = store.readStore(bot, 'storage');
    return {
        chests: Array.isArray(chests) ? chests : [],
        sites: Array.isArray(sites) ? sites : [],
        storage: storage || null,
    };
}

function saveLandmarks(bot, data) {
    ensureMigrated(bot);
    let ok = true;
    // 三个领域分别写各自的文件
    ok = store.writeStore(bot, 'chests', (data.chests || []).slice(0, MAX_ENTRIES)) && ok;
    ok = store.writeStore(bot, 'sites', (data.sites || []).slice(0, MAX_ENTRIES)) && ok;
    if (data.storage) {
        ok = store.writeStore(bot, 'storage', data.storage) && ok;
    } else {
        ok = store.writeStore(bot, 'storage', null) && ok;
    }
    return ok;
}

function normalizePos(p) {
    if (!p) return null;
    const x = p.x ?? p[0];
    const y = p.y ?? p[1];
    const z = p.z ?? p[2];
    if (x == null || y == null || z == null) return null;
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

/**
 * 记录一个箱子位置。重复位置会更新而不是追加。
 * @param {object} bot
 * @param {object} pos {x,y,z}
 * @param {string} note 备注，例如 'placed_by_bot'
 * @param {object} extra 额外字段，例如 { category: 'ores', contents: {...} }
 */
export function rememberChest(bot, pos, note = '', extra = null) {
    const n = normalizePos(pos);
    if (!n) return false;
    const data = loadLandmarks(bot);
    // 保留旧的 contents/category（除非显式传入新的）
    const old = data.chests.find(c => c.x === n.x && c.y === n.y && c.z === n.z);
    data.chests = data.chests.filter(c =>
        !(c.x === n.x && c.y === n.y && c.z === n.z));
    const entry = { ...n, note, lastUsed: Date.now() };
    if (old?.category) entry.category = old.category;
    if (old?.contents) entry.contents = old.contents;
    if (extra) Object.assign(entry, extra);
    data.chests.unshift(entry);
    return saveLandmarks(bot, data);
}

/**
 * 更新某个箱子记录的「装了什么」和「分类」。
 * 整理完箱子后调用，这样以后查东西不用再一个个开箱子。
 */
export function updateChestContents(bot, pos, contents, category = null) {
    const n = normalizePos(pos);
    if (!n) return false;
    const data = loadLandmarks(bot);
    const hit = data.chests.find(c => c.x === n.x && c.y === n.y && c.z === n.z);
    if (!hit) return false;
    hit.contents = contents || {};
    if (category) hit.category = category;
    hit.lastUsed = Date.now();
    return saveLandmarks(bot, data);
}

/**
 * 按分类找箱子。category 为 null 时返回所有箱子。
 */
export function chestsByCategory(bot, category) {
    const data = loadLandmarks(bot);
    if (!category) return data.chests;
    return data.chests.filter(c => c.category === category);
}

/**
 * 在所有记录的箱子内容里搜索某种物品，返回 { chest, count } 列表。
 * 注意：contents 是上次整理时记录的，可能过期 —— 调用方需要验证。
 */
export function findItemInChests(bot, itemName) {
    const data = loadLandmarks(bot);
    const hits = [];
    for (const c of data.chests) {
        const n = c.contents?.[itemName];
        if (n > 0) hits.push({ chest: { x: c.x, y: c.y, z: c.z }, count: n, category: c.category });
    }
    return hits.sort((a, b) => b.count - a.count);
}

/**
 * 仓库区（固定放箱子的地方）。
 */
export function rememberStorageArea(bot, pos, note = 'main_storage') {
    const n = normalizePos(pos);
    if (!n) return false;
    const data = loadLandmarks(bot);
    data.storage = { ...n, note, createdAt: data.storage?.createdAt || Date.now() };
    return saveLandmarks(bot, data);
}

export function getStorageArea(bot) {
    const data = loadLandmarks(bot);
    return data.storage || null;
}

/**
 * 记录一个工地位置。
 */
export function rememberSite(bot, pos, note = '') {
    const n = normalizePos(pos);
    if (!n) return false;
    const data = loadLandmarks(bot);
    data.sites = data.sites.filter(c =>
        !(c.x === n.x && c.y === n.y && c.z === n.z));
    data.sites.unshift({ ...n, note, lastUsed: Date.now() });
    return saveLandmarks(bot, data);
}

/**
 * 按距离排序返回已知箱子，最近的在前。
 * @param {object} bot
 * @param {object|number[]} near 参考点，通常是工地或 bot 当前位置
 */
export function knownChestsNearest(bot, near) {
    const ref = normalizePos(near) || normalizePos(bot?.entity?.position);
    const data = loadLandmarks(bot);
    if (!ref) return data.chests;
    const dist2 = c => (c.x - ref.x) ** 2 + (c.y - ref.y) ** 2 + (c.z - ref.z) ** 2;
    return [...data.chests].sort((a, b) => dist2(a) - dist2(b));
}

/**
 * 忘掉一个箱子（比如验证时发现方块已经没了）。
 */
export function forgetChest(bot, pos) {
    const n = normalizePos(pos);
    const data = loadLandmarks(bot);
    const before = data.chests.length;
    data.chests = data.chests.filter(c =>
        !(c.x === n.x && c.y === n.y && c.z === n.z));
    if (data.chests.length === before) return false;
    return saveLandmarks(bot, data);
}

/**
 * 标记某个箱子刚被用过（用于"就近优先"排序）。
 */
export function touchChest(bot, pos) {
    const n = normalizePos(pos);
    if (!n) return false;
    const data = loadLandmarks(bot);
    const hit = data.chests.find(c =>
        c.x === n.x && c.y === n.y && c.z === n.z);
    if (!hit) return false;
    hit.lastUsed = Date.now();
    return saveLandmarks(bot, data);
}

export function landmarksFileFor(bot) {
    // 兼容旧调用点：现在数据分在多个文件里，返回所在目录
    return store.storeFileFor(bot, 'chests').replace(/[\\/]chests\.json$/, '');
}
