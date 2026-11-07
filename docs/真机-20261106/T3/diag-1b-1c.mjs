// T3 定向诊断：旧版（无 IME 守卫）在「组合中回车」时为什么 defaultPrevented=true 却 send 不出去？
//
// 待验证假设：Vue 的 vModelText 在组合期间不同步 DOM→ref（onInput 里 `e.target.composing` 直接 return），
// 所以 onKey 里 send() 读到的 `input.value` 是空串 ⇒ `if (!text) return` 空转。
//
// 判据必须是**页面可观测**的，不能靠猜：
//   ChatStream 的"发送"按钮是 `:disabled="!currentAgent?.in_game || !input.trim()"`
//   ⇒ 按钮 disabled 与否直接反映 **ref** 是否为空（与输入框 DOM 里的候选文本无关）。
//   ／同一时刻 DOM 输入框里明明有字 ⇒ 两者不一致就证明「DOM 有字、ref 空」。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'E:/我的世界ai';
const T3 = path.join(ROOT, 'docs/真机-20261106/T3');
const EV = path.join(T3, 'evidence');
const require = createRequire(path.join(ROOT, 'mindcraft/'));
const WebSocket = require('ws');
const TOKEN = fs.readFileSync(path.join(ROOT, 'mindcraft/.mindserver-token'), 'utf8').trim();
const MASKED = TOKEN.slice(0, 4) + '****' + TOKEN.slice(-2);
const mask = (s) => String(s).split(TOKEN).join(MASKED).split(encodeURIComponent(TOKEN)).join(MASKED);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIST = path.join(T3, 'dist-old'); // 旧版（= 部署产物行为）
const steps = [];

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); ws.on('message', (r) => this._m(r)); }
  on(m, f) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(f); }
  _m(raw) {
    const m = JSON.parse(raw.toString());
    if (m.id !== undefined) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    for (const f of this.handlers.get(m.method) || []) f(m.params, m.sessionId);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 20000); });
  }
  async rec(method, params = {}, sessionId, note) {
    const e = { n: steps.length + 1, note, request: { method, params: JSON.parse(mask(JSON.stringify(params))) } };
    try { e.response = await this.send(method, params, sessionId) ?? null; } catch (err) { e.error = mask(err.message); }
    steps.push(e);
    fs.writeFileSync(path.join(EV, 'diag-1b1c.steps.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
    if (e.error) throw new Error(e.error);
    return e.response;
  }
}

const INSTRUMENT = String.raw`
(() => {
  if (window.__t3) return 'already';
  const rec = [];
  const t0 = performance.now();
  const log = (o) => rec.push(Object.assign({ t: +(performance.now() - t0).toFixed(2) }, o));
  window.addEventListener('keydown', (e) => {
    log({ phase: 'keydown@capture', key: e.key, keyCode: e.keyCode, isComposing: e.isComposing, prevented: e.defaultPrevented, target: e.target && e.target.tagName });
    setTimeout(() => log({ phase: 'keydown@settled', key: e.key, isComposing: e.isComposing, prevented: e.defaultPrevented }), 0);
  }, true);
  ['compositionstart', 'compositionend', 'input'].forEach((k) => window.addEventListener(k, (e) => log({ phase: 'evt:' + k, data: e.data ?? null, isComposing: e.isComposing }), true));
  const inp = () => document.querySelector('.composer input');
  const btn = () => document.querySelector('.composer button.primary');
  window.__t3 = {
    rec,
    snap() {
      const i = inp(); const b = btn();
      return {
        domInputValue: i ? i.value : null,
        // ★ 关键：按钮 disabled 只取决于 ref 里的文本（input.trim()），不取决于 DOM
        sendButtonDisabled: b ? b.disabled : null,
        sendButtonLabel: b ? b.textContent : null,
        chatMeTexts: Array.from(document.querySelectorAll('.chat .line.me .text')).map((x) => x.textContent),
        composerPlaceholder: i ? i.placeholder : null,
      };
    },
    reset() { rec.length = 0; },
    clearInput() { const i = inp(); if (i) { const p = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); p.set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); } },
    enable() { const i = inp(); if (i) { i.disabled = false; i.focus(); } return i ? i.disabled : null; },
    clickSend() { const b = btn(); if (!b) return 'no-button'; b.click(); return { disabled: b.disabled }; },
  };
  return 'installed';
})();
`;

const KEY = (vk, key, code) => ({ type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const KEYUP = (vk, key, code) => ({ type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profileDir = path.join(os.tmpdir(), 't3-edge-profile-diag'); // 不塞进证据目录
const child = spawn(EDGE, ['--remote-debugging-port=9222', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let version = null;
for (let i = 0; i < 80; i++) { try { version = await (await fetch('http://127.0.0.1:9222/json/version')).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
const cdp = new CDP(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.rec('Page.enable', {}, sid, 'domain');
await cdp.rec('Runtime.enable', {}, sid, 'domain');
await cdp.rec('Network.enable', {}, sid, 'domain');
await cdp.rec('Network.setCacheDisabled', { cacheDisabled: true }, sid, '禁缓存');
await cdp.rec('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sid, '观测器');
await cdp.rec('Page.navigate', { url: `http://localhost:8080/console?token=${TOKEN}` }, sid, '① 种 cookie');
await sleep(2200);

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
cdp.on('Fetch.requestPaused', async (p, s) => {
  try {
    const pn = new URL(p.request.url).pathname;
    if (p.resourceType === 'Document') {
      await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(html, 'utf8').toString('base64') }, s);
      return;
    }
    const fp = path.join(DIST, 'assets', path.posix.basename(pn));
    if (fs.existsSync(fp)) {
      const ct = fp.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
      await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: ct }], body: fs.readFileSync(fp).toString('base64') }, s);
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, s);
  } catch (e) { console.error('[fetch]', e.message); }
});
await cdp.rec('Fetch.enable', { patterns: [{ urlPattern: '*/console*', requestStage: 'Request' }] }, sid, '② 挂旧版夹具');
await cdp.rec('Page.navigate', { url: 'http://localhost:8080/console/' }, sid, '③ 打开旧版夹具');
for (let i = 0; i < 80; i++) { await sleep(250); try { if (await ev("!!document.querySelector('.composer input')")) break; } catch {} }
await sleep(600);

async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
const snap = () => ev('window.__t3.snap()');
async function press(note, vk, key, code) {
  await cdp.rec('Input.dispatchKeyEvent', KEY(vk, key, code), sid, note + ' · rawKeyDown');
  await cdp.rec('Input.dispatchKeyEvent', KEYUP(vk, key, code), sid, note + ' · keyUp');
  await sleep(150);
}

await ev('__t3.enable()');
const out = {};

// ── 阶段 1：纯组合（就是 seq1b/1c 的形态）──
await ev('__t3.clearInput(); __t3.reset()');
await cdp.rec('Input.imeSetComposition', { text: 'nihaoshijie', selectionStart: 12, selectionEnd: 12 }, sid, '组合中（未上屏）');
await sleep(150);
out['1_composition_only_beforeEnter'] = await snap();
out['1_clickSend_duringComposition'] = await ev('__t3.clickSend()');
await sleep(150);
out['1_afterClickSend'] = await snap();
await press('组合中回车 VK=13', 13, 'Enter', 'Enter');
out['1_afterEnter'] = await snap();
out['1_events'] = await ev('window.__t3.rec.slice()');

// ── 阶段 2：结束组合（上屏），同一份文本再回车 ──
await cdp.rec('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }, sid, '结束组合');
await sleep(250);
out['2_afterCompositionEnd'] = await snap();
await press('组合结束后回车 VK=13', 13, 'Enter', 'Enter');
out['2_afterEnter'] = await snap();
out['2_sendButtonDisabled'] = out['2_afterEnter'].sendButtonDisabled;

// ── 阶段 3：对照——先上屏中文，再起一段组合（seq1f 形态），验证"ref 空 vs 非空"是唯一变量 ──
await ev('__t3.clearInput(); __t3.reset()');
await cdp.rec('Input.insertText', { text: '你好' }, sid, '先上屏「你好」（ref 此时应非空）');
await sleep(200);
out['3_afterCommittedText'] = await snap();
await cdp.rec('Input.imeSetComposition', { text: 'shijie', selectionStart: 6, selectionEnd: 6 }, sid, '再起一段组合');
await sleep(200);
out['3_compositionOnTopOfCommitted'] = await snap();
await press('组合中回车 VK=13（ref 已非空）', 13, 'Enter', 'Enter');
out['3_afterEnter'] = await snap();
out['3_events'] = await ev('window.__t3.rec.slice()');

fs.writeFileSync(path.join(EV, 'diag-1b1c.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
try { child.kill(); } catch {}
process.exit(0);
