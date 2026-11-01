/**
 * A13 朝向：看向某处（方块 / 实体 / 玩家 / 坐标）。
 *
 * 为什么单独一个原子（见 原子层缺口清单 缺口 4）：
 *   `nav_pathfinder.js` 里有个 lookAt，但只看方块坐标；实体的看向在各处各写一遍
 *   （`task_follow` 里 `bot.lookAt(ent.position.offset(0, head, 0))`、
 *    `atom_attack` 里 `bot.lookAt(entity.position.offset(0, entity.height ?? 1, 0))`）。
 *   陪玩场景里"看着玩家说话"是真实需求，需要统一入口。
 *
 * 设计要点：
 *   - 目标解析复用 atom_query 的 target 形状（{kind:'block'|'entity'|'player'|'point'}）
 *   - 方块看中心、实体看**头部**（不是脚，看脚会显得在盯着地面）
 *   - 后置校验：读 yaw/pitch，确认真的转过去了（bot.lookAt 有时静默失败）
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { EYE_HEIGHT } from '../rules/rules.runtime.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 看向目标。
 *
 * @param {object} bot
 * @param {object} target
 *   { kind: 'point', pos: {x,y,z} }     看向某个世界坐标（方块中心）
 *   { kind: 'block', pos: {x,y,z} }     看向方块中心
 *   { kind: 'entity', entity }           看向实体头部
 *   { kind: 'player', name }             看向玩家头部（需 bot.players 里可见）
 *
 * @param {object} opts { force = true, verifyMs = 600, toleranceRad = 0.35 }
 * @returns ActionResult，data: { yaw, pitch, lookedAt: {x,y,z} }
 */
export async function lookAt(bot, target, opts = {}) {
    const { force = true, verifyMs = 600, toleranceRad = 0.35 } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const resolved = resolvePoint(bot, target);
    if (!resolved.ok) return resolved;
    const { point, label } = resolved.data;

    // 后置校验的基准：转之前的朝向
    const before = { yaw: bot.entity?.yaw ?? 0, pitch: bot.entity?.pitch ?? 0 };

    let err = null;
    try {
        await bot.lookAt(new Vec3(point.x, point.y, point.z), force);
    } catch (e) {
        err = e;
    }
    if (err) {
        return fail('INTERNAL', String(err?.message ?? err), { lookedAt: point });
    }

    // 后置校验：bot.lookAt 在目标不可达/被挡住时会静默不转，必须读 yaw/pitch 确认
    const wantYaw = Math.atan2(-(point.x - bot.entity.position.x), -(point.z - bot.entity.position.z));
    const wantPitch = Math.atan2(
        point.y - (bot.entity.position.y + (bot.entity.eyeHeight ?? EYE_HEIGHT)),
        Math.hypot(point.x - bot.entity.position.x, point.z - bot.entity.position.z),
    );

    const t0 = Date.now();
    while (Date.now() - t0 < verifyMs) {
        const yaw = bot.entity?.yaw ?? 0;
        const pitch = bot.entity?.pitch ?? 0;
        if (angleDiff(yaw, wantYaw) <= toleranceRad && Math.abs(pitch - wantPitch) <= toleranceRad) {
            return ok({ yaw, pitch, lookedAt: point, label });
        }
        await sleep(50);
    }

    // 转不过去：如实报，别假装成功（上层可能据此决定"要不要走近一点"）
    return fail('BLOCKED', `转不过去（目标 ${label}）`, {
        yaw: bot.entity?.yaw, pitch: bot.entity?.pitch,
        wantYaw, wantPitch, lookedAt: point,
        before,
    });
}

// ---------------------------------------------------------------------------

/** 把四种目标解析成一个"要看的世界坐标" */
function resolvePoint(bot, target) {
    if (!target || typeof target !== 'object' || typeof target.kind !== 'string') {
        return fail('NO_TARGET', '目标必须是 {kind: ...} 描述对象');
    }

    if (target.kind === 'point' || target.kind === 'block') {
        const p = target.pos;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
            return fail('NO_TARGET', '坐标无效');
        }
        // 方块看中心：+0.5 才对着方块正面，不然会盯着方块角
        return ok({ point: { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }, label: 'block' });
    }

    if (target.kind === 'entity') {
        const e = target.entity;
        if (!e || e.isValid === false || !e.position) {
            return fail('NO_TARGET', '实体不在或没有坐标');
        }
        // 看头部而不是脚：看脚会像在盯地面
        // rule:R1-04 player 高 1.8（实体的 height 字段缺失时兜底）
        const headY = e.position.y + (e.height ?? 1.8) * 0.85;
        return ok({ point: { x: e.position.x, y: headY, z: e.position.z }, label: e.name ?? 'entity' });
    }

    if (target.kind === 'player') {
        const name = target.name;
        const ent = name ? bot.players?.[name]?.entity : null;
        if (!ent || !ent.position) {
            return fail('NO_TARGET', `看不见 ${name ?? '（未给名字）'} 的实体，没法看过去`, { name });
        }
        // rule:R1-04 player 高 1.8（兜底，理由同上）
        const headY = ent.position.y + (ent.height ?? 1.8) * 0.85;
        return ok({ point: { x: ent.position.x, y: headY, z: ent.position.z }, label: name });
    }

    return fail('NO_TARGET', `不认识的朝向类型 ${target.kind}`);
}

/** 两个角度之间的最小差值（弧度），处理 ±π 环绕 */
function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
}
