/**
 * A7 交互：按方块类别分派 —— 门 / 床 / 工作站 / 农作物。
 *
 * 为什么不是一个泛化的 use(anything)：
 *   四类的"后置判据"根本不同 —— 门看 open 属性、床看 isSleeping、工作站看窗口/状态、
 *   农作物看 age。硬塞进一个函数必然长出一堆 if，这正是 707 行 collect 的病
 *   （规格-v2 §6）。
 *
 * 单一副作用：让目标方块的状态发生变化。不负责走过去（复合层先 moveTo）。
 */
import Vec3 from 'vec3';
import { ok, fail, normalizeTarget } from './atom_contract.js';
import { blockAt, reachDistanceTo } from './atom_perceive.js';
import { GOAL_LOOK_AT_DEFAULT_REACH } from '../rules/rules.runtime.js';
import { openContainer, containerKindOf } from './atom_container.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 名字 → 交互类别。不确定的返回 null（不猜）。 */
export function useKindOf(bot, name) {
    if (!name) return null;
    if (/_door$/.test(name)) return 'door';
    if (/_trapdoor$/.test(name) || /_fence_gate$/.test(name)) return 'door';
    if (/_bed$/.test(name)) return 'bed';
    if (/^wheat$|^carrots$|^potatoes$|^beetroots$/.test(name)) return 'crop';
    if (containerKindOf(bot, name)) return 'workstation';
    return null;
}

/**
 * 与 pos 处方块交互。
 *
 * @returns ActionResult，data: { kind, pos, state }
 */
export async function useBlock(bot, pos, opts = {}) {
    const { maxReach = GOAL_LOOK_AT_DEFAULT_REACH, timeout = 3000 } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');
    const _t = normalizeTarget(pos);
    if (!_t || !_t.pos) return fail('NO_TARGET', '目标位置无效');
    pos = _t.pos;

    const v = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const block = blockAt(bot, v);
    if (!block) return fail('NO_TARGET', '那个位置没有方块');

    const kind = useKindOf(bot, block.name);
    if (!kind) return fail('NO_TARGET', `不知道怎么和 ${block.name} 交互`, { block: block.name });

    const dist = reachDistanceTo(bot, v);
    if (dist > maxReach) {
        return fail('OUT_OF_REACH', `够不着，眼睛到方块 ${dist.toFixed(1)} 格`, { distEyeToBlock: dist, block: block.name });
    }

    if (kind === 'door') return useDoor(bot, v, block, timeout);
    if (kind === 'bed') return useBed(bot, v, block, timeout);
    if (kind === 'crop') return harvestCrop(bot, v, block, timeout);

    // 工作站里"有 GUI"的那部分直接交给容器原子（避免两套开窗逻辑）。
    // 注意：必须传描述对象，不能传 Vec3 —— openContainer 只接受 {kind:'block', pos}
    // （踩过：这里传 Vec3，openContainer 会报"目标位置无效"）
    return openContainer(bot, { kind: 'block', pos: { x: v.x, y: v.y, z: v.z } }, { maxReach, timeout });
}

// ---------------------------------------------------------------------------
// 门 / 栅栏门 / 活板门
// ---------------------------------------------------------------------------

async function useDoor(bot, v, block, timeout) {
    const before = getOpenState(block);
    const t0 = Date.now();

    try {
        await Promise.race([
            bot.activateBlock(block),
            sleep(timeout).then(() => { throw new Error('activate-timeout'); }),
        ]);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/timeout/.test(msg)) return fail('TIMEOUT', `右键 ${Date.now() - t0}ms 没反应`, { block: block.name, costMs: Date.now() - t0 });
        return fail('INTERNAL', msg, { error: msg, block: block.name });
    }

    // 后置：读世界看 open 属性是否翻转（服务端可能拒绝开门，比如被红石锁住）
    const after = await waitFor(bot, () => {
        const b = blockAt(bot, v);
        if (!b) return 'gone';
        const now = getOpenState(b);
        return now !== before ? now : null;
    }, 1200);

    if (after === null) {
        return fail('BLOCKED', `${block.name} 没打开（可能被挡住/红石锁住）`, { block: block.name });
    }
    return ok({ useKind: 'door', pos: { x: v.x, y: v.y, z: v.z }, state: after, costMs: Date.now() - t0 });
}

function getOpenState(block) {
    // 门的 open 是布尔属性；活板门/栅栏门同名
    const p = block.getProperties?.() ?? block._properties ?? {};
    return p.open === true || p.open === 'true';
}

// ---------------------------------------------------------------------------
// 床
// ---------------------------------------------------------------------------

async function useBed(bot, v, block, timeout) {
    const t0 = Date.now();
    const wasSleeping = !!bot.isSleeping;

    try {
        if (wasSleeping) {
            bot.wake();
        } else {
            await Promise.race([
                bot.sleep(block),
                sleep(timeout).then(() => { throw new Error('sleep-timeout'); }),
            ]);
        }
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/timeout/.test(msg)) return fail('TIMEOUT', `上床 ${Date.now() - t0}ms 没成功`, { block: block.name, costMs: Date.now() - t0 });
        // 白天睡觉/有怪物在旁边，mineflayer 会抛具体原因，原样带回去
        return fail('BLOCKED', msg.slice(0, 80), { error: msg, block: block.name });
    }

    const after = await waitFor(bot, () => (!!bot.isSleeping !== wasSleeping ? !!bot.isSleeping : null), 1500);
    if (after === null) {
        return fail('BLOCKED', `床的状态没变化（${wasSleeping ? '没能起床' : '没能躺下'}）`, { block: block.name });
    }
    return ok({ useKind: 'bed', pos: { x: v.x, y: v.y, z: v.z }, state: after ? 'sleeping' : 'awake', costMs: Date.now() - t0 });
}

// ---------------------------------------------------------------------------
// 农作物（只收成熟的）
// ---------------------------------------------------------------------------

async function harvestCrop(bot, v, block, timeout) {
    const age = Number(block.getProperties?.()?.age ?? -1);
    const MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 }[block.name];
    if (MAX_AGE == null) return fail('NO_TARGET', `不认识作物 ${block.name}`, { block: block.name });
    if (age < MAX_AGE) {
        return fail('BLOCKED', `${block.name} 还没熟（age ${age}/${MAX_AGE}）`, { block: block.name, state: age });
    }

    const t0 = Date.now();
    try {
        await Promise.race([
            bot.dig(block, true),
            sleep(timeout).then(() => { throw new Error('harvest-timeout'); }),
        ]);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/timeout/.test(msg)) return fail('TIMEOUT', `收 ${Date.now() - t0}ms 没完`, { block: block.name, costMs: Date.now() - t0 });
        return fail('INTERNAL', msg, { error: msg, block: block.name });
    }

    // 后置：该格应该变空（作物被收走）或 age 归零（部分作物）
    const after = await waitFor(bot, () => {
        const b = blockAt(bot, v);
        if (!b) return 'gone';
        if (b.name === 'air' || b.name === 'cave_air') return 'gone';
        return null;
    }, 1200);
    if (after === null) {
        return fail('TIMEOUT', `${block.name} 收了但还在`, { block: block.name });
    }
    return ok({ useKind: 'crop', pos: { x: v.x, y: v.y, z: v.z }, state: 'harvested', costMs: Date.now() - t0 });
}

// ---------------------------------------------------------------------------

/**
 * 轮询等待 predicate 返回「有效值」；超时返回 null。
 *
 * 注意：predicate 返回 **undefined 表示还没完成**，其它任何值（含 false、0、''）都算完成。
 * 2026-10-24 踩过：门关闭时 open=false，旧实现用 `r !== false` 过滤，导致「关上」永远判成超时。
 */
async function waitFor(bot, predicate, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (bot.interrupt_code) return null;
        const r = predicate();
        if (r !== undefined && r !== null) return r;
        await sleep(80);
    }
    return null;
}
