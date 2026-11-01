// B1 验收：感知层 10 个场景。
// 前置：测试服 25566 / RCON 25576 已启动；超平坦，地表 y=-61，站人 y=-60。
import mineflayer from 'mineflayer';
import { rcon } from './rcon.mjs';
import {
    blockAt, findBlocks, canReach, reachDistanceTo, countItem, playerPos, blockBelow,
} from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;

function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8',
});
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });

const RC = (c) => rcon(c);
async function setBlock(x, y, z, block) {
    await RC(`setblock ${x} ${y} ${z} minecraft:${block}`);
    await sleep(180);
}
async function clearArea() {
    for (const y of [-60, -59, -58]) {
        await RC(`fill -6 ${y} -6 8 ${y} 8 air`);
    }
    await RC('tp probe 0.5 -60 0.5');
    await sleep(400);
}

bot.once('spawn', async () => {
    await sleep(2000);
    await RC('op probe');
    await RC('gamemode survival probe');
    await RC('clear probe');
    await RC('tp probe 0.5 -60 0.5');
    await sleep(600);

    const p = bot.entity.position;
    console.log(`位置 (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})  eyeHeight=${bot.entity.eyeHeight}  canSeeBlock=${typeof bot.canSeeBlock}`);
    console.log('');

    // 1. 3 格外可见方块 → 够得着
    await clearArea();
    await setBlock(3, -60, 0, 'oak_log');
    check('1) 3 格外 oak_log 可够着', canReach(bot, { x: 3, y: -60, z: 0 }) === true,
        `dist=${reachDistanceTo(bot, { x: 3, y: -60, z: 0 }).toFixed(2)}`);

    // 2. 6 格外 → 够不着
    await setBlock(6, -60, 0, 'stone');
    check('2) 6 格外 stone 够不着', canReach(bot, { x: 6, y: -60, z: 0 }) === false,
        `dist=${reachDistanceTo(bot, { x: 6, y: -60, z: 0 }).toFixed(2)}`);

    // 3. 隔一堵两格高的墙 → 够不着
    await clearArea();
    await setBlock(3, -60, 0, 'oak_log');
    await setBlock(2, -60, 0, 'stone');
    await setBlock(2, -59, 0, 'stone');
    check('3) 隔墙 oak_log 够不着', canReach(bot, { x: 3, y: -60, z: 0 }) === false,
        `dist=${reachDistanceTo(bot, { x: 3, y: -60, z: 0 }).toFixed(2)}`);

    // 4. 下方 3 格 + 横向 2 格 → 超距
    await clearArea();
    await setBlock(2, -63, 0, 'stone');
    const d4 = reachDistanceTo(bot, { x: 2, y: -63, z: 0 });
    check('4) 斜下方 4.6 格够不着', canReach(bot, { x: 2, y: -63, z: 0 }) === false && d4 > 4.3,
        `dist=${d4.toFixed(2)}`);

    // 5. 头顶正上方一格 → 够得着
    await clearArea();
    await setBlock(0, -58, 0, 'stone');
    check('5) 头顶 1 格 stone 可够着', canReach(bot, { x: 0, y: -58, z: 0 }) === true,
        `dist=${reachDistanceTo(bot, { x: 0, y: -58, z: 0 }).toFixed(2)}`);

    // 6. findBlocks 只返回目标方块，且按距离排序
    await clearArea();
    await setBlock(5, -60, 2, 'oak_log');
    await setBlock(5, -60, 3, 'oak_log');
    await setBlock(3, -60, 4, 'oak_log');
    await setBlock(4, -60, 5, 'stone');
    const logs = findBlocks(bot, 'oak_log', 32, 16);
    check('6) findBlocks 只返回 3 个 oak_log', logs.length === 3,
        `实际 ${logs.length}，名字=${logs.map(b => b.name).join(',')}`);
    const sorted = logs.every((b, i) => i === 0 || logs[i - 1].position.distanceTo(bot.entity.position) <= b.position.distanceTo(bot.entity.position));
    check('6b) 结果按距离升序', sorted);

    // 7. 水也能查到（特殊方块）
    await setBlock(2, -60, 6, 'water');
    const water = findBlocks(bot, 'water', 16, 8);
    check('7) findBlocks 能查到 water', water.length >= 1, `${water.length} 个`);

    // 8. 未加载区块 → 空数组，不抛（先清掉半径内所有 stone，否则测的是“附近有没有石头”）
    await clearArea();
    await RC('fill -6 -63 -6 8 -63 8 air');
    await sleep(200);
    await RC('setblock 2000 -60 2000 minecraft:stone');
    const far = findBlocks(bot, 'stone', 32, 16);
    check('8) 未加载区块不返回、半径内为 0', Array.isArray(far) && far.length === 0, `${far.length} 个`);

    // 9. 背包计数
    await RC('give probe oak_log 3');
    await RC('give probe oak_planks 1');
    await sleep(600);
    check('9) countItem 计数正确', countItem(bot, 'oak_log') === 3 && countItem(bot, 'oak_planks') === 1,
        `log=${countItem(bot, 'oak_log')} plank=${countItem(bot, 'oak_planks')}`);

    // 10. 玩家坐标 / 不在线
    const self = playerPos(bot, 'probe');
    check('10) playerPos 拿到自己', !!self && Math.abs(self.x - bot.entity.position.x) < 0.5);
    check('10b) 不在线的玩家返回 null', playerPos(bot, 'nobody_here') === null);

    // 附加：脚下方块
    // 这里测的是「环境假设」，所以自己把脚下还原成草地，不依赖上一个套件留下的地形。
    await RC('fill -2 -61 -2 2 -61 2 grass_block');
    await RC('setblock 0 -60 0 air');
    await RC('tp probe 0.5 -60 0.5');
    await sleep(500);
    check('11) blockBelow 是 grass_block', blockBelow(bot, bot.entity.position)?.name === 'grass_block',
        blockBelow(bot, bot.entity.position)?.name ?? 'null');

    // 清场
    await clearArea();
    await RC('clear probe');

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
