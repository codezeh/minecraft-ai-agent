// 掘进原子测试（2026-10-29）
//
// 重点验"安全范围"和"液体一票否决"——这是用户设计的核心约束：
// 「在挖之前搞个安全范围，也就是在那个范围内可以随便挖」
// 「要小心掉到危险的地方，得先规划好动作轨迹」
//
// 用假 bot（不带真实世界），因为这些都是**纯几何判断**，不需要连游戏。
import { computeSafeZone, inSafeZone, checkStep } from '../src/agent/library/atom_tunnel.js';
import { makeFakeBot } from './fixtures/fake_bot.mjs';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

/**
 * 造一个假 bot（公共夹具 tools/fixtures/fake_bot.mjs）：
 * blocks 是 Map<"x,y,z", name>，没登记的格子返回 null（未加载，⚠ 关键：不是 air）。
 */
function fakeBot(at, feet = { x: 0, y: 64, z: 0 }) {
    return makeFakeBot({
        world: at,
        feet,
        posOffset: 0,          // 原来这里就是整格坐标，不是格中心
        unloaded: 'null',      // 未加载必须是 null：判 NO_DATA 靠它
        diggable: (name) => !/^(bedrock|water|lava)$/.test(name),
    });
}

// ---------- 1) 安全范围 ----------
console.log('=== 1) 安全范围（箱子）===');
{
    const bot = fakeBot(new Map(), { x: 0, y: 64, z: 0 });
    const zone = computeSafeZone(bot, { radius: 3, up: 2, down: 2 });
    console.log(`  范围: x[${zone.x0},${zone.x1}] y[${zone.y0},${zone.y1}] z[${zone.z0},${zone.z1}]`);
    check('中心点在内', inSafeZone(zone, { x: 0, y: 64, z: 0 }), '');
    check('边界在内', inSafeZone(zone, { x: 3, y: 66, z: 3 }), '');
    check('出界被拒（x=4）', !inSafeZone(zone, { x: 4, y: 64, z: 0 }), '');
    check('出界被拒（y=67）', !inSafeZone(zone, { x: 0, y: 67, z: 0 }), '');
    check('出界被拒（y=61）', !inSafeZone(zone, { x: 0, y: 61, z: 0 }), '');
}

// ---------- 2) 正常掘进：前方是实心土 ----------
console.log('\n=== 2) 前方是实心土 → 允许 ===');
{
    const at = new Map();
    // 她站在 (0,64,0)，脚下 y=63 石头，正前方 (1,64) 和 (1,65) 都是土
    at.set('0,63,0', 'stone');
    at.set('1,63,0', 'stone');              // 前方的地板
    at.set('1,64,0', 'dirt');               // 脚位（要挖）
    at.set('1,65,0', 'dirt');               // 头位（要挖）
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    console.log(`  ${r.ok ? 'OK 要挖' + r.dig.length + '格 → 站(' + r.to.x + ',' + r.to.y + ',' + r.to.z + ')' : '拒绝: ' + r.code + ' ' + r.why}`);
    check('允许掘进', r.ok === true, r.ok ? '' : r.why);
    if (r.ok) {
        check('要挖 2 格（脚+头）', r.dig.length === 2, `${r.dig.length} 格`);
        check('目标格是正前方一格', r.to.x === 1 && r.to.y === 64 && r.to.z === 0, JSON.stringify(r.to));
    }
}

// ---------- 3) 地表：头位本来就是空气 → 只挖 1 格 ----------
console.log('\n=== 3) 地表（头位是空气）→ 只挖 1 格 ===');
{
    const at = new Map();
    at.set('0,63,0', 'stone');
    at.set('1,63,0', 'stone');
    at.set('1,64,0', 'grass_block');        // 脚位：一堵土坎
    at.set('1,65,0', 'air');                // 头位：空的
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    check('允许', r.ok === true, r.ok ? '' : r.why);
    if (r.ok) check('只挖 1 格（头位无需挖）', r.dig.length === 1, `${r.dig.length} 格`);
}

// ---------- 4) 前方是水 → 一票否决 ----------
console.log('\n=== 4) 前方是水 → 拒绝 ===');
{
    const at = new Map();
    at.set('0,63,0', 'stone');
    at.set('1,63,0', 'stone');
    at.set('1,64,0', 'water');              // 脚位是水
    at.set('1,65,0', 'water');
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    console.log(`  ${r.ok ? '允许' : '拒绝: ' + r.code}`);
    check('拒绝挖水', !r.ok && r.code === 'BLOCKED', r.code ?? 'OK');
}

// ---------- 5) 侧壁是水（挖穿会灌进来）→ 一票否决 ----------
console.log('\n=== 5) 侧壁有岩浆 → 拒绝 ===');
{
    const at = new Map();
    at.set('0,63,0', 'stone');
    at.set('1,63,0', 'stone');
    at.set('1,64,0', 'dirt');
    at.set('1,65,0', 'dirt');
    at.set('2,64,0', 'lava');               // 右侧是岩浆
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    console.log(`  ${r.ok ? '允许' : '拒绝: ' + r.code + ' — ' + r.why}`);
    check('侧壁岩浆 → 拒绝', !r.ok && r.code === 'LIQUID_RISK', r.code ?? 'OK');
}

// ---------- 6) 头顶是水（挖穿会灌）→ 一票否决 ----------
console.log('\n=== 6) 头顶两格是水 → 拒绝 ===');
{
    const at = new Map();
    at.set('0,63,0', 'stone');
    at.set('1,63,0', 'stone');
    at.set('1,64,0', 'dirt');
    at.set('1,65,0', 'dirt');
    at.set('1,66,0', 'water');              // 正上方是水
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    console.log(`  ${r.ok ? '允许' : '拒绝: ' + r.code}`);
    check('头顶液体 → 拒绝', !r.ok && r.code === 'LIQUID_RISK', r.code ?? 'OK');
}

// ---------- 7) 前方下方是空气 → 会掉下去 ----------
console.log('\n=== 7) 地板是空气 → 拒绝（会掉）===');
{
    const at = new Map();
    at.set('0,63,0', 'stone');
    at.set('1,63,0', 'air');                // 前方地板是空的
    at.set('1,64,0', 'air');
    at.set('1,65,0', 'air');
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    console.log(`  ${r.ok ? '允许' : '拒绝: ' + r.code + ' — ' + r.why}`);
    check('无地板 → 拒绝', !r.ok && r.code === 'NO_FLOOR', r.code ?? 'OK');
}

// ---------- 7b) 前方地板是水 / 岩浆 → 拒绝（D15）----------
// D15：原来写成 isLiquid(floorB.name)，传了字符串，恒为 false → 液体地板被当成实心。
// 地板在目标格正下方，不在"液体一票否决"扫的 9 个邻格里，只能靠这一条挡住。
for (const liquid of ['water', 'lava']) {
    console.log(`\n=== 7b) 地板是 ${liquid} → 拒绝（D15）===`);
    const at = new Map();
    at.set('0,63,0', 'stone');
    at.set('1,63,0', liquid);               // 前方的地板是液体
    at.set('1,64,0', 'air');
    at.set('1,65,0', 'air');
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    console.log(`  ${r.ok ? '允许（错）' : '拒绝: ' + r.code + ' — ' + r.why}`);
    check(`地板是 ${liquid} → NO_FLOOR`, !r.ok && r.code === 'NO_FLOOR', r.code ?? 'OK');
}

// ---------- 8) 基岩 → 拒绝 ----------
console.log('\n=== 8) 前方是基岩 → 拒绝 ===');
{
    const at = new Map();
    at.set('0,63,0', 'stone');
    at.set('1,63,0', 'stone');
    at.set('1,64,0', 'bedrock');
    at.set('1,65,0', 'bedrock');
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    check('基岩 → 拒绝', !r.ok && (r.code === 'BLOCKED' || r.code === 'NO_TOOL'), r.code ?? 'OK');
}

// ---------- 9) 未加载的方块 → NO_DATA（不猜） ----------
console.log('\n=== 9) 前方未加载 → 拒绝（不猜）===');
{
    const at = new Map();     // 全是 null
    const bot = fakeBot(at);
    const zone = computeSafeZone(bot, { radius: 4, up: 3, down: 3 });
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    console.log(`  ${r.ok ? '允许' : '拒绝: ' + r.code}`);
    check('未加载 → NO_DATA', !r.ok && r.code === 'NO_DATA', r.code ?? 'OK');
}

// ---------- 10) 出安全范围 → 拒绝 ----------
console.log('\n=== 10) 出安全范围 → 拒绝 ===');
{
    const at = new Map();
    at.set('0,63,0', 'stone');
    at.set('1,63,0', 'stone');
    at.set('1,64,0', 'dirt');
    at.set('1,65,0', 'dirt');
    const bot = fakeBot(at);
    // 故意把范围设成不含前一格
    const zone = { ok: true, x0: 0, x1: 0, y0: 60, y1: 70, z0: -1, z1: 1 };
    const r = checkStep(bot, { dx: 1, dz: 0 }, { zone });
    console.log(`  ${r.ok ? '允许' : '拒绝: ' + r.code}`);
    check('出界 → OUT_OF_ZONE', !r.ok && r.code === 'OUT_OF_ZONE', r.code ?? 'OK');
}

// ---------- 11) 树体：整树扫描 / 自然树判断 / 砍伐规划 ----------
// 用户设计：「确定一个木头之后扫描联系的所有木头（扫描整个树体，看看是不是自然树），
//            然后规划砍树方案」
console.log('\n=== 11) 树体：扫描 + 判断 + 规划 ===');
{
    const { scanTree, judgeTree, planFelling } = await import('../src/agent/library/atom_tree.js');

    // 造一棵"11 格笔直丛林树"：树干 x/z 各 1 格，y=71~81，周围有叶子
    const at2 = new Map();
    for (let y = 71; y <= 81; y++) at2.set(`-96,${y},-209`, 'jungle_log');
    // 树冠：在 y=78~84 放一圈叶子
    for (let y = 78; y <= 84; y++) {
        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                const k = `${-96 + dx},${y},${-209 + dz}`;
                if (!at2.has(k)) at2.set(k, 'jungle_leaves');
            }
        }
    }
    // 地板
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) at2.set(`${-96 + dx},70,${-209 + dz}`, 'grass_block');
    // 远处放一堆木板（模拟"12 格外有玩家建筑"）—— 不该影响判断
    for (let i = 0; i < 30; i++) at2.set(`${-96 + 10},${72 + (i % 3)},${-209 + (i % 5)}`, 'oak_planks');

    const b2 = fakeBot(at2, { x: -89, y: 63, z: -212 });
    const scan = scanTree(b2, { x: -96, y: 71, z: -209 });
    console.log(`  扫描: ${scan.ok ? scan.logs.length + ' 根, y ' + scan.minY + '~' + scan.maxY + ', 跨度 ' + scan.spanX + 'x' + scan.spanZ : '失败 ' + scan.code}`);
    check('扫出整棵树', scan.ok === true, scan.ok ? '' : scan.why);
    if (scan.ok) {
        check('树干 11 根（6 向连通，不串到别的树）', scan.logs.length === 11, `${scan.logs.length} 根`);
        check('识别为笔直树干（跨度 1x1）', scan.spanX === 1 && scan.spanZ === 1, `${scan.spanX}x${scan.spanZ}`);
        check('数到树冠', scan.leaves >= 3, `${scan.leaves} 片`);

        const judge = judgeTree(scan);
        console.log(`  判断: ${judge.isTree ? '✅ 自然树' : '❌ 不是树'} — ${judge.why}`);
        check('判定为自然树', judge.isTree === true, judge.why);
        check('远处木板不影响判断', scan.artificial <= 6, `近身人造 ${scan.artificial}`);

        const plan = planFelling(scan, { standY: 70 });
        console.log(`  规划: ${plan.why}`);
        check('排得出砍伐顺序', plan.ok === true, '');
        if (plan.ok) {
            check('从底往上（第一层 y=71）', plan.order[0].y === 71, `y=${plan.order[0].y}`);
            check('层数 = 11', plan.layers === 11, `${plan.layers} 层`);
            check('站在 y=70 时第一层够得到', plan.reachableFromGround === true, '');
        }
        // 站在地面下方 12 格（真实场景）→ 应如实报告够不到
        const plan2 = planFelling(scan, { standY: 59 });
        check('站太低时如实报告够不到（不假装能砍）', plan2.reachableFromGround === false, plan2.why.slice(0, 40));
    }

    // 反向：没有叶子的"光杆"不该被判成自然树
    const at3 = new Map();
    for (let y = 71; y <= 75; y++) at3.set(`5,${y},5`, 'oak_log');
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) at3.set(`${5 + dx},70,${5 + dz}`, 'stone');
    const b3 = fakeBot(at3, { x: 10, y: 63, z: 10 });
    const scan3 = scanTree(b3, { x: 5, y: 71, z: 5 });
    const judge3 = judgeTree(scan3);
    console.log(`  光杆判断: ${judge3.isTree ? '❌ 误判成树' : '✅ 正确拒绝'} — ${judge3.why}`);
    check('没有树冠的光杆不算自然树', judge3.isTree === false, judge3.why);
}


// ---------- 12) 绕开液体：找干燥的可爬升列 ----------
// 场景：她和水沟这岸隔着 6 格水，对岸才是树。
// 直接朝目标挖必然 LIQUID_RISK，得先横移到旁边干燥的一列。
console.log('\n=== 12) 找干燥可爬升列 ===');
{
    const { findDryClimbColumn } = await import('../src/agent/library/atom_tunnel.js');

    // 造场景：她在 (0,64,0)，x=1..4 是一条水沟，x=5..8 是干燥石地
    const mk = (wet) => {
        const at = new Map();
        for (let x = -6; x <= 10; x++) {
            for (let z = -6; z <= 6; z++) {
                at.set(`${x},63,${z}`, 'stone');            // 地板
                for (let y = 64; y <= 72; y++) at.set(`${x},${y},${z}`, 'air');
            }
        }
        if (wet) {
            for (let x = 1; x <= 4; x++) {
                for (let z = -6; z <= 6; z++) at.set(`${x},64,${z}`, 'water');
            }
        }
        return fakeBot(at, { x: 0, y: 64, z: 0 });
    };

    // 有水沟：正前方 x=1..4 是水 → 应该找到 x>=5 的干燥列
    const botWet = mk(true);
    const r1 = findDryClimbColumn(botWet, { x: 8, z: 0 }, { radius: 6, upTo: 70 });
    console.log(`  有水沟时: ${r1.ok ? '找到 ' + r1.candidates.length + ' 个候选，最优 (' + r1.candidates[0].x + ',' + r1.candidates[0].z + ')' : '失败 ' + r1.code}`);
    check('有水沟时能找到干燥列', r1.ok === true, r1.ok ? '' : r1.why);
    if (r1.ok) {
        check('候选列都不是水沟里那几列', !r1.candidates.some(c => c.x >= 1 && c.x <= 4), '');
        check('最优候选在被水沟另一侧或背后', r1.candidates[0].x <= 0 || r1.candidates[0].x >= 5,
            `x=${r1.candidates[0].x}`);
    }

    // 四周全是水 → 应如实报找不到
    const at2 = new Map();
    for (let x = -6; x <= 10; x++) for (let z = -6; z <= 6; z++) {
        at2.set(`${x},63,${z}`, 'stone');
        for (let y = 64; y <= 72; y++) at2.set(`${x},${y},${z}`, 'water');
    }
    at2.set('0,64,0', 'air');   // 她自己在空气里
    const botAllWet = fakeBot(at2, { x: 0, y: 64, z: 0 });
    const r2 = findDryClimbColumn(botAllWet, { x: 5, z: 0 }, { radius: 3, upTo: 70 });
    console.log(`  四周全水时: ${r2.ok ? '❌ 居然找到 ' + r2.candidates.length + ' 个' : '✅ 如实报 ' + r2.code}`);
    check('四周全是水时如实报找不到', r2.ok === false, r2.ok ? '不该找到' : r2.code);
}


// ---------- 13) 水下地面标 SUBMERGED，规划不再潜水底 ----------
// 用户场景：她浮在水面 y=62，规划却让她下到 y=50 的水底，
// 执行层没有潜水能力 → `HEIGHT_MISS 该降到 y=58，实际停在 y=62`。
// 真实数据里 47.7% 的实心面在水下，全禁会无路可走，所以用高代价而非禁止。
console.log('\n=== 13) 水下地面（SUBMERGED）===');
{
    const { mkdirSync, rmSync } = await import('node:fs');
    const { saveSurfaces, T } = await import('../src/agent/library/terrain3d.js');
    const { plan3D } = await import('../src/agent/library/path_3d.js');
    const tmp = 'C:/Users/zeh/AppData/Local/Temp/submerged-' + Date.now();
    mkdirSync(tmp, { recursive: true });

    // 造一条走廊：y=50 是"水下地面"（SUBMERGED），y=62 是水面，两侧 y=62 是陆地
    const cells = [];
    for (let x = 0; x < 40; x++) {
        for (let z = 0; z < 6; z++) {
            if (x >= 10 && x <= 30) {
                cells.push({ x, z, y: 50, t: T.SUBMERGED });   // 深水底
                cells.push({ x, z, y: 62, t: T.WATER });       // 水面
            } else {
                cells.push({ x, z, y: 62, t: T.SOLID });       // 陆地
            }
        }
    }
    saveSurfaces(tmp, cells);

    const p = plan3D(tmp, { x: 2, y: 63, z: 3 }, { x: 37, y: 63, z: 3 },
        { maxNodes: 60000, margin: 6 });
    console.log(`  跨水规划: ${p.ok ? 'OK ' + p.path.length + '步，代价 ' + p.cost.toFixed(1) : '失败 ' + p.code}`);
    check('能跨过水域', p.ok, p.code ?? 'OK');
    if (p.ok) {
        const ys = p.path.map(s => s.y);
        const minY = Math.min(...ys);
        console.log(`  y 范围: ${minY} ~ ${Math.max(...ys)}`);
        check('不潜到水底（y 不低于 60）', minY >= 60, `最低 y=${minY}`);
    }

    // 反向：如果**只有水下通路**，仍然要能走（不能因为贵就报 NO_PATH）
    const cells2 = [];
    for (let x = 0; x < 20; x++) {
        for (let z = 0; z < 6; z++) {
            cells2.push({ x, z, y: 50, t: T.SUBMERGED });   // 全部是水下地面
            cells2.push({ x, z, y: 62, t: T.WATER });
        }
    }
    // 两端各留一格陆地当起终点
    for (let z = 0; z < 6; z++) {
        cells2.push({ x: 0, z, y: 50, t: T.SOLID });
        cells2.push({ x: 19, z, y: 50, t: T.SOLID });
    }
    saveSurfaces(tmp, cells2);
    const p2 = plan3D(tmp, { x: 0, y: 51, z: 3 }, { x: 19, y: 51, z: 3 },
        { maxNodes: 60000, margin: 6 });
    console.log(`  只有水下通路时: ${p2.ok ? 'OK ' + p2.path.length + '步' : '失败 ' + p2.code}`);
    check('只有水下通路时仍能规划（不因代价高而 NO_PATH）', p2.ok, p2.code ?? 'OK');

    try { rmSync(tmp, { recursive: true, force: true }); } catch { }
}


console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);