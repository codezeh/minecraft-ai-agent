<script setup lang="ts">
/**
 * `_global` events 的只读时间线（t3）：分页（`{at,id}` 游标）+ 按 kind 过滤。
 *
 * 数据源是 `events:since`（t7 在 mindserver 接线；服务端未接时本页如实说"暂不可用"）。
 * ★ 不显示 token/hash：服务端只写标识，面板再用 `payloadText()` 剔一遍敏感字段（第二道闸）。
 */
import { computed, onMounted } from 'vue'
import { store } from '../../stores/agents'
import {
  eventsView, kindOptions, kindSourceNote, EVENT_WINDOWS,
  loadEvents, loadMoreEvents, loadEventStats, payloadText, ensureClock, clock,
} from '../../stores/world'
import { fmtTime, fmtAgo } from '../../api/time'

onMounted(() => {
  ensureClock()
  void loadEventStats()
  void loadEvents(true)
})

function reload() { void loadEvents(true) }
function more() { void loadMoreEvents() }
// 筛选切换只是"再发一次请求"：乱序回执由 store 的请求代号裁决（world.ts 的 RACE-GUARD），本页不重复实现。
function onWindowChange() { void loadEvents(true) }
function onKindChange() { void loadEvents(true) }

/** 状态框：`not-wired` 与 `ok 但空` 必须是**两句话**（一个"没做"，一个"还没发生"）。 */
const stateBox = computed(() => {
  if (eventsView.phase === 'loading') return { tone: 'dim', text: '读取事件…' }
  if (eventsView.phase === 'not-wired') return { tone: 'warn', text: eventsView.message }
  if (eventsView.phase === 'error') return { tone: 'bad', text: eventsView.message }
  return null
})

const emptyText = computed(() => {
  const win = EVENT_WINDOWS.find((w) => w.ms === eventsView.windowMs)?.label || '当前时间窗'
  if (eventsView.kind) return `${win}里没有 ${eventsView.kind} 这类事件的记录`
  return `${win}里还没有事件记录（不是"功能没做"：服务端回了空列表）`
})

/** 倒序展示：最近发生的在上面（服务端按 at 升序回，分页仍需升序游标）。 */
const rows = computed(() => eventsView.events.slice().reverse())

const total = computed(() => eventsView.events.length)
</script>

<template>
  <div class="wrap scroll">
    <div class="head">
      <h3>事件</h3>
      <span class="faint small">
        `_global` 只读时间线 · 已载入 {{ total }} 条{{ eventsView.mayHaveMore ? '+' : '' }}
        <template v-if="eventsView.kind"> · 只看 <b>{{ eventsView.kind }}</b></template>
        <template v-if="!store.connected"> · <b class="bad">未连接 mindserver</b></template>
      </span>
      <div class="spacer" />
      <select v-model.number="eventsView.windowMs" @change="onWindowChange">
        <option v-for="w in EVENT_WINDOWS" :key="w.ms" :value="w.ms">{{ w.label }}</option>
      </select>
      <select v-model="eventsView.kind" :title="kindSourceNote" @change="onKindChange">
        <option value="">全部 kind</option>
        <option v-for="k in kindOptions" :key="k" :value="k">{{ k }}</option>
      </select>
      <button :disabled="eventsView.phase === 'loading' || !store.connected" @click="reload()">刷新</button>
    </div>

    <div class="row faint small">
      <span>kind 清单：{{ kindSourceNote }}</span>
    </div>

    <div v-if="stateBox" class="msg" :class="stateBox.tone">{{ stateBox.text }}</div>

    <template v-if="eventsView.phase === 'ok'">
      <div class="table">
        <div class="thead">
          <span class="c-at">时间</span>
          <span class="c-kind">kind</span>
          <span class="c-who">who</span>
          <span class="c-world">存档</span>
          <span class="c-payload">payload</span>
        </div>
        <div v-for="e in rows" :key="e.id" class="trow">
          <span class="c-at" :title="e.id">{{ fmtTime(e.at) }}<i class="faint"> · {{ fmtAgo(e.at, clock.now) }}</i></span>
          <span class="c-kind"><span class="tag" :class="e.kind.startsWith('inventory.') ? 'warn' : (e.kind.startsWith('team.') ? 'ok' : 'plain')">{{ e.kind }}</span></span>
          <span class="c-who mono">{{ e.avatarId || '-' }}</span>
          <span class="c-world mono faint">{{ e.worldId || '-' }}</span>
          <span class="c-payload mono" :title="payloadText(e.payload)">{{ payloadText(e.payload) }}</span>
        </div>
        <div v-if="!rows.length" class="empty faint">{{ emptyText }}</div>
      </div>

      <div class="row more">
        <button :disabled="!eventsView.cursor || eventsView.loadingMore" @click="more()">
          {{ eventsView.loadingMore ? '读取中…' : '继续往后读（更新的）' }}
        </button>
        <span class="faint small">
          服务端 `since` 是「`at >= 游标`」（宁重不漏），重复行按 id 去重；
          单页上限由服务端夹（默认 200 / 最大 500）—— 满一页就只能说"可能还有"。
        </span>
      </div>
      <div v-if="eventsView.moreMessage" class="msg warn">{{ eventsView.moreMessage }}</div>
    </template>

    <p class="hint faint">
      只读时间线：本页不写事件、不删事件（`events` 表在库层就是追加写，任何 UPDATE/DELETE 会被 ABORT）。
      这里**不显示任何 token / token 哈希 / 公钥**：服务端写事件时就只落标识，
      面板再按字段名（token/secret/hash/pubkey/sig…）剥一层，两层都不给。
    </p>
  </div>
</template>

<style scoped>
.wrap { padding: var(--gap); display: flex; flex-direction: column; gap: 8px; height: 100%; overflow: auto; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head h3 { font-size: 14px; }
.spacer { flex: 1; }
.small { font-size: 11px; }
.bad { color: var(--bad); }

.msg { font-size: 12px; padding: 7px 10px; border-radius: 6px; }
.msg.dim { color: var(--fg-dim); background: var(--bg-panel); border: 1px solid var(--border-soft); }
.msg.warn { color: var(--warn); background: #26200f; border: 1px solid #4a3f1f; }
.msg.bad { color: var(--bad); background: #261212; border: 1px solid #4a2a2a; }

.table { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.thead, .trow { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12px; }
.thead { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-faint);
         background: var(--bg); border-bottom: 1px solid var(--border-soft); }
.trow { border-bottom: 1px solid var(--border-soft); }
.trow:last-child { border-bottom: none; }
.empty { padding: 12px; font-size: 12px; }

.c-at { flex: 0 0 172px; font-size: 11px; }
.c-at i { font-style: normal; }
.c-kind { flex: 0 0 148px; }
.c-who { flex: 0 0 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.c-world { flex: 0 0 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.c-payload { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }

.more { margin-top: 2px; }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--border); color: var(--fg-dim); }
.tag.ok { color: var(--ok); border-color: #2a4a2f; background: #12261a; }
.tag.warn { color: var(--warn); border-color: #4a3f1f; background: #26200f; }
.tag.plain { color: var(--fg-dim); }
.hint { font-size: 11px; line-height: 1.6; margin: 4px 0 0; }
</style>
