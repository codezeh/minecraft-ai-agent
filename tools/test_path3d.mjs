// 验证 3D 规划器（path_3d）。
//
// 关键验收：用**她的真实 3D 数据**，看能不能算出一条出路。
// 已知事实（probe_3d_live 实测）：
//   她站在 (-90, 60, -235)，这一层全图只有 1 个面
//   y=70 有 102 个面（地表），y=44 有 103 个面（洞穴）
import { plan3D, describe3D, C3 } from '../src/agent/library/path_3d.js';
import { stats3d } from '../src/agent/library/terrain3d.js';

const MAP = './bots/deepseek/map';
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const st = stats3d(MAP);
console.log(`\n3D 库里: ${st.cells} 个面 / ${st.chunks} 区块`);
if (st.cells === 0) {
    console.log('库是空的，先跑 probe_3d_live 扫描');
    process.exit(2);
}

// ---------- 1) 从她的位置出去（不指定终点 = 找最近的开阔处）----------
console.log('\n=== 1) 从她 (-90,60,-235) 找出口 ===');
{
    const t0 = Date.now();
    const plan = plan3D(MAP, { x: -90, y: 60, z: -235 }, null, { maxNodes: 60000 });
    const ms = Date.now() - t0;
    console.log(`  ${describe3D(plan)}  ${ms}ms`);

    check('能算出路线', plan.ok, plan.code ?? 'OK');
    if (plan.ok) {
        console.log('  路线前 8 步:', plan.path.slice(0, 8).map(p => `(${p.x},${p.y},${p.z})${p.action !== 'walk' ? '[' + p.action + ']' : ''}`).join(' → '));
        const dy = plan.path[plan.path.length - 1].y - plan.path[0].y;
        console.log(`  总高差: ${dy >= 0 ? '+' : ''}${dy}`);
        check('路线确实离开了原位置', plan.path.length > 2, `${plan.path.length} 步`);
        check('终点不是原地', Math.hypot(plan.goal.x + 90, plan.goal.z + 235) > 2 || Math.abs(plan.goal.y - 60) > 1,
            `终点 (${plan.goal.x},${plan.goal.y},${plan.goal.z})`);
        check('耗时 < 3 秒', ms < 3000, `${ms}ms`);
    }
}

// ---------- 2) 指定终点：走到地表 --------
console.log('\n=== 2) 从她位置走到地表 y=70 附近 ===');
{
    // 找一个 y=70 的真实面当终点
    const { boxSurfaces } = await import('../src/agent/library/terrain3d.js');
    const top = boxSurfaces(MAP, -100, -245, -80, -225, 68, 74);
    console.log(`  y=68..74 有 ${top.length} 个面`);
    if (top.length) {
        const target = top[Math.floor(top.length / 2)];
        console.log(`  选终点 (${target.x},${target.y},${target.z})`);
        const plan = plan3D(MAP, { x: -90, y: 60, z: -235 }, { x: target.x, y: target.y, z: target.z },
            { maxNodes: 80000 });
        console.log(`  ${describe3D(plan)}`);
        check('能规划到地表目标', plan.ok, plan.code ?? 'OK');
        if (plan.ok) {
            check('终点就是目标', plan.goal.x === target.x && plan.goal.y === target.y && plan.goal.z === target.z,
                JSON.stringify(plan.goal));
        }
    } else {
        console.log('  （没有 y=68..74 的面，跳过）');
    }
}

// ---------- 3) 代价函数合理 ----------
console.log('\n=== 3) 步进代价：越高越贵 ===');
{
    const costs = [0, 1, 2, 3, 5, 10].map(d => {
        // 复刻 stepCost
        if (d === 0) return C3.flat;
        if (d === 1) return C3.up1;
        if (d === 2) return C3.up2;
        return C3.upBase + C3.upPerExtra * (d - 2);
    });
    console.log('  上 0/1/2/3/5/10 格 →', costs.map(c => c.toFixed(1)).join(' / '));
    check('单调递增', costs.every((c, i) => i === 0 || c > costs[i - 1]), '');
    check('上 1 格比平地贵但不夸张', costs[1] > costs[0] && costs[1] < costs[0] * 4, '');
    check('上 10 格极贵（>80）', costs[5] > 80, costs[5].toFixed(1));
}

// ---------- 4) 空数据/无效起点要老实报错 ----------
console.log('\n=== 4) 异常情况老实报错 ===');
{
    const r1 = plan3D(MAP, { x: 99999, y: 100, z: 99999 }, null, { maxNodes: 5000 });
    check('远在库外的起点 → NO_DATA/NO_START', ['NO_DATA', 'NO_START'].includes(r1.code), r1.code ?? 'OK');
    check('失败时 path 是空数组', Array.isArray(r1.path) && r1.path.length === 0, '');
}

// ---------- 5) 目标不在面上时要在附近找（回归测试）----------
console.log('=== 5) 目标不在面上（回归：不许返回 NO_PATH）===');
{
    // 用**临时库自造数据**，不依赖她的实际地图 ——
    // 旧版本依赖真实地图某坐标，库一清空/重建就误报失败。
    const { mkdirSync, rmSync } = await import('node:fs');
    const { saveSurfaces, T } = await import('../src/agent/library/terrain3d.js');
    const tmp = 'C:/Users/zeh/AppData/Local/Temp/t3d-goal-' + Date.now();
    mkdirSync(tmp, { recursive: true });
    const cells = [];
    for (let x = 0; x < 30; x++) cells.push({ x, z: 0, y: 64, t: T.SOLID });
    saveSurfaces(tmp, cells);
    // 目标 y=66 不在面上（面在 y=64），应退化成最近的面而不是 NO_PATH
    const r = plan3D(tmp, { x: 0, y: 65, z: 0 }, { x: 20, y: 66, z: 0 },
        { maxNodes: 20000, margin: 4 });
    console.log(`  ${describe3D(r)}`);
    check('目标不在面上时仍有结果（不返回 NO_PATH）', r.ok, r.code ?? 'OK');
    if (r.ok) {
        const dh = Math.hypot(r.goal.x - 20, r.goal.z - 0);
        check('终点落在目标附近 4 格内', dh <= 4.5, `水平差 ${dh.toFixed(1)} 格`);
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { }
}

// ---------- 6) 回归：浮点误差不能把起点锁到下一层 ----------
console.log('\n=== 6) 回归：起点浮点误差（Math.floor 少 1 格）===');
{
    // 实测事故（302 格长规划，连续 5 轮卡同一点）：
    //   她在水面，精确 y=61.99 → Math.floor = 61，而库里水面记的是 y=62；
    //   旧逻辑只往 -3 方向找起点，找到 y=59（水下地面，2 格容差内），
    //   于是整条路径从水底算起 → 每轮 `HEIGHT_MISS 该降到 y=59，实际停在 y=62`。
    const { mkdirSync, rmSync } = await import('node:fs');
    const { saveSurfaces, T } = await import('../src/agent/library/terrain3d.js');
    const tmp = 'C:/Users/zeh/AppData/Local/Temp/float-start-' + Date.now();
    mkdirSync(tmp, { recursive: true });
    const cells = [];
    // 一条走廊：水面 y=62（水），水下地面 y=59，长 20
    for (let x = 0; x < 20; x++) {
        cells.push({ x, z: 0, y: 59, t: T.SOLID });
        cells.push({ x, z: 0, y: 62, t: T.WATER });
    }
    saveSurfaces(tmp, cells);

    // 起点用 61.99（floor → 61），应该锁到 y=62 水面而不是 y=59 水底
    const p = plan3D(tmp, { x: 2, y: 61.99, z: 0 }, { x: 17, y: 62, z: 0 },
        { maxNodes: 20000, margin: 4 });
    console.log(`  规划: ${p.ok ? 'OK ' + p.path.length + '步' : '失败 ' + p.code}`);
    check('能规划', p.ok, p.code ?? 'OK');
    if (p.ok) {
        console.log(`  起点 y=${p.start.y}（期望 62，不是 59）`);
        check('起点锁在水面 y=62，没掉到水底 y=59', p.start.y === 62, `实际 ${p.start.y}`);
        const ys = p.path.map(s => s.y);
        check('整条路径都留在水面层', Math.min(...ys) >= 60, `最低 y=${Math.min(...ys)}`);
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { }
}


console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
