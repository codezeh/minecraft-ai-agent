/**
 * t40：executor 的 dig 分支 —— **邻列横向钻洞**（脚位格必须被挖掉）。
 *
 * 背景（t40 打点定位）：executor 的 dig 循环 `let y = Math.floor(p.y)`，
 * 只挖 `blockAt(bx, y+1, bz)` —— **从不挖 y 本身**（她脚位那格）。
 * 于是"邻列横向挖隧道"永远开不出人形通道（她身高 1.8，需要 2 格高）。
 * 真机表现：dig-through 挖 4 格却 NO_PATH。
 *
 * 三条用例（captain 要求先加用例再改）：
 *  ① 邻列 dig：脚位格 + 上面一格都必须被挖掉
 *  ② 同列 dig 回归：语义不变（往上挖天花板，**不挖自己脚位**）
 *  ③ 假成功守卫：邻列挖完脚位格仍不是空气 → **必须返回失败**，不许 ok({dug:0})
 */
import { execStep } from '../src/agent/library/executor.js';
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';
import Vec3 from 'vec3';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

const PICK = { name: 'diamond_pickaxe', type: 1, count: 1, slot: 0 };

function botAt(x, y, z, extra = {}) {
    const bot = makeFakeBot({
        items: [PICK],
        world: worldOf(extra.world ?? []),
        // ★ 2026-11-03（t46）：邻列 dig 挖通后 executor 会调 `stepInto` 真的走进隧道。
        //   假件默认"只记录不移动" → stepInto 必然超时 → 这些用例会假红。
        //   打开可选的"走一格"模拟（只模拟水平相邻一格，不做物理/跳跃）。
        walkOnForward: true,
        ...(extra.opts ?? {}),
    });
    // ★ 2026-11-03（t46）：原来这里是 `new Vec3(x, y, z)` —— **整数坐标不是她真实的位置**。
    //   真机 bot 永远站在**格心**（x/z 带 .5）。放整数会让"到隔壁一格"的距离算成
    //   hypot(1.5, 0.5)=1.58 > STEP_ADJACENT_MAX(1.5) → stepInto 报"不是相邻一格"，
    //   于是"挖开通道后走进去"在假件里必然失败（假红）。
    bot.entity.position = new Vec3(x + 0.5, y, z + 0.5);
    return bot;
}

const nameAt = (bot, x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z), false);
    return b?.name ?? null;
};

// 一面 5 格高的墙在 x=1 列（她站在 x=0，脚位 y=-60）
const WALL = [
    { x: 1, y: -61, z: 0, name: 'stone' },   // 墙下的地面
    { x: 1, y: -60, z: 0, name: 'stone' },   // ★ 脚位那格（关键）
    { x: 1, y: -59, z: 0, name: 'stone' },   // 头那格
    { x: 1, y: -58, z: 0, name: 'stone' },
    { x: 1, y: -57, z: 0, name: 'stone' },
    { x: 1, y: -56, z: 0, name: 'stone' },   // 墙顶（path_3d 现在就把边打到这）
];

// ① 邻列 dig：脚位格 + 头格都要挖掉
{
    const bot = botAt(0, -60, 0, { world: WALL });
    // path_3d 现在生成的边：目标列 x=1、面位 y=-56（墙顶）
    const r = await execStep(bot, { action: 'dig', x: 1, y: -56, z: 0 }, { onEvent: () => { } });
    const feetAfter = nameAt(bot, 1, -60, 0);
    const headAfter = nameAt(bot, 1, -59, 0);
    check('① 邻列 dig：脚位格(-60) 与头格(-59) 都被挖掉（开出人形通道）',
        r.ok && feetAfter === 'air' && headAfter === 'air',
        `ok=${r.ok} 脚位格=${feetAfter} 头格=${headAfter}`);
}

// ② 同列 dig 回归：往上挖天花板，**不许挖自己脚位那格**
{
    const bot = botAt(0, -60, 0, {
        world: [
            { x: 0, y: -60, z: 0, name: 'stone' },   // 自己脚位（不该被挖）
            { x: 0, y: -59, z: 0, name: 'stone' },   // 头顶（该挖）
            { x: 0, y: -58, z: 0, name: 'stone' },   // 再上（该挖）
        ],
    });
    const r = await execStep(bot, { action: 'dig', x: 0, y: -60, z: 0 }, { onEvent: () => { } });
    const feetAfter = nameAt(bot, 0, -60, 0);
    const headAfter = nameAt(bot, 0, -59, 0);
    check('② 同列 dig 回归：挖掉头顶(-59)、**不挖自己脚位(-60)**（语义与改前一致）',
        feetAfter === 'stone' && headAfter === 'air',
        `脚位格=${feetAfter}（应 stone） 头格=${headAfter}（应 air） ok=${r.ok}`);
}

// ③ ★ 假成功守卫：**循环一次都没跑**时（step.y 使 targetY <= 脚位），
//    旧代码直接 `return ok({dug:0})` = 假成功。脚位格还是实心，必须报失败。
{
    const bot = botAt(0, -60, 0, { world: WALL });
    // step.y = -61 → targetFeetY = -60，while(-60 < -60) 不成立 → dug=0
    const r = await execStep(bot, { action: 'dig', x: 1, y: -61, z: 0 }, { onEvent: () => { } });
    const feetAfter = nameAt(bot, 1, -60, 0);
    check('③ ★ 假成功守卫：邻列一步没挖、脚位格仍 stone → 必须失败（旧代码 ok({dug:0})）',
        r.ok === false,
        `ok=${r.ok} code=${r.code ?? "-"} 脚位格=${feetAfter} msg=${r.message ?? ""}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
