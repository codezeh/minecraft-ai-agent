// 验收：!goToPlayer 长距离走 hopTo（能游泳/挖穿）。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { goToPlayer } from '../src/agent/library/flow_follow.js';
import { scanArea } from '../src/agent/library/chunk_map.js';
import { mkdirSync, existsSync } from 'fs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const DIR = './bots/probe/map-goto';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const mk = (username) => {
    const b = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline', version: '1.21.8' });
    b.loadPlugin(pf.pathfinder);
    b.on('error', () => { });
    b.on('kicked', (r) => console.log(`${username} KICKED`, String(r).slice(0, 60)));
    return b;
};

const bot = mk('probe');        // 走的人
const player = mk('leader');    // 被找的人

const waitSpawn = (b) => new Promise(r => b.once('spawn', r));

(async () => {
    await Promise.all([waitSpawn(bot), waitSpawn(player)]);
    await sleep(2500);
    await RC('op probe'); await RC('op leader');
    await RC('gamemode survival probe'); await RC('gamemode survival leader');

    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

    // 两个账号相距 100 格
    const b0 = bot.entity.position.floored();
    // probe 保持 spawn 位置
    await sleep(1200);
    const room = { x: b0.x + 100, z: b0.z + 40 };
    await RC(`spreadplayers ${room.x} ${room.z} 4 12 false leader`);
    await sleep(2000);

    const dist0 = bot.entity.position.distanceTo(player.entity.position);
    console.log(`  起点 ${bot.entity.position.floored()}，目标玩家在 ${player.entity.position.floored()}，相距 ${dist0.toFixed(0)} 格`);

    // 扫地图（hopTo 也会自己扫，这里先扫一遍让长规划有数据）
    await scanArea(bot, DIR, Math.floor(b0.x / 16), Math.floor(b0.z / 16), 4);
    await scanArea(bot, DIR, Math.floor(room.x / 16), Math.floor(room.z / 16), 4);

    const events = [];
    const t0 = Date.now();
    const r = await goToPlayer(bot, 'leader', { distance: 3, mapDir: DIR, onEvent: e => events.push(e) });
    const ms = Date.now() - t0;
    const dist1 = bot.entity.position.distanceTo(player.entity.position);
    const hopStart = events.find(e => e.type === 'hop_start');
    const hopDone = events.find(e => e.type === 'hop_done');

    console.log(`  结果: code=${r.code} 距玩家 ${dist1.toFixed(0)} 格 用时 ${(ms / 1000).toFixed(0)}s`);
    console.log(`  hop 事件: start=${hopStart ? hopStart.dist + '格' : '无'} done=${hopDone ? hopDone.code + ' 剩' + hopDone.dist : '无'}`);

    check('长距离触发了 hopTo', !!hopStart, hopStart ? `起始 ${hopStart.dist} 格` : '没触发');
    check('最终走到了玩家附近（<6 格）', dist1 < 6, `距 ${dist1.toFixed(0)} 格`);
    check('耗时合理（<120s）', ms < 120000, `${(ms / 1000).toFixed(0)}s`);

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit(); player.quit();
    process.exit(failed ? 1 : 0);
})();
