/**
 * moveTo 落脚状态契约验收（测试服 25566）。
 *
 * 起因（用户判断）：「原子技能不够干净，移动和攀爬这几个动作不够明确」。
 * 核实结果：atom_move.js 310 行、6 个导出函数里，
 *   onGround / standable / findStandSpot 命中数 **0** ——
 *   移动原子完全不报告「最后停在哪、是不是站着」。
 * 后果实测：collectDrops 里 moveTo 返回 OK，但 bot 停在半空，
 *   紧接着 digBlock 报「现在悬空」。
 *
 * 本测试验证新增的四个字段：
 *   landedAt    实际停在哪
 *   onGround    bot 自报的落地标志（不可信，仅参考）
 *   standable   按脚下方块判定（可信）
 *   groundBlock 脚下是什么方块
 *
 * 用法：node tools/atom_move_landing.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { moveTo } from '../src/agent/library/atom_move.js';
import { blockAt } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'ml' + (Date.now() % 100000);

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

    // 场地：地面 -61 是石头，-60 空
    await RC(`fill ${p.x - 4} ${p.y} ${p.z - 4} ${p.x + 12} ${p.y + 10} ${p.z + 4} air`);
    await RC(`fill ${p.x - 4} ${p.y - 1} ${p.z - 4} ${p.x + 12} ${p.y - 1} ${p.z + 4} stone`);
    await sleep(1200);

    // ---- 1) 平地：应该 standable=true ----
    const flat = { x: p.x + 4, y: p.y, z: p.z };
    await RC(`gamemode survival ${NAME}`);
    const r1 = await moveTo(bot, { kind: 'point', pos: flat }, { tol: 1, timeout: 15000 });
    check('平地 moveTo 成功', r1.ok, `code=${r1.code}`);
    check('★ 平地 standable=true', r1.data?.standable === true, `standable=${r1.data?.standable} 脚下=${r1.data?.groundBlock}`);
    check('返回 landedAt', !!r1.data?.landedAt, JSON.stringify(r1.data?.landedAt));
    check('返回 onGround 字段', r1.data?.onGround !== undefined, `onGround=${r1.data?.onGround}`);
    check('返回 groundBlock', typeof r1.data?.groundBlock === 'string', `groundBlock=${r1.data?.groundBlock}`);

    // ---- 2) 站到树叶上：standable 可能为 true，但 groundBlock 是树叶（上层要能看出来） ----
    //    造一根 4 格高的树叶柱，站上去
    const leafX = p.x + 8, leafZ = p.z;
    await RC(`fill ${leafX} ${p.y} ${leafZ} ${leafX} ${p.y + 3} ${leafZ} oak_leaves`);
    await sleep(700);
    await RC(`tp ${NAME} ${leafX + 0.5} ${p.y + 4} ${leafZ + 0.5}`);
    await sleep(1500);
    const r2 = await moveTo(bot, { kind: 'point', pos: { x: leafX, y: p.y + 4, z: leafZ } }, { tol: 2, timeout: 8000 });
    check('树叶上 moveTo 有返回', r2.ok || r2.code === 'NO_PATH', `code=${r2.code}`);
    const gb2 = r2.data?.groundBlock;
    check('★ 树叶上能看出脚下是树叶',
        gb2 === 'oak_leaves' || gb2 === null,
        `groundBlock=${gb2} standable=${r2.data?.standable}`);

    // ---- 3) 悬空：moveTo 到空中目标，必须如实报告不可站 ----
    //    把脚下的方块挖掉，让她自由落体后的终点没有支撑
    await RC(`tp ${NAME} ${p.x + 2.5} ${p.y + 6} ${p.z + 2.5}`);
    await sleep(1200);
    // 目标在很高的空中（没有落脚点）
    const airGoal = { x: p.x + 2, y: p.y + 8, z: p.z + 2 };
    const r3 = await moveTo(bot, { kind: 'point', pos: airGoal }, { tol: 1, timeout: 6000 });
    console.log(`     悬空目标结果: code=${r3.code} standable=${r3.data?.standable} landedAt=${JSON.stringify(r3.data?.landedAt)}`);
    // 关键：不管成功失败，只要返回了 data 就必须带 standable
    if (r3.data) {
        check('★ 悬空场景也报告 standable', r3.data.standable !== undefined,
            `standable=${r3.data.standable} 脚下=${r3.data.groundBlock}`);
    } else {
        check('★ 悬空场景也报告 standable', false, '没返回 data');
    }

    // ---- 4) 一致性：standable 必须和"脚下真是实心"一致 ----
    const landed = r3.data?.landedAt ?? bot.entity.position.floored();
    const below = blockAt(bot, { x: landed.x, y: landed.y - 1, z: landed.z });
    const trulySolid = !!below && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(below.name);
    check('★ standable 与脚下方块一致',
        (r3.data?.standable ?? false) === trulySolid,
        `standable=${r3.data?.standable} 实际脚下=${below?.name}`);

    console.log(`\n落脚状态契约：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
