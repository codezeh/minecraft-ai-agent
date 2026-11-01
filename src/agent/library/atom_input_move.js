/**
 * 输入原子：移动键（键盘）—— **全系统唯一允许按移动键的地方**。
 *
 * 规矩见 docs/architecture/01_primitives.md §2（A1/A3/A4/A7）与 §3.1。
 * 为什么收拢：`setControlState` 之前散在 8 个文件里（executor 潜水、atom_climb、
 * atom_pillar、atom_tunnel、skills、modes…各写一份），出事查不到是谁按的、谁该松；
 * 更常见的是**按下去没人松**（残留按键是最难查的一类 bug）。
 *
 * 本文件只做"按一下 / 按住直到 / 松开"，不做任何判断：
 *   - 不重试、不循环动作、不调别的输入原子（A5）
 *   - 不判断"该不该按"（A6，那是动作层的事）
 *   - 按下的键在所有退出路径上松开（A7，`try/finally`）
 *   - 等待中每 ~100ms 查一次 `interrupt_code`，中断返回 `INTERRUPTED`（A3）
 */
import { ok, fail } from './contract.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 不传 timeout 时按住多久（够爬一格/垫一块，但不至于挂着不放）。 */
export const DEFAULT_HOLD_TIMEOUT = 5000;

/**
 * 轮询间隔默认值。
 *
 * A3 要求"每 ~100ms 查一次中断"；需要更细的判据（跳垫那种 25ms 级）
 * 由调用方显式传 intervalMs，别改这个默认。
 */
export const DEFAULT_POLL_MS = 100;

/** 键名规范化：'jump' 和 ['jump','forward'] 都收。 */
function toKeyList(keys) {
    if (keys == null) return [];
    const arr = Array.isArray(keys) ? keys : [keys];
    return arr.filter((k) => typeof k === 'string' && k.length > 0);
}

function setKey(bot, key, on) {
    try { bot.setControlState(key, on); } catch { /* ignore：假 bot / 断线时不许把原子带崩 */ }
}

/**
 * 按住一组键，直到 `until()` 为真或到时；退出时**一定**松开。
 *
 * `until` 的语义：返回真值（`true` / 非空对象…）= 完成；返回 `false` /
 * `undefined` / `null` = 继续等。注意跟 `atom_wait.waitUntil` 不同 ——
 * 那边"只要不是 undefined/null 就算完成"（因为要留住返回值），
 * 这里只关心"成没成"，所以用真值判断，`false` 不会被误当完成。
 *
 * @param {object} bot
 * @param {string|string[]} keys 一个键或一组键（如 swimStep 要同时按前+跳）
 * @param {object} opts
 *   until      判据函数；不给就是"按满 timeout"
 *   timeout    毫秒，默认 DEFAULT_HOLD_TIMEOUT
 *   intervalMs 中断/判据轮询间隔，默认 DEFAULT_POLL_MS
 * @returns ActionResult
 *   ok   → data: { keys, heldMs, reason: 'until'|'timeout' }
 *   TIMEOUT → data: { keys, heldMs }
 *   INTERRUPTED → data: { keys, heldMs }
 *   INTERNAL → 判据抛错（data.error）
 */
export async function holdKey(bot, keys, opts = {}) {
    const {
        until = null,
        timeout = DEFAULT_HOLD_TIMEOUT,
        intervalMs = DEFAULT_POLL_MS,
    } = opts;

    const list = toKeyList(keys);
    if (list.length === 0 && typeof until !== 'function') {
        return fail('INTERNAL', 'holdKey 需要一个键或一个判据');
    }
    if (!Number.isFinite(timeout) || timeout < 0) {
        return fail('INTERNAL', `holdKey 的 timeout 非法（${timeout}）`);
    }
    if (until != null && typeof until !== 'function') {
        return fail('INTERNAL', 'holdKey 的 until 必须是函数');
    }

    // A3：入口先查中断 —— 断了就别再按键（按下去就是"喊停还在动"）
    if (bot?.interrupt_code) {
        return fail('INTERRUPTED', '被取消了', { keys: list, heldMs: 0 });
    }

    const t0 = Date.now();
    let reason = 'timeout';
    let internal = null;

    try {
        for (const k of list) setKey(bot, k, true);

        while (true) {
            if (bot?.interrupt_code) {
                return fail('INTERRUPTED', '被取消了', { keys: list, heldMs: Date.now() - t0 });
            }
            if (until) {
                let done;
                try {
                    done = until();
                } catch (e) {
                    internal = String(e?.message ?? e);
                    break;
                }
                if (done) { reason = 'until'; break; }
            }
            const left = timeout - (Date.now() - t0);
            if (left <= 0) { reason = 'timeout'; break; }
            await sleep(Math.min(intervalMs, Math.max(1, left)));
        }
    } finally {
        // A7：所有退出路径都松键（含判据抛错 / 中断 early-return）
        for (const k of list) setKey(bot, k, false);
    }

    const heldMs = Date.now() - t0;
    if (internal) {
        return fail('INTERNAL', `holdKey 的判据抛错：${internal}`, { keys: list, heldMs, error: internal });
    }
    if (reason === 'until') {
        return ok({ keys: list, heldMs, reason });
    }
    return fail('TIMEOUT', `按住 ${list.join('+')} ${timeout}ms 条件没成立`, { keys: list, heldMs });
}

/**
 * 按一下：按住 ms 毫秒后松开。
 *
 * 到点松开是**正常结束**（不算 TIMEOUT），所以这里把 holdKey 的 TIMEOUT 折回 ok。
 *
 * @returns ActionResult data: { keys, heldMs }
 */
export async function pressKey(bot, key, ms = 200, opts = {}) {
    const r = await holdKey(bot, key, { ...opts, timeout: ms, until: null });
    if (r.ok) return r;
    if (r.code === 'TIMEOUT') return ok({ keys: r.data.keys, heldMs: r.data.heldMs, reason: 'timeout' });
    return r;
}

/** 冲刺键（`setControlState('sprint', on)`）。 */
export async function setSprint(bot, on = true) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    setKey(bot, 'sprint', !!on);
    return ok({ sprint: !!on });
}

/**
 * 潜行键（`setControlState('sneak', on)`）。
 *
 * 注意：**水里下沉不需要 sneak**（重力 + 阻尼就够了，见 executor 潜水那段实测），
 * 这里的 sneak 只用来限制水平漂移速度。
 */
export async function setSneak(bot, on = true) {
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    setKey(bot, 'sneak', !!on);
    return ok({ sneak: !!on });
}

/**
 * 松键 —— 唯一允许任何层随手调用的输入原子（01_primitives.md §2 的唯一例外）。
 *
 * 不给 keys 就是"松开所有键"（= `clearControlStates`，收尾用）；
 * 给了 keys 就只松这几个（如潜水前要把前一个动作留下的 forward 松开）。
 *
 * @param {object} bot
 * @param {string|string[]} [keys]
 * @returns ActionResult data: { keys: 'all'|string[] }
 */
export async function releaseAll(bot, keys = null) {
    const list = toKeyList(keys);
    if (list.length === 0) {
        try { bot?.clearControlStates?.(); } catch { /* ignore */ }
        // 假 bot 的记录表不会因 clearControlStates 之外的原因清空，这里顺手同步，
        // 免得单测断言"松没松"时看到残留（见 tools/fixtures/fake_bot.mjs）。
        if (bot?.__controls instanceof Map) bot.__controls.clear();
        return ok({ keys: 'all' });
    }
    for (const k of list) setKey(bot, k, false);
    return ok({ keys: list });
}
