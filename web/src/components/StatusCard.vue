<script setup lang="ts">
import { computed } from 'vue'
import { currentAgent, currentState, agentAction, store } from '../stores/agents'

const s = currentState
const a = currentAgent

const inGame = computed(() => !!a.value?.in_game)
const healthPct = computed(() => Math.max(0, Math.min(100, ((s.value?.gameplay.health ?? 0) / 20) * 100)))
const hungerPct = computed(() => Math.max(0, Math.min(100, ((s.value?.gameplay.hunger ?? 0) / 20) * 100)))

const pos = computed(() => {
  const p = s.value?.gameplay.position
  return p ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}` : '-'
})

const actionKind = computed(() => s.value?.action.kind || 'idle')
const lastFailure = computed(() => {
  const f = s.value?.lastFailure
  if (!f) return ''
  if (typeof f === 'string') return f
  return f.message || f.code || JSON.stringify(f).slice(0, 120)
})

function fmt(v: any) { return v === undefined || v === null || v === '' ? '-' : v }
</script>

<template>
  <div class="card">
    <div class="head">
      <div class="who">
        <span class="avatar">◆</span>
        <div>
          <div class="name">{{ a?.name || '无 agent' }}</div>
          <div class="sub faint">{{ s?.gameplay.biome || '未知群系' }} · {{ s?.gameplay.dimension || '-' }}</div>
        </div>
      </div>
      <span class="badge" :class="inGame ? 'ok' : 'bad'">{{ inGame ? '在线' : '离线' }}</span>
    </div>

    <div class="bars">
      <div class="bar">
        <span class="k">❤</span>
        <div class="track"><i class="fill hp" :style="{ width: healthPct + '%' }" /></div>
        <span class="v num">{{ fmt(s?.gameplay.health) }}</span>
      </div>
      <div class="bar">
        <span class="k">⛁</span>
        <div class="track"><i class="fill food" :style="{ width: hungerPct + '%' }" /></div>
        <span class="v num">{{ fmt(s?.gameplay.hunger) }}</span>
      </div>
    </div>

    <dl class="grid">
      <dt>动作</dt>
      <dd>
        <span class="act" :class="actionKind">{{ s?.action.current || '未知' }}</span>
      </dd>
      <dt>位置</dt>
      <dd class="num">{{ pos }}</dd>
      <dt>朝向</dt>
      <dd>{{ s?.facing?.text || '-' }}</dd>
      <dt>天气/时间</dt>
      <dd>{{ fmt(s?.gameplay.weather) }} · {{ fmt(s?.gameplay.timeLabel) }}</dd>
      <dt>附近</dt>
      <dd>
        <span v-if="s?.nearby.humanPlayers.length">{{ s.nearby.humanPlayers.join(', ') }}</span>
        <span v-else class="faint">无玩家</span>
      </dd>
    </dl>

    <div v-if="lastFailure" class="fail" :title="lastFailure">
      <span class="k">上次失败</span>{{ lastFailure }}
    </div>

    <div class="actions">
      <button :disabled="!a || inGame" @click="agentAction('start-agent')">启动</button>
      <button :disabled="!a || !inGame" @click="agentAction('stop-agent')">停止</button>
      <button :disabled="!a" class="danger" @click="agentAction('restart-agent')">重启</button>
    </div>
  </div>
</template>

<style scoped>
.card { display: flex; flex-direction: column; gap: 10px; padding: 12px; }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.who { display: flex; align-items: center; gap: 9px; }
.avatar {
  width: 30px; height: 30px; border-radius: 7px; flex: none;
  display: grid; place-items: center;
  background: var(--bg-hover); color: var(--accent); border: 1px solid var(--border);
}
.name { font-weight: 600; }
.sub { font-size: 11px; }

.bars { display: flex; flex-direction: column; gap: 5px; }
.bar { display: flex; align-items: center; gap: 7px; font-size: 11px; }
.bar .k { width: 12px; text-align: center; color: var(--fg-dim); }
.track { flex: 1; height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; }
.fill { display: block; height: 100%; border-radius: 3px; transition: width .3s; }
.fill.hp { background: linear-gradient(90deg, #da3633, #f85149); }
.fill.food { background: linear-gradient(90deg, #9e6a03, #d29922); }
.bar .v { width: 22px; text-align: right; color: var(--fg-dim); }

.grid { display: grid; grid-template-columns: 62px 1fr; gap: 4px 8px; margin: 0; font-size: 12px; }
.grid dt { color: var(--fg-faint); }
.grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.act { padding: 0 6px; border-radius: 4px; background: var(--bg-hover); font-size: 11px; }
.act.acting { color: #7ee787; background: #0f2a17; }
.act.chatting { color: #a5d6ff; background: #0d2036; }
.act.thinking { color: #d2a8ff; background: #221533; }
.act.stopped { color: #ffa198; background: #2d1416; }

.fail {
  font-size: 11px; color: #ffb4ae; background: #2d1416;
  border: 1px solid #5a2226; border-radius: 6px; padding: 5px 7px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fail .k { color: var(--fg-faint); margin-right: 6px; }

.actions { display: flex; gap: 6px; margin-top: auto; }
.actions button { flex: 1; }
</style>
