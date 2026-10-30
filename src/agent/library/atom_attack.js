/**
 * A8 攻击：attackEntity。
 *
 * 单一副作用：让目标受到伤害（或明确报告打不到）。
 * 不负责"找敌人"（复合层的 defendSelf 负责）——原子只处理"已经指定的这个实体"。
 *
 * 复用原则（见 自研申报.md 申报 07）：
 *   实际攻击直接走 mineflayer-pvp（已加载）。本文件只补它缺的：
 *   前置断言（实体有效性/距离）、后置校验（目标死了吗）、错误码归一。
 */
import { ok, fail, normalizeTarget } from './atom_contract.js';

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
        try {
            await bot.lookAt(entity.position.offset(0, entity.height ?? 1, 0), true);
        } catch { /* ignore */ }
        if (bot.entity.position.distanceTo(entity.position) <= MELEE_REACH) {
            bot.attack(entity, true);
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
