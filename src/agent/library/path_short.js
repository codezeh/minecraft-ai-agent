/**
 * 短规划：把一段路走完。失败就对半切。
 *
 * 依据（实测）：pathfinder 单次调用约 13~15 秒，与距离关系不大。
 * 所以「整段重试」是浪费，应该切半：24 格失败 → 试 12 格 → 再失败试 6 格。
 * 切到 6 格还失败，才认定这一段真的走不通。
 */
import { moveToXZEx } from './atom_move.js';

const MIN_SEG = 6;              // 最短切到 6 格
const MAX_DEPTH = 4;            // 最多切 4 层（24 → 12 → 6）

/**
 * 走一段路，失败就切半。
 * @returns {{ok:boolean, reached:{x,z}, used:Array, splits:number, costMs:number, code?:string}}
 */
export async function walkSegment(bot, from, to, opts = {}) {
    const { timeout = 20000, depth = 0, onEvent = () => { } } = opts;
    const used = [];
    const t0 = Date.now();

    if (bot.interrupt_code) {
        return { ok: false, reached: { x: bot.entity.position.x, z: bot.entity.position.z }, used, splits: 0, costMs: 0, code: 'INTERRUPTED' };
    }

    const dist = Math.hypot(to.x - bot.entity.position.x, to.z - bot.entity.position.z);
    if (dist < 3) {
        return { ok: true, reached: { x: bot.entity.position.x, z: bot.entity.position.z }, used, splits: 0, costMs: 0 };
    }

    const r = await moveToXZEx(bot, { kind: 'point', posXZ: { x: to.x, z: to.z } }, { tol: 2, timeout });
    used.push({ to: { x: to.x, z: to.z }, code: r.code, ms: Date.now() - t0, partial: r.data?.partial === true });
    onEvent({ type: 'segment', to: { x: to.x, z: to.z }, code: r.code, dist: Math.round(dist), partial: r.data?.partial === true });

    if (r.ok && !r.data?.partial) {
        return { ok: true, reached: { x: to.x, z: to.z }, used, splits: 0, costMs: Date.now() - t0 };
    }
    // partial：已经朝目标推进了一段。不当作失败，而是「推进后继续」——
    // 这是 Baritone 的 partial path 思路：搜索受限时先走能走的那段，再重规划。
    if (r.ok && r.data?.partial) {
        const p = { x: bot.entity.position.x, z: bot.entity.position.z };
        const remain = Math.hypot(to.x - p.x, to.z - p.z);
        onEvent({ type: 'partial', advanced: Math.round(r.data.advanced || 0), remain: Math.round(remain) });
        if (remain < 4) {
            return { ok: true, reached: p, used, splits: 0, costMs: Date.now() - t0, partialEnd: true };
        }
        // 还有距离：递归走完剩下的（深度+1，避免无限推进）
        if (depth + 1 > MAX_DEPTH) {
            return { ok: true, reached: p, used, splits: 0, costMs: Date.now() - t0, partialEnd: true };
        }
        const next = await walkSegment(bot, p, to, { timeout, depth: depth + 1, onEvent });
        used.push(...next.used);
        return { ...next, used, splits: next.splits, costMs: Date.now() - t0 };
    }
    if (r.code === 'INTERRUPTED') {
        return { ok: false, reached: { x: bot.entity.position.x, z: bot.entity.position.z }, used, splits: 0, costMs: Date.now() - t0, code: 'INTERRUPTED' };
    }

    // 切半：走到中间点，再走剩下的一半
    if (depth >= MAX_DEPTH || dist < MIN_SEG * 2) {
        return {
            ok: false,
            reached: { x: bot.entity.position.x, z: bot.entity.position.z },
            used, splits: depth, costMs: Date.now() - t0, code: r.code,
        };
    }

    const mid = {
        x: (bot.entity.position.x + to.x) / 2,
        z: (bot.entity.position.z + to.z) / 2,
    };
    onEvent({ type: 'split', from: { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }, mid: { x: Math.round(mid.x), z: Math.round(mid.z) }, to });

    const a = await walkSegment(bot, from, mid, { timeout, depth: depth + 1, onEvent });
    used.push(...a.used);
    if (!a.ok) return { ...a, used, splits: a.splits + 1, costMs: Date.now() - t0 };

    const b = await walkSegment(bot, mid, to, { timeout, depth: depth + 1, onEvent });
    used.push(...b.used);
    return {
        ok: b.ok,
        reached: b.reached,
        used,
        splits: a.splits + b.splits + 1,
        costMs: Date.now() - t0,
        code: b.code,
    };
}
