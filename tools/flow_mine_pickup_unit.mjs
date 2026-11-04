/**
 * `flow_mine` 的「挖一块捡一块」（t72）离线回归 —— 不需要服务器。
 *
 * 真机背景（第 20 跑，产品自己报出来的）：
 *   «挖了 7 个 oak_log，但只捡到 2 个（掉落物没到手）» → `obtain:oak_log` 只到 1/8 → 505 秒后 blocked。
 * 根因两条，都是"攒到最后一次性捡"造成的：
 *   ① 掉落物**5 分钟就消失** —— 那一趟 505 秒，早期挖的早没了（`fa275cc`）
 *   ② 她边走边挖、位置一直在变 —— 末尾那次 collectDrops 的 origin 是"当时脚下"，
 *      `radius: 10` 够不到远处掉的
 * 修法：**每挖一块就在那一块的位置附近捡**（radius 4、预算 2.5s），末尾那次保留兜底。
 *
 * ── 怎么在"不许改 src"的前提下测它 ──────────────────────────────────────
 *   ① **端到端**：跑**真 `mine()`**，观察点取 `bot.clearControlStates` 的调用次数 ——
 *      全仓只有 `flow_pickup.collectDrops` 会调它（`flow_pickup.js:117`），
 *      所以它就是"collectDrops 被调了几次"的**忠实计数器**。
 *   ② **源码级结构守卫**：断言 t72 那段代码**存在**且**紧接在 `if (dug.ok) {` 分支的
 *      `continue;` 之前** —— 谁把它删了/注释了，这条立刻红。
 *   ③ **行为差分**：把那段代码从源码里**取出来编译**，用打桩的 collectDrops 驱动：
 *      正常 → 3 次；把取出的块"注释掉" → 0 次。证明"看调用次数"这个观察点
 *      确实对那段代码的**有无**敏感（不敏感的话用例就是假的）。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import Vec3 from 'vec3';
import { makeFakeBot, assertPointLike, worldOf, realRegistry } from './fixtures/fake_bot.mjs';
import { mine } from '../src/agent/library/flow_mine.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const SRC = readFileSync('src/agent/library/flow_mine.js', 'utf8');

// ══════════════════════════════════════════════════════════════════════════
// ① 端到端：真 mine()，数 collectDrops 的调用次数
// ══════════════════════════════════════════════════════════════════════════

/**
 * 造"有 N 块矿 + 有一把镐"的假 bot。
 * @param {object} o  { ores, dropsLand, onCollect }
 *   dropsLand=true  → 挖下就把产物放进背包（正常情形）
 *   dropsLand=false → **挖下但没捡到**（真机 ① ：掉落物丢了/过期了）
 */
function mineBot({ ores = 3, dropsLand = false, onCollect = null } = {}) {
    const world = new Map();
    for (let i = 0; i < ores; i++) {
        world.set(`${i + 1},16,0`, {
            name: 'iron_ore', position: { x: i + 1, y: 16, z: 0, distanceTo: () => 1 },
            diggable: true, canHarvest: () => true, harvestTools: { 877: true }, digTime: () => 10,
        });
    }
    const bot = makeFakeBot({
        feet: { x: 0, y: 16, z: 0 },
        items: [{ name: 'iron_pickaxe', type: 892, count: 1, slot: 36, maxDurability: 250, durabilityUsed: 0 }],
        registry: {
            blocksByName: { iron_ore: { id: 15 } },
            itemsByName: { iron_pickaxe: { id: 892 }, raw_iron: { id: 867 } },
        },
        stubs: {
            // ★ t68：findBlocks 返回 **Vec3**（真 mineflayer 如此；query_perceive 会直接喂给 blockAt）
            findBlocks: () => [...world.keys()].map((k) => k.split(',').map(Number))
                .map(([x, y, z]) => new Vec3(x, y, z)),
            blockAt: (v) => {
                // ★ t68：**严格守卫**（与夹具/真 mineflayer 同一条判据）。
                //   为什么保留自己的方块形状而不整换夹具：这里的方块带着
                //   `digTime()/harvestTools`（`mine()` 判断"挖得动/挖多久"要用），
                //   夹具的方块没有这两样 —— 整换会让 dig 走另一条路（实测 TIMEOUT）。
                //   但**坐标形状必须一样挑剔**：否则 `mine()` 内部传裸对象（t70 家族）
                //   在本文件里永远看不见。
                assertPointLike(v);
                const k = `${Math.floor(v?.x ?? 0)},${Math.floor(v?.y ?? 0)},${Math.floor(v?.z ?? 0)}`;
                return world.get(k) ?? { name: 'air', position: v };
            },
            dig: async (b) => {
                const k = `${b.position.x},${b.position.y},${b.position.z}`;
                if (!world.has(k)) return;
                world.delete(k);
                if (!dropsLand) return;                     // ← 挖了，但掉落物没进包
                const cur = bot.inventory.slots.find((i) => i.name === 'raw_iron');
                if (cur) cur.count += 1;
                else bot.inventory.slots.push({ name: 'raw_iron', type: 867, count: 1, slot: 37 });
            },
            // ★ 计数器：只有 flow_pickup.collectDrops 会调 clearControlStates
            // ★ 计数口径修正：`holdDig` 也会调 clearControlStates（挖前静默），
            //   它带 `__silencingForDig` 标记 → 排除掉，只数 collectDrops 自己的调用。
            //   （原口径"只有 collectDrops 会调它"已被 t80/t82 打破 —— 借副作用当计数器是脆的）
            clearControlStates: () => {
                if (bot.__silencingForDig) return;
                bot.__collectCalls++; onCollect?.(bot.__collectCalls);
            },
        },
    });
    bot.__collectCalls = 0;
    // ══════════════════════════════════════════════════════════════════════
    // ★★ t74：**主观测点换成 `findDrops` 的入口**，不再靠 `clearControlStates`。
    //
    //   为什么换：`clearControlStates` 是**别人（collectDrops）的副作用**，
    //   借它数自己 = 脆的判据。今晚已被证伪两次：
    //     · t82 在 collectDrops 里加无条件静默 → 计数 3→6
    //     · t80 `holdDig` 也开始调它 → 只能靠 `__silencingForDig` 打补丁排除
    //   （上面那段"计数口径修正"就是补丁的痕迹 —— 补丁会越打越多）
    //
    //   新观测点：`query_drops.findDrops()` 的第一行就是 `Object.values(bot.entities ?? {})`
    //   → 给 `bot.entities` 装 getter，"被读一次" = "collectDrops 真的去找了一次掉落物"。
    //   这是它的**必要路径**（不读 entities 就找不到掉落物），比"某副作用被调"稳定。
    // ══════════════════════════════════════════════════════════════════════
    bot.__findDropsCalls = 0;
    Object.defineProperty(bot, 'entities', {
        configurable: true,
        get() { bot.__findDropsCalls++; return {}; },   // 空实体表：没有掉落物可捡
    });
    return bot;
}

// 1. ★ 核心用例：挖 3 块、掉落物一个都没捡到 → 每块后都要调 collectDrops
{
    const bot = mineBot({ ores: 3, dropsLand: false });
    const r = await mine(bot, 'iron', 3, { ctx: { deadline: Date.now() + 20000 } });
    // 3 块各一次（每块后）+ 末尾兜底一次 = 4；至少必须 ≥3（"每块后都调"）
    // ★ t74：主判据看 `findDrops` 调用次数（稳）；旧的 __collectCalls 只做交叉验证
    const perBlockOk = bot.__findDropsCalls >= 3 && bot.__collectCalls >= 3;
    check('① 挖 3 块、掉落物没进包 → 每块后都调 collectDrops（calls ≥ 3，不是只在最后调一次）',
        perBlockOk, `findDrops ${bot.__findDropsCalls} 次 / 旧计数器 ${bot.__collectCalls} 次（期望各 ≥3）code=${r.code}`);
}

// 2. 正常情形（挖一块就进包）：够数以后不再白捡，但仍然"每块后都试过"
{
    const bot = mineBot({ ores: 3, dropsLand: true });
    const r = await mine(bot, 'iron', 3, { ctx: { deadline: Date.now() + 20000 } });
    // 挖第 1 块后 1<3 → 调；第 2 块后 2<3 → 调；第 3 块后 3<3 不成立 → 跳过；末尾兜底 1 次 → 共 3
    check('② 掉落物真的进包时：每块后按"还差多少"决定捡不捡（共 3 次 = 2 次/块 + 1 次兜底）',
        bot.__findDropsCalls === 3 && bot.__collectCalls === 3 && r.ok === true,
        `findDrops=${bot.__findDropsCalls} 旧计数=${bot.__collectCalls} code=${r.code}`);
}

// 3. 一块都没挖成（没有矿）→ 不该有"每块后"的调用（只有末尾可能 0 次，因为 mined<want）
{
    const bot = mineBot({ ores: 0, dropsLand: false });
    const r = await mine(bot, 'iron', 2, { ctx: { deadline: Date.now() + 5000 } });
    check('③ 附近没矿 → 不会产生"每块后"的 collectDrops（守卫不是无条件乱调）',
        bot.__findDropsCalls === 0 && bot.__collectCalls === 0,
        `findDrops=${bot.__findDropsCalls} 旧计数=${bot.__collectCalls} code=${r.code}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ② 源码级结构守卫：t72 那段必须**还在**，且**紧接 `if (dug.ok)` 分支的 continue**
//    （删掉/注释掉 → 本条红；这是"改动被抹掉"的探测器）
// ══════════════════════════════════════════════════════════════════════════
function extractPickupBlock(src) {
    const anchor = src.indexOf('改成"挖一块、捡一块"');
    if (anchor < 0) return null;
    const tryIdx = src.indexOf('try {', anchor);
    if (tryIdx < 0) return null;
    const contIdx = src.indexOf('continue;', tryIdx);
    if (contIdx < 0) return null;
    return src.slice(tryIdx, contIdx);
}
const PICKUP_BLOCK = extractPickupBlock(SRC);
{
    const ok = !!PICKUP_BLOCK
        && /countAll\(\)\s*-\s*before\s*<\s*want/.test(PICKUP_BLOCK)      // 还是"还差才捡"
        && /await collectDrops\(bot,\s*\{[^}]*block\.position/.test(PICKUP_BLOCK)  // 在**那一块的位置**捡
        && /radius:\s*4/.test(PICKUP_BLOCK)                               // 半径 4（不跨区）
        && !/^\s*\/\//.test(PICKUP_BLOCK.trim());                          // 没有被注释掉
    check('② 源码级守卫：t72「挖一块捡一块」那段还在，且是在方块位置 radius:4 捡（不是攒到最后）',
        ok, ok ? '' : `block=${PICKUP_BLOCK ? PICKUP_BLOCK.length + ' chars' : 'null'}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 行为差分：证明"数 collectDrops 调用次数"这个观察点对那段代码的**有无**敏感
//    把取出的块编译成一个 async 函数（collectDrops/countAll/trace 全部打桩注入），
//    正常块 → 3 次；把块换成"注释掉"（空实现）→ 0 次。
// ══════════════════════════════════════════════════════════════════════════
{
    // ★ 注意：把块"注释掉"时**不能**让包裹用的 `})();` 落在注释里 ——
    //   所以这里 trimEnd() 之后再拼，并且把收尾放在**单独一行**。
    const compileBlock = (blockText) => new Function(
        'bot', 'block', 'before', 'want', 'countAll', 'collectDrops', 'trace', 'ctx',
        `return (async () => {\n${String(blockText).trimEnd()}\n})();`,
    );

    // 3 块、掉落物永不进包 → 每次调用都该触发一段 collectDrops
    const drive = async (blockText) => {
        let calls = 0;
        const run = compileBlock(blockText);
        for (let i = 0; i < 3; i++) {
            await run(
                { },                                   // bot（块里没用 bot 的成员，collectDrops 是桩）
                { name: 'iron_ore', position: { x: i, y: 16, z: 0 } },
                0,                                     // before
                3,                                     // want
                () => 0,                               // countAll：始终 0 → 永远"还差"
                async () => { calls++; },              // collectDrops 桩
                () => { },                             // trace
                { deadline: Date.now() + 5000 },
            );
        }
        return calls;
    };

    const normalCalls = PICKUP_BLOCK ? await drive(PICKUP_BLOCK) : -1;
    const commentedOut = PICKUP_BLOCK
        ? await drive(PICKUP_BLOCK.trimEnd().split('\n').map((l) => `// ${l}`).join('\n'))
        : -1;

    check('③-1 行为差分（正常）：3 块 → 3 次 collectDrops', normalCalls === 3, `calls=${normalCalls}`);
    check('③-2 反向验证：把这段**注释掉** → 0 次（证明"数调用次数"确实能抓到这段的缺失）',
        commentedOut === 0, `calls=${commentedOut}`);
    check('③-3 上面两条合起来 = 用例① 的判据（≥3）在"那段被删掉"时必然变红',
        normalCalls === 3 && commentedOut === 0, `normal=${normalCalls} removed=${commentedOut}`);
}

// ── ③-4 ★ t74：把"那段在不在" × "**真 collectDrops** × **新观测点(findDrops)**" 交叉验证 ──
//   前三条用的是打桩的 collectDrops（数的是桩自己被调几次）；这条换成**真的 collectDrops**，
//   于是计数变成"findDrops 真被读了几次" —— 这才是新观测点。
//   预期：那段在 → 3；那段被注释掉 → 0。
{
    const { collectDrops } = await import('../src/agent/library/flow_pickup.js');
    // 注意：`new Function('collectDrops', 'return (...)')` 才是"把 collectDrops 注入进去"；
    //   早前写成 `new Function(一系列参数, body)(collectFn)` —— 那个 `(collectFn)` 是**调用**，
    //   把 collectFn 绑定到了第一个参数 `bot` 上，导致块里的 collectDrops 是 undefined
    //   → 被块自己的 try/catch 吞掉 → 计数 0（一个"看起来像产品没调用"的假象）。
    const compileWith = (blockText, collectFn) => new Function(
        'collectDrops',
        'return (async (bot, block, before, want, countAll, trace, ctx) => {\n'
        + String(blockText).trimEnd() + '\n});',
    )(collectFn);

    const driveReal = async (blockText) => {
        const b = makeFakeBot({ feet: { x: 0, y: 16, z: 0 }, registry: realRegistry(), world: worldOf([]), unloaded: 'air' });
        b.__findDropsCalls = 0;
        Object.defineProperty(b, 'entities', { configurable: true, get() { b.__findDropsCalls++; return {}; } });
        const run = compileWith(blockText, (bot2, origin, opts) => collectDrops(bot2, origin, { ...opts, deadlineMs: 3000 }));
        for (let i = 0; i < 3; i++) {
            await run(b, { name: 'iron_ore', position: { x: i, y: 16, z: 0 } }, 0, 3, () => 0, null, () => {}, { deadline: Date.now() + 12000 });
        }
        return b.__findDropsCalls;
    };

    const on = PICKUP_BLOCK ? await driveReal(PICKUP_BLOCK) : -1;
    const off = PICKUP_BLOCK
        ? await driveReal(PICKUP_BLOCK.trimEnd().split('\n').map((l) => '// ' + l).join('\n'))
        : -1;
    check('③-4 真 collectDrops + 新观测点：那段在 → findDrops 3 次；注释掉 → 0 次（用例① 会红）',
        on === 3 && off === 0, `在=${on} 注释掉=${off}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ④ ★★ 观测点自检（t74）：证明"数 findDrops"这个**观测点本身**是活的
//
//   换了观测点之后必须证明它真会动、也会不动 —— 否则又是一个"装了但没人验证会挡"的闸。
//   这里直接调 `collectDrops`（绕过 mine()）：
//     a) 正常调用 → 必须真的去找掉落物（`__findDropsCalls` ≥ 1）
//     b) 一进来就被中断 → **不该去找**（= 0）→ 证明计数不是"进来就 +1"的假信号
// ══════════════════════════════════════════════════════════════════════════
{
    const { collectDrops } = await import('../src/agent/library/flow_pickup.js');

    // 注意：collectDrops 找不到掉落物时会走到"踩一脚/走位"分支 → 需要**完整 registry**
    // （pathfinder 的 Movements 会读 blocksByName 一堆）。所以这里用 realRegistry()。
    const botA = makeFakeBot({ feet: { x: 0, y: 16, z: 0 }, registry: realRegistry(), world: worldOf([]), unloaded: 'air' });
    botA.__findDropsCalls = 0;
    Object.defineProperty(botA, 'entities', { configurable: true, get() { botA.__findDropsCalls++; return {}; } });
    // deadline 要够长：collectDrops 第 1 步是"原地静默 ~400ms"，之后才去 findDrops
    await collectDrops(botA, { x: 0, y: 16, z: 0 }, { countFn: () => 0, radius: 4, deadlineMs: 3000 });
    check('④-a 观测点自检：collectDrops 正常调用 → findDrops 真的被调用（计数是活的）',
        botA.__findDropsCalls >= 1, `calls=${botA.__findDropsCalls}`);

    const botB = makeFakeBot({ feet: { x: 0, y: 16, z: 0 }, registry: realRegistry(), world: worldOf([]), unloaded: 'air' });
    botB.__findDropsCalls = 0;
    Object.defineProperty(botB, 'entities', { configurable: true, get() { botB.__findDropsCalls++; return {}; } });
    botB.interrupt_code = 'USER_STOP';
    const rB = await collectDrops(botB, { x: 0, y: 16, z: 0 }, { countFn: () => 0, radius: 4, deadlineMs: 300 });
    check('④-b 观测点自检：被中断时不去找（计数不是"进来就 +1"的假信号）',
        rB.code === 'INTERRUPTED' && botB.__findDropsCalls === 0, `code=${rB.code} calls=${botB.__findDropsCalls}`);
}

console.log(`${pass}/${pass + fail} 个用例通过  （产品文件未改动）`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
