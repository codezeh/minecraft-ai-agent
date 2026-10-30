// 一次性诊断：确认「spreadplayers 到森林 → 附近真有天然橡木林」这条路可行。
// 目的：给 bench_s2_main.mjs 选锚点，不再靠猜坐标。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'fnd' + (Date.now() % 10000);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', () => { });
bot.on('kicked', (r) => { console.log('KICKED', JSON.stringify(r).slice(0, 120)); process.exit(2); });

const leafCount = (r = 32) => {
    const logs = bot.findBlocks({ matching: bot.registry.blocksByName.oak_log.id, maxDistance: r, count: 400 });
    const leaves = bot.findBlocks({ matching: bot.registry.blocksByName.oak_leaves.id, maxDistance: r, count: 400 });
    return { logs: logs.length, leaves: leaves.length };
};

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);

    const centers = [
        [-272, -352],
        [-272 + 120, -352 + 60],
        [-272 - 100, -352 - 80],
    ];

    for (const [cx, cz] of centers) {
        const out = await RC(`spreadplayers ${cx} ${cz} 8 24 false ${NAME}`);
        await sleep(2500);
        const p = bot.entity.position.floored();
        const c = leafCount(32);
        console.log(`中心(${cx},${cz}) → 落在 ${p.x},${p.y},${p.z}  rcon=${String(out).trim().slice(0, 60)}`);
        console.log(`   32 格内 oak_log=${c.logs}  oak_leaves=${c.leaves}  ${c.logs >= 12 && c.leaves >= 40 ? '✅ 可用锚点' : '⚠️ 偏稀'}`);
    }

    bot.quit();
    process.exit(0);
});
