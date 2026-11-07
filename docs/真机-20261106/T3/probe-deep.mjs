// 深探：__vue_app__ 上到底有什么，元素上有没有 __vueParentComponent。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/我的世界ai';
const T3 = path.join(ROOT, 'docs/真机-20261106/T3');
const require = createRequire(path.join(ROOT, 'mindcraft/'));
const WebSocket = require('ws');
const TOKEN = fs.readFileSync(path.join(ROOT, 'mindcraft/.mindserver-token'), 'utf8').trim();
const mask = (s) => String(s).split(TOKEN).join(TOKEN.slice(0, 4) + '****' + TOKEN.slice(-2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.on('message', (r) => this._m(r)); }
  _m(raw) { const m = JSON.parse(raw.toString()); if (m.id === undefined) return; const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  send(method, params = {}, sessionId) { const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId; this.ws.send(JSON.stringify(msg)); return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 20000); }); }
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const child = spawn(EDGE, ['--remote-debugging-port=9222', `--user-data-dir=${path.join(T3, 'edge-profile-dbg')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let version = null;
for (let i = 0; i < 60; i++) { try { version = await (await fetch('http://127.0.0.1:9222/json/version')).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
const cdp = new CDP(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sid); await cdp.send('Runtime.enable', {}, sid);
await cdp.send('Page.navigate', { url: `http://localhost:8080/console?token=${TOKEN}` }, sid);
await sleep(3500);

const EXPR = `(() => {
  const appEl = document.querySelector('#app');
  const app = appEl.__vue_app__;
  const info = { appKeys: Object.keys(app), instanceNull: app._instance === null || app._instance === undefined };
  info.containerTag = app._container ? app._container.tagName : null;
  info.containerKeys = app._container ? Object.keys(app._container).filter(k => k.startsWith('__')) : null;
  // 元素上是否挂了组件实例
  const walk = document.querySelector('#app .app') || appEl.firstElementChild;
  info.elKeys = walk ? Object.keys(walk).filter(k => k.startsWith('__')) : null;
  const inst = walk && walk.__vueParentComponent;
  info.hasInst = !!inst;
  if (inst) {
    info.instType = inst.type && (inst.type.__name || inst.type.name);
    info.setupKeys = Object.keys(inst.setupState || {});
    info.hasSubTree = !!inst.subTree;
    // 从 subTree 走一层
    const kids = [];
    const visit = (vn, d) => {
      if (!vn || d > 3) return;
      if (vn.component) kids.push({ d, name: vn.component.type && (vn.component.type.__name || vn.component.type.name), setupKeys: Object.keys(vn.component.setupState || {}) });
      const c = vn.children;
      if (Array.isArray(c)) c.forEach(x => visit(x, d + 1));
      else if (c && typeof c === 'object' && c.component) visit(c, d + 1);
    };
    visit(inst.subTree, 0);
    info.kids = kids;
  }
  return info;
})()`;
const r = await cdp.send('Runtime.evaluate', { expression: EXPR, returnByValue: true }, sid);
console.log(JSON.stringify(r.result.value, null, 1));
fs.writeFileSync(path.join(T3, 'evidence', 'probe-deep.json'), JSON.stringify(r.result.value, null, 2));
try { child.kill(); } catch {}
process.exit(0);
