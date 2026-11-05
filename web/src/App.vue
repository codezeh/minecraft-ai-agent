<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { store, currentAgent, selectAgent } from './stores/agents'

const route = useRoute()

const navItems = computed(() => [
  { to: '/', label: '控制台' },
  { to: '/terrain', label: '3D 地形' },
  { to: '/debug', label: '诊断' },
  { to: '/setup', label: '配置' },
])

const connClass = computed(() => (store.connected ? 'ok' : store.everConnected ? 'warn' : 'bad'))
const connText = computed(() =>
  store.connected ? 'mindserver 已连接' : store.everConnected ? '重连中…' : '未连接',
)
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo">◆</span>
        <span class="name">陪玩控制台</span>
      </div>

      <nav class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          :class="{ active: route.path === item.to }"
        >{{ item.label }}</RouterLink>
      </nav>

      <div class="right">
        <select
          v-if="store.agents.length > 1"
          class="agent-select"
          :value="currentAgent?.name || ''"
          @change="selectAgent(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="a in store.agents" :key="a.name" :value="a.name">
            {{ a.name }}{{ a.in_game ? '' : '（离线）' }}
          </option>
        </select>
        <span class="badge" :class="connClass">
          <i class="dot" />{{ connText }}
        </span>
      </div>
    </header>

    <div v-if="store.lastError" class="banner">{{ store.lastError }}</div>

    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100%; }

.topbar {
  display: flex; align-items: center; gap: 16px;
  padding: 0 14px; height: 46px; flex: none;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 7px; }
.logo { color: var(--accent); }
.name { font-weight: 600; letter-spacing: .02em; }

.nav { display: flex; gap: 2px; margin-left: 8px; }
.nav-link {
  padding: 5px 11px; border-radius: 6px; color: var(--fg-dim);
  text-decoration: none; font-size: 12px;
}
.nav-link:hover { background: var(--bg-hover); color: var(--fg); }
.nav-link.active { background: var(--bg-elev); color: var(--accent); }

.right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.agent-select { padding: 3px 6px; }

.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.banner {
  flex: none;
  padding: 7px 14px;
  font-size: 12px;
  color: #ffb4ae;
  background: #2d1416;
  border-bottom: 1px solid #5a2226;
}

.content { flex: 1; min-height: 0; overflow: hidden; }
</style>
