<script setup lang="ts">
import { computed, ref, onMounted, watch, nextTick } from 'vue'
import { store, currentState, currentAgent, retrySubscribe } from '../stores/agents'
import { humanize } from '../api/humanize'
import {
  diag, pullEvents, clearEvents, fetchTaskState, fetchMemory, eventTone, eventDetail,
} from '../stores/diag'

type Tab = 'events' | 'task' | 'memory' | 'state' | 'output'
const tab = ref<Tab>('events')

// W13：只在真的停在 full_state 页时才 stringify（原来每秒对整份状态做一次）
const stateJson = computed(() =>
  tab.value !== 'state'
    ? ''
    : (currentState.value ? JSON.stringify(currentState.value, null, 2) : '（无数据）'),
)

const output = computed(() => store.output.slice().reverse())

const filteredEvents = computed(() => {
  const q = diag.filter.trim().toLowerCase()
  const list = [...diag.events].reverse()
  if (!q) return list
  return list.filter(e => (e.type + ' ' + eventDetail(e)).toLowerCase().includes(q))
})

const listEl = ref<HTMLElement | null>(null)

function time(ts: number) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

async function copy() {
  const text =
    tab.value === 'events' ? filteredEvents.value.map(e => JSON.stringify(e)).join('\n')
    : tab.value === 'task' ? JSON.stringify(diag.taskState, null, 2)
    : tab.value === 'memory' ? (diag.memory?.memory || '')
    : tab.value === 'state' ? stateJson.value
    : output.value.map(o => o.text).join('\n')
  await navigator.clipboard?.writeText(text)
}

watch(tab, (t) => {
  if (t === 'events' && !diag.events.length) void pullEvents()
  if (t === 'task') void fetchTaskState()
  if (t === 'memory') void fetchMemory()
})

onMounted(() => {
  void pullEvents()
  void fetchTaskState()
})
</script>

<template>
  <div class="debug">
    <div class="tabs">
      <button :class="{ on: tab === 'events' }" @click="tab = 'events'">
        事件流 <span class="cnt">{{ diag.events.length }}</span>
      </button>
      <button :class="{ on: tab === 'task' }" @click="tab = 'task'">任务 / 运行时</button>
      <button :class="{ on: tab === 'memory' }" @click="tab = 'memory'">记忆</button>
      <button :class="{ on: tab === 'state' }" @click="tab = 'state'">full_state</button>
      <button :class="{ on: tab === 'output' }" @click="tab = 'output'">输出日志</button>

      <div class="spacer" />
      <!-- #62：订阅状态显式化（listen-to-agents 被限流时，relay 根本没注册，所有面板都只会超时） -->
      <span class="small" :class="store.subscribed ? 'faint' : 'bad'">
        {{ store.subscribed ? '已订阅状态' : '未确认订阅' }}
      </span>
      <button v-if="!store.subscribed" @click="retrySubscribe()">重试订阅</button>
      <span class="faint small">{{ currentAgent?.name || '-' }}</span>
      <button @click="copy">复制</button>
    </div>

    <!-- 事件流 -->
    <div v-show="tab === 'events'" class="pane-wrap">
      <div class="toolbar">
        <input v-model="diag.filter" type="text" placeholder="过滤 type / 字段…" spellcheck="false" />
        <button :class="{ on: diag.paused }" @click="diag.paused = !diag.paused">
          {{ diag.paused ? '继续接收' : '暂停接收' }}
        </button>
        <button @click="pullEvents">补拉</button>
        <button class="danger" @click="clearEvents">清空</button>
        <span v-if="diag.lastError" class="bad small">{{ humanize(diag.lastError) }}</span>
      </div>
      <div ref="listEl" class="pane scroll">
        <div v-for="e in filteredEvents" :key="e.seq" class="ev" :class="eventTone(e.type)">
          <span class="seq faint num">#{{ e.seq }}</span>
          <span class="t faint num">{{ time(e.ts) }}</span>
          <span class="type">{{ e.type }}</span>
          <span class="detail">{{ eventDetail(e) }}</span>
        </div>
        <div v-if="!filteredEvents.length" class="faint empty">
          还没有事件。让她动起来（发个「砍 8 个木头」或在游戏里叫她），导航层的 dig / plan-fail /
          scan3d 会自动流进来。
        </div>
      </div>
    </div>

    <!-- 任务 / 运行时 -->
    <div v-show="tab === 'task'" class="pane scroll">
      <div class="toolbar inline">
        <button :disabled="diag.busy" @click="fetchTaskState">{{ diag.busy ? '读取中…' : '刷新' }}</button>
        <span v-if="diag.taskState && !diag.taskState.ok" class="bad small">
          {{ humanize(diag.taskState.reason) || '读取失败' }}
        </span>
      </div>

      <template v-if="diag.taskState?.ok">
        <div class="kv-grid">
          <div class="k">当前动作</div>
          <div class="v">
            <span v-if="diag.taskState.action?.current">{{ diag.taskState.action.current }}</span>
            <span v-else class="faint">{{ diag.taskState.action?.isIdle ? '空闲' : '-' }}</span>
            <span class="faint"> · executing={{ diag.taskState.action?.executing }}</span>
          </div>

          <div class="k">自驱</div>
          <div class="v">
            stopped={{ diag.taskState.selfPrompter?.stopped }} ·
            paused={{ diag.taskState.selfPrompter?.paused }} ·
            active={{ diag.taskState.selfPrompter?.active }}
          </div>

          <div class="k">任务</div>
          <div class="v">
            {{ diag.taskState.task?.present ? (diag.taskState.task?.name || '有任务') : '无任务（自由对话）' }}
          </div>

          <div class="k">地形库</div>
          <div class="v num" v-if="diag.taskState.store">
            {{ diag.taskState.store.cells.toLocaleString() }} 个可站立面 ·
            {{ diag.taskState.store.chunks.toLocaleString() }} 个区块
          </div>
          <div class="v faint" v-else>读不到</div>

          <div class="k">有效失败点</div>
          <div class="v num">{{ diag.taskState.activeFails ?? '-' }} <span class="faint">（10 分钟内）</span></div>

          <div class="k">事件缓冲</div>
          <div class="v num">
            seq={{ diag.taskState.events?.seq }} · {{ diag.taskState.events?.size }}/{{ diag.taskState.events?.max }}
          </div>

          <div class="k">模式</div>
          <div class="v">{{ diag.taskState.modes || '（无）' }}</div>
        </div>
      </template>
      <div v-else class="faint pad">点「刷新」读取（要求 bot 在游戏里）。</div>
    </div>

    <!-- 记忆 -->
    <div v-show="tab === 'memory'" class="pane scroll">
      <div class="toolbar inline">
        <button :disabled="diag.busy" @click="fetchMemory">{{ diag.busy ? '读取中…' : '刷新' }}</button>
        <span v-if="diag.memory?.ok" class="faint small num">
          {{ diag.memory.path }} · {{ diag.memory.bytes }} 字节 ·
          {{ diag.memory.turns }} 轮 · v{{ diag.memory.codeVersion }}
        </span>
        <span v-else-if="diag.memory" class="bad small">{{ diag.memory.reason }}</span>
      </div>
      <pre v-if="diag.memory?.ok" class="mem">{{ diag.memory.memory || '（memory 为空）' }}</pre>
      <div v-else class="faint pad">点「刷新」读取她的记忆摘要。</div>
    </div>

    <!-- full_state -->
    <div v-show="tab === 'state'" class="pane scroll">
      <pre>{{ stateJson }}</pre>
    </div>

    <!-- 输出日志 -->
    <div v-show="tab === 'output'" class="pane scroll">
      <div v-for="o in output" :key="o.seq" class="line">
        <span class="faint num">{{ time(o.t) }}</span>
        <span class="who">{{ o.agent }}</span>
        <span class="text">{{ o.text }}</span>
      </div>
      <div v-if="!output.length" class="faint empty">还没有输出</div>
    </div>
  </div>
</template>

<style scoped>
.debug { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: var(--gap); gap: 8px; }

.tabs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tabs button.on { background: var(--bg-elev); border-color: var(--accent); color: var(--accent); }
.cnt { font-size: 10px; color: var(--fg-faint); }
.spacer { flex: 1; }
.small { font-size: 11px; }
.bad { color: #ffb4ae; }

.pane-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.toolbar { display: flex; align-items: center; gap: 6px; }
.toolbar.inline { margin-bottom: 8px; }
.toolbar input { flex: 1; max-width: 320px; }
.toolbar button.on { background: #2d333b; border-color: var(--warn); color: var(--warn); }

.pane { flex: 1; min-height: 0; overflow: auto; background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
pre { margin: 0; font-size: 11.5px; line-height: 1.55; color: #a5d6ff; }
pre.mem { color: #d2d8de; white-space: pre-wrap; word-break: break-word; }

.ev { display: flex; gap: 8px; font-size: 11.5px; padding: 2px 0; border-bottom: 1px solid #161b22; align-items: baseline; }
.ev .seq { width: 46px; flex: none; }
.ev .t { width: 58px; flex: none; }
.ev .type { flex: none; min-width: 108px; font-weight: 600; }
.ev .detail { flex: 1; color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ev.bad .type { color: var(--bad); }
.ev.warn .type { color: var(--warn); }
.ev.act .type { color: var(--accent); }
.ev.plain .type { color: var(--fg); }

.kv-grid { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; font-size: 12px; }
.kv-grid .k { color: var(--fg-faint); }
.kv-grid .v { word-break: break-word; }

.line { display: flex; gap: 8px; font-size: 11.5px; padding: 1px 0; }
.line .who { color: var(--fg-dim); width: 70px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line .text { flex: 1; white-space: pre-wrap; word-break: break-word; }
.empty { font-size: 12px; line-height: 1.7; }
.pad { padding: 10px 0; }
</style>
