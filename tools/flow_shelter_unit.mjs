/** t31：flow_shelter 离线用例（蓝图形状 / 材料判断 / 透传 build / idle_planner 接线）。 */
import { shelterBlueprint, shelter, manifest } from '../src/agent/library/flow_shelter.js';
import { decideIdle, isIdle, IDLE } from '../src/agent/library/idle_planner.js';
import { CODES } from '../src/agent/library/contract.js';
import { SKILL_NAMES } from '../src/agent/library/composite_registry.js';
import { makeFakeBot } from './fixtures/fake_bot.mjs';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

// ① 蓝图形状：3×3 封闭壳，中间两格留空（她要站里面）
{
    const bp = shelterBlueprint({ x: 0.5, y: 64, z: 0.5 }, 'cobblestone', 1);
    const inner = bp.filter((b) => b.x === 0 && b.z === 0 && (b.y === 64 || b.y === 65));
    const byY = bp.reduce((a, b) => { a[b.y] = (a[b.y] || 0) + 1; return a; }, {});
    check('① 蓝图 = 地板9+墙8+8+顶9=34，中间两格留空（能站人）',
        bp.length === 34 && inner.length === 0 && byY[63] === 9 && byY[66] === 9,
        `共${bp.length} 层分布=${JSON.stringify(byY)} 中空=${inner.length}`);
}

// ② 整圈墙连通：外圈每层 8 格
{
    const bp = shelterBlueprint({ x: 0.5, y: 64, z: 0.5 }, 'stone', 1);
    const wall64 = bp.filter((b) => b.y === 64).length;
    const wall65 = bp.filter((b) => b.y === 65).length;
    check('② 两层墙都是外圈 8 格（封闭，不露天）', wall64 === 8 && wall65 === 8, `${wall64}/${wall65}`);
}

// ②b ★ 屋顶正中**最后放**（这样条件 C 的"4 邻已落地"必然成立，才能封顶）
{
    const bp = shelterBlueprint({ x: 0.5, y: 64, z: 0.5 }, 'cobblestone', 1);
    const roof = bp.filter((b) => b.y === 66);
    const last = roof[roof.length - 1];
    const centerIsLast = last.x === 0 && last.z === 0;
    const othersFirst = roof.slice(0, -1).every((b) => !(b.x === 0 && b.z === 0));
    check('②b ★ 屋顶正中最后放（保证 4 邻已落地 → 条件 C 成立 → 能封顶）',
        centerIsLast && othersFirst && roof.length === 9,
        `最后一块=(${last.x},${last.z}) 顶层 ${roof.length} 块`);
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
