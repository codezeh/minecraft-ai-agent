import { reactive, computed } from 'vue'
import { socket, connect, emitControl } from '../api/socket'
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

export async function refreshTerrain(opts: {
  mode?: 'around' | 'full'
  radius?: number
  lod?: number
} = {}): Promise<TerrainResult | null> {
  const a = currentAgent.value
  if (!a) return null
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
