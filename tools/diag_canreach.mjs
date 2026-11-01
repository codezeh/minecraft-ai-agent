// 诊断：站在树干旁边时 canReach / canSeeBlock 到底返回什么。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { canReach, blockAt, reachDistanceTo } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => console.log('ERR', e.message));
bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 100)));

bot.once('spawn', async () => {
    await sleep(1800);
    await RC('op probe');
    await RC('fill -12 -60 -12 12 -58 12 air');
    await RC('fill -12 -61 -12 12 -61 12 grass_block');
    // 树：树干 3 格 + 树冠在上方
    await RC('fill 6 -57 -2 6 -56 2 oak_leaves');
    await RC('fill 6 -60 0 6 -58 0 oak_log');
    await RC('tp probe 7.5 -60 0.5');
    await sleep(1500);

    const pos = { x: 6, y: -60, z: 0 };
    const b = blockAt(bot, pos);
    console.log('当前站位', bot.entity.position.floored());
    console.log('目标方块', b?.name);
    console.log('眼距', reachDistanceTo(bot, pos).toFixed(2));
    console.log('canSeeBlock', (() => { try { return bot.canSeeBlock(b); } catch (e) { return 'threw ' + e.message; } })());
    console.log('canReach', canReach(bot, pos));

    // 换到 y=-59 那格试试
    const pos2 = { x: 6, y: -59, z: 0 };
    console.log('\ny=-59 那格：眼距', reachDistanceTo(bot, pos2).toFixed(2), 'canSeeBlock',
        (() => { try { return bot.canSeeBlock(blockAt(bot, pos2)); } catch (e) { return 'threw'; } })(),
        'canReach', canReach(bot, pos2));

    bot.quit();
    process.exit(0);
});
