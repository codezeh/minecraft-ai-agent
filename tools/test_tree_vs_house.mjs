// 验收：房子上的原木不能被砍，天然树能砍。
// 场景（超平坦测试服）：
//   A. 天然树：3 格高 oak_log + 周围 20+ 片 oak_leaves
//   B. 房子柱子：3 格高 oak_log + 周围铺 oak_planks / glass / stairs
// 期望：collect 只砍 A，不碰 B。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { collect } from '../src/agent/library/flow_collect.js';
import { countItem, blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c);

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', JSON.stringify(r).slice(0, 120)); process.exit(2); });

// 场景 A：天然树（树干 + 树冠）
const TREE = { x: 6, z: 0 };
// 场景 B：房子柱子（原木柱 + 木板墙/玻璃）
const HOUSE = { x: -6, z: 0 };

async function buildScene() {
    bot.interrupt_code = false;
    await RC('fill -14 -60 -14 14 -58 14 air');
    await RC('fill -14 -61 -14 14 -61 14 grass_block');

    // 顺序很重要：先铺「外壳」（树叶/木板），最后放「原木」，
    // 否则填充会把原木一起覆盖掉（第一次就是这么把场景搭坏的）。

    // A 天然树：树冠在树干【上方】，不要把树干包死（真实树就是这样；
    // 包死的话连站的地方都没有，那是场景搭错，不是逻辑错）
    await RC(`fill ${TREE.x - 2} -57 ${TREE.z - 2} ${TREE.x + 2} -56 ${TREE.z + 2} oak_leaves`);
    await RC(`fill ${TREE.x} -60 ${TREE.z} ${TREE.x} -58 ${TREE.z} oak_log`);

    // B 房子：先外壳（木板/玻璃/楼梯），后原木柱
    await RC(`fill ${HOUSE.x - 2} -60 ${HOUSE.z - 2} ${HOUSE.x + 2} -57 ${HOUSE.z + 2} oak_planks`);
    await RC(`setblock ${HOUSE.x - 2} -59 ${HOUSE.z} glass`);
    await RC(`setblock ${HOUSE.x + 2} -59 ${HOUSE.z} oak_stairs`);
    await RC(`fill ${HOUSE.x} -60 ${HOUSE.z} ${HOUSE.x} -58 ${HOUSE.z} oak_log`);

    await RC('tp probe 0.5 -60 0.5');
    await sleep(1200);
}

function treeIntact() {
    let n = 0;
    for (let y = -60; y <= -58; y++) if (blockAt(bot, { x: TREE.x, y, z: TREE.z })?.name === 'oak_log') n++;
    return n;
}
function houseIntact() {
    let n = 0;
    for (let y = -60; y <= -58; y++) if (blockAt(bot, { x: HOUSE.x, y, z: HOUSE.z })?.name === 'oak_log') n++;
    return n;
}

bot.once('spawn', async () => {
    await sleep(1800);
    await RC('op probe');
    await RC('gamemode survival probe');
    await buildScene();

    check('场景搭好：树 3 格原木、房子 3 格原木', treeIntact() === 3 && houseIntact() === 3,
        `树=${treeIntact()} 房子=${houseIntact()}`);

    // 只要 3 个：刚好够砍掉那棵树
    await RC('clear probe');
    await RC('give probe iron_axe 1');
    await sleep(600);

    const r = await collect(bot, 'oak_log', 3, { deadlineMs: 60000 });

    const treeLeft = treeIntact();
    const houseLeft = houseIntact();
    check('天然树被砍掉（树干消失）', treeLeft === 0, `剩 ${treeLeft}/3 格`);
    check('房子上的原木一根没动', houseLeft === 3, `剩 ${houseLeft}/3 格`);
    console.log(`        collect 返回：code=${r.code} collected=${r.data?.count} msg=${r.message ?? ''}`);

    // 反向验证：只给房子的原木、没有任何树冠 → 应该拒绝并说明
    await buildScene();
    await RC(`fill ${TREE.x} -60 ${TREE.z} ${TREE.x} -58 ${TREE.z} air`);   // 去掉天然树，只留房子
    await sleep(800);
    const r2 = await collect(bot, 'oak_log', 3, { deadlineMs: 45000 });
    const houseAfter = houseIntact();
    check('只剩房子原木时，拒绝砍并如实说明', !r2.ok && houseAfter === 3,
        `code=${r2.code} msg=${r2.message} 房子剩 ${houseAfter}/3`);

    await RC('clear probe');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
