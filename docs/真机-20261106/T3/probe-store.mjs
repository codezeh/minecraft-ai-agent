// 探测：面板 0 agent ⇒ ConsoleView 走 empty 分支、ChatStream 不挂载。
// 这里只做「能不能在页面运行时摸到 Vue 实例上的 store」的可达性探测，不改源码。
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
await cdp.send('Page.navigate', { url: `http://localhost:8080/console?token=${TOKEN}` }, sid);
await sleep(3500);

const DISCOVER = `(() => {
  const out = { app: false, instances: [] };
  const appEl = document.querySelector('#app');
  const app = appEl && appEl.__vue_app__;
  out.app = !!app;
  if (!app) return out;
  const seen = new Set();
  const stack = [app._instance];
  const visitVNode = (vn) => {
    if (!vn) return;
    if (vn.component) stack.push(vn.component);
    const c = vn.children;
    if (Array.isArray(c)) c.forEach(visitVNode);
    else if (c && typeof c === 'object' && c.component) stack.push(c.component);
  };
  while (stack.length) {
    const inst = stack.pop();
    if (!inst || seen.has(inst)) continue;
    seen.add(inst);
    const name = (inst.type && (inst.type.__name || inst.type.name)) || 'anon';
    let keys = [];
    try { keys = Object.keys(inst.setupState || {}); } catch {}
    const hasStore = keys.includes('store');
    const storeShape = hasStore ? { agents: Array.isArray(inst.setupState.store.agents) ? inst.setupState.store.agents.length : 'not-array', connected: inst.setupState.store.connected } : null;
    out.instances.push({ name, setupKeys: keys, hasStore, storeShape });
    if (inst.subTree) visitVNode(inst.subTree);
  }
  return out;
})()`;

const r = await cdp.send('Runtime.evaluate', { expression: DISCOVER, returnByValue: true }, sid);
console.log('DISCOVER:', mask(JSON.stringify(r.result.value, null, 1)));

// 尝试注入 stub agent
const INJECT = `(() => {
  const app = document.querySelector('#app').__vue_app__;
  const seen = new Set(); const stack = [app._instance]; let store = null;
  const visit = (vn) => { if (!vn) return; if (vn.component) stack.push(vn.component); const c = vn.children; if (Array.isArray(c)) c.forEach(visit); };
  while (stack.length && !store) {
    const inst = stack.pop();
    if (!inst || seen.has(inst)) continue;
    seen.add(inst);
    const st = inst.setupState || {};
    for (const k of Object.keys(st)) {
      const v = st[k];
      if (v && typeof v === 'object' && Array.isArray(v.agents) && typeof v.connected === 'boolean') { store = v; break; }
    }
    if (inst.subTree) visit(inst.subTree);
  }
  if (!store) return { ok: false, reason: 'store not reachable' };
  store.agents.push({ name: 't3-stub', in_game: true, socket_connected: true, viewer_port: null });
  return { ok: true, agents: store.agents.map(a => a.name) };
})()`;
const r2 = await cdp.send('Runtime.evaluate', { expression: INJECT, returnByValue: true }, sid);
console.log('INJECT:', mask(JSON.stringify(r2.result.value)));
await sleep(700);
const r3 = await cdp.send('Runtime.evaluate', {
  expression: `JSON.stringify({ composer: !!document.querySelector('.composer input'), disabled: document.querySelector('.composer input') ? document.querySelector('.composer input').disabled : null, chatLines: document.querySelectorAll('.chat .line').length, body: document.body.innerText.slice(0,200) })`,
  returnByValue: true,
}, sid);
console.log('AFTER INJECT:', mask(r3.result.value));
fs.writeFileSync(path.join(T3, 'evidence', 'probe-store.json'), mask(JSON.stringify({ discover: r.result.value, inject: r2.result.value, after: r3.result.value }, null, 2)));
try { child.kill(); } catch {}
process.exit(0);
