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
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  currentAgent, issueIdentityCode, identityStatus, unbindIdentity,
  issueRecoveryCode, revokeRecoveryCode, relinkAvatar,
  type IdentityBindingRow, type IdentityMode, type IdentityPersonRow, type IdentityRecoveryRow,
} from '../stores/agents'
import { humanize } from '../api/humanize'

const busy = ref(false)
const err = ref('')
const code = ref('')
const expiresAt = ref(0)
const now = ref(Date.now())
const bindings = ref<IdentityBindingRow[]>([])
// ★ t27：当前"离线 / 正版验证 + owner 策略"——用户在面板上就能看到自己处在哪种状态
const mode = ref<IdentityMode | null>(null)
const pending = ref<{ expiresAt: number; sessionId: string | null }[]>([])
// R6 #69/#74：身份表损坏（已 fail-closed 按空表处理）与"读不到模式"的原因
const corrupt = ref(false)
const backupPath = ref<string | null>(null)
const codesCorrupt = ref(false)
const codesBackupPath = ref<string | null>(null)
const modeError = ref<string | null>(null)
// ★ 决策 A：人表（people 权威）+ 恢复码
const people = ref<IdentityPersonRow[]>([])
const recoveries = ref<IdentityRecoveryRow[]>([])
const thisBotPerson = ref<{ id: string; name: string; state: string } | null>(null)
const peopleCorrupt = ref(false)
const peopleBackup = ref<string | null>(null)
const recCode = ref('')
const recExpiresAt = ref(0)

let tick: ReturnType<typeof setInterval> | null = null

/** 剩余秒数（≤0 表示已过期）。 */
const remainSec = computed(() => {
  if (!expiresAt.value) return 0
  return Math.max(0, Math.ceil((expiresAt.value - now.value) / 1000))
})

const hasCode = computed(() => code.value !== '' && remainSec.value > 0)

const agentName = computed(() => currentAgent.value?.name || '')

/** 恢复码剩余秒数（一次性码，过期就要重新生成）。 */
const recRemain = computed(() => {
  if (!recExpiresAt.value) return 0
  return Math.max(0, Math.ceil((recExpiresAt.value - now.value) / 1000))
})

/** 这个人手上还有几个未用的恢复码。 */
function recoveryCount(personId: string): number {
  return recoveries.value.filter((x) => x.person_id === personId).length
}

/** 面板「生成恢复码」：person 级一次性码，明文只在这一刻出现。 */
async function generateRecovery(p: IdentityPersonRow) {
  if (busy.value) return
  busy.value = true
  err.value = ''
  try {
    const r = await issueRecoveryCode(p.id)
    if (r?.ok && r.code) {
      recCode.value = r.code
      recExpiresAt.value = r.expiresAt || (Date.now() + (r.ttlMs || 0))
      now.value = Date.now()
      await refresh()
    } else {
      recCode.value = ''
      err.value = humanize(r?.reason)
    }
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function revokeRecovery(p: IdentityPersonRow) {
  busy.value = true
  err.value = ''
  try {
    const r = await revokeRecoveryCode(p.id)
    if (!r?.ok) err.value = humanize(r?.reason)
    await refresh()
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

/** 改挂：把当前 bot 挂到这个人名下（旧 avatar 记录退役）。 */
async function relink(p: IdentityPersonRow) {
  const owner = agentName.value
  if (!owner) return
  busy.value = true
  err.value = ''
  try {
    const r = await relinkAvatar(p.id, owner)
    if (currentAgent.value?.name !== owner) return
    if (!r?.ok) err.value = humanize(r?.reason)
    await refresh()
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

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
      mode.value = r.mode || null
      // 字段缺失一律当"正常"（旧服务端不发这两个字段，不能被当成损坏/异常）
      corrupt.value = r.corrupt === true
      backupPath.value = r.corrupt === true ? (r.backup ?? null) : null
      codesCorrupt.value = r.codesCorrupt === true
      codesBackupPath.value = r.codesCorrupt === true ? (r.codesBackup ?? null) : null
      modeError.value = r.modeError ?? null
      // 人表（旧服务端没有这些字段 ⇒ 一律当"空/正常"，不能误报损坏）
      people.value = r.people || []
      recoveries.value = r.recoveries || []
      thisBotPerson.value = r.thisBotPerson || null
      peopleCorrupt.value = r.peopleCorrupt === true
      peopleBackup.value = r.peopleCorrupt === true ? (r.peopleBackup ?? null) : null
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
  // #61：把"这次解绑属于谁"钉住；期间切了人就丢弃结果，别把 A 的结果写进 B 的视图
  const owner = agentName.value
  err.value = ''
  try {
    const r = await unbindIdentity({ uuid: row.uuid, name: row.name }, owner)
    if (currentAgent.value?.name !== owner) return
    if (!r?.ok) err.value = humanize(r?.reason)
    else if (!r.removed) err.value = '服务端没有删除任何记录（这个玩家可能本来就不在名单里）'
    await refresh()
  } catch (e: any) {
    err.value = String(e?.message || e)
  }
}

/** 当前模式的**人话**（含 owner 可达性）。 */
const modeText = computed(() => {
  const m = mode.value
  if (!m) return ''
  if (m.effective === 'persistent') return 'uuid 可信 ⇒ 绑定持久有效（owner 可达）'
  if (m.effective === 'session') return `uuid 由名字派生 ⇒ owner 仅在 !claim 后 ${m.sessionMinutes} 分钟内有效`
  return 'uuid 由名字派生 ⇒ 离线时 owner 不可达（只聊天）'
})

function copyCode() {
  if (!code.value) return
  try { void navigator.clipboard?.writeText(code.value) } catch { /* 剪贴板不可用就算了，码就在眼前 */ }
}

// #61：切 agent 时必须清空并重拉 —— 否则显示的是上一个 bot 的绑定/模式，
// 「解绑」还会把 A 的行发给 B（服务端 removed:0，界面却像成功了）。
watch(agentName, (name, prev) => {
  if (name === prev) return
  bindings.value = []
  pending.value = []
  mode.value = null
  corrupt.value = false
  backupPath.value = null
  codesCorrupt.value = false
  codesBackupPath.value = null
  modeError.value = null
  people.value = []
  recoveries.value = []
  thisBotPerson.value = null
  peopleCorrupt.value = false
  peopleBackup.value = null
  recCode.value = ''
  recExpiresAt.value = 0
  code.value = ''
  expiresAt.value = 0
  err.value = ''
  if (name) void refresh()
})

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

    <!-- ★ t27：当前模式（离线 / 正版验证）+ 生效的 owner 策略 -->
    <div v-if="mode" class="mode" :class="mode.onlineMode === true ? 'premium' : 'offline'">
      <span class="badge">{{ mode.onlineMode === true ? '正版验证' : '离线模式' }}</span>
      <span class="mode-text">{{ modeText }}</span>
    </div>
    <div v-if="mode && mode.onlineMode !== true" class="switch-hint">
      想切成正版验证（owner 持久、不可被同名冒用）：改
      <code>config/network.json</code> 的 <code>servers.main.onlineMode = true</code>
      → 跑 <code>node tools/server-net.mjs apply</code> → 重启 Minecraft 服务器。
    </div>

    <!-- R6 #69：身份表损坏必须说清"已按空表处理"，否则下面"0 个绑定"会被读成"没人绑过" -->
    <div v-if="codesCorrupt" class="corrupt small">
      <b>⚠ 绑定码表损坏</b>：已按<strong>空表</strong>处理，待用的绑定码全部不可用。
      <div v-if="codesBackupPath" class="bk">原文件已改名留证：<code>{{ codesBackupPath }}</code></div>
    </div>
    <div v-if="corrupt" class="corrupt small">
      <b>⚠ 身份表损坏</b>：已按<strong>空表</strong>处理（fail-closed，不会误授权）。
      <div v-if="backupPath" class="bk">原文件已改名留证：<code>{{ backupPath }}</code></div>
      <div class="bk">此时"0 个绑定"<b>不代表</b>没人绑定过，别据此判断权限。</div>
    </div>

    <!-- R6 #74：读不到身份策略时，别只留一个空白 -->
    <div v-if="modeError && !mode" class="bad small">
      读不到身份策略（离线/正版无法判断）：{{ modeError }}
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
      <div v-else-if="corrupt" class="faint small">
        绑定表不可读（见上方"身份表损坏"）—— 这不是"没有绑定"，别据此判断权限。
      </div>
      <div v-else class="faint small">还没有人绑定。玩家拿到码后在游戏里 <code>!claim</code> 即可。</div>
    </div>

    <!-- ★ 决策 A：人表（people 是权威 —— 这只 bot 归谁、谁邀请了谁、恢复码都在这里） -->
    <div class="people">
      <div class="sub">
        人表 {{ people.length }} 人
        <span v-if="thisBotPerson" class="faint"> · 这只分身归「{{ thisBotPerson.name }}」</span>
        <span v-else class="warn-tag"> · 这只分身还没挂到人 ⇒ 缓存里的权限不生效</span>
      </div>
      <div v-if="peopleCorrupt" class="corrupt small">
        <b>⚠ 人表（people）损坏</b>：已按空表 fail-closed 处理（不会误授权）。
        <div v-if="peopleBackup" class="bk">原文件已留证：<code>{{ peopleBackup }}</code></div>
      </div>
      <ul v-if="people.length">
        <li v-for="p in people" :key="p.id" class="person">
          <div class="prow">
            <span class="who">{{ p.name }}</span>
            <span class="tag" :class="p.state === 'active' ? 'owner' : 'expired'">
              {{ p.state === 'active' ? '已启用' : '已撤销' }}
            </span>
            <span v-if="p.aliases.length" class="faint">别名 {{ p.aliases.join(' / ') }}</span>
            <span v-if="p.invited_by" class="faint">· 邀请人 {{ p.invited_by }}</span>
          </div>
          <div class="prow faint">
            <span>分身：{{ p.avatars.length ? p.avatars.join('、') : '（无）' }}</span>
            <span v-if="p.retired_avatars.length">· 退役：{{ p.retired_avatars.join('、') }}</span>
          </div>
          <div class="prow">
            <button class="tiny ghost" :disabled="busy || p.state !== 'active'" @click="generateRecovery(p)">
              生成恢复码
            </button>
            <button class="tiny ghost" :disabled="busy || !recoveryCount(p.id)" @click="revokeRecovery(p)">
              作废恢复码
            </button>
            <button class="tiny ghost" :disabled="busy || p.state !== 'active'" @click="relink(p)">
              改挂到这只 bot
            </button>
            <span class="faint">{{ recoveryCount(p.id) }} 个恢复码未用</span>
          </div>
        </li>
      </ul>
      <div v-else class="faint small">人表还是空的：玩家 <code>!claim</code> 或你 <code>!invite</code> 之后这里会出现「人」。</div>
      <div v-if="recCode" class="codebox" :class="{ dead: recRemain <= 0 }">
        <div class="code">{{ recCode }}</div>
        <div class="meta">
          <span v-if="recRemain > 0">一次性恢复码，剩余 <b>{{ recRemain }}</b> 秒</span>
          <span v-else class="bad">已过期 —— 重新生成</span>
          <span class="faint">游戏里：<code>!recover {{ recCode }}</code></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.identity { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.label { font-size: 12px; color: var(--fg-dim); letter-spacing: .04em; }

.codebox { border: 1px solid var(--border-soft); border-radius: 6px; padding: 8px 10px; background: var(--bg-hover); }
.codebox.dead { opacity: .6; }
.code { font: 600 18px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
.meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; font-size: 11px; color: var(--fg-dim); }

.hints { margin: 0; padding-left: 18px; font-size: 11px; line-height: 1.7; color: var(--fg-dim); }
.hints code { background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; }
.hints .warn { color: var(--warn, #c9a227); }

.bindings { display: flex; flex-direction: column; gap: 4px; }
.sub { font-size: 11px; color: var(--fg-dim); }
.bindings ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.bindings li { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.who { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--border-soft); }
.tag.owner { color: var(--ok, #4ade80); }
.tag.weak { color: var(--warn, #c9a227); }
.tag.expired { color: var(--bad, #f87171); }

/* t27：模式徽标 */
.mode { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--border-soft); white-space: nowrap; }
.mode.premium .badge { color: var(--ok, #4ade80); }
.mode.offline .badge { color: var(--warn, #c9a227); }
.mode-text { color: var(--fg-dim); line-height: 1.5; }
.switch-hint { font-size: 10px; line-height: 1.6; color: var(--fg-dim); opacity: .85; }
.switch-hint code { background: var(--bg-hover); padding: 0 3px; border-radius: 2px; }

/* R6 #69：身份表损坏告警（比"错误"更重，要显眼且不误导） */
.corrupt {
  color: #ffd18a; background: #2a2110; border: 1px solid #4a3f1f;
  border-radius: 6px; padding: 6px 8px; line-height: 1.6;
}
.corrupt .bk { font-size: 10px; color: var(--fg-dim); margin-top: 3px; }
.corrupt code, .corrupt strong { color: #ffd18a; }

/* ★ 决策 A：人表（people 权威）—— 每行一个人，动作都是 person 级的 */
.people { display: flex; flex-direction: column; gap: 4px; }
.people ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.people li.person { display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
.prow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.warn-tag { color: var(--warn, #c9a227); }

button.tiny { font-size: 11px; padding: 2px 8px; }
button.tiny.ghost { background: transparent; border: 1px solid var(--border-soft); }
</style>
