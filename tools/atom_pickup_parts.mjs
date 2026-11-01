/**
 * 拆分后的原子验收：findDrops（纯查询）+ waitForItem（只等）。
 *
 * 起因（用户判断）：「拆的还不够原子，这样污染应该好查一些」。
 * 拆前的矛盾症状：collectDrops 报 TIMEOUT，但背包其实 +1。
 *
 * 本测试要证明三件事：
 *   1) findDrops 能单独跑、能数出掉落物、能区分"真没有"和"半径不够"
 *   2) waitForItem 能单独跑、失败就是"真没等到"，不含任何移动
 *   3) 两者组合能把"捡到没有"判定得一清二楚（不再自相矛盾）
 *
 * 用法：node tools/atom_pickup_parts.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { findDrops } from '../src/agent/library/query_drops.js';
import { waitForItem } from '../src/agent/library/atom_wait_item.js';
import { countItem } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'pp' + (Date.now() % 100000);

let pass = 0, fail_ = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
    else { fail_++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(1200);
    const p = bot.entity.position.floored();
    await RC(`fill ${p.x - 3} ${p.y} ${p.z - 3} ${p.x + 10} ${p.y + 6} ${p.z + 3} air`);
    await RC(`fill ${p.x - 3} ${p.y - 1} ${p.z - 3} ${p.x + 10} ${p.y - 1} ${p.z + 3} stone`);
    await sleep(1200);

    const count = () => countItem(bot, 'oak_log');

    // ================= findDrops =================
    console.log('\n=== findDrops（纯查询）===');

    // 1) 附近没东西 —— 先清掉场地里遗留的掉落物（前面测试会留下很多）
    await RC('kill @e[type=item]');
    await sleep(800);
    const empty = findDrops(bot, { radius: 8 });
    check('没掉落物 → NO_TARGET', empty.code === 'NO_TARGET', `code=${empty.code}`);
    check('仍然返回 radius/near（能判断是不是半径问题）',
        empty.data?.radius === 8 && !!empty.data?.near,
        `radius=${empty.data?.radius} seen=${empty.data?.seenInWorld}`);

    // 2) 造一个掉落物：用 summon item
    //    放在 bot 附近 3 格
    const dropX = p.x + 3, dropZ = p.z;
    await RC(`summon item ${dropX} ${p.y} ${dropZ} {Item:{id:"minecraft:oak_log",Count:1b}}`);
    await sleep(1500);

    const found = findDrops(bot, { radius: 8 });
    check('有掉落物 → 能找到', found.ok, `code=${found.code} count=${found.data?.count}`);
    check('数出至少 1 个', (found.data?.count ?? 0) >= 1, `count=${found.data?.count}`);
    check('带最近距离', typeof found.data?.nearestDist === 'number', `nearestDist=${found.data?.nearestDist}`);
    check('带精确坐标（不是只有地板化坐标）',
        !!found.data?.items?.[0]?.exactPos,
        JSON.stringify(found.data?.items?.[0]?.exactPos));

    // 3) 半径不够时，能看出"视野里有但超范围"
    const tooSmall = findDrops(bot, { radius: 1 });
    check('★ 半径太小时能区分"真没有"和"超范围"',
        tooSmall.code === 'NO_TARGET' && (tooSmall.data?.seenInWorld ?? 0) > 0,
        `seenInWorld=${tooSmall.data?.seenInWorld} msg=${String(tooSmall.message).slice(0, 30)}`);

    // 4) NaN 坐标防护
    const nanBot = { entity: { position: { x: NaN, y: 0, z: 0 } }, entities: {} };
    const nanRes = findDrops(nanBot, {});
    check('自己坐标 NaN → INTERNAL（不硬算）', nanRes.code === 'INTERNAL', `code=${nanRes.code}`);

    // ================= waitForItem =================
    console.log('\n=== waitForItem（只等，不动）===');

    // 5) 等一个不会发生的变化 → 必须 TIMEOUT，且不移动
    const beforePos = bot.entity.position.floored();
    const r5 = await waitForItem(bot, { countFn: () => 999, timeoutMs: 600, intervalMs: 100 });
    check('数量不变 → TIMEOUT', r5.code === 'TIMEOUT', `code=${r5.code}`);
    check('报告 waitedMs / polls', typeof r5.data?.waitedMs === 'number' && typeof r5.data?.polls === 'number',
        `waitedMs=${r5.data?.waitedMs} polls=${r5.data?.polls}`);
    const afterPos = bot.entity.position.floored();
    check('★ 只等不动（位置没变）',
        beforePos.x === afterPos.x && beforePos.z === afterPos.z,
        `${beforePos.x},${beforePos.z} → ${afterPos.x},${afterPos.z}`);

    // 6) 中途数量变化 → 成功，且报告增量
    let fake = 100;
    const inc = setInterval(() => { fake++; }, 100);
    const r6 = await waitForItem(bot, { countFn: () => fake, timeoutMs: 3000, intervalMs: 100 });
    clearInterval(inc);
    check('★ 数量增加 → 成功', r6.ok, `code=${r6.code}`);
    check('报告增量', (r6.data?.gained ?? 0) >= 1, `gained=${r6.data?.gained}`);

    // 7) base 显式传入时，只算"这次"的增量（BUG-002 的教训）
    let fixed = 50;
    const r7 = await waitForItem(bot, { countFn: () => fixed, base: 50, timeoutMs: 500, intervalMs: 100 });
    check('★ base 已达标时不误报成功（minGain=1 语义）',
        r7.code === 'TIMEOUT',
        `code=${r7.code} gained=${r7.data?.gained}`);

    // 8) countFn 抛错 → INTERNAL（判据不可用，比超时更该被知道）
    const r8 = await waitForItem(bot, {
        countFn: () => { throw new Error('背包没就绪'); },
        timeoutMs: 400, intervalMs: 100,
    });
    check('★ countFn 一直抛错 → INTERNAL', r8.code === 'INTERNAL', `code=${r8.code} msg=${String(r8.message).slice(0, 30)}`);

    // ================= 组合：判定不再自相矛盾 =================
    console.log('\n=== 组合：先等、再找、再等 ===');
    const base = count();
    // 造一个新掉落物，然后等它被吸进来
    await RC(`summon item ${p.x + 1} ${p.y} ${p.z} {Item:{id:"minecraft:oak_log",Count:1b}}`);
    const w = await waitForItem(bot, { countFn: count, base, timeoutMs: 4000 });
    const realGain = count() - base;
    check('★ 判据与实际一致（不再"报超时但背包+1"）',
        (w.ok === true) === (realGain >= 1),
        `waitForItem.ok=${w.ok} 实际增量=${realGain}`);

    console.log(`\n拆分原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
