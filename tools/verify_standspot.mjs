// 验收：修复后，那棵 7 格丛林树能否为每一格找到站位（复现修复前 0/7）。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

// 直接 import 项目的 findStandSpot（它在 task_collect 内部，这里复刻同样逻辑验证参数）
import { blockAt, reachDistanceTo } from '../src/agent/library/query_perceive.js';

const NOT_SOLID = new Set(['air', 'cave_air', 'water', 'lava', 'short_grass', 'tall_grass',
    'fern', 'vine', 'snow', 'seagrass', 'torch']);

function standableAt(bot, p) {
    const feet = blockAt(bot, p);
    const head = blockAt(bot, { x: p.x, y: p.y + 1, z: p.z });
    const below = blockAt(bot, { x: p.x, y: p.y - 1, z: p.z });
    if (!feet || !head || !below) return false;
    const feetClear = NOT_SOLID.has(feet.name);
    const headClear = NOT_SOLID.has(head.name);
    const belowSolid = !['air', 'cave_air', 'water', 'lava'].includes(below.name);
    return feetClear && headClear && belowSolid;
}

function findStandSpot(bot, pos, maxReach = 4.5) {
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
    [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]];
    let best = null;
    for (const [dx, dy, dz] of dirs) {
        const p = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
        if (!standableAt(bot, p)) continue;
        const d = Math.hypot(pos.x + 0.5 - (p.x + 0.5), pos.y + 0.5 - (p.y + 1.62), pos.z + 0.5 - (p.z + 0.5));
        if (d > maxReach) continue;
        if (!best || d < best.d) best = { pos: p, d };
    }
    if (best) return best;
    for (let r = 2; r <= 4; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                for (let dy = -6; dy <= 2; dy++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                    const p = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
                    if (!standableAt(bot, p)) continue;
                    const d = Math.hypot(pos.x + 0.5 - (p.x + 0.5), pos.y + 0.5 - (p.y + 1.62), pos.z + 0.5 - (p.z + 0.5));
                    if (d > maxReach) continue;
                    if (!best || d < best.d) best = { pos: p, d };
                }
            }
        }
        if (best) return best;
    }
    return null;
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => console.log('ERR', e.message));
bot.on('kicked', () => console.log('KICKED'));

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    await RC('gamemode spectator probe');
    await RC('tp probe -192.5 67 -262.5');
    await sleep(1500);
    await RC('gamemode survival probe');
    await sleep(2500);

    // 修复前这两棵树：4 格树只有 1 格可站、7 格树 0 格可站
    for (const tree of [{ x: -193, z: -245, ys: [67, 66, 65, 64] }, { x: -192, z: -285, ys: [75, 74, 73, 72, 71, 70, 69] }]) {
        let found = 0;
        console.log(`\n=== 树 (${tree.x},${tree.z}) 共 ${tree.ys.length} 格 ===`);
        for (const y of tree.ys) {
            const s = findStandSpot(bot, { x: tree.x, y, z: tree.z });
            if (s) found++;
            console.log(`  y=${y} → ${s ? `站位(${s.pos.x},${s.pos.y},${s.pos.z}) 距${s.d.toFixed(1)}` : '❌ 无'}`);
        }
        console.log(`  可站 ${found}/${tree.ys.length}`);
    }

    bot.quit();
    process.exit(0);
});
