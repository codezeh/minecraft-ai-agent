import { reactive, computed } from 'vue'
import { socket, request, connect, emitControl, isOnline } from '../api/socket'
import type { AgentInfo, FullState, TerrainResult } from '../api/types'

export interface ChatLine {
  seq: number
  t: number
  kind: 'me' | 'her' | 'system'
  agent: string
  text: string
}

export interface OutputLine {
  seq: number
  t: number
  agent: string
  text: string
}

const MAX_CHAT = 500
const MAX_OUTPUT = 500

export const store = reactive({
  connected: false,
  everConnected: false,
  agents: [] as AgentInfo[],
  states: {} as Record<string, FullState>,
  current: '',
  chat: [] as ChatLine[],
  output: [] as OutputLine[],
  terrainCache: {} as Record<string, TerrainResult>,
  terrainLoading: false,
  lastError: '',
})

let seq = 0

/**
 * ★★★ WEB-002（2026-11-06 深度检查）：**状态入口必须先验协议**。
 *
 * 缺陷原貌：`state-update` 直接把收到的对象塞进 `store.states`。
 *   而服务端在"**首次** get-full-state 超时、又没有旧状态可发"时会发
 *   `{error: ...}` 这种**不是 FullState** 的载荷（报告 B 级证据确认了这条路径）。
 *   于是 `currentState` 拿到一个只有 `error` 字段的对象 ⇒
 *   `StatusCard` 的 `gameplay.health`、`InventoryGrid` 的 `inventory.counts` 取到 undefined
 *   ⇒ **TypeError，状态卡与背包整个渲染失败**（报告实测 healthPct/items 都抛）。
 *
 * 修法：在**边界**做一次形状校验 —— 形状不对的条目不进 `states`，
 *   把原因单独记到 `lastError`（界面能显示"状态还没拿到"），
 *   组件侧再各自做可选链兜底。这样"协议缺口"变成一句可读的提示，而不是一段崩栈。
 */
function isFullState(v: any): v is FullState {
  return !!v
    && typeof v === 'object'
    && v.gameplay && typeof v.gameplay === 'object'
    && typeof v.gameplay.health === 'number'      // 状态卡读它
    && v.inventory && typeof v.inventory === 'object'
    && v.inventory.counts && typeof v.inventory.counts === 'object'   // 背包读它
}

function sanitizeStates(raw: any): Record<string, FullState> {
  const out: Record<string, FullState> = {}
  if (!raw || typeof raw !== 'object') return out
  const bad: string[] = []
  for (const [name, st] of Object.entries(raw)) {
    if (isFullState(st)) out[name] = st
    else bad.push(name)
  }
  // 服务端"没有旧状态"时会把错误放在顶层（不是某个 agent 的 state 里）
  const topLevelError = (raw as any).error
  if (topLevelError) {
    store.lastError = '状态尚未就绪：' + String(topLevelError)
  } else if (bad.length) {
    store.lastError = `状态数据不完整（${bad.join(', ')}），已忽略；通常出现在首次 full_state 超时之后`
  }
  return out
}

export const currentAgent = computed(() => {
  const list = store.agents
  if (!list.length) return null
  return list.find(a => a.name === store.current) || list[0]
})

export const currentState = computed<FullState | null>(() => {
  const a = currentAgent.value
  if (!a) return null
  return store.states[a.name] || null
})

function pushChat(line: Omit<ChatLine, 'seq' | 't'>) {
  store.chat.push({ ...line, seq: ++seq, t: Date.now() })
  if (store.chat.length > MAX_CHAT) store.chat.splice(0, store.chat.length - MAX_CHAT)
}

function pushOutput(line: Omit<OutputLine, 'seq' | 't'>) {
  store.output.push({ ...line, seq: ++seq, t: Date.now() })
  if (store.output.length > MAX_OUTPUT) store.output.splice(0, store.output.length - MAX_OUTPUT)
}

let inited = false
export function initStore() {
  if (inited) return
  inited = true

  socket.on('connect', () => {
    store.connected = true
    store.everConnected = true
    store.lastError = ''
    // 每次（重）连接都要重新订阅；服务端侧不会重复计数同一条 socket。
    socket.emit('listen-to-agents')
  })

  socket.on('disconnect', () => {
    store.connected = false
    store.states = {}
    store.lastError = '与 mindserver 断开，正在重连…'
  })

  socket.on('connect_error', (e: Error) => {
    store.connected = false
    store.lastError = '连不上 mindserver(8080)：' + (e?.message || 'unknown')
  })

  socket.on('agents-status', (agents: AgentInfo[]) => {
    store.agents = Array.isArray(agents) ? agents : []
    if (!store.agents.some(a => a.name === store.current)) {
      store.current = store.agents[0]?.name || ''
    }
  })

  socket.on('state-update', (states: Record<string, FullState>) => {
    // 1 Hz 全量推送；这里按 agent 覆盖，字段级 diff 交给 Vue 的响应式。
    store.states = sanitizeStates(states)
  })

  // 她的输出（agent.js 的 sendOutputToServer）与系统消息都走这条
  socket.on('bot-output', (agentName: string, message: string) => {
    if (!message) return
    pushOutput({ agent: agentName, text: String(message) })
    pushChat({ kind: agentName === 'system' ? 'system' : 'her', agent: agentName, text: String(message) })
  })

  // bot 之间的对话
  socket.on('chat-message', (from: string, json: any) => {
    const text = json?.message
    if (text) pushChat({ kind: 'system', agent: from, text: `${from}: ${text}` })
  })

  connect()
}

export function selectAgent(name: string) {
  store.current = name
}

/** 发消息给她。旧面板同一条通路：send-message → agent.respondFunc */
export function say(text: string): boolean {
  const a = currentAgent.value
  const msg = text.trim()
  if (!a || !msg) return false
  // WEB-001：断线时不发（否则事件躺在 sendBuffer 里，重连后突然执行一条"迟到指令"）。
  const r = emitControl('send-message', a.name, { from: 'ADMIN', message: msg })
  if (!r.ok) {
    store.lastError = r.message
    return false
  }
  pushChat({ kind: 'me', agent: a.name, text: msg })
  return true
}

export async function agentAction(
  evt: 'start-agent' | 'stop-agent' | 'restart-agent' | 'destroy-agent',
): Promise<boolean> {
  const a = currentAgent.value
  if (!a) return false
  // WEB-001：启停/重启这类控制命令绝不能进了缓冲区等重连 ——
  // 报告实测过"界面报超时失败，重连后 server-stop 真的执行了"。
  const r = emitControl(evt, a.name)
  if (!r.ok) {
    store.lastError = r.message
    return false
  }
  return true
}

/**
 * 身份绑定 —— 面板侧入口（R4 t24）。
 *
 * ★ 这条链路原来**是断的**：mindserver 注册了 `identity-issue-code`，但 web/src 里
 *   对 identity/绑定/claim 的引用是 **0** —— 玩家永远拿不到码，`!claim` 永远失败，
 *   owner 永远不可达（叠加 t20 的 deny 默认 = 彻底锁死）。所以下面三个函数就是那座桥。
 *
 * 语义（与 mindserver 一致）：
 *   · 码 5 分钟内有效、**只能用一次**、**绑当前面板会话**（断开即作废未核销的码）；
 *   · 码只会出现在**签发的这一次回执**里（identity-status 不回码，免得被随手拉走）。
 */
export interface IssuedIdentityCode {
  ok: boolean
  agent?: string
  code?: string
  expiresAt?: number
  ttlMs?: number
  reason?: string
}

export interface IdentityBindingRow {
  uuid: string | null
  name: string | null
  level: string
  boundAt: number
  expiresAt: number
  expired: boolean
  /** t20：离线服按名字派生 uuid ⇒ 同名者可冒用（这叫弱绑定） */
  weak: boolean
}

/**
 * 当前"身份模式"（t27）—— 面板据此告诉用户他现在处在哪种状态：
 * 离线（uuid 由名字派生，owner 限时）还是正版验证（uuid 可信，owner 持久）。
 */
export interface IdentityMode {
  /** true=正版验证；false=离线；null=读不到 server.properties（按离线处理） */
  onlineMode: boolean | null
  source: string
  /** persistent | session | deny */
  effective: string
  uuidTrusted: boolean
  sessionMinutes: number
  reason: string
}

export interface IdentityStatus {
  ok: boolean
  agent?: string
  bindings?: IdentityBindingRow[]
  pendingCodes?: { expiresAt: number; sessionId: string | null }[]
  mode?: IdentityMode | null
  reason?: string
}

/** 面板点「生成绑定码」→ 拿一个一次性码。 */
export function issueIdentityCode(agentName = currentAgent.value?.name): Promise<IssuedIdentityCode> {
  if (!agentName) return Promise.reject(new Error('没有选中的 agent'))
  return request<IssuedIdentityCode>('identity-issue-code', agentName)
}

/** 查当前绑定与未核销的码（不含码本身）。 */
export function identityStatus(agentName = currentAgent.value?.name): Promise<IdentityStatus> {
  if (!agentName) return Promise.reject(new Error('没有选中的 agent'))
  return request<IdentityStatus>('identity-status', agentName)
}

/** 解绑（立刻生效，不需要重启）。 */
export function unbindIdentity(
  who: { uuid?: string | null; name?: string | null },
  agentName = currentAgent.value?.name,
): Promise<{ ok: boolean; removed?: number; reason?: string }> {
  if (!agentName) return Promise.reject(new Error('没有选中的 agent'))
  // mindserver 的签名是 (agentName, who, callback) —— request() 会把 callback 追加在最后
  return request('identity-unbind', agentName, who)
}

export async function refreshTerrain(opts: {
  mode?: 'around' | 'full'
  radius?: number
  lod?: number
} = {}): Promise<TerrainResult | null> {
  const a = currentAgent.value
  if (!a) return null
  /**
   * ★ WEB-001 同类残留（R4 §7-⑦，2026-11-07 第四轮审计）：**这条路径原来绕过了离线闸**。
   *
   * 缺陷原貌：`say()` / `agentAction()` 都改走 `emitControl()`（没连接就拒发），
   *   但 `refreshTerrain()` 里还是裸的 `socket.emit('request-terrain', …)`。
   *   `autoConnect:false` + 断线期间 socket.io 会把 emit **缓存**在 `socket.sendBuffer`：
   *   界面显示"超时(30s)"失败，重连那一刻这个请求会被真发出去 ——
   *   于是用户重连后地形被一条"早就失败了的旧请求"覆盖（和 WEB-001 的启停迟到执行同源）。
   *
   * 口径与 `emitControl` 一致：没连接 ⇒ **不发**，把"没发出去"如实告诉界面。
   * 为什么这里单独判而不是直接调 `emitControl()`：这里需要 ack + 自定义超时，
   * 而 `emitControl` 是"发了就不管"的语义（且它不接受 ack 回调）。
   */
  if (!isOnline()) {
    const reason = '未连接到 mindserver，地形请求没有发出'
    store.lastError = reason
    return { ok: false, reason }
  }
  store.terrainLoading = true
  try {
    const res = await new Promise<TerrainResult>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: '超时(30s)' }), 31000)
      socket.emit(
        'request-terrain',
        a.name,
        { mode: opts.mode || 'around', radius: opts.radius ?? 48, lod: opts.lod ?? 2 },
        (r: TerrainResult) => {
          clearTimeout(timer)
          resolve(r || { ok: false, reason: 'no response' })
        },
      )
    })
    if (res.ok) store.terrainCache[a.name] = res
    else store.lastError = '地形加载失败：' + (res.reason || 'unknown')
    return res
  } finally {
    store.terrainLoading = false
  }
}
