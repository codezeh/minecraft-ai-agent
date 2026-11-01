// B2 验收：移动层。8 方向 × 2 距离 + 绕墙 + 封闭盒 + 中断停止。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { moveTo, stopMove } from '../src/agent/library/nav_pathfinder.js';
import { lookAtPoint } from '../src/agent/library/atom_input_mouse.js';
import { blockAt } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });

const RC = (c) => rcon(c);
const at = () => bot.entity.position;

async function reset() {
    bot.interrupt_code = false;
    await RC('fill -12 -60 -12 44 -58 12 air');
    await RC('fill -12 -61 -12 44 -61 12 grass_block');   // 地面被别套件挖空时补回来
    await RC('tp probe 0.5 -60 0.5');
    await sleep(400);
    // tp 之后要站稳再走：服务端会校验移动包，落点没同步时直接踢 invalid_player_movement
    await sleep(500);
    for (let i = 0; i < 20 && !bot.entity?.onGround; i++) await sleep(100);
}

bot.once('spawn', async () => {
    await sleep(2000);
    await RC('op probe');
    await sleep(300);

    // 1) 8 方向 × 2 距离
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let okCount = 0, total = 0;
    const slowest = [];
    for (const [dx, dz] of dirs) {
        for (const d of [15, 30]) {
            await reset();
            const tx = Math.round(0.5 + dx * d), tz = Math.round(0.5 + dz * d);
            const t0 = Date.now();
            const r = await moveTo(bot, tx, -60, tz, { tol: 1, timeout: 30000 });
            const ms = Date.now() - t0;
            const end = at();
            const remain = Math.hypot(end.x - (tx + 0.5), end.z - (tz + 0.5));
            total++;
            slowest.push(ms);
            const good = r.ok && remain <= 1.6;
            if (good) { okCount++; console.log(`  PASS  移动 ${d} 格 (${dx},${dz}) -> (${tx},${tz})  ${ms}ms 余 ${remain.toFixed(1)}`); passed++; }
            else { console.log(`  FAIL  移动 ${d} 格 (${dx},${dz}) -> (${tx},${tz})  code=${r.code} 余 ${remain.toFixed(1)}`); failed++; }
        }
    }
    console.log(`  ---- 移动成功 ${okCount}/${total}，最慢 ${Math.max(...slowest)}ms`);

    // 2) 绕墙：墙挡在正前方，应该绕过去而不是挖穿
    await reset();
    await RC('fill 8 -60 -4 8 -59 4 stone');
    await sleep(200);
    const wallRun = await moveTo(bot, 14, -60, 0, { tol: 1, timeout: 40000 });
    const wallStillThere = blockAt(bot, { x: 8, y: -60, z: 0 })?.name;
    check('绕墙：到达且墙没被挖', wallRun.ok && wallStillThere === 'stone', `code=${wallRun.code} 墙=${wallStillThere}`);

    // 3) 封闭盒：应返回 NO_PATH，不抛异常
    await reset();
    await RC('fill -1 -60 -1 1 -60 1 stone');
    await RC('fill -1 -59 -1 1 -59 1 stone');
    await RC('setblock 0 -60 0 air');
    await RC('setblock 0 -59 0 air');
    await RC('tp probe 0.5 -60 0.5');
    await sleep(400);
    const boxRun = await moveTo(bot, 6, -60, 0, { tol: 1, timeout: 8000 });
    check('封闭盒：返回 NO_PATH', boxRun.code === 'NO_PATH', `code=${boxRun.code} msg=${boxRun.message ?? ''}`);

    // 4) 中断：走到一半喊停
    await reset();
    bot.interrupt_code = false;
    const walking = moveTo(bot, 40, -60, 0, { tol: 1, timeout: 30000 });
    await sleep(1200);
    bot.interrupt_code = true;
    await stopMove(bot);
    const stopped = await walking;
    const before = at();
    await sleep(1200);
    const after = at();
    const drift = Math.hypot(after.x - before.x, after.z - before.z);
    check('中断：moveTo 返回 INTERRUPTED', stopped.code === 'INTERRUPTED', `code=${stopped.code}`);
    check('中断：1.2 秒内位移 < 0.2 格', drift < 0.2, `drift=${drift.toFixed(3)}`);
    bot.interrupt_code = false;

    // 5) lookAt 不抛
    const la = await lookAtPoint(bot, { x: 3.5, y: -59.5, z: 0.5 });
    check('lookAt 返回 ok', la.ok === true);

    await reset();
    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
