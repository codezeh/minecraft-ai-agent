<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { store, currentAgent, selectAgent, dismissError, dataStale, stateAgeMs } from './stores/agents'
import { reconnectNow } from './api/socket'

const route = useRoute()

const navItems = computed(() => [
  { to: '/', label: '控制台' },
  { to: '/terrain', label: '3D 地形' },
  { to: '/debug', label: '诊断' },
  { to: '/setup', label: '配置' },
  // R5 t28：设置中心（开关/滑块）。和 /setup 分开：「配置」是建 agent 的向导，
  // 「设置」是改运行参数的开关面板 —— 两者混在一起会让人以为都得重启才生效。
  { to: '/settings', label: '设置' },
  // R5 t15：凭据保管库。导航条目和 router.ts 的 meta.label 必须一致，
  // 否则"菜单里叫一个名、路由里叫另一个名"，搜文档的人会对不上。
  { to: '/vault', label: '凭据' },
  // #68：任务板（后端 board:* 早就有，前端一直没有入口）
  { to: '/board', label: '任务板' },
  // t3：存档只读视图（队伍/库存/事件/联邦）。label 必须与 router.ts 的 meta.label 一致。
  { to: '/world', label: '存档' },
])

const connClass = computed(() => (store.connected ? 'ok' : store.everConnected ? 'warn' : 'bad'))
const connText = computed(() => {
  // #66：token 失效时不再说"重连中"（它其实已经停了），要说清下一步怎么做。
  if (store.authFailed) return 'token 失效'
  return store.connected ? 'mindserver 已连接' : store.everConnected ? '重连中…' : '未连接'
})

/** #63：数据新鲜度（断线/超时都把"最后一帧多久前"摆到台面上）。 */
const ageText = computed(() => {
  if (!store.connected) return ''
  const ms = stateAgeMs.value
  if (!Number.isFinite(ms)) return '尚未收到状态'
  return ms >= 1000 ? `${Math.round(ms / 1000)}s 前` : '刚刚'
})
const staleClass = computed(() => (dataStale.value ? 'bad' : 'ok'))
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
        <span v-if="store.connected" class="badge" :class="staleClass" :title="'最后一帧状态：' + ageText">
          数据 {{ ageText }}
        </span>
        <span class="badge" :class="connClass">
          <i class="dot" />{{ connText }}
        </span>
      </div>
    </header>

    <div v-if="store.lastError" class="banner">
      <span class="txt">{{ store.lastError }}</span>
      <button v-if="!store.connected" class="mini" @click="reconnectNow()">重试连接</button>
      <button class="mini ghost" title="关闭这条提示" @click="dismissError()">×</button>
    </div>

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
  display: flex; align-items: center; gap: 8px;
}
.banner .txt { flex: 1; }
.banner .mini { font-size: 11px; padding: 1px 8px; }
.banner .mini.ghost { background: transparent; border-color: #5a2226; }

.content { flex: 1; min-height: 0; overflow: hidden; }
</style>
