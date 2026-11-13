<script setup lang="ts">
/**
 * 共享库存只读视图（t3）：物品清单（已知/预占/可用）、预占中（holder/qty/到期）、
 * 容器缓存、最近账本与对账差异。
 *
 * ★ 只读：本页**不预占、不结算、不释放、不对账**（那些是 bot 侧流程，面板没有开箱观测，
 *   替人点"对账"只会写进假差额 —— 见 wiring-web.md §4）。
 */
import { computed, onMounted, ref } from 'vue'
import { currentAgent, store } from '../../stores/agents'
import {
  stockView, heldReservations, dirtyContainers, reconcileRows, negativeItems, teamView,
  loadStock, loadLedger, loadTeams, ensureClock, clock,
} from '../../stores/world'
import { fmtTime, fmtAgo } from '../../api/time'

const filter = ref('')
const reasonFilter = ref('')

onMounted(() => {
  ensureClock()
  void loadStock()
  void loadLedger()
  // 「本队共享仓」标记要用队伍坐标：直接从本页先打开时也要有（teamView 还没读过才补一次）
  if (teamView.phase === 'idle') void loadTeams(currentAgent.value?.name || '')
})

function refresh() {
  void loadStock()
  void loadLedger()
}

/** 物品清单：按可用量降序（负数最先被看见），并套一层文本过滤。 */
const items = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const list = stockView.items.slice().sort((a, b) => a.available - b.available || a.item.localeCompare(b.item))
  return q ? list.filter((i) => i.item.toLowerCase().includes(q)) : list
})

const reasons = computed(() => {
  const set = new Set(stockView.ledger.map((r) => r.reason))
  return [...set].sort()
})

const ledger = computed(() => {
  const r = reasonFilter.value
  return r ? stockView.ledger.filter((e) => e.reason === r) : stockView.ledger
})

/** 队伍共享仓坐标（若队伍视图已读）：把容器标记成"这是本队的共享仓"。 */
const teamChestKeys = computed(() => new Set(teamView.chests.map((c) => `${c.x},${c.y},${c.z}`)))

function containerKey(c: { x: number; y: number; z: number }): string { return `${c.x},${c.y},${c.z}` }
function itemsSummary(items: Record<string, number>): string {
  const parts = Object.entries(items || {}).filter(([, n]) => Number(n) > 0)
  if (!parts.length) return '空'
  const head = parts.slice(0, 6).map(([n, c]) => `${n}×${c}`).join(' ')
  return parts.length > 6 ? `${head} …（共 ${parts.length} 种）` : head
}

const stockPhase = computed(() => {
  if (stockView.phase === 'loading') return { tone: 'dim', text: '读取库存快照…' }
  if (stockView.phase === 'not-wired') return { tone: 'warn', text: stockView.message }
  if (stockView.phase === 'error') return { tone: 'bad', text: stockView.message }
  return null
})
const ledgerPhase = computed(() => {
  if (stockView.ledgerPhase === 'loading') return { tone: 'dim', text: '读取账本…' }
  if (stockView.ledgerPhase === 'not-wired') return { tone: 'warn', text: stockView.ledgerMessage }
  if (stockView.ledgerPhase === 'error') return { tone: 'bad', text: stockView.ledgerMessage }
  return null
})
</script>

<template>
  <div class="wrap scroll">
    <div class="head">
      <h3>共享库存</h3>
      <span class="faint small">
        存档 {{ stockView.worldId || '（未知）' }} · {{ stockView.items.length }} 种物品 ·
        {{ heldReservations.length }} 张预占 ·
        <template v-if="stockView.expired.length"> 读取时作废过期券 {{ stockView.expired.length }} 张 ·</template>
        {{ stockView.containers.length }} 个已知容器
        <template v-if="!store.connected"> · <b class="bad">未连接 mindserver</b></template>
      </span>
      <div class="spacer" />
      <input v-model="filter" class="filter" placeholder="过滤物品名…" spellcheck="false" />
      <button :disabled="stockView.phase === 'loading' || !store.connected" @click="refresh()">刷新</button>
    </div>

    <div v-if="stockPhase" class="msg" :class="stockPhase.tone">{{ stockPhase.text }}</div>

    <template v-if="stockView.phase === 'ok'">
      <!-- ① 物品：已知 / 预占 / 可用 -->
      <div class="table">
        <div class="thead">
          <span class="c-item">物品</span>
          <span class="c-num">已知</span>
          <span class="c-num">预占中</span>
          <span class="c-num">可用</span>
        </div>
        <div v-for="i in items" :key="i.item" class="trow" :class="{ bad: i.available < 0 }">
          <span class="c-item mono">{{ i.item }}</span>
          <span class="c-num num">{{ i.known }}</span>
          <span class="c-num num">{{ i.reserved }}</span>
          <span class="c-num num" :class="{ neg: i.available < 0 }">
            {{ i.available }}<i v-if="i.available < 0" class="faint"> 预占超过已知</i>
          </span>
        </div>
        <div v-if="!items.length" class="empty faint">
          {{ stockView.items.length ? '没有满足过滤条件的物品' : '还没有任何容器内容被记录（容器缓存是空的）' }}
        </div>
      </div>

      <div v-if="negativeItems.length" class="msg warn">
        ⚠ {{ negativeItems.length }} 种物品的预占超过了已知库存：服务端对账时会把这类列成警告，
        但**不会**替你撤销别人的券（需要人工确认）。
      </div>

      <!-- ② 预占中：holder / qty / 到期 -->
      <div class="panel">
        <div class="panel-title">预占中（{{ heldReservations.length }}）</div>
        <div class="table flat">
          <div class="thead">
            <span class="c-id">预占 id</span>
            <span class="c-item2">物品</span>
            <span class="c-num">数量</span>
            <span class="c-holder">持有者</span>
            <span class="c-at">到期</span>
            <span class="c-at2">建立</span>
          </div>
          <div v-for="r in heldReservations" :key="r.id" class="trow">
            <span class="c-id mono" :title="r.id">{{ r.id }}</span>
            <span class="c-item2 mono">{{ r.item }}</span>
            <span class="c-num num">{{ r.qty }}</span>
            <span class="c-holder mono">{{ r.holder }}</span>
            <span class="c-at" :title="fmtTime(r.expires_at)">
              <span :class="r.expires_at <= clock.now ? 'bad' : 'dim'">{{ fmtAgo(r.expires_at, clock.now) }}</span>
            </span>
            <span class="c-at2 faint">{{ fmtTime(r.created_at) }}</span>
          </div>
          <div v-if="!heldReservations.length" class="empty faint">
            没有预占中的券（`held` 为空）：此刻没有谁占着库存等取用。
          </div>
        </div>
      </div>

      <!-- ③ 容器缓存 + 待对账 -->
      <div class="panel">
        <div class="panel-title">
          容器（{{ stockView.containers.length }}）<template v-if="dirtyContainers.length"> · 待对账 {{ dirtyContainers.length }}</template>
        </div>
        <div class="table flat">
          <div class="thead">
            <span class="c-xyz">坐标</span>
            <span class="c-content">内容</span>
            <span class="c-at">最近观测</span>
            <span class="c-flag">状态</span>
          </div>
          <div v-for="c in stockView.containers" :key="containerKey(c)" class="trow">
            <span class="c-xyz mono">({{ c.x }}, {{ c.y }}, {{ c.z }})</span>
            <span class="c-content" :title="itemsSummary(c.items)">{{ itemsSummary(c.items) }}</span>
            <span class="c-at faint">{{ fmtAgo(c.updated_at, clock.now) }}</span>
            <span class="c-flag">
              <span v-if="c.dirty" class="tag warn" title="上次取用结果不确定：缓存不能当账，等下次开箱强刷或对账">待对账</span>
              <span v-if="teamChestKeys.has(containerKey(c))" class="tag ok">本队共享仓</span>
              <span v-if="!c.dirty && !teamChestKeys.has(containerKey(c))" class="faint">—</span>
            </span>
          </div>
          <div v-if="!stockView.containers.length" class="empty faint">
            还没有容器被观测过（第一次开箱后会写进缓存）。
          </div>
        </div>
      </div>
    </template>

    <!-- ④ 最近账本 + 对账差异 -->
    <div class="panel">
      <div class="panel-title">最近账本（{{ ledger.length }}）· 对账差异 {{ reconcileRows.length }}</div>
      <div class="sub-body">
        <div v-if="ledgerPhase" class="msg" :class="ledgerPhase.tone">{{ ledgerPhase.text }}</div>
        <template v-else>
          <div class="row bar">
            <select v-model="reasonFilter">
              <option value="">全部来源</option>
              <option v-for="r in reasons" :key="r" :value="r">{{ r }}</option>
            </select>
            <span class="faint small">
              账本只记**物理上真的动了**的数量（取用为负、对账修正为差额）；
              `reconcile` 那几行的 `delta` 就是账实差异。
            </span>
          </div>
          <div class="table flat">
            <div class="thead">
              <span class="c-at">时间</span>
              <span class="c-item2">物品</span>
              <span class="c-num">delta</span>
              <span class="c-holder">经手</span>
              <span class="c-reason">来源</span>
            </div>
            <div v-for="e in ledger" :key="e.id" class="trow">
              <span class="c-at faint">{{ fmtTime(e.at) }}</span>
              <span class="c-item2 mono">{{ e.item }}</span>
              <span class="c-num num" :class="e.delta < 0 ? 'neg' : (e.delta > 0 ? 'pos' : 'faint')">
                {{ e.delta > 0 ? '+' : '' }}{{ e.delta }}
              </span>
              <span class="c-holder mono">{{ e.holder || '-' }}</span>
              <span class="c-reason"><span class="tag" :class="e.reason === 'reconcile' ? 'warn' : 'plain'">{{ e.reason }}</span></span>
            </div>
            <div v-if="!ledger.length" class="empty faint">账本是空的（还没发生过取用/释放/对账）。</div>
          </div>
        </template>
      </div>
    </div>

    <p class="hint faint">
      两条必须知道的边界：① 共享库存**按存档**存（`inventory_*` 表没有 `team_id`），不是按队 ——
      所以这一页统计的是整个存档的共享库，"队"只体现在容器坐标是否属于本队。
      ② 真正的**账实差异**只能由客户端开箱上报后由 `inventory:reconcile` 写入；
      面板没有开箱观测，**不会**替你对账（那会写进凭空造出来的差额）。
    </p>
  </div>
</template>

<style scoped>
.wrap { padding: var(--gap); display: flex; flex-direction: column; gap: 8px; height: 100%; overflow: auto; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head h3 { font-size: 14px; }
.spacer { flex: 1; }
.small { font-size: 11px; }
.filter { width: 170px; }
.bad { color: var(--bad); }
.warn { color: var(--warn); }

.msg { font-size: 12px; padding: 7px 10px; border-radius: 6px; }
.msg.dim { color: var(--fg-dim); background: var(--bg-panel); border: 1px solid var(--border-soft); }
.msg.warn { color: var(--warn); background: #26200f; border: 1px solid #4a3f1f; }
.msg.bad { color: var(--bad); background: #261212; border: 1px solid #4a2a2a; }

.table { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.table.flat { border: none; border-radius: 0; }
.thead, .trow { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12px; }
.thead { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-faint);
         background: var(--bg); border-bottom: 1px solid var(--border-soft); }
.trow { border-bottom: 1px solid var(--border-soft); }
.trow:last-child { border-bottom: none; }
.trow.bad { background: #1f1315; }
.empty { padding: 12px; font-size: 12px; }

.c-item { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-item2 { flex: 0 0 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-num { flex: 0 0 86px; text-align: right; }
.neg { color: var(--bad); }
.pos { color: var(--ok); }
.c-id { flex: 0 0 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.c-holder { flex: 0 0 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-at { flex: 0 0 118px; }
.c-at2 { flex: 0 0 110px; }
.c-xyz { flex: 0 0 128px; }
.c-content { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.c-flag { flex: 0 0 150px; display: flex; gap: 4px; }
.c-reason { flex: 0 0 92px; }

.sub-body { padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
.bar { flex-wrap: wrap; }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--border); color: var(--fg-dim); }
.tag.ok { color: var(--ok); border-color: #2a4a2f; background: #12261a; }
.tag.warn { color: var(--warn); border-color: #4a3f1f; background: #26200f; }
.tag.plain { color: var(--fg-dim); }
.hint { font-size: 11px; line-height: 1.6; margin: 4px 0 0; }
</style>
