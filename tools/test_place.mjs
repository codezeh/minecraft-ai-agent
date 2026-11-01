// B4 验收：放置 20 次 + 边缘/失败路径。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { placeBlockAt } from '../src/agent/library/act_place.js';
import { blockAt } from '../src/agent/library/query_perceive.js';
import { isResult, CODES } from '../src/agent/library/contract.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });
const RC = (c) => rcon(c);

async function reset() {
    bot.interrupt_code = false;
    await RC('fill -6 -60 -6 10 -54 10 air');
    await RC('fill -6 -61 -6 10 -61 10 grass_block');   // 补回地面：有的用例会挖掉 -61
    await RC('tp probe 0.5 -60 0.5');
    await sleep(900);
    // 确认地面真的回来了，否则后面的 NO_SUPPORT 会误判
    const ground = blockAt(bot, { x: 1, y: -61, z: 1 })?.name;
    if (ground !== 'grass_block') console.log(`        [reset 警告] (1,-61,1)=${ground}`);
}

function expect(label, r, code) {
    const shape = isResult(r) && JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['code', 'data', 'message', 'ok']);
    const good = shape && CODES.includes(r.code) && (code ? r.code === code : true);
    check(label, good, `code=${r.code}${code && r.code !== code ? `(期望${code})` : ''}`);
    return r;
}

bot.once('spawn', async () => {
    await sleep(1800);
    await RC('op probe');
    await RC('clear probe');
    await RC('gamemode survival probe');
    await RC('give probe dirt 64');
    await RC('give probe stone 64');
    await sleep(500);

    // 场景自洽：20 次放置必须在 tp + 地面复原之后跑。
    // 全套连跑时这里曾出现 0/20、平均 1ms —— 因为 bot 出生点停在上一个套件留下的位置，
    // 那些坐标不在加载区块里，blockAt 全是 null，第一步就返回 NO_TARGET。
    await reset();

    // ---- 20 次平地放置
    const spots = [];
    for (const y of [-60, -59, -58]) {
        for (const x of [1, 2, 3]) for (const z of [1, 2]) spots.push([x, y, z]);
        for (const x of [-1, -2, -3]) for (const z of [1, 2]) spots.push([x, y, z]);
    }
    let okCount = 0, shapeBad = 0;
    const fails = [];
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
        const [x, y, z] = spots[i];
        const r = await placeBlockAt(bot, { x, y, z }, 'dirt');
        const actual = blockAt(bot, { x, y, z })?.name;
        if (r.ok && actual === 'dirt') okCount++;
        else fails.push(`(${x},${y},${z}) code=${r.code} msg=${r.message} 实际=${actual}`);
        if (!isResult(r)) shapeBad++;
    }
    const dt = Date.now() - t0;
    check(`20 次平地放置成功 ${okCount}/20`, okCount >= 18, `用时 ${dt}ms 平均 ${Math.round(dt / 20)}ms/次`);
    if (fails.length) console.log('        失败明细:\n          ' + fails.slice(0, 8).join('\n          '));
    // 已知现象：连续快速放置时客户端 blockUpdate 偶尔丢失（单点复现 6/6 成功）。
    // 影响：复合层（platform）必须带重试，不能指望单次必成。
    if (fails.some(f => f.includes('blockUpdate'))) {
        console.log('        注：blockUpdate 丢失属于已知的客户端/服务端竞态，复合层需重试');
    }
    check('20 次返回形状全部合法', shapeBad === 0, `异常 ${shapeBad}`);

    // ---- 失败路径
    await reset();
    await RC('setblock 2 -60 0 minecraft:stone');
    await sleep(200);
    expect('目标被占 → OCCUPIED', await placeBlockAt(bot, { x: 2, y: -60, z: 0 }, 'dirt'), 'OCCUPIED');
    expect('没这个物品 → NO_ITEM', await placeBlockAt(bot, { x: 2, y: -59, z: 0 }, 'diamond_block'), 'NO_ITEM');
    // 支撑面是箱子（可交互方块不拿来垫）→ NO_SUPPORT
    await RC('setblock 1 -61 1 minecraft:chest');
    await sleep(200);
    expect('只挨着箱子 → NO_SUPPORT', await placeBlockAt(bot, { x: 1, y: -60, z: 1 }, 'dirt'), 'NO_SUPPORT');
    expect('太远 → OUT_OF_REACH', await placeBlockAt(bot, { x: 9, y: -60, z: 9 }, 'dirt'), 'OUT_OF_REACH');
    expect('自己的位置 → OCCUPIED', await placeBlockAt(bot, { x: 0, y: -60, z: 0 }, 'dirt'), 'OCCUPIED');

    // ---- 幂等：同一位置再放一次
    await reset();
    const r1 = await placeBlockAt(bot, { x: 2, y: -60, z: 2 }, 'dirt');
    const r2 = await placeBlockAt(bot, { x: 2, y: -60, z: 2 }, 'dirt');
    check('幂等：第二次返回 OK existed', r1.ok && r2.ok && r2.data?.existed === true, `r2=${JSON.stringify(r2)}`);

    // ---- ledge ×5：下方挖空，只能靠侧面的墙依附（规格 B4 验收：ledge 5 次全对）
    await reset();
    const ledges = [
        [1, 3, 2, 3],
        [3, 1, 4, 1],
        [-1, 3, -2, 3],
        [3, 3, 4, 3],
        [-3, 1, -4, 1],
    ];
    let ledgeOk = 0;
    for (const [tx, tz, wx, wz] of ledges) {
        await RC(`setblock ${tx} -61 ${tz} minecraft:air`);     // 抽掉下方地面
        await RC(`setblock ${wx} -60 ${wz} minecraft:stone`);   // 侧面的墙
        await sleep(220);
        const r = await placeBlockAt(bot, { x: tx, y: -60, z: tz }, 'dirt');
        const placed = blockAt(bot, { x: tx, y: -60, z: tz })?.name === 'dirt';
        const belowEmpty = blockAt(bot, { x: tx, y: -61, z: tz })?.name === 'air';
        // 下方是空、靠侧面依附 —— support 是 stone 还是相邻刚放的 dirt 都算对
        if (r.ok && placed && belowEmpty && r.data?.support) ledgeOk++;
        else console.log(`        [ledge 失败] (${tx},-60,${tz}) code=${r.code} msg=${r.message} support=${r.data?.support} 实际=${blockAt(bot, { x: tx, y: -60, z: tz })?.name} 下方=${blockAt(bot, { x: tx, y: -61, z: tz })?.name}`);
    }
    check('ledge ×5 靠侧面依附全对', ledgeOk === 5, `${ledgeOk}/5`);

    await reset();
    await RC('clear probe');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
