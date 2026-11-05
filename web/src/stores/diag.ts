import { reactive } from 'vue'
import { socket } from '../api/socket'
import { store, currentAgent } from './agents'

export interface AgentEvent {
  seq: number
  ts: number
  type: string
  [k: string]: any
}

export interface TaskState {
  ok: boolean
  reason?: string
  name?: string
  action?: { current: string; isIdle: boolean | null; executing: boolean }
  selfPrompter?: { stopped: boolean | null; paused: boolean | null; active: boolean | null; loopActive: boolean | null }
  task?: { present: boolean; name: string | null }
  modes?: string
  store?: { cells: number; chunks: number } | null
  activeFails?: number
  events?: { seq: number; size: number; max: number }
}

export interface MemoryInfo {
  ok: boolean
  reason?: string
  path?: string
  bytes?: number
  codeVersion?: number | null
  memory?: string | null
  turns?: number
}

const MAX_EVENTS = 400

export const diag = reactive({
  events: [] as AgentEvent[],
  paused: false,
  filter: '',
  taskState: null as TaskState | null,
  memory: null as MemoryInfo | null,
  busy: false,
  lastError: '',
})

let inited = false

function addEvent(agentName: string, e: AgentEvent) {
  if (!e || typeof e !== 'object') return
  const cur = currentAgent.value?.name
  if (cur && agentName && agentName !== cur) return
  if (diag.paused) return
  diag.events.push(e)
  if (diag.events.length > MAX_EVENTS) diag.events.splice(0, diag.events.length - MAX_EVENTS)
}

export function initDiag() {
  if (inited) return
  inited = true

  socket.on('agent-event', (agentName: string, e: AgentEvent) => addEvent(agentName, e))

  // 重连后补拉一次历史（事件是内存 ring buffer，断线期间会漏）
  socket.on('connect', () => {
    if (store.everConnected) void pullEvents()
  })
}

function ack<T>(event: string, ...args: any[]): Promise<T> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, reason: '超时' } as any) }
    }, 16000)
    ;(socket as any).emit(event, ...args, (r: T) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r ?? ({ ok: false, reason: '空响应' } as any))
    })
  })
}

/** 补拉历史事件（按 seq 增量） */
export async function pullEvents() {
  const a = currentAgent.value
  if (!a) return
  const since = diag.events.length ? diag.events[diag.events.length - 1].seq : 0
  const res = await ack<{ ok: boolean; events: AgentEvent[]; reason?: string }>('get-events', a.name, since)
  if (!res?.ok) { diag.lastError = res?.reason || '拉取事件失败'; return }
  for (const e of res.events || []) {
    if (!diag.events.some(x => x.seq === e.seq)) diag.events.push(e)
  }
  diag.events.sort((x, y) => x.seq - y.seq)
  if (diag.events.length > MAX_EVENTS) diag.events.splice(0, diag.events.length - MAX_EVENTS)
}

export async function clearEvents() {
  const a = currentAgent.value
  if (!a) return
  await ack('clear-events', a.name)
  diag.events = []
}

export async function fetchTaskState() {
  const a = currentAgent.value
  if (!a) return
  diag.busy = true
  try {
    diag.taskState = await ack<TaskState>('get-task-state', a.name)
  } finally {
    diag.busy = false
  }
}

export async function fetchMemory() {
  const a = currentAgent.value
  if (!a) return
  diag.busy = true
  try {
    diag.memory = await ack<MemoryInfo>('get-memory', a.name)
  } finally {
    diag.busy = false
  }
}

/** 事件类型 → 视觉分类（红=出问题，蓝=动作，灰=其余） */
export function eventTone(type: string): 'bad' | 'warn' | 'act' | 'plain' {
  if (/fail|unsafe|miss|timeout|error|stuck/i.test(type)) return 'bad'
  if (/oscillation|retry|interrupt/i.test(type)) return 'warn'
  if (/^action-/.test(type)) return 'act'
  return 'plain'
}

/** 把事件剩余字段压成一行 key=value */
export function eventDetail(e: AgentEvent): string {
  const skip = new Set(['seq', 'ts', 'type'])
  const parts: string[] = []
  for (const [k, v] of Object.entries(e)) {
    if (skip.has(k)) continue
    if (v === null || v === undefined) continue
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
    parts.push(`${k}=${val.length > 40 ? val.slice(0, 40) + '…' : val}`)
  }
  return parts.join(' ')
}
