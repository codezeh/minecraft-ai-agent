// 判定实验：collectDrops 里的「跳跃 + 前后挪半步」会不会导致 invalid_player_movement。
//
// 背景：那段代码是为「掉落物漏捡」加的补丁（task_collect.js:153-176）：
//   setControlState('jump', true) → 250ms → false → forward/back 各 280ms
// 怀疑：手动控制状态与 pathfinder 同时作用，客户端位置与服务端物理不同步 → 被踢。
//
// 三组，各用新账号：
//   A 只站着（对照组）
//   B 纯跳 3 次（setControlState jump）
//   C 跳 + 前后挪半步 3 轮（复刻 collectDrops）
//
// 用法：node tools/diag_jump_kick.mjs
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

let kicked = null;

async function run(label, fn) {
    kicked = null;
    const name = 'jk' + (Date.now() % 100000);
    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: 25565, username: name, auth: 'offline', version: '1.21.8',
    });
    bot.loadPlugin(pf.pathfinder);
    bot.on('error', () => { });
    bot.on('kicked', (r) => { kicked = JSON.stringify(r).slice(0, 140); });
    await new Promise((res) => bot.once('spawn', res));
    await sleep(1500);
    await RC(`op ${name}`);
    await RC(`gamemode survival ${name}`);
    await sleep(1000);

    const before = bot.entity.position.clone();
    try { await fn(bot); } catch (e) { console.log(`   动作异常：${e.message}`); }
    const after = bot.entity.position.clone();
    await sleep(2500);

    const moved = before.distanceTo(after);
    console.log(`[${label}] 位移=${moved.toFixed(2)} 结果=${kicked ? `❌ 被踢 ${kicked}` : '✅ 未被踢'}`);
    try { bot.quit(); } catch { }
    await sleep(1200);
    return !kicked;
}

const A = await run('A 站着不动 6s', async () => { await sleep(6000); });

const B = await run('B 纯跳 3 次', async (bot) => {
    for (let i = 0; i < 3; i++) {
        bot.setControlState('jump', true);
        await sleep(250);
        bot.setControlState('jump', false);
        await sleep(600);
    }
});

const C = await run('C 跳 + 前后挪半步 ×3（复刻 collectDrops）', async (bot) => {
    for (let i = 0; i < 3; i++) {
        bot.setControlState('jump', true);
        await sleep(250);
        bot.setControlState('jump', false);
        await sleep(300);
        for (const k of ['forward', 'back']) {
            bot.setControlState(k, true);
            await sleep(280);
            bot.setControlState(k, false);
            await sleep(250);
        }
    }
});

console.log(`\n===== 结论 =====`);
console.log(`A(不动)=${A ? 'OK' : '踢'}  B(纯跳)=${B ? 'OK' : '踢'}  C(跳+挪）=${C ? 'OK' : '踢'}`);
console.log(C ? '跳跃补捡不是元凶' : '★ 复刻 collectDrops 就能踢人 → 锁定元凶');
process.exit(0);
