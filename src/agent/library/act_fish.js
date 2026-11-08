/**
 * 动作：钓鱼（M6 P1，02 §3.6）。
 *
 *   fishOnce(target?)  手里有鱼竿、面前是水 → bot.fish() → 背包多一样
 *
 * 为什么要单独一个文件：`bot.fish()` 是 mineflayer **替我们写好的多步动作**
 * （抛竿 → 等浮标下沉 → 收竿），它内部有等待。按 01 §1 的定义它归动作层直接用，
 * 而不是拆成"按住右键 + 等 + 松手"的原子组合 —— 拆了反而要自己判断"浮标沉了没有"。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { countItem } from './query_perceive.js';

/**
 * 超时哨兵：`raceWithTimeout()` 超时时返回它（与任何正常返回值都不相等）。
 * 用 Symbol 而不是 `null`/`undefined`，避免和"动作正常返回空"混淆。
 */
const TIMED_OUT = Symbol('timed-out');

/**
 * 超时竞速。
 *
 * ★ R4 §7-⑥（2026-11-07 第四轮审计）修复 —— 与 modes.js 的 unstuck 相同的病灶：
 *   原来是裸的 `Promise.race([work(), new Promise((_r, rej) => setTimeout(...))])`：
 *    ① **计时器从不 clearTimeout**：任务正常结束/提前失败后，那个定时器还挂在事件循环上
 *       （单次钓鱼 30 秒、批量钓鱼同时挂 N 个；测试进程会被它拖住不退出）；
 *    ② 超时只是"上层不再等"，底层 `bot.fish()` **仍在后台跑**，会和下一次动作抢 bot。
 *   这里：到点必清定时器；超时以**返回值**告知（而不是造一个假异常），
 *   调用方负责把底层收掉（见 fishOnce 里超时分支的 deactivateItem）。
 *
 * @returns {Promise<any|typeof TIMED_OUT>}
 */
async function raceWithTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    try {
        // Promise.race 会给两侧都挂 then ⇒ 超时后底层再 reject 也不会变成
        // unhandled rejection（那条链已经有人接了）。
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 钓一次鱼。
 *
 * @returns ActionResult
 *   ok        → data: { caught, item, before, after, costMs }
 *   NO_TOOL   包里没有鱼竿 —— 与 NO_ITEM 的区别：鱼竿是**工具**（不消耗、可复用），
 *             提示上层去"弄鱼竿"，不是"弄材料"
 *   NOT_READY 抛竿了但没咬钩（这段水域没鱼/浮标没沉）—— 与 TIMEOUT 的区别：
 *             那是"等太久了动作没完成"，这是"这次没鱼，换个位置再来"
 *   TIMEOUT   整体超时（bot.fish 卡住）
 *   NO_TARGET 面前没有水面（不需要 target 参数，但水要由调用方保证/或这里粗查）
 */
export async function fishOnce(bot, target = null, opts = {}) {
    const { timeoutMs = 30000 } = opts;
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const rod = (bot.inventory?.items?.() ?? []).find((i) => i?.name === 'fishing_rod' && (i.count ?? 0) > 0);
    if (!rod) return fail('NO_TOOL', '没有鱼竿');

    // 给了目标就检查那格是不是水；没给就跳过（由调用方选好站位）
    if (target) {
        const raw = target?.pos ?? target;
        if (Number.isFinite(raw?.x)) {
            const blk = bot.blockAt?.(new Vec3(Math.floor(raw.x), Math.floor(raw.y), Math.floor(raw.z)), false);
            if (blk && !/water/.test(blk.name)) {
                return fail('NO_TARGET', `目标格不是水（${blk.name}）`, { block: blk.name });
            }
        }
    }

    try {
        if (bot.heldItem?.name !== 'fishing_rod') await bot.equip(rod, 'hand');
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }

    const before = (bot.inventory?.items?.() ?? []).reduce((n, i) => n + (i.count ?? 0), 0);

    let fishResult;
    try {
        // bot.fish() 会自己等浮标下沉然后收竿
        fishResult = await raceWithTimeout(bot.fish(), timeoutMs);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了');
        // mineflayer 在"浮标一直没沉/被拉走"时抛错 —— 那是这次没鱼，不是动作坏了
        return fail('NOT_READY', msg.slice(0, 120), { error: msg, costMs: Date.now() - t0 });
    }
    if (fishResult === TIMED_OUT) {
        // 超时：把底层收掉，别让它在后台继续钓（会与下一次动作抢 bot）
        try { bot.deactivateItem?.(); } catch { /* 没这个接口就算了，不掩盖 TIMEOUT */ }
        return fail('TIMEOUT', `钓了 ${Math.round((Date.now() - t0) / 1000)} 秒还没收竿`, { costMs: Date.now() - t0 });
    }

    const after = (bot.inventory?.items?.() ?? []).reduce((n, i) => n + (i.count ?? 0), 0);
    const caught = after - before;
    if (caught <= 0) {
        // 收竿了但背包没多东西：这次没钓着
        return fail('NOT_READY', '收竿了但没钓到东西（这次没鱼）', { caught: 0, costMs: Date.now() - t0 });
    }
    return ok({ caught, before, after, costMs: Date.now() - t0 });
}

/** 背包里某物数量（保留导出，测试与上层都可能用）。 */
export { countItem };
