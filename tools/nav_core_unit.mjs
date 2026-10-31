/**
 * nav_core.normalizeDest 单元测试 —— 不需要服务器。
 *
 * goTo 要接受三种写法（老代码传裸 {x,z}，原子契约传 {kind:'point',pos}），
 * 归一化是**唯一**该容忍的地方（原子层不再接受裸坐标）。
 *
 * 引擎选择（walk3d / pathfinder3 / pathfinder2）无法在纯单测里验——
 * 它要真调 walkTo/moveTo。那部分靠 tools/bench_move_baseline.mjs 的
 * 改前/改后对比来证明（接线 task_hop 前后各跑一次）。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { normalizeDest, goTo } from '../src/agent/library/nav_core.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. 裸 {x,z} → y 为 null ───────────────────────────────────────────
{
    const r = normalizeDest({ x: 10, z: 20 });
    if (eq(r, { x: 10, y: null, z: 20 })) okCase('裸 {x,z} 接受', JSON.stringify(r));
    else badCase('裸 {x,z} 接受', JSON.stringify(r));
}

// ── 2. 裸 {x,y,z} → y 保留 ───────────────────────────────────────────
{
    const r = normalizeDest({ x: 1, y: 64, z: 2 });
    if (eq(r, { x: 1, y: 64, z: 2 })) okCase('裸 {x,y,z} 接受', JSON.stringify(r));
    else badCase('裸 {x,y,z} 接受', JSON.stringify(r));
}

// ── 3. {kind:'point', pos} 两种键都认 ────────────────────────────────
{
    const a = normalizeDest({ kind: 'point', pos: { x: 3, y: 65, z: 4 } });
    const b = normalizeDest({ kind: 'point', posXZ: { x: 3, z: 4 } });
    if (eq(a, { x: 3, y: 65, z: 4 }) && eq(b, { x: 3, y: null, z: 4 })) {
        okCase('描述对象两种键都认', `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    } else {
        badCase('描述对象两种键都认', `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
}

// ── 4. 非法输入一律 null（不抛、不产出 NaN）──────────────────────────
{
    const cases = [
        [null, 'null'],
        [undefined, 'undefined'],
        [{}, '空对象'],
        [{ x: NaN, z: 0 }, 'NaN x'],
        [{ x: 0, z: Infinity }, 'Infinity z'],
        [{ kind: 'point' }, 'kind 但没坐标'],
        [{ kind: 'point', pos: { x: NaN, z: 1 } }, 'pos 里是 NaN'],
        ['abc', '字符串'],
    ];
    const bad = cases.filter(([v]) => normalizeDest(v) !== null);
    if (!bad.length) okCase('非法输入一律 null', `${cases.length} 种`);
    else badCase('非法输入一律 null', JSON.stringify(bad.map(([, n]) => n)));
}

// ── 5. goTo：目标无效时给 NO_TARGET（不需要服务器）──────────────────
{
    const bot = { entity: { position: { x: 0, y: 64, z: 0 } } };
    const r = await goTo(bot, { x: NaN, z: 0 }, {});
    if (!r.ok && r.code === 'NO_TARGET') okCase('goTo 目标无效 → NO_TARGET', r.code);
    else badCase('goTo 目标无效 → NO_TARGET', JSON.stringify(r));
}

// ── 6. goTo：已中断 → INTERRUPTED（且不落进任何引擎）─────────────────
{
    const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, interrupt_code: 'USER_STOP' };
    const r = await goTo(bot, { x: 1, z: 1 }, {});
    if (!r.ok && r.code === 'INTERRUPTED') okCase('goTo 已中断 → INTERRUPTED', r.code);
    else badCase('goTo 已中断 → INTERRUPTED', JSON.stringify(r));
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
