/**
 * 动作：与实体交互（M6 P1，02 §3.5）。
 *
 *   feedEntity(entity, food)  够得着、手里是对的食物 → equip → useOnEntity → 进入繁殖状态
 *   tradeOnce(villager, index) 够得着、货够 → openVillager → trade → 关
 *
 * 为什么和 `act_attack` 分开：那两个是"伤害/威胁"语义，这里是"合作/交易"语义。
 * 混在一起会让 `nearestAttackable` 这类判断被误用（村民能被 attack，但不该被攻击）。
 */
import { ok, fail } from './contract.js';
import { useOnEntity } from './atom_input_mouse.js';

/** 近距交互距离（mineflayer 的 activateEntity 走 3 格左右）。 */
const INTERACT_REACH = 3.5;

/** 算到实体的距离；读不到坐标返回 null。 */
function distTo(bot, entity) {
    const self = bot?.entity?.position;
    const p = entity?.position;
    if (!self || !p) return null;
    return Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z);
}

/**
 * 给动物喂东西（进繁殖状态）。
 *
 * @param {object} entity 目标动物
 * @param {string} food   要喂的物品名（小麦/胡萝卜/种子…）
 * @returns ActionResult
 *   ok            → data: { entity, item, inLove }
 *   NO_ITEM       背包里没有这种食物 —— 与 NO_TOOL 的区别：食物是**消耗品**，
 *                 上层该去"弄食物"，不是"换个工具"
 *   OUT_OF_REACH  够不着 —— 与 NO_PATH 的区别：走近就行（02 §3.5 原表用的就是 OUT_OF_REACH）
 *   NO_TARGET     目标无效/已经没了
 *   INTERNAL      使用物品时抛错
 */
export async function feedEntity(bot, entity, food, opts = {}) {
    const { maxReach = INTERACT_REACH } = opts;
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!entity || entity.isValid === false) return fail('NO_TARGET', '目标实体无效');
    if (!food) return fail('NO_TARGET', '没说要喂什么');

    const d = distTo(bot, entity);
    if (d == null) return fail('NO_TARGET', '读不到目标坐标');
    if (d > maxReach) {
        return fail('OUT_OF_REACH', `目标在 ${d.toFixed(1)} 格外（交互 ${maxReach} 格）`, {
            dist: d, entity: entity.name ?? null,
        });
    }

    const stack = (bot.inventory?.items?.() ?? []).find((i) => i?.name === food && (i.count ?? 0) > 0);
    if (!stack) return fail('NO_ITEM', `背包里没有 ${food}`, { food });

    try {
        if (bot.heldItem?.name !== food) await bot.equip(stack, 'hand');
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e) });
    }

    const used = await useOnEntity(bot, entity);
    if (!used.ok) {
        if (used.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
        if (used.code === 'NO_TARGET') return fail('NO_TARGET', '目标没了');
        return fail('INTERNAL', used.message, { error: used.data?.error ?? used.message });
    }

    // 后置：读繁殖状态。读不到就如实说"没法确认"，别谎报成功
    const inLove = entity.inLove ?? entity.metadata?.[12] ?? null;
    const verified = inLove !== null && inLove !== undefined;
    return ok({
        entity: entity.name ?? null,
        item: food,
        inLove,
        verified: verified ? !!inLove : false,
    });
}

/**
 * 和村民做**一笔**交易。
 *
 * @param {object} villager 村民实体
 * @param {number} index    第几个交易（默认 0）
 * @returns ActionResult
 *   ok            → data: { entity, index, item }
 *   WINDOW_CLOSED 交易窗口没开着 —— 与 NOT_READY 的区别：这个要"先开窗"（开窗是流程的事）
 *   NOT_READY     没有第 index 个交易 —— 与 NO_ITEM 的区别：那是"货不够"，这是"没这一条"
 *   NO_ITEM       货不够（村民要求的东西背包里没有）
 *   OUT_OF_REACH  够不着
 */
export async function tradeOnce(bot, villager, index = 0, opts = {}) {
    const { maxReach = INTERACT_REACH } = opts;
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!villager || villager.isValid === false) return fail('NO_TARGET', '目标村民无效');

    const d = distTo(bot, villager);
    if (d == null) return fail('NO_TARGET', '读不到目标坐标');
    if (d > maxReach) return fail('OUT_OF_REACH', `村民在 ${d.toFixed(1)} 格外`, { dist: d });

    const win = bot.currentWindow;
    if (!win) return fail('WINDOW_CLOSED', '交易窗口没开（先 openVillager 再交易）', {});

    const trades = win.trades ?? [];
    const tr = trades[index];
    if (!tr) {
        return fail('NOT_READY', `没有第 ${index} 个交易（共 ${trades.length} 条）`, {
            index, available: trades.length,
        });
    }

    // 货够不够：第一项输入（有的交易要两样）
    const want = tr.inputItem1 ?? tr.inputItem?.[0] ?? null;
    if (want?.name) {
        const have = (bot.inventory?.items?.() ?? [])
            .filter((i) => i?.name === want.name)
            .reduce((n, i) => n + (i.count ?? 0), 0);
        const need = want.count ?? 1;
        if (have < need) {
            return fail('NO_ITEM', `交易要 ${need} 个 ${want.name}，只有 ${have}`, {
                item: want.name, need, have, index,
            });
        }
    }

    try {
        await win.trade(tr, 1);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了');
        if (/window|closed/i.test(msg)) return fail('WINDOW_CLOSED', msg, { error: msg });
        return fail('INTERNAL', msg, { error: msg, index });
    }

    return ok({ entity: villager.name ?? null, index, item: want?.name ?? null });
}
