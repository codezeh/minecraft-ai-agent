<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TYPE_META } from '../api/types'

const props = defineProps<{
  data: {
    x: Float32Array
    y: Float32Array
    z: Float32Array
    t: Uint8Array
    count: number
    bbox: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }
    fails: { x: number; y: number; z: number; hits: number }[]
  } | null
  showTypes: boolean[]
  yMin: number
  yMax: number
  topOnly: boolean
  showFails: boolean
  marker: { x: number; y: number; z: number } | null
}>()

const host = ref<HTMLDivElement | null>(null)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let mesh: THREE.InstancedMesh | null = null
let failMesh: THREE.InstancedMesh | null = null
let markerGroup: THREE.Group | null = null
let resizeObs: ResizeObserver | null = null
let raf = 0
let fittedFor = ''

const COLORS = new Map<number, THREE.Color>()
for (const k of Object.keys(TYPE_META)) COLORS.set(Number(k), new THREE.Color(TYPE_META[Number(k)].color))

function isVisible(i: number): boolean {
  const t = props.data!.t[i]
  if (!props.showTypes[t]) return false
  const y = props.data!.y[i]
  if (y < props.yMin || y > props.yMax) return false
  return true
}

/** 每列最上层（"只看最上层"模式）；一次遍历建表，避免每次点击 O(n²) */
let topIndex: Map<string, number> | null = null
function buildTopIndex() {
  topIndex = new Map()
  const d = props.data
  if (!d) return
  for (let i = 0; i < d.count; i++) {
    const k = d.x[i] + ',' + d.z[i]
    const cur = topIndex.get(k)
    if (cur === undefined || d.y[i] > d.y[cur]) topIndex.set(k, i)
  }
}

/**
 * ★ WEB-004（2026-11-06 深度检查）：**实例容量必须按需要扩**，不能"建好就不管"。
 *
 * 缺陷原貌：`failMesh` 在 onMounted 里按 `props.data?.fails.length || 1` 建。
 *   而地形页初始 `data=null` ⇒ 容量 = **1**；之后加载到 ≥2 个失败点时
 *   `rebuildFails()` 直接往 `setMatrixAt(1, …)` 写 —— **越过容量**，
 *   第二个矩阵全是 undefined（报告实测 count=2/capacity=1）。渲染出来的点位就是错的/缺失的。
 *
 * 修法：写入前先确保容量够；不够就**重建**（并释放旧的 geometry/material —— 见 WEB-005）。
 *   容量只增不减，避免"隐藏图层→再显示"时反复重建。
 */
function ensureCapacity(
  current: THREE.InstancedMesh | null,
  needed: number,
  makeGeo: () => THREE.BufferGeometry,
  makeMat: () => THREE.Material,
): THREE.InstancedMesh {
  const cap = (current as any)?._cap ?? current?.instanceMatrix?.count ?? 0
  if (current && cap >= needed) return current
  if (current) {
    // ★ WEB-005：重建前把旧资源真的释放掉（不只是从场景移除）
    scene?.remove(current)
    current.geometry.dispose()
    ;(current.material as THREE.Material | undefined)?.dispose()
    current.dispose()
  }
  const next = new THREE.InstancedMesh(makeGeo(), makeMat(), Math.max(1, needed))
  next.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  ;(next as any)._cap = Math.max(1, needed)
  next.count = 0
  scene?.add(next)
  return next
}

/**
 * ★ WEB-010（2026-11-06 深度检查）：实例矩阵/count 变了以后**必须重算包围球**。
 *
 * 缺陷原貌：只更新 `instanceMatrix` 与 `count`，`boundingSphere` 还是上一次的。
 *   Three 的视锥剔除用的是这个球 ⇒ 复用同容量 mesh 刷到别的坐标时，
 *   球还停在地图外 ⇒ **整张地图被判"在视野外"而不渲染**（报告实测：重算前 visible=false，重算后 true）。
 */
function refreshBounds(im: THREE.InstancedMesh) {
  im.computeBoundingSphere()
  im.computeBoundingBox?.()
}

function rebuildInstances() {
  const d = props.data
  if (!mesh) return
  if (!d) { mesh.count = 0; refreshBounds(mesh); return }   // ★ 无数据就把旧的清掉（别留上一张图）
  mesh = ensureCapacity(
    mesh, d.count,
    () => new THREE.BoxGeometry(1, 1, 1),
    () => new THREE.MeshLambertMaterial({ color: 0xffffff }),
  )

  const m = new THREE.Matrix4()
  const color = new THREE.Color()
  let n = 0

  for (let i = 0; i < d.count; i++) {
    if (!isVisible(i)) continue
    if (props.topOnly && topIndex) {
      const k = d.x[i] + ',' + d.z[i]
      if (topIndex.get(k) !== i) continue
    }
    // 方块本体占 [x, x+1]，几何中心在 +0.5
    m.makeTranslation(d.x[i] + 0.5, d.y[i] + 0.5, d.z[i] + 0.5)
    mesh.setMatrixAt(n, m)

    // 按高度做一点明暗，否则整片同色看不出起伏
    const base = COLORS.get(d.t[i]) || color.set('#888888')
    const span = Math.max(1, d.bbox.y1 - d.bbox.y0)
    const k2 = 0.72 + 0.38 * ((d.y[i] - d.bbox.y0) / span)
    color.copy(base).multiplyScalar(k2)
    mesh.setColorAt(n, color)
    n++
  }

  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  refreshBounds(mesh)      // ★ WEB-010
}

function rebuildFails() {
  const d = props.data
  if (!failMesh) return
  if (!d || !props.showFails || !d.fails.length) {
    failMesh.count = 0
    refreshBounds(failMesh)   // ★ WEB-010：清空也要让包围球跟上
    return
  }
  // ★ WEB-004：先按实际失败点数量确保容量
  failMesh = ensureCapacity(
    failMesh, d.fails.length,
    () => new THREE.SphereGeometry(1, 12, 8),
    () => new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.65 }),
  )
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const p = new THREE.Vector3()
  let n = 0
  for (const f of d.fails) {
    const scale = 0.4 + Math.min(2.4, Math.sqrt(f.hits || 1) * 0.5)
    s.set(scale, scale, scale)
    p.set(f.x + 0.5, f.y + 0.5, f.z + 0.5)
    m.compose(p, q, s)
    failMesh.setMatrixAt(n++, m)
  }
  failMesh.count = n
  failMesh.instanceMatrix.needsUpdate = true
  refreshBounds(failMesh)   // ★ WEB-010
}

/**
 * ★ WEB-005（2026-11-06 深度检查）：位置标记**只建一次**，之后只改 position。
 *
 * 缺陷原貌：`rebuildMarker()` 每次（位置 1Hz 推送）都 `markerGroup.clear()` +
 *   新建 3 个 Mesh（球/杆/环），旧的 geometry/material **从未 dispose**
 *   —— 报告实测：两轮后 3 个旧对象脱离场景，本应 6 次 dispose 实际 0 次。
 *   长时间开着地形页就是持续泄漏渲染资源（显存增长 + 掉帧）。
 *
 * 修法：第一次调用时建好三个对象并挂上；之后仅更新坐标。卸载时统一释放。
 */
let markerBuilt = false

function rebuildMarker() {
  if (!markerGroup || !camera) return
  if (!markerBuilt) {
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    )
    body.name = 'marker-body'
    markerGroup.add(body)

    // 一根竖杆，便于在密集地形里找到她
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 14, 6),
      new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.85 }),
    )
    pole.name = 'marker-pole'
    markerGroup.add(pole)

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 1.9, 24),
      new THREE.MeshBasicMaterial({ color: 0x58a6ff, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }),
    )
    ring.name = 'marker-ring'
    ring.rotation.x = -Math.PI / 2
    markerGroup.add(ring)
    markerBuilt = true
  }
  const mk = props.marker
  const body = markerGroup.getObjectByName('marker-body')
  const pole = markerGroup.getObjectByName('marker-pole')
  const ring = markerGroup.getObjectByName('marker-ring')
  if (!body || !pole || !ring) return
  // 没有位置就藏起来（而不是留在地图原点）
  markerGroup.visible = !!mk
  if (!mk) return
  body.position.set(mk.x, mk.y + 1.6, mk.z)
  pole.position.set(mk.x, mk.y + 8, mk.z)
  ring.position.set(mk.x, mk.y + 0.06, mk.z)
}

/** 释放一群对象的 geometry/material（卸载/重建时用）。 */
function disposeGroup(g: THREE.Group | null) {
  if (!g) return
  g.traverse((o: any) => {
    o?.geometry?.dispose?.()
    const mat = o?.material
    if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.())
    else mat?.dispose?.()
  })
  g.clear()
}

function fitCamera(force = false) {
  const d = props.data
  if (!camera || !controls || !d) return
  const key = `${d.bbox.x0},${d.bbox.x1},${d.bbox.z0},${d.bbox.z1}`
  if (!force && key === fittedFor) return
  fittedFor = key

  const b = d.bbox
  const cx = (b.x0 + b.x1) / 2
  const cz = (b.z0 + b.z1) / 2
  const cy = (b.y0 + b.y1) / 2
  const span = Math.max(b.x1 - b.x0, b.z1 - b.z0, 24)
  const dist = span * 1.15

  camera.position.set(cx + dist * 0.55, cy + dist * 0.75, cz + dist * 0.55)
  camera.near = 1
  camera.far = dist * 20
  camera.updateProjectionMatrix()
  controls.target.set(cx, cy, cz)
  controls.update()
}

function resetView() {
  fittedFor = ''
  fitCamera(true)
}

function loop() {
  raf = requestAnimationFrame(loop)
  controls?.update()
  if (renderer && scene && camera) renderer.render(scene, camera)
}

function sizeToHost() {
  const el = host.value
  if (!el || !renderer || !camera) return
  const w = el.clientWidth || 1
  const h = el.clientHeight || 1
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

onMounted(() => {
  const el = host.value
  if (!el) return

  scene = new THREE.Scene()
  scene.background = new THREE.Color('#0d1117')
  scene.fog = new THREE.Fog('#0d1117', 400, 1400)

  camera = new THREE.PerspectiveCamera(55, 1, 1, 4000)

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  el.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.maxPolarAngle = Math.PI * 0.495
  controls.screenSpacePanning = false

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.15))
  const dir = new THREE.DirectionalLight(0xffffff, 0.75)
  dir.position.set(1, 2, 0.6)
  scene.add(dir)

  // 面实例：所有可站立面共用一份几何
  // ★ WEB-004：容量按**实际需要**建（含失败点），并统一走 ensureCapacity 扩容。
  mesh = ensureCapacity(
    null, props.data?.count || 1,
    () => new THREE.BoxGeometry(1, 1, 1),
    () => new THREE.MeshLambertMaterial({ color: 0xffffff }),
  )
  mesh.count = 0

  // 失败点
  failMesh = ensureCapacity(
    null, props.data?.fails?.length || 1,
    () => new THREE.SphereGeometry(1, 12, 8),
    () => new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.65 }),
  )
  failMesh.count = 0
  failMesh.visible = true

  markerGroup = new THREE.Group()
  scene.add(markerGroup)

  sizeToHost()
  resizeObs = new ResizeObserver(sizeToHost)
  resizeObs.observe(el)

  if (props.data) {
    buildTopIndex()
    rebuildInstances()
    rebuildFails()
    fitCamera()
  }
  rebuildMarker()
  loop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  resizeObs?.disconnect()
  controls?.dispose()
  mesh?.geometry.dispose()
  ;(mesh?.material as THREE.Material | undefined)?.dispose()
  mesh?.dispose()
  failMesh?.geometry.dispose()
  ;(failMesh?.material as THREE.Material | undefined)?.dispose()
  failMesh?.dispose()
  // ★ WEB-005：标记那三个对象的 geometry/material 也要释放（原来只置空引用）
  disposeGroup(markerGroup)
  markerBuilt = false
  if (renderer) {
    renderer.dispose()
    renderer.domElement.remove()
  }
  scene = null
  camera = null
  controls = null
  mesh = null
  failMesh = null
  markerGroup = null
  renderer = null
})

watch(
  () => props.data,
  () => {
    if (!scene) return
    buildTopIndex()
    // ★ WEB-004：扩容与重建统一由 rebuildInstances/rebuildFails 里的 ensureCapacity 负责
    //   （原来这里手写一份"按容量重建"的克隆逻辑，两处判据已经不一致）
    rebuildInstances()
    rebuildFails()
    fitCamera()
    rebuildMarker()
  },
)

watch(
  () => [props.showTypes.join(','), props.yMin, props.yMax, props.topOnly],
  () => rebuildInstances(),
)
watch(() => props.showFails, rebuildFails)
watch(() => props.marker, rebuildMarker, { deep: true })

defineExpose({ resetView })
</script>

<template>
  <div ref="host" class="terrain-host">
    <div v-if="!data" class="placeholder faint">
      <div>还没有地形数据</div>
      <div class="sub">点右上角「加载」——按需从 terrain3d.db 拉取，不进 1 Hz 状态流</div>
    </div>
  </div>
</template>

<style scoped>
.terrain-host { position: relative; width: 100%; height: 100%; overflow: hidden; }
.terrain-host :deep(canvas) { display: block; }
.placeholder {
  position: absolute; inset: 0;
  display: grid; place-content: center; gap: 6px; text-align: center;
  font-size: 13px; pointer-events: none;
}
.placeholder .sub { font-size: 11px; }
</style>
