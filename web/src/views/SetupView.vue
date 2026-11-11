<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { socket, request, emitControl } from '../api/socket'
import { store, selectAgent } from '../stores/agents'

// ---------- agent ----------
const busy = ref(false)
const settingsJson = ref('')
const selected = ref('')
const err = ref('')

async function loadSettings(name: string) {
  selected.value = name
  settingsJson.value = ''
  err.value = ''
  // #60：原来裸 emit 无超时/无离线判据 —— 回调不来就永远停占位文案，看起来像没点中。
  try {
    const res = await request<{ error?: string; settings?: any }>('get-settings', name)
    if (res?.error) { err.value = res.error; return }
    settingsJson.value = JSON.stringify(res?.settings ?? {}, null, 2)
  } catch (e: any) {
    err.value = '读取配置失败：' + (e?.message || String(e))
  }
}

// #65：高危操作两次点击确认（与 /vault 的删除一致），4 秒后自动复位
const confirmDestroy = ref('')
const confirmStop = ref(false)

function act(evt: string, name: string) {
  if (evt === 'destroy-agent' && confirmDestroy.value !== name) {
    confirmDestroy.value = name
    setTimeout(() => { if (confirmDestroy.value === name) confirmDestroy.value = '' }, 4000)
    return
  }
  if (evt === 'destroy-agent') confirmDestroy.value = ''
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
/** ★ WEB-009：create-agent 的 ack 超时（毫秒）。后端建 agent 要起子进程，给它 20 秒。 */
const CREATE_ACK_TIMEOUT_MS = 20000

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
  // #60：request() 在断线时立即以 OFFLINE 拒绝；原来没有 catch ⇒ 未处理拒绝 + 页面永远空白
  try {
    const r = await request<{ ok: boolean; profiles?: ProfileRow[]; dir?: string; reason?: string }>('get-profiles')
    if (!r?.ok) { profilesErr.value = r?.reason || '读取失败'; return }
    profiles.value = r.profiles || []
    profilesDir.value = r.dir || ''
  } catch (e: any) {
    profilesErr.value = '读取 profile 列表失败：' + (e?.message || String(e))
  }
}

async function pick(p: ProfileRow) {
  picked.value = p
  createMsg.value = ''
}

async function createAgent() {
  if (!picked.value) return
  creating.value = true
  createMsg.value = ''
  // ★★★ WEB-009（2026-11-06 深度检查）：**create-agent 必须有 ack 超时**。
  //
  //   缺陷原貌：这里 `socket.emit('create-agent', settings, cb)` 然后 `new Promise(resolve)`，
  //   resolve **只**在回调里被调用。断线 / 回调丢失 / 后端迟迟不回时：
  //     · 这个 Promise 永远 pending ⇒ `finally` 不执行 ⇒ `creating` 永远是 true
  //       （报告实测：creating=true 且 timeoutTimers=0）⇒ 按钮永久"创建中"，错误也不显示；
  //     · 用户以为卡死，刷新后重试 → 可能**重复创建**同名 agent。
  //
  //   修法（照报告"走统一 ack 超时 helper、超时显示结果未知并查询状态"）：
  //     · 给 ack 一个明确的超时；超时后如实告诉用户"结果未知"，并**主动查一次** agent 列表；
  //     · 补上 catch，任何异常都在界面上可见（原来 request 的 rejection 没人接）；
  //     · 无论如何都会走到 finally 把 creating 复位。
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  try {
    const pf = await request<{ ok: boolean; json?: any; reason?: string }>('get-profile', picked.value.file)
    if (!pf?.ok || !pf.json) { createMsg.value = '读 profile 失败：' + (pf?.reason || '?'); return }
    const settings = { ...form.value, profile: pf.json }
    const name = pf.json.name
    const ack = await new Promise<{ timedOut: boolean; res?: any }>((resolve) => {
      ackTimer = setTimeout(() => resolve({ timedOut: true }), CREATE_ACK_TIMEOUT_MS)
      socket.emit('create-agent', settings, (res: any) => resolve({ timedOut: false, res }))
    })
    if (ack.timedOut) {
      createMsg.value = `创建请求 ${CREATE_ACK_TIMEOUT_MS / 1000} 秒没有回应 —— **结果未知**，`
        + '正在重新读取 agent 列表确认（不要立刻重复创建）…'
      await new Promise((r) => setTimeout(r, 800))
      const seen = store.agents.some((a) => a.name === name)
      createMsg.value = seen
        ? `已确认 ${name} 创建成功（ack 丢了，但 agent 在列表里）`
        : `仍未看到 ${name}：可能创建失败，也可能后端还在处理。请稍等再刷新列表，别急着重复点。`
    } else {
      createMsg.value = ack.res?.success ? `已创建 ${name}` : `失败：${ack.res?.error || '未知错误'}`
    }
  } catch (e: any) {
    // 原来这里没有 catch：request 的 rejection 直接变成 unhandled，界面什么都不显示
    createMsg.value = '创建过程出错：' + (e?.message || String(e))
  } finally {
    if (ackTimer) clearTimeout(ackTimer)   // ★ 不留悬挂定时器
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
  // #60：断线时 request() 立即拒绝 —— 原来没 catch，徽标永远停在"未知"
  try {
    const r = await request<ServerStatus>('server-status')
    srv.value = r
    const l = await request<{ ok: boolean; lines?: string[] }>('server-log', 60)
    if (l?.ok) srvLog.value = l.lines || []
  } catch (e: any) {
    srvMsg.value = '读取 Paper 服务状态失败：' + (e?.message || String(e))
  }
}

async function srvAction(kind: 'start' | 'stop') {
  // #65：优雅停服一击即发太危险 —— 第一次点只进入确认态
  if (kind === 'stop' && !confirmStop.value) {
    confirmStop.value = true
    setTimeout(() => { confirmStop.value = false }, 4000)
    return
  }
  if (kind === 'stop') confirmStop.value = false
  srvBusy.value = true
  srvMsg.value = ''
  try {
    const r = await request<any>(kind === 'start' ? 'server-start' : 'server-stop')
    srvMsg.value = r?.ok
      ? (kind === 'start' ? `已启动 pid=${r.pid}（等 Done 出现才算就绪）` : '已发出优雅停止')
      : `失败：${r?.reason || '?'}${r?.hint ? ' — ' + r.hint : ''}`
    setTimeout(refreshServer, 1200)
  } catch (e: any) {
    // #60：原来只有 try/finally（没有 catch）⇒ 断线点"启动服务"完全没反应
    srvMsg.value = `操作失败：${e?.message || String(e)}`
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
        <div class="col-profiles scroll" role="radiogroup" aria-label="选择 profile">
          <!-- ★★★ WEB-011（2026-11-06 深度检查）：原来是**不可聚焦的 div**（只有 @click）。
               键盘用户 Tab 不到、Enter/空格也选不了 ⇒ 纯键盘与部分辅助技术用户
               **无法完成创建 agent 这条主流程**（报告静态断言确认：无 tabindex/无键盘处理/无原生控件）。
               修法：换成原生 `<button>`（天然可聚焦、Enter/空格可激活、可被读屏识别），
               并用 role="radio" + aria-checked 让"单选一个 profile"的语义对辅助技术可见。 -->
          <button
            v-for="p in profiles"
            :key="p.file"
            type="button"
            class="prof"
            role="radio"
            :aria-checked="picked?.file === p.file"
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
          </button>
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
          <button class="danger" :disabled="srvBusy" @click="srvAction('stop')">
            {{ confirmStop ? '确认停止？（再点一次）' : '优雅停止（RCON）' }}
          </button>
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
/* ★ WEB-011：现在是原生 button —— 必须清掉 button 的默认外观，否则和原来的 div 长得不一样；
   同时保留可见的焦点环（键盘用户要看得出"现在停在哪一项"）。 */
.prof {
  display: block; width: 100%; text-align: left; font: inherit; color: inherit;
  background: none; border: 0; border-bottom: 1px solid var(--border-soft);
  padding: 6px 9px; cursor: pointer;
}
.prof:hover { background: var(--bg-hover); }
.prof:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
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
