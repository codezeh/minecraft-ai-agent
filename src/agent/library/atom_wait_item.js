/**
 * A16 等待：等背包出现变化（只等，不动）。
 *
 * 为什么单独一个原子（用户判断 2026-10-25：「拆的还不够原子」）：
 *   原来 `collectDrops` 把「等掉落物飞过来」和「走过去/往下找站位」混在一个函数里。
 *   后果实测：`collectDrops` 报 `TIMEOUT 2786ms`，但紧接着检查背包却是 +1 ——
 *   东西捡到了，原子却说没捡到。这种自相矛盾**只有在"判定和动作混在一起"时才会出现**。
 *
 * 拆分后：本原子只负责「给定时限内，背包有没有变化」。
 *   它不移动、不找站位、不改世界 —— 所以它的失败可以直接归因为"就是没等到"。
 *
 * 与 `atom_wait.waitUntil` 的区别：
 *   `waitUntil` 是通用的"等某个条件成立"；
 *   本原子专用于"等计数增加"，把常见用法（判据 + 轮询 + 增量报告）固定下来，
 *   避免每个调用方各写一遍（写得不一样就会漏判，这次就是这么踩的）。
 */
import { ok, fail } from './contract.js';
import { waitUntil } from './atom_wait.js';

/**
 * 等背包数量增加。
 *
 * @param {object} bot
 * @param {object} opts
 *   countFn     () => number  计数函数（必需）。抛错会被降级处理，不让原子崩
 *   base        基准值。不传则在调用开始时自己快照（推荐）
 *   timeoutMs   最多等多久，默认 3000
 *   intervalMs  轮询间隔，默认 150
 *   minGain     至少增加多少算成功，默认 1
 *
 * @returns ActionResult
 *   ok  → data: { gained, waitedMs, polls, base, now }
 *   TIMEOUT → data: { gained: 0, waitedMs, polls, base, now }
 *   INTERNAL → countFn 一直抛错（判据本身不可用，比"没等到"更该被上层知道）
 */
export async function waitForItem(bot, opts = {}) {
    const {
        countFn,
        base,
        timeoutMs = 3000,
        intervalMs = 150,
        minGain = 1,
    } = opts;

    if (typeof countFn !== 'function') {
        return fail('INTERNAL', 'waitForItem 需要 countFn', {});
    }
    if (bot.interrupt_code) {
        return fail('INTERRUPTED', '被取消了', {});
    }

    const t0 = Date.now();
    let polls = 0;
    let err = null;

    // 基准：默认在开场快照"本次调用前"的数量。
    // 不传 base 也不让调用方传"任务开始时的数量"——那会让第一次成功之后
    // 后续每次都立即判成功（BUG-002 踩过这个坑）。
    let baseCount;
    if (Number.isFinite(base)) {
        baseCount = base;
    } else {
        try { baseCount = countFn(); } catch (e) { err = e; baseCount = 0; }
    }

    const read = () => {
        polls++;
        try { return countFn(); } catch (e) { err = e; return null; }
    };

    const r = await waitUntil(
        () => {
            const now = read();
            if (now === null) return undefined;              // 读不到 = 继续等
            if (now - baseCount >= minGain) return true;
            return undefined;                                 // 还没到 = 继续等
        },
        { timeoutMs, intervalMs, bot },
    );

    let now = null;
    try { now = countFn(); } catch { now = null; }
    const gained = (now === null || !Number.isFinite(now)) ? 0 : now - baseCount;

    // 只在"完全读不到"时才报 INTERNAL（判据不可用）。
    // 曾经读到过就属于正常超时——不能因为最后一次读失败就否掉前面的观测。
    if (err && polls > 0 && now === null) {
        return fail('INTERNAL', `countFn 读不到数量：${String(err?.message ?? err)}`, {
            gained: 0, waitedMs: Date.now() - t0, polls, base: baseCount,
        });
    }

    if (r.ok === true || gained >= minGain) {
        return ok({
            gained,
            waitedMs: Date.now() - t0,
            polls,
            base: baseCount,
            now,
        });
    }

    return fail('TIMEOUT', `等了 ${Date.now() - t0}ms 数量没变化`, {
        gained,
        waitedMs: Date.now() - t0,
        polls,
        base: baseCount,
        now,
    });
}
