<script setup lang="ts">
/**
 * 面板侧「玩家身份绑定」入口（R4 t24）。
 *
 * ★ 为什么需要这个组件：mindserver 从 t13 起就有 `identity-issue-code` / `identity-status` /
 *   `identity-unbind` 三个事件，但**面板一个都没调用**（web/src 里 identity/绑定/claim 命中 0）。
 *   后果是玩家永远拿不到码 ⇒ 游戏里 `!claim` 永远失败 ⇒ owner 永远不可达
 *   （叠加 t20 的 `offline_owner_mode=deny` 默认，等于彻底锁死）。
 *   所以这里不是"锦上添花的 UI"，而是那条链路的**唯一入口**。
 *
 * 三条提示必须同时出现（少一条都会让人误判这套机制能干什么）：
 *   ① 下一步动作：游戏里 `!claim <码>`；
 *   ② 码的边界：5 分钟、只能用一次、面板断开即作废；
 *   ③ 离线服的限制：它只证明"此刻你能拿到面板"，**不能**证明游戏里那个同名的人是本人。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  currentAgent, issueIdentityCode, identityStatus, unbindIdentity,
  type IdentityBindingRow,
} from '../stores/agents'

const busy = ref(false)
const err = ref('')
const code = ref('')
const expiresAt = ref(0)
const now = ref(Date.now())
const bindings = ref<IdentityBindingRow[]>([])
const pending = ref<{ expiresAt: number; sessionId: string | null }[]>([])

let tick: ReturnType<typeof setInterval> | null = null

/** 剩余秒数（≤0 表示已过期）。 */
const remainSec = computed(() => {
  if (!expiresAt.value) return 0
  return Math.max(0, Math.ceil((expiresAt.value - now.value) / 1000))
})

const hasCode = computed(() => code.value !== '' && remainSec.value > 0)

const agentName = computed(() => currentAgent.value?.name || '')

function fmtTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function refresh() {
  if (!agentName.value) return
  try {
    const r = await identityStatus(agentName.value)
    if (r?.ok) {
      bindings.value = r.bindings || []
      pending.value = r.pendingCodes || []
      err.value = ''
    } else {
      err.value = humanize(r?.reason)
    }
  } catch (e: any) {
    err.value = String(e?.message || e)
  }
}

async function generate() {
  if (!agentName.value || busy.value) return
  busy.value = true
  err.value = ''
  try {
    const r = await issueIdentityCode(agentName.value)
    if (r?.ok && r.code) {
      code.value = r.code
      expiresAt.value = r.expiresAt || (Date.now() + (r.ttlMs || 300000))
      now.value = Date.now()
      await refresh()
    } else {
      code.value = ''
      expiresAt.value = 0
      err.value = humanize(r?.reason)
    }
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function unbind(row: IdentityBindingRow) {
  if (!agentName.value) return
  err.value = ''
  try {
    const r = await unbindIdentity({ uuid: row.uuid, name: row.name }, agentName.value)
    if (!r?.ok) err.value = humanize(r?.reason)
    await refresh()
  } catch (e: any) {
    err.value = String(e?.message || e)
  }
}

/** 把服务端的 reason 翻成能照做的人话（不是给开发者看的错误码）。 */
function humanize(reason?: string): string {
  const r = String(reason || '')
  if (r === 'panel_only') return '这条操作只允许从面板发起（agent 通道不能签发身份码）。'
  if (r === 'unknown_agent') return 'mindserver 里没有这个 agent（可能已被删除）。'
  if (r === 'rate_limited') return '太频繁了，等一分钟再试（防止刷出一堆码）。'
  if (r === 'need_uuid_or_name') return '解绑需要指定是哪个玩家。'
  if (!r) return '失败（服务端没有给出原因）'
  return r
}

function copyCode() {
  if (!code.value) return
  try { void navigator.clipboard?.writeText(code.value) } catch { /* 剪贴板不可用就算了，码就在眼前 */ }
}

onMounted(() => {
  tick = setInterval(() => { now.value = Date.now() }, 1000)
  void refresh()
})
onUnmounted(() => { if (tick) clearInterval(tick) })
</script>

<template>
  <div class="identity">
    <div class="head">
      <span class="label">玩家身份</span>
      <button class="tiny" :disabled="!agentName || busy" :title="'生成一个一次性绑定码，让玩家在游戏里 !claim'" @click="generate">
        {{ busy ? '生成中…' : '生成绑定码' }}
      </button>
    </div>

    <div v-if="err" class="bad small">{{ err }}</div>

    <!-- 码 + 倒计时 -->
    <div v-if="code" class="codebox" :class="{ dead: !hasCode }">
      <div class="code">{{ code }}</div>
      <div class="meta">
        <span v-if="hasCode">剩余 <b>{{ remainSec }}</b> 秒（{{ fmtTime(expiresAt) }} 失效）</span>
        <span v-else class="bad">已失效 —— 重新点「生成绑定码」</span>
        <button class="tiny ghost" @click="copyCode">复制</button>
      </div>
    </div>

    <!-- ★ 三条提示（缺一条就会让人误判这套机制的边界） -->
    <ol v-if="hasCode" class="hints">
      <li>在游戏里输入 <code>!claim {{ code }}</code>（大小写、连字符都无所谓）。</li>
      <li><b>5 分钟</b>内有效、<b>只能用一次</b>；这个面板连接一断，未用的码立刻作废。</li>
      <li class="warn">
        <b>离线服提醒</b>：码只能证明「此刻你能拿到这个面板」，<b>不能</b>证明游戏里那个同名的人是本人
        （离线服 uuid 由名字派生，同名即可冒充）。要真正防冒名，请开正版验证或装登录插件（如 AuthMe）。
      </li>
    </ol>

    <!-- 已绑定的人 -->
    <div class="bindings">
      <div class="sub">已绑定 {{ bindings.length }} 人<span v-if="pending.length" class="faint"> · {{ pending.length }} 个码待使用</span></div>
      <ul v-if="bindings.length">
        <li v-for="(b, i) in bindings" :key="b.uuid || b.name || i">
          <span class="who">{{ b.name || b.uuid }}</span>
          <span class="tag" :class="b.level">{{ b.level }}</span>
          <span v-if="b.weak" class="tag weak" title="离线服：uuid 由名字派生，同名者可冒充">弱绑定</span>
          <span v-if="b.expired" class="tag expired">已过期</span>
          <button class="tiny ghost" @click="unbind(b)">解绑</button>
        </li>
      </ul>
      <div v-else class="faint small">还没有人绑定。玩家拿到码后在游戏里 <code>!claim</code> 即可。</div>
    </div>
  </div>
</template>

<style scoped>
.identity { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.label { font-size: 12px; color: var(--text-dim); letter-spacing: .04em; }

.codebox { border: 1px solid var(--border-soft); border-radius: 6px; padding: 8px 10px; background: var(--bg-hover); }
.codebox.dead { opacity: .6; }
.code { font: 600 18px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
.meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; font-size: 11px; color: var(--text-dim); }

.hints { margin: 0; padding-left: 18px; font-size: 11px; line-height: 1.7; color: var(--text-dim); }
.hints code { background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; }
.hints .warn { color: var(--warn, #c9a227); }

.bindings { display: flex; flex-direction: column; gap: 4px; }
.sub { font-size: 11px; color: var(--text-dim); }
.bindings ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.bindings li { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.who { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--border-soft); }
.tag.owner { color: var(--ok, #4ade80); }
.tag.weak { color: var(--warn, #c9a227); }
.tag.expired { color: var(--bad, #f87171); }

button.tiny { font-size: 11px; padding: 2px 8px; }
button.tiny.ghost { background: transparent; border: 1px solid var(--border-soft); }
</style>
