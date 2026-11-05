/**
 * 垫脚清单 id 错配回归（【活 bug】，2026-11-05）—— 不需要服务器。
 *
 * 修的什么：
 *   `scafoldingBlocks` 要的是 **item id**，而两处生产代码曾经都喂 **block id**：
 *     · scaffold_blocks.js  scaffoldBlockIds()  → registry.blocksByName[name].id
 *     · skills.js           buildMovements()    → mc.getBlockId(name)
 *   而 mineflayer-pathfinder 的判据是：
 *     movements.js:86-88  this.scafoldingBlocks.push(registry.itemsByName.dirt.id)
 *     movements.js:159    if (item.type === id) count += item.count   // item.type = item id
 *
 *   于是除 `stone`/`andesite`/`diorite`/`granite`（1.21.8 里两种 id 巧合相同）以外
 *   **全部数不到** → `countScaffoldingItems()` = 0 → A* 的 `remainingBlocks === 0`
 *   （movements.js:346/352/404/567）→ 所有"放方块走过去"的分支直接 return
 *   → 明明带着木板，遇沟坎却绕远路 / NO_PATH，**而且不报错**。
 *
 * 本文件守三层（缺一层就会重演"测了但测不了错"）：
 *   ① **契约层**：`scaffoldIdReport()` 返回的每个 id 都必须能被 `item.type === id` 命中
 *      —— 这正是 pathfinder 的比对方式，不是我们自己编的。
 *   ② **行为层**：用**真 A\***（pathfinder 的 `AStar`，纯函数、不启服）跑一道无底深沟，
 *      并且**两条入口各跑一遍**（`nav_pathfinder.makeMovements` 与 `skills.buildMovements`）：
 *      同一个 movements 只把 `scafoldingBlocks` 换成 block id，看 A* 是否从"垫过去"变成"绕远路"。
 *      只验一条 = 漏掉一半的静默失效（用户撞上哪条取决于入口）。
 *   ③ **结构层**：两个文件都只许查 itemsByName，不许再出现 blocksByName 取垫脚 id。
 *
 * 反向验证（把取值改回 block id，两个文件各跑一遍）：
 *   node tools/scaffold_ids_unit.mjs                                                         # 绿
 *   SCAFFOLD_MODULE=../tmp/red_scaffold/mutated.js node tools/scaffold_ids_unit.mjs           # 红（scaffold_blocks.js）
 *   SKILLS_MODULE=../tmp/red_scaffold/skills_mutated.js node tools/scaffold_ids_unit.mjs      # 红（skills.js）
 *
 * 输出：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import mcDataFactory from 'minecraft-data';
import Vec3 from 'vec3';

const SCAFFOLD = process.env.SCAFFOLD_MODULE ?? '../src/agent/library/scaffold_blocks.js';
const SKILLS = process.env.SKILLS_MODULE ?? '../src/agent/library/skills.js';
// nav_pathfinder 是"第二条入口"，反向验证时要能把它指到变异副本
// （它内部 `import './scaffold_blocks.js'` 是相对路径，只改 SCAFFOLD_MODULE 到不了它）。
const NAV = process.env.NAV_MODULE ?? '../src/agent/library/nav_pathfinder.js';

const require = createRequire(import.meta.url);
const pf = require('mineflayer-pathfinder');
const AStar = require('mineflayer-pathfinder/lib/astar');
const Move = require('mineflayer-pathfinder/lib/move');
const BlockFactory = require('prismarine-block');

const mcData = mcDataFactory('1.21.8');
const Block = BlockFactory(mcData);

const mod = await import(SCAFFOLD);
const navMod = await import(NAV);
const skills = await import(SKILLS);

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, actual) => { fail++; console.log(`FAIL ${n} ${actual}`); };

console.log(`被测模块：scaffold=${SCAFFOLD}`);
console.log(`                skills=${SKILLS}`);
console.log(`                nav=${NAV}`);

/** 背包物品：`type` 一定是 **item id**（mineflayer 的 item.type 就是它）。 */
const item = (name, count, slot) => ({ name, count, type: mcData.itemsByName[name].id, slot });

function fakeBot(items) {
    return {
        registry: mcData,
        entity: {
            position: new Vec3(0.5, 64, 0.5), effects: {},
            isInWater: false, isInLava: false, onGround: true, height: 1.8, width: 0.6,
        },
        inventory: { items: () => items },
        game: { dimension: 'overworld', gameMode: 'survival' },
        pathfinder: { bestHarvestTool: () => null },
        modes: { isOn: () => false, pause: () => { }, unpause: () => { } },
        output: '',
    };
}

// ── ① 契约层：返回的每个 id 都必须被 `item.type === id` 命中 ─────────────────
//   至少覆盖 oak_planks / cobblestone / dirt / **stone**（stone 是"巧合也能过"的对照组，
//   只测它等于没测 —— 它的 block id 与 item id 恰好都是 1）。
{
    const names = ['oak_planks', 'cobblestone', 'dirt', 'stone'];
    const items = names.map((n, i) => item(n, 3 + i, 36 + i));
    const bot = fakeBot(items);
    const ids = mod.scaffoldItemIds ? mod.scaffoldItemIds(bot) : mod.scaffoldBlockIds(bot);
    const report = mod.scaffoldIdReport ? mod.scaffoldIdReport(bot) : { ids, skipped: [] };

    // pathfinder 的算法原样复现：只看 item.type === id
    const counted = items.filter((it) => ids.includes(it.type)).reduce((n, it) => n + it.count, 0);
    const expectTotal = 3 + 4 + 5 + 6;
    const missing = names.filter((n) => !ids.includes(mcData.itemsByName[n].id));
    const byType = names.map((n) => {
        const itemId = mcData.itemsByName[n].id, blockId = mcData.blocksByName[n].id;
        return `${n}: item=${itemId} block=${blockId}${itemId === blockId ? '(巧合相同)' : '(不同)'}→${ids.includes(itemId) ? '命中' : '未命中'}`;
    }).join(' | ');

    if (missing.length === 0 && counted === expectTotal) {
        okCase('四种垫脚料（含 stone 对照）的 item id 全在清单里且都数得到',
            `ids=${JSON.stringify(ids)} 计数=${counted}/${expectTotal}`);
    } else {
        badCase('清单里应含这四种的 **item id**',
            `缺=${JSON.stringify(missing)} ids=${JSON.stringify(ids)} 计数=${counted}/${expectTotal}`);
    }
    console.log(`       ${byType}`);

    if (report.skipped.length === 0) {
        okCase('这四种都取得到 item id（没有误跳过）', `skipped=${JSON.stringify(report.skipped)}`);
    } else {
        badCase('不该跳过任何一种', JSON.stringify(report.skipped));
    }
}

// ── ② 只有方块没有 item 的名字：跳过并记录，**不许**塞 block id ───────────────
{
    const ghost = 'dirt';                       // 名字合法（在垫脚清单里），但把它的 item 抹掉
    const bot = fakeBot([item(ghost, 5, 36), item('cobblestone', 2, 37)]);
    bot.registry = { ...mcData, itemsByName: { ...mcData.itemsByName, [ghost]: undefined } };
    const report = mod.scaffoldIdReport
        ? mod.scaffoldIdReport(bot)
        : { ids: mod.scaffoldBlockIds(bot), skipped: [] };

    const dirtIds = [mcData.blocksByName[ghost].id, mcData.itemsByName[ghost].id];
    const leaked = report.ids.filter((id) => dirtIds.includes(id));
    if (leaked.length === 0 && report.skipped.includes(ghost) && report.ids.includes(mcData.itemsByName.cobblestone.id)) {
        okCase('取不到 item id 时跳过并记录，不塞 block id',
            `ids=${JSON.stringify(report.ids)} skipped=${JSON.stringify(report.skipped)}`);
    } else if (!mod.scaffoldIdReport) {
        badCase('缺少 scaffoldIdReport（无法记录被跳过的名字）', `旧接口只返回 ids=${JSON.stringify(report.ids)}`);
    } else {
        badCase('应跳过并记录',
            `leaked=${JSON.stringify(leaked)} ids=${JSON.stringify(report.ids)} skipped=${JSON.stringify(report.skipped)}`);
    }
}

// ── ③ 行为层：真 A* 跑一道**无界裂谷**，两条入口各跑一遍 ─────────────────────
//
//   为什么两条都要跑：垫脚清单有两条生产路径，用户撞上哪条取决于入口 ——
//     · nav_pathfinder.makeMovements()  → moveTo / hopTo / path_short
//     · skills.buildMovements()         → goToGoal / goToPosition（技能层主路）
//
//   世界：y<=62 实心、y=63 是地板；z∈{3,4,5} **整片**挖空（x 方向无限延伸）——
//   绕不过去，唯一出路就是"放方块垫过去"。关掉跨沟跳跃（allowParkour=false）后，
//   那条分支的第一行正是 `if (node.remainingBlocks === 0) return`。
//   用无界裂谷（而不是有限宽的坑）是为了让结论二值化：要么垫过去，要么到不了。
{
    const GAP_Z = [3, 4, 5];
    const nameAt = (x, y, z) => (GAP_Z.includes(z) || y >= 64 ? 'air' : 'stone');

    const cache = new Map();
    const worldBlockAt = (pos) => {
        const k = `${pos.x},${pos.y},${pos.z}`;
        if (!cache.has(k)) {
            const b = Block.fromStateId(mcData.blocksByName[nameAt(pos.x, pos.y, pos.z)].defaultState, 0);
            b.position = new Vec3(pos.x, pos.y, pos.z);
            cache.set(k, b);
        }
        return cache.get(k);
    };

    const items = [item('oak_planks', 7, 36), item('cobblestone', 9, 37)];
    const blockIds = [...new Set(items.map((i) => mcData.blocksByName[i.name].id))];

    /** 跑一次真 A*，返回它"愿不愿意垫"的结论。 */
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
        { key: 'nav_pathfinder.makeMovements', make: (bot) => navMod.makeMovements(bot, { scaffold: true }) },
        { key: 'skills.buildMovements', make: (bot) => skills.buildMovements(bot, {}) },
    ];

    for (const entry of entries) {
        const bot = fakeBot(items);
        bot.blockAt = worldBlockAt;
        let m = null, threw = null;
        try { m = entry.make(bot); } catch (err) { threw = err; }
        if (!m) {
            badCase(`${entry.key}：应能建出 movements`, threw ? `抛错=${threw.message}` : '返回空');
            continue;
        }
        m.allowParkour = false;                 // 两条入口都"只能垫不能跳"，否则测不出差别

        const good = astar(m);                  // 现状（修好后应为 item id）
        m.scafoldingBlocks = blockIds;          // 同一个 movements，只换清单 → 一对一对照
        const bad = astar(m);

        if (good.count > 0 && good.status === 'success' && good.places >= 3) {
            okCase(`${entry.key}：清单喂 item id ⇒ A* 规划出**垫过去**的路径`,
                `count=${good.count} status=${good.status} 节点=${good.nodes} toPlace=${good.places}`);
        } else {
            badCase(`${entry.key}：喂 item id 时应规划垫脚路径`, JSON.stringify(good));
        }

        if (bad.count === 0 && bad.places === 0 && bad.status !== 'success') {
            okCase(`${entry.key}：清单喂 block id ⇒ 数到 0、**到不了对岸**（这就是那个 bug）`,
                `count=${bad.count} status=${bad.status} 节点=${bad.nodes} toPlace=${bad.places}`);
        } else {
            badCase(`${entry.key}：喂 block id 时不该还能过去`, JSON.stringify(bad));
        }

        if (good.places > bad.places) {
            okCase(`${entry.key}：id 类型决定"垫过去"还是"过不去"`,
                `垫脚 ${good.nodes} 节点/${good.places} 次放置 vs 错 id ${bad.nodes} 节点/${bad.places} 次放置(status=${bad.status})`);
        } else {
            badCase(`${entry.key}：id 类型必须改变 A* 的结论`,
                `good=${JSON.stringify(good)} bad=${JSON.stringify(bad)}`);
        }
    }

    // 对照：背包里真的没有垫脚料 ⇒ 关掉搭桥、同样过不去
    {
        const bot = fakeBot([]);
        bot.blockAt = worldBlockAt;
        const m = navMod.makeMovements(bot, { scaffold: true });
        m.allowParkour = false;
        const none = astar(m);
        if (none.count === 0 && none.places === 0 && none.status !== 'success' && m.allow1by1towers === false) {
            okCase('对照（背包无垫脚料）⇒ 关掉搭桥、过不去',
                `count=${none.count} status=${none.status} allow1by1towers=${m.allow1by1towers}`);
        } else {
            badCase('空背包时应关掉搭桥', JSON.stringify({ ...none, towers: m.allow1by1towers }));
        }
    }
}

// ── ④ 结构断言：两个文件都不许再用 blocksByName 取垫脚 id ────────────────────
{
    const srcScaffold = readFileSync(new URL(SCAFFOLD, import.meta.url), 'utf8');
    const okScaffold = /registry\?\.itemsByName\?\.\[it\.name\]\?\.id/.test(srcScaffold)
        && !/registry\?\.blocksByName\?\.\[it\.name\]\?\.id/.test(srcScaffold);
    if (okScaffold) {
        okCase('scaffold_blocks.js 只查 itemsByName（不再碰 blocksByName）', 'itemsByName ✓ / blocksByName ✗');
    } else {
        badCase('scaffold_blocks.js 必须只查 itemsByName', '仍出现 blocksByName 取 id');
    }

    // 垫脚段 = `// ---- 搭桥 / 垫脚 ----` 到 `const haveBlocks`（再往后是 blocksToAvoid，
    // 那一段**确实**该用 block id，不能一起判 —— 否则会把正确代码判成错）。
    // 判之前先剥掉注释：注释里会**提到**旧写法（"这里原来用 mc.getBlockId()"），
    // 那是文档不是代码 —— 不剥就会把解释性文字判成违规。
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const srcSkills = readFileSync(new URL(SKILLS, import.meta.url), 'utf8');
    const from = srcSkills.indexOf('// ---- 搭桥 / 垫脚 ----');
    const to = srcSkills.indexOf('const haveBlocks', from);
    const buildBody = from >= 0 && to > from ? stripComments(srcSkills.slice(from, to)) : '';
    const okSkills = /itemsByName\?\.\[name\]\?\.id/.test(buildBody) && !/getBlockId\(/.test(buildBody);
    if (okSkills) {
        okCase('skills.buildMovements 的垫脚清单只查 itemsByName', 'itemsByName ✓ / getBlockId ✗（已剥注释，只看代码）');
    } else {
        badCase('skills.buildMovements 必须只查 itemsByName',
            `找到垫脚段=${buildBody.length > 0} 用 getBlockId=${/getBlockId\(/.test(buildBody)}`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
