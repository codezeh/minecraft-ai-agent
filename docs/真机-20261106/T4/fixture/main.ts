// T4 夹具 —— **不是产品代码**：只 import 产品源码，web/src 一个字节都不改。
//
// 为什么需要夹具（与 T3 同因）：
//   面板里 0 agent（T1/T2 的 bot 是裸 mineflayer、不经 mindserver）⇒ `currentAgent` 为 null
//   ⇒ TerrainView 的"加载地形"永远拿不到数据（数据在 agent 进程里，面板只经 socket 请求）。
//   而 `loadTerrain()` 走 socket 根本不可能返回真数据。所以这里**直接调产品自己的
//   `decodeTerrain()`** 灌入**与后端同格式**的 payload（origin/pos(base64 交错 int16)/types/bbox/fails），
//   被验的渲染代码路径（rebuildInstances / rebuildFails / rebuildMarker / ensureCapacity /
//   refreshBounds / disposeGroup / onBeforeUnmount）完全是产品原文。
//
// 保真度声明（也写进 README）：
//   ① 数据是**合成后按产品解码器解开**的，不是真实飞行采集的地形；
//   ② 宿主页面是本夹具（真实 TerrainView + 真实 TerrainCanvas 组件树）；
//   ③ 面板无 agent ⇒ 不经过 socket 请求/响应，只走解码 + 渲染。
import { createApp, defineComponent, h, ref, computed } from 'vue'
import TerrainView from '../../../../web/src/views/TerrainView.vue'
import TerrainCanvas from '../../../../web/src/components/TerrainCanvas.vue'
import { terrain, decodeTerrain } from '../../../../web/src/stores/terrain'
import { store, initStore } from '../../../../web/src/stores/agents'
import { socket } from '../../../../web/src/api/socket'
import * as THREE_PROBE from 'three'

const STUB = { name: 't4-stub', in_game: true, socket_connected: true, viewer_port: 0 }
// ★ 先把维度固定住：产品 terrain.ts 里有 WEB-007 的失效 watch（agent/维度一变就清空地形）。
//   若首个 tickMarker 才第一次写入 dimension，键会从 'unknown' 变成 'minecraft:overworld'，
//   于是地形被正当清空 —— 实测踩过（setFails 报 no data）。所以初始化时就写死维度。
const DIM = 'minecraft:overworld'
const setState = (p: { x: number; y: number; z: number }) => {
  store.states['t4-stub'] = {
    gameplay: { health: 20, position: p, dimension: DIM },
    inventory: { counts: {} },
  } as any
}
setState({ x: 0, y: 64, z: 0 })
const ensureStub = () => {
  if (!store.agents.some((a: any) => a.name === 't4-stub')) (store.agents as any[]).push(STUB as any)
}
ensureStub()
initStore()
socket.on('agents-status', () => { setTimeout(ensureStub, 0) })
const keepStub = setInterval(ensureStub, 200)
setTimeout(() => clearInterval(keepStub), 60000)

// ── 合成 payload（与后端同格式：origin + 交错 int16 坐标 + uint8 类型）─────────────
function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

/**
 * 造网格状地形：cols×cols 列，每列 heights 个面，原点在 origin。
 * pattern: 'normal' | 'fail-heavy'（影响类型分布，仅用于视觉区分）
 */
function makePayload(opts: {
  cols?: number
  heights?: number
  origin?: [number, number, number]
  fails?: number
  seed?: number
}) {
  const cols = opts.cols ?? 40
  const heights = opts.heights ?? 4
  const [ox, oy, oz] = opts.origin ?? [-100, 60, -100]
  const failsN = opts.fails ?? 0
  let seed = opts.seed ?? 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

  const n = cols * cols * heights
  const coords = new Int16Array(n * 3)
  const types = new Uint8Array(n)
  let k = 0
  let y0 = Infinity, y1 = -Infinity
  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < cols; cz++) {
      const h = 1 + Math.floor(rnd() * heights)
      for (let i = 0; i < h; i++) {
        coords[k * 3] = cx
        coords[k * 3 + 1] = i
        coords[k * 3 + 2] = cz
        types[k] = (cx + cz + i) % 7
        if (i < y0) y0 = i
        if (i > y1) y1 = i
        k++
      }
    }
  }
  const count = k
  const pos = b64(new Uint8Array(coords.buffer, 0, count * 3 * 2))
  const tps = b64(types.subarray(0, count))
  const fails: { x: number; y: number; z: number; hits: number }[] = []
  for (let i = 0; i < failsN; i++) {
    fails.push({
      x: Math.floor(rnd() * cols),
      y: y1 + 1,
      z: Math.floor(rnd() * cols),
      hits: 1 + Math.floor(rnd() * 9),
    })
  }
  return {
    ok: true,
    origin: [ox, oy, oz] as [number, number, number],
    dtype: 'int16' as const,
    count,
    pos,
    types: tps,
    bbox: { x0: ox, x1: ox + cols, z0: oz, z1: oz + cols, y0: oy, y1: oy + (y1 - y0) },
    fails,
    lod: 1,
    mode: 'around' as const,
    ms: 7,
  }
}

// ── 对外控制面（CDP 侧调用；只操作真实 store / 真实组件）──────────────────────────
const showView = ref(true)
const markerOn = ref(true)

const control = {
  /** 灌入地形（走产品 decodeTerrain，真实解码路径） */
  load(opts: any = {}) {
    const res = makePayload(opts)
    const decoded = decodeTerrain(res as any)
    return {
      ok: !!decoded,
      count: decoded?.count ?? 0,
      fails: decoded?.fails.length ?? 0,
      stats: terrain.stats,
      bbox: decoded?.bbox ?? null,
    }
  },
  /** 大量失败点（WEB-004：后端上限 3000） */
  setFails(n: number) {
    const d = terrain.decoded
    if (!d) return { ok: false, reason: 'no data' }
    const b = d.bbox
    const fails = []
    for (let i = 0; i < n; i++) {
      fails.push({
        x: b.x0 + (i % 64),
        y: b.y0 + 1 + (i % 3),
        z: b.z0 + Math.floor(i / 64),
        hits: 1 + (i % 9),
      })
    }
    ;(d as any).fails = fails
    return { ok: true, fails: fails.length }
  },
  /** 模拟 1Hz 位置推送（WEB-005：标记不该反复建对象） */
  tickMarker(i: number) {
    const d = terrain.decoded
    const b = d?.bbox
    const p = b
      ? { x: b.x0 + (i % 20), y: b.y0 + 1, z: b.z0 + (i % 17) }
      : { x: i, y: 64, z: 0 }
    setState(p)
    return p
  },
  setMarkerVisible(v: boolean) { markerOn.value = v },
  /** 卸载整棵 TerrainView（测 onBeforeUnmount 的释放） */
  unmount() { showView.value = false; return true },
  remount() { showView.value = true; return true },
  state() {
    return {
      hasData: !!terrain.decoded,
      count: terrain.decoded?.count ?? 0,
      fails: terrain.decoded?.fails.length ?? 0,
      stats: terrain.stats,
      bbox: terrain.decoded?.bbox ?? null,
      yMin: terrain.yMin,
      yMax: terrain.yMax,
      showFails: terrain.showFails,
      mode: terrain.mode,
    }
  },
  setShowFails(v: boolean) { terrain.showFails = v },
  setTopOnly(v: boolean) { terrain.topOnly = v },
  setSlice(min: number, max: number) { terrain.yMin = min; terrain.yMax = max },
  setShowTypes(arr: boolean[]) { terrain.showTypes = arr },
}
;(window as any).__t4ctl = control
// 诊断：alias('three' → three-instrument.ts) 到底有没有生效（原型上应能看到 __t4 字样）
;(window as any).__t4diag = {
  revision: (THREE_PROBE as any).REVISION,
  renderPatched: /__t4/.test(String((THREE_PROBE as any).WebGLRenderer.prototype.render)),
  rendererName: (THREE_PROBE as any).WebGLRenderer.name,
}
;(window as any).__t4store = { store, terrain }

const Root = defineComponent({
  name: 'T4Fixture',
  render: () =>
    h('div', { style: 'height:100vh;display:flex;flex-direction:column;font:14px system-ui' }, [
      h('div', { style: 'flex:none;padding:5px 10px;background:#1f1f1f;color:#ddd;font-size:12px' },
        'T4 fixture · 真实 TerrainView + TerrainCanvas（web/src 未改动）· 数据为合成注入'),
      h('div', { style: 'flex:1;min-height:0' }, showView.value ? [h(TerrainView)] : []),
    ]),
})

createApp(Root).mount('#app')
