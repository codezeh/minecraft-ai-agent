/** t31：flow_shelter 离线用例（蓝图形状 / 材料判断 / 透传 build / idle_planner 接线）。 */
import { shelterBlueprint, shelterBuildOrder, capCell, isOutsideShelter, shelter, manifest } from '../src/agent/library/flow_shelter.js';
import { decideIdle, isIdle, IDLE } from '../src/agent/library/idle_planner.js';
import { CODES } from '../src/agent/library/contract.js';
import { SKILL_NAMES } from '../src/agent/library/composite_registry.js';
import { makeFakeBot } from './fixtures/fake_bot.mjs';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

// ① 蓝图默认形状（2026-11-03 缩小）：3×3、**1 层墙 + 顶 = 17 格**，中间留空
{
    // ★ 2026-11-03：屋顶正中**不在蓝图里**了 —— 它由 capCell() 单独"先出后封"。
    //   所以蓝图 = 墙 8 + 顶圈 8 = 16，另加 1 格正中 = 17。
    const bp = shelterBlueprint({ x: 0.5, y: 64, z: 0.5 }, 'cobblestone', 3, { floor: 'never' });
    const inner = bp.filter((b) => b.x === 0 && b.z === 0 && b.y === 64);
    const byY = bp.reduce((a, b) => { a[b.y] = (a[b.y] || 0) + 1; return a; }, {});
    const cap = capCell({ x: 0.5, y: 64, z: 0.5 });
    const capInBp = bp.some((b) => b.x === cap.x && b.y === cap.y && b.z === cap.z);
    // ★ 墙**2 层**（64/65）+ 顶圈(66) = 24；正中由 capCell 另封在 66。
    //   内空 cy..cy+1 都是空 → 她身高 1.8 放得下（1 层墙会把顶压在她头上，那是把人封死）。
    check('① 蓝图 = 墙2层16 + 顶圈8 = 24（capCell 另封正中），内空 2 格高放得下她',
        bp.length === 24 && inner.length === 0 && byY[64] === 8 && byY[65] === 8 && byY[66] === 8
        && !capInBp && cap.x === 0 && cap.y === 66 && cap.z === 0,
        `共${bp.length} 层=${JSON.stringify(byY)} cap=(${cap.x},${cap.y},${cap.z})`);
}

// ①b floor:'auto' 只在脚下不实心时补 1 块地板
{
    const air = shelterBlueprint({ x: 0.5, y: 64, z: 0.5 }, 'cobblestone', 3, { floor: 'auto', underBlockName: 'air' });
    const solid = shelterBlueprint({ x: 0.5, y: 64, z: 0.5 }, 'cobblestone', 3, { floor: 'auto', underBlockName: 'stone' });
    check('①b floor=auto：脚下是空气补 1 块；脚下已实心就不补',
        air.length === 25 && solid.length === 24, `air=${air.length} solid=${solid.length}`);
}

// ② 墙是完整外圈 8 格（封闭，不露天）
{
    const bp = shelterBlueprint({ x: 0.5, y: 64, z: 0.5 }, 'stone', 3, { floor: 'never' });
    const w1 = bp.filter((b) => b.y === 64).length;
    const w2 = bp.filter((b) => b.y === 65).length;
    const roof = bp.filter((b) => b.y === 66).length;
    check('② 墙两层各 8 格 + 顶圈 8 格（+正中另封 = 9，封闭不露天）',
        w1 === 8 && w2 === 8 && roof === 8, `墙${w1}/${w2} 顶圈${roof}`);
}

// ②b ★ capCell 指向屋顶正中（她头顶那列）—— 这就是"必须出门才能封"的那一格
{
    const cap = capCell({ x: 3.5, y: 70, z: -2.5 });
    check('②b ★ capCell 指向头顶列正中（墙2层之上，y+2）—— 必须出门才能封的那格',
        cap.x === 3 && cap.y === 72 && cap.z === -3, `cap=(${cap.x},${cap.y},${cap.z})`);
}

// ②c ★ "是否已出格"判定必须用 OR（真机抓到的我的逻辑 bug：用 AND 则永远为假）
{
    const cases = [
        [2, 0, true, '纯向东跳出（dz=0）→ 算出来了'],
        [0, 2, true, '纯向北跳出（dx=0）→ 算出来了'],
        [-2, 0, true, '纯向西'],
        [0, -2, true, '纯向南'],
        [1, 0, false, '还在屋里（墙在 ±1）'],
        [0, 0, false, '正中心'],
        [1, 1, false, '贴墙角仍算屋内'],
    ];
    const wrong = cases.filter(([x, z, exp]) => isOutsideShelter(x, z, 0, 0) !== exp);
    check('②c ★ isOutsideShelter 用 OR：（纯单方向跳出也算出格，否则 holdKey 永远等不到）',
        wrong.length === 0, `${cases.length} 组全对`);
}

// ═══ ★★ 几何断言（用户要求：先离线证明顺序，别上真机才发现）═══
{
    const feet = { x: 0.5, y: 64, z: 0.5 };
    const order = shelterBuildOrder(feet, 'cobblestone', 3, { floor: 'never' });
    const cx = 0, cy = 64, cz = 0;

    // 她可能站的合法位置：正中 + 内空（3×3 内空只有正中 1 格）
    const bodyColumns = [[cx, cz]];                    // 身体列 = 正中
    const onBodyColumn = (b) => bodyColumns.some(([x, z]) => b.x === x && b.z === z);

    // ① wall2 / roofRing 的 pos **不在**任何合法站位的身体列上
    const risky = order.filter((b) => ['wall2', 'roofRing'].includes(b.phase))
        .filter(onBodyColumn);
    check('★① wall2 / roofRing 都不在她身体列上（所以她能在屋里先放完）',
        risky.length === 0, risky.length ? JSON.stringify(risky) : `${order.filter(b => ['wall2','roofRing'].includes(b.phase)).length} 块全部安全`);

    // ② cap 的 pos **在**正中列（所以必须最后放、且人在屋外）
    const cap = order.find((b) => b.phase === 'cap');
    const capInCenter = cap && cap.x === cx && cap.z === cz && cap.y === cy + 2;
    check('★② cap 在正中列（y+2）→ 必须最后放、且必须人在屋外',
        !!capInCenter, cap ? `cap=(${cap.x},${cap.y},${cap.z})` : '(无 cap)');

    // ③ sealDoor 的 pos **不在**正中列（所以能在屋里放）
    const door = order.filter((b) => b.phase === 'sealDoor');
    const doorOk = door.length === 2 && door.every((b) => !onBodyColumn(b));
    check('★③ sealDoor 不在正中列（横向 ±1）→ 能在屋里从里面封',
        doorOk, door.map((b) => `(${b.x},${b.y},${b.z})`).join(' '));

    // ④ 总数对得上、无重复无缺
    const byPhase = order.reduce((a, b) => { a[b.phase] = (a[b.phase] || 0) + 1; return a; }, {});
    const keys = new Set(order.map((b) => `${b.x},${b.y},${b.z}`));
    const noDup = keys.size === order.length;
    check('★④ 总数 25 = wall1·7 + wall2·7 + roofRing·8 + cap·1 + sealDoor·2，且无重复',
        order.length === 25 && byPhase.wall1 === 7 && byPhase.wall2 === 7
        && byPhase.roofRing === 8 && byPhase.cap === 1 && byPhase.sealDoor === 2 && noDup,
        `共${order.length} ${JSON.stringify(byPhase)} 无重复=${noDup}`);
}

// ★⑤ 内空高度：cy 与 cy+1 都必须没有方块（她身高 1.8，少一层就是活埋）
{
    const order = shelterBuildOrder({ x: 0.5, y: 64, z: 0.5 }, 'cobblestone', 3, { floor: 'never' });
    const inBody = order.filter((b) => b.x === 0 && b.z === 0 && (b.y === 64 || b.y === 65));
    check('★⑤ 内空 cy/cy+1 两格都没有方块（墙必须 2 层，1 层=把她压头上）',
        inBody.length === 0, inBody.length ? JSON.stringify(inBody) : '两格都空');
}

// ③ manifest 合法：level=flow，codes 全已注册
{
    const codesOk = (manifest.codes ?? []).every((c) => c === 'OK' || CODES.includes(c));
    check('③ manifest level=flow 且 codes 全已注册', manifest.level === 'flow' && codesOk,
        `name=${manifest.name} level=${manifest.level}`);
}

// ④ 没有材料 → NO_ITEM（并给出缺什么）
{
    // 脚下要读得到（否则先撞 NO_TARGET，测不到材料判断）
    const bot = makeFakeBot({
        items: [{ name: 'stick', type: 1, count: 4, slot: 0 }],
        stubs: { blockAt: (v) => ({ name: 'stone', position: v }) },
    });
    bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } };
    const r = await shelter(bot, {});
    check('④ 没有建筑材料 → NO_ITEM', !r.ok && r.code === 'NO_ITEM', r.code);
}

// ⑤ 脚下这一格：**未加载 / 虚空 / 水** 是三件不同的事，必须报三个不同的码
//
// ★ 为什么这条测试被改过（t36，2026-11-03）：原来只有一条
//     check('⑤ 脚下读不到 → NO_TARGET（不在虚空搭屋子）', ... blockAt:()=>null)
//   它想验的是"不在虚空搭屋子"，但用 `blockAt` 返回 **null** 来模拟"虚空"——
//   这两件事在 CODES 里是分开的：
//     null  = 那格**还没加载** → `NO_DATA`（走近/等加载，可重试）
//     air   = 读得到、但**站不住** → `NO_TARGET`（换地方搭）
//   更严重的是：它掩盖了一个真 bug —— 生产代码当时只有 `if (!below)`，
//   只挡 null；脚下真是 air 时会**一路往下走，在虚空里搭屋子**。
//   改判据的权威依据是 `contract.js` 的 `CODES` 定义（NO_DATA = 目标格未加载，读不到方块），
//   不是"为了让这条变绿而放宽断言" —— 反而把覆盖**变细**了（a/b/c 三种）。
{
    // ⑤a 区块未加载（blockAt 返回 null）→ NO_DATA
    const bot = makeFakeBot({ items: [{ name: 'cobblestone', type: 1, count: 64, slot: 0 }], stubs: { blockAt: () => null } });
    bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } };
    const r = await shelter(bot, {});
    check('⑤a 脚下那格读不到（未加载）→ NO_DATA', !r.ok && r.code === 'NO_DATA', r.code);
}
{
    // ⑤b 脚下是真空气/虚空 → NO_TARGET（不在虚空搭屋子）
    const bot = makeFakeBot({ items: [{ name: 'cobblestone', type: 1, count: 64, slot: 0 }], stubs: { blockAt: () => ({ name: 'air', position: { x: 0, y: 63, z: 0 } }) } });
    bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } };
    const r = await shelter(bot, {});
    check('⑤b 脚下是空气 → NO_TARGET（不在虚空搭屋子）', !r.ok && r.code === 'NO_TARGET', r.code);
}
{
    // ⑤c 脚下是水 → NO_TARGET（水上不搭）
    const bot = makeFakeBot({ items: [{ name: 'cobblestone', type: 1, count: 64, slot: 0 }], stubs: { blockAt: () => ({ name: 'water', position: { x: 0, y: 63, z: 0 } }) } });
    bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } };
    const r = await shelter(bot, {});
    check('⑤c 脚下是水 → NO_TARGET', !r.ok && r.code === 'NO_TARGET', r.code);
}

// ⑥ 中断优先
{
    const bot = makeFakeBot({});
    bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } };
    bot.interrupt_code = 'stop';
    const r = await shelter(bot, {});
    check('⑥ 被取消 → INTERRUPTED', !r.ok && r.code === 'INTERRUPTED', r.code);
}

// ⑦ ★ idle_planner 死分支接上了：注册表里有 shelter → 天黑无遮蔽会派 shelter 单
{
    const v = decideIdle({ now: 1e6, nightFalling: true, nearShelter: false, availableSkills: SKILL_NAMES });
    check('⑦ ★ idle_planner"天黑没地方待→shelter"不再是死分支（注册表已含 shelter）',
        SKILL_NAMES.includes('shelter') && v.action === 'job' && v.job?.skill === 'shelter',
        `action=${v.action} skill=${v.job?.skill} reason=${v.reason}`);
}

// ⑧ 反向：注册表里没有 shelter 时**确实跳过**（证明⑦不是假绿）
{
    const withoutShelter = SKILL_NAMES.filter((n) => n !== 'shelter');
    const v = decideIdle({ now: 1e6, nightFalling: true, nearShelter: false, availableSkills: withoutShelter });
    check('⑧ 反向验证：没有 shelter 时会跳过（⑦不是假绿）', v.action !== 'job' || v.job?.skill !== 'shelter', v.action);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
