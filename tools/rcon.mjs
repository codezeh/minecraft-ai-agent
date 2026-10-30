// 最小 RCON 客户端（测试服 25576）
import net from 'node:net';

export function rcon(command, { host = '127.0.0.1', port = 25576, password = 'localdev', timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const t = setTimeout(() => { sock.destroy(); reject(new Error('rcon timeout')); }, timeout);
    let buf = Buffer.alloc(0);
    let authed = false;
    const send = (id, type, body) => {
      const b = Buffer.from(body, 'utf8');
      const out = Buffer.alloc(4 + 4 + 4 + b.length + 2);
      out.writeInt32LE(4 + 4 + b.length + 2, 0);
      out.writeInt32LE(id, 4);
      out.writeInt32LE(type, 8);
      b.copy(out, 12);
      sock.write(out);
    };
    sock.on('connect', () => send(1, 3, password));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readInt32LE(0);
      if (buf.length < 4 + len) return;
      const id = buf.readInt32LE(4);
      const body = buf.slice(12, 4 + len - 2).toString('utf8');
      buf = buf.slice(4 + len);
      if (!authed) {
        if (id === -1) { clearTimeout(t); sock.destroy(); return reject(new Error('rcon auth failed')); }
        authed = true;
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

// 批量执行，逐条返回
export async function rconAll(commands, opts) {
  const out = [];
  for (const c of commands) out.push([c, await rcon(c, opts)]);
  return out;
}
