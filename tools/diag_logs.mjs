// 真实地形诊断：附近的 oak_log 里，有多少是「有可站邻格」的。纯只读，不执行任何服务器命令。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { io } from 'socket.io-client';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });

const SOLID = (b) => b && !['air', 'cave_air', 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'vine', 'snow'].includes(b.name);

bot.once('spawn', async () => {
    await sleep(2500);

    const def = bot.registry.blocksByName['oak_log'];
    const positions = bot.findBlocks({ matching: def.id, maxDistance: 48, count: 200 });
    console.log(`附近 oak_log: ${positions.length} 个（半径 48）`);

    let standable = 0;
    const rows = [];
    for (const p of positions.slice(0, 40)) {
        const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
        const stands = [];
        for (const [dx, dy, dz] of dirs) {
            const feet = bot.blockAt(p.offset(dx, dy, dz), false);
            const below = bot.blockAt(p.offset(dx, dy - 1, dz), false);
            const head = bot.blockAt(p.offset(dx, dy + 1, dz), false);
            if (feet && !SOLID(feet) && head && !SOLID(head) && below && SOLID(below)) {
                stands.push(`${p.x + dx},${p.y + dy},${p.z + dz}`);
            }
        }
        if (stands.length) standable++;
        rows.push(`(${p.x},${p.y},${p.z}) 可站邻格=${stands.length} ${stands.slice(0, 2).join(' | ')}`);
    }
    console.log(rows.join('\n'));
    console.log(`\n统计：检查 ${rows.length} 个，有可站邻格 ${standable} 个`);

    // 她的位置（方便对照）
    console.log(`probe 位置: ${bot.entity.position}`);
    bot.quit();
    process.exit(0);
});
