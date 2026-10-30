// 接线：!placeHere 在有/无坐标两种情况下都走新原子。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import settings from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import { getCommand } from '../src/agent/commands/index.js';
import { blockAt } from '../src/agent/library/atom_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}
const RC = (c) => rcon(c);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', e => console.log('ERR', e.message));

const agent = {
    bot,
    actions: {
        async runAction(label, fn) {
            const value = await fn();
            return { success: true, message: '', interrupted: false, timedout: false, value };
        },
    },
};

bot.once('spawn', async () => {
    setSettings(settings);
    await sleep(1800);
    await RC('op probe'); await RC('clear probe');
    await RC('gamemode survival probe');
    await RC('give probe dirt 32');
    await sleep(400);

    const place = getCommand('!placeHere');
    check('!placeHere 存在', !!place);

    // 有坐标
    await RC('fill -4 -60 -4 6 -54 6 air'); await RC('fill -4 -61 -4 6 -61 6 grass_block');
    await RC('tp probe 0.5 -60 0.5'); await sleep(800);
    await RC('tp probe 0.5 -60 0.5 180 0'); await sleep(300);   // 面朝北
    const out1 = await place.perform(agent, 'dirt', 2, -60, 0);
    check('有坐标：返回一行 OK', typeof out1 === 'string' && out1.startsWith('placeHere: OK'), out1);
    check('有坐标：方块真的放上了', blockAt(bot, { x: 2, y: -60, z: 0 })?.name === 'dirt',
        blockAt(bot, { x: 2, y: -60, z: 0 })?.name);

    // 无坐标：放在面前
    await RC('fill -4 -60 -4 6 -54 6 air'); await sleep(600);
    const feet = bot.entity.position.floored();
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw)), dz = Math.round(Math.cos(yaw));
    const front = { x: feet.x + dx, y: feet.y, z: feet.z + dz };
    const out2 = await place.perform(agent, 'dirt');
    const placedFront = blockAt(bot, front)?.name === 'dirt';
    check('无坐标：放在面朝那一格', placedFront, `front=(${front.x},${front.y},${front.z}) 实际=${blockAt(bot, front)?.name} out=${out2}`);

    // 失败路径也走一行
    const out3 = await place.perform(agent, 'diamond_block', 1, -60, 1);
    check('失败也是一行（NO_ITEM）', typeof out3 === 'string' && out3.includes('NO_ITEM'), out3);

    await RC('fill -4 -60 -4 6 -54 6 air'); await RC('clear probe');
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit(); process.exit(failed ? 1 : 0);
});
