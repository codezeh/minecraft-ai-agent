/**
 * 复合层执行器：按步骤序列逐条执行，报出「第几步、哪个原子、什么码」。
 *
 * 为什么需要（见 复合层改造规划 §2）：
 *   现在 composite 失败只能报"采集失败"，要定位得翻日志数事件。
 *   有了这个执行器，失败直接是 `step 7 / digBlock / OUT_OF_REACH`。
 *
 * 设计原则（防止变成第二个 collect）：
 *   1. **只管执行，不做决策**：怎么排步骤是 plan() 的事
 *   2. **降级只看 onFail 表**：表里没写的 code 不做降级，如实报上去
 *   3. **不循环找目标**：上层要重规划就返回 `replan`，由调用方重新 plan
 *
 * 它与原子的关系：原子是"一次尝试"，这里是"一串尝试"，不重复原子的断言/校验。
 */
import { ok, fail } from './atom_contract.js';

/**
 * 执行步骤序列。
 *
 * @param {object} bot
 * @param {Array} steps plan() 产出的步骤
 * @param {object} opts
 *   handlers    { atomName: async (bot, args, step) => ActionResult }
 *               —— 必须显式提供，不做动态 import（避免拼错名字时静默失败）
 *   onStep      每步回调（给上层做时间线）
 *   deadlineMs  总时限
 *   onReplan    action='replan' 时的回调，返回新的 steps（可选）
 *
 * @returns ActionResult
 *   ok  → data: { doneSteps, count, failed: [] }
 *   fail → data: { doneSteps, failedStep, atom, count, failed: [{step,atom,pos,code,message}] }
 */
export async function runSteps(bot, steps, opts = {}) {
    const {
        handlers = {},
        onStep = () => { },
        deadlineMs = 0,
        onReplan = null,
    } = opts;

    if (!Array.isArray(steps)) return fail('INTERNAL', 'steps 必须是数组');
    if (!steps.length) return fail('NO_TARGET', '没有可执行的步骤');

    const t0 = Date.now();
    const failed = [];
    let doneSteps = 0;
    let queue = steps.slice();
    let replans = 0;

    while (queue.length) {
        if (bot.interrupt_code) {
            return fail('INTERRUPTED', `停了（做到第 ${doneSteps} 步）`, { doneSteps, failed });
        }
        if (deadlineMs > 0 && Date.now() - t0 > deadlineMs) {
            return fail('TIMEOUT', `时间到了（做到第 ${doneSteps} 步）`, { doneSteps, failed, costMs: Date.now() - t0 });
        }

        const step = queue.shift();
        const handler = handlers[step.atom];
        if (typeof handler !== 'function') {
            return fail('INTERNAL', `第 ${step.step} 步的原子 ${step.atom} 没有处理器`, {
                doneSteps, failedStep: step.step, atom: step.atom, failed,
            });
        }

        let result;
        try {
            result = await handler(bot, step.args, step);
        } catch (e) {
            result = fail('INTERNAL', `原子抛错：${String(e?.message ?? e)}`);
        }

        onStep({ type: 'step', step: step.step, atom: step.atom, code: result.code, ok: result.ok });

        // ---- 成功：继续 ----
        if (result.ok) {
            // move 的 partial：推进了但没到。交给 onFail 表里的 partial 规则
            if (result.data?.partial) {
                const rule = pickRule(step.onFail, 'PARTIAL');
                if (rule?.action === 'replan' && onReplan) {
                    const next = await onReplan({ step, result, doneSteps });
                    if (Array.isArray(next) && next.length) { queue = next; replans++; continue; }
                }
                // 没有规则就当作"做到了能到的最远处"，继续下一步
            }
            doneSteps++;
            continue;
        }

        // ---- 失败：查 onFail 表 ----
        const record = {
            step: step.step,
            atom: step.atom,
            pos: step.args?.target?.pos ?? step.args?.pos ?? null,
            code: result.code,
            message: result.message,
        };
        failed.push(record);
        onStep({ type: 'step-failed', ...record });

        const rule = pickRule(step.onFail, result.code) ?? pickRule(step.onFail, '*');
        const action = rule?.action ?? 'next';   // 表里没写 = 不做降级，继续下一条

        if (action === 'abort') {
            return fail(result.code, `第 ${step.step} 步（${step.atom}）失败：${result.message}`, {
                doneSteps, failedStep: step.step, atom: step.atom, failed, costMs: Date.now() - t0,
            });
        }
        if (action === 'replan') {
            if (typeof onReplan !== 'function') {
                return fail(result.code, `第 ${step.step} 步要重规划但没有提供 onReplan`, {
                    doneSteps, failedStep: step.step, atom: step.atom, failed,
                });
            }
            if (replans >= 3) {
                return fail('BLOCKED', `第 ${step.step} 步连续重规划 ${replans} 次仍失败`, {
                    doneSteps, failedStep: step.step, atom: step.atom, failed,
                });
            }
            const next = await onReplan({ step, result, doneSteps, failed });
            replans++;
            if (Array.isArray(next) && next.length) { queue = next; continue; }
            return fail(result.code, `第 ${step.step} 步（${step.atom}）失败且无法重规划`, {
                doneSteps, failedStep: step.step, atom: step.atom, failed,
            });
        }
        if (action === 'skipGroup') {
            // 跳过「同一组」的剩余步骤。
            // 场景（实测）：一棵树要挖 3 格，结果 moveTo 没走到（NO_PATH 停在 15 格外），
            // 后面三个 digBlock 就全是 "现在悬空/够不着" 的连锁失败——
            // 白跑 3 次、每次 1.5 秒，还污染失败统计。
            const g = step.group;
            if (g != null) {
                const before = queue.length;
                queue = queue.filter(s => s.group !== g);
                onStep({ type: 'group-skipped', group: g, skipped: before - queue.length });
            }
            continue;
        }
        if (action === 'skip' || action === 'restep' || action === 'retry' || action === 'next') {
            // restep/retry 由 plan 生成的序列自己表达（重排后续步骤）；
            // 执行器不做"重试同一个原子"——那是原子的调用方（plan）该决定的事。
            continue;
        }

        continue;
    }

    return ok({
        doneSteps,
        count: doneSteps,
        failed,
        costMs: Date.now() - t0,
    });
}

/** 从 onFail 表里挑匹配 code 的规则；`*` 是兜底 */
function pickRule(onFail, code) {
    if (!Array.isArray(onFail) || !onFail.length) return null;
    return onFail.find(r => String(r.code).toUpperCase() === String(code).toUpperCase())
        ?? onFail.find(r => r.code === '*')
        ?? null;
}
