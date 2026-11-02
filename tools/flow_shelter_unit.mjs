/** t31：flow_shelter 离线用例（蓝图形状 / 材料判断 / 透传 build / idle_planner 接线）。 */
import { shelterBlueprint, capCell, isOutsideShelter, shelter, manifest } from '../src/agent/library/flow_shelter.js';
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

// ⑤ 读不到脚下 → NO_TARGET（不会在虚空里搭）
{
    const bot = makeFakeBot({ items: [{ name: 'cobblestone', type: 1, count: 64, slot: 0 }], stubs: { blockAt: () => null } });
    bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } };
    const r = await shelter(bot, {});
    check('⑤ 脚下读不到 → NO_TARGET（不在虚空搭屋子）', !r.ok && r.code === 'NO_TARGET', r.code);
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
