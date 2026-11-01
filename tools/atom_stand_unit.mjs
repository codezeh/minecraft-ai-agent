/**
 * atom_stand 离线回归（D27）—— 不需要服务器。
 *
 * 缺陷原貌：`PASSABLE` 里有 `lava`，canStand 只查"脚位/头位可穿过 + 下方有支撑"，
 * 于是脚位或头位是岩浆、下方是石头的格子被判成能站；findStandSpot 直接用这个结论选站位。
 * （下方是岩浆本来就判不能站：NO_SUPPORT 里有 lava。）
 *
 * 真机验收另见 tools/atom_stand.mjs（测试服 25566）。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { canStand, findStandSpot } from '../src/agent/library/atom_stand.js';
import { makeFakeBot } from './fixtures/fake_bot.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/** 假 bot（公共夹具）：world 是 Map<"x,y,z", 方块名>，没登记的格子返回 null（= 未加载）。 */
function fakeBot(world, feet = { x: 0, y: 64, z: 0 }) {
    return makeFakeBot({ world, feet, posOffset: 0.5 });
}

/** 一根竖列：下方 / 脚位 / 头位 */
function column(below, feet, head) {
    return new Map([['5,63,5', below], ['5,64,5', feet], ['5,65,5', head]]);
}

const cases = [
    ['脚位是岩浆 → 不能站', column('stone', 'lava', 'air'), false],
    ['头位是岩浆 → 不能站', column('stone', 'air', 'lava'), false],
    ['下方是岩浆 → 不能站（原来就对）', column('lava', 'air', 'air'), false],
    ['脚位是水 → 能站（站在浅水里是正常的）', column('stone', 'water', 'air'), true],
    ['石头上的空气 → 能站', column('stone', 'air', 'air'), true],
];
for (const [name, world, want] of cases) {
    const r = canStand(fakeBot(world), { x: 5, y: 64, z: 5 });
    check(name, r.ok && r.data.standable === want, `standable=${r.data?.standable} why=${r.data?.why}`);
}

// findStandSpot：目标原木 (0,64,0)。紧邻里只有两格可能能站：
//   (1,64,0) 脚位是岩浆 —— 排在搜索顺序第一，修之前会被选中
//   (0,64,1) 正常
{
    const world = new Map([
        ['0,64,0', 'oak_log'],
        ['1,63,0', 'stone'], ['1,64,0', 'lava'], ['1,65,0', 'air'],
        ['0,63,1', 'stone'], ['0,64,1', 'air'], ['0,65,1', 'air'],
    ]);
    const r = findStandSpot(fakeBot(world, { x: 3, y: 64, z: 3 }), { x: 0, y: 64, z: 0 });
    const p = r.data?.pos;
    check('findStandSpot 不选脚位是岩浆的格子', r.ok && p && p.x === 0 && p.z === 1, `pos=${JSON.stringify(p)}`);
}

// 只有岩浆格时：如实报找不到，不凑合
{
    const world = new Map([
        ['0,64,0', 'oak_log'],
        ['1,63,0', 'stone'], ['1,64,0', 'lava'], ['1,65,0', 'air'],
    ]);
    const r = findStandSpot(fakeBot(world, { x: 3, y: 64, z: 3 }), { x: 0, y: 64, z: 0 });
    check('只剩岩浆格时报 NO_SUPPORT', !r.ok && r.code === 'NO_SUPPORT', `ok=${r.ok} code=${r.code}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
