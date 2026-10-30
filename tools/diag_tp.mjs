// 小实验：tp 到空中 / tp 到地面，各试一次，看会不会被踢 invalid_player_movement。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); });
bot.on('kicked', (r) => { console.log('KICKED', JSON.stringify(r).slice(0, 200)); process.exit(2); });

bot.once('spawn', async () => {
    await sleep(2500);
    await RC('op probe');
    await RC('gamemode survival probe');

    console.log('起始位置', bot.entity.position);

    // 试 1：tp 到 y=120（空中），观察是否被踢
    console.log('--- 试 1：tp 到空中 y=120 ---');
    await RC('tp probe -150.5 120 -230.5');
    for (let i = 0; i < 20; i++) {
        await sleep(300);
        const p = bot.entity.position;
        console.log(`  t=${(i + 1) * 0.3}s y=${p.y.toFixed(2)} onGround=${bot.entity.onGround}`);
        if (bot.entity.onGround && p.y < 110) break;
    }
    console.log('试 1 存活，落点', bot.entity.position.floored());

    await RC('clear probe');
    bot.quit();
    process.exit(0);
});
