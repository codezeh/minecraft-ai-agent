import * as store from './memory_store.js';

/**
 * 地标持久化：把箱子、工地这类"精确坐标"写进文件，而不是放进模型记忆。
 *
 * 为什么不用 memory.json：
 * memory.json 的内容由模型自己的总结器反复改写，坐标这种精确数据放在里面迟早会漂移丢失
 * （之前已经出现过调试用的计分板命令被写进长期记忆的情况）。
 *
 * 存储位置（★★ R6 #19 之后**箱子不在文件里了**）：
 *   bots/<agent>/memory/sites.json     工地 / 死亡点 / 房子
 *   bots/<agent>/memory/storage.json   仓库区
 *   memory/chests.json                 ★ **旧账本，不再读、不再写**（只剩升级时的一次性迁移
 *                                      源角色，见本文件"箱子账本"一节与 docs/audit-r6/fixes/ledger.md）
 *   bots/<agent>/landmarks.json        更旧的大文件，memory_store 会一次性迁到上面几份
 *
 * 拆分的好处：新增技能只要 registerNamespace 一个新名字，不用改这里；
 * 某一份文件损坏也不会连累其他数据；每次只重写自己那份，文件不会越滚越大。
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

// ───────────────────────────────────────────────────────────────────────────
// 箱子账本（R6 #19）：**任务板库 shared(kind='chest') 是唯一真相**
//
// 病史（两个账本并存）：
//   B4 把箱子内容搬进了任务板，`flow_store.js` 的文件头还写着「不再有第二个真相」；
//   但**本文件**的 rememberChest / updateChestContents / findItemInChests 仍在读写
//   `bots/<name>/memory/chests.json`，而 skills.js 的 !putInChest / !viewChest /
//   verifyChest / storeItem / findItemInStorage / tidyInventory 全走这一路。
//   于是 A 用 !putInChest 存的 64 个原木，B 用共享账本（board:shared-find-item /
//   findItemInSharedChests）**看不到** —— 各记各的，谁也不知道对方记了什么。
//
// 现在只有一份真相（三条规矩，缺一条就会重新长出第二个账本）：
//   ① **写**：本文件把箱子行写进板库 `shared(kind='chest')` —— 这是唯一的持久化落点。
//      `memory/chests.json` 既不读也不写。
//   ② **读**：从板库读；进程内留一份**缓存快照**（WeakMap，按 bot 隔离）。
//      缓存不是账本 —— 丢了可以从板库重建；同步 API 之所以还在，是因为
//      `protectedPlaces()` / `loadLandmarks()` 这些读者本身是同步的（保护点、地图）。
//      异步读者请先 `await refreshChests(bot)`（或 `await loadChests(bot)`）再读。
//   ③ **无板**（mindserver 没连上）：只更新内存缓存、**绝不回落写文件**
//      —— 与 flow_store 同一立场（宁可少一条记忆，也不要再长出第二份文件）。
//      这种情况会被 `chestLedgerErrors(bot)` 记成 `NO_BOARD`，不再静默吞掉。
//
// 需要"落库之后再对外报成功"的命令（!putInChest 这类）用
// `await flushChestWrites(bot)` 等这一批写入结束 —— 这样 A 存完，B 立刻查得到。
// ───────────────────────────────────────────────────────────────────────────

const CHEST_LEDGER = new WeakMap();   // bot -> 账本缓存（**缓存，不是真相**）
let NO_BOARD_WARNED = false;

/** 删箱子的"实测半径"：超出这个距离的 `blockAt` 返回 null 只说明区块没加载，不说明箱子没了。 */
const FORGET_RADIUS = 64;

function boardOf(bot) {
    return bot?.agent?.board ?? bot?.board ?? null;
}

function stateOf(bot) {
    let st = CHEST_LEDGER.get(bot);
    if (!st) {
        st = {
            rows: new Map(),      // key "x,y,z" -> entry（**视图**：板库 ∪ 本地未落库的改动）
            boardRows: new Map(), // key "x,y,z" -> entry（**纯板库快照**；写之前拿它当合并基底）
            hydrated: false,      // 是否已经从板库读过一次
            at: 0,                // 上次读取的时间
            kicking: false,       // 是否已有一次后台刷新在飞
            dirty: new Set(),     // 本地已改、还没落库的 key（刷新时不许被抹掉）
            errors: [],           // 最近的读写失败（诊断用，不静默）
            queue: Promise.resolve(),   // 写入串行队列
        };
        CHEST_LEDGER.set(bot, st);
    }
    return st;
}

function keyOfPos(n) {
    return `${n.x},${n.y},${n.z}`;
}

function parseKey(key) {
    const p = String(key ?? '').split(',').map(Number);
    if (p.length !== 3 || p.some((v) => !Number.isFinite(v))) return null;
    return { x: p[0], y: p[1], z: p[2] };
}

function noteNoBoard(bot) {
    const st = stateOf(bot);
    pushError(st, { code: 'NO_BOARD', key: '', message: '没有任务板：箱子账本只在内存里，不同步别处' });
    if (!NO_BOARD_WARNED) {
        NO_BOARD_WARNED = true;
        console.warn('[landmarks] 没有任务板：箱子账本只留在内存（不再写 memory/chests.json）');
    }
}

function pushError(st, e) {
    st.errors.push({ at: Date.now(), ...e });
    if (st.errors.length > 20) st.errors.splice(0, st.errors.length - 20);
    if (e.code !== 'NO_BOARD') {
        console.warn(`[landmarks] 箱子账本失败 ${e.key || ''} ${e.code} ${e.message ?? ''}`);
    }
}

/** 板库一行 → 账本条目（`{pos,items,category,note}` 与 flow_store 的合并形状都认）。 */
function entryFromRow(row) {
    if (!row || (row.kind != null && row.kind !== 'chest')) return null;
    const v = row.value ?? {};
    if (v.removed) return null;                       // 墓碑：实测已消失的箱子
    const pos = v.pos ?? parseKey(row.key);
    if (!pos) return null;
    const nx = Number(pos.x), ny = Number(pos.y), nz = Number(pos.z);
    if (![nx, ny, nz].every((n) => Number.isFinite(n))) return null;
    const items = v.items ?? v.contents ?? {};
    return {
        key: String(row.key),
        x: Math.floor(nx), y: Math.floor(ny), z: Math.floor(nz),
        note: v.note ?? '',
        category: v.category ?? null,
        contents: (items && typeof items === 'object') ? { ...items } : {},
        lastUsed: Number(v.lastUsed ?? v.at ?? row.updatedAt ?? 0) || 0,
        owner: row.owner ?? v.owner ?? null,
        updatedAt: Number(row.updatedAt ?? 0) || 0,
    };
}

/** 缓存快照（近用过的在前；**不是**权威读，权威读是 await loadChests）。 */
function snapshot(bot) {
    const st = stateOf(bot);
    return [...st.rows.values()].sort((a, b) =>
        (b.lastUsed || 0) - (a.lastUsed || 0) || String(a.key).localeCompare(String(b.key)));
}

/**
 * 从板库刷新缓存（**权威读**）。
 *
 * 读失败/没板都不抛：返回手上这份缓存快照，并把失败记进 `chestLedgerErrors`。
 * @returns {Promise<Array>} 箱子条目数组
 */
export async function refreshChests(bot) {
    const st = stateOf(bot);
    const board = boardOf(bot);
    if (!board?.sharedList) { noteNoBoard(bot); return snapshot(bot); }
    try {
        const r = await board.sharedList('chest');
        if (!r?.ok) {
            pushError(st, { code: r?.code ?? 'INTERNAL', key: '', message: r?.message ?? r?.reason });
            return snapshot(bot);
        }
        const incoming = new Map();
        for (const row of (r.data?.items ?? [])) {
            const e = entryFromRow(row);
            if (!e) continue;
            // ★ 合并（flow_store 的 `sharedMerge` 只写 pos/items/owner/at）会把
            //   category/note 这类"档案字段"抹掉。板库那份确实没了，但我这边知道过，
            //   就按"档案字段只增不减"补回来 —— 免得一次增量入库把分类箱子变成 unsorted。
            const local = st.rows.get(e.key);
            if (local) {
                if (!e.category) e.category = local.category ?? null;
                if (!e.note) e.note = local.note ?? '';
            }
            incoming.set(e.key, e);
        }
        st.boardRows = incoming;                 // 纯板库快照（写路径的合并基底）
        // ★ 本地改了还没落库的条目不许被刷掉（否则"刚记的箱子"会闪一下就没）
        const view = new Map(incoming);
        for (const k of st.dirty) {
            const local = st.rows.get(k);
            if (local) view.set(k, local);
        }
        st.rows = view;
        st.hydrated = true;
        st.at = Date.now();
    } catch (err) {
        pushError(st, { code: 'INTERNAL', key: '', message: `sharedList 抛异常：${String(err?.message ?? err)}` });
    }
    return snapshot(bot);
}

/** 权威读的别名（语义更直白：读箱子账本）。 */
export function loadChests(bot) {
    return refreshChests(bot);
}

/**
 * 同步缓存快照（给同步读者：protectedPlaces / loadLandmarks / map_query）。
 *
 * 没刷过就顺手踢一次后台刷新（不 await），下次调用就有数据了。
 */
export function cachedChests(bot) {
    const st = stateOf(bot);
    if (!st.hydrated && !st.kicking) {
        st.kicking = true;
        refreshChests(bot).catch(() => { /* 已经在 errors 里记过 */ })
            .finally(() => { st.kicking = false; });
    }
    return snapshot(bot);
}

/** 账本诊断：最近 20 条读写失败 + 是否已同步、还有几条没落库。 */
export function chestLedgerErrors(bot) {
    const st = stateOf(bot);
    return {
        errors: st.errors.map((e) => ({ ...e })),
        hydrated: st.hydrated,
        pendingWrites: st.dirty.size,
    };
}

/** 等本 bot 已排队的箱子写入全部结束（命令层用它保证"存完别人就能查到"）。 */
export async function flushChestWrites(bot) {
    const st = stateOf(bot);
    try { await st.queue; } catch { /* 单条失败已记进 errors，不打断调用方 */ }
}

/**
 * 把一次箱子变更**排进串行队列**并写到板库。
 *
 * 为什么排队：同一只 bot 连写两个箱子时，两次 `sharedPut` 若并发，
 * 后一个可能带着更旧的快照先写下去。串行 + 写前刷新，保证每一条都基于最新状态。
 */
function persistChest(bot, key, patch) {
    const st = stateOf(bot);
    st.dirty.add(key);
    const run = async () => {
        const board = boardOf(bot);
        if (!board?.sharedPut) { noteNoBoard(bot); st.dirty.delete(key); return; }
        // ★ 写前先读一次板库：本文件写的是**绝对值**（"箱子现在有什么"），
        //   若拿一份过期快照整份覆盖，就会把别人刚合并进去的增量抹掉。
        //   刷新把这个窗口压到一次往返以内（增量写用 sharedMerge 的地方仍然天然安全）。
        try { await refreshChests(bot); } catch { /* 读不到就用本地快照写 */ }
        // ★ 合并基底必须是**纯板库那份**（st.boardRows），不是本地视图：
        //   视图里可能是我刚按「冷缓存」拼出来的条目（contents 还是 {}），
        //   拿它当基底写绝对值就会把别人记下的内容抹成空 —— ⑦ 号用例守的就是这条。
        const e = st.boardRows.get(key) ?? st.rows.get(key) ?? null;
        const pos = patch.pos ?? (e ? { x: e.x, y: e.y, z: e.z } : null);
        if (!pos) {
            pushError(st, { code: 'NO_TARGET', key, message: '缺少坐标，拒绝写一条没有位置的箱子' });
            st.dirty.delete(key);
            return;
        }
        const value = {
            pos: { x: pos.x, y: pos.y, z: pos.z },
            items: { ...(patch.contents ?? e?.contents ?? {}) },
            category: patch.category ?? e?.category ?? null,
            note: patch.note || e?.note || '',
            lastUsed: patch.lastUsed ?? e?.lastUsed ?? Date.now(),
            ...(patch.removed ? { removed: true } : {}),
        };
        let r;
        try {
            r = await board.sharedPut('chest', key, value);
        } catch (err) {
            // 用已注册的 INTERNAL（错误码审计只认 contract.CODES；细节在 message 里）
            r = { ok: false, code: 'INTERNAL', message: `sharedPut 抛异常：${String(err?.message ?? err)}` };
        }
        if (r?.ok) st.dirty.delete(key);
        else pushError(st, { code: r?.code ?? 'INTERNAL', key, message: r?.message ?? r?.reason });
    };
    st.queue = st.queue.then(run).catch(() => { /* run 自己兜住了；这里只防意外 */ });
    return st.queue;
}

export function loadLandmarks(bot) {
    ensureMigrated(bot);
    const sites = store.readStore(bot, 'sites');
    const storage = store.readStore(bot, 'storage');
    return {
        // ★ R6 #19：`.chests` 是**缓存快照**（不是文件、不是权威）。
        //   要权威答案请 `await loadChests(bot)`。
        chests: cachedChests(bot),
        sites: Array.isArray(sites) ? sites : [],
        storage: storage || null,
    };
}

/**
 * 受保护地点列表（家 / 仓库 / 箱子）。
 *
 * 为什么放在这一层：这是**读盘 + 缓存**，属于数据层的事。
 * 原来它埋在 `atom_classify.isProtected` 里，用一个模块级可变变量
 * `landmarkCache` 缓存 —— 既违反"原子不读写全局状态"（ARCHITECTURE_REDESIGN §6.1），
 * 又会让多个 bot 共用同一份缓存（谁先读谁的数据就是谁的）。
 *
 * 现在：按 bot 分别缓存（WeakMap），原子只接收算好的列表。
 *
 * ★ R6 #19：这个函数是**同步**的（flow_collect_plan 直接调用），所以它读的是
 *   箱子账本的缓存快照。进程刚起、还没人 `await` 过箱子账本时，箱子这条会暂时为空
 *   —— 首次调用会顺手踢一次后台刷新，下一次（≤60s）就补上了。站点/仓库区照旧读文件，
 *   与本条无关。
 *
 * @param {object} bot
 * @param {{ttlMs?:number}} opts
 * @returns {Array<{x:number,y:number,z:number}>}
 */
const PROTECTED_CACHE = new WeakMap();   // bot -> { at, spots }

export function protectedPlaces(bot, opts = {}) {
    const { ttlMs = 60000 } = opts;
    const now = Date.now();
    const hit = PROTECTED_CACHE.get(bot);
    if (hit && now - hit.at < ttlMs) return hit.spots;

    const spots = [];
    try {
        const lm = loadLandmarks(bot);
        // ★ 第8条 J3（恒空）：读端过去写的是 `if (c?.pos) spots.push(c.pos)`，
        //   但写入端（rememberChest / rememberSite / rememberStorageArea）存的是**扁平**
        //   `{x,y,z,note,lastUsed}` —— 没有 `.pos` 这一层。于是 spots 永远是空数组，
        //   这道「别挖到玩家的箱子和家」的闸从写出来那天起没拦过任何东西。
        //   现在两端都用 normalizePos 归一成同一形状（顺带 floor，并丢掉 note/contents 等字段）。
        for (const c of lm.chests || []) { const p = normalizePos(c); if (p) spots.push(p); }
        for (const s of lm.sites || []) { const p = normalizePos(s); if (p) spots.push(p); }
        { const p = normalizePos(lm.storage); if (p) spots.push(p); }
    } catch { /* 没有地标数据就不保护（新存档常见） */ }

    PROTECTED_CACHE.set(bot, { at: now, spots });
    return spots;
}

/** 测试用：清掉某个 bot 的地标缓存（不传就清不了弱引用，只能等 GC） */
export function resetProtectedCache(bot) {
    if (bot) PROTECTED_CACHE.delete(bot);
}


function saveLandmarks(bot, data) {
    ensureMigrated(bot);
    let ok = true;
    // ★ R6 #19：**箱子不在这里写**（它是板库的一行，不是一个文件）。
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
 *
 * ★ R6 #19：写的是**共享账本**（板库），写到别的 bot 也看得见的地方。
 *   返回 true 表示"已记进本地账本缓存"，真正落库由 `flushChestWrites(bot)` 收尾。
 * @param {object} bot
 * @param {object} pos {x,y,z}
 * @param {string} note 备注，例如 'placed_by_bot'
 * @param {object} extra 额外字段，例如 { category: 'ores', contents: {...} }
 */
export function rememberChest(bot, pos, note = '', extra = null) {
    const n = normalizePos(pos);
    if (!n) return false;
    const st = stateOf(bot);
    const key = keyOfPos(n);
    const old = st.rows.get(key) ?? null;
    const entry = {
        key,
        ...n,
        note: note ?? old?.note ?? '',
        // 保留旧的 contents/category（除非显式传入新的）
        category: extra?.category ?? old?.category ?? null,
        contents: { ...(extra?.contents ?? old?.contents ?? {}) },
        lastUsed: Date.now(),
        owner: old?.owner ?? null,
        updatedAt: Date.now(),
    };
    st.rows.set(key, entry);
    // ★ 只有**显式带了** contents 才写 items；`!scanned` / `!placed_by_bot` 这类"只登记位置"
    //   的调用不许把别人记下的内容抹成 {}（不传时 persistChest 会沿用板库那份）。
    const patch = {
        pos: { ...n }, note: entry.note, category: entry.category, lastUsed: entry.lastUsed,
    };
    if (extra?.contents != null) patch.contents = entry.contents;
    persistChest(bot, key, patch);
    return true;
}

/**
 * 更新某个箱子记录的「装了什么」和「分类」。
 * 整理完箱子后调用，这样以后查东西不用再一个个开箱子。
 *
 * ★ R6 #19：内容写进共享账本；**没记过的箱子也会被记上**（开到箱子看到内容，
 *   本身就是一次真实观测 —— 以前这里 `if (!hit) return false` 会把观测丢掉）。
 */
export function updateChestContents(bot, pos, contents, category = null) {
    const n = normalizePos(pos);
    if (!n) return false;
    const st = stateOf(bot);
    const key = keyOfPos(n);
    const old = st.rows.get(key) ?? null;
    const entry = {
        key,
        ...n,
        note: old?.note ?? '',
        category: category ?? old?.category ?? null,
        contents: { ...(contents ?? {}) },
        lastUsed: Date.now(),
        owner: old?.owner ?? null,
        updatedAt: Date.now(),
    };
    st.rows.set(key, entry);
    persistChest(bot, key, {
        pos: { ...n }, note: entry.note, category: entry.category,
        contents: entry.contents, lastUsed: entry.lastUsed,
    });
    return true;
}

/**
 * 按分类找箱子。category 为 null 时返回所有箱子。
 * （同步读缓存快照；要最新请先 `await refreshChests(bot)`。）
 */
export function chestsByCategory(bot, category) {
    const list = cachedChests(bot);
    if (!category) return list;
    return list.filter(c => c.category === category);
}

/**
 * 在所有记录的箱子内容里搜索某种物品，返回 { chest, count } 列表。
 * 注意：contents 是上次整理时记录的，可能过期 —— 调用方需要验证。
 * （同步读缓存快照；要最新请先 `await refreshChests(bot)`。）
 */
export function findItemInChests(bot, itemName) {
    const hits = [];
    for (const c of cachedChests(bot)) {
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
 * （同步读缓存快照；要最新请先 `await refreshChests(bot)`。）
 * @param {object} bot
 * @param {object|number[]} near 参考点，通常是工地或 bot 当前位置
 */
export function knownChestsNearest(bot, near) {
    const ref = normalizePos(near) || normalizePos(bot?.entity?.position);
    const list = cachedChests(bot);
    if (!ref) return list;
    const dist2 = c => (c.x - ref.x) ** 2 + (c.y - ref.y) ** 2 + (c.z - ref.z) ** 2;
    return [...list].sort((a, b) => dist2(a) - dist2(b));
}

/**
 * 忘掉一个箱子（比如验证时发现方块已经没了）。
 *
 * ★ R6 #19 两条新规矩：
 *   ① 抹的是**共享账本**里的那一条（写墓碑 `removed:true`，别的 bot 也不会再把它当库存）。
 *   ② **只在实测半径内**才抹：`bot.blockAt()` 对没加载的区块同样返回 null，
 *      以前这会把"离得远的箱子"当成"没了"删掉记录（各删各的，看不见）。
 *      现在账本是共享的，误删就是**所有人的**记录一起没 —— 所以超出 FORGET_RADIUS
 *      时只报 false，不动账本。
 */
export function forgetChest(bot, pos) {
    const n = normalizePos(pos);
    if (!n) return false;
    const st = stateOf(bot);
    const key = keyOfPos(n);
    const me = bot?.entity?.position;
    const dist = me ? Math.hypot(me.x - n.x, me.z - n.z) : Infinity;
    if (!(dist <= FORGET_RADIUS)) return false;
    st.rows.delete(key);
    persistChest(bot, key, { pos: { ...n }, removed: true });
    return true;
}

/**
 * 标记某个箱子刚被用过（用于"就近优先"排序）。
 *
 * 只动本地缓存的 lastUsed：板库侧的顺序本来就按 updatedAt 排，
 * 不需要为了一次"碰一下"多写一行（少一次往返，也少一次覆盖别人的机会）。
 */
export function touchChest(bot, pos) {
    const n = normalizePos(pos);
    if (!n) return false;
    const st = stateOf(bot);
    const hit = st.rows.get(keyOfPos(n));
    if (!hit) return false;
    hit.lastUsed = Date.now();
    return true;
}

export function landmarksFileFor(bot) {
    // 兼容旧调用点：现在数据分在多个文件里（**箱子已不在文件里**，见上"箱子账本"一节），
    // 所以这里只返回地标文件所在目录 —— 不要再拿它拼 chests.json 的路径。
    return store.storeFileFor(bot, 'sites').replace(/[\\/][^\\/]+$/, '');
}
