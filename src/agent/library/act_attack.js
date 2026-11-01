/**
 * A8 攻击：attackEntity。
 *
 * 单一副作用：让目标受到伤害（或明确报告打不到）。
 * 不负责"找敌人"（复合层的 defendSelf 负责）——原子只处理"已经指定的这个实体"。
 *
 * M6（2026-11-02）补了 `attackOnce`：**一次**挥击的契约版。
 * 原 `attackEntity` 是"打到死"的循环（那是 flow_fight 的职责），
 * 而 02 §3 要的 `attackOnce` 是"够得着、冷却好了 → 挥一下 → 目标掉血"。
 *
 * 复用原则（见 自研申报.md 申报 07）：
 *   实际攻击直接走 mineflayer-pvp（已加载）。本文件只补它缺的：
 *   前置断言（实体有效性/距离）、后置校验（目标死了吗）、错误码归一。
 */
import { ok, fail, normalizeTarget } from './contract.js';
// ★ 2026-11-01（A.4）：挥击是鼠标输入，只许从 atom_input_mouse 出手。本文件不再裸调 bot.attack。
import { attackOnce as swingOnce, lookAtPoint } from './atom_input_mouse.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 近战可及距离。R2 层面这是客户端判定，服务端在 3 格左右（击退前）。 */
const MELEE_REACH = 3.0;

/**
 * 不该被当成攻击目标的实体类别。
 *
 * 实测（2026-10-24）：mineflayer 的 `entity.type` 用的是 minecraft-data 的
 * category，僵尸是 **'hostile'** 而不是 'mob'，牛是 'animal'，玩家是 'player'。
 * 所以不能写 `type === 'mob'` 判断活体（那样连僵尸都会被排除）。
 */
const NOT_ATTACKABLE_TYPES = new Set([
    'player', 'armor_stand', 'item', 'experience_orb', 'arrow', 'snowball',
    'boat', 'minecart', 'tnt', 'falling_block', 'end_crystal', 'fireball',
    'area_effect_cloud', 'item_frame', 'painting', 'leash_knot',
]);

/** 活体类别（能掉血、能被打死的） */
const LIVING_TYPES = new Set(['hostile', 'animal', 'passive', 'mob', 'water_creature', 'ambient']);

export function isAttackable(entity) {
    if (!entity || entity.isValid === false) return false;
    const t = entity.type;
    if (!t) return false;
    if (NOT_ATTACKABLE_TYPES.has(t)) return false;
    // 活体：类别命中，或者带 health 字段（部分插件实体没有 category）
    if (LIVING_TYPES.has(t)) return true;
    return entity.health != null;
}

/**
 * 攻击指定实体。
 *
 * @param {object} bot
 * @param {object} entity 目标实体（不是 id，避免"查 id 时目标已经换了"）
 * @param {object} opts { timeout=8000, maxReach=3.0 }
 * @returns ActionResult，data: { target, killed, hpLeft?, costMs }
 */
export async function attackEntity(bot, target, opts = {}) {
    const { timeout = 8000, maxReach = MELEE_REACH } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    // 目标归一化（原子接口标准 §2）：必须显式 {kind:'entity', entity}
    const _t = normalizeTarget(target);
    if (!_t || _t.kind !== 'entity' || !_t.entity) {
        return fail('NO_TARGET', '目标必须是 {kind:"entity", entity}');
    }
    const entity = _t.entity;

    // ---- 前置断言 ----
    if (!entity || entity.isValid === false) {
        return fail('NO_TARGET', '目标已经不在了');
    }
    if (!isAttackable(entity)) {
        return fail('NO_TARGET', `${entity.type} 不是该打的（${entity.name ?? ''}）`, { target: { kind: 'entity', name: entity.type } });
    }
    if (bot.currentWindow) {
        return fail('BLOCKED', '有窗口开着，先关再打');
    }

    const targetName = entity.name ?? entity.type;
    const startDist = bot.entity.position.distanceTo(entity.position);
    if (startDist > maxReach) {
        return fail('OUT_OF_REACH', `目标在 ${startDist.toFixed(1)} 格外（近战 ${maxReach} 格）`,
            { distFeetToEntity: startDist, target: { kind: 'entity', name: targetName } });
    }

    const t0 = Date.now();
    const startHp = entity.health ?? null;
    let usedPvp = false;

    try {
        // 优先用 pvp 插件（会自己贴上去打、会跳劈）
        if (bot.pvp?.attack) {
            usedPvp = true;
            bot.pvp.attack(entity);
        } else {
            // 没有 pvp 插件就裸打：定时 attack + 看向目标
            await bareAttack(bot, entity, timeout);
        }
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e), target: { kind: 'entity', name: targetName } });
    }

    // ---- 后置校验：目标死了/消失了/离太远 ----
    let killed = false;
    let hpLeft = null;
    while (Date.now() - t0 < timeout) {
        if (bot.interrupt_code) {
            try { bot.pvp?.stop?.(); } catch { /* ignore */ }
            return fail('INTERRUPTED', '被取消了');
        }
        if (!entity.isValid) { killed = true; break; }
        if (entity.health != null) {
            hpLeft = entity.health;
            if (entity.health <= 0) { killed = true; break; }
        }
        const d = bot.entity.position.distanceTo(entity.position);
        if (d > 8) break;   // 目标跑了，不算杀
        await sleep(150);
    }

    try { bot.pvp?.stop?.(); } catch { /* ignore */ }

    const costMs = Date.now() - t0;
    if (killed) {
        return ok({ target: { kind: 'entity', name: targetName }, killed: true, hpLeft: hpLeft ?? null, costMs });
    }

    // 没杀死但确实在打（掉血了）→ 也算推进，让上层决定要不要继续
    if (startHp != null && hpLeft != null && hpLeft < startHp) {
        return ok({ target: { kind: 'entity', name: targetName }, killed: false, hpLeft, costMs, note: '造成伤害但没打死' });
    }

    return fail('TIMEOUT', `${targetName} 打了 ${Math.round(costMs / 1000)} 秒没死也没掉血`,
        { target: { kind: 'entity', name: targetName }, costMs, usedPvp });
}

/** 没有 pvp 插件时的裸攻击循环（保底，不常用）。 */
async function bareAttack(bot, entity, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout && entity.isValid && !bot.interrupt_code) {
        const d = bot.entity.position.distanceTo(entity.position);
        if (d > MELEE_REACH) await sleep(120);
        // 扭头 + 挥击都走输入原子（同一个出口，别在这里另开一份）
        const eye = entity.position.offset(0, entity.height ?? 1, 0);
        await lookAtPoint(bot, { x: eye.x, y: eye.y, z: eye.z }, { force: true });
        if (bot.entity.position.distanceTo(entity.position) <= MELEE_REACH) {
            await swingOnce(bot, entity);
        }
        await sleep(600);
    }
}

/** 找最近的攻击目标（复合层用，属于感知辅助，不产生副作用）。 */
export function nearestAttackable(bot, radius = 12) {
    const list = Object.values(bot.entities || {})
        .filter(isAttackable)
        .filter(e => e.position && e.position.distanceTo(bot.entity.position) <= radius)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    return list[0] ?? null;
}

// ───────────────────────────────────────────────────────────────────────────
// attackOnce：一次挥击（02 §3 的契约版）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 攻击冷却（毫秒）。
 *
 * 为什么用常量而不是读游戏状态：mineflayer **没有暴露攻击冷却**（那是客户端内部计时），
 * 所以这里只能自己记"上次挥击时间"。取值 625ms（原版 1.9+ 剑的基础冷却 0.625s）。
 * 不假装能读到真实冷却 —— 记自己的时间戳，遵守同一个间隔。
 */
export const ATTACK_COOLDOWN_MS = 625;

/**
 * 朝目标挥**一次**（不追、不循环、不等它死）。
 *
 * @param {object} bot
 * @param {object} target {kind:'entity', entity} 或直接给实体
 * @returns ActionResult
 *   ok           → data: { target, hpBefore, hpAfter, damaged, costMs }
 *   NO_TARGET     目标无效/已经死了
 *   OUT_OF_REACH  超出近战距离 —— 与 NO_REACH 的区别：NO_REACH 是"走不过去"，
 *                 OUT_OF_REACH 是"就在那儿但够不着"，走近即可
 *   NOT_READY     攻击冷却还没好 —— 与 TIMEOUT 的区别：TIMEOUT 是"等了很久没成"，
 *                 NOT_READY 是"等 0.2 秒就行"
 */
export async function attackOnce(bot, target, opts = {}) {
    const { maxReach = MELEE_REACH } = opts;
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const t = normalizeTarget(target);
    if (!t || t.kind !== 'entity' || !t.entity) {
        return fail('NO_TARGET', '目标必须是 {kind:"entity", entity}');
    }
    const entity = t.entity;
    if (entity.isValid === false) return fail('NO_TARGET', '目标已经没了', { name: entity.name ?? null });

    const self = bot.entity?.position;
    const pos = entity.position;
    if (!self || !pos) return fail('NO_TARGET', '读不到目标坐标');
    const dist = Math.hypot(pos.x - self.x, pos.y - self.y, pos.z - self.z);
    if (dist > maxReach) {
        return fail('OUT_OF_REACH', `目标在 ${dist.toFixed(1)} 格外（近战 ${maxReach} 格）`, {
            dist, maxReach, name: entity.name ?? null,
        });
    }

    // 冷却：只看自己记的时间戳（mineflayer 不暴露真实冷却）
    const last = Number(bot.__lastAttackAt ?? 0);
    const waitMs = ATTACK_COOLDOWN_MS - (Date.now() - last);
    if (waitMs > 0) {
        return fail('NOT_READY', `攻击冷却还差 ${Math.round(waitMs)}ms`, { waitMs });
    }

    const hpBefore = entity.health ?? null;

    // 先看向目标（挥击前要对着它），再用输入原子挥一次
    const head = entity.position.offset(0, entity.height ?? 1, 0);
    await lookAtPoint(bot, { x: head.x, y: head.y, z: head.z }, { force: true });
    const swing = await swingOnce(bot, entity);
    bot.__lastAttackAt = Date.now();
    if (!swing.ok) {
        if (swing.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
        return fail(swing.code === 'NO_TARGET' ? 'NO_TARGET' : 'INTERNAL', swing.message, { error: swing.data?.error });
    }

    // 后置：掉血或死了才算真的打到（服务端偶尔吞包）
    await sleep(120);
    const hpAfter = entity.health ?? null;
    const damaged = (hpBefore != null && hpAfter != null && hpAfter < hpBefore)
        || entity.isValid === false;
    if (!damaged) {
        return fail('BLOCKED', `挥了但目标没掉血（可能是无敌帧/被挡住）`, {
            name: entity.name ?? null, hpBefore, hpAfter, costMs: Date.now() - t0,
        });
    }
    return ok({ target: entity.name ?? null, hpBefore, hpAfter, damaged: true, costMs: Date.now() - t0 });
}
