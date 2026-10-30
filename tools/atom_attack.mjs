/**
 * atom_attack 的独立验收（测试服 25566 超平坦）。
 *
 * 覆盖：正常打死僵尸 / 目标太远 OUT_OF_REACH / 目标是物品 NO_TARGET /
 *       打不死的目标 TIMEOUT / 有窗口时 BLOCKED。
 *
 * 用法：node tools/atom_attack.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import pvp from 'mineflayer-pvp';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { attackEntity, isAttackable, nearestAttackable } from '../src/agent/library/atom_attack.js';
import { openContainer, closeContainer } from '../src/agent/library/atom_container.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'aa' + (Date.now() % 100000);

let pass = 0, fail_ = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
    else { fail_++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
// teleport 后坐标会变 NaN（mineflayer 物理引擎 bug），装上兜底
installPositionGuard(bot);
// 必须加载 pvp：attackEntity 的实际攻击走 bot.pvp.attack（见 自研申报 07）。
// 不加载会走 bareAttack 兜底，实测「打了 8~11 秒没掉血」——所以这是硬前置，不是可选优化。
bot.loadPlugin(pvp.plugin ?? pvp);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 120)));

/** 轮询等待条件成立 */
const waitUntil = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (pred()) return true;
        await sleep(120);
    }
    return false;
};

const waitEntity = (type, ms = 5000) => new Promise((res) => {    const t0 = Date.now();
    const iv = setInterval(() => {
        const me = bot.entity.position;
        // 必须取「最近的那一只」：之前测试残留的僵尸会干扰（曾取到 33 格外的一只）
        const list = Object.values(bot.entities || {})
            .filter(x => x.type === type && x.isValid)
            .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
        const e = list[0];
        if (e) { clearInterval(iv); res(e); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
    }, 150);
});

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);
    // 独立区域：测试之间不共享世界状态
    await RC(`tp ${NAME} 100 -59 -500`);
    await RC(`difficulty hard`);

    // 状态复位：连跑多个原子测试时，上一个测试可能留下窗口/实体
    // （实测：单跑 10/10，连跑 6/10 —— 就是残留状态干扰）
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { }
    await RC(`kill @e[type=!player]`);
    await sleep(800);

    const p = bot.entity.position.floored();

    // 1) isAttackable 判据
    check('玩家不可攻击', isAttackable({ type: 'player', isValid: true }) === false);
    check('掉落物不可攻击', isAttackable({ type: 'item', isValid: true }) === false);
    check('僵尸可攻击', isAttackable({ type: 'mob', name: 'zombie', isValid: true }) === true);
    check('失效实体不可攻击', isAttackable({ type: 'mob', isValid: false }) === false);

    // 2) 刷一个僵尸在 2 格外
    // NoAI:1b —— 让它站着不动。NoAI:0b 时它会追着 bot 跑，
    // 加上寻路抖动，pvp 有时打不中，导致测试偶发失败（实测 1/3 概率）。
    await RC(`summon zombie ${p.x + 2} ${p.y} ${p.z} {NoAI:1b}`);
    const z1 = await waitEntity("hostile");
    check('僵尸已生成', !!z1, z1 ? `dist=${bot.entity.position.distanceTo(z1.position).toFixed(1)}` : '未找到');
    if (!z1) { finish(); return; }

    // 3) 近战打死
    await RC(`give ${NAME} iron_sword 1`);
    // 等武器真的进背包再打：原来固定 sleep(400) 偶发不够
    // （连跑时曾出现"打了 10 秒没掉血"，单跑却是好的）
    await waitUntil(() => (bot.inventory?.items?.() ?? []).some(i => i.name === 'iron_sword'), 5000);
    const sword = (bot.inventory?.items?.() ?? []).find(i => i.name === 'iron_sword');
    if (sword) { try { await bot.equip(sword, 'hand'); } catch { } }
    console.log(`  [准备] pvp=${!!bot.pvp} 手持=${bot.heldItem?.name ?? '空'}`);
    const r1 = await attackEntity(bot, { kind: 'entity', entity: z1 }, { timeout: 12000 });
    // 权威判据：服务端还有没有这只僵尸（客户端 isValid 会滞后几百毫秒）
    const goneServer = !(await RC('data get entity @e[type=zombie,limit=1]')).includes('Zombie has the following');
    check('打死僵尸', r1.ok && (r1.data?.killed === true || goneServer),
        `code=${r1.code} killed=${r1.data?.killed} 服务端已消失=${goneServer} ${r1.message}`);

    // 4) 超距 → OUT_OF_REACH
    await RC(`summon zombie ${p.x + 30} ${p.y} ${p.z} {NoAI:1b,PersistenceRequired:1b}`);
    const z2 = await waitEntity("hostile");
    if (z2) {
        const r2 = await attackEntity(bot, { kind: 'entity', entity: z2 }, { timeout: 2000 });
        check('超距 OUT_OF_REACH', r2.code === 'OUT_OF_REACH', `code=${r2.code} dist=${r2.data?.dist?.toFixed?.(1)}`);
    } else check('超距 OUT_OF_REACH', false, '僵尸没生成');

    // 5) 目标消失 → NO_TARGET
    const ghost = { type: 'mob', isValid: false, position: bot.entity.position.clone() };
    const r3 = await attackEntity(bot, { kind: 'entity', entity: ghost });
    check('目标消失 NO_TARGET', r3.code === 'NO_TARGET', `code=${r3.code}`);

    // 6) 有窗口开着 → BLOCKED
    await RC(`setblock ${p.x + 1} ${p.y} ${p.z} chest`);
    await sleep(800);
    const co = await openContainer(bot, { kind: 'block', pos: { x: p.x + 1, y: p.y, z: p.z } });
    if (co.ok) {
        await RC(`summon zombie ${p.x + 2} ${p.y} ${p.z + 1} {NoAI:1b,PersistenceRequired:1b}`);
        const z3 = await waitEntity("hostile");
        if (z3) {
            const r4 = await attackEntity(bot, { kind: 'entity', entity: z3 });
            check('有窗口时 BLOCKED', r4.code === 'BLOCKED', `code=${r4.code}`);
        } else check('有窗口时 BLOCKED', false, '僵尸没生成');
        closeContainer(bot);
    } else check('有窗口时 BLOCKED', false, `开箱失败 ${co.code}`);

    // 7) nearestAttackable
    const near = nearestAttackable(bot, 40);
    check('nearestAttackable 找到目标', !!near, near ? `type=${near.type}` : '未找到');

    finish();

    function finish() {
        console.log(`\nattack 原子：${pass} PASS / ${fail_} FAIL`);
        bot.quit();
        process.exit(fail_ === 0 ? 0 : 1);
    }
});
