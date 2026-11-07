// 诊断：打开面板后把「页面实际拿到了什么」dump 出来（token 打码）。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/我的世界ai';
const T3 = path.join(ROOT, 'docs/真机-20261106/T3');
const require = createRequire(path.join(ROOT, 'mindcraft/'));
const WebSocket = require('ws');
const TOKEN = fs.readFileSync(path.join(ROOT, 'mindcraft/.mindserver-token'), 'utf8').trim();
const MASKED = TOKEN.slice(0, 4) + '****' + TOKEN.slice(-2);
const mask = (s) => String(s).split(TOKEN).join(MASKED).split(encodeURIComponent(TOKEN)).join(MASKED);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; ws.on('message', (r) => this._m(r)); }
  _m(raw) {
    const m = JSON.parse(raw.toString());
    if (m.id !== undefined) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    this.events.push(m);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 20000); });
  }
}

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const child = spawn(EDGE, ['--remote-debugging-port=9222', `--user-data-dir=${path.join(T3, 'edge-profile-dbg')}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let version = null;
for (let i = 0; i < 60; i++) { try { version = await (await fetch('http://127.0.0.1:9222/json/version')).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
const cdp = new CDP(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sid);
await cdp.send('Runtime.enable', {}, sid);
await cdp.send('Network.enable', {}, sid);
const url = `http://localhost:8080/console?token=${TOKEN}`;
await cdp.send('Page.navigate', { url }, sid);
await sleep(4000);
const info = await cdp.send('Runtime.evaluate', {
  expression: `JSON.stringify({href: location.href, title: document.title, bodyLen: document.body ? document.body.innerText.length : -1, body: (document.body?document.body.innerText:'').slice(0,600), scripts: Array.from(document.scripts).map(s=>s.src), html: document.documentElement.outerHTML.slice(0,600), appHtml: document.querySelector('#app') ? document.querySelector('#app').innerHTML.slice(0,500) : null}, null, 1)`,
  returnByValue: true,
}, sid);
console.log('PAGE:', mask(info.result.value));
const net = cdp.events.filter((e) => e.method === 'Network.responseReceived').map((e) => `${e.params.response.status} ${e.params.response.mimeType} ${mask(e.params.response.url)}`);
console.log('NET:\n' + net.join('\n'));
const bad = cdp.events.filter((e) => e.method === 'Network.loadingFailed').map((e) => mask(JSON.stringify(e.params)));
console.log('FAILED:\n' + bad.join('\n'));
cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled').slice(0, 20).forEach((e) => console.log('CONSOLE', e.params.type, mask(JSON.stringify(e.params.args.map((a) => a.value ?? a.description))).slice(0, 300)));
cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').forEach((e) => console.log('EXC', mask(JSON.stringify(e.params.exceptionDetails).slice(0, 400))));
fs.writeFileSync(path.join(T3, 'evidence', 'debug-page.json'), mask(JSON.stringify({ page: info.result.value, net, failed: bad }, null, 2)));
try { child.kill(); } catch {}
process.exit(0);
