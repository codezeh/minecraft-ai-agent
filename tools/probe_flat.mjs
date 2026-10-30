// 测试服探针：确认是超平坦、出生点高度、RCON 可用
import mineflayer from 'mineflayer';
import net from 'node:net';

const HOST = '127.0.0.1';
const PORT = 25566;
const RCON_PORT = 25576;
const RCON_PASS = 'localdev';

function rcon(pw, port, host, command) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const t = setTimeout(() => { sock.destroy(); reject(new Error('rcon timeout')); }, 8000);
    let buf = Buffer.alloc(0);
    let phase = 0;
    const send = (id, type, body) => {
      const b = Buffer.from(body, 'utf8');
      const out = Buffer.alloc(4 + 4 + 4 + b.length + 2);
      out.writeInt32LE(4 + 4 + b.length + 2, 0);
      out.writeInt32LE(id, 4);
      out.writeInt32LE(type, 8);
      b.copy(out, 12);
      sock.write(out);
    };
    sock.on('connect', () => send(1, 3, pw));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readInt32LE(0);
      if (buf.length < 4 + len) return;
      const id = buf.readInt32LE(4);
      const body = buf.slice(12, 4 + len - 2).toString('utf8');
      buf = buf.slice(4 + len);
      if (phase === 0) {
        if (id === -1) { clearTimeout(t); sock.destroy(); return reject(new Error('rcon auth failed')); }
        phase = 1;
        send(2, 2, command);
      } else {
        clearTimeout(t);
        sock.end();
        resolve(body);
      }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

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
    out.rcon = (await rcon(RCON_PASS, RCON_PORT, HOST, 'list')).trim();
  } catch (e) {
    out.rcon = 'ERR: ' + e.message;
  }
  console.log(JSON.stringify(out, null, 2));
  bot.quit();
  process.exit(0);
});
