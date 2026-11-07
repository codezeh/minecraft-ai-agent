import { Rcon, connectBot, clearInv, give, sleep } from 'file:///E:/我的世界ai/docs/真机-20261106/T2/lib-probe.mjs';
const r = new Rcon(); await r.connect();
const bot = await connectBot('probe2');
await clearInv(r, 'probe2'); await sleep(600);
console.log('zero case   :', JSON.stringify(await r.cmd('clear probe2 minecraft:iron_sword 0')));
await give(r, 'probe2', 'iron_sword', 10); await sleep(900);
console.log('ten case    :', JSON.stringify(await r.cmd('clear probe2 minecraft:iron_sword 0')));
console.log('still 10?   :', JSON.stringify(await r.cmd('clear probe2 minecraft:iron_sword 0')));
await give(r, 'probe2', 'dirt', 64); await sleep(600);
console.log('dirt case   :', JSON.stringify(await r.cmd('clear probe2 minecraft:dirt 0')));
try { bot.quit('d'); } catch {}
r.close(); await sleep(200); process.exit(0);
