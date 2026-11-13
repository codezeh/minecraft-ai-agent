<script setup lang="ts">
/**
 * 存档只读视图（t3）：队伍 / 库存 / 事件 / 联邦四个标签页。
 *
 * 为什么合成一页而不是四个导航项：这四块看的是**同一个存档维度**的数据，
 * 排查时要在"队伍 → 它的共享仓 → 谁预占了 → 事件里怎么记的"之间来回跳；
 * 拆成四个顶级菜单会让导航栏变成一长串，而现有控制台的导航已经很满。
 * 全部只读 —— 写操作仍然在各页（任务板/设置/凭据）。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TeamPanel from '../components/world/TeamPanel.vue'
import StockPanel from '../components/world/StockPanel.vue'
import EventsPanel from '../components/world/EventsPanel.vue'
import FederationPanel from '../components/world/FederationPanel.vue'
import { currentAgent, store } from '../stores/agents'
import { teamView, stockView } from '../stores/world'

const TABS = [
  { key: 'team', label: '队伍' },
  { key: 'stock', label: '库存' },
  { key: 'events', label: '事件' },
  { key: 'federation', label: '联邦' },
] as const

type TabKey = typeof TABS[number]['key']

const route = useRoute()
const router = useRouter()

function tabOf(v: unknown): TabKey {
  const s = String(v ?? '')
  return (TABS.some((t) => t.key === s) ? s : 'team') as TabKey
}

const tab = ref<TabKey>(tabOf(route.query.tab))
watch(() => route.query.tab, (v) => { tab.value = tabOf(v) })

function select(k: TabKey) {
  tab.value = k
  // 用 query 记住标签页：刷新/分享链接不会跳回第一页（不新增路由，仅参数）
  void router.replace({ query: { ...route.query, tab: k } })
}

const botName = computed(() => currentAgent.value?.name || '')
const worldId = computed(() => teamView.worldId || stockView.worldId || '')
</script>

<template>
  <div class="world">
    <div class="bar">
      <div class="tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ active: tab === t.key }"
          @click="select(t.key)"
        >{{ t.label }}</button>
      </div>
      <span class="faint small">
        存档 <b>{{ worldId || '（未知/未接）' }}</b>
        <template v-if="botName"> · bot <b>{{ botName }}</b></template>
        <template v-else> · 面板还没选中 bot</template>
        <template v-if="!store.connected"> · <b class="bad">未连接 mindserver</b></template>
      </span>
      <div class="spacer" />
      <span class="faint small">只读视图 · 写操作在任务板/设置/凭据</span>
    </div>

    <div class="body">
      <TeamPanel v-if="tab === 'team'" />
      <StockPanel v-else-if="tab === 'stock'" />
      <EventsPanel v-else-if="tab === 'events'" />
      <FederationPanel v-else />
    </div>
  </div>
</template>

<style scoped>
.world { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.bar {
  flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px var(--gap); border-bottom: 1px solid var(--border-soft); background: var(--bg-panel);
}
.tabs { display: flex; gap: 2px; }
.tab {
  font-size: 12px; padding: 3px 12px; border-radius: 6px;
  background: transparent; border: 1px solid transparent; color: var(--fg-dim);
}
.tab:hover:not(.active) { background: var(--bg-hover); color: var(--fg); }
.tab.active { background: var(--bg-elev); border-color: var(--border); color: var(--accent); }
.small { font-size: 11px; }
.bad { color: var(--bad); }
.spacer { flex: 1; }
.body { flex: 1; min-height: 0; overflow: hidden; }
</style>
