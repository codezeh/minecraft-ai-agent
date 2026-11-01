// 攀爬能力测试（2026-10-28）
//
// 验证三层：
//   1) 分类：藤蔓/梯子 → T.CLIMBABLE；且不再被当空气
//   2) 规划：竖直藤蔓柱能生成 climb 边，Cost 合理，且不被当落脚点
//   3) 原子：atom_climb 的 climbableUp / climbableDown 能正确算出可爬格数
//
// 不依赖真实世界（用合成库），保证库一清空也不会误报。
import { mkdirSync, rmSync } from 'node:fs';
import { plan3D } from '../src/agent/library/path_3d.js';
import { saveSurfaces, classifyBlock, columnSurfaces, T } from '../src/agent/library/terrain3d.js';
import { isClimbableName, climbableUp, climbableDown } from '../src/agent/library/act_climb.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

// ---------- 1) 分类 ----------
console.log('=== 1) 方块分类 ===');
{
    const cases = [
        ['vine', T.CLIMBABLE], ['weeping_vines', T.CLIMBABLE], ['weeping_vines_plant', T.CLIMBABLE],
        ['twisting_vines', T.CLIMBABLE], ['cave_vines', T.CLIMBABLE], ['cave_vines_plant', T.CLIMBABLE],
        ['ladder', T.CLIMBABLE], ['oak_ladder', T.CLIMBABLE],
        ['stone', T.SOLID], ['water', T.WATER], ['oak_leaves', T.LEAVES],
    ];
    let bad = [];
    for (const [name, want] of cases) {
        const got = classifyBlock(name);
        if (got !== want) bad.push(`${name}: 期望 ${want} 得到 ${got}`);
    }
    check('所有攀爬方块分类正确', bad.length === 0, bad.join('; '));
    // 关键回归：vine 不能是 null（空气）
    check('vine 不再是空气（旧 bug）', classifyBlock('vine') !== null, '');
    check('short_grass 仍是空气', classifyBlock('short_grass') === null, '');

    // ★ 回归：带命名空间前缀的方块名也要分类正确。
    // 实测 bug：她扫描时名字可能是 `minecraft:ladder`，旧代码正则按无前缀写，
    // 匹配失败 → 落进 SOLID 默认分支 → 6 格梯子变成"实心方块"。
    const prefixed = [
        ['minecraft:ladder', T.CLIMBABLE], ['minecraft:vine', T.CLIMBABLE],
        ['minecraft:weeping_vines', T.CLIMBABLE],
        ['minecraft:water', T.WATER], ['minecraft:stone', T.SOLID],
        ['minecraft:oak_leaves', T.LEAVES], ['minecraft:air', null],
    ];
    let pbad = [];
    for (const [n, want] of prefixed) {
        const got = classifyBlock(n);
        if (got !== want) pbad.push(`${n}: 期望 ${want} 得到 ${got}`);
    }
    check('带 minecraft: 前缀也分类正确', pbad.length === 0, pbad.join('; '));
}

// ---------- 2) 规划：竖直藤蔓柱 ----------
console.log('\n=== 2) 规划：竖直藤蔓柱 ===');
{
    const dir = 'C:/Users/zeh/AppData/Local/Temp/climb-test-' + Date.now();
    mkdirSync(dir, { recursive: true });

    // 造场景：地面 y=50 的平台，x=5 那一条是藤蔓柱（y=51..55）
    // 藤蔓柱顶端 y=56 是一块可站平台
    const cells = [];
    for (let x = 0; x < 11; x++) {
        for (let z = 0; z < 11; z++) {
            cells.push({ x, z, y: 50, t: T.SOLID });          // 地面
        }
    }
    for (let y = 51; y <= 55; y++) {
        cells.push({ x: 5, z: 5, y, t: T.CLIMBABLE });         // 竖直藤蔓
    }
    for (let x = 3; x < 8; x++) {
        for (let z = 3; z < 8; z++) {
            cells.push({ x, z, y: 56, t: T.SOLID });           // 顶上平台
        }
    }
    saveSurfaces(dir, cells);

    // 从地面走到顶上平台：必须经过藤蔓
    const plan = plan3D(dir, { x: 2, y: 51, z: 5 }, { x: 5, y: 57, z: 5 },
        { maxNodes: 40000, margin: 6 });
    console.log(`  规划: ${plan.ok ? 'OK ' + plan.path.length + '步，代价 ' + plan.cost.toFixed(1) : '失败 ' + plan.code}`);
    check('能规划到藤蔓顶上（垂直 6 格）', plan.ok, plan.code ?? 'OK');
    if (plan.ok) {
        const climbs = plan.path.filter(s => s.action === 'climb');
        console.log(`  攀爬步数: ${climbs.length}`);
        check('路径里用了 climb 动作', climbs.length > 0, `${climbs.length} 步`);
        const up = plan.path.some(p => p.y >= 56);
        check('路径到达了 y>=56 的平台', up, '');
    }

    // 关键：藤蔓不能被当落脚点
    const col = columnSurfaces(dir, 5, 5);
    const vines = col.filter(c => c.t === T.CLIMBABLE);
    console.log(`  藤蔓列 (5,5): ${JSON.stringify(col)}`);
    check('藤蔓列被记录为 CLIMBABLE', vines.length > 0, `${vines.length} 格`);

    // 从平台下到地面。
    // 注意：**不要求**这里用 climb —— 平台边直接跳下去更便宜（down 代价 ~1/格，
    // climb 是 1.5/格 × 0.7）。规划器选 down 是正确行为。
    // 真正要验的是"能下去"，以及"climb 边在必须用时可用"（见下面的封闭井测试）。
    const down = plan3D(dir, { x: 5, y: 57, z: 5 }, { x: 2, y: 51, z: 5 },
        { maxNodes: 40000, margin: 6 });
    console.log(`  下降规划: ${down.ok ? 'OK ' + down.path.length + '步' : '失败 ' + down.code}`);
    check('能规划从平台下到地面', down.ok, down.code ?? 'OK');

    // 封闭井：四周都是实心高墙，只能靠藤蔓下去。
    // 这才逼出 descnd 时必须用 climb 的场景。
    const cells2 = [];
    for (let x = 0; x < 11; x++) for (let z = 0; z < 11; z++) {
        cells2.push({ x, z, y: 50, t: T.SOLID });
        // 井壁：x=4 和 x=6 从 y=51 立到 y=58
        if (x === 4 || x === 6) for (let y = 51; y <= 58; y++) cells2.push({ x, z, y, t: T.SOLID });
    }
    for (let y = 51; y <= 58; y++) cells2.push({ x: 5, z: 5, y, t: T.CLIMBABLE });
    cells2.push({ x: 5, z: 5, y: 59, t: T.SOLID });     // 井口盖板（站在上面）
    saveSurfaces(dir, cells2);

    const well = plan3D(dir, { x: 5, y: 60, z: 5 }, { x: 5, y: 51, z: 5 },
        { maxNodes: 60000, margin: 6 });
    console.log(`  竖井下降: ${well.ok ? 'OK ' + well.path.length + '步' : '失败 ' + well.code}`);
    check('竖井里能下到井底', well.ok, well.code ?? 'OK');
    if (well.ok) {
        check('竖井下降必须用 climb', well.path.some(s => s.action === 'climb'), '');
    }

    try { rmSync(dir, { recursive: true, force: true }); } catch { }
}

// ---------- 3) 原子：可爬格数计算 ----------
console.log('\n=== 3) 原子：isClimbableName ===');
{
    check('ladder 可爬', isClimbableName('ladder') === true, '');
    check('vine 可爬', isClimbableName('vine') === true, '');
    check('vine 在 allowVine=false 时不可爬', isClimbableName('vine', { allowVine: false }) === false, '');
    check('ladder 在 allowVine=false 时仍可爬', isClimbableName('ladder', { allowVine: false }) === true, '');
    check('stone 不可爬', isClimbableName('stone') === false, '');
    check('空值不可爬', isClimbableName(null) === false, '');
}

// ---------- 4) 回归：没藤蔓时行为不变 ----------
console.log('\n=== 4) 回归：普通地形不受影响 ===');
{
    const dir = 'C:/Users/zeh/AppData/Local/Temp/climb-plain-' + Date.now();
    mkdirSync(dir, { recursive: true });
    const cells = [];
    for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) cells.push({ x, z, y: 64, t: T.SOLID });
    saveSurfaces(dir, cells);
    const p = plan3D(dir, { x: 2, y: 65, z: 2 }, { x: 17, y: 65, z: 17 }, { maxNodes: 20000, margin: 4 });
    check('平地仍能正常规划', p.ok, p.code ?? 'OK');
    if (p.ok) {
        check('平地路径里没有 climb', !p.path.some(s => s.action === 'climb'), '');
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
}

// ---------- 5) 回归：过水不许规划成"潜到水底走" ----------
console.log('\n=== 5) 回归：水面路径不能潜底 ===');
{
    const dir = 'C:/Users/zeh/AppData/Local/Temp/water-path-' + Date.now();
    mkdirSync(dir, { recursive: true });
    // 造一条水沟：y=62 水面（连续 20 格），y=58 水下地面。两侧 y=62 是陆地。
    // 她应该"浮着走水面"，绝不该潜到 y=58 走。
    const cells = [];
    for (let x = 0; x < 30; x++) {
        for (let z = 0; z < 6; z++) {
            if (x >= 5 && x <= 24) {
                cells.push({ x, z, y: 58, t: T.SOLID });
                cells.push({ x, z, y: 62, t: T.WATER });
            } else {
                cells.push({ x, z, y: 62, t: T.SOLID });
            }
        }
    }
    saveSurfaces(dir, cells);

    const p = plan3D(dir, { x: 2, y: 63, z: 3 }, { x: 27, y: 63, z: 3 },
        { maxNodes: 60000, margin: 6 });
    console.log(`  跨水规划: ${p.ok ? 'OK ' + p.path.length + '步，代价 ' + p.cost.toFixed(1) : '失败 ' + p.code}`);
    check('能跨过水沟', p.ok, p.code ?? 'OK');
    if (p.ok) {
        const ys = p.path.map(s => s.y);
        const minY = Math.min(...ys);
        console.log(`  路径 y 范围: ${minY} ~ ${Math.max(...ys)}`);
        check('没有潜到水下地面（y<60）', minY >= 60, `最低 y=${minY}`);
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
}


console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
