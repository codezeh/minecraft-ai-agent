// T3 / WEB-003 真机验收：真实 Edge + CDP 直驱，跑 IME 键序，断言「组合中的回车是否被当成发送」。
//
// 两种模式（同一条驱动、同一台浏览器、同一批 CDP 键序，唯一变量是**被验的前端代码**）：
//   node t3-ime.mjs current  —— ChatStream.vue 取当前 web/src（含 isImeComposing 修复）
//   node t3-ime.mjs old      —— ChatStream.vue 取 git 22c41e8（修复前；与面板实际部署 bundle 里
//                               `function i(a){a.key==="Enter"&&!a.shiftKey&&(a.preventDefault(),r())}` 同构）
//
// 为什么不是直接打开面板 /console：
//   面板 0 agent（T1 的 bot 是裸 mineflayer，不经 mindserver）⇒ ConsoleView 的
//   `v-if="!store.agents.length"` 挡住整个 console 区 ⇒ ChatStream 不挂载，没有输入框可测。
//   而生产构建里 store 也摸不到（Vue 3.5 prod 不挂 _instance/__vueParentComponent、setupState 为空），
//   无法在页面里补一条 agent。故用最小夹具把**真实组件**挂起来（详见 fixture/*/main.ts 里的差异声明），
//   再用 CDP 的 Fetch.fulfillRequest 把它挂到 http://localhost:8080/console 上（同源 ⇒ cookie + socket 都真实）。
//
// 不新增依赖：ws 取自 mindcraft/node_modules。端口只用 9222 / 8080。token 一律打码（前 4 后 2）。

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'E:/我的世界ai';
const T3 = path.join(ROOT, 'docs/真机-20261106/T3');
const EV = path.join(T3, 'evidence');
fs.mkdirSync(EV, { recursive: true });

const require = createRequire(path.join(ROOT, 'mindcraft/'));
const WebSocket = require('ws');

const MODE = (process.argv[2] || 'current').trim() === 'old' ? 'old' : 'current';
const DIST = path.join(T3, `dist-${MODE}`);
const PANEL = 'http://localhost:8080';
const TOKEN = fs.readFileSync(path.join(ROOT, 'mindcraft/.mindserver-token'), 'utf8').trim();
const MASKED = TOKEN.slice(0, 4) + '****' + TOKEN.slice(-2);
const mask = (s) => String(s).split(TOKEN).join(MASKED).split(encodeURIComponent(TOKEN)).join(MASKED);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
const snapshots = [];
let stepNo = 0;

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.events = [];
    ws.on('message', (raw) => this._msg(raw));
  }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 128 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return new CDP(ws);
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  _msg(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      m.error ? p.rej(new Error(`${m.error.message} (${m.error.code})`)) : p.res(m.result);
      return;
    }
    this.events.push(m);
    for (const fn of this.handlers.get(m.method) || []) { try { fn(m.params, m.sessionId); } catch (e) { console.error('[handler]', m.method, e.message); } }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout: ' + method)); } }, 30000);
    });
  }
  /** 发一条 CDP 命令，并把「原始请求/响应」落盘（token 打码）。 */
  async rec(method, params = {}, sessionId, note) {
    const entry = { n: ++stepNo, mode: MODE, note: note || null, request: { method, params: JSON.parse(mask(JSON.stringify(params))) } };
    try {
      const result = await this.send(method, params, sessionId);
      entry.response = result === undefined ? null : JSON.parse(mask(JSON.stringify(result)));
    } catch (e) {
      entry.error = mask(e.message);
      steps.push(entry); flushSteps(); throw e;
    }
    steps.push(entry); flushSteps();
    return steps[steps.length - 1].response;
  }
  close() { try { this.ws.close(); } catch {} }
}
const flushSteps = () => fs.writeFileSync(path.join(EV, `${MODE}.steps.jsonl`), steps.map((s) => JSON.stringify(s)).join('\n') + '\n');

// ── 页面内观测器：只在 DOM 侧观察，不碰源码 ───────────────────────────────────
const INSTRUMENT = String.raw`
(() => {
  if (window.__t3) return 'already';
  const rec = [], clears = [];
  let seq = 0;
  const t0 = performance.now();
  const el = () => document.querySelector('.composer input');
  const val = () => { const e = el(); return e ? e.value : null; };
  const log = (o) => { rec.push(Object.assign({ n: ++seq, t: +(performance.now() - t0).toFixed(2) }, o)); if (rec.length > 800) rec.shift(); };
  const desc = (e) => ({
    eventType: e.type, key: e.key, code: e.code, keyCode: e.keyCode, which: e.which,
    isComposing: e.isComposing, repeat: e.repeat, defaultPrevented: e.defaultPrevented,
    shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey,
    target: e.target ? (e.target.tagName + (e.target.type ? '[' + e.target.type + ']' : '')) : null,
  });
  // window 捕获阶段 = 应用处理器之前；setTimeout(0) = 应用处理器之后（能读到最终 defaultPrevented）
  window.addEventListener('keydown', (e) => {
    log(Object.assign({ phase: 'keydown@capture', valueBefore: val() }, desc(e)));
    setTimeout(() => {
      log({ phase: 'keydown@settled', key: e.key, keyCode: e.keyCode, code: e.code, isComposing: e.isComposing,
            defaultPrevented: e.defaultPrevented, valueAfter: val(), clearsSoFar: clears.length,
            chatMeLines: document.querySelectorAll('.chat .line.me').length });
    }, 0);
  }, true);
  ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input'].forEach((k) => {
    window.addEventListener(k, (e) => {
      log({ phase: 'evt:' + k, data: (e.data === undefined ? null : e.data), inputType: e.inputType || null, isComposing: e.isComposing, value: val() });
    }, true);
  });
  window.__t3 = {
    rec, clears,
    snap() {
      const e = el();
      const st = window.__t3store;
      return {
        inputValue: val(),
        inputDisabled: e ? e.disabled : null,
        inputFocused: !!e && document.activeElement === e,
        chatMeLines: document.querySelectorAll('.chat .line.me').length,
        chatMeTexts: Array.from(document.querySelectorAll('.chat .line.me .text')).map((x) => x.textContent),
        chatAllLines: document.querySelectorAll('.chat .line').length,
        composerPlaceholder: e ? e.placeholder : null,
        store: st ? { connected: !!st.connected, agents: st.agents.map(a => a.name), current: st.current, lastError: st.lastError } : null,
        clears: clears.slice(),
        rec: rec.slice(),
      };
    },
    reset() { rec.length = 0; clears.length = 0; seq = 0; },
    // 「输入框被清空」= send() 唯一会把 input 置空的路径 ⇒ 用它数「send 被调用了几次」
    hookValue() {
      const e = el(); if (!e) return 'no-element'; if (e.__t3hooked) return 'already';
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      Object.defineProperty(e, 'value', {
        configurable: true,
        get() { return proto.get.call(e); },
        set(v) {
          const prev = proto.get.call(e);
          if (String(v) === '' && String(prev) !== '') clears.push({ t: +(performance.now() - t0).toFixed(2), text: prev });
          proto.set.call(e, v);
        },
      });
      e.__t3hooked = true; return 'hooked';
    },
    clearInput() { const e = el(); if (e) { const p = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); p.set.call(e, ''); e.dispatchEvent(new Event('input', { bubbles: true })); } return val(); },
    enable() { const e = el(); if (!e) return null; const was = e.disabled; e.disabled = false; e.focus(); return { wasDisabled: was, nowDisabled: e.disabled, focused: document.activeElement === e }; },
    // 页面内合成 KeyboardEvent —— 只用于「分支隔离」，报告里明确标注它不是浏览器输入
    synth(init) {
      const e = el(); if (!e) return 'no-element';
      e.focus();
      const ev = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
      e.dispatchEvent(ev);
      return { key: ev.key, keyCode: ev.keyCode, isComposing: ev.isComposing, defaultPrevented: ev.defaultPrevented };
    },
  };
  return 'installed';
})();
`;

async function evalIn(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error('page eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
async function snap(cdp, sid, label) {
  const s = await evalIn(cdp, sid, 'window.__t3.snap()');
  s.label = label; s.mode = MODE; snapshots.push(s);
  fs.writeFileSync(path.join(EV, `${MODE}.snapshots.json`), JSON.stringify(snapshots, null, 2));
  return s;
}
/** 发一条命令但不落 steps（用于焦点修正这类杂务）。 */
async function ev2(cdp, sid, expression) {
  try { return await evalIn(cdp, sid, expression); } catch { return null; }
}
/** 每条"应该被页面看到的按键"都必须被观测器看到，否则直接失败（防空证据）。 */
function mustObserve(sum, label) {
  if (!sum.keydowns || sum.keydowns.length === 0) {
    throw new Error(`未观测到 keydown（${label}）：CDP 事件没到达页面，本次证据作废`);
  }
  return sum;
}
const keyDown = (vk, key, code) => ({ type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (vk, key, code) => ({ type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
async function cdpPress(cdp, sid, note, vk, key, code) {
  await cdp.rec('Input.dispatchKeyEvent', keyDown(vk, key, code), sid, note + ' · rawKeyDown');
  await cdp.rec('Input.dispatchKeyEvent', keyUp(vk, key, code), sid, note + ' · keyUp');
  await sleep(160);
}

async function main() {
  const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const child = spawn(EDGE, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${path.join(os.tmpdir(), `t3-edge-profile-${MODE}`)}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // ★ 这三条是必需的：窗口被遮挡/后台化时 Chromium 会把页面标成 visibilityState="hidden"，
    //   并**丢弃 CDP 派发的键事件**（实测：visibilityState=hidden 时 keydown 观测到 0 条，
    //   同一脚本在页面 visible 时全部正常）。关掉遮挡检测与后台化，保证输入事件真的到达页面。
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion,msEdgeFirstRunExperience',
    ...(process.env.T3_HEADLESS === '1' ? ['--headless=new'] : []),
    '--window-size=1280,900', '--window-position=80,60',
    'about:blank',
  ], { stdio: 'ignore' });
  const HEADLESS = process.env.T3_HEADLESS === '1';

  let version = null;
  for (let i = 0; i < 80; i++) { try { version = await (await fetch('http://127.0.0.1:9222/json/version')).json(); break; } catch { await sleep(250); } }
  if (!version) throw new Error('Edge CDP 未就绪 (9222)');
  console.log('[edge]', version.Browser, '| UA:', version['User-Agent']);

  const bws = await CDP.connect(version.webSocketDebuggerUrl);
  const { targetId } = await bws.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await bws.send('Target.attachToTarget', { targetId, flatten: true });

  await bws.rec('Page.enable', {}, sid, 'domain');
  await bws.rec('Runtime.enable', {}, sid, 'domain');
  await bws.rec('Network.enable', {}, sid, 'domain');
  await bws.rec('Network.setCacheDisabled', { cacheDisabled: true }, sid, '禁缓存');
  await bws.rec('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sid, '页面内观测器（DOM 侧，不改源码）');

  // 第 1 步：正常导航一次，让服务端把 ?token 换成 HttpOnly cookie（302 → /console/）
  await bws.rec('Page.navigate', { url: `${PANEL}/console?token=${TOKEN}` }, sid, '① 首次导航：?token → HttpOnly cookie（服务端 302）');
  await sleep(2500);
  const cookieCheck = await evalIn(bws, sid, `JSON.stringify({ href: location.href, docs: document.cookie.includes('mindserver') })`);
  console.log('[cookie]', mask(cookieCheck));

  // 第 2 步：只拦截 /console*，用夹具页面顶替文档与资源（同源 8080 ⇒ cookie 与 socket.io 都真实）
  const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const served = [];
  bws.on('Fetch.requestPaused', async (p, s) => {
    const u = p.request.url;
    try {
      const pn = new URL(u).pathname;
      if (p.resourceType === 'Document') {
        served.push({ url: mask(u), as: 'document(index.html)', bytes: indexHtml.length });
        await bws.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(indexHtml, 'utf8').toString('base64'),
        }, s);
        return;
      }
      const base = path.posix.basename(pn);
      const fp = path.join(DIST, 'assets', base);
      if (fs.existsSync(fp)) {
        const ct = base.endsWith('.js') ? 'text/javascript; charset=utf-8' : base.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
        const buf = fs.readFileSync(fp);
        served.push({ url: mask(u), as: 'asset:' + base, bytes: buf.length });
        await bws.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: ct }, { name: 'Cache-Control', value: 'no-store' }],
          body: buf.toString('base64'),
        }, s);
        return;
      }
      await bws.send('Fetch.continueRequest', { requestId: p.requestId }, s);
    } catch (e) { console.error('[fetch]', e.message); }
  });
  await bws.rec('Fetch.enable', { patterns: [{ urlPattern: '*/console*', requestStage: 'Request' }] }, sid, '② 拦截 /console* 并用夹具顶替');
  await bws.rec('Page.navigate', { url: `${PANEL}/console/` }, sid, '③ 导航到夹具页面');
  await sleep(800);

  let ready = false;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try { if (await evalIn(bws, sid, "!!document.querySelector('.composer input')")) { ready = true; break; } } catch {}
  }
  if (!ready) throw new Error('夹具未挂载 .composer input');
  await sleep(800);

  const hooked = await evalIn(bws, sid, '__t3.hookValue()');
  // ★ 焦点就绪自检：新 profile 首次启动时，CDP 派发的键事件可能因为标签页/窗口未前置而根本不到页面
  //   （实测踩过一次：control0 与 ①-a..①-f 全空、②③④ 正常）。这里先用一个无副作用的 Shift
  //   探一次，观测器必须能收到；收不到就重试，仍收不到就直接失败 —— 绝不产出"空证据"。
  await bws.rec('Page.bringToFront', {}, sid, '把标签页提到前台');
  let warmup = 0;
  let focusOk = false;
  let focusDetail = null;
  for (let i = 0; i < 12 && !focusOk; i++) {
    warmup++;
    await evalIn(bws, sid, '__t3.clearInput(); __t3.reset(); __t3.enable()');
    await bws.send('Input.dispatchKeyEvent', keyDown(16, 'Shift', 'ShiftLeft'), sid);
    await bws.send('Input.dispatchKeyEvent', keyUp(16, 'Shift', 'ShiftLeft'), sid);
    await sleep(250);
    const seen = await evalIn(bws, sid, "window.__t3.rec.filter(r => r.phase === 'keydown@capture').length");
    const vis = await evalIn(bws, sid, 'document.visibilityState');
    focusDetail = { attempts: warmup, seen, visibilityState: vis };
    // 页面 hidden 时 Chromium 会丢弃键事件 ⇒ 必须 visible 且真的收到
    focusOk = seen > 0 && vis === 'visible';
    if (!focusOk) await ev2(bws, sid, 'window.focus(); document.body.focus(); document.querySelector(".composer input").focus();');
    await sleep(250);
  }
  console.log(`[focus] warmup attempts=${warmup} observed=${focusOk} detail=${JSON.stringify(focusDetail)} headless=${HEADLESS}`);
  if (!focusOk) throw new Error(`焦点/可见性自检失败：CDP 键事件没有到达页面（visibilityState=${focusDetail?.visibilityState}）。不产出证据；可用 T3_HEADLESS=1 重跑。`);
  await evalIn(bws, sid, '__t3.clearInput(); __t3.reset();');
  const probe = await evalIn(bws, sid, `JSON.stringify({
    hooked: '${hooked}',
    scripts: Array.from(document.scripts).map(s => s.src),
    placeholder: document.querySelector('.composer input').placeholder,
    disabled: document.querySelector('.composer input').disabled,
    bundleHasImeFix: null,
    store: window.__t3store ? { connected: window.__t3store.connected, agents: window.__t3store.agents.map(a => a.name) } : null
  })`);
  console.log('[fixture]', mask(probe));
  // 直接从页面里取回被执行的 bundle 文本特征（证明这一臂跑的是哪个版本）
  const bundleMark = await evalIn(bws, sid, `(async () => {
    const src = Array.from(document.scripts).map(s => s.src).find(s => /t3-index-.*\\.js$/.test(s));
    const t = await (await fetch(src)).text();
    return JSON.stringify({ src: src.replace(location.origin, ''), bytes: t.length, hasImeComposing: /isComposing/.test(t), has229: /keyCode\\s*===?\\s*229|229/.test(t), hasProcess: /Process/.test(t) });
  })()`);
  console.log('[bundle]', mask(bundleMark));

  const A = {};

  // ── 控制组 0：disabled 输入框上按回车 → 不应有任何 keydown 进到应用（证明后面的观测不是空转）──
  await evalIn(bws, sid, `(() => { const e = document.querySelector('.composer input'); e.disabled = true; e.blur(); __t3.reset(); return e.disabled; })()`);
  await cdpPress(bws, sid, 'control0: disabled 输入框上的 Enter', 13, 'Enter', 'Enter');
  const c0 = await snap(bws, sid, 'control0-disabled-enter');
  A.control0_disabled_enter = {
    keydownsSeen: c0.rec.filter((r) => r.phase === 'keydown@capture').length,
    keydownTargets: c0.rec.filter((r) => r.phase === 'keydown@capture').map((r) => r.target),
    clears: c0.clears.length,
    inputValue: c0.inputValue,
    note: 'disabled 时 keydown 只落到 BODY（应用处理器挂在 input 上，收不到）⇒ 后面各序列的输入框一定是被显式启用过的',
  };
  await evalIn(bws, sid, '__t3.enable()');

  // ══ 序列① 组合中的回车（预期：不发送）════════════════════════════════════
  await evalIn(bws, sid, '__t3.clearInput(); __t3.reset(); __t3.enable()');
  await bws.rec('Input.imeSetComposition', { text: 'nihaoshijie', selectionStart: 12, selectionEnd: 12 }, sid, '①-a 造中文候选（composition 进行中）');
  await sleep(150);
  const s1a0 = await snap(bws, sid, '①-a-before-enter');
  await cdpPress(bws, sid, '①-a 组合中的回车：rawKeyDown VK=229 key=Process', 229, 'Process', '');
  const s1a = await snap(bws, sid, '①-a-after-enter');
  A['seq1a_composition_enter(key=Process,VK=229)'] = mustObserve(summarize(s1a, s1a0), '①-a');

  await cdpPress(bws, sid, '①-b 组合中的回车：rawKeyDown VK=229 key=Enter', 229, 'Enter', 'Enter');
  const s1b = await snap(bws, sid, '①-b-after-enter');
  A['seq1b_composition_enter(key=Enter,VK=229)'] = mustObserve(summarize(s1b, s1a), '①-b');

  await cdpPress(bws, sid, '①-c 组合中的回车：rawKeyDown VK=13 key=Enter', 13, 'Enter', 'Enter');
  const s1c = await snap(bws, sid, '①-c-after-enter');
  A['seq1c_composition_enter(key=Enter,VK=13)'] = mustObserve(summarize(s1c, s1b), '①-c');

  await cdpPress(bws, sid, '①-d 分支隔离：key=Process + VK=65（keyCode 不是 229）', 65, 'Process', 'KeyA');
  const s1d = await snap(bws, sid, '①-d-after-key');
  A['seq1d_branch_key=Process_only'] = mustObserve(summarize(s1d, s1c), '①-d');

  await evalIn(bws, sid, '__t3.reset()');
  const synthRes = await bws.rec('Runtime.evaluate', { expression: "__t3.synth({ key: 'Enter', keyCode: 13, which: 13, isComposing: true })", returnByValue: true }, sid, '①-e 分支隔离：页面内合成 KeyboardEvent(isComposing:true)');
  await sleep(180);
  const s1e = await snap(bws, sid, '①-e-after-synth');
  A['seq1e_branch_isComposing_only'] = Object.assign({ synthReturn: synthRes.result.value }, summarize(s1e, null));

  // 收尾这次 composition
  await bws.rec('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }, sid, '① 收尾：清空组合（compositionend）');
  await sleep(200);
  await snap(bws, sid, '①-cleanup');

  // ══ 序列①-f（最接近真人的复现）：**已有上屏文字**，再起一段组合，组合中回车 ══════
  // 为什么必须补这一条：v-model 在组合期间不写回 ref（Vue 的 vModelText 对 e.target.composing
  // 直接 return），所以"只在组合里但还没上屏"时旧代码虽然 preventDefault 了、send() 却因文本为空而空转。
  // 真人用微软拼音的典型形态是「前一段已经上屏 + 正在选下一段的候选词」——这时回车会把**已上屏的
  // 半句话**发出去并清空输入框，这才是缺陷报告里那句"还没打完就被发出去"。
  await evalIn(bws, sid, '__t3.clearInput(); __t3.reset(); __t3.enable()');
  await bws.rec('Input.insertText', { text: '你好' }, sid, '①-f 先上屏一段（"你好" 进入 v-model）');
  await sleep(150);
  await bws.rec('Input.imeSetComposition', { text: 'shijie', selectionStart: 6, selectionEnd: 6 }, sid, '①-f 再起一段组合（"shijie" 候选窗，尚未上屏）');
  await sleep(150);
  const s1f0 = await snap(bws, sid, '①-f-before-enter');
  await cdpPress(bws, sid, '①-f 组合中的回车：VK=13 key=Enter', 13, 'Enter', 'Enter');
  await sleep(160);
  const s1f = await snap(bws, sid, '①-f-after-enter');
  A['seq1f_composing_with_committed_text'] = mustObserve(summarize(s1f, s1f0), '①-f');
  const shot1f = await bws.send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(EV, `${MODE}-1f-composing-enter.png`), Buffer.from(shot1f.data, 'base64'));
  await bws.rec('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }, sid, '①-f 收尾：清空组合');

  // ══ 序列② 组合结束后再回车（预期：发送一次）══════════════════════════════
  await evalIn(bws, sid, '__t3.clearInput(); __t3.reset(); __t3.enable()');
  await bws.rec('Input.imeSetComposition', { text: 'nihaoshijie', selectionStart: 12, selectionEnd: 12 }, sid, '② 造 composition');
  await sleep(120);
  await bws.rec('Input.insertText', { text: '你好世界' }, sid, '② 上屏（compositionend，组合结束）');
  await sleep(250);
  const s2pre = await snap(bws, sid, '②-before-enter');
  await cdpPress(bws, sid, '② 组合结束后的回车（VK=13 key=Enter）', 13, 'Enter', 'Enter');
  await sleep(160);
  const s2 = await snap(bws, sid, '②-after-enter');
  A.seq2_after_composition_enter = mustObserve(summarize(s2, s2pre), '②');

  // ══ 序列③ 普通回车（无 composition，预期：发送一次）════════════════════════
  await evalIn(bws, sid, '__t3.clearInput(); __t3.reset(); __t3.enable()');
  await bws.rec('Input.insertText', { text: '普通回车测试' }, sid, '③ 直接打字（无 composition）');
  await sleep(140);
  const s3pre = await snap(bws, sid, '③-before-enter');
  await cdpPress(bws, sid, '③ 普通回车（VK=13 key=Enter）', 13, 'Enter', 'Enter');
  await sleep(160);
  const s3 = await snap(bws, sid, '③-after-enter');
  A.seq3_plain_enter = mustObserve(summarize(s3, s3pre), '③');
  const shot3 = await bws.send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(EV, `${MODE}-3-plain-enter.png`), Buffer.from(shot3.data, 'base64'));

  // ══ 序列④ 加分：insertText 直接上屏后立刻 Enter，不应丢字 ══════════════════
  await evalIn(bws, sid, '__t3.clearInput(); __t3.reset(); __t3.enable()');
  const s4pre = await snap(bws, sid, '④-before-insertText');
  await bws.rec('Input.insertText', { text: '上屏即回车' }, sid, '④ 直接上屏');
  await bws.rec('Input.dispatchKeyEvent', keyDown(13, 'Enter', 'Enter'), sid, '④ 上屏后**立刻** Enter（无间隔）· rawKeyDown');
  await bws.rec('Input.dispatchKeyEvent', keyUp(13, 'Enter', 'Enter'), sid, '④ keyUp');
  await sleep(250);
  const s4 = await snap(bws, sid, '④-after-enter');
  A.seq4_inserttext_then_enter = mustObserve(summarize(s4, s4pre), '④');

  // ══ 附：Shift+Enter 不发送（旧代码也如此，作 sanity）════════════════════════
  await evalIn(bws, sid, '__t3.clearInput(); __t3.reset(); __t3.enable()');
  const s5pre = await snap(bws, sid, '附-before');
  await bws.rec('Input.insertText', { text: '换行测试' }, sid, '附 Shift+Enter 前打字');
  await bws.rec('Input.dispatchKeyEvent', { ...keyDown(13, 'Enter', 'Enter'), modifiers: 8 }, sid, '附 Shift+Enter rawKeyDown (modifiers=8)');
  await bws.rec('Input.dispatchKeyEvent', { ...keyUp(13, 'Enter', 'Enter'), modifiers: 8 }, sid, '附 Shift+Enter keyUp');
  await sleep(200);
  const s5 = await snap(bws, sid, '附-ShiftEnter');
  A.appendix_shift_enter = mustObserve(summarize(s5, s5pre), '附-Shift+Enter');

  const summary = {
    mode: MODE,
    headless: HEADLESS,
    focusSelfCheck: focusDetail,
    edge: version.Browser,
    userAgent: version['User-Agent'],
    fixture: { dist: path.basename(DIST), served, bundleMark: JSON.parse(bundleMark) },
    pageUrl: mask(`${PANEL}/console/`),
    token: MASKED,
    assertions: A,
    files: { steps: `${MODE}.steps.jsonl`, snapshots: `${MODE}.snapshots.json` },
  };
  fs.writeFileSync(path.join(EV, `${MODE}.summary.json`), JSON.stringify(summary, null, 2));
  console.log('\n===== ' + MODE + ' 断言汇总 =====');
  console.log(JSON.stringify(A, null, 2));
  const exc = bws.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text);
  console.log('\n页面异常:', JSON.stringify(exc).slice(0, 800));

  bws.close();
  try { child.kill(); } catch {}
  await sleep(500);
  process.exit(0);
}

/** 从快照差分出「这一次按键发生了什么」。 */
function summarize(cur, prev) {
  const newRec = prev ? cur.rec.slice(prev.rec.length) : cur.rec;
  const downs = newRec.filter((r) => r.phase === 'keydown@capture').map((r) => ({ key: r.key, code: r.code, keyCode: r.keyCode, isComposing: r.isComposing, target: r.target, valueBefore: r.valueBefore }));
  const settled = newRec.filter((r) => r.phase === 'keydown@settled').map((r) => ({ key: r.key, keyCode: r.keyCode, isComposing: r.isComposing, defaultPrevented: r.defaultPrevented, valueAfter: r.valueAfter, clearsSoFar: r.clearsSoFar, chatMeLines: r.chatMeLines }));
  const newClears = prev ? cur.clears.slice(prev.clears.length) : cur.clears;
  const comp = newRec.filter((r) => r.phase.startsWith('evt:')).map((r) => ({ phase: r.phase, data: r.data, value: r.value }));
  const curTexts = cur.chatMeTexts || [];
  const prevTexts = (prev && prev.chatMeTexts) || [];
  const newChatTexts = curTexts.slice(prevTexts.length);
  return {
    keydowns: downs,
    settled,
    sendPathExecuted: newClears.length > 0,
    sendCount: newClears.length,
    clearedTexts: newClears.map((c) => c.text),
    inputValueBefore: prev ? prev.inputValue : null,
    inputValueAfter: cur.inputValue,
    chatMeLinesBefore: prev ? prev.chatMeLines : null,
    chatMeLinesAfter: cur.chatMeLines,
    chatLinesDelta: prev ? cur.chatMeLines - prev.chatMeLines : null,
    chatMeTextsAdded: newChatTexts,
    compositionEvents: comp,
    storeConnected: cur.store ? cur.store.connected : null,
  };
}

main().catch((e) => {
  console.error('[FATAL]', mask(e.stack || e.message));
  fs.writeFileSync(path.join(EV, `${MODE}.fatal.txt`), mask(String(e.stack || e.message)));
  process.exit(1);
});
