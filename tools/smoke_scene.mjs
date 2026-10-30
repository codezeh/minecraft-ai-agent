// 冒烟：RCON 造场景 → bot 真的看得到
import mineflayer from 'mineflayer';
import Vec3 from 'vec3';
import { rcon } from './rcon.mjs';

const X = -5, Y = -60, Z = -3;
const X2 = -5, Z2 = -5;

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'builder', auth: 'offline', version: '1.21.8' });
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });

bot.once('spawn', async () => {
  await new Promise(r => setTimeout(r, 1500));
  const results = [];
  results.push(['op', await rcon('op builder')]);
  results.push(['time', await rcon('time set day')]);
  results.push(['log', await rcon(`setblock ${X} ${Y} ${Z} minecraft:oak_log`)]);
  results.push(['stone', await rcon(`setblock ${X2} ${Y} ${Z2} minecraft:stone`)]);

  await new Promise(r => setTimeout(r, 500));
  const a = bot.blockAt(new Vec3(X, Y, Z));
  const b = bot.blockAt(new Vec3(X2, Y, Z2));

  console.log(JSON.stringify({
    rcon: results,
    seen: { oak: a?.name, stone: b?.name },
    pos: [+bot.entity.position.x.toFixed(1), +bot.entity.position.y, +bot.entity.position.z.toFixed(1)],
  }, null, 2));

  // 清场
  await rcon(`setblock ${X} ${Y} ${Z} minecraft:air`);
  await rcon(`setblock ${X2} ${Y} ${Z2} minecraft:air`);
  bot.quit();
  process.exit(0);
});
