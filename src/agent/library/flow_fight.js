/**
 * 流程：打一个或一群目标（M7 P0，04 §6.1 卡片 `flow_fight`）。
 *
 * 卡片原文：
 *   plan：最近的目标 `reserve entity:…` → 追到 `maxReach` 内 → **等冷却** → `attackOnce`
 *         → 目标死了换下一个
 *   撤退：血量 < `retreatHp` → `flow_escape`，返回 `ok({killed:false, retreated:true})`
 *         —— **撤退是正确行为，不算失败**
 *   onFail：`NO_TARGET` → `skip`；`OUT_OF_REACH` → `restep`（再追）
 *   和反射的区别：`self_defense` / `cowardice` 是被动的、不经任务板；
 *         `flow_fight` 是主动去打。
 *
 * ★ 怎么按 `attackOnce` 的冷却节流（本文件最要紧的一处）
 *   `act_attack.attackOnce` 有 625ms 冷却常量 `ATTACK_COOLDOWN_MS`，冷却没好它返回 `NOT_READY`。
 *   朴素写法会是 `while (alive) { await attackOnce(...) }` —— 冷却没好就空转，
 *   一秒钟几百次无效调用，还刷满日志。这里的做法：
 *     · 从动作里**导出**那个常量（同一个真相，不抄数字）
 *     · 拿到 `NOT_READY` 就 `sleep(waitMs ?? ATTACK_COOLDOWN_MS)` **等够时间再打**，
 *       而不是立刻重试
 *     · 每次挥击本身也要耗时间，所以两击之间自然间隔 ≥ 冷却
 *   另外 `OUT_OF_REACH`（目标被击退）→ 重新 `goTo` 追上，不是失败。
 *
 * 为什么撤退调 `flow_escape` 而流程自己不清场：逃生（挖/垫）是 `flow_escape` 的职责；
 * 这里只负责"发现打不过 → 交出去"。这也是"流程可以调别的流程"的正当用法。
 */
import { ok, fail } from './contract.js';
import { attackOnce, ATTACK_COOLDOWN_MS } from './act_attack.js';
// nearestEntity 在 atom_read（读取原子）里 —— 流程可以 import 原子（02 §5 允许）。
import { nearestEntity } from './atom_read.js';
import { mapDirOf } from './bot_paths.js';
import { goTo } from './nav_core.js';
import { escapeUp } from './flow_escape.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'fight',
    level: 'flow',
    summary: '主动去打一个或一群目标（血少了会自动撤退，撤退不算失败）',
    params: {
        target: 'string',
        maxKills: 'int 1..16 = 1',
        retreatHp: 'int 1..20 = 8',
    },
    needs: { items: ['武器'], near: [] },
    claims: ['entity:target'],
    codes: ['NO_TARGET', 'OUT_OF_REACH', 'NOT_READY', 'BLOCKED', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: false,
    timeoutMs: 3 * 60 * 1000,
};

/** 近战追击距离（比动作层 maxReach 略大：进到 3 格内才打）。 */
const CHASE_DIST = 3.2;

/** 睡着等，但不越过 deadline。 */
async function sleepWithin(ctx, ms) {
    const left = (ctx?.deadline ?? 0) - Date.now();
    if (left <= 0) return false;
    const wait = Math.max(0, Math.min(ms, left));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return true;
}

/** 目标还活着吗。 */
function alive(e) {
    return !!e && e.isValid !== false && (e.health == null || e.health > 0);
}

/** 找最近的可打目标（名字匹配；`target` 支持实体名或类型）。 */
function findTarget(bot, target) {
    try {
        const ent = nearestEntity(bot, (e) => {
            if (!alive(e)) return false;
            const n = String(e.name ?? '');
            const t = String(e.type ?? '');
            return n === target || t === target || n.includes(target);
        }, 32);
        return ent ?? null;
    } catch {
        return null;
    }
}

/** 追到目标 CHASE_DIST 以内。返回是否追到。 */
async function chase(bot, entity, ctx) {
    const p = entity?.position;
    if (!p) return false;
    const walked = await goTo(bot, { kind: 'point', posXZ: { x: p.x, z: p.z } }, {
        mapDir: mapDirOf(bot),
        deadlineMs: Math.max(3000, Math.min((ctx?.deadline ?? Date.now() + 15000) - Date.now(), 15000)),
        arriveTol: CHASE_DIST,
    });
    return walked.ok;
}

/**
 * 打目标。
 *
 * @param {object} opts { maxKills=1, retreatHp=8, ctx }
 * @returns ActionResult
 *   ok        → data: { killed, kills, want, retreated:false }
 *   ok        → data: { killed:false, retreated:true }   ← **撤退是正确行为，用 ok 返回**（卡片原文）
 *   NO_TARGET 附近没有这个目标（skip）
 */
export async function fight(bot, target, opts = {}) {
    const maxKills = Math.max(1, Math.floor(Number(opts.maxKills) || 1));
    const retreatHp = Math.max(1, Math.min(20, Math.floor(Number(opts.retreatHp) || 8)));
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!target) return fail('NO_TARGET', '没说要打什么');

    let kills = 0;
    let sawTarget = false;
    let lastCode = null;
    const MAX_ATTACKS = 200;              // 兜底：防死循环（04 §4.4 第 4 条：循环必须有上限）
    let attacks = 0;

    while (kills < maxKills) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { kills, want: maxKills });
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;
        if (attacks++ > MAX_ATTACKS) break;

        // ── 撤退判据（卡片：血量 < retreatHp → flow_escape，撤退不算失败）──
        const hp = Number(bot.health ?? 20);
        if (hp < retreatHp) {
            try {
                await escapeUp(bot, {
                    deadlineMs: Math.max(3000, Math.min((ctx.deadline ?? Date.now() + 20000) - Date.now(), 20000)),
                    mapDir: mapDirOf(bot),
                });
            } catch { /* 逃不出去也照实报撤退了 */ }
            return ok({ killed: false, kills, want: maxKills, retreated: true, hpAtRetreat: hp });
        }

        // ── 选目标 ──
        const entity = findTarget(bot, target);
        if (!entity) {
            if (sawTarget || kills > 0) break;        // 打完了/目标没了：正常收尾
            return fail('NO_TARGET', `附近没有 ${target}`, { target, kills, want: maxKills });
        }
        sawTarget = true;

        // ── 追到近战范围（OUT_OF_REACH 时会来这儿）──
        const d = Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z);
        if (d > CHASE_DIST) {
            const okChase = await chase(bot, entity, ctx);
            if (!okChase) { lastCode = 'OUT_OF_REACH'; continue; }   // 追不上：下一轮再试
        }

        // ── 挥一次。冷却没好就**等够时间**，不空转 ──
        const r = await attackOnce(bot, { kind: 'entity', entity });
        if (r.ok) {
            if (!alive(entity)) kills++;
            else {
                // 打中了但没死：等一个冷却再打（动作自己会返回 NOT_READY 也行，但这里主动节流）
                if (!(await sleepWithin(ctx, ATTACK_COOLDOWN_MS))) break;
            }
            continue;
        }

        if (r.code === 'NOT_READY') {
            // 冷却没好 —— 等它，而不是立刻重试（这就是"按冷却节流"的落点）
            const waitMs = Number(r.data?.waitMs) || ATTACK_COOLDOWN_MS;
            if (!(await sleepWithin(ctx, waitMs))) break;
            continue;
        }
        if (r.code === 'OUT_OF_REACH') {
            lastCode = 'OUT_OF_REACH';                // 被击退了 → 下一轮重新追
            continue;
        }
        if (r.code === 'NO_TARGET') {
            // 目标消失了：如果是我们打死的，算一杀；否则收尾
            kills++;
            continue;
        }
        if (r.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { kills, want: maxKills });
        if (r.code === 'BLOCKED') {
            // 挥了没掉血（无敌帧/被挡）：等一个冷却再来
            lastCode = 'BLOCKED';
            if (!(await sleepWithin(ctx, ATTACK_COOLDOWN_MS))) break;
            continue;
        }
        lastCode = r.code ?? 'INTERNAL';
        break;
    }

    if (kills >= maxKills) {
        return ok({ killed: true, kills, want: maxKills, retreated: false, costMs: Date.now() - t0 });
    }
    if (kills > 0) {
        // 打了一部分：部分完成用 ok 带数（上层按 kills/want 判断要不要补）
        return ok({ killed: true, kills, want: maxKills, retreated: false, partial: true, costMs: Date.now() - t0 });
    }
    return fail(lastCode === 'OUT_OF_REACH' ? 'OUT_OF_REACH' : 'TIMEOUT',
        `没打死目标（${lastCode ?? 'timeout'}）`, { kills, want: maxKills, costMs: Date.now() - t0 });
}
