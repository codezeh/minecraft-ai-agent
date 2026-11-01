// 判定实验：站在树叶上，把树叶挖掉，服务端会不会判 invalid_player_movement。
//
// 背景：flow_collect.js 的 standableAt() 允许"下方是树叶"作为站立支撑
// （注释写「站在树叶上方是合法的」）。但树叶会消失（被挖/自然枯萎），
// bot 会瞬间从树冠高度掉到地面 —— 实测 diag_collect_kick 里出现过
// y 74.16 → 65.49 的单帧 8.7 格跳变，随后被踢。
//
// 做法（测试服同款场景自造，不碰主服真实地形）：
//   1. RCON 在开阔处堆一个 3 格高的树叶柱，顶上再放一块树叶当站台
//   2. 把 bot 送到站台上（tp 一次，之后不动）
//   3. 用 RCON 挖掉脚下的树叶 → 看是否被踢
//
// 用法：node tools/diag_leaf_stand.mjs
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'leaf' + (Date.now() % 100000);

let kicked = null;
const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25565, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
bot.on('error', () => { });
bot.on('kicked', (r) => { kicked = JSON.stringify(r).slice(0, 140); });

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);
    await sleep(800);

    const base = bot.entity.position.floored();
    const x = base.x + 6, z = base.z, y0 = base.y;

    console.log(`平台位置 (${x},${y0}..${y0 + 4},${z})`);

    // 造：地面 y0-1 实心已存在；从 y0+3 起放 1 格树叶站台（离地 3 格）
    await RC(`setblock ${x} ${y0 + 3} ${z} oak_leaves`);
    await sleep(800);

    // 站上去：先 tp 到方块正上方（会落到树叶上）
    await RC(`tp ${NAME} ${x + 0.5} ${y0 + 4.2} ${z + 0.5}`);
    await sleep(2500);

    const p1 = bot.entity.position;
    console.log(`站立位置 (${p1.x.toFixed(2)},${p1.y.toFixed(2)},${p1.z.toFixed(2)})（应在 y≈${y0 + 4}）`);

    // 关键动作：挖掉脚下的树叶
    console.log('挖掉脚下树叶...');
    const t0 = Date.now();
    let maxStep = 0, prev = p1.clone();
    const sampler = setInterval(() => {
        const p = bot.entity.position;
        const d = p.distanceTo(prev);
        if (d > maxStep) maxStep = d;
        prev = p.clone();
    }, 200);
    await RC(`setblock ${x} ${y0 + 3} ${z} air`);
    await sleep(4000);
    clearInterval(sampler);

    const p2 = bot.entity.position;
    console.log(`落地位置 (${p2.x.toFixed(2)},${p2.y.toFixed(2)},${p2.z.toFixed(2)})`);
    console.log(`高差 ${(p1.y - p2.y).toFixed(2)} 格，最大单次采样位移 ${maxStep.toFixed(2)} 格`);
    console.log(`结果：${kicked ? `❌ 被踢 ${kicked}` : '✅ 未被踢'}`);
    console.log(kicked
        ? '★ 站在树叶上、树叶消失 → 会判瞬移踢人。standableAt 允许"树叶当支撑"是错的。'
        : '树叶消失没踢人，需继续找别的原因');

    try { bot.quit(); } catch { }
    process.exit(0);
});
