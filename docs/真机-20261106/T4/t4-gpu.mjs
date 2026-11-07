// T4 / WEB-004·005·010 真机验收驱动：真实 Edge + CDP + 真 WebGL，跑资源曲线/容量/包围球。
//
// 用法：
//   node t4-gpu.mjs <variant> [seconds]      variant = current | old（唯一变量是 TerrainCanvas.vue 版本）
//   node t4-gpu.mjs gpuinfo                 只抓 GPU（带 GPU 参数 vs 默认参数对照）
//
// 观测手段（不改产品源码）：
//   · vite alias 把 'three' 指到 T4/three-instrument.ts ⇒ 组件 new 出来的 WebGLRenderer 是我们的子类，
//     于是能拿到**真实** renderer.info.memory/render，并在每次 render() 时捕获 scene
//     ⇒ 从场景里遍历 InstancedMesh 读 capacity/count/boundingSphere/矩阵有限性。
//   · 数据由夹具调产品自己的 decodeTerrain() 灌入（与后端同格式 payload），不是真飞行采集。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'E:/我的世界ai';
const T4 = path.join(ROOT, 'docs/真机-20261106/T4');
const EV = path.join(T4, 'evidence');
fs.mkdirSync(EV, { recursive: true });
const require = createRequire(path.join(ROOT, 'mindcraft/'));
const WebSocket = require('ws');

const ARG = (process.argv[2] || 'current').trim();
const MODE = ARG === 'gpuinfo' ? 'gpuinfo' : ARG === 'old' ? 'old' : 'current';
const SECONDS = Number(process.argv[3] || 0) || (MODE === 'gpuinfo' ? 0 : 90);
const PANEL = 'http://localhost:8080';
const TOKEN = fs.readFileSync(path.join(ROOT, 'mindcraft/.mindserver-token'), 'utf8').trim();
const MASKED = TOKEN.slice(0, 4) + '****' + TOKEN.slice(-2);
const mask = (s) => String(s).split(TOKEN).join(MASKED).split(encodeURIComponent(TOKEN)).join(MASKED);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
let stepNo = 0;

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.events = [];
    ws.on('message', (raw) => this._msg(raw));
  }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return new CDP(ws);
  }
  on(m, f) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(f); }
  _msg(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      m.error ? p.rej(new Error(`${m.error.message} (${m.error.code})`)) : p.res(m.result);
      return;
    }
    this.events.push(m);
    for (const f of this.handlers.get(m.method) || []) { try { f(m.params, m.sessionId); } catch (e) { console.error('[h]', m.method, e.message); } }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
    });
  }
  async rec(method, params = {}, sessionId, note) {
    const e = { n: ++stepNo, mode: MODE, note: note || null, request: { method, params: JSON.parse(mask(JSON.stringify(params))) } };
    try { e.response = await this.send(method, params, sessionId) ?? null; } catch (err) { e.error = mask(err.message); }
    steps.push(e);
    fs.writeFileSync(path.join(EV, `${MODE}.steps.jsonl`), steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
    if (e.error) throw new Error(e.error);
    return steps[steps.length - 1].response;
  }
  close() { try { this.ws.close(); } catch {} }
}

const GPU_FLAGS = [
  '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-webgl', '--enable-webgl2-compute-context',
];
const BASE_FLAGS = [
  '--remote-debugging-port=9222',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  // T3 学到的：窗口被遮挡时 Chromium 标 hidden 并丢弃输入事件/降频，会让曲线失真
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion,msEdgeFirstRunFeature',
  '--window-size=1280,900', '--window-position=80,60',
];
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function launch(extraFlags, tag) {
  const child = spawn(EDGE, [
    ...BASE_FLAGS,
    `--user-data-dir=${path.join(os.tmpdir(), `t4-edge-profile-${tag}`)}`,
    ...extraFlags,
    'about:blank',
  ], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 100; i++) { try { version = await (await fetch('http://127.0.0.1:9222/json/version')).json(); break; } catch { await sleep(250); } }
  if (!version) throw new Error('Edge CDP 未就绪');
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { child, cdp, sid: sessionId, version };
}


// 页面级 GL 探针：不依赖 three，直接看驱动侧
//  · 对象计数 create*/delete*（资源曲线，独立于 renderer.info）
//  · drawElementsInstanced/drawArraysInstanced 的 instanceCount（真正画了多少实例）
//  · bufferData/bufferSubData 上传的 Float32Array 元信息（实例矩阵容量与有限性）
const GL_INSTRUMENT = String.raw`
(() => {
  if (window.__glc) return;
  const c = { createBuffer:0, deleteBuffer:0, createTexture:0, deleteTexture:0, createProgram:0, deleteProgram:0, createFramebuffer:0, deleteFramebuffer:0, createRenderbuffer:0, deleteRenderbuffer:0, createVertexArray:0, deleteVertexArray:0, contexts:0 };
  const d = { instanced: [], bufMeta: [], draws: 0, raf: 0, lastRafAt: 0 };
  (function beat() { d.raf++; d.lastRafAt = +(performance.now()).toFixed(1); requestAnimationFrame(beat); })();
  window.__glc = c; window.__gls = d;
  const wrapC = (proto, k) => {
    const orig = proto[k];
    if (typeof orig !== 'function' || orig.__w) return;
    const f = function (...a) { c[k]++; return orig.apply(this, a); };
    f.__w = 1; proto[k] = f;
  };
  const wrapD = (proto, k) => {
    const orig = proto[k];
    if (typeof orig !== 'function' || orig.__w) return;
    const f = function (...a) {
      d.draws++;
      try {
        // 两种签名：elements(count, type, offset, instanceCount) / arrays(first, count, instanceCount)
        // drawElementsInstanced(mode, count, type, offset, instanceCount)
        // drawArraysInstanced(mode, first, count, instanceCount)
        const ic = (k === 'drawElementsInstanced') ? a[4] : a[3];
        const cnt = (k === 'drawElementsInstanced') ? a[1] : a[2];
        if (typeof ic === 'number') {
          if (d.instanced.length >= 400) d.instanced.shift();   // 环形：只保留最近 400 条
          d.instanced.push({ m: k, instanceCount: ic, count: cnt | 0, t: +(performance.now()).toFixed(1) });
        }
      } catch (e) {}
      return orig.apply(this, a);
    };
    f.__w = 1; proto[k] = f;
  };
  const wrapBuf = (proto, k) => {
    const orig = proto[k];
    if (typeof orig !== 'function' || orig.__w) return;
    const f = function (...a) {
      try {
        for (const x of a) {
          if (x instanceof Float32Array && x.length >= 64) {
            let nonFinite = 0, mn = Infinity, mx = -Infinity;
            for (let i = 0; i < x.length; i++) { const v = x[i]; if (!Number.isFinite(v)) nonFinite++; else { if (v < mn) mn = v; if (v > mx) mx = v; } }
            const rec = { via: k, len: x.length, nonFinite, min: Number.isFinite(mn) ? +mn.toFixed(2) : null, max: Number.isFinite(mx) ? +mx.toFixed(2) : null, t: +(performance.now()).toFixed(1) };
            // 同长度只留最后一条，避免刷爆
            const i = d.bufMeta.findIndex((z) => z.len === rec.len);
            if (i >= 0) d.bufMeta[i] = rec; else if (d.bufMeta.length < 60) d.bufMeta.push(rec);
            break;
          }
        }
      } catch (e) {}
      return orig.apply(this, a);
    };
    f.__w = 1; proto[k] = f;
  };
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const gl = origGet.call(this, type, ...rest);
    if (gl && /webgl/i.test(String(type))) {
      c.contexts++; d.lastContext = gl; window.__gl = gl;
      const proto = Object.getPrototypeOf(gl);
      for (const k of Object.keys(c)) if (k !== 'contexts' && k.startsWith('create') || k.startsWith('delete')) { if (k !== 'contexts') wrapC(proto, k); }
      wrapD(proto, 'drawElementsInstanced'); wrapD(proto, 'drawArraysInstanced');
      wrapBuf(proto, 'bufferData'); wrapBuf(proto, 'bufferSubData');
    }
    return gl;
  };
})();
`;

const GPUINFO_EXPR = `(() => {
  const out = {};
  // 注意：同一个 canvas 上先取 webgl2 再取 webgl 会恒返回 null，必须用两个 canvas
  const c2 = document.createElement('canvas');
  const c1 = document.createElement('canvas');
  const gl2 = c2.getContext('webgl2');
  const gl1 = c1.getContext('webgl');
  const gl = gl2 || gl1;
  out.hasWebGL2 = !!gl2;
  out.hasWebGL1 = !!gl1;
  if (!gl) { out.error = 'no webgl context'; return out; }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  out.unmaskedVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
  out.unmaskedRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  if (!dbg) { out.note = 'WEBGL_debug_renderer_info not available'; out.vendor = gl.getParameter(gl.VENDOR); out.renderer = gl.getParameter(gl.RENDERER); }
  out.version = gl.getParameter(gl.VERSION);
  out.shadingLanguageVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
  const attrs = gl.getContextAttributes() || {};
  out.antialias = attrs.antialias; out.powerPreference = attrs.powerPreference;
  out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  out.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  return out;
})()`;

async function gpuInfoStage() {
  // 两套启动参数各测一次：带 GPU 参数 / 默认（常落 SwiftShader）
  const out = {};
  for (const [tag, flags] of [['gpu', GPU_FLAGS], ['default', []]]) {
    const { child, cdp, sid, version } = await launch(flags, tag);
    await cdp.rec('Page.enable', {}, sid, 'domain');
    await cdp.rec('Runtime.enable', {}, sid, 'domain');
    await cdp.rec('Page.navigate', { url: `${PANEL}/console?token=${TOKEN}` }, sid, '种 cookie + 同源页面');
    await sleep(2500);
    const r = await cdp.rec('Runtime.evaluate', { expression: GPUINFO_EXPR, returnByValue: true }, sid, `GPU 信息（${tag}）`);
    out[tag] = { flags, browser: version['User-Agent'], gpu: r.result.value };
    cdp.close(); try { child.kill(); } catch {}
    await sleep(800);
  }
  fs.writeFileSync(path.join(EV, 'gpuinfo.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// ── 采样器：每秒读 renderer.info + 场景里的 InstancedMesh ──────────────────────────
const SAMPLE_EXPR = `(() => {
  const t4 = window.__t4 || {};
  const r = (t4.renderers || [])[0];
  const glc = window.__glc || null;
  const gls = window.__gls || { instanced: [], bufMeta: [], draws: 0 };
  const live = glc ? {
    buffers: glc.createBuffer - glc.deleteBuffer,
    textures: glc.createTexture - glc.deleteTexture,
    programs: glc.createProgram - glc.deleteProgram,
    vas: glc.createVertexArray - glc.deleteVertexArray,
    framebuffers: glc.createFramebuffer - glc.deleteFramebuffer,
  } : null;
  // 最近 1 秒内的 instanced 绘制里最大的 instanceCount（反映"这一帧到底画了多少实例"）
  const recent = gls.instanced.slice(-24);
  const maxInst = recent.length ? Math.max(...recent.map(x => x.instanceCount)) : null;
  return {
    t: +(performance.now() / 1000).toFixed(2),
    gl: glc ? { ...glc } : null,
    live,
    drawCallsTotal: gls.draws,
    maxInstanceCountRecent: maxInst,
    instanceCountSet: [...new Set(recent.map(x => x.instanceCount))],
    instancedRecent: recent.slice(-6),
    bufMeta: gls.bufMeta.map(b => ({ len: b.len, nonFinite: b.nonFinite, min: b.min, max: b.max, via: b.via })),
    three: r ? { geometries: r.info.memory.geometries, textures: r.info.memory.textures, triangles: r.info.render.triangles, calls: r.info.render.calls } : null,
    dataState: window.__t4ctl ? window.__t4ctl.state() : null,
    vis: document.visibilityState,
    hasFocus: document.hasFocus(),
    raf: (window.__gls || {}).raf || 0,
    renders: t4.renders || 0,
    contextLost: t4.contextLost || 0,
    diag: window.__t4diag || null,
    glError: (() => {
      try {
        let gl = window.__gl || (window.__gls || {}).lastContext || (t4.contexts || [])[0];
        if (!gl) {
          // three 用 'webgl2' 建的上下文；对同一 canvas 再取一次拿回同一个上下文对象
          const cv = document.querySelector('.terrain-host canvas') || document.querySelector('canvas');
          if (cv) gl = cv.getContext('webgl2') || cv.getContext('webgl') || cv.getContext('experimental-webgl');
        }
        if (!gl) return 'no-context';
        const errs = []; for (let i = 0; i < 8; i++) { const e = gl.getError(); if (e === 0) break; errs.push(e); }
        return errs.length ? errs : 'NONE';
      } catch (e) { return 'err:' + e; }
    })(),
  };
})()`;

async function main() {
  if (MODE === 'gpuinfo') return gpuInfoStage();

  const DIST = path.join(T4, `dist-${MODE}`);
  const { child, cdp, sid, version } = await launch(GPU_FLAGS, `${MODE}`);
  console.log('[edge]', version.Browser);

  await cdp.rec('Page.enable', {}, sid, 'domain');
  await cdp.rec('Runtime.enable', {}, sid, 'domain');
  await cdp.rec('Log.enable', {}, sid, 'domain（抓 console 里的 WebGL 报错）');
  await cdp.rec('Network.enable', {}, sid, 'domain');
  await cdp.rec('Network.setCacheDisabled', { cacheDisabled: true }, sid, '禁缓存');
  await cdp.rec('Page.addScriptToEvaluateOnNewDocument', { source: GL_INSTRUMENT }, sid, '页面级 GL 对象计数（独立于 three）');
  cdp.on('Log.entryAdded', (p) => {
    const t = p?.entry?.text || '';
    if (/WebGL|INVALID_|GL_|draw|out of range/i.test(t)) console.log('[console!]', mask(t).slice(0, 300));
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const t = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/WebGL|INVALID_|draw|out of range|THREE/i.test(t)) console.log('[consoleAPICalled!]', mask(t).slice(0, 300));
  });

  // 1) 种 cookie（正常导航一次）
  await cdp.rec('Page.navigate', { url: `${PANEL}/console?token=${TOKEN}` }, sid, '① 种 HttpOnly cookie');
  await sleep(2500);
  // 2) 拦截 /console* → 夹具
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const served = [];
  cdp.on('Fetch.requestPaused', async (p, s) => {
    try {
      const pn = new URL(p.request.url).pathname;
      if (p.resourceType === 'Document') {
        served.push({ url: mask(p.request.url), as: 'document', bytes: html.length });
        await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(html, 'utf8').toString('base64') }, s);
        return;
      }
      const fp = path.join(DIST, 'assets', path.posix.basename(pn));
      if (fs.existsSync(fp)) {
        const ct = fp.endsWith('.js') ? 'text/javascript; charset=utf-8' : fp.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
        served.push({ url: mask(p.request.url), as: path.posix.basename(pn), bytes: fs.statSync(fp).size });
        await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: ct }], body: fs.readFileSync(fp).toString('base64') }, s);
        return;
      }
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, s);
    } catch (e) { console.error('[fetch]', e.message); }
  });
  await cdp.rec('Fetch.enable', { patterns: [{ urlPattern: '*/console*', requestStage: 'Request' }] }, sid, '② 用夹具顶替 /console');
  await cdp.rec('Page.navigate', { url: `${PANEL}/console/` }, sid, '③ 打开夹具（同源，cookie/socket 真实）');

  const ev = async (expr, note) => {
    const r = note ? await cdp.rec('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, sid, note)
      : await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };

  // 等夹具与 canvas 就绪
  let ready = false;
  for (let i = 0; i < 100; i++) {
    await sleep(250);
    try { if (await ev("!!document.querySelector('.terrain-host canvas') && !!window.__t4ctl")) { ready = true; break; } } catch {}
  }
  if (!ready) throw new Error('夹具未就绪（.terrain-host canvas / __t4ctl）');
  await cdp.rec('Page.bringToFront', {}, sid, '提到前台');
  // 关键：页面被标 hidden 时 RAF 会停 ⇒ 渲染停止、绘制统计冻结（T3 踩过同类坑）。
  // 用 CDP 的焦点模拟让页面持续认为自己是活跃的，同时每帧记录 rAF 心跳用于自证。
  await cdp.rec('Emulation.setFocusEmulationEnabled', { enabled: true }, sid, '让页面保持"已聚焦"（RAF 不被暂停）');
  await sleep(800);

  const out = { mode: MODE, edge: version.Browser, ua: version['User-Agent'], fixture: { dist: path.basename(DIST), served }, startedAt: new Date().toISOString() };

  // ── 0. GPU 身份（这一臂实际用的渲染器）────────────────────────────────────
  out.gpu = await ev(GPUINFO_EXPR, 'GPU 身份（WEBGL_debug_renderer_info）');
  console.log('[gpu]', JSON.stringify(out.gpu));
  const vis = await ev('document.visibilityState');
  out.visibilityState = vis;

  // ── 1. 空场景基线 ────────────────────────────────────────────────────────
  await sleep(500);
  out.baseline_empty = await ev(SAMPLE_EXPR, '基线（无地形数据）');

  // ── 2. 灌入地形（真实 decodeTerrain 路径）────────────────────────────────
  out.load_result = await ev('__t4ctl.load({ cols: 40, heights: 4 })', '灌入地形：40×40 列、每列 1..4 层');
  await sleep(1200); // 等 watcher + 渲染
  out.after_load = await ev(SAMPLE_EXPR, '加载后');

  // ── 3a. 空转曲线（不推送位置，只等）：隔离"渲染循环自身是否增长" ──────────
  const idleCurve = [];
  const ti0 = Date.now();
  for (let s = 0; s < Math.min(10, Math.max(6, Math.floor(SECONDS / 6))); s++) {
    const sample = await ev(SAMPLE_EXPR);
    sample.i = s; sample.wallMs = Date.now() - ti0;
    idleCurve.push(sample);
    await sleep(Math.max(0, 1000 - (Date.now() - ti0 - s * 1000)));
  }
  out.idleCurve = idleCurve;
  fs.writeFileSync(path.join(EV, `${MODE}.idle-curve.json`), JSON.stringify(idleCurve, null, 2));
  console.log('[idle] live buffers:', idleCurve.map(x => x.live?.buffers).join(','), '| programs:', idleCurve.map(x => x.live?.programs).join(','));

  // ── 3b. WEB-005 资源曲线：1Hz 位置推送（触发 rebuildMarker）+ 每秒采样 ──────
  const curve = [];
  const t0 = Date.now();
  for (let s = 0; s < SECONDS; s++) {
    await ev(`__t4ctl.tickMarker(${s})`);
    const sample = await ev(SAMPLE_EXPR);
    sample.i = s;
    sample.wallMs = Date.now() - t0;
    curve.push(sample);
    if (s % 10 === 0) console.log(`[curve ${s}s] liveBuf=${sample.live?.buffers} liveProg=${sample.live?.programs} maxInst=${sample.maxInstanceCountRecent} drawTotal=${sample.drawCallsTotal}`);
    await sleep(Math.max(0, 1000 - (Date.now() - t0 - s * 1000)));
  }
  out.curve = curve;
  fs.writeFileSync(path.join(EV, `${MODE}.curve.json`), JSON.stringify(curve, null, 2));

  // ── 4. WEB-004：3000 个失败点（后端上限）─────────────────────────────────
  // WEB-004 场景：地形**先到位**，之后才来 3000 个失败点 ⇒ 走 ensureCapacity 扩容路径
  // （这正是原缺陷形态：failMesh 在 onMounted 按当时 fails 数建，事后到达的失败点会越界写入）
  out.set_fails_3000 = await ev('__t4ctl.setFails(3000)', '地形已存在时，塞入 3000 个失败点（后端上限）');
  await sleep(400);
  await ev('(__t4ctl.setShowFails(false), "off")', '关失败点图层 → rebuildFails(count=0)');
  await sleep(700);
  await ev('(__t4ctl.setShowFails(true), "on")', '开失败点图层 → rebuildFails → ensureCapacity 按 3000 扩容');
  await sleep(2500);
  out.fails_state = await ev('__t4ctl.state()', '确认失败点已进 terrain.decoded');
  out.after_fails = await ev(SAMPLE_EXPR, '3000 失败点后（容量/instanceCount/矩阵有限性）');
  out.gl_error_after_fails = await ev(`(() => { const gl = (window.__t4.contexts||[])[0]; if (!gl) return 'no-context'; const errs=[]; for (let i=0;i<8;i++){ const e = gl.getError(); if (e===0) break; errs.push(e);} return errs.length?errs:'NONE'; })()`, '显式清空并读取 GL 错误队列');
  out.console_errors = cdp.events.filter((e) => e.method === 'Log.entryAdded').map((e) => e.params?.entry?.text).filter((t) => t && /WebGL|INVALID_|draw|out of range/i.test(t));

  // ── 4b. 截图①：地形 + 3000 个失败点（红球）────────────────────────────────
  {
    const sh = await cdp.rec('Page.captureScreenshot', { format: 'png' }, sid, '截图①：地形 + 3000 失败点');
    fs.writeFileSync(path.join(T4, `${MODE}-terrain-fails.png`), Buffer.from(sh.data, 'base64'));
  }

  // ── 5. WEB-010：同容量复用 + 包围球（换到远处另一片地形）──────────────────
  out.before_reuse = await ev(SAMPLE_EXPR, '复用前');
  // 关键：cols 30 ⇒ 面数约 2250 < 现有容量 3999 ⇒ ensureCapacity 会**复用同一个 mesh**
  // （这正是 WEB-010 的场景：矩阵/count 换了、包围球必须跟着重算）
  out.reuse_load = await ev('__t4ctl.load({ cols: 30, heights: 4, origin: [8000, 60, 8000], seed: 999 })', '面数更小、换到 (8000,60,8000)：应复用同容量 mesh');
  await sleep(1600);
  out.after_reuse = await ev(SAMPLE_EXPR, '复用后（draw 是否仍发生 = 有没有被视锥误裁）');

  // ── 6. 只显示最上层 / 切片（顺带看 count 与三角形变化）────────────────────
  out.top_only = await ev('(__t4ctl.setTopOnly(true), "ok")');
  await sleep(800);
  out.after_top_only = await ev(SAMPLE_EXPR, '只看最上层');
  await ev('__t4ctl.setTopOnly(false)');

  // ── 8. 卸载整棵视图 → 资源必须回落（WEB-005 的卸载路径）────────────────────
  out.before_unmount = await ev(SAMPLE_EXPR, '卸载前');
  await ev('__t4ctl.unmount()', '卸载 TerrainView（触发 onBeforeUnmount 全量 dispose）');
  await sleep(1500);
  out.after_unmount = await ev(SAMPLE_EXPR, '卸载后');

  // ── 9. 重新挂载 + 再灌一次，看是否二次泄漏 ───────────────────────────────
  await ev('__t4ctl.remount()');
  await sleep(1200);
  await ev('__t4ctl.load({ cols: 24, heights: 3, origin: [0,60,0], seed: 7 })');
  await sleep(1200);
  out.after_remount = await ev(SAMPLE_EXPR, '重新挂载并再灌一次');
  // 复用后立刻再来一张（看远处那一片是否正常可见）
  {
    const sh2 = await cdp.rec('Page.captureScreenshot', { format: 'png' }, sid, '截图②：复用后的远处地形');
    fs.writeFileSync(path.join(T4, `${MODE}-reuse-far.png`), Buffer.from(sh2.data, 'base64'));
  }
  const shot2 = await cdp.rec('Page.captureScreenshot', { format: 'png' }, sid, '截图③：重新挂载后的地形');
  fs.writeFileSync(path.join(T4, `${MODE}-remount.png`), Buffer.from(shot2.data, 'base64'));

  out.pageErrors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => mask(e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text).slice(0, 400));

  fs.writeFileSync(path.join(EV, `${MODE}.summary.json`), JSON.stringify(out, null, 2));
  console.log('\n=== 摘要 ===');
  console.log('gpu:', JSON.stringify(out.gpu?.unmaskedRenderer || out.gpu?.renderer), '| vendor:', JSON.stringify(out.gpu?.unmaskedVendor));
  const brief = (x) => JSON.stringify({ live: x.live, draws: x.drawCallsTotal, maxInst: x.maxInstanceCountRecent });
  console.log('empty  ', brief(out.baseline_empty));
  console.log('loaded ', brief(out.after_load), '| bufMeta:', JSON.stringify(out.after_load.bufMeta));
  const lo = curve.map((c) => c.live?.buffers);
  console.log('curve buffers live first/last/min/max:', lo[0], lo[lo.length - 1], Math.min(...lo), Math.max(...lo));
  const lp = curve.map((c) => c.live?.programs);
  console.log('curve programs live first/last/min/max:', lp[0], lp[lp.length - 1], Math.min(...lp), Math.max(...lp));
  console.log('fails  state:', JSON.stringify(out.fails_state), '| instSet:', JSON.stringify(out.after_fails.instanceCountSet));
  console.log('fails  bufMeta lens:', JSON.stringify(out.after_fails.bufMeta.map(b => b.len)), '| nonFinite worst:', Math.max(0, ...out.after_fails.bufMeta.map(b => b.nonFinite)));
  console.log('fails  glErr:', JSON.stringify(out.gl_error_after_fails));
  console.log('reuse  before/after instSet:', JSON.stringify(out.before_reuse.instanceCountSet), '->', JSON.stringify(out.after_reuse.instanceCountSet));
  console.log('reuse  after state:', JSON.stringify(out.after_reuse.dataState));
  console.log('vis set:', JSON.stringify([...new Set(curve.map(c => c.vis))]), '| raf first/last:', curve[0]?.raf, curve[curve.length - 1]?.raf);
  console.log('topOnly after:', brief(out.after_top_only));
  console.log('unmount live before/after:', JSON.stringify(out.before_unmount.live), '->', JSON.stringify(out.after_unmount.live));
  console.log('remount live:', JSON.stringify(out.after_remount.live));

  cdp.close(); try { child.kill(); } catch {}
  await sleep(500);
  process.exit(0);
}

main().catch((e) => {
  console.error('[FATAL]', mask(e.stack || e.message));
  try { fs.writeFileSync(path.join(EV, `${MODE}.fatal.txt`), mask(String(e.stack || e.message))); } catch {}
  process.exit(1);
});
