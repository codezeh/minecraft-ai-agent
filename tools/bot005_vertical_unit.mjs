/**
 * BOT-005（2026-11-06 深度检查）—— goTo 丢弃目标高度 / 原地报成功。
 *
 * 缺陷原貌：
 *   nav_core 调用 walkTo 时只传 {x,z}，y 被丢掉；而 walkTo 的到达判据只算
 *   `hypot(dx, dz)`。于是"站在 y64、目标 y120"这种只有垂直差的请求会**零步返回 OK**，
 *   上层接着去执行够不到的交互（跨楼层箱子/熔炉/采集点）。
 *
 * 修复后应成立的三条判据：
 *   ① 只有垂直差 → 明确失败 HEIGHT_MISS，且数据里带 verticalDistance（不假装到了）；
 *   ② 同一层的目标（方块 y 与脚位 y 差 1）→ 仍然 OK（不误伤正常导航）；
 *   ③ 不给 y 的老调用（{x,z}）→ 行为完全不变（ok）。
 *
 * 全部离线：假 bot + 假 mapDir，不连服务器、不读地形库。
 */
import { walkTo } from '../src/agent/library/executor.js';
import { goTo } from '../src/agent/library/nav_core.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/** 只实现 walkTo/goTo 会碰到的接口。 */
function makeBot({ x = 0, y = 64, z = 0 } = {}) {
    return {
        entity: { position: { x, y, z } },
        interrupt_code: null,
        // 让 restoreGoalModes 的"还在动吗"判定立刻收敛
        pathfinder: { isMoving: () => false, setGoal: () => { }, stop: () => { } },
        modes: { isPaused: () => false, pause: () => { }, unpause: () => { } },
    };
}

const MAP_DIR = '__no_such_map__';   // 一旦真的进入规划就会失败，正好证明"没进规划"

// ── ① 只有垂直差：必须 HEIGHT_MISS，不能 OK ────────────────────────────
{
    const bot = makeBot({ x: 0, y: 64, z: 0 });
    const r = await walkTo(bot, { x: 0, y: 120, z: 0 }, { mapDir: MAP_DIR });
    check('① 垂直差 56 格不再原地报成功', r.ok === false, `ok=${r.ok} code=${r.code}`);
    check('① 失败码是 HEIGHT_MISS', r.code === 'HEIGHT_MISS', `code=${r.code}`);
    check('① 数据里如实带出垂直距离', Math.abs((r.data?.verticalDistance ?? 0) - 56) < 0.01,
        `verticalDistance=${r.data?.verticalDistance}`);
    check('① 没有浪费轮次（第 0 轮就判出来）', (r.data?.rounds ?? -1) === 0, `rounds=${r.data?.rounds}`);
    check('① 一步没走', (r.data?.moved ?? -1) === 0, `moved=${r.data?.moved}`);
}

// ── ② 同一层（方块 y=64，脚位 y=65）：照旧 OK ─────────────────────────────
{
    const bot = makeBot({ x: 3, y: 65, z: -2 });
    const r = await walkTo(bot, { x: 3, y: 64, z: -2 }, { mapDir: MAP_DIR });
    check('② 方块 y 与脚位 y 差 1 仍判到达（不误伤）', r.ok === true, `ok=${r.ok} code=${r.code}`);
}

// ── ③ 不给 y 的老调用：行为不变 ─────────────────────────────────────────
{
    const bot = makeBot({ x: 0, y: 64, z: 0 });
    const r = await walkTo(bot, { x: 0, z: 0 }, { mapDir: MAP_DIR });
    check('③ 不给 y 时仍按水平判到达（向后兼容）', r.ok === true, `ok=${r.ok} code=${r.code}`);
}

// ── ④ 经 goTo 入口：y 必须真的传下去（还原报告里的复现路径）──────────────
{
    const bot = makeBot({ x: 0, y: 64, z: 0 });
    const r = await goTo(bot, { x: 0, y: 120, z: 0 }, { mapDir: MAP_DIR });
    check('④ goTo→walkTo 不再丢掉 y', r.ok === false && r.code === 'HEIGHT_MISS',
        `ok=${r.ok} code=${r.code}`);
    check('④ 结果标明走的是 3D 引擎', r.data?.engine === 'walk3d', `engine=${r.data?.engine}`);
}

// ── ⑤ 水平也没到：不能抢着报 HEIGHT_MISS（否则掩盖真正的行走失败）─────
{
    const bot = makeBot({ x: 0, y: 64, z: 0 });
    let r = null;
    try {
        r = await walkTo(bot, { x: 50, y: 120, z: 50 }, { mapDir: MAP_DIR, deadlineMs: 30 });
    } catch (e) {
        r = { ok: false, code: 'THREW', message: String(e?.message ?? e) };
    }
    check('⑤ 水平未达时不误报 HEIGHT_MISS', r.code !== 'HEIGHT_MISS',
        `code=${r.code} message=${String(r.message ?? '').slice(0, 60)}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
