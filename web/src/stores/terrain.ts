import { reactive, computed, watch } from 'vue'
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
  /**
   * ★ WEB-007：这份地形**属于哪个 agent / 哪个维度**。
   *   面板上显示的坐标必须和"当前选中的 bot 与它所在的世界"一致，否则导航诊断会被读反。
   */
  owner: '' as string,
  dimension: '' as string,
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

/**
 * ★★★ WEB-007（2026-11-06 深度检查）：地形是**某一个 bot 在某一个维度**的世界的快照。
 *
 * 缺陷原貌：`decodeTerrain()` 无条件把结果写进全局 `terrain.decoded`，不带任何归属信息。于是：
 *   · 请求 A 的地形 → 中途切到 B → A 的响应**迟到**回来，直接覆盖 B 的视图
 *     （报告实测：请求 A、当前 B，屏幕上是 A 的坐标 101）；
 *   · 同一个 bot 换维度后旧数据仍然显示，没有任何失效判据；
 *   · `res` 不 ok / 没数据时只把 stats 写成原因，**旧 mesh 不清**（画面上留着上一张地图）。
 *
 * 修法：每次请求发出时记住"为谁、在哪个维度、第几次请求"，回来时三样都对得上才落盘；
 *   对不上一律丢弃（并说明原因）。数据为空时把 decoded 显式清成 null，
 *   让画布据此把实例数清 0（而不是继续画旧的）。
 */
let loadSeq = 0

function dimensionOf(): string {
  // 维度来自 1Hz 全量状态里的 gameplay.dimension（拿不到就当未知维度）
  const a = currentAgent.value
  const st = a ? store.states[a.name] : null
  return (st?.gameplay as any)?.dimension ?? 'unknown'
}

// ★ F-WEB-102（批次1，2026-11-06）：参数类型放宽为 `TerrainResult | null`。
//   依据：`refreshTerrain()` 的声明返回就是 `Promise<TerrainResult | null>`（agents.ts，无 agent 时 `return null`），
//   而本函数本来就在用 `!res?.ok` 处理 null —— 运行时语义早就容许 null，只是签名写窄了。
//   ★ WEB-007（批次2）：再增加可选的 `expected`，用于丢弃"属于别人/别的维度/过期"的响应。
export function decodeTerrain(
  res: TerrainResult | null,
  expected?: { owner: string; dimension: string; seq: number },
) {
  // ★ 归属校验：迟到的响应不许覆盖当前视图
  if (expected) {
    const curOwner = currentAgent.value?.name ?? ''
    const curDim = dimensionOf()
    if (expected.seq !== loadSeq) {
      terrain.stats = '已丢弃过期地形响应（期间又发起了新的加载）'
      return null
    }
    if (expected.owner !== curOwner) {
      terrain.stats = `已丢弃 ${expected.owner} 的地形响应（当前是 ${curOwner || '未选择'}）`
      return null
    }
    if (expected.dimension !== curDim) {
      terrain.stats = `已丢弃 ${expected.dimension} 的地形响应（当前维度是 ${curDim}）`
      return null
    }
  }
  if (!res?.ok || !res.origin || !res.pos || !res.types) {
    // ★ 数据无效时**连旧网格一起清掉**，否则画面上留着上一张地图，看起来像"加载成功了"
    terrain.decoded = null
    terrain.owner = ''
    terrain.dimension = ''
    terrain.stats = res?.reason || '无数据'
    return null
  }
  const [ox, oy, oz] = res.origin
  // W15：契约漂移时给出可见错误，而不是让 new Int32Array 抛 RangeError（旧图留在屏幕上）
  const dtype = (res as any).dtype === 'int32' ? 4 : 2
  const posBytes = b64ToBytes(res.pos)
  const typesBytes = b64ToBytes(res.types)
  if (posBytes.byteLength % (dtype * 3) !== 0) {
    terrain.decoded = null
    terrain.stats = `地形数据损坏：pos 长度 ${posBytes.byteLength} 不是 ${dtype * 3} 的整数倍`
    return null
  }
  if (typesBytes.length < Math.floor(posBytes.byteLength / dtype / 3)) {
    terrain.decoded = null
    terrain.stats = `地形数据损坏：types 只有 ${typesBytes.length} 个，少于面数`
    return null
  }
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
    t[i] = types[i] ?? 0   // W15：缺失类型码按"实心"兜底，且上面已校验数量
  }

  const bbox = res.bbox || {
    x0: Math.min(...x), x1: Math.max(...x),
    z0: Math.min(...z), z1: Math.max(...z),
    y0: Math.min(...y), y1: Math.max(...y),
  }

  terrain.decoded = { x, y, z, t, count, bbox, fails: res.fails || [] }
  // ★ WEB-007：记下这份数据的归属（画布/诊断可据此断言"显示的是谁的哪个世界"）
  terrain.owner = currentAgent.value?.name ?? ''
  terrain.dimension = dimensionOf()
  terrain.yMin = bbox.y0
  terrain.yMax = bbox.y1

  const multi = new Set<string>()
  for (let i = 0; i < count; i++) multi.add(x[i] + ',' + Math.floor(z[i]))
  terrain.stats = `${count.toLocaleString()} 面 · ${multi.size.toLocaleString()} 列 · y ${bbox.y0}~${bbox.y1} · lod ${res.lod ?? 1} · ${res.ms ?? '?'}ms`
  return terrain.decoded
}

export async function loadTerrain() {
  const a = currentAgent.value
  if (!a) return null
  // ★ WEB-007：请求发出时就锁定"这次是为谁、哪个维度、第几次"
  const expected = { owner: a.name, dimension: dimensionOf(), seq: ++loadSeq }
  const res = await refreshTerrain({
    mode: terrain.mode,
    radius: terrain.radius,
    lod: terrain.lod,
  })
  // W15：解码异常必须变成可见错误（原来会以未处理拒绝逃出去，画面停在旧图）
  try {
    return decodeTerrain(res, expected)
  } catch (e: any) {
    terrain.decoded = null
    terrain.stats = '地形解码失败：' + (e?.message || String(e))
    return null
  }
}

/** 切 agent / 换维度时，旧地形立即失效（别让上一个 bot 或上一个世界的图留在屏幕上）。 */
watch(
  () => [currentAgent.value?.name ?? '', dimensionOf()].join('|'),
  () => {
    if (!terrain.decoded) return
    terrain.decoded = null
    terrain.owner = ''
    terrain.dimension = ''
    terrain.stats = '已切换 bot / 维度：旧地形已清空，请重新加载'
    loadSeq++   // 让还在路上的旧请求全部作废
  },
)

export const canLoad = computed(() => !!currentAgent.value?.in_game)
