<script setup lang="ts">
/**
 * #68：任务板最小入口。
 * 只要求"能看到板、能取消/重试"；建单/编辑/共享数据不在本条范围内。
 */
import { onMounted, onUnmounted } from 'vue'
import { board, visibleJobs, openJobs, refreshBoard, cancelJob, retryJob, canCancel, canRetry, initBoard } from '../stores/board'
import { store } from '../stores/agents'
import { humanize } from '../api/humanize'

const TONE: Record<string, string> = {
  pending: 'warn', ready: 'info', claimed: 'act', running: 'act',
  paused: 'warn', blocked: 'bad', done: 'ok', failed: 'bad', cancelled: 'plain',
}

function argsText(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

onMounted(() => {
  initBoard()
  board.watching = true
  void refreshBoard()
})

onUnmounted(() => { board.watching = false })
</script>

<template>
  <div class="board scroll">
    <div class="head">
      <h2>任务板</h2>
      <span class="faint small">
        未终结 {{ openJobs.length }} 张 · 共加载 {{ board.jobs.length }} 张
        <template v-if="!store.connected"> · <b class="bad">未连接 mindserver</b></template>
      </span>
      <div class="spacer" />
      <label class="faint small"><input v-model="board.openOnly" type="checkbox" @change="refreshBoard()" />只看未终结</label>
      <input v-model="board.filterText" class="filter" placeholder="过滤 id / skill / state…" spellcheck="false" />
      <button :disabled="board.loading || !store.connected" @click="refreshBoard()">
        {{ board.loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <div v-if="board.error" class="msg bad">{{ humanize(board.error) }}</div>
    <div v-if="board.notice" class="msg ok">{{ board.notice }}</div>

    <div class="table">
      <div class="thead">
        <span class="c-id">id</span>
        <span class="c-state">状态</span>
        <span class="c-skill">skill / 参数</span>
        <span class="c-who">assignee</span>
        <span class="c-num">优先级</span>
        <span class="c-num">尝试</span>
        <span class="c-act">操作</span>
      </div>
      <div v-for="j in visibleJobs" :key="j.id" class="trow">
        <span class="c-id mono" :title="j.id">{{ j.id }}</span>
        <span class="c-state"><span class="tag" :class="TONE[j.state] || 'plain'">{{ j.state }}</span></span>
        <span class="c-skill">
          <b>{{ j.skill || j.title || '-' }}</b>
          <span class="faint">{{ argsText(j.args) }}</span>
        </span>
        <span class="c-who mono">{{ j.assignee || (j.lease?.owner ? '租:' + j.lease.owner : '共享') }}</span>
        <span class="c-num num">{{ j.priority ?? '-' }}</span>
        <span class="c-num num">{{ j.attempts ?? 0 }}</span>
        <span class="c-act">
          <button class="mini" :disabled="!canRetry(j) || board.busy[j.id]" title="放回 ready 让调度器重新领"
                  @click="retryJob(j)">重试</button>
          <button class="mini danger" :disabled="!canCancel(j) || board.busy[j.id]" title="置为 cancelled（终态）"
                  @click="cancelJob(j)">取消</button>
        </span>
      </div>
      <div v-if="!visibleJobs.length" class="empty faint">
        {{ board.loading ? '读取中…' : '板是空的（或没有满足过滤条件的单）。' }}
      </div>
    </div>

    <p class="hint faint">
      「重试」= 把 blocked/paused/被抢占的单放回 ready；「取消」= 置为终态 cancelled（不可撤销）。
      done/failed/cancelled 是终态，按钮已禁用 —— 要重做请新建单（本页不做建单）。
    </p>
  </div>
</template>

<style scoped>
.board { padding: var(--gap); height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head h2 { font-size: 15px; }
.spacer { flex: 1; }
.filter { width: 200px; }
.small { font-size: 11px; }
.bad { color: #ffb4ae; }

.msg { font-size: 12px; padding: 7px 10px; border-radius: 6px; }
.msg.bad { color: var(--bad); background: #261212; border: 1px solid #4a2a2a; }
.msg.ok { color: var(--ok); background: #12261a; border: 1px solid #2a4a2f; }

.table { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.thead, .trow { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12px; }
.thead { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-faint);
         background: var(--bg); border-bottom: 1px solid var(--border-soft); }
.trow { border-bottom: 1px solid var(--border-soft); }
.trow:last-child { border-bottom: none; }
.c-id { flex: 0 0 116px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-state { flex: 0 0 78px; }
.c-skill { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
.c-skill b, .c-skill span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-who { flex: 0 0 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-num { flex: 0 0 52px; text-align: right; }
.c-act { flex: 0 0 118px; display: flex; gap: 4px; justify-content: flex-end; }
.mono { font-family: var(--mono); }
.mini { font-size: 11px; padding: 1px 7px; }

.tag { font-size: 10px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--border); color: var(--fg-dim); }
.tag.ok { color: var(--ok); border-color: #2a4a2f; background: #12261a; }
.tag.bad { color: var(--bad); border-color: #4a2a2a; background: #261212; }
.tag.warn { color: var(--warn); border-color: #4a3f1f; background: #26200f; }
.tag.info { color: var(--accent); border-color: #1f3a5f; background: #10202f; }
.tag.act { color: #a5d6ff; border-color: #1f3a5f; background: #0d2036; }
.empty { padding: 12px; font-size: 12px; }
.hint { font-size: 11px; line-height: 1.6; margin: 0; }
</style>
