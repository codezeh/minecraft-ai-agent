/**
 * A6 容器：openContainer / closeContainer / 存取的薄封装。
 *
 * 单一副作用：打开一个容器窗口（或关掉）。
 * 不负责"存什么、取什么"——那是复合层的事，否则就又长回 skills.js 那种 5 个函数各写一遍。
 *
 * 实现原则（见 原子动作规格-v2.md §5）：
 *   - 开窗动作**直接复用 mineflayer 的 bot.openContainer**，本文件只补它缺的三件：
 *     前置断言（是不是容器 / 距离）、后置校验（窗口真的开了吗）、错误码归一
 *   - 容器判定按注册表 + 名字模式，不写死长名单（版本升级会漏）
 */
import Vec3 from 'vec3';
import { ok, fail, normalizeTarget } from './contract.js';
import { blockAt, reachDistanceTo } from './query_perceive.js';
import { GOAL_LOOK_AT_DEFAULT_REACH } from '../rules/rules.runtime.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 名字 → 容器类别。用模式匹配，注册表里出现新变体也能覆盖。 */
const CONTAINER_PATTERNS = [
    { re: /^chest$|^trapped_chest$/, kind: 'chest' },
    { re: /^ender_chest$/, kind: 'ender_chest' },
    { re: /^barrel$/, kind: 'barrel' },
    { re: /^hopper$/, kind: 'hopper' },
    { re: /^dropper$/, kind: 'dropper' },
    { re: /^dispenser$/, kind: 'dispenser' },
    { re: /_shulker_box$|^shulker_box$/, kind: 'shulker' },
    { re: /^furnace$|^lit_furnace$/, kind: 'furnace' },
    { re: /^smoker$/, kind: 'smoker' },
    { re: /^blast_furnace$/, kind: 'blast_furnace' },
    { re: /^brewing_stand$/, kind: 'brewing_stand' },
    { re: /^enchanting_table$/, kind: 'enchanting_table' },
    { re: /^crafting_table$/, kind: 'crafting_table' },
    { re: /^anvil$|^chipped_anvil$|^damaged_anvil$/, kind: 'anvil' },
    { re: /^stonecutter$/, kind: 'stonecutter' },
    { re: /^smithing_table$/, kind: 'smithing_table' },
    { re: /^loom$/, kind: 'loom' },
    { re: /^cartography_table$/, kind: 'cartography_table' },
    { re: /^grindstone$/, kind: 'grindstone' },
    { re: /^lectern$/, kind: 'lectern' },
];

/**
 * 这个方块是不是容器（能开窗）。
 * @returns {string|null} kind，不是容器返回 null
 */
export function containerKindOf(bot, name) {
    const def = bot?.registry?.blocksByName?.[name];
    if (!def) return null;
    for (const p of CONTAINER_PATTERNS) {
        if (p.re.test(name)) return p.kind;
    }
    return null;
}

/** 容器自身的槽位数（不含玩家背包）。注意 window.slots 是「容器 + 背包 + 快捷栏」总和。 */
const CONTAINER_SLOTS = {
    chest: 27, trapped_chest: 27, barrel: 27, ender_chest: 27,
    hopper: 5, dropper: 9, dispenser: 9,
    furnace: 3, smoker: 3, blast_furnace: 3, brewing_stand: 5,
    enchanting_table: 2, crafting_table: 10, stonecutter: 2, smithing_table: 4,
    loom: 4, cartography_table: 3, grindstone: 3, lectern: 1,
};

/** 玩家背包 + 快捷栏固定占 36 格（27 + 9），无论容器多大。 */
const PLAYER_SLOTS = 36;

/**
 * 实际的槽位构成（实测，不是猜的）。
 *
 * 2026-10-24 测试服实测：打开 chest 后 `window.slots.length = 63`，
 * 因为它是「27 容器 + 27 背包 + 9 快捷栏」。所以不能拿 27 去断言。
 * 这里只做**如实记录 + 一致性校验**（containerSlots 必须等于 CONTAINER_SLOTS 里声明的值），
 * 不拿它当失败判据——版本差异会让总和变，但"容器部分多大"是稳定的。
 */
function slotLayout(kind, slotsLen) {
    const expected = CONTAINER_SLOTS[kind] ?? null;
    if (expected == null || slotsLen == null) return { containerSlots: null, expected: null, consistent: null };
    const containerSlots = slotsLen - PLAYER_SLOTS;
    return { containerSlots, expected, consistent: containerSlots === expected };
}

/**
 * 打开 pos 处的容器。
 *
 * @returns ActionResult，data: { containerKind, pos, slots, title }
 */
export async function openContainer(bot, pos, opts = {}) {
    const { maxReach = GOAL_LOOK_AT_DEFAULT_REACH, timeout = 4000 } = opts;

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');
    const _t = normalizeTarget(pos);
    if (!_t || !_t.pos) return fail('NO_TARGET', '目标位置无效');
    pos = _t.pos;

    const v = pos instanceof Vec3
        ? new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
        : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));

    // ---- 前置断言 ----
    const block = blockAt(bot, v);
    if (!block) return fail('NO_TARGET', '那个位置没有方块');

    const kind = containerKindOf(bot, block.name);
    if (!kind) return fail('NO_TARGET', `${block.name} 不是容器`, { block: block.name });

    const dist = reachDistanceTo(bot, v);
    if (dist > maxReach) {
        return fail('OUT_OF_REACH', `够不着，眼睛到容器 ${dist.toFixed(1)} 格`,
            { distEyeToBlock: dist, block: block.name });
    }

    // 已经开着别的窗口：先关，别叠着开（叠着开会让服务端忽略第二次 open）
    if (bot.currentWindow) {
        return fail('BLOCKED', `已经有窗口开着（${bot.currentWindow.title ?? '未命名'}），先关掉`,
            { block: block.name });
    }

    // ---- 执行（复用 mineflayer，不自己发包）----
    //
    // 两个 API 分工（实测 2026-10-24，见 mineflayer/lib/plugins/chest.js:14）：
    //   bot.openContainer 只接受白名单（箱子/漏斗/投掷器/潜影盒/末影箱），
    //     对工作台/熔炉/铁砧会抛 "containerToOpen is neither a block nor an entity"
    //   bot.openBlock 是底层通用入口，不查白名单
    // 所以：箱子类走 openContainer（它会额外校验窗口类型），其余走 openBlock。
    const USE_OPEN_CONTAINER = new Set(['chest', 'trapped_chest', 'ender_chest', 'barrel',
        'hopper', 'dropper', 'dispenser', 'shulker']);
    const t0 = Date.now();
    let win = null;
    try {
        const opener = USE_OPEN_CONTAINER.has(kind)
            ? bot.openContainer(block)
            : bot.openBlock(block);
        win = await Promise.race([
            opener,
            sleep(timeout).then(() => { throw new Error('open-timeout'); }),
        ]);
    } catch (e) {
        const msg = String(e?.message ?? e);
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { /* ignore */ }
        if (/timeout/.test(msg)) {
            return fail('TIMEOUT', `开了 ${Date.now() - t0}ms 还没开`, { block: block.name, costMs: Date.now() - t0 });
        }
        return fail('INTERNAL', msg, { error: msg, block: block.name });
    }

    // ---- 后置校验：窗口真的开了吗（读 bot 状态，不信返回值）----
    const opened = bot.currentWindow ?? win;
    if (!opened) {
        return fail('TIMEOUT', `openContainer 返回了但窗口没开`, { block: block.name, costMs: Date.now() - t0 });
    }

    const slots = opened.slots?.length ?? null;
    const layout = slotLayout(kind, slots);

    // 槽位数不判失败（版本/背包大小会变），但如实带回去：
    // consistent=false 说明「容器部分」与声明不符，值得上层或测试注意到。
    return ok({
        containerKind: kind,
        pos: { x: v.x, y: v.y, z: v.z },
        slots,
        containerSlots: layout.containerSlots,
        expectedSlots: layout.expected,
        slotConsistent: layout.consistent,
        title: opened.title ?? '',
        distEyeToBlock: dist,
        costMs: Date.now() - t0,
    });
}

/** 关掉当前窗口（幂等：没开窗也返回 ok）。 */
export function closeContainer(bot) {
    if (!bot.currentWindow) return ok({ closed: false });
    try {
        bot.closeWindow(bot.currentWindow);
        return ok({ closed: true });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e));
    }
}

/** 当前窗口里的物品快照（给上层判断"有没有我要的"）。 */
export function windowItems(bot) {
    const win = bot.currentWindow;
    if (!win) return null;
    return (win.slots || [])
        .map((it, i) => (it && it.name ? { slot: i, name: it.name, count: it.count } : null))
        .filter(Boolean);
}
