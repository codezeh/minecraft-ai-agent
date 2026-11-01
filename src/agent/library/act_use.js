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
import { ok, fail, normalizeTarget } from './contract.js';
import { blockAt, reachDistanceTo } from './query_perceive.js';
import { GOAL_LOOK_AT_DEFAULT_REACH } from '../rules/rules.runtime.js';
import { openContainer, containerKindOf } from './act_container.js';
import { waitUntil } from './atom_wait.js';
import { holdDig, useOnBlock } from './atom_input_mouse.js';

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

    // ★ 2026-11-01（Phase A.2）：「右键方块」这一个输入交给 atom_input_mouse.useOnBlock。
    // 错误分类保持不变（超时 / 其它异常各自一个码）。
    const used = await useOnBlock(bot, block, { timeout });
    if (!used.ok) {
        if (used.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
        if (used.code === 'TIMEOUT') {
            return fail('TIMEOUT', `右键 ${Date.now() - t0}ms 没反应`, { block: block.name, costMs: Date.now() - t0 });
        }
        return fail('INTERNAL', used.message, { error: used.data?.error ?? used.message, block: block.name });
    }

    // 后置：读世界看 open 属性是否翻转（服务端可能拒绝开门，比如被红石锁住）
    //
    // ★ 2026-11-01（D22）：等状态变化改用 `atom_wait.waitUntil` 并把 bot 传进去。
    // 原来的本地 waitFor 在中断时返回 null，调用方把它当成"没变化"→ 报 BLOCKED
    // 说"门被红石锁住了"。取消就是取消，不该伪装成世界变了。
    const afterRes = await waitUntil(() => {
        const b = blockAt(bot, v);
        if (!b) return 'gone';
        const now = getOpenState(b);
        return now !== before ? now : null;
    }, { timeoutMs: 1200, intervalMs: 80, bot });

    if (afterRes.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { block: block.name });
    if (!afterRes.ok) {
        return fail('BLOCKED', `${block.name} 没打开（可能被挡住/红石锁住）`, { block: block.name });
    }
    const after = afterRes.data.value;
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

    // 同 useDoor：D22 —— 中断要报 INTERRUPTED，不能伪装成"床没反应"。
    const bedRes = await waitUntil(
        () => (!!bot.isSleeping !== wasSleeping ? !!bot.isSleeping : null),
        { timeoutMs: 1500, intervalMs: 80, bot },
    );
    if (bedRes.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { block: block.name });
    if (!bedRes.ok) {
        return fail('BLOCKED', `床的状态没变化（${wasSleeping ? '没能起床' : '没能躺下'}）`, { block: block.name });
    }
    const after = bedRes.data.value;
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
    // 收作物 = 对着那格按住左键 → atom_input_mouse.holdDig（超时/中断都在里面收尾）
    const dug = await holdDig(bot, block, { timeout });
    if (!dug.ok) {
        if (dug.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { block: block.name });
        if (dug.code === 'TIMEOUT') return fail('TIMEOUT', `收 ${Date.now() - t0}ms 没完`, { block: block.name, costMs: Date.now() - t0 });
        return fail('INTERNAL', dug.message, { error: dug.data?.error ?? dug.message, block: block.name });
    }

    // 后置：该格应该变空（作物被收走）或 age 归零（部分作物）
    const cropRes = await waitUntil(() => {
        const b = blockAt(bot, v);
        if (!b) return 'gone';
        if (b.name === 'air' || b.name === 'cave_air') return 'gone';
        return null;
    }, { timeoutMs: 1200, intervalMs: 80, bot });
    if (cropRes.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { block: block.name });
    if (!cropRes.ok) {
        return fail('TIMEOUT', `${block.name} 收了但还在`, { block: block.name });
    }
    return ok({ useKind: 'crop', pos: { x: v.x, y: v.y, z: v.z }, state: 'harvested', costMs: Date.now() - t0 });
}

// ---------------------------------------------------------------------------

/**
 * 「等某个状态变化」现在统一走 `atom_wait.waitUntil`（传 bot → 中断返回 INTERRUPTED）。
 *
 * 原来这里有一个本地 waitFor：中断时返回 null，调用方当成「没变化」→ 报 BLOCKED
 * 说「门被红石锁住了」。取消就是取消，不该伪装成世界没变（D22）。
 */
