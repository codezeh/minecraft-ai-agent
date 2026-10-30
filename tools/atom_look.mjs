/**
 * atom_look 的独立验收（测试服 25566 超平坦）。
 *
 * 重点：验证 yaw/pitch 真的转到了目标方向，而不是只看返回 code。
 *
 * 用法：node tools/atom_look.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { lookAt } from '../src/agent/library/atom_look.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const BASE = 1700;
const NAME = 'al' + (Date.now() % 100000);

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

const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const diff = (a, b) => Math.abs(norm(a - b));

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
    await sleep(600);
    const p = bot.entity.position.floored();

    // 1) 看向正东方（+x）的方块：yaw 应接近 -π/2
    const eastPos = { x: p.x + 5, y: p.y, z: p.z };
    await RC(`setblock ${eastPos.x} ${eastPos.y} ${eastPos.z} stone`);
    await sleep(700);
    const r1 = await lookAt(bot, { kind: 'block', pos: eastPos });
    check('看向方块成功', r1.ok, `code=${r1.code} ${r1.message}`);
    // minecraft yaw: 0 = +z(南), -π/2 = +x(东)
    check('★ yaw 指向 +x（约 -π/2）', diff(bot.entity.yaw, -Math.PI / 2) < 0.35,
        `yaw=${bot.entity.yaw.toFixed(2)} 期望≈${(-Math.PI / 2).toFixed(2)}`);
    check('返回 yaw/pitch', typeof r1.data?.yaw === 'number' && typeof r1.data?.pitch === 'number');
    check('返回 lookedAt', !!r1.data?.lookedAt);

    // 2) 看向正北方（-z）：yaw 应接近 0
    const northPos = { x: p.x, y: p.y, z: p.z - 5 };
    await RC(`setblock ${northPos.x} ${northPos.y} ${northPos.z} stone`);
    await sleep(700);
    const r2 = await lookAt(bot, { kind: 'block', pos: northPos });
    check('看向 -z 成功', r2.ok, `code=${r2.code}`);
    check('★ yaw 指向 -z（约 0）', diff(bot.entity.yaw, 0) < 0.35,
        `yaw=${bot.entity.yaw.toFixed(2)} 期望≈0`);

    // 3) 看向天顶（pitch 应接近 +π/2）
    const r3 = await lookAt(bot, { kind: 'point', pos: { x: p.x, y: p.y + 20, z: p.z } });
    check('看向高处成功', r3.ok, `code=${r3.code}`);
    check('★ pitch 抬高', bot.entity.pitch > 0.8, `pitch=${bot.entity.pitch.toFixed(2)}`);

    // 4) 看向脚下（pitch 应接近 -π/2）
    const r4 = await lookAt(bot, { kind: 'point', pos: { x: p.x, y: p.y - 20, z: p.z } });
    check('看向低处成功', r4.ok, `code=${r4.code}`);
    check('★ pitch 压低', bot.entity.pitch < -0.8, `pitch=${bot.entity.pitch.toFixed(2)}`);

    // 5) 实体：刷僵尸，看向它
    await RC(`kill @e[type=!player]`);
    await sleep(500);
    await RC(`summon zombie ${p.x + 3} ${p.y} ${p.z} {NoAI:1b}`);
    await sleep(1200);
    const z = Object.values(bot.entities || {}).find(e => e.name === 'zombie' && e.isValid);
    check('僵尸已生成', !!z, z ? `dist=${bot.entity.position.distanceTo(z.position).toFixed(1)}` : '未找到');
    if (z) {
        const r5 = await lookAt(bot, { kind: 'entity', entity: z });
        check('看向实体成功', r5.ok, `code=${r5.code} ${r5.message}`);
        // 僵尸在 +x 方向 → yaw 应接近 -π/2
        check('★ 实体朝向正确', diff(bot.entity.yaw, -Math.PI / 2) < 0.4,
            `yaw=${bot.entity.yaw.toFixed(2)}`);
    }

    // 6) 玩家：第二个 bot
    const OTHER = 'lo' + (Date.now() % 100000);
    const other = mineflayer.createBot({
        host: '127.0.0.1', port: 25566, username: OTHER, auth: 'offline', version: '1.21.8',
    });
    other.loadPlugin(pf.pathfinder);
    other.on('error', () => { });
    await new Promise((res) => other.once('spawn', res));
    await sleep(2000);
    await RC(`tp ${OTHER} ${p.x} ${p.y} ${p.z - 4}`);   // 放在 -z 方向
    await sleep(2000);

    const r6 = await lookAt(bot, { kind: 'player', name: OTHER });
    check('看向玩家成功', r6.ok, `code=${r6.code} ${r6.message}`);
    if (r6.ok) {
        check('★ 玩家朝向正确（-z ≈ yaw 0）', diff(bot.entity.yaw, 0) < 0.4,
            `yaw=${bot.entity.yaw.toFixed(2)}`);
    }

    // 7) 失败路径
    check('无效目标 NO_TARGET', (await lookAt(bot, null)).code === 'NO_TARGET');
    check('不认识的 kind NO_TARGET', (await lookAt(bot, { kind: 'ufo' })).code === 'NO_TARGET');
    check('坐标 NaN NO_TARGET',
        (await lookAt(bot, { kind: 'point', pos: { x: NaN, y: 0, z: 0 } })).code === 'NO_TARGET');
    check('看不见的玩家 NO_TARGET',
        (await lookAt(bot, { kind: 'player', name: 'nobody_xyz' })).code === 'NO_TARGET');
    check('实体已消失 NO_TARGET',
        (await lookAt(bot, { kind: 'entity', entity: { isValid: false } })).code === 'NO_TARGET');

    // 8) 中断
    bot.interrupt_code = true;
    const rInt = await lookAt(bot, { kind: 'block', pos: eastPos });
    bot.interrupt_code = false;
    check('中断 INTERRUPTED', rInt.code === 'INTERRUPTED', `code=${rInt.code}`);

    other.quit();
    await sleep(500);

    console.log(`\nlook 原子：${pass} PASS / ${fail_} FAIL`);
    bot.quit();
    process.exit(fail_ === 0 ? 0 : 1);
});
