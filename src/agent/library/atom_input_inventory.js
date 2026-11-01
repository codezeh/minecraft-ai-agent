/**
 * 输入原子：物品栏与界面 —— **全系统唯一允许切快捷栏 / 点窗口格子的地方**。
 *
 * 规矩见 docs/architecture/01_primitives.md §2（A1/A3/A4/A7）与 §3.3。
 * A1 那一列里有 `bot.clickWindow`；`bot.setQuickBarSlot`（按数字键切快捷栏）同理 ——
 * 都是"一次玩家输入"，所以只许住在 `atom_input_*`。
 *
 * 现状（2026-11-01 建这个文件时，先查过全仓再定接口）：
 *   - `bot.clickWindow` / `bot.setQuickBarSlot`：全仓 **0 处**（没有存量行为要保，接口按 01 §3.3 定）
 *   - `closeWindow`：已有原子 `atom_container.closeContainer`（01 §3.3 标 ✅），
 *     这里**转出**它，不写第二份
 *   - 扔东西：`atom_items.dropItem` 用的是 `bot.toss`（不是 clickWindow），不归这里
 *
 * 本文件只发一次输入，不判断"该不该切/该不该扔"（A6）、不重试（A5）；
 * "切过去没有""格子少了没有"这类后置复核是动作层的事。
 */
import { ok, fail } from './contract.js';
import { closeContainer } from './act_container.js';

/** 快捷栏格数（原版 9）。 */
export const HOTBAR_SLOTS = 9;

/**
 * 按数字键切到快捷栏第 i 格（0 起）。
 *
 * @param {object} bot
 * @param {number} i 0..8
 * @returns ActionResult
 *   ok  → data: { slot }
 *   INTERRUPTED / INTERNAL
 */
export async function selectSlot(bot, i) {
    const slot = Number(i);
    if (!Number.isInteger(slot) || slot < 0 || slot >= HOTBAR_SLOTS) {
        return fail('NO_TARGET', `快捷栏格号非法（${i}，应为 0..${HOTBAR_SLOTS - 1}）`);
    }
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (typeof bot.setQuickBarSlot !== 'function') {
        return fail('INTERNAL', '这个 bot 没有 setQuickBarSlot（不是完整 mineflayer 实例？）');
    }
    try {
        bot.setQuickBarSlot(slot);
        return ok({ slot });
    } catch (e) {
        return fail('INTERNAL', String(e?.message ?? e), { error: String(e?.message ?? e), slot });
    }
}

/**
 * 在当前打开的窗口里点一个格子（`bot.clickWindow`）。
 *
 * @param {object} bot
 * @param {number} slot   格子号
 * @param {object} opts
 *   button  0 = 左键（默认），1 = 右键
 *   mode    0 = 左键点、1 = shift-点、2 = 数字键交换、4 = Q 丢出（见 mineflayer 文档）
 * @returns ActionResult ok(data:{slot,button,mode}) / NO_TARGET / WINDOW_CLOSED / INTERRUPTED / INTERNAL
 */
export async function clickSlot(bot, slot, opts = {}) {
    const { button = 0, mode = 0 } = opts;
    const s = Number(slot);
    if (!Number.isInteger(s) || s < 0) {
        return fail('NO_TARGET', `格子号非法（${slot}）`);
    }
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!bot?.currentWindow) return fail('WINDOW_CLOSED', '现在没有打开的窗口');
    if (typeof bot.clickWindow !== 'function') {
        return fail('INTERNAL', '这个 bot 没有 clickWindow');
    }
    try {
        await bot.clickWindow(s, button, mode);
        return ok({ slot: s, button, mode });
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (/window|closed/i.test(msg)) return fail('WINDOW_CLOSED', msg, { error: msg, slot: s });
        if (/interrupt/i.test(msg)) return fail('INTERRUPTED', '被取消了', { slot: s });
        return fail('INTERNAL', msg, { error: msg, slot: s });
    }
}

/**
 * 关掉当前窗口。
 *
 * 转出 `atom_container.closeContainer` —— 那条早就是原子（01 §3.3 标 ✅），
 * 这里再写一份就是"同一能力两套实现"。入口放在本文件只是为了"界面输入只有一个出口"。
 *
 * @returns ActionResult ok(data:{closed}) / INTERNAL
 */
export async function closeWindow(bot) {
    return closeContainer(bot);
}

/**
 * 把一个格子的东西丢出去（Q 键）：`clickWindow(slot, all ? 1 : 0, 4)`。
 *
 * @param {object} bot
 * @param {number} slot  格子号
 * @param {boolean} all  true = 整摞丢（右键到光标再丢），false = 丢一个
 * @returns ActionResult
 */
export async function dropSlot(bot, slot, all = false) {
    return clickSlot(bot, slot, { button: all ? 1 : 0, mode: 4 });
}
