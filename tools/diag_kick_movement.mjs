// 判定实验：invalid_player_movement 到底是「阈值太严」还是「出生点把 bot 卡在方块里」
//
// 三个场景各跑一次（每次新账号）：
//   A 出生点原地站 5 秒（不动）           → 不动也被踢 = 出生点/区块问题
//   B tp 到森林后原地站 5 秒               → 动了才踢 = 位置同步问题
//   C tp 到森林后 pathfinder 走 10 格      → 走位才踢 = 移动校验问题
//
// 用法：node tools/diag_kick_movement.mjs
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const FOREST = [-292, 68, -354];

let kicked = null;

function makeBot(tag) {
    const name = tag + (Date.now() % 100000);
    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: 25565, username: name, auth: 'offline', version: '1.21.8',
    });
    bot.loadPlugin(pf.pathfinder);
    bot.on('error', () => { });
    bot.on('kicked', (r) => { kicked = JSON.stringify(r).slice(0, 160); });
    return { bot, name };
}

async function waitPos(bot, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const p = bot.entity?.position;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return p;
        await sleep(200);
    }
    return null;
}

async function scenario(label, fn) {
    kicked = null;
    const { bot, name } = makeBot('kx');
    await new Promise((res) => bot.once('spawn', res));
    await sleep(1500);
    await RC(`op ${name}`);
    await RC(`gamemode survival ${name}`);
    const p = await waitPos(bot);
    console.log(`\n[${label}] 账号=${name} 位置=${p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : 'NaN'}`);
    try {
        await fn(bot, name);
    } catch (e) {
        console.log(`   动作异常：${e.message}`);
    }
    await sleep(3000);
    console.log(`   结果：${kicked ? `❌ 被踢 ${kicked}` : '✅ 未被踢'}`);
    try { bot.quit(); } catch { }
    await sleep(1500);
    return !kicked;
}

const A = await scenario('A 出生点原地不动 5s', async () => {
    await sleep(5000);
});

const B = await scenario('B tp 森林后原地不动 5s', async (bot, name) => {
    await RC(`tp ${name} ${FOREST[0]} ${FOREST[1]} ${FOREST[2]}`);
    await sleep(5000);
});

const C = await scenario('C tp 森林后走 10 格', async (bot, name) => {
    await RC(`tp ${name} ${FOREST[0]} ${FOREST[1]} ${FOREST[2]}`);
    await sleep(2500);
    const p = bot.entity.position;
    await bot.pathfinder.goto(new pf.goals.GoalNear(p.x + 10, p.y, p.z, 2)).catch(e => console.log('   goto:', e.message));
    await sleep(1500);
});

console.log(`\n===== 结论 =====`);
console.log(`A(不动被踢)=${!A}  B(tp后不动被踢)=${!B}  C(tp后走位被踢)=${!C}`);
process.exit(0);
