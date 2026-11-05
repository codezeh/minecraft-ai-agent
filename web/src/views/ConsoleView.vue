<script setup lang="ts">
import StatusCard from '../components/StatusCard.vue'
import InventoryGrid from '../components/InventoryGrid.vue'
import ChatStream from '../components/ChatStream.vue'
import QuickCommands from '../components/QuickCommands.vue'
import { store } from '../stores/agents'
</script>

<template>
  <div v-if="!store.agents.length" class="empty">
    <div class="panel box">
      <h2>还没有 agent</h2>
      <p class="dim">
        mindserver 没报告任何 agent。检查 <code>settings.js</code> 里的 <code>profiles</code>，
        或去「配置」页创建一个。
      </p>
      <RouterLink to="/setup"><button class="primary">去配置</button></RouterLink>
    </div>
  </div>

  <div v-else class="console">
    <aside class="left panel">
      <StatusCard />
      <div class="divider" />
      <div class="panel-title">背包</div>
      <InventoryGrid />
    </aside>

    <section class="center panel">
      <ChatStream />
      <QuickCommands />
    </section>
  </div>
</template>

<style scoped>
/* 2D 地形是废案，已移除；空出来的宽度给对话区 */
.console {
  display: grid;
  grid-template-columns: 340px minmax(420px, 1fr);
  gap: var(--gap);
  padding: var(--gap);
  height: 100%;
  min-height: 0;
}

.left, .center { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.divider { flex: none; height: 1px; background: var(--border-soft); }

.empty { display: grid; place-items: center; height: 100%; }
.box { padding: 28px 32px; max-width: 420px; text-align: center; }
.box h2 { margin-bottom: 8px; font-size: 15px; }
.box p { margin: 0 0 16px; font-size: 12px; line-height: 1.7; }
.box code { background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; }

@media (max-width: 980px) {
  .console { grid-template-columns: 1fr; height: auto; overflow: auto; }
  .left, .center { max-height: 75vh; }
}
</style>
