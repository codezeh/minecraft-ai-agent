<script setup lang="ts">
import { computed } from 'vue'
import { currentAgent, currentState } from '../stores/agents'

const agentName = computed(() => currentAgent.value?.name || '')
const eq = computed(() => currentState.value?.inventory.equipment)

// 装备槽显示顺序与图标来源（贴图走 mindserver 的 /assets/item/:agent/:name.png）
const equipment = computed(() => [
  { key: 'helmet', label: '头', item: eq.value?.helmet },
  { key: 'chestplate', label: '胸', item: eq.value?.chestplate },
  { key: 'leggings', label: '腿', item: eq.value?.leggings },
  { key: 'boots', label: '脚', item: eq.value?.boots },
  { key: 'mainHand', label: '手', item: eq.value?.mainHand },
])

const items = computed(() => {
  const counts = currentState.value?.inventory.counts || {}
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
})

function iconUrl(name: string) {
  return `/assets/item/${encodeURIComponent(agentName.value)}/${encodeURIComponent(name)}.png`
}

function pretty(name: string) {
  return name.replace(/_/g, ' ')
}

// 贴图取不到时回落成首字母，不出现破图
function onImgError(e: Event) {
  const el = e.target as HTMLImageElement
  el.style.display = 'none'
  const fb = el.nextElementSibling as HTMLElement | null
  if (fb) fb.style.display = 'grid'
}
</script>

<template>
  <div class="inv">
    <div class="eq">
      <div v-for="slot in equipment" :key="slot.key" class="slot" :title="slot.item || '空'">
        <img v-if="slot.item" :src="iconUrl(slot.item)" alt="" @error="onImgError" />
        <span v-if="slot.item" class="fb">{{ slot.item[0].toUpperCase() }}</span>
        <span v-else class="empty">·</span>
        <i class="tag">{{ slot.label }}</i>
      </div>
    </div>

    <div class="meta faint">
      占用 {{ currentState?.inventory.stacksUsed ?? '-' }} / {{ currentState?.inventory.totalSlots ?? '-' }} 格
      · {{ items.length }} 种
    </div>

    <div class="grid scroll">
      <div v-for="[name, n] in items" :key="name" class="item" :title="pretty(name)">
        <img :src="iconUrl(name)" alt="" loading="lazy" @error="onImgError" />
        <span class="fb">{{ name[0].toUpperCase() }}</span>
        <b class="count">{{ n }}</b>
      </div>
      <div v-if="!items.length" class="faint nothing">背包空 / 无数据</div>
    </div>
  </div>
</template>

<style scoped>
.inv { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; min-height: 0; }

.eq { display: flex; gap: 5px; }
.slot {
  position: relative; width: 34px; height: 34px; flex: none;
  display: grid; place-items: center;
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
}
.slot img { width: 24px; height: 24px; image-rendering: pixelated; }
.slot .fb, .item .fb {
  display: none; place-items: center;
  font-size: 12px; color: var(--fg-dim);
}
.slot .empty { color: var(--fg-faint); }
.slot .tag {
  position: absolute; bottom: -1px; right: 1px;
  font-size: 8px; font-style: normal; color: var(--fg-faint);
}

.meta { font-size: 11px; }

.grid {
  display: flex; flex-wrap: wrap; gap: 4px;
  align-content: flex-start;
  min-height: 0; flex: 1;
}
.item {
  position: relative; width: 32px; height: 32px;
  display: grid; place-items: center;
  background: var(--bg); border: 1px solid var(--border-soft); border-radius: 5px;
}
.item img { width: 22px; height: 22px; image-rendering: pixelated; }
.item .count {
  position: absolute; right: 1px; bottom: 0;
  font-size: 10px; font-weight: 600; color: #fff;
  text-shadow: 0 0 3px #000, 0 0 2px #000;
}
.nothing { font-size: 11px; padding: 6px 0; }
</style>
