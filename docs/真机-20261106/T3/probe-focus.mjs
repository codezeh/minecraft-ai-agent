// 探：CDP 键事件怎样才能可靠地到达页面（新 profile / 新标签页的前置问题）。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'E:/我的世界ai';
const require = createRequire(path.join(ROOT, 'mindcraft/'));
const WebSocket = require('ws');
const TOKEN = fs.readFileSync(path.join(ROOT, 'mindcraft/.mindserver-token'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wsUrl = async () => { for (let i = 0; i < 80; i++) { try { return (await (await fetch('http://127.0.0.1:9222/json/version')).json()).webSocketDebuggerUrl; } catch { await sleep(250); } } throw new Error('no cdp'); };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); ws.on('message', (r) => { const m = JSON.parse(r.toString()); if (m.id && this.p.has(m.id)) { const x = this.p.get(m.id); this.p.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } }); }
  send(method, params = {}, sessionId) { const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId; this.ws.send(JSON.stringify(msg)); return new Promise((res, rej) => { this.p.set(id, { res, rej }); setTimeout(() => { if (this.p.delete(id)) rej(new Error('timeout ' + method)); }, 15000); }); }
}

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const prof = path.join(os.tmpdir(), 't3-edge-probe-focus');
const child = spawn(EDGE, ['--remote-debugging-port=9222', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeFirstRunExperience', '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
const url = await wsUrl();
const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
const cdp = new CDP(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sid);
await cdp.send('Runtime.enable', {}, sid);
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__seen=[]; window.addEventListener('keydown',(e)=>window.__seen.push({key:e.key,keyCode:e.keyCode,target:e.target.tagName}),true);`
}, sid);
await cdp.send('Page.navigate', { url: `http://localhost:8080/console?token=${TOKEN}` }, sid);
await sleep(2500);

const ev = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sid)).result.value;
const state = async () => ev(`JSON.stringify({hasFocus:document.hasFocus(), vis:document.visibilityState, seen:window.__seen.length, href:location.href, active:document.activeElement && document.activeElement.tagName})`);
const press = async () => { await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sid); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sid); await sleep(300); };

console.log('A. 直接派发          ', await state()); await press(); console.log('   ->', await state());
await cdp.send('Page.bringToFront', {}, sid); await sleep(400);
console.log('B. bringToFront 后   ', await state()); await press(); console.log('   ->', await state());
await cdp.send('Target.activateTarget', { targetId }); await sleep(400);
console.log('C. activateTarget 后 ', await state()); await press(); console.log('   ->', await state());
// D. 用浏览器级 window 聚焦 + 输入框聚焦
await ev(`window.focus(); document.querySelector('.composer input') ? document.querySelector('.composer input').focus() : document.body.focus();`);
await sleep(300); console.log('D. focus() 后        ', await state()); await press(); console.log('   ->', await state());

fs.writeFileSync('E:/我的世界ai/docs/真机-20261106/T3/evidence/probe-focus.txt', 'see stdout');
try { child.kill(); } catch {}
process.exit(0);
