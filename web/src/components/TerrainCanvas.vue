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

function rebuildInstances() {
  const d = props.data
  if (!mesh || !d) return

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
}

function rebuildFails() {
  const d = props.data
  if (!failMesh) return
  if (!d || !props.showFails || !d.fails.length) { failMesh.count = 0; return }
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
}

function rebuildMarker() {
  if (!markerGroup || !camera) return
  markerGroup.clear()
  const mk = props.marker
  if (!mk) return

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  )
  body.position.set(mk.x, mk.y + 1.6, mk.z)
  markerGroup.add(body)

  // 一根竖杆，便于在密集地形里找到她
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 14, 6),
    new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.85 }),
  )
  pole.position.set(mk.x, mk.y + 8, mk.z)
  markerGroup.add(pole)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.4, 1.9, 24),
    new THREE.MeshBasicMaterial({ color: 0x58a6ff, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.set(mk.x, mk.y + 0.06, mk.z)
  markerGroup.add(ring)
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
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff })
  mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, props.data?.count || 1))
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  scene.add(mesh)

  // 失败点
  const fgeo = new THREE.SphereGeometry(1, 12, 8)
  const fmat = new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.65 })
  failMesh = new THREE.InstancedMesh(fgeo, fmat, Math.max(1, props.data?.fails.length || 1))
  failMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  failMesh.count = 0
  scene.add(failMesh)

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
  failMesh?.geometry.dispose()
  ;(failMesh?.material as THREE.Material | undefined)?.dispose()
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
  (d) => {
    if (!scene) return
    buildTopIndex()
    if (mesh && d) {
      // 面数可能变化，按需扩容
      if (mesh.count + 1 > mesh.instanceMatrix.count || (mesh as any)._cap !== d.count) {
        mesh.dispose()
        scene.remove(mesh)
        const geo = new THREE.BoxGeometry(1, 1, 1)
        const mat = new THREE.MeshLambertMaterial({ color: 0xffffff })
        mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, d.count))
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        ;(mesh as any)._cap = d.count
        scene.add(mesh)
      }
    }
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
