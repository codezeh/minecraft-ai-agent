/**
 * atom_safe 的独立验收（测试服 25566 超平坦）。
 *
 * 造真实危险场景验证：岩浆是致命、僵尸是危险、远处岩浆也要发现（两个真相那条）。
 *
 * 用法：node tools/atom_safe.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { isSafe } from '../src/agent/library/query_safe.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const BASE = 2100;
const NAME = 'as' + (Date.now() % 100000);

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
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 120)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    for (let i = 0; i < 3; i++) {
        await RC(`tp ${NAME} ${BASE} -60 ${BASE}`);
        await sleep(1200);
        if (Math.abs(bot.entity.position.x - BASE) < 5) break;
    }
    try { bot.creative.stopFlying(); } catch { }
    await sleep(800);

    const p = bot.entity.position.floored();
    // 清一片干净场地（小范围）
    await RC(`fill ${p.x - 8} ${p.y} ${p.z - 8} ${p.x + 8} ${p.y + 3} ${p.z + 8} air`);
    await RC(`fill ${p.x - 8} ${p.y - 1} ${p.z - 8} ${p.x + 8} ${p.y - 1} ${p.z + 8} stone`);
    await RC(`kill @e[type=!player]`);
    await sleep(1500);

    // 1) 干净场地 → 安全
    const r1 = isSafe(bot);
    check('干净场地判安全', r1.ok && r1.data?.safe === true,
        `safe=${r1.data?.safe} reasons=${JSON.stringify(r1.data?.reasons)}`);
    check('干净场地 hostiles=0', r1.data?.hostiles === 0);
    check('安全时给 note（明示不是保证）', typeof r1.data?.note === 'string',
        `note=${r1.data?.note}`);

    // 2) 附近放岩浆 → 不安全
    await RC(`setblock ${p.x + 3} ${p.y} ${p.z} lava`);
    await sleep(800);
    const r2 = isSafe(bot);
    check('★ 附近岩浆 → 不安全', r2.ok && r2.data?.safe === false,
        `safe=${r2.data?.safe} reasons=${JSON.stringify(r2.data?.reasons)}`);
    check('★ 报出致命 hazard', (r2.data?.nearHazards ?? 0) > 0,
        `nearHazards=${r2.data?.nearHazards} lethal 相关=见 reasons`);

    // 清理岩浆
    await RC(`setblock ${p.x + 3} ${p.y} ${p.z} air`);
    await RC(`setblock ${p.x + 3} ${p.y - 1} ${p.z} stone`);
    await sleep(800);

    // 3) ★ 两个真相那条：岩浆在采样半径外、枚举半径内（6 格）
    //    原实现只采样 ±4 会漏掉，这条专门验证"远处也算危险"
    const far = { x: p.x + 6, y: p.y - 1, z: p.z };
    await RC(`setblock ${far.x} ${far.y} ${far.z} lava`);
    await sleep(800);
    const r3 = isSafe(bot);
    check('★ 6 格外的岩浆也能发现（不只 ±4 采样）',
        r3.data?.safe === false && (r3.data?.nearHazards ?? 0) > 0,
        `safe=${r3.data?.safe} nearHazards=${r3.data?.nearHazards} liquids=${r3.data?.liquids}`);
    await RC(`setblock ${far.x} ${far.y} ${far.z} stone`);
    await sleep(600);

    // 4) 敌对生物
    await RC(`summon zombie ${p.x + 4} ${p.y} ${p.z} {NoAI:1b}`);
    await sleep(1200);
    const r4 = isSafe(bot);
    check('★ 附近僵尸 → 不安全', r4.data?.safe === false && (r4.data?.hostiles ?? 0) > 0,
        `hostiles=${r4.data?.hostiles} reasons=${JSON.stringify(r4.data?.reasons)}`);

    // 5) 动物不算危险
    await RC(`kill @e[type=zombie]`);
    await sleep(600);
    await RC(`summon cow ${p.x + 4} ${p.y} ${p.z} {NoAI:1b}`);
    await sleep(1200);
    const r5 = isSafe(bot);
    check('牛不算危险', r5.data?.safe === true && r5.data?.hostiles === 0,
        `safe=${r5.data?.safe} hostiles=${r5.data?.hostiles}`);
    await RC(`kill @e[type=cow]`);
    await sleep(600);

    // 6) 指定位置检查（不是自己脚下）
    const farPos = { kind: 'point', pos: { x: p.x + 30, y: p.y, z: p.z + 30 } };
    const r6 = isSafe(bot, farPos);
    check('可以查远处位置', r6.ok && r6.data?.pos?.x === p.x + 30,
        `pos=${JSON.stringify(r6.data?.pos)}`);

    // 7) 参数校验
    check('无效 target → NO_TARGET', isSafe(bot, { kind: 'ufo' }).code === 'NO_TARGET');
    check('target 无 pos → NO_TARGET', isSafe(bot, { kind: 'point' }).code === 'NO_TARGET');

    // 8) 自己坐标 NaN
    const saved = bot.entity.position.clone();
    bot.entity.position.x = NaN;
    const r8 = isSafe(bot);
    bot.entity.position.x = saved.x;
    check('自己 NaN → INTERNAL', r8.code === 'INTERNAL', `code=${r8.code}`);

    console.log(`\nsafe 原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
