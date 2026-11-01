/**
 * A9 查询：她 / 玩家 / 实体 / 方块 在哪、什么状态。
 *
 * 为什么叫"查询"而不是"定位"（2026-10-24 用户拍板）：
 *   它要回答的不只是坐标，还有「在不在线、看不看得见、多远、多久前的信息、什么维度」。
 *   "定位"会让人以为只返回一个点，进而又在调用点自己补状态判断——那正是要消灭的重复。
 *
 * 数据来源两级（关键设计）：
 *   RCON（权威）  服务端永远知道所有人的坐标。实测：玩家 tp 到 500,500，bot 在 -8,-4，
 *                 `data get entity <name> Pos` 仍能读到精确位置。
 *   客户端实体（兜底）  bot 是客户端，只在跟踪范围（玩家约 48 格）内才有实体位置；
 *                 超出后服务端发 entity_destroy，`players[name].entity` 变 null
 *                 （mineflayer/lib/plugins/entities.js:288-297）。
 *   所以顺序是：RCON 查得到就用 RCON（带 `source:'rcon'`），查不到退回实体/最后已知位置。
 *
 * 四态语义（混在一起会出错）：
 *   visible   看得见 → 有实时坐标
 *   recalled  看不见但在线 → 用最后已知位置（带 ageMs 告诉上层有多旧）
 *   offline   不在线 → 跟"看不见"是两回事，不该说"我找不到你"
 *   lost      在线但从未见过 → 完全没线索
 */
import { ok, fail } from './contract.js';
import { EYE_HEIGHT } from '../rules/rules.runtime.js';
import { findBlocks, blockAt } from './query_perceive.js';
import { rconPlayerPos, rconOptsFromBot } from './rcon_client.js';

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// 玩家位置追踪（从 flow_follow.js 上提，逻辑未改）
// ---------------------------------------------------------------------------

export class PlayerTracker {
    constructor({ maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
        this.maxAgeMs = maxAgeMs;
        this.seen = new Map();
    }
    remember(name, pos, dim) {
        this.seen.set(name, { x: pos.x, y: pos.y, z: pos.z, dim, at: Date.now() });
    }
    recall(name) {
        const r = this.seen.get(name);
        if (!r) return null;
        if (Date.now() - r.at > this.maxAgeMs) return null;
        return r;
    }
    update(bot) {
        for (const [name, p] of Object.entries(bot.players ?? {})) {
            if (p.entity) this.remember(name, p.entity.position, p.entity.dimension ?? bot.game?.dimension);
        }
    }
}

const trackers = new WeakMap();

export function ensureTracking(bot, opts) {
    let t = trackers.get(bot);
    if (t) return t;
    t = new PlayerTracker(opts);
    trackers.set(bot, t);
    const iv = setInterval(() => {
        try { t.update(bot); } catch { /* bot 可能已断开 */ }
    }, 1000);
    if (iv.unref) iv.unref();
    return t;
}

// ---------------------------------------------------------------------------
// 查询（同步版：只用客户端已知信息）
// ---------------------------------------------------------------------------

/**
 * 查询目标信息（不碰网络，纯客户端）。
 *
 * target：
 *   { kind: 'self' }
 *   { kind: 'player', name }
 *   { kind: 'entity', entity }
 *   { kind: 'block', name, radius? } | { kind: 'block', pos }
 *
 * @returns ActionResult，data 见 queryPlayer / queryBlock 的注释
 */
export function query(bot, target, opts = {}) {
    const { tracker = null, maxAgeMs = DEFAULT_MAX_AGE_MS } = opts;

    const me = bot.entity?.position;
    if (!me || !Number.isFinite(me.x) || !Number.isFinite(me.y) || !Number.isFinite(me.z)) {
        return fail('INTERNAL', '自己的坐标无效（NaN），无法查询');
    }
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const t = target;
    if (!t || typeof t !== 'object' || typeof t.kind !== 'string') {
        return fail('NO_TARGET', '目标必须是 {kind: ...} 描述对象');
    }

    if (t.kind === 'self') {
        return ok({
            kind: 'self',
            name: bot.username ?? '我',
            visibility: 'visible',
            source: 'client',
            pos: floor3(me),
            entityPos: float3(me),
            distFeetToTarget: 0,
            dim: bot.game?.dimension ?? null,
            ageMs: 0,
        });
    }
    if (t.kind === 'player') {
        return queryPlayer(bot, t.name, tracker ?? ensureTracking(bot, { maxAgeMs }), me);
    }
    if (t.kind === 'entity') {
        return queryEntity(bot, t.entity, me);
    }
    if (t.kind === 'block') {
        return queryBlock(bot, t, me);
    }
    return fail('NO_TARGET', `不认识的查询类型 ${t.kind}`);
}

/**
 * 异步版：玩家位置优先问 RCON（权威），失败退回客户端。
 *
 * 为什么单独一个入口而不是把 query 改成 async：
 *   方块/实体/自己这些**不需要网络**，改成 async 会让所有调用点都得 await，
 *   而 await 一个纯内存操作没有任何收益。只有"玩家在哪"这一项值得联网。
 */
export async function queryPlayerExact(bot, target, opts = {}) {
    const { tracker = null, useRcon = true, rconOpts = null, maxAgeMs = DEFAULT_MAX_AGE_MS } = opts;
    if (!target || target.kind !== 'player') return query(bot, target, { tracker, maxAgeMs });

    const me = bot.entity?.position;
    if (!me || !Number.isFinite(me.x)) return fail('INTERNAL', '自己的坐标无效（NaN），无法查询');

    const name = target.name;
    if (!name) return fail('NO_TARGET', '要给玩家名');

    // 诊断日志（2026-10-26）：goToPlayer 反复报「找不到你」但独立探针能查到，
    // 说明失败发生在这一条链的某一步。把每一步的真实结果打出来，别再靠猜。
    const dbg = (step, detail) => {
        if (process.env.QUERY_DEBUG === '0') return;
        console.log(`[query] ${name} ${step}: ${detail}`);
    };

    // 「不在线」先判：RCON 查一个不在线的人会返回 "No entity was found"，那是另一种情况
    const online = bot.players?.[name] !== undefined;
    dbg('online', `${online}（bot.players 里有 ${Object.keys(bot.players ?? {}).length} 个玩家）`);
    if (!online) {
        return fail('NO_TARGET', `${name} 不在线`, { kind: 'player', name, visibility: 'offline', source: 'client' });
    }

    // 1) 先试 RCON —— 任意距离都精确
    if (useRcon) {
        const o = rconOpts ?? rconOptsFromBot(bot);
        dbg('rcon', `尝试 ${o.host}:${o.port}`);
        const pos = await rconPlayerPos(name, o);
        dbg('rcon-result', pos ? `(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)})` : 'null（超时/鉴权/解析失败）');
        if (pos) {
            const tr = tracker ?? ensureTracking(bot, { maxAgeMs });
            tr.remember(name, pos, bot.game?.dimension);
            return ok({
                kind: 'player',
                name,
                visibility: 'visible',
                source: 'rcon',
                pos: floor3(pos),
                entityPos: pos,
                distFeetToTarget: distance3(me, pos),
                distFeetToEntity: distance3(me, pos),
                dim: bot.game?.dimension ?? null,
                ageMs: 0,
            });
        }
    }

    // 2) RCON 不可用 → 退回客户端实体 / 最后已知位置
    const hasEntity = !!bot.players?.[name]?.entity;
    dbg('client', `player.entity ${hasEntity ? '有' : '无（超出跟踪范围）'}`);
    return queryPlayer(bot, name, tracker ?? ensureTracking(bot, { maxAgeMs }), me);
}

// ---------------------------------------------------------------------------

function queryPlayer(bot, name, tracker, me) {
    if (!name) return fail('NO_TARGET', '要给玩家名');

    const player = bot.players?.[name];
    if (!player) {
        return fail('NO_TARGET', `${name} 不在线`, { kind: 'player', name, visibility: 'offline', source: 'client' });
    }

    if (player.entity) {
        tracker?.remember(name, player.entity.position, player.entity.dimension ?? bot.game?.dimension);
        const p = player.entity.position;
        return ok({
            kind: 'player', name, visibility: 'visible', source: 'client',
            pos: floor3(p), entityPos: float3(p),
            distFeetToTarget: distance3(me, p),
            distFeetToEntity: distance3(me, p),
            dim: player.entity.dimension ?? bot.game?.dimension ?? null,
            ageMs: 0,
        });
    }

    const rec = tracker?.recall(name);
    if (rec && rec.dim === (bot.game?.dimension ?? rec.dim)) {
        return ok({
            kind: 'player', name, visibility: 'recalled', source: 'memory',
            pos: floor3(rec), entityPos: float3(rec),
            distFeetToTarget: distance3(me, rec),
            distFeetToEntity: distance3(me, rec),
            dim: rec.dim,
            ageMs: Date.now() - rec.at,
        });
    }

    return fail('NO_TARGET', `看不见 ${name}，也没有他最后出现的位置`, {
        kind: 'player', name, visibility: 'lost', source: 'none',
    });
}

function queryEntity(bot, entity, me) {
    if (!entity) return fail('NO_TARGET', '实体为空');
    if (entity.isValid === false) {
        return fail('NO_TARGET', '那个实体已经不在了', { kind: 'entity', visibility: 'lost' });
    }
    const p = entity.position;
    if (!p) return fail('NO_TARGET', '实体没有坐标');
    return ok({
        kind: 'entity', name: entity.name ?? entity.type ?? 'entity',
        visibility: 'visible', source: 'client',
        pos: floor3(p), entityPos: float3(p),
        distFeetToTarget: distance3(me, p),
        distFeetToEntity: distance3(me, p),
        dim: entity.dimension ?? bot.game?.dimension ?? null,
        ageMs: 0,
    });
}

function queryBlock(bot, t, me) {
    if (t.pos) {
        const v = { x: Math.floor(t.pos.x), y: Math.floor(t.pos.y), z: Math.floor(t.pos.z) };
        const b = blockAt(bot, v);
        if (!b) return fail('NO_TARGET', '那个位置读不到方块', { kind: 'block', pos: v });
        if (b.name === 'air' || b.name === 'cave_air') {
            return fail('NO_TARGET', '那里是空气', { kind: 'block', name: b.name, pos: v, visibility: 'lost' });
        }
        return ok(blockResult(b, v, bot, me));
    }

    if (!t.name) return fail('NO_TARGET', '要给方块名或坐标');
    const found = findBlocks(bot, t.name, t.radius ?? 32, 1);
    if (!found.length) {
        return fail('NO_TARGET', `附近没有 ${t.name}`, { kind: 'block', name: t.name, visibility: 'lost' });
    }
    const b = found[0];
    const v = { x: Math.floor(b.position.x), y: Math.floor(b.position.y), z: Math.floor(b.position.z) };
    return ok(blockResult(b, v, bot, me));
}

function blockResult(b, v, bot, me) {
    return {
        kind: 'block',
        name: b.name,
        visibility: 'known',
        source: 'client',
        pos: v,
        entityPos: null,
        distFeetToTarget: distance3(me, center(v)),
        distEyeToBlock: distance3(eyeOf(bot, me), center(v)),
        dim: bot.game?.dimension ?? null,
        ageMs: 0,
    };
}

// ---------------------------------------------------------------------------

function floor3(p) {
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}
function float3(p) {
    return { x: p.x, y: p.y, z: p.z };
}
function center(v) {
    return { x: v.x + 0.5, y: v.y + 0.5, z: v.z + 0.5 };
}
function eyeOf(bot, me) {
    return { x: me.x, y: me.y + (bot.entity?.eyeHeight ?? EYE_HEIGHT), z: me.z };
}
function distance3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
