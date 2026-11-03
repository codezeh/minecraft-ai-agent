/**
 * 流程：挖 N 个矿（M7 P0，04 §6.1 卡片 `flow_mine`）。
 *
 * 卡片原文：
 *   plan：按矿种定目标高度（写进配置，例：铁 16、钻石 -58）→ `flow_tunnel` 阶梯下到那层
 *         → 主巷道每隔 3 格开支巷 → 每步先看可见矿石，有就 `digBlock` + 捡 → 够数原路返回
 *   安全：每步 `checkStep`；掉血交给 `self_preservation` 反射，流程不自己判
 *   onFail：`LIQUID_RISK` `NO_FLOOR` → `replan` 换方向；`NO_TOOL` → `abort`
 *   完成：增量 ≥ `count`；到 `maxDepth` 或 deadline → `fail('TIMEOUT', …, {count, want})`
 *
 * ★ "矿挖不到 / 太深" 怎么处理（本文件最需要说清的一处）
 *   三种情况分开处置，因为它们对上层的意思完全不同：
 *   ① **附近根本没有这种矿** → `NO_TARGET`（换个地方/换个矿种；这是"没目标"，不是"做不到"）
 *   ② **有矿但够不着/走不过去** → 先 `goTo` 靠近；仍不行 → `OUT_OF_REACH`
 *      （与 NO_TARGET 的区别：那是"没有矿"，这是"矿在那儿但过不去"）
 *   ③ **太深/到 maxDepth 还没挖够** → `TIMEOUT` 且带 `{count, want}`（卡片明确要求这个码）
 *      —— 不用 NO_PATH：路径本身没问题，是"深度预算用完了"
 *   另外 `NO_TOOL`（挖不动，比如没镐）→ **abort**，不重试：换方向也没用。
 *
 * 为什么"下到目标层"用 `tunnelStep` 而不是自己挖：`atom_tunnel.tunnelStep` 已经带
 * `checkStep` 安全检查（液体/无地板红线），流程不该自己再实现一遍挖穿逻辑。
 */
import { ok, fail } from './contract.js';
import { digBlock, isDiggable, canDigWithInventory, canDigReason } from './act_dig.js';
import { findBlocks } from './query_perceive.js';
import { countItem } from './query_perceive.js';
// ★★ 2026-11-04（t70）：**必须用 `query_perceive.blockAt`，不能用 `bot.blockAt(裸对象)`。**
//
//   mineflayer 的 `bot.blockAt(point)` 内部会调 `point.floored()` —— 那是 **Vec3 的方法**，
//   传裸 `{x,y,z}` 会**抛错**（或被 catch 吞成 null）。
//
//   真机证据（第 17 跑）：`[MINE] goTo ... stand= null` **×130**，`stand={...}` **×0** ——
//   而我用 verify 实测的同一份四邻数据在离线跑 `findStandNear`，**能正确返回 {y:-59}**。
//   也就是说：**逻辑对，读方块的方式错。**
//
//   `query_perceive.blockAt(bot, pos)` 里面已经 `vec(pos)` 包好了 Vec3 —— 复用它，
//   也顺便只有"一处知道怎么读方块"（今晚"同一件事只许一个名字"）。
import { blockAt as readBlock } from './query_perceive.js';
import { mapDirOf } from './bot_paths.js';
import { goTo } from './nav_core.js';
import { collectDrops } from './flow_pickup.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'mine',
    level: 'flow',
    summary: '挖 N 个某种矿（会走到矿旁边、挖掉、捡起来；太深会放弃）',
    params: {
        ore: 'string',
        count: 'int 1..64 = 1',
        maxDepth: 'int 1..128 = 64',
    },
    needs: { items: ['镐'], near: [] },
    claims: [],
    codes: ['NO_TARGET', 'NO_TOOL', 'NOT_READY', 'OUT_OF_REACH', 'NO_PATH', 'NO_FLOOR', 'LIQUID_RISK', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: false,
    timeoutMs: 8 * 60 * 1000,
};

/**
 * ★★ 2026-11-04（t72）：**常驻诊断，`TRACE=1` 才输出，默认零开销。**
 *
 * 为什么改成常驻（原来是"跑前加、跑完删"）：
 *   "跑完立刻还原打点"和"下一跑还要用打点"是**矛盾**的 —— 第 20 跑就因此拿不到
 *   `[MINE]` 数据（verify 按硬约束还原了，于是那一跑没有可用诊断）。
 *   改成手动开关：想有数据就 `TRACE=1` 启动，不用改代码、不会忘、不留残留风险。
 *
 * 这四类行是踩过坑才加的，别删：
 *   `round` 每轮候选数 / feetY  → 暴露过"根本没扫到矿"和"人在错误的高度"
 *   `goTo`  落点 stand + 结果码 → 暴露过 `stand=null ×130`（裸对象）和"选到树干内部"
 *   `dig`   结果码              → 暴露过 `INTERNAL 1590`（两条流抢 pathfinder）
 *   `pickup` mined vs gained    → 暴露过"挖 7 个只捡到 2 个"（掉落物过期）
 */
function trace(...args) {
    if (process.env.TRACE) console.log('[MINE]', ...args);
}

/**
 * 各矿的理想挖掘高度（Y）。卡片举例：铁 16、钻石 -58。
 * 这张表是"去哪找"的常识，不是魔法数：原版矿脉按 Y 分布，找不到就换高度。
 */
const ORE_Y = {
    coal: 96, copper: 48, iron: 16, gold: -16, redstone: -58, diamond: -58,
    lapis: 0, emerald: 100, nether_quartz: 32, ancient_debris: 15,
};


/**
 * 时间预算（毫秒）。**上限**语义：调用处一律 `Math.min(预算, deadline - now)`，
 * 所以永远不会越过任务单的 deadline。具名化是为了"要调就只改一处"。
 */
const DESCEND_BUDGET_MS = 60000;    // 下到目标高度那一次 goTo
const APPROACH_BUDGET_MS = 40000;   // 走近某一块矿
const DESCEND_WINDOW_MS = 30000;    // 下潜时额外给的窗口（与预算取小）
const APPROACH_WINDOW_MS = 30000;   // 走近时额外给的窗口（与预算取小）
const MIN_WAIT_BUDGET_MS = 4000;    // 每一步最少给的预算

/** 矿名规范化：`iron_ore` / `deepslate_iron_ore` / `iron` 都认。 */
function oreNames(ore) {
    const base = String(ore ?? '').toLowerCase().replace(/^minecraft:/, '');
    const bare = base.replace(/^deepslate_/, '').replace(/_ore$/, '');
    const names = new Set([base]);
    if (!base.endsWith('_ore')) names.add(`${bare}_ore`);
    names.add(`deepslate_${bare}_ore`);
    return [...names];
}

/**
 * 矿石方块 → **掉落物**物品名。
 *
 * ★ 2026-11-02 真机抽验抓到的第二处谎报：原来用"方块名"当背包计数键，
 *   可是挖 `iron_ore` 掉的是 `raw_iron`（方块和物品不是同一个名字）。
 *   于是 `countItem('iron_ore')` 永远是 0 → 流程报 `gained:0`，
 *   而实际上她背包里已经有 raw_iron 了。
 *
 * 规则：`X_ore` → `raw_X`（铁/金/铜），钻石/红石/青金石/绿宝石/煤炭直接同名。
 * 表里没有的，退回"按方块名数"（老行为，至少不会崩）。
 */
const ORE_DROP = {
    iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
    gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
    copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
    coal_ore: 'coal', deepslate_coal_ore: 'coal',
    diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
    emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
    redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
    lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
    nether_quartz_ore: 'quartz',
    ancient_debris: 'ancient_debris',
};

/** 现在所在的高度。 */
function feetY(bot) {
    return Math.floor(bot.entity?.position?.y ?? 0);
}

/**
 * ★★ 2026-11-03（t67）：找一个**能站在方块旁边**的格子。
 *
 * 为什么需要：`goTo` 的目标如果传方块自身（`block.position`），那是**实心格的内部**，
 * 寻路器不可能站进去 → `NO_REACH`。真机实测：`goTo false NO_REACH × 127`，
 * 导致 d>4 的块全被跳过，只挖到 1/8。
 *
 * 判据（保守，找得到才走）：
 *   同层四邻（±x / ±z），要求**那格是 air**（能站人）且**它脚下是实心**（站得住）。
 *   找不到就返回 null（调用方退回"只给 x/z"的旧行为，不会更差）。
 */
export function findStandNear(bot, pos) {
    try {
        const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
        const cands = [];
        // ★ t68：dy 到 -6、dx/dz 到 ±3 —— 树干的 log 离地可能差 5 层
        //   （log 在 y=-55、地面在 -60）。范围太小时会全 null → NO_REACH 降不下来。
        for (let dy = 0; dy >= -6; dy -= 1) {
            for (let dx = -3; dx <= 3; dx += 1) {
                for (let dz = -3; dz <= 3; dz += 1) {
                    // ★★ 2026-11-04（t71）：**必须换列** —— 只跳过 `dy===0` 是不够的。
                    //
                    //   真机证据（第 18 跑）：`findStandNear` 已经 131 次都返回了落点
                    //   （`stand=null` 从 130 降到 0），但 `goTo` 仍然 `NO_REACH ×128`。
                    //   看它返回的样例：
                    //     stand= {x:6206, y:-57, z:8806}  for bpos= 6206 -54 8806   ← dx=0,dz=0！
                    //     stand= {x:6205, y:-59, z:8806}  for bpos= 6206 -58 8806   ← dx=-1 正常
                    //   第一个例子选中的是**方块自己那一列、往下 3 格** ——
                    //   对树来说那正是**树干内部**（树干占满那一列），寻路器当然走不进去 → `NO_REACH`。
                    //
                    //   "站在旁边"的语义就要求**水平方向换列**（dx 或 dz 非 0）。
                    //   同列往下的候选看起来"脚下有实心"（踩在树干上），实际是树干内部。
                    if (dx === 0 && dz === 0) continue;                // 必须换列（含原方块自身）
                    const x = bx + dx, y = by + dy, z = bz + dz;
                    // ★ t70：用 `readBlock`（query_perceive，内部包 Vec3）
                    //   而不是 `bot.blockAt(裸对象)` —— 后者对裸对象会抛错/返回 null。
                    const feet = readBlock(bot, { x, y, z });
                    if (!feet || !/^(air|cave_air|void_air)$/.test(feet.name)) continue;
                    const below = readBlock(bot, { x, y: y - 1, z });
                    if (!below) continue;
                    if (/^(air|cave_air|void_air)$/.test(below.name)) continue;
                    if (/^(water|lava)$/.test(below.name)) continue;
                    if (/_leaves$/.test(below.name)) continue;         // 树叶站不住
                    cands.push({ x, y, z, score: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 1.5 });
                }
            }
        }
        if (!cands.length) return null;
        cands.sort((a, b) => a.score - b.score);
        const best = cands[0];
        return { x: best.x, y: best.y, z: best.z };
    } catch { return null; }
}

/**
 * 挖 count 个 ore。
 *
 * @param {object} opts { maxDepth=64, ctx }
 * @returns ActionResult
 *   ok        → data: { ore, count, want, mined, costMs }
 *   NO_TARGET 附近找不到这种矿
 *   NO_TOOL   挖不动（没镐/镐不够好）—— abort
 *   OUT_OF_REACH 有矿但走不过去
 *   TIMEOUT   到 maxDepth 或 deadline 还没挖够（带 count/want）
 */
export async function mine(bot, ore, count = 1, opts = {}) {
    const want = Math.max(1, Math.floor(Number(count) || 1));
    const maxDepth = Math.max(1, Math.floor(Number(opts.maxDepth) || 64));
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    const t0 = Date.now();
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (!ore) return fail('NO_TARGET', '没说要挖什么矿');

    const names = oreNames(ore);
    // 计数键：**掉落物名**（挖 iron_ore 得到的是 raw_iron，不是 iron_ore）。
    // 有的矿方块名和物品名相同（diamond_ore → diamond），所以两种都数，取大。
    const dropNames = [...new Set(names.map((n) => ORE_DROP[n] ?? n))];
    const countAll = () =>
        dropNames.reduce((n, name) => n + countItem(bot, name), 0)
        + names.reduce((n, name) => n + countItem(bot, name), 0);
    const before = countAll();
    const startY = feetY(bot);
    const wantY = ORE_Y[String(ore).toLowerCase().replace(/^minecraft:/, '').replace(/_ore$/, '')];

    let mined = 0;
    let sawAnyOre = false;
    let lastCode = null;
    const MAX_ROUNDS = 40;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { ore, count: mined, want });
        if (countAll() - before >= want) break;
        if (Date.now() >= (ctx.deadline ?? Infinity)) break;
        // 深度预算：比起点低了 maxDepth 就收工（卡片：到 maxDepth → TIMEOUT + count/want）
        if (startY - feetY(bot) > maxDepth) break;

        // ── 找可见矿石（近的先挖）──
        const candidates = [];
        for (const name of names) {
            try {
                const found = findBlocks(bot, name, 32, 32) ?? [];
                for (const b of found) candidates.push(b);
            } catch { /* 未注册的矿名直接跳过 */ }
        }
        if (!candidates.length) {
            // 这一轮视野里没有矿。第一次没看到 → 可能该换高度；换过还没 → NO_TARGET
            if (sawAnyOre || round > 0) { lastCode = lastCode ?? 'NO_TARGET'; break; }
            // 下到目标高度再扫一轮（用 goTo 走到本列更深的位置；走不到就认命）
            if (wantY != null && feetY(bot) > wantY) {
                const dest = {
                    x: Math.floor(bot.entity.position.x),
                    z: Math.floor(bot.entity.position.z),
                };
                const walked = await goTo(bot, { kind: 'point', posXZ: dest }, {
                    mapDir: mapDirOf(bot),
                    deadlineMs: Math.max(MIN_WAIT_BUDGET_MS, Math.min((ctx.deadline ?? Date.now() + DESCEND_WINDOW_MS) - Date.now(), DESCEND_BUDGET_MS)),
                    arriveTol: 2,
                });
                if (!walked.ok && walked.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
            }
            lastCode = 'NO_TARGET';
            break;
        }
        sawAnyOre = true;
        // ★ t78：`round` 打点补回来（第 24 跑 verify 报它丢了）——
        //   它是判断"有没有扫到树 / 人在不在正确高度"的关键
        trace('round', 'n=', round, 'ore=', ore, 'candidates=', candidates.length,
            'feetY=', Math.round(bot.entity.position.y), 'count=', countAll() - before, '/', want);

        // 按距离排序，逐个试
        const self = bot.entity.position;
        candidates.sort((a, b) => a.position.distanceTo(self) - b.position.distanceTo(self));

        for (const block of candidates.slice(0, 8)) {
            if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了', { ore, count: mined, want });
            if (countAll() - before >= want) break;

            // 挖不动就别试了（换方向/换工具是上层的事）
            if (!isDiggable(block)) continue;
            // ★ 三态判据（t21）：**"背包读不到"不等于"没有工具"**。
            //   真机踩过：造场地把她 entomb 了 → 窒息死亡 → 服务端清空背包 →
            //   items=[] → 旧代码直接报 NO_TOOL → 任务板按规则②判 blocked（终态）。
            //   但真相是"刚死、背包正在重建"，下一秒重试就好了。
            //   所以：unreadable → NOT_READY（可重试），只有真·没工具才报 NO_TOOL。
            const why = canDigReason(bot, block);
            if (why.why === 'unreadable') {
                return fail('NOT_READY', `背包暂时读不到（可能在死亡/重生重建中），过一会再试`, {
                    ore, block: block.name, count: mined, want,
                    // 不谎报：明确标记"这次的工具状态没能确认"
                    verified: false, reason: 'inventory-unreadable',
                });
            }
            if (!why.can) {
                return fail('NO_TOOL', `挖不动 ${block.name}（没有合适的镐）`, { ore, block: block.name, count: mined, want });
            }

            // 走近（够不着才走）
            const d = block.position.distanceTo(self);
            if (d > 4) {
                // ★★ 2026-11-03（t67）：**目标不能是方块自身** —— 那是实心格的内部，
                //   寻路器不可能站进去 → `NO_REACH`。
                //
                //   真机证据（verify 第 14 跑）：
                //     goTo false NO_REACH × 127
                //     [MINE] try d= 4.6 / 4.9 / 5.1 …  ← d>4 的全被跳过
                //     [MINE] try d= 1.2 / 2.5 / 3.5 …  ← d<=4 直接挖，成了 7 个
                //   → 只挖到 1/8，绝大多数块"够不着又走不过去"被跳过。
                //
                //   改成走到**方块旁边能站的那一格**（四邻里 air 且脚下实心）。
                const stand = findStandNear(bot, block.position);
                const walked = await goTo(bot, stand
                    ? { kind: 'point', pos: stand }
                    : { x: block.position.x, z: block.position.z }, {
                    mapDir: mapDirOf(bot),
                    deadlineMs: Math.max(MIN_WAIT_BUDGET_MS, Math.min((ctx.deadline ?? Date.now() + APPROACH_WINDOW_MS) - Date.now(), APPROACH_BUDGET_MS)),
                    arriveTol: 2,
                });
                if (!walked.ok) {
                    // ★ t72：常驻诊断（TRACE 守卫，默认零输出零开销）—— 见文件顶部的说明
                    trace('goTo', 'false', walked.code ?? '', '|', String(walked.message ?? '').slice(0, 100),
                        '| stand=', JSON.stringify(stand), 'bpos=', block.position.x, block.position.y, block.position.z);
                    if (walked.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了');
                    // ★★ 2026-11-04（t78）：**走不动 ≠ 够不着 —— 先重新量一次距离。**
                    //
                    //   真机证据（第 24 跑）：`NO_REACH ×139`，其中
                    //     「还差 5 格，最后原因 STUCK」×67
                    //     「还差 4 格，最后原因 STUCK」×36
                    //     「还差 6 格，最后原因 STUCK」×17
                    //   `stand` 全对（0 个 null）→ 落点没问题，是**走过去时被树叶/树干物理卡住**。
                    //
                    //   而循环的判据是 `if (d > 4) { goTo }` ——
                    //   **她本来离 8 格，`goTo` 已经把她带到 3-6 格了**，
                    //   这时 d 已经 ≤4（够得着！），可代码却直接 `continue` 跳过这一块，
                    //   于是"白走一趟 + 白丢一块"。
                    //
                    //   正确做法：**走不动就重新量距离，够得着就直接挖**。
                    //   够不着才真的换下一块（保持原来的 OUT_OF_REACH 语义）。
                    const dNow = block.position.distanceTo(bot.entity.position);
                    if (dNow <= 4) {
                        trace('goTo', 'stuck-but-in-reach', 'dNow=', dNow.toFixed(1), '→ 直接挖');
                        // 落到下面的 digBlock（不 continue）
                    } else {
                        lastCode = 'OUT_OF_REACH';            // 真够不着：换下一块
                        continue;
                    }
                } else {
                    trace('goTo', 'true', 'OK', '| stand=', JSON.stringify(stand));
                }
            }

            const dug = await digBlock(bot, { kind: 'block', pos: { x: block.position.x, y: block.position.y, z: block.position.z } });
            // ★ t78：`dig` 打点补回来（第 24 跑 verify 报它丢了）
            // ★ t79：把 `dug.message` 也打出来 —— 第 25 跑 `dig false INTERNAL ×5403`（d=1.2 够得着）
            //   但没打 message，看不到底层原因。`act_dig` 把 `holdDig` 的 error.message 原样带出来，
            //   那正是我们要的（例如 "goal was changed" / "block is not diggable" / 服务端取消）。
            trace('dig', dug.ok ? 'true' : 'false', dug.code ?? 'OK', block.name,
                'd=', block.position.distanceTo(bot.entity.position).toFixed(1),
                'mined=', mined, '/', want,
                '| err=', String(dug.message ?? '').slice(0, 120),
                '| dataErr=', String(dug.data?.error ?? '').slice(0, 120));
            if (dug.ok) {
                mined++;
                // ★★ 2026-11-04（t72）：**每挖一块就顺手捡，别攒到最后一次性捡。**
                //
                //   真机证据（第 20 跑）：
                //     «挖了 7 个 oak_log，但只捡到 2 个（掉落物没到手）»   ← 产品自己报的
                //     obtain:oak_log 因此只到 1/8 → 505 秒后 blocked
                //
                //   根因有两个，都是"攒到最后"造成的：
                //     ① **掉落物 5 分钟就消失** —— 这一趟跑了 505 秒（8.4 分钟），
                //        早期挖的早就没了；最后那次 collectDrops 只能捡到最近的两块。
                //     ② **她边走边挖，位置一直在变** —— 末尾那次 collectDrops 的
                //        `origin` 是"当时脚下的位置"，`radius: 10` 够不到远处掉的。
                //
                //   改成"挖一块、捡一块"：每块挖完就在**那一块的位置**附近捡，
                //   半径小（4）、预算短（2.5s）—— 不攒、不跨区、不超时。
                //   末尾那次仍然保留（兜底捡漏）。
                try {
                    if (countAll() - before < want) {
                        const g0 = countAll() - before;
                        await collectDrops(bot, { x: block.position.x, y: block.position.y, z: block.position.z }, {
                            countFn: () => countAll(),
                            radius: 4,
                            deadlineMs: Math.max(1500, Math.min((ctx.deadline ?? Date.now() + 2500) - Date.now(), 2500)),
                        });
                        trace('pickup', 'block=', block.name, 'gained', g0, '→', countAll() - before, '/', want);
                    }
                } catch { /* 捡不到就继续挖（末尾还有一次兜底） */ }
                continue;
            }

            if (dug.code === 'INTERRUPTED') return fail('INTERRUPTED', '被取消了', { ore, count: mined, want });
            if (dug.code === 'NO_TOOL') {
                return fail('NO_TOOL', dug.message ?? '挖不动', { ore, block: block.name, count: mined, want });
            }
            if (dug.code === 'OUT_OF_REACH') { lastCode = 'OUT_OF_REACH'; continue; }
            lastCode = dug.code ?? 'INTERNAL';
        }
    }

    // ★ 挖完必须**捡**（卡片原文："有就 digBlock + 捡"）。
    //
    // 2026-11-02 真机抽验抓到的 bug：原来只把 `mined`（digBlock 成功次数）当完成判据，
    // 挖下来的矿**掉在地上没捡**，背包 0→0，流程却报 `ok{mined:2}` —— 谎报成功。
    // 现在挖够数就先 collectDrops，再用**背包增量**作为真正的完成判据。
    let picked = false;
    if (mined >= want) {
        try {
            await collectDrops(bot, { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }, {
                countFn: () => countAll(),
                radius: 10,
                deadlineMs: Math.max(3000, Math.min((ctx.deadline ?? Date.now() + 10000) - Date.now(), 10000)),
            });
            picked = true;
        } catch { /* 捡不到就照实报（下面按背包增量判）*/ }
    }

    const gained = countAll() - before;
    // 完成判据：**背包真的多了**才算；`mined` 只作为"挖了几个"的附加信息带出去
    const done = gained;

    if (done >= want) {
        return ok({ ore, count: done, want, mined, gained, picked, costMs: Date.now() - t0 });
    }
    // 挖到了但没捡到（掉落物滚走了/被水冲了）：这是"挖到没拿到"，要如实说，
    // 不能拿 mined 冒充 count —— 上层看到 count 会以为背包里有了。
    if (mined >= want && gained < want) {
        return fail('NO_ITEM', `挖了 ${mined} 个 ${ore}，但只捡到 ${gained} 个（掉落物没到手）`, {
            ore, count: gained, want, mined, gained, picked, costMs: Date.now() - t0,
        });
    }

    // 没到够数：区分"根本没有矿" / "走不过去" / "太深了"
    if (!sawAnyOre || lastCode === 'NO_TARGET') {
        return fail('NO_TARGET', `附近没有 ${ore}`, { ore, count: done, want, mined, gained });
    }
    if (lastCode === 'OUT_OF_REACH') {
        return fail('OUT_OF_REACH', `${ore} 在那儿但过不去`, { ore, count: done, want, mined, gained });
    }
    // 太深 / 时间到 —— 卡片要求 TIMEOUT + {count, want}
    return fail('TIMEOUT', `挖到深度/时间上限，只挖到 ${done}/${want} 个 ${ore}`, {
        ore, count: done, want, mined, gained, startY, endY: feetY(bot), maxDepth, costMs: Date.now() - t0,
    });
}
