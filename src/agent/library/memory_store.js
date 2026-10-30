/**
 * 分域持久化存储：每个「领域」一个独立 JSON 文件。
 *
 * 为什么不是一个大的 landmarks.json：
 *   技能的长期记忆会越来越多（箱子、工地、死亡点、农田、村民交易、矿脉…）。
 *   全塞进一个文件会有三个问题：
 *     1. 每次写都要重写整份，文件越大越慢，也越容易在写入中断时整体损坏
 *     2. 一个技能的数据坏了会连累其他技能
 *     3. 新加技能必须改这个文件的读写逻辑，容易互相踩
 *
 *   所以拆成 bots/<agent>/memory/<namespace>.json，一个领域一个文件：
 *     每次只读写自己那份，互不干扰；新增技能只要注册一个命名空间。
 *
 * 文件布局：
 *   bots/deepseek/memory/chests.json
 *   bots/deepseek/memory/sites.json
 *   bots/deepseek/memory/storage.json
 *   bots/deepseek/memory/<以后的新技能>.json
 *
 * 每份文件都带 schema 版本，方便以后迁移：
 *   { "_v": 1, "_updated": 1792488000000, "data": { ... } }
 */

import fs from 'fs';
import path from 'path';

const SCHEMA_VERSION = 1;

/** 已注册的命名空间 → 默认值。新增技能在这里加一行即可。 */
const REGISTRY = {
    chests: () => [],                 // 箱子：[{ x, y, z, note, category?, contents?, lastUsed }]
    sites: () => [],                  // 地点：[{ x, y, z, note, lastUsed }]  死亡点/工地/房子
    storage: () => null,              // 仓库区：{ x, y, z, note, createdAt } 或 null
    // 危险区域：[{ x, y, z, radius?, reason, hits, lastHit }]
    // hits 记录"在这里出事几次"，用来判断要不要永久避开
    dangers: () => [],
    // 任务进度：{ [taskId]: { title, total, done, updated, note } }
    // 长任务（盖 3784 块、整平 50x50）中断后可以从 done 处接着做
    tasks: () => ({}),
    // 地形危险团块（岩浆/火/仙人掌）：[{ x0,z0,x1,z1,type,count,seenAt,hits }]
    // 和 dangers 的区别：dangers 是"人在某处出过事"的手工标记；
    // hazards 是从世界枚举出来的地形危险轮廓，会被重扫结果修正/失效。
    hazards: () => [],
};

export function knownNamespaces() {
    return Object.keys(REGISTRY);
}

/**
 * 注册一个新的记忆命名空间。
 * 新技能只要调用一次 registerNamespace('farming', () => []),
 * 就能用 readStore/writeStore 存自己的数据，完全不用碰其他文件。
 */
export function registerNamespace(name, defaultFactory) {
    if (!name || typeof defaultFactory !== 'function') {
        throw new Error('registerNamespace(name, defaultFactory) 需要合法的名字和默认值工厂');
    }
    REGISTRY[name] = defaultFactory;
}

function memoryDir(bot) {
    const agentName = bot?.username || 'agent';
    return path.resolve(process.cwd(), 'bots', agentName, 'memory');
}

export function storeFileFor(bot, namespace) {
    return path.join(memoryDir(bot), `${namespace}.json`);
}

/**
 * 读一份领域数据。文件不存在或损坏时返回默认值（不会抛）。
 */
export function readStore(bot, namespace) {
    const fallback = REGISTRY[namespace] ? REGISTRY[namespace]() : null;
    try {
        const p = storeFileFor(bot, namespace);
        if (!fs.existsSync(p)) return fallback;
        const raw = fs.readFileSync(p, 'utf8');
        if (!raw.trim()) return fallback;
        const parsed = JSON.parse(raw);
        // 兼容两种形态：带外壳的 {_v, data} 或直接是裸数据
        if (parsed && typeof parsed === 'object' && 'data' in parsed) {
            return parsed.data ?? fallback;
        }
        return parsed ?? fallback;
    } catch (err) {
        console.warn(`[memory] 读取 ${namespace} 失败，使用默认值:`, err.message);
        return fallback;
    }
}

/**
 * 写一份领域数据。原子写入（临时文件 + rename），避免写一半断电导致整份损坏。
 */
export function writeStore(bot, namespace, data) {
    try {
        const dir = memoryDir(bot);
        fs.mkdirSync(dir, { recursive: true });
        const p = storeFileFor(bot, namespace);
        const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
        const payload = {
            _v: SCHEMA_VERSION,
            _updated: Date.now(),
            data: data ?? (REGISTRY[namespace] ? REGISTRY[namespace]() : null),
        };
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, p); // 同分区 rename 是原子的
        return true;
    } catch (err) {
        console.warn(`[memory] 写入 ${namespace} 失败:`, err.message);
        return false;
    }
}

/**
 * 读取 → 修改 → 写回。回调直接改传进去的对象/数组。
 * @returns {*} 回调的返回值
 */
export function updateStore(bot, namespace, mutator) {
    const current = readStore(bot, namespace);
    const result = mutator(current);
    writeStore(bot, namespace, current);
    return result;
}

/**
 * 从旧的单文件 landmarks.json 迁移到分域文件。
 * 只迁移一次：目标文件已存在就跳过。
 * @returns {{migrated:boolean, from?:string, parts?:string[]}}
 */
export function migrateFromLegacyLandmarks(bot) {
    const legacyPath = path.resolve(process.cwd(), 'bots', bot?.username || 'agent', 'landmarks.json');
    try {
        if (!fs.existsSync(legacyPath)) return { migrated: false };
        const raw = fs.readFileSync(legacyPath, 'utf8');
        if (!raw.trim()) return { migrated: false };
        const legacy = JSON.parse(raw);

        const parts = [];
        // 逐块迁移；目标已存在则跳过，避免覆盖新的分域数据
        const hasContent = ns => {
            const p = storeFileFor(bot, ns);
            return fs.existsSync(p);
        };

        if (Array.isArray(legacy.chests) && legacy.chests.length && !hasContent('chests')) {
            writeStore(bot, 'chests', legacy.chests);
            parts.push(`chests(${legacy.chests.length})`);
        }
        if (Array.isArray(legacy.sites) && legacy.sites.length && !hasContent('sites')) {
            writeStore(bot, 'sites', legacy.sites);
            parts.push(`sites(${legacy.sites.length})`);
        }
        if (legacy.storage && !hasContent('storage')) {
            writeStore(bot, 'storage', legacy.storage);
            parts.push('storage');
        }

        if (parts.length) {
            // 迁移完成后把旧文件改名留档，不直接删（万一还要查）
            const backup = `${legacyPath}.migrated-${Date.now()}`;
            try { fs.renameSync(legacyPath, backup); } catch (e) { /* 留档失败不影响使用 */ }
            console.log(`[memory] 已从 landmarks.json 迁移: ${parts.join(', ')}`);
            return { migrated: true, from: legacyPath, parts, backup };
        }
        return { migrated: false };
    } catch (err) {
        console.warn('[memory] 迁移旧 landmarks.json 失败:', err.message);
        return { migrated: false, error: String(err.message) };
    }
}
