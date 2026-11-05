/**
 * 拐杖 id 错配的 A/B 探针（t8，2026-11-05）—— 用**真 A\*** 跑无界裂谷。
 *
 * 为什么单独留这份探针：`tools/scaffold_ids_unit.mjs` 里同样的结论已经固化成了断言，
 * 但排障时经常需要"手工换个世界/换个背包再看一眼"，那时直接跑这个比改测试快。
 *
 * 用法（bare import 要走 mindcraft/node_modules，所以必须**放进项目里跑**）：
 *   cd mindcraft && cp ../docs/audit/probes/t8-gap-probe.mjs tmp/ && node tmp/t8-gap-probe.mjs
 *   （临时拷进 tmp/ 即可，tmp/ 在 .gitignore 里）
 *
 * 期望输出（两条入口一致）：
 *   现况（item id）count=16 status=success 节点=9 toPlace=3
 *   换成 block id  count=0  status=partial 节点=2 toPlace=0
 *
 * 判据来源（两处，都在 pathfinder 自己源码里）：
 *   movements.js:86-88  this.scafoldingBlocks.push(registry.itemsByName.dirt.id)   ← item id
 *   movements.js:159    if (item.type === id) count += item.count                  ← item.type
 *   movements.js:346/352/404/567   if (node.remainingBlocks === 0) return          ← 静默禁用垫脚
 */
import { createRequire } from 'node:module';
import Vec3 from 'vec3';

const require = createRequire(import.meta.url);
const pf = require('mineflayer-pathfinder');
const AStar = require('mineflayer-pathfinder/lib/astar');
const Move = require('mineflayer-pathfinder/lib/move');
const BlockFactory = require('prismarine-block');
const mcData = require('minecraft-data')('1.21.8');
const Block = BlockFactory(mcData);

const skills = await import('../src/agent/library/skills.js');
const nav = await import('../src/agent/library/nav_pathfinder.js');

// 世界：y<=62 实心、y=63 地板；z∈{3,4,5} 整片（x 方向无限）挖空 = 无底裂谷。
// 绕不过去，唯一出路是"放方块垫过去"；关掉 parkour 后，那条分支的门槛就是 remainingBlocks。
const GAP_Z = [3, 4, 5];
const nameAt = (x, y, z) => (GAP_Z.includes(z) || y >= 64 ? 'air' : 'stone');
const cache = new Map();
const blockAt = (pos) => {
    const k = `${pos.x},${pos.y},${pos.z}`;
    if (!cache.has(k)) {
        const b = Block.fromStateId(mcData.blocksByName[nameAt(pos.x, pos.y, pos.z)].defaultState, 0);
        b.position = new Vec3(pos.x, pos.y, pos.z);
        cache.set(k, b);
    }
    return cache.get(k);
};

const items = [
    { name: 'oak_planks', count: 7, type: mcData.itemsByName.oak_planks.id, slot: 36 },
    { name: 'cobblestone', count: 9, type: mcData.itemsByName.cobblestone.id, slot: 37 },
];
const blockIds = [...new Set(items.map((i) => mcData.blocksByName[i.name].id))];

const bot = {
    registry: mcData,
    entity: { position: new Vec3(0.5, 64, 0.5), effects: {}, isInWater: false, isInLava: false, onGround: true, height: 1.8, width: 0.6 },
    inventory: { items: () => items },
    game: { dimension: 'overworld', gameMode: 'survival' },
    pathfinder: { bestHarvestTool: () => null },
    modes: { isOn: () => false, pause: () => { }, unpause: () => { } },
    output: '',
    blockAt,
};

const astar = (m) => {
    const count = m.countScaffoldingItems();
    const start = new Move(0, 64, 0, count, 0, [], [], false);
    const goal = new pf.goals.GoalNear(0, 64, 10, 1);
    const res = new AStar(start, m, goal, 4000).compute();
    const path = res.path ?? [];
    return {
        count,
        status: res.status,
        nodes: path.length,
        places: path.reduce((n, p) => n + (p.toPlace?.length ?? 0), 0),
    };
};

const entries = [
    ['nav_pathfinder.makeMovements', () => nav.makeMovements(bot, { scaffold: true })],
    ['skills.buildMovements', () => skills.buildMovements(bot, {})],
];

for (const [label, build] of entries) {
    const m = build();
    m.allowParkour = false;
    const good = astar(m);                     // 代码现状（应为 item id）
    m.scafoldingBlocks = blockIds;             // 同一个 movements，只换清单
    const bad = astar(m);
    console.log(`\n[${label}]`);
    console.log(`  现况（item id）：count=${good.count} status=${good.status} 节点=${good.nodes} toPlace=${good.places}`);
    console.log(`  换成 block id ：count=${bad.count} status=${bad.status} 节点=${bad.nodes} toPlace=${bad.places}`);
}
