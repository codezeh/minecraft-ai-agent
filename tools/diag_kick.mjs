// 最小复现：探清 invalid_player_movement 到底由哪一步触发。
// 每步单独记录，被踢时能看出停在哪。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => console.log('ERR', e.message));
bot.on('kicked', (r) => { console.log('KICKED at step:', STEP, JSON.stringify(r).slice(0, 100)); process.exit(2); });

let STEP = 'spawn';
bot.once('spawn', async () => {
    await sleep(2500);
    console.log('spawn 位置', bot.entity.position, '飞行状态', bot.entity.onGround, '游戏模式信息', JSON.stringify(bot.game?.gameMode ?? null));

    await RC('op probe');
    await sleep(500);

    STEP = 'gamemode';
    await RC('gamemode survival probe');
    await sleep(1000);
    console.log('切 survival 后，飞行标志:', bot.entity?.onGround, 'pos', bot.entity.position);

    STEP = 'setControls';
    bot.setControlState('forward', true);
    await sleep(1200);
    bot.setControlState('forward', false);
    console.log('走了 1.2s，位置', bot.entity.position);

    STEP = 'pathfinder';
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(new pf.goals.GoalNear(
        Math.floor(bot.entity.position.x) + 5,
        Math.floor(bot.entity.position.y),
        Math.floor(bot.entity.position.z), 1)).catch(e => console.log('goto err', e.message));
    console.log('goto 完成，位置', bot.entity.position);

    STEP = 'dig';
    const target = bot.findBlock({ matching: bot.registry.blocksByName['oak_log'].id, maxDistance: 24 });
    if (target) {
        await RC('give probe iron_axe 1');
        await sleep(600);
        await bot.pathfinder.goto(new pf.goals.GoalNear(target.position.x, target.position.y, target.position.z, 3)).catch(e => console.log('goto tree err', e.message));
        console.log('到树旁', bot.entity.position);
        await bot.dig(target).catch(e => console.log('dig err', e.message));
        console.log('挖完，位置', bot.entity.position);
    } else {
        console.log('附近没树');
    }

    STEP = 'done';
    console.log('全部通过，未被踢');
    bot.quit();
    process.exit(0);
});
