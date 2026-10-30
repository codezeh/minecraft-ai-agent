// 验证：开了 allow1by1towers 后，pathfinder 能不能自己垫到高处够树？
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const Vec3 = (await import('vec3')).Vec3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', () => { });
bot.on('kicked', () => console.log('KICKED'));

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    await RC('gamemode survival probe');
    await RC('tp probe -178.5 64 -225.5');
    await sleep(2000);
    await RC('clear probe');
    await RC('give probe dirt 64');       // 垫脚材料
    await RC('give probe iron_axe 1');
    await sleep(1200);

    const moves = new pf.Movements(bot);
    moves.canDig = true;
    moves.allow1by1towers = true;
    moves.allowParkour = true;
    moves.maxDropDown = 3;
    moves.dontMineUnderFallingBlock = false;
    moves.scafoldingBlocks = [];           // 清空默认，手动加
    const dirtId = bot.registry.itemsByName['dirt'].id;
    moves.scafoldingBlocks.push(dirtId);
    bot.pathfinder.setMovements(moves);

    const pos0 = bot.entity.position;
    console.log(`起点 y=${pos0.y.toFixed(0)}`);
    console.log(`垫脚材料: dirt ${bot.registry.itemsByName['dirt'].id} 已在 scafoldingBlocks\n`);

    // 目标：树上 y=70 那格（高处）
    const target = { x: -178, y: 70, z: -225 };
    const b = bot.blockAt(new Vec3(target.x, target.y, target.z));
    console.log(`目标 (${target.x},${target.y},${target.z}) = ${b?.name}，高差 ${(target.y - pos0.y).toFixed(0)} 格\n`);

    for (const [label, goal] of [
        ['GoalLookAtBlock', new pf.goals.GoalLookAtBlock(new Vec3(target.x, target.y, target.z), bot.world)],
        ['GoalNear r=2', new pf.goals.GoalNear(target.x, target.y, target.z, 2)],
    ]) {
        const t0 = Date.now();
        let err = '';
        try {
            await Promise.race([
                bot.pathfinder.goto(goal),
                sleep(30000).then(() => { throw new Error('timeout-30s'); }),
            ]);
        } catch (e) { err = `${e.name}: ${String(e.message).slice(0, 50)}`; }
        const now = bot.entity.position;
        console.log(`  ${label.padEnd(16)} ${err ? 'FAIL ' + err : 'OK'} ${((Date.now() - t0) / 1000).toFixed(1)}s  现在 y=${now.y.toFixed(1)}`);
        if (!err) {
            // 到了之后能挖到吗
            const dist = Math.hypot(target.x + 0.5 - now.x, target.y + 0.5 - (now.y + 1.62), target.z + 0.5 - now.z);
            console.log(`    眼到方块距离 ${dist.toFixed(2)} 格 ${dist <= 4.5 ? '→ 够得着' : '→ 仍够不着'}`);
            break;
        }
    }

    bot.quit();
    process.exit(0);
});
