<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { socket, request, emitControl } from '../api/socket'
import { store, selectAgent } from '../stores/agents'

// ---------- agent ----------
const busy = ref(false)
const settingsJson = ref('')
const selected = ref('')
const err = ref('')

function loadSettings(name: string) {
  selected.value = name
  settingsJson.value = ''
  err.value = ''
  socket.emit('get-settings', name, (res: any) => {
    if (res?.error) { err.value = res.error; return }
    settingsJson.value = JSON.stringify(res?.settings ?? {}, null, 2)
  })
}

function act(evt: string, name: string) {
  // WEB-001：启停/重启/销毁是**有副作用**的控制命令，断线时绝不能 emit
  // （socket.io 会把事件存进 sendBuffer，重连后突然执行 —— 实测过 server-stop 迟到执行）。
  const r = emitControl(evt, name)
  if (!r.ok) { err.value = r.message; return }
  busy.value = true
  setTimeout(() => { busy.value = false }, 800)
}

// ---------- profile ----------
interface ProfileRow {
  file: string; path: string; name?: string; api?: string; model?: string
  url?: string; bytes?: number; error?: string
}
const profiles = ref<ProfileRow[]>([])
const profilesDir = ref('')
const picked = ref<ProfileRow | null>(null)
const profilesErr = ref('')
const creating = ref(false)
const createMsg = ref('')

// 只暴露真正常改的几项（其余走 settings_spec 默认值）
const form = ref({
  host: '127.0.0.1',
  port: 25565,
  minecraft_version: '1.21.8',
  base_profile: 'assistant',
  init_message: '用中文回复 hello world 和你的名字',
  // ★ WEB-012（2026-11-06 深度检查）：默认 **false**，与后端 settings_spec 的安全默认一致。
  //   原来这里写 true，等于"用户在面板上点创建"就静默把模型写/运行本机代码打开，
  //   而命令行启动的 bot 是 false —— 同一个产品两个默认值，其中一个等于本机 root。
  allow_insecure_coding: false,
  max_messages: 30,
  spawn_timeout: 60,
  load_memory: true,
})

async function loadProfiles() {
  profilesErr.value = ''
  const r = await request<{ ok: boolean; profiles?: ProfileRow[]; dir?: string; reason?: string }>('get-profiles')
  if (!r?.ok) { profilesErr.value = r?.reason || '读取失败'; return }
  profiles.value = r.profiles || []
  profilesDir.value = r.dir || ''
}

async function pick(p: ProfileRow) {
  picked.value = p
  createMsg.value = ''
}

async function createAgent() {
  if (!picked.value) return
  creating.value = true
  createMsg.value = ''
  try {
    const pf = await request<{ ok: boolean; json?: any; reason?: string }>('get-profile', picked.value.file)
    if (!pf?.ok || !pf.json) { createMsg.value = '读 profile 失败：' + (pf?.reason || '?'); return }
    const settings = { ...form.value, profile: pf.json }
    await new Promise<void>((resolve) => {
      socket.emit('create-agent', settings, (res: any) => {
        createMsg.value = res?.success ? `已创建 ${pf.json.name}` : `失败：${res?.error || '未知错误'}`
        resolve()
      })
    })
  } finally {
    creating.value = false
  }
}

// ---------- paper 服务 ----------
interface ServerStatus {
  ok: boolean
  status?: string
  listening?: boolean
  externallyStarted?: boolean
  pid?: number | null
  uptimeMs?: number
  ready?: boolean
  exitCode?: number | null
  error?: string
  port?: number
  rcon?: { enabled: boolean; port: number; hasPassword: boolean }
  serverDir?: string
  jar?: string | null
  java?: string
  reason?: string
  hint?: string
}
const srv = ref<ServerStatus | null>(null)
const srvLog = ref<string[]>([])
const srvBusy = ref(false)
const srvMsg = ref('')

async function refreshServer() {
  const r = await request<ServerStatus>('server-status')
  srv.value = r
  const l = await request<{ ok: boolean; lines?: string[] }>('server-log', 60)
  if (l?.ok) srvLog.value = l.lines || []
}

async function srvAction(kind: 'start' | 'stop') {
  srvBusy.value = true
  srvMsg.value = ''
  try {
    const r = await request<any>(kind === 'start' ? 'server-start' : 'server-stop')
    srvMsg.value = r?.ok
      ? (kind === 'start' ? `已启动 pid=${r.pid}（等 Done 出现才算就绪）` : '已发出优雅停止')
      : `失败：${r?.reason || '?'}${r?.hint ? ' — ' + r.hint : ''}`
    setTimeout(refreshServer, 1200)
  } finally {
    srvBusy.value = false
  }
}

function uptime(ms?: number) {
  if (!ms) return '-'
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

const srvBadge = computed(() => {
  const s = srv.value
  if (!s?.ok) return { cls: 'bad', text: '未知' }
  if (s.listening && s.externallyStarted) return { cls: 'warn', text: '外部启动（start.bat）' }
  if (s.status === 'running') return { cls: 'ok', text: '运行中' }
  if (s.status === 'starting') return { cls: 'warn', text: '启动中…' }
  if (s.status === 'stopping') return { cls: 'warn', text: '停止中…' }
  return { cls: 'bad', text: '未运行' }
})

onMounted(() => {
  void loadProfiles()
  void refreshServer()
})
</script>

<template>
  <div class="setup">
    <!-- Agent -->
    <section class="panel">
      <div class="panel-title">Agent</div>
      <div class="list">
        <div v-for="a in store.agents" :key="a.name" class="row-item">
          <span class="name">{{ a.name }}</span>
          <span class="badge" :class="a.in_game ? 'ok' : 'bad'">{{ a.in_game ? '在线' : '离线' }}</span>
          <span class="faint small">viewer {{ a.viewerPort ?? '-' }}</span>
          <div class="spacer" />
          <button :disabled="busy || a.in_game" @click="act('start-agent', a.name)">启动</button>
          <button :disabled="busy || !a.in_game" @click="act('stop-agent', a.name)">停止</button>
          <button :disabled="busy" @click="act('restart-agent', a.name)">重启</button>
          <button :disabled="busy" @click="loadSettings(a.name)">设置</button>
          <button :disabled="busy" class="danger" @click="act('destroy-agent', a.name)">删除</button>
          <button @click="selectAgent(a.name)">选中</button>
        </div>
        <div v-if="!store.agents.length" class="faint small pad">还没有 agent</div>
      </div>
      <div class="pane scroll inner">
        <pre v-if="settingsJson">{{ settingsJson }}</pre>
        <div v-else-if="err" class="bad small pad">{{ err }}</div>
        <div v-else class="faint small pad">点「设置」读某个 agent 的完整配置（只读）。</div>
      </div>
    </section>

    <!-- 新建 agent -->
    <section class="panel">
      <div class="panel-title">
        新建 Agent
        <span class="faint small" v-if="profilesDir">· {{ profilesDir }}</span>
      </div>

      <div class="cols">
        <div class="col-profiles scroll">
          <div
            v-for="p in profiles"
            :key="p.file"
            class="prof"
            :class="{ on: picked?.file === p.file }"
            @click="pick(p)"
          >
            <div class="pfile">{{ p.file }}</div>
            <div class="faint small">
              <span v-if="p.error" class="bad">{{ p.error }}</span>
              <template v-else>
                name={{ p.name }} · {{ p.api }} · {{ p.model }}
              </template>
            </div>
          </div>
          <div v-if="profilesErr" class="bad small pad">{{ profilesErr }}</div>
        </div>

        <div class="col-form">
          <div class="grid2">
            <label>host<input v-model="form.host" /></label>
            <label>port<input v-model.number="form.port" type="number" /></label>
            <label>MC 版本<input v-model="form.minecraft_version" /></label>
            <label>
              base_profile
              <select v-model="form.base_profile">
                <option>survival</option><option>assistant</option>
                <option>creative</option><option>god_mode</option>
              </select>
            </label>
            <label>max_messages<input v-model.number="form.max_messages" type="number" /></label>
            <label>spawn_timeout<input v-model.number="form.spawn_timeout" type="number" /></label>
          </div>
          <label class="wide">init_message<input v-model="form.init_message" /></label>
          <div class="checks">
            <label
              title="允许模型写并运行任意 JS，等于把本机 root 权限交给模型。只有你主动勾选才开启。"
            ><input v-model="form.allow_insecure_coding" type="checkbox" />allow_insecure_coding（= 本机 root，默认关）</label>
            <label><input v-model="form.load_memory" type="checkbox" />load_memory</label>
          </div>
          <div class="row">
            <button class="primary" :disabled="!picked || creating" @click="createAgent">
              {{ creating ? '创建中…' : `用 ${picked?.file || '选中的 profile'} 创建` }}
            </button>
            <button @click="loadProfiles">刷新列表</button>
          </div>
          <div v-if="createMsg" class="small" :class="createMsg.startsWith('已') ? 'ok-text' : 'bad'">{{ createMsg }}</div>
        </div>
      </div>
    </section>

    <!-- paper 服务 -->
    <section class="panel">
      <div class="panel-title">
        Paper 服务
        <span class="badge" :class="srvBadge.cls" style="margin-left:8px">{{ srvBadge.text }}</span>
      </div>

      <div class="srv">
        <div class="kv-grid">
          <div class="k">端口</div>
          <div class="v num">{{ srv?.port }} · RCON {{ srv?.rcon?.port }}
            <span class="faint">({{ srv?.rcon?.enabled ? 'enabled' : 'disabled' }}
              · {{ srv?.rcon?.hasPassword ? 'has-password' : 'NO-password' }})</span>
          </div>

          <div class="k">进程</div>
          <div class="v num">{{ srv?.pid ? 'pid=' + srv.pid : '未托管' }}</div>

          <div class="k">已运行</div>
          <div class="v num">{{ uptime(srv?.uptimeMs) }}</div>

          <div class="k">jar</div>
          <div class="v faint small">{{ srv?.jar || '未找到 server.jar' }}</div>

          <div class="k">java</div>
          <div class="v faint small">{{ srv?.java }}</div>
        </div>

        <div class="row">
          <button class="primary" :disabled="srvBusy" @click="srvAction('start')">启动服务</button>
          <button class="danger" :disabled="srvBusy" @click="srvAction('stop')">优雅停止（RCON）</button>
          <button :disabled="srvBusy" @click="refreshServer">刷新</button>
        </div>
        <div v-if="srvMsg" class="small" :class="srvMsg.startsWith('已') ? 'ok-text' : 'bad'">{{ srvMsg }}</div>
        <div class="tip faint">
          停止只走 RCON <code>stop</code>，不强杀（强杀有存档损坏风险）。若服是 start.bat 起的，
          这里能看状态但停不了——那是外部进程，我不碰。
        </div>

        <div class="pane scroll log">
          <pre>{{ srvLog.length ? srvLog.join('\n') : '（还没有日志；启动后这里会有真实输出）' }}</pre>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.setup {
  display: flex; flex-direction: column; gap: var(--gap);
  padding: var(--gap); height: 100%; min-height: 0; overflow: auto;
}
.panel-title { display: flex; align-items: center; }
.list { display: flex; flex-direction: column; }
.row-item { display: flex; align-items: center; gap: 7px; padding: 8px 12px; border-bottom: 1px solid var(--border-soft); }
.row-item:last-child { border-bottom: none; }
.name { font-weight: 600; }
.spacer { flex: 1; }
.small { font-size: 11px; }
.pad { padding: 10px 12px; }
.bad { color: #ffb4ae; }
.ok-text { color: var(--ok); }

.pane { min-height: 0; overflow: auto; background: var(--bg); border: 1px solid var(--border-soft); border-radius: 6px; }
.pane.inner { margin: 10px 12px; max-height: 200px; }
pre { margin: 0; padding: 8px 10px; font-size: 11px; line-height: 1.5; color: #a5d6ff; white-space: pre-wrap; }

.cols { display: grid; grid-template-columns: 300px 1fr; gap: 12px; padding: 10px 12px; }
.col-profiles { max-height: 240px; border: 1px solid var(--border-soft); border-radius: 6px; }
.prof { padding: 6px 9px; border-bottom: 1px solid var(--border-soft); cursor: pointer; }
.prof:hover { background: var(--bg-hover); }
.prof.on { background: var(--bg-elev); box-shadow: inset 2px 0 0 var(--accent); }
.pfile { font-size: 12px; }

.col-form { display: flex; flex-direction: column; gap: 8px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
.grid2 label, .wide { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--fg-dim); }
.checks { display: flex; gap: 14px; font-size: 11px; color: var(--fg-dim); }
.checks label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.srv { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.kv-grid { display: grid; grid-template-columns: 70px 1fr; gap: 4px 10px; font-size: 12px; }
.kv-grid .k { color: var(--fg-faint); }
.tip { font-size: 11px; line-height: 1.6; }
.tip code { background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; }
.log { max-height: 240px; }

@media (max-width: 900px) {
  .cols { grid-template-columns: 1fr; }
}
</style>
