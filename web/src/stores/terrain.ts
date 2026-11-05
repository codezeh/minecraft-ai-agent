import { reactive, computed } from 'vue'
import { store, currentAgent, refreshTerrain } from './agents'
import type { TerrainResult } from '../api/types'

export const terrain = reactive({
  // 视图选项
  mode: 'around' as 'around' | 'full',
  radius: 48,
  lod: 2,
  showTypes: [true, true, true, true, true, true, true] as boolean[],
  yMin: -64,
  yMax: 320,
  topOnly: false,
  showFails: true,
  // 解码后的缓存
  decoded: null as null | {
    x: Float32Array
    y: Float32Array
    z: Float32Array
    t: Uint8Array
    count: number
    bbox: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }
    fails: { x: number; y: number; z: number; hits: number }[]
  },
  stats: '',
})

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 后端给的是相对 origin 的整型三元组（int16 或 int32）+ Uint8 类型码，这里解回世界坐标 */
export function decodeTerrain(res: TerrainResult) {
  if (!res?.ok || !res.origin || !res.pos || !res.types) {
    terrain.decoded = null
    terrain.stats = res?.reason || '无数据'
    return null
  }
  const [ox, oy, oz] = res.origin
  const posBytes = b64ToBytes(res.pos)
  // 后端按坐标跨度选宽度：跨度 < 32760 用 int16，否则 int32
  const i16 =
    (res as any).dtype === 'int32'
      ? new Int32Array(posBytes.buffer, posBytes.byteOffset, posBytes.byteLength / 4)
      : new Int16Array(posBytes.buffer, posBytes.byteOffset, posBytes.byteLength / 2)
  const types = b64ToBytes(res.types)
  const count = Math.min(res.count || 0, Math.floor(i16.length / 3))

  const x = new Float32Array(count)
  const y = new Float32Array(count)
  const z = new Float32Array(count)
  const t = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    x[i] = i16[i * 3] + ox
    y[i] = i16[i * 3 + 1] + oy
    z[i] = i16[i * 3 + 2] + oz
    t[i] = types[i]
  }

  const bbox = res.bbox || {
    x0: Math.min(...x), x1: Math.max(...x),
    z0: Math.min(...z), z1: Math.max(...z),
    y0: Math.min(...y), y1: Math.max(...y),
  }

  terrain.decoded = { x, y, z, t, count, bbox, fails: res.fails || [] }
  terrain.yMin = bbox.y0
  terrain.yMax = bbox.y1

  const multi = new Set<string>()
  for (let i = 0; i < count; i++) multi.add(x[i] + ',' + Math.floor(z[i]))
  terrain.stats = `${count.toLocaleString()} 面 · ${multi.size.toLocaleString()} 列 · y ${bbox.y0}~${bbox.y1} · lod ${res.lod ?? 1} · ${res.ms ?? '?'}ms`
  return terrain.decoded
}

export async function loadTerrain() {
  const res = await refreshTerrain({
    mode: terrain.mode,
    radius: terrain.radius,
    lod: terrain.lod,
  })
  return decodeTerrain(res)
}

export const canLoad = computed(() => !!currentAgent.value?.in_game)
