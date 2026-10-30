// 验证真 3D 地形库（terrain3d）。
//
// 核心验收：**她那个"5 米角落"的问题，3D 能不能识别出来。**
// 2.5D 地图说那块地 72% 连通可走、代价 1，但她实际被墙夹住。
import { openDb3d, scanSphere, columnSurfaces, boxSurfaces, hasSurface, stats3d, classifyBlock, T } from '../src/agent/library/terrain3d.js';
import { rmSync, existsSync, mkdirSync } from 'node:fs';

const DIR = 'C:/Users/zeh/AppData/Local/Temp/t3d-test-' + Date.now();
mkdirSync(DIR, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

// ---------- 1) 建库 ----------
console.log('\n=== 1) 建库与表结构 ===');
{
    const db = openDb3d(DIR);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    console.log('  表:', tables.join(', '));
    check('有 surf 表', tables.includes('surf'), '');
    check('有 chunk_index 表', tables.includes('chunk_index'), '');

    const cols = db.prepare('PRAGMA table_info(chunk_index)').all().map(r => r.name);
    console.log('  chunk_index 列:', cols.join(', '));
    check('chunk_index 只有长宽（x0/z0/x1/z1），没有 y', !cols.some(c => /^y/.test(c)),
        cols.join(','));

    const scols = db.prepare('PRAGMA table_info(surf)').all().map(r => r.name);
    check('surf 有 x/z/y/t', ['x', 'z', 'y', 't'].every(c => scols.includes(c)), scols.join(','));
    db.close();
}

// ---------- 2) 方块分类 ----------
console.log('\n=== 2) 方块分类 ===');
{
    const cases = [
        ['stone', T.SOLID], ['grass_block', T.SOLID], ['dirt', T.SOLID],
        ['water', T.WATER], ['lava', T.LAVA], ['magma_block', T.LAVA],
        ['oak_planks', T.BUILT], ['oak_leaves', T.LEAVES],
        ['air', null], ['cave_air', null], ['short_grass', null],
    ];
    for (const [name, want] of cases) {
        const got = classifyBlock(name);
        check(`${name} → ${want === null ? '无面' : want}`, got === want, `得到 ${got}`);
    }
}

// ---------- 3) 用假 bot 扫一个"她那种角落" ----------
console.log('\n=== 3) 造一个她那种场景：5 米角落，东边 5 格厚墙 ===');
{
    // 假世界：y=0 是地面（实心），y>=1 是空气；
    // x 从 +3 到 +8 是一堵 5 格厚的墙（y=1..4 都实心）
    const SOLID_NAMES = ['stone', 'dirt', 'grass_block'];
    const fakeBot = {
        blockAt(pos) {
            const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
            if (y < 0) return { name: 'stone' };                    // 地下
            if (y === 0) return { name: 'grass_block' };            // 地面
            // 东边 3..8 格是厚墙（她走不过去）
            if (x >= 3 && x <= 8 && y >= 1 && y <= 4) return { name: 'stone' };
            // 其余是空气
            return { name: 'air' };
        },
    };

    const r = scanSphere(fakeBot, DIR, { x: 0, y: 1, z: 0 }, 20);
    console.log(`  扫描: ${r.cells} 个面 / ${r.columns} 列 / ${r.chunks} 区块 / ${r.ms}ms`);
    check('扫描到面', r.cells > 0, `${r.cells}`);
    check('扫描耗时合理', r.ms < 5000, `${r.ms}ms`);

    console.log('\n  查列（她的位置 x=0,z=0）:');
    const col = columnSurfaces(DIR, 0, 0);
    console.log('   ', JSON.stringify(col));
    check('她脚下那列有地面（y=0）', col.some(c => c.y === 0), JSON.stringify(col));

    console.log('\n  查列（墙的位置 x=5,z=0）:');
    const wall = columnSurfaces(DIR, 5, 0);
    console.log('   ', JSON.stringify(wall));
    // 注意：墙 y=1..4 全实心，从上往下扫**只有 y=4 是"空气→实心"的边界**
    // （y=3/2/1 上面都是实心，不是边界）。所以这里只有 1 个面，是对的。
    // 这恰好说明 surf 存的是"可站立面"，不是"每个方块"。
    check('墙那列只有 1 个面（墙顶 y=4）', wall.length === 1 && wall[0].y === 4,
        JSON.stringify(wall));

    console.log('\n  盒子查询（她到东边 10 格）:');
    const box = boxSurfaces(DIR, -2, -2, 10, 2, -5, 10);
    console.log(`    ${box.length} 个面`);
    check('盒子查询返回结果', box.length > 0, `${box.length}`);

    check('hasSurface 能精确查某格', hasSurface(DIR, 0, 0, 0) === true && hasSurface(DIR, 0, 9, 0) === false,
        `(0,0,0)=${hasSurface(DIR, 0, 0, 0)} (0,9,0)=${hasSurface(DIR, 0, 9, 0)}`);
}

// ---------- 4) 3D 能区分"有屋顶的洞穴"和"露天平地" ----------
console.log('\n=== 4) 3D 的关键能力：同一 (x,z) 有多个面 ===');
{
    // 造一个两层结构：y=0 地面，y=5 天花板（= 洞穴）
    const fakeBot = {
        blockAt(pos) {
            const y = Math.floor(pos.y);
            if (y < 0) return { name: 'stone' };
            if (y === 0) return { name: 'grass_block' };   // 地面
            if (y === 5) return { name: 'stone' };         // 天花板
            return { name: 'air' };
        },
    };
    scanSphere(fakeBot, DIR, { x: 100, y: 1, z: 100 }, 12);
    const col = columnSurfaces(DIR, 100, 100);
    console.log('  洞穴列:', JSON.stringify(col));
    check('同一列查到 2 个面（地面 y=0 + 天花板 y=5）', col.length === 2, JSON.stringify(col));
    check('说明 2.5D 会漏掉天花板', col.some(c => c.y === 5), '');

    const st = stats3d(DIR);
    console.log(`  库里共 ${st.cells} 个面 / ${st.chunks} 区块`);
    check('统计可用', st.cells > 0 && st.chunks > 0, JSON.stringify(st));
}

// ---------- 5) 重扫同一区域是覆盖，不是累加 ----------
console.log('\n=== 5) 重扫幂等（不重复累加）===');
{
    const before = stats3d(DIR).cells;
    const fakeBot = { blockAt: (pos) => (Math.floor(pos.y) === 0 ? { name: 'grass_block' } : { name: 'air' }) };
    scanSphere(fakeBot, DIR, { x: 100, y: 1, z: 100 }, 12);
    const after = stats3d(DIR).cells;
    console.log(`  重扫前 ${before} → 重扫后 ${after}`);
    check('重扫不会无限增长（主键去重）', after <= before + 50, `${before} → ${after}`);
}

// ---------- 可穿过的植物不能被当成实心 ----------
console.log('\n=== 可穿过植物分类（第 6 组）===');
{
    // 实测事故（302 格长规划）：(-390,-148) 真实是 air + 旁边 bamboo，
    // 库里却记着 y=63 SOLID（因为 bamboo 被归成 SOLID），
    // 规划据此给出路径，pathfinder 拒绝 → `STUCK 差 4.8 格且完全没动`。
    const passable = [
        'bamboo', 'bamboo_sapling', 'sugar_cane', 'large_fern', 'dead_bush',
        'tall_seagrass', 'short_grass', 'tall_grass', 'fern', 'snow',
        'torch', 'wall_torch', 'dandelion', 'poppy', 'red_mushroom',
    ];
    const bad = passable.filter(n => classifyBlock(n) !== null);
    console.log(`  检查 ${passable.length} 种可穿过方块，误判 ${bad.length} 种`);
    if (bad.length) console.log(`    误判: ${bad.join(', ')}`);
    check('可穿过的植物都不产生可站立面', bad.length === 0, bad.join(', '));
    // 反向：真正的实心不能被漏掉
    check('stone 仍是 SOLID', classifyBlock('stone') === T.SOLID, '');
    check('grass_block 仍是 SOLID', classifyBlock('grass_block') === T.SOLID, '');
}


console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
try { rmSync(DIR, { recursive: true, force: true }); } catch { }
process.exit(failed ? 1 : 0);
