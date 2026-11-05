<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import TerrainCanvas from '../components/TerrainCanvas.vue'
import { terrain, loadTerrain, canLoad } from '../stores/terrain'
import { currentState, currentAgent, store } from '../stores/agents'
import { TYPE_META } from '../api/types'

const canvasRef = ref<InstanceType<typeof TerrainCanvas> | null>(null)
const error = ref('')

const data = computed(() => terrain.decoded)

const marker = computed(() => {
  const p = currentState.value?.gameplay.position
  return p ? { x: p.x, y: p.y, z: p.z } : null
})

const yRange = computed(() => {
  const b = terrain.decoded?.bbox
  return b ? { min: b.y0, max: b.y1 } : { min: -64, max: 320 }
})

async function load() {
  error.value = ''
  const res = await loadTerrain()
  if (!res) error.value = store.lastError || '没有拿到地形数据'
}

function toggleType(i: number) {
  const arr = terrain.showTypes.slice()
  arr[i] = !arr[i]
  terrain.showTypes = arr
}

onMounted(() => {
  // 进页面不自动拉：confirm 数据量后再点，避免一进就卡
})

const types = Object.entries(TYPE_META).map(([k, v]) => ({ code: Number(k), ...v }))
</script>

<template>
  <div class="wrap">
    <TerrainCanvas
      ref="canvasRef"
      :data="data"
      :show-types="terrain.showTypes"
      :y-min="terrain.yMin"
      :y-max="terrain.yMax"
      :top-only="terrain.topOnly"
      :show-fails="terrain.showFails"
      :marker="marker"
    />

    <aside class="panel side">
      <div class="panel-title">数据</div>
      <div class="body">
        <div class="row">
          <select v-model="terrain.mode">
            <option value="around">以她为中心</option>
            <option value="full">全图</option>
          </select>
          <select v-model.number="terrain.lod">
            <option :value="1">lod 1 全量</option>
            <option :value="2">lod 2</option>
            <option :value="4">lod 4 粗</option>
          </select>
        </div>
        <div v-if="terrain.mode === 'around'" class="row">
          <span class="faint k">半径</span>
          <input v-model.number="terrain.radius" type="range" min="16" max="128" step="8" />
          <span class="num k2">{{ terrain.radius }}</span>
        </div>
        <button class="primary" :disabled="!canLoad || store.terrainLoading" @click="load">
          {{ store.terrainLoading ? '读取中…' : '加载地形' }}
        </button>
        <div v-if="!canLoad" class="faint tip">agent 不在线，地形读不到（数据在 agent 进程里）</div>
        <div v-if="error" class="tip bad">{{ error }}</div>
        <div v-if="terrain.stats" class="stats num">{{ terrain.stats }}</div>

        <div class="panel-title inner">图层</div>
        <label v-for="t in types" :key="t.code" class="chk">
          <input type="checkbox" :checked="terrain.showTypes[t.code]" @change="toggleType(t.code)" />
          <i class="sw" :style="{ background: t.color }" />
          <span>{{ t.name }}</span>
          <span class="faint code">{{ t.code }}</span>
        </label>

        <label class="chk">
          <input v-model="terrain.showFails" type="checkbox" />
          <i class="sw" style="background:#ff4444" />
          <span>失败点</span>
          <span class="faint code">{{ data?.fails.length ?? 0 }}</span>
        </label>

        <div class="panel-title inner">高度切片</div>
        <div class="slice">
          <span class="faint k">下限</span>
          <input v-model.number="terrain.yMin" type="range" :min="yRange.min" :max="yRange.max" />
          <span class="num k2">{{ terrain.yMin }}</span>
        </div>
        <div class="slice">
          <span class="faint k">上限</span>
          <input v-model.number="terrain.yMax" type="range" :min="yRange.min" :max="yRange.max" />
          <span class="num k2">{{ terrain.yMax }}</span>
        </div>

        <label class="chk">
          <input v-model="terrain.topOnly" type="checkbox" />
          <span>只看最上层</span>
        </label>

        <div class="row btns">
          <button @click="canvasRef?.resetView()">重置视角</button>
          <button
            @click="
              terrain.yMin = yRange.min;
              terrain.yMax = yRange.max
            "
          >重置切片</button>
        </div>
      </div>
    </aside>

    <div class="hintbar faint">
      拖拽旋转 · 滚轮缩放 · 右键平移 ·
      <template v-if="currentAgent"> agent {{ currentAgent.name }} </template>
      <template v-if="currentState?.facing"> · 朝向 {{ currentState.facing.text }}</template>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: relative; height: 100%; min-height: 0; }

.side {
  position: absolute; right: 12px; top: 12px; width: 258px;
  max-height: calc(100% - 24px);
  display: flex; flex-direction: column;
  background: rgba(22, 27, 34, .95);
  backdrop-filter: blur(6px);
}
.body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.panel-title.inner { padding: 8px 0 2px; border: none; margin-top: 4px; }

.row select { flex: 1; }
.k { font-size: 11px; width: 26px; flex: none; }
.k2 { font-size: 11px; width: 30px; text-align: right; flex: none; }
input[type='range'] { flex: 1; min-width: 0; }

.chk { display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer; }
.chk .sw { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.chk .code { margin-left: auto; font-size: 10px; }

.slice { display: flex; align-items: center; gap: 7px; }

.btns { margin-top: 4px; }
.btns button { flex: 1; }

.tip { font-size: 11px; color: var(--fg-dim); }
.tip.bad { color: #ffb4ae; }
.stats { font-size: 11px; color: var(--fg-dim); line-height: 1.6; }

.hintbar {
  position: absolute; left: 12px; bottom: 10px;
  font-size: 11px; padding: 4px 10px;
  background: rgba(13, 17, 23, .8); border-radius: 20px;
}

@media (max-width: 780px) {
  .side { position: static; width: auto; max-height: none; margin: 10px; }
  .wrap { display: flex; flex-direction: column; overflow: auto; }
}
</style>
