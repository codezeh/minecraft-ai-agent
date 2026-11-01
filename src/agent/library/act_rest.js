/**
 * 动作：睡觉与起床（M6 P1，02 §3.4）。
 *
 *   sleepInBed(target)  是床、够得着、夜里或雷雨 → bot.sleep → isSleeping
 *   wake()              在睡 → bot.wake → 不在睡（**没睡也返回 ok**，幂等）
 *
 * 从 `act_use` 的"床"分支拆出来的：那里 `useBlock` 按方块名分派到 门/床/工作站/作物 四类，
 * 塞在一起的结果是错误码只能混用 —— "白天睡不了"（要等到晚上）和"门被红石锁住"
 * （要换个办法）用同一个码，上层没法区分该等还是该换。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { GOAL_LOOK_AT_DEFAULT_REACH as REACH } from '../rules/rules.runtime.js';

/** 床够不够得着（走近是流程的事，这里只判"现在能不能睡"）。 */
function inReach(bot, pos, maxReach) {
    const self = bot?.entity?.position;
    if (!self || !pos) return null;
    return Math.hypot(pos.x - self.x, pos.y - self.y, pos.z - self.z) <= maxReach;
}

/** 现在是不是能睡的时候：夜里，或有雷雨（原版规则）。 */
function isNightOrStorm(bot) {
    try {
        // mineflayer 的 time.isDay 由 bot.time.timeOfDay 推出来；雷雨也能睡
        if (bot.isRaining && bot.thunderState > 0) return true;
        return bot.time?.isDay === false;
    } catch {
        return false;
    }
}

/**
 * 到床上睡一觉。
 *
 * @param {object} target {pos:{x,y,z}} 或 Vec3
 * @returns ActionResult
 *   ok            → data: { pos, block, sleeping }
 *   NO_TARGET      那不是床
 *   OUT_OF_REACH   够不着 —— 与 NO_PATH 的区别：这是"就在那儿但太远"，走近即可
 *   NOT_READY      现在是白天且没雷雨 —— 与 BLOCKED 的区别：BLOCKED 是"有东西挡着/被锁住"
 *                  要换办法；NOT_READY 是"时机不对，等到晚上再来"（02 §4 错误码注释原话）
 */
export async function sleepInBed(bot, target, opts = {}) {
    const { maxReach = REACH } = opts;
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const raw = target?.pos ?? target;
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isFinite(raw.z)) {
        return fail('NO_TARGET', '目标位置无效');
    }
    const v = new Vec3(Math.floor(raw.x), Math.floor(raw.y), Math.floor(raw.z));
    const block = bot.blockAt?.(v, false);
    if (!block) return fail('NO_TARGET', '那格读不到方块（未加载？）');
    if (!/_bed$/.test(block.name)) return fail('NO_TARGET', `那不是床（${block.name}）`, { block: block.name });

    if (inReach(bot, { x: v.x + 0.5, y: v.y + 0.5, z: v.z + 0.5 }, maxReach) === false) {
        return fail('OUT_OF_REACH', `床太远了（> ${maxReach} 格）`, { block: block.name });
    }

    if (!isNightOrStorm(bot)) {
        return fail('NOT_READY', '现在是白天，睡不了（等到晚上或有雷雨）', { block: block.name });
    }

    if (bot.isSleeping) return ok({ pos: { x: v.x, y: v.y, z: v.z }, block: block.name, sleeping: true, already: true });

    try {
        await bot.sleep(block);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了');
        // mineflayer 白天/有怪物在旁边会抛具体原因 —— 那是"时机/环境不对"，不是路径问题
        return fail('NOT_READY', msg.slice(0, 120), { error: msg, block: block.name });
    }

    // 后置：读 bot.isSleeping（不信返回值）
    if (!bot.isSleeping) {
        return fail('NOT_READY', '躺下了但状态没变成"在睡"', { block: block.name });
    }
    return ok({ pos: { x: v.x, y: v.y, z: v.z }, block: block.name, sleeping: true });
}

/**
 * 起床。
 *
 * **没在睡的时候返回 ok**（幂等）—— 这不是失败：调用方问"让我醒着"，她本来就醒着，
 * 目的已经达成。用 NOT_READY/BLOCKED 会误导上层去重试。
 *
 * @returns ActionResult ok(data:{sleeping:false, wasSleeping}) / INTERNAL
 */
export async function wake(bot) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    const wasSleeping = !!bot.isSleeping;
    if (!wasSleeping) return ok({ sleeping: false, wasSleeping: false, already: true });
    try {
        bot.wake?.();
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }
    return ok({ sleeping: !!bot.isSleeping, wasSleeping: true });
}
