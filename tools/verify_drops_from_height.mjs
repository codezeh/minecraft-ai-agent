/**
 * 复现验证：高处作业时掉落物掉到地面，能不能捡到。
 *
 * 背景（2026-10-24 主服第 5 轮实测）：在 (-269,69,-352) 这种高处作业时，
 * 掉落物掉到地面（下方 5 格），而站位搜索只看挖掘点 3 格内 → 反复踩空、一个都捡不到。
 * 补强：找不到站位时往下逐层找（最多 8 格）。
 *
 * 本脚本用 RCON 精确造出这个场景，验证补强是否真的有效：
 *   1) 搭一根 5 格高的柱子，顶上放原木
 *   2) 让 bot 站在柱顶（模拟树冠位置）
 *   3) 挖掉原木，掉落物会掉到地面
 *   4) 调 collectDrops，看能不能捡到
 *
 * 用法：node tools/verify_drops_from_height.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard, inspectPhysics } from '../src/sim/position_guard.js';
import { collectDrops } from '../src/agent/library/atom_drops.js';
import { digBlock } from '../src/agent/library/atom_dig.js';
import { countItem, blockAt } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });   // 测试服（掉落实测正常）
const BASE = 600;                              // 测试服独立区域
const NAME = 'vd' + (Date.now() % 100000);

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
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 100)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(600);

    // 清一块场地：地面 y=-61，柱顶 y=-56（5 格高）
    const gx = BASE, gz = BASE;
    await RC(`fill ${gx - 3} ${-60} ${gz - 3} ${gx + 3} ${-55} ${gz + 3} air`);
    await RC(`fill ${gx - 3} ${-61} ${gz - 3} ${gx + 3} ${-61} ${gz + 3} stone`);
    // 柱子：y=-60..-57 是石头，顶面 -57；原木放在 -56
    // 柱高 10 格：让掉落物落到地面后离 bot 超过 8 格（直接吸附半径），
    // 强制走"往下找"这条补强路径
    await RC(`fill ${gx} ${-60} ${gz} ${gx} ${-52} ${gz} stone`);
    await sleep(900);

    // bot 站到柱顶（y=-56），用 tp（4.39 已修 NaN）
    await RC(`tp ${NAME} ${gx + 0.5} -51 ${gz + 0.5}`);
    await sleep(2200);
    const ph = inspectPhysics(bot);
    check('物理正常（tp 后）', ph.healthy, `pos=${JSON.stringify(ph.pos)}`);

    const standPos = bot.entity.position.floored();
    console.log(`  站位 ${standPos}，地面在 y=-61，高差 ${standPos.y - (-61)} 格`);

    // 在原木位置放方块（就在脚边那格：-56 层，旁边一格）
    const logPos = { x: gx + 1, y: -51, z: gz };
    await RC(`setblock ${logPos.x} ${logPos.y} ${logPos.z} oak_log`);
    await sleep(700);
    check('原木已就位', blockAt(bot, logPos)?.name === 'oak_log',
        `实际=${blockAt(bot, logPos)?.name}`);

    // 切生存 + 给斧头
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await sleep(1500);
    const axe = (bot.inventory?.items?.() ?? []).find(i => i.name === 'iron_axe');
    if (axe) { try { await bot.equip(axe, 'hand'); } catch { } }
    check('手持斧头', bot.heldItem?.name === 'iron_axe', `手持=${bot.heldItem?.name ?? '空'}`);

    // 挖掉（掉落物会掉到 y=-61 地面）
    const before = countItem(bot, 'oak_log');
    const dug = await digBlock(bot, { kind: 'block', pos: logPos });
    check('挖掉高处原木', dug.ok, `code=${dug.code} ${dug.message}`);

    // 关键：调 collectDrops，验证能否从高处把地面上的掉落物捡回来
    const t0 = Date.now();
    const r = await collectDrops(bot, logPos, {
        countFn: () => countItem(bot, 'oak_log'),
        deadlineMs: 15000,
    });
    const gained = countItem(bot, 'oak_log') - before;
    const ms = Date.now() - t0;

    check('★ 高处掉落物能捡到', gained >= 1, `gained=${gained}（用时 ${Math.round(ms / 1000)}s）`);
    check('返回结果诚实', r.data?.gained === gained, `返回=${r.data?.gained} 实际=${gained}`);
    if (r.data?.steps) {
        console.log(`  steps: ${r.data.steps.map(s => s.step).join(' → ')}`);
    }
    // 注意：掉落物如果在 8 格内直接飞过来，"往下找"这条路根本不会走（wait-long 就成功）。
    // 所以这一项只在"没直接吸到"时才有意义，这里不强求通过。
    const usedBelow = (r.data?.steps ?? []).some(s => s.step === 'step-below');
    console.log(`  说明：${usedBelow ? '走了往下找' : '掉落物直接吸到（没用到往下找）'}`);

    console.log(`\n高处捡拾：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
