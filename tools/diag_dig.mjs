// 诊断：真实地形下，砍一棵树到底断在哪一步。
// 对最近 5 个 oak_log，逐项打印：可站邻格 / moveTo 返回码 / canReach / digBlock 返回码。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { findBlocks, canReach, blockAt } from '../src/agent/library/query_perceive.js';
import { moveTo } from '../src/agent/library/nav_pathfinder.js';
import { digBlock } from '../src/agent/library/act_dig.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', JSON.stringify(r)); process.exit(1); });

const NOT_SOLID = new Set(['air', 'cave_air', 'water', 'lava', 'short_grass', 'tall_grass',
    'fern', 'vine', 'snow', 'seagrass', 'torch', 'oak_leaves']);

function standableAt(p) {
    const feet = blockAt(bot, p);
    const head = blockAt(bot, { x: p.x, y: p.y + 1, z: p.z });
    const below = blockAt(bot, { x: p.x, y: p.y - 1, z: p.z });
    if (!feet || !head || !below) return false;
    return NOT_SOLID.has(feet.name) && NOT_SOLID.has(head.name) && !NOT_SOLID.has(below.name);
}

function standSpots(pos) {
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
    return dirs.map(([dx, dy, dz]) => ({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }))
        .filter(p => standableAt(p));
}

bot.once('spawn', async () => {
    await sleep(2500);
    await RC('op probe');
    await RC('gamemode survival probe');
    await RC('clear probe');
    await RC('give probe iron_axe 1');
    await RC('spreadplayers -150 -230 4 20 false probe');
    await sleep(3500);

    console.log('位置', bot.entity.position.floored());
    const logs = findBlocks(bot, 'oak_log', 32, 40);
    console.log(`半径 32 内有 oak_log ${logs.length} 个`);

    for (const lg of logs.slice(0, 5)) {
        const pos = lg.position;
        const stands = standSpots(pos);
        console.log(`\n== 目标 (${pos.x},${pos.y},${pos.z}) 离我 ${pos.distanceTo(bot.entity.position).toFixed(1)} 格，可站邻格 ${stands.length}`);
        if (!stands.length) {
            console.log('   跳过：没有可站邻格');
            continue;
        }
        const s = stands[0];
        const mv = await moveTo(bot, s.x, s.y, s.z, { tol: 0, timeout: 15000 });
        console.log(`   moveTo → ${mv.code} ${mv.message ?? ''} (到了 ${bot.entity.position.floored()})`);
        const reach = canReach(bot, pos);
        console.log(`   canReach → ${reach}（眼到方块 ${Math.hypot(pos.x + 0.5 - bot.entity.position.x, pos.y + 0.5 - (bot.entity.position.y + 1.62), pos.z + 0.5 - bot.entity.position.z).toFixed(2)} 格）`);
        if (!reach) continue;
        const dug = await digBlock(bot, pos);
        console.log(`   digBlock → ${dug.code} ${dug.message ?? ''}`);
        if (dug.ok) {
            console.log('   成功，停在这里');
            break;
        }
    }

    await RC('clear probe');
    bot.quit();
    process.exit(0);
});
