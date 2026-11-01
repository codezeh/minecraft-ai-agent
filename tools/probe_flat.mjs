// 测试服探针：确认是超平坦、出生点高度、RCON 可用
import mineflayer from 'mineflayer';
import { rcon } from './rcon.mjs';

const HOST = '127.0.0.1';
const PORT = 25566;
const RCON_PORT = 25576;
// 密码不再写死（原 RCON_PASS = 'localdev'）：由 ./rcon.mjs →
// src/agent/library/rcon_client.js → server.properties 按 rcon.port 认领（09 §4 M1）。

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.on('error', (e) => { console.log('BOT_ERROR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', r); process.exit(1); });

bot.once('spawn', async () => {
  await new Promise(r => setTimeout(r, 2000));
  const p = bot.entity.position;
  const below = bot.blockAt(p.offset(0, -1, 0));
  const at = bot.blockAt(p);
  const out = {
    pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
    below: below?.name,
    at: at?.name,
    dimension: bot.game.dimension,
    seed: bot.game.seed,
  };
  try {
    out.rcon = (await rcon('list', { port: RCON_PORT, host: HOST })).trim();
  } catch (e) {
    out.rcon = 'ERR: ' + e.message;
  }
  console.log(JSON.stringify(out, null, 2));
  bot.quit();
  process.exit(0);
});
