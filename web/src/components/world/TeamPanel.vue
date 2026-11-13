<script setup lang="ts">
/**
 * 队伍只读视图（t3）：当前存档的队伍列表、成员、共享仓坐标，以及当前 bot 属于哪个队。
 * 只调 `team:list` / `team:chest-list`（服务端已有），没有任何写操作。
 */
import { computed, onMounted, watch } from 'vue'
import { currentAgent, store } from '../../stores/agents'
import { teamView, loadTeams, ensureClock } from '../../stores/world'
import { fmtTime } from '../../api/time'

const botName = computed(() => currentAgent.value?.name || '')

onMounted(() => {
  ensureClock()
  void loadTeams(botName.value)
})

// 顶部切换 bot ⇒ "本 bot 所在队"必须跟着变，否则会显示上一只 bot 的队伍（假信息）
watch(botName, (next, prev) => {
  if (next === prev) return
  teamView.chests = []
  teamView.chestPhase = 'idle'
  void loadTeams(next)
})

function refresh() { void loadTeams(botName.value) }

const roleText: Record<string, string> = { leader: '队长', member: '队员' }
function roleOf(r: string): string { return roleText[r] || r }

const phaseBox = computed(() => {
  if (teamView.phase === 'loading') return { tone: 'dim', text: '读取队伍…' }
  if (teamView.phase === 'not-wired') return { tone: 'warn', text: teamView.message }
  if (teamView.phase === 'error') return { tone: 'bad', text: teamView.message }
  return null
})
</script>

<template>
  <div class="wrap scroll">
    <div class="head">
      <h3>队伍</h3>
      <span class="faint small">
        存档 {{ teamView.worldId || '（未知）' }} · {{ teamView.teams.length }} 支
        <template v-if="botName"> · 当前 bot <b>{{ botName }}</b></template>
        <template v-else> · <b class="warn">面板还没选中 bot</b></template>
        <template v-if="!store.connected"> · <b class="bad">未连接 mindserver</b></template>
      </span>
      <div class="spacer" />
      <button :disabled="teamView.phase === 'loading' || !store.connected" @click="refresh()">刷新</button>
    </div>

    <div v-if="phaseBox" class="msg" :class="phaseBox.tone">{{ phaseBox.text }}</div>

    <div class="table" v-if="teamView.phase === 'ok'">
      <div class="thead">
        <span class="c-name">队名</span>
        <span class="c-mem">成员</span>
        <span class="c-chest">共享仓</span>
        <span class="c-by">创建者</span>
        <span class="c-at">建立时间</span>
      </div>
      <div v-for="t in teamView.teams" :key="t.id" class="trow" :class="{ mine: teamView.botTeam?.id === t.id }">
        <span class="c-name">
          <b>{{ t.name }}</b>
          <span v-if="teamView.botTeam?.id === t.id" class="tag ok">本 bot 在此</span>
          <span class="faint mono id">{{ t.id }}</span>
        </span>
        <span class="c-mem">
          <span v-for="m in t.members" :key="m.avatar_id" class="who" :title="'加入于 ' + fmtTime(m.joined_at)">
            {{ m.avatar_id }}<i class="faint">·{{ roleOf(m.role) }}</i>
          </span>
          <span v-if="!t.members.length" class="faint">没有成员</span>
        </span>
        <span class="c-chest num" :title="t.chests ? '坐标见下方（只有本队可见）' : '还没登记共享仓'">
          {{ t.chests }} 个
        </span>
        <span class="c-by mono">{{ t.created_by }}</span>
        <span class="c-at faint">{{ fmtTime(t.created_at) }}</span>
      </div>
      <div v-if="!teamView.teams.length" class="empty faint">
        这个存档里还没有队伍（不是"没读到"：服务端回了空列表）。
      </div>
    </div>

    <div class="panel sub">
      <div class="panel-title">本 bot 队伍的共享仓坐标</div>
      <div class="sub-body">
        <div v-if="teamView.chestPhase === 'loading'" class="faint small">读取共享仓…</div>
        <div v-else-if="teamView.chestPhase === 'not-wired'" class="msg warn small">{{ teamView.chestMessage }}</div>
        <div v-else-if="teamView.chestPhase === 'error'" class="msg bad small">{{ teamView.chestMessage }}</div>
        <template v-else>
          <div v-if="teamView.chests.length" class="chests">
            <span v-for="c in teamView.chests" :key="`${c.x},${c.y},${c.z}`" class="chest mono"
                  :title="`登记人 ${c.added_by || '-'} · ${fmtTime(c.added_at)}`">
              ({{ c.x }}, {{ c.y }}, {{ c.z }})
            </span>
          </div>
          <div v-else class="faint small">{{ teamView.chestMessage || '本队还没登记共享仓坐标' }}</div>
        </template>
      </div>
    </div>

    <p class="hint faint">
      只读：本页不建队/不加入/不登记坐标。共享仓坐标**只有队员能看**（服务端按成员判定），
      所以这里只展开当前 bot 所在队伍的坐标；其它队伍只显示登记数量。
      面板要以某只 bot 的身份读坐标，靠的是 `team:chest-list` 的 `bot` 参数（服务端裁决身份，
      面板侧无法自证，`online-mode=false` 下名字可自报 —— 这是已知边界）。
    </p>
  </div>
</template>

<style scoped>
.wrap { padding: var(--gap); display: flex; flex-direction: column; gap: 8px; height: 100%; overflow: auto; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head h3 { font-size: 14px; }
.spacer { flex: 1; }
.small { font-size: 11px; }
.warn { color: var(--warn); }
.bad { color: var(--bad); }

.msg { font-size: 12px; padding: 7px 10px; border-radius: 6px; }
.msg.dim { color: var(--fg-dim); background: var(--bg-panel); border: 1px solid var(--border-soft); }
.msg.warn { color: var(--warn); background: #26200f; border: 1px solid #4a3f1f; }
.msg.bad { color: var(--bad); background: #261212; border: 1px solid #4a2a2a; }

.table { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.thead, .trow { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 12px; }
.thead { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-faint);
         background: var(--bg); border-bottom: 1px solid var(--border-soft); }
.trow { border-bottom: 1px solid var(--border-soft); }
.trow:last-child { border-bottom: none; }
.trow.mine { background: #10202f; }
.c-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden; }
.c-name b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.id { font-size: 10px; opacity: .65; }
.c-mem { flex: 0 0 240px; display: flex; flex-wrap: wrap; gap: 4px; }
.who { font-size: 11px; padding: 0 5px; border-radius: 9px; background: var(--bg-elev); border: 1px solid var(--border); }
.who i { font-style: normal; margin-left: 3px; font-size: 10px; }
.c-chest { flex: 0 0 62px; }
.c-by { flex: 0 0 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-at { flex: 0 0 120px; }
.empty { padding: 12px; font-size: 12px; }

.sub { margin-top: 4px; }
.sub-body { padding: 8px 12px; }
.chests { display: flex; flex-wrap: wrap; gap: 6px; }
.chest { font-size: 11px; padding: 1px 7px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--border); color: var(--fg-dim); }
.tag.ok { color: var(--ok); border-color: #2a4a2f; background: #12261a; }
.hint { font-size: 11px; line-height: 1.6; margin: 4px 0 0; }
</style>
