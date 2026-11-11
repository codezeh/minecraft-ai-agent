<script setup lang="ts">
import { computed } from 'vue'
import { currentAgent, currentState, agentAction, store, isActionPending, stateAgeMs, STALE_AFTER_MS } from '../stores/agents'

const s = currentState
const a = currentAgent

// #58/#63：在线 = 连上了 && 列表没失效 && in_game；断线时不许再显示"在线"。
const inGame = computed(() => !!a.value?.in_game && store.connected && !store.agentsStale)
/** #63：状态帧超过 5 秒即视为过期（服务端 5 秒不回会沿用旧帧，面板必须能看出来）。 */
const expired = computed(() => Number.isFinite(stateAgeMs.value) && stateAgeMs.value > STALE_AFTER_MS)
const ageSec = computed(() => Number.isFinite(stateAgeMs.value) ? Math.round(stateAgeMs.value / 1000) : null)
// ★ WEB-002：`gameplay` 本身可能整个缺失（服务端首次 full_state 超时后只发了错误对象）。
//   原来写 `s.value?.gameplay.health` —— 可选链只保护了 `s`，`gameplay` 是 undefined 时仍然抛。
//   现在逐层可选，拿不到就按 0 显示，让卡片降级而不是崩掉整个面板。
const g = computed(() => s.value?.gameplay ?? null)
const healthPct = computed(() => { const v = g.value?.health; return typeof v === 'number' ? Math.max(0, Math.min(100, (v / 20) * 100)) : 0 })
const hungerPct = computed(() => { const v = g.value?.hunger; return typeof v === 'number' ? Math.max(0, Math.min(100, (v / 20) * 100)) : 0 })

const pos = computed(() => {
  const p = g.value?.position
  return p && typeof p.x === 'number' ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}` : '-'
})

const actionKind = computed(() => s.value?.action?.kind || 'idle')
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

    <!-- #63：状态停更必须可见（否则卡死的 bot 会长期显示"健康、坐标正常"） -->
    <div v-if="expired" class="stale">
      ⚠ 状态已过期 {{ ageSec }} 秒（服务端超时会沿用上一帧）—— 下面的坐标/血量可能不是现在
    </div>

    <div v-if="store.actionError[a?.name || '']" class="fail" :title="store.actionError[a?.name || '']">
      <span class="k">操作失败</span>{{ store.actionError[a?.name || ''] }}
    </div>

    <div v-if="lastFailure" class="fail" :title="lastFailure">
      <span class="k">上次失败</span>{{ lastFailure }}
    </div>

    <div class="actions">
      <!-- #65：在飞期间上锁；#57：服务端无 ack，按钮文案如实说"已发起" -->
      <button :disabled="!a || inGame || isActionPending(a.name, 'start-agent')" @click="agentAction('start-agent')">
        {{ isActionPending(a?.name || '', 'start-agent') ? '启动中…' : '启动' }}
      </button>
      <button :disabled="!a || !inGame || isActionPending(a.name, 'stop-agent')" @click="agentAction('stop-agent')">
        {{ isActionPending(a?.name || '', 'stop-agent') ? '停止中…' : '停止' }}
      </button>
      <button :disabled="!a || isActionPending(a.name, 'restart-agent')" class="danger"
              @click="agentAction('restart-agent')">
        {{ isActionPending(a?.name || '', 'restart-agent') ? '重启中…' : '重启' }}
      </button>
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

/* #63：数据过期横幅（比错误更常见，要能一眼看到） */
.stale {
  font-size: 11px; color: #ffd18a; background: #2a2110;
  border: 1px solid #4a3f1f; border-radius: 6px; padding: 5px 7px;
}

.actions { display: flex; gap: 6px; margin-top: auto; }
.actions button { flex: 1; }
</style>
