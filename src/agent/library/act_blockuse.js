/**
 * 动作：对"有状态的方块"右键一次（M6 P1）。
 *
 *   toggleBlock(target)  门/活板门/栅栏门/拉杆 → activateBlock → 状态翻转
 *   boneMeal(target)     手上骨粉、作物/树苗未成熟 → activateBlock → 生长推进
 *
 * 为什么这两个放一起、又和 `act_use` 分开：
 *   `act_use.useBlock` 是"按方块类型分派到具体交互"（门→开关、床→睡、工作站→开窗、作物→收），
 *   它关心的是"这类方块该怎么操作"；本文件这两件事关心的是**"右键一下让状态变化"**这个通式 ——
 *   判据都是"翻转前后读同一个属性"，不依赖具体方块类型。
 *
 *   分成不同文件还有个实际好处：boneMeal 需要 NO_TOOL（骨粉是消耗品），
 *   act_use 那套错误码里没有这个位置。
 */
import Vec3 from 'vec3';
import { ok, fail } from './contract.js';
import { useOnBlock } from './atom_input_mouse.js';
import { GOAL_LOOK_AT_DEFAULT_REACH as REACH } from '../rules/rules.runtime.js';

/** 能"翻开/关上"的方块。拉杆/按钮这类是瞬时脉冲，也按翻转处理（读 powered）。 */
const TOGGLEABLE = /(_door|_trapdoor|_fence_gate|lever|_button)$/;

/** 从方块属性里读出"开/关"或"通电"状态。读不到返回 undefined（不假装是 false）。 */
function stateOf(block) {
    const p = block?.getProperties?.() ?? block?._properties ?? null;
    if (!p) return undefined;
    if (p.open !== undefined) return p.open === true || p.open === 'true';
    if (p.powered !== undefined) return p.powered === true || p.powered === 'true';
    return undefined;
}

/**
 * 右键翻一下门/活板门/栅栏门/拉杆/按钮。
 *
 * @returns ActionResult
 *   ok            → data: { pos, block, before, after, verified }
 *   NO_TARGET      不是能翻的方块
 *   OUT_OF_REACH   够不着 —— 与 NO_PATH 的区别：走近就行，不用重规划路径
 *   BLOCKED        右键了但状态没变（被红石锁住/被挡住）—— 与 NOT_READY 的区别：
 *                  这个不是"等一会"，是"现在就是打不开"，要换个办法
 *
 * verified=false：这个方块读不到 open/powered 属性，所以"翻过去了"无法确认。
 * 不谎报成功，但也别 fail —— 右键本身没报错。
 */
export async function toggleBlock(bot, target, opts = {}) {
    const { maxReach = REACH } = opts;
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const raw = target?.pos ?? target;
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isFinite(raw.z)) {
        return fail('NO_TARGET', '目标位置无效');
    }
    const v = new Vec3(Math.floor(raw.x), Math.floor(raw.y), Math.floor(raw.z));
    const block = bot.blockAt?.(v, false);
    if (!block) return fail('NO_TARGET', '那格读不到方块（未加载？）');
    if (!TOGGLEABLE.test(block.name)) {
        return fail('NO_TARGET', `${block.name} 不是能开关的方块`, { block: block.name });
    }

    const self = bot.entity?.position;
    if (self) {
        const d = Math.hypot(v.x + 0.5 - self.x, v.y + 0.5 - self.y, v.z + 0.5 - self.z);
        if (d > maxReach) return fail('OUT_OF_REACH', `${block.name} 离 ${d.toFixed(1)} 格，够不着`, { dist: d });
    }

    const before = stateOf(block);
    const used = await useOnBlock(bot, block, { timeout: opts.timeout ?? 3000 });
    if (!used.ok) {
        if (used.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
        if (used.code === 'TIMEOUT') return fail('BLOCKED', `右键 ${block.name} 没反应`, { block: block.name });
        return fail('INTERNAL', used.message, { error: used.data?.error ?? used.message });
    }

    const after = stateOf(bot.blockAt?.(v, false));
    if (before === undefined || after === undefined) {
        return ok({ pos: { x: v.x, y: v.y, z: v.z }, block: block.name, before: null, after: null, verified: false });
    }
    if (before === after) {
        return fail('BLOCKED', `${block.name} 状态没变（可能被红石锁住或挡住）`, {
            block: block.name, before, after,
        });
    }
    return ok({ pos: { x: v.x, y: v.y, z: v.z }, block: block.name, before, after, verified: true });
}

/** 能吃骨粉加速的方块：作物、树苗、草/花（骨粉对它们都有效）。 */
const BONE_MEALABLE = /^(wheat|carrots|potatoes|beetroots|.*_sapling|.*_stem|.*_crop|grass_block|short_grass|tall_grass|.*_tulip|.*_orchid|.*_allium|.*_bluet|.*_daisy|.*_cornflower|.*_lily|.*_dandelion|.*_poppy|.*_rose|.*_mushroom)$/;

/** 作物的"熟没熟"要看 age；其它方块没有这个概念，返回 null。 */
function maturityOf(block) {
    const p = block?.getProperties?.() ?? null;
    const age = Number(p?.age);
    if (!Number.isFinite(age)) return null;
    const MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
    return { age, maxAge: MAX_AGE[block.name] ?? null };
}

/**
 * 对作物/树苗撒一次骨粉。
 *
 * @returns ActionResult
 *   ok            → data: { pos, block, before, after, advanced }
 *   NO_TOOL       手上/背包里没有骨粉 —— 与 NO_ITEM 的区别：骨粉在这里是**工具性的消耗品**，
 *                 上层该去"弄骨粉"（打骷髅/堆肥），提示方向不同
 *   NOT_READY     已经熟了/长到头了 —— 撒了也没用，等它自己长或直接收
 *   NO_TARGET     那格不是能吃骨粉的方块
 *   OUT_OF_REACH  够不着
 */
export async function boneMeal(bot, target, opts = {}) {
    const { maxReach = REACH } = opts;
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const raw = target?.pos ?? target;
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isFinite(raw.z)) {
        return fail('NO_TARGET', '目标位置无效');
    }
    const v = new Vec3(Math.floor(raw.x), Math.floor(raw.y), Math.floor(raw.z));
    const block = bot.blockAt?.(v, false);
    if (!block) return fail('NO_TARGET', '那格读不到方块（未加载？）');
    if (!BONE_MEALABLE.test(block.name)) {
        return fail('NO_TARGET', `${block.name} 不能撒骨粉`, { block: block.name });
    }

    const bag = (bot.inventory?.items?.() ?? []);
    const meal = bag.find((i) => i?.name === 'bone_meal' && (i.count ?? 0) > 0);
    if (!meal) return fail('NO_TOOL', '没有骨粉', { block: block.name });

    const self = bot.entity?.position;
    if (self) {
        const d = Math.hypot(v.x + 0.5 - self.x, v.y + 0.5 - self.y, v.z + 0.5 - self.z);
        if (d > maxReach) return fail('OUT_OF_REACH', `${block.name} 离 ${d.toFixed(1)} 格，够不着`, { dist: d });
    }

    const before = maturityOf(block);
    if (before && before.maxAge != null && before.age >= before.maxAge) {
        return fail('NOT_READY', `${block.name} 已经熟了（age ${before.age}/${before.maxAge}），撒了也没用`, {
            block: block.name, age: before.age, maxAge: before.maxAge,
        });
    }

    // 骨粉要拿在手上才生效
    try {
        if (bot.heldItem?.name !== 'bone_meal') await bot.equip(meal, 'hand');
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }

    const used = await useOnBlock(bot, block, { timeout: opts.timeout ?? 3000 });
    if (!used.ok) {
        if (used.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
        if (used.code === 'TIMEOUT') return fail('BLOCKED', `右键 ${block.name} 没反应`, { block: block.name });
        return fail('INTERNAL', used.message, { error: used.data?.error ?? used.message });
    }

    const afterBlock = bot.blockAt?.(v, false);
    const after = maturityOf(afterBlock);
    // 读得到 age 就比 age；读不到（草/花/树苗）就只能信"用了骨粉"这件事
    const advanced = before && after ? (after.age > before.age) : null;
    if (advanced === false) {
        return fail('NOT_READY', `${block.name} 撒了骨粉但没长（age ${before.age}→${after.age}）`, {
            block: block.name, before: before.age, after: after.age,
        });
    }
    return ok({
        pos: { x: v.x, y: v.y, z: v.z },
        block: block.name,
        before: before?.age ?? null,
        after: after?.age ?? null,
        advanced,
    });
}
