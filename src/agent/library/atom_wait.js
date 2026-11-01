/**
 * A10 等待：轮询到某个条件成立（或超时）。
 *
 * 为什么单独一个原子（见 原子层缺口清单 缺口 6）：
 *   收敛前有 4 份各自实现的轮询：
 *     atom_dig   的 waitGone       （80ms，不查中断）
 *     atom_place 的 waitForBlock   （80ms，不查中断）
 *     atom_use   的 waitFor        （80ms，查中断）
 *     atom_attack 的主循环         （150ms，查中断）
 *   多份实现的实际代价不是"重复代码"，而是**行为不一致**：
 *     atom_use 那份曾经把 `false` 当成"还没完成"，导致门"关上"永远判超时（实测踩过）。
 *     其余三份没这个 bug 纯属运气——它们恰好没有返回 false 的谓词。
 *
 * 语义约定（关键，写死在这里避免再踩）：
 *   谓词返回 **undefined 或 null**  = 还没完成，继续等
 *   谓词返回**其它任何值**（含 false / 0 / ''） = 完成，立即返回该值
 */
import { ok, fail } from './contract.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const DEFAULT_INTERVAL_MS = 80;

/**
 * 等谓词返回非 undefined/null 的值。
 *
 * @param {function} predicate  () => value | undefined | null
 * @param {object} opts
 *   timeoutMs      超时（毫秒），默认 1500
 *   intervalMs     轮询间隔，默认 80
 *   bot            传了才检查 bot.interrupt_code
 *   interruptible  是否响应中断，默认 !!bot
 * @returns ActionResult
 *   ok   → data: { value, waitedMs }
 *   TIMEOUT → data: { waitedMs }
 *   INTERRUPTED → data: { waitedMs }
 */
export async function waitUntil(predicate, opts = {}) {
    const {
        timeoutMs = 1500,
        intervalMs = DEFAULT_INTERVAL_MS,
        bot = null,
        interruptible = !!bot,
    } = opts;

    if (typeof predicate !== 'function') {
        return fail('INTERNAL', 'waitUntil 需要一个谓词函数');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        return fail('INTERNAL', `waitUntil 的 timeoutMs 非法（${timeoutMs}）`);
    }

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (interruptible && bot?.interrupt_code) {
            return fail('INTERRUPTED', '被取消了', { waitedMs: Date.now() - t0 });
        }

        let value;
        try {
            value = predicate();
        } catch (e) {
            return fail('INTERNAL', `谓词抛错：${String(e?.message ?? e)}`, { waitedMs: Date.now() - t0 });
        }

        // 只有 undefined / null 表示"还没好"，其它一律算完成（含 false）
        if (value !== undefined && value !== null) {
            return ok({ value, waitedMs: Date.now() - t0 });
        }
        await sleep(intervalMs);
    }

    return fail('TIMEOUT', `等了 ${Date.now() - t0}ms 条件没成立`, { waitedMs: Date.now() - t0 });
}

/**
 * 布尔版：只关心"成没成"，把 TIMEOUT 也当 false。
 *
 * 给那些"等不到就继续"的调用方（比如原子的后置校验：挖完没变空气就报 TIMEOUT，
 * 不需要区分"等待超时"和"条件为假"）。
 *
 * @returns {Promise<boolean>}
 */
export async function waitBool(predicate, opts = {}) {
    const r = await waitUntil(predicate, opts);
    return r.ok === true;
}
