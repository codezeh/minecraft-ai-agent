import { reactive, computed } from 'vue'
import { socket, request, connect, emitControl, isOnline, pauseReconnect } from '../api/socket'
import { humanizeControl } from '../api/humanize'
import type { AgentInfo, FullState, TerrainResult } from '../api/types'

export interface ChatLine {
  seq: number
  t: number
  kind: 'me' | 'her' | 'system'
  agent: string
  text: string
  /** ★ #57：服务端无 ack ⇒ 只能区分"已发出"与"已知失败"，不能假装"已送达"。 */
  state?: 'pending' | 'sent' | 'failed'
  reason?: string
}

export interface OutputLine {
  seq: number
  t: number
  agent: string
  text: string
}

const MAX_CHAT = 500
// #64：输出日志与对话是两份独立缓冲（不再互挤容量），输出留得更久便于排障。
const MAX_OUTPUT = 1000

export const store = reactive({
  connected: false,
  everConnected: false,
  /** #58：断开后 agents 只是"上一次看到的"，界面不许再把它当在线。 */
  agentsStale: false,
  agents: [] as AgentInfo[],
  states: {} as Record<string, FullState>,
  /** #63：最后一帧状态的到达时刻（0 = 从未收到）。 */
  statesAt: 0,
  /** #63：每秒刷新一次，供"数据已过期 Ns"使用。 */
  now: Date.now(),
  current: '',
  chat: [] as ChatLine[],
  output: [] as OutputLine[],
  /** #64：断线期间可能有消息丢失（界面据此插一条分隔提示）。 */
  chatGap: false,
  /** #62：是否收到过 state-update（= 服务端确实把我们放进了订阅集合）。 */
  subscribed: false,
  /** #62：订阅可能失败时的说明（限流/无回执）。 */
  subscribeError: '',
  /** #57：已发出但未确认的控制动作，key = `${agent}:${event}`。 */
  pendingActions: {} as Record<string, { event: string; at: number }>,
  /** #57：最近一次控制失败帧（按 agent 记，供卡片就地显示）。 */
  actionError: {} as Record<string, string>,
  /** #66：握手 token 失效（不再无脑重连）。 */
  authFailed: false,
  terrainCache: {} as Record<string, TerrainResult>,
  terrainLoading: false,
  lastError: '',
  /** #63：lastError 是否可关闭（临时错误不该挂一整天）。 */
  lastErrorAt: 0,
})

let seq = 0

/** #63：统一写错误（带时间戳），临时错误可被成功响应清掉。 */
export function setError(msg: string) {
  store.lastError = msg
  store.lastErrorAt = Date.now()
}

export function dismissError() {
  store.lastError = ''
  store.lastErrorAt = 0
}

/** #63：距最后一帧状态多久（毫秒；从没收到过 = Infinity）。 */
export const stateAgeMs = computed(() =>
  store.statesAt ? Math.max(0, store.now - store.statesAt) : Infinity,
)

/** 超过这个年龄的状态一律视为过期，界面不再显示为"健康/在线"。 */
export const STALE_AFTER_MS = 5000

export const dataStale = computed(() =>
  !store.connected || store.agentsStale || stateAgeMs.value > STALE_AFTER_MS,
)

// #64：把最近的消息落到 sessionStorage —— 刷新页面不再清空，断线也有上下文。
const PERSIST_KEY = 'mindcraft-panel:history-v1'
let persistTimer: ReturnType<typeof setTimeout> | null = null

function persistHistory() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      sessionStorage.setItem(PERSIST_KEY, JSON.stringify({
        chat: store.chat.slice(-200),
        output: store.output.slice(-200),
        gap: store.chatGap,
      }))
    } catch { /* 隐私模式/配额满：不持久化，不影响主流程 */ }
  }, 400)
}

// #62：listen-to-agents 无 ack，且被限流时服务端直接 return。只能"看有没有状态帧"反推：
// 连上后迟迟没有 state-update ⇒ 视为可能未订阅，退避重试并把状态显式化。
let subTimer: ReturnType<typeof setTimeout> | null = null
let subAttempt = 0

function armSubscribeWatch(delayMs = 12000) {
  if (subTimer) clearTimeout(subTimer)
  subTimer = setTimeout(() => {
    subTimer = null
    if (!store.connected || store.subscribed) return
    subAttempt += 1
    if (subAttempt > 3) {
      store.subscribeError = '仍然收不到状态更新：可能被服务端限流（10 次/60 秒）或 relay 未注册。请稍后点「重试订阅」。'
      return
    }
    socket.emit('listen-to-agents')
    store.subscribeError = `未收到状态更新，正在重新订阅（第 ${subAttempt} 次）…`
    armSubscribeWatch(5000 * subAttempt)
  }, delayMs)
}

function stopSubscribeWatch() {
  if (subTimer) { clearTimeout(subTimer); subTimer = null }
}

/** 手动重试订阅（#62 的出口，DebugView / 横幅用）。 */
export function retrySubscribe() {
  if (!store.connected) return
  stopSubscribeWatch()
  subAttempt = 0
  store.subscribed = false
  store.subscribeError = ''
  socket.emit('listen-to-agents')
  armSubscribeWatch()
}

function restoreHistory() {
  try {
    const raw = sessionStorage.getItem(PERSIST_KEY)
    if (!raw) return
    const d = JSON.parse(raw)
    if (Array.isArray(d?.chat)) store.chat = d.chat
    if (Array.isArray(d?.output)) store.output = d.output
    store.chatGap = d?.gap === true
    seq = Math.max(0, ...store.chat.map((c: ChatLine) => Number(c.seq) || 0),
      ...store.output.map((o: OutputLine) => Number(o.seq) || 0))
  } catch { /* 坏数据当成没有 */ }
}

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
    && typeof v.gameplay.health === 'number'
    && v.gameplay.position && typeof v.gameplay.position === 'object'
    && v.inventory && typeof v.inventory === 'object'
    && v.inventory.counts && typeof v.inventory.counts === 'object'
    && v.inventory.equipment && typeof v.inventory.equipment === 'object'
    && typeof v.inventory.stacksUsed === 'number'
    && v.action && typeof v.action === 'object'
    && v.nearby && typeof v.nearby === 'object'
    && Array.isArray(v.nearby.humanPlayers)
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
    setError('状态尚未就绪：' + String(topLevelError))
  } else if (bad.length) {
    setError(`状态数据不完整（${bad.join(', ')}），已忽略；通常出现在首次 full_state 超时之后`)
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

function pushChat(line: Omit<ChatLine, 'seq' | 't'>): number {
  const row: ChatLine = { ...line, seq: ++seq, t: Date.now() }
  store.chat.push(row)
  if (store.chat.length > MAX_CHAT) store.chat.splice(0, store.chat.length - MAX_CHAT)
  persistHistory()
  return row.seq
}

function pushOutput(line: Omit<OutputLine, 'seq' | 't'>): number {
  const row: OutputLine = { ...line, seq: ++seq, t: Date.now() }
  store.output.push(row)
  if (store.output.length > MAX_OUTPUT) store.output.splice(0, store.output.length - MAX_OUTPUT)
  persistHistory()
  return row.seq
}

/** #57：把某条"我发的"消息从 pending 落成 sent / failed。 */
function settleChat(chatSeq: number, state: 'sent' | 'failed', reason = '') {
  const row = store.chat.find(c => c.seq === chatSeq)
  if (!row) return
  row.state = state
  if (reason) row.reason = reason
  persistHistory()
}

let inited = false
export function initStore() {
  if (inited) return
  inited = true

  // #64：刷新页面后把最近的消息接回来（不依赖服务端重放）
  restoreHistory()
  // #63：1 Hz 心跳，驱动"数据已过期 Ns"（只是本地时钟，不碰服务端）
  setInterval(() => { store.now = Date.now() }, 1000)

  socket.on('connect', () => {
    store.connected = true
    store.everConnected = true
    store.agentsStale = false
    store.authFailed = false
    store.subscribed = false
    store.subscribeError = ''
    dismissError()
    // 每次（重）连接都要重新订阅；服务端侧不会重复计数同一条 socket。
    socket.emit('listen-to-agents')
    armSubscribeWatch()
  })

  socket.on('disconnect', () => {
    store.connected = false
    // #58：列表只是"上次看到的" —— 不清空，但必须失效，否则面板继续显示"在线"。
    store.agentsStale = true
    store.states = {}
    store.statesAt = 0
    store.subscribed = false
    store.chatGap = true
    store.pendingActions = {}
    // #57：还在"发送中"的消息不可能再被确认了，落成失败（不要永远转圈）
    for (const c of store.chat) {
      if (c.state === 'pending') { c.state = 'failed'; c.reason = '发送后连接断开' }
    }
    stopSubscribeWatch()
    setError('与 mindserver 断开，正在重连…')
  })

  socket.on('connect_error', (e: any) => {
    store.connected = false
    store.agentsStale = true
    const code = e?.data?.code
    if (code === 'AUTH_REQUIRED' || code === 'AUTH_BAD_TOKEN') {
      store.authFailed = true
      setError('握手 token 已失效：mindserver 重启会换 token。请用新值重新打开 '
        + `http://${location.hostname}:8080/?token=<mindcraft/.mindserver-token 里的值>`)
      pauseReconnect()   // 不再 0.5s 一次地刷重连
      return
    }
    setError('连不上 mindserver(8080)：' + (e?.message || 'unknown'))
  })

  // #57：服务端四类失败帧（原来前端一个都没监听 ⇒ 控制命令"点了没反应也不知道"）。
  const onFail = (evt: string) => (p: any) => {
    const name = String(p?.agent || store.current || '')
    const reason = String(p?.reason || '服务端拒绝，未给出原因')
    store.actionError[name] = `${evt} 失败：${reason}`
    delete store.pendingActions[`${name}:${evt}`]
    if (name === store.current || !name) setError(`${name || 'agent'} ${evt} 失败：${reason}`)
    pushChat({ kind: 'system', agent: name || 'system', text: `${evt} 失败：${reason}` })
  }
  socket.on('start-agent-failed', onFail('start-agent'))
  socket.on('destroy-agent-failed', onFail('destroy-agent'))
  socket.on('agent-channel-rejected', onFail('agent-channel-rejected'))
  socket.on('agent-channel-taken-over', (p: any) => {
    const name = String(p?.agent || store.current || '')
    store.actionError[name] = '「' + name + '」的 agent 通道已被另一次连接接管'
    setError('「' + name + '」的 agent 通道已被接管（可能是另一个面板/进程）')
  })

  socket.on('agents-status', (agents: AgentInfo[]) => {
    store.agents = Array.isArray(agents) ? agents : []
    store.agentsStale = false
    // 列表回来了 = 这条连接是活的；此前"已发起未确认"的控制动作可以收尾。
    store.pendingActions = {}
    store.actionError = {}
    if (!store.agents.some(a => a.name === store.current)) {
      store.current = store.agents[0]?.name || ''
    }
  })

  socket.on('state-update', (states: Record<string, FullState>) => {
    // 1 Hz 全量推送；这里按 agent 覆盖，字段级 diff 交给 Vue 的响应式。
    store.states = sanitizeStates(states)
    store.statesAt = Date.now()
    store.now = Date.now()
    // #62：能收到状态帧 ⇒ 订阅确实生效了，清掉"可能未订阅"的告警。
    if (!store.subscribed) {
      store.subscribed = true
      store.subscribeError = ''
      stopSubscribeWatch()
    }
    // #63：状态帧持续到达 = 链路确实活着 ⇒ 15 秒前的临时错误自动消失（不再挂一整天）
    if (store.lastError && store.lastErrorAt && Date.now() - store.lastErrorAt > 15000) {
      dismissError()
    }
  })

  // 她的输出（agent.js 的 sendOutputToServer）与系统消息都走这条
  socket.on('bot-output', (agentName: string, message: string) => {
    if (!message) return
    pushOutput({ agent: agentName, text: String(message) })
    // 系统消息进对话流；bot 的输出也进（日志行由 ChatStream 的开关折叠）
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
export async function say(text: string): Promise<boolean> {
  const a = currentAgent.value
  const msg = text.trim()
  if (!a || !msg) return false
  if (store.connected && a.in_game && !store.agentsStale) {
    // 在线且确认在游戏里：往下走
  } else {
    setError('未连接或 agent 不在游戏里：这条消息没有发出去')
    return false
  }
  // WEB-001：断线时不发（否则事件躺在 sendBuffer 里，重连后突然执行一条"迟到指令"）。
  const r = await emitControl('send-message', a.name, { from: 'ADMIN', message: msg })
  if (!r.ok) {
    setError(humanizeControl(r.code, r.message))
    return false
  }
  // 现在服务端有 ack：拿到 ok 就是"已交给 agent 通道"，不用再靠 2.5 秒后猜。
  pushChat({ kind: 'me', agent: a.name, text: msg, state: 'sent' })
  return true
}

export async function agentAction(
  evt: 'start-agent' | 'stop-agent' | 'restart-agent' | 'destroy-agent',
): Promise<boolean> {
  const a = currentAgent.value
  if (!a) return false
  // WEB-001：启停/重启这类控制命令绝不能进了缓冲区等重连 ——
  // 报告实测过"界面报超时失败，重连后 server-stop 真的执行了"。
  const key = `${a.name}:${evt}`
  if (store.pendingActions[key]) return false   // #65：连点不再重复下发
  const r = await emitControl(evt, a.name)
  if (!r.ok) {
    setError(humanizeControl(r.code, r.message))
    return false
  }
  // ack 已经回答了"服务端执行了没"；这里的 pending 只是短时按钮锁，防止连点。
  store.pendingActions[key] = { event: evt, at: Date.now() }
  delete store.actionError[a.name]
  setTimeout(() => { delete store.pendingActions[key] }, 3000)
  return true
}

/** #57：查询某 agent 某个动作是否在飞行中（界面用来加锁/显示"已发起…"）。 */
export function isActionPending(agent: string, evt: string): boolean {
  return !!store.pendingActions[`${agent}:${evt}`]
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
  /** R6 #74：读身份策略失败的原因（mode 为 null 时才可能有值）。 */
  modeError?: string | null
  /** R6 #69：身份表损坏（已按空表 fail-closed 处理）；缺失时视为 false。 */
  corrupt?: boolean
  /** 损坏时原文件的留证路径（<path>.corrupt-<ts>）。 */
  backup?: string | null
  /** 码表（identity-codes.json）损坏；口径与 corrupt 一致。 */
  codesCorrupt?: boolean
  /** 码表损坏时的留证路径。 */
  codesBackup?: string | null
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
