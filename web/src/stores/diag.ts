import { reactive, watch } from 'vue'
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

/**
 * ★★★ WEB-006（2026-11-06 深度检查）：**事件游标必须按 agent 分区**。
 *
 * 缺陷原貌：`pullEvents()` 拿 `diag.events` 的**最后一条 seq** 当 `since` 去请求，
 *   而 `diag.events` 是**全局一份**、里面装的是"当前 agent 的事件"。于是：
 *     · 从 A（已收到 seq=900）切到 B 时，仍然用 **900** 去问 B 的历史
 *       ⇒ B 的 1~900 条**全部漏掉**（报告实测：切 B 后用 A 的 900 请求，显示的还是 A 的事件）；
 *     · 同名进程重启后 seq 从 1 重新数，而游标还停在旧进程的 900
 *       ⇒ **永远拉不到新进程的任何事件**（报告实测：seq=2 仍持 900 游标）；
 *     · 切换过程中**迟到**的响应会写进当前（已经换了人的）视图。
 *
 * 修法：每个 agent 各自记游标；切换 agent 时清空视图并按该 agent 的游标重拉；
 *   请求发出时记下"这次是为谁拉的"，回来时归属不符就丢弃；
 *   若响应里出现比游标更小的 seq ⇒ 是**新进程**，从 0 重来。
 */
const cursors = new Map<string, number>()
/** 当前 `diag.events` 属于哪个 agent（空串 = 还没装载任何 agent）。 */
let eventsOwner = ''

/** 切到另一个 agent：清空派生视图（事件/任务/记忆都是"这个 bot 的"，不能跨人显示）。 */
function resetForAgent(name: string) {
  eventsOwner = name
  diag.events = []
  diag.taskState = null
  diag.memory = null
}

function addEvent(agentName: string, e: AgentEvent) {
  if (!e || typeof e !== 'object') return
  const cur = currentAgent.value?.name
  if (cur && agentName && agentName !== cur) return
  if (diag.paused) return
  // 视图还没对上当前 agent（例如刚切换、重拉还没回来）→ 先清掉别人的残留
  if (cur && eventsOwner !== cur) resetForAgent(cur)
  diag.events.push(e)
  if (cur) cursors.set(cur, Math.max(cursors.get(cur) ?? 0, e.seq))
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

  // ★ WEB-006：切换 agent 时按**该 agent 自己的**游标重拉，并清掉上一个 bot 的残留。
  watch(() => currentAgent.value?.name ?? '', (name, prev) => {
    if (name === prev) return
    if (!name) { resetForAgent(''); return }
    resetForAgent(name)
    void pullEvents()
  })
}

/**
 * ★★★ WEB-001 同源残留（R6 #18）：**断线时不许 emit**。
 *
 * 缺陷原貌：这里无条件 `(socket as any).emit(...)`。socket.io-client 在未连接时
 *   会把事件推进 `sendBuffer`；16 秒后这里 resolve 成 `{ok:false, reason:'超时'}`，
 *   而 `clearEvents()` 不看结果照样清本地视图 + 把游标归零；
 *   重连瞬间 `emitBuffered` 把排队的那条 `clear-events` **真发出去**
 *   ⇒ agent 的事件环形缓冲被清空 —— 恰好发生在"出问题了、想留证据"的时刻。
 *
 * 现在的口径（与 `api/socket.ts` 的 `request()` 对齐）：
 *   · 没连接 ⇒ 立刻 resolve `{ok:false, reason:'OFFLINE'}`，**根本不 emit**（进不了缓冲区）；
 *   · 调用方必须检查 `ok` 再改本地状态（见 clearEvents）。
 *
 * 为什么不直接用 `request()`：这里的事件是**诊断用**、失败要就地显示成
 * `diag.lastError`，不需要 `request()` 那套"结果未知"的语义；而且想保持
 * 16s 这个宽松超时（`get-task-state` 要读库）。
 */
type DiagAck<T> = T & { ok?: boolean; reason?: string }

function ack<T>(event: string, ...args: any[]): Promise<DiagAck<T>> {
  if (!socket.connected) {
    // ★ 关键：**先判连接再 emit**。emit 一次就等于把事件排进 sendBuffer。
    return Promise.resolve({ ok: false, reason: 'OFFLINE' } as DiagAck<T>)
  }
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

/** 补拉历史事件（按**该 agent 自己的** seq 增量） */
export async function pullEvents() {
  const a = currentAgent.value
  if (!a) return
  if (!socket.connected) {
    // 断线时补拉只会把 "get-events" 排进 sendBuffer，重连后迟到执行；这里直接跳过。
    diag.lastError = '未连接 mindserver：事件补拉已跳过'
    return
  }
  const owner = a.name
  const since = cursors.get(owner) ?? 0
  const res = await ack<{ ok: boolean; events: AgentEvent[]; reason?: string }>('get-events', owner, since)
  // ★ WEB-006：迟到的响应不能写进"已经换成别人"的视图里
  if (currentAgent.value?.name !== owner) return
  if (!res?.ok) { diag.lastError = res?.reason || '拉取事件失败'; return }
  const incoming = res.events || []
  // ★ 进程重启识别：同名 bot 的 seq 从 1 重新数 ⇒ 出现比游标更小的 seq 就是"新进程"，
  //   此时旧游标无效（否则永远拉不到新进程的事件）。从 0 重来。
  const restarted = incoming.some((e) => Number(e?.seq) < since)
  if (restarted) {
    console.warn(`[diag] ${owner} 的事件 seq 回退（${since} → 更小）：判定为进程重启，重置游标`)
    resetForAgent(owner)
  }
  if (eventsOwner !== owner) resetForAgent(owner)
  for (const e of incoming) {
    if (!diag.events.some(x => x.seq === e.seq)) diag.events.push(e)
    cursors.set(owner, Math.max(cursors.get(owner) ?? 0, Number(e?.seq) || 0))
  }
  diag.events.sort((x, y) => x.seq - y.seq)
  if (diag.events.length > MAX_EVENTS) diag.events.splice(0, diag.events.length - MAX_EVENTS)
}

export async function clearEvents() {
  const a = currentAgent.value
  if (!a) return
  const owner = a.name
  const r = await ack<{ ok: boolean; reason?: string }>('clear-events', owner)
  // ★ R6 #18：**只有服务端确认清掉了，才清本地视图与游标**。
  //   原来这里不看回执：断线时事件其实没发出去（或超时），本地却已经清空并
  //   把游标归零 —— 用户以为"没清掉"，而重连后那条排队的 clear-events 真的执行了。
  if (!r?.ok) {
    diag.lastError = r?.reason === 'OFFLINE'
      ? '未连接 mindserver：清空未执行（本地视图保留）'
      : `清空失败：${r?.reason || '未知原因'}（本地视图保留）`
    return
  }
  if (currentAgent.value?.name !== owner) return
  diag.events = []
  cursors.set(owner, 0)
  diag.lastError = ''
}

export async function fetchTaskState() {
  const a = currentAgent.value
  if (!a) return
  const owner = a.name
  diag.busy = true
  try {
    const r = await ack<TaskState>('get-task-state', owner)
    // ★ WEB-006：任务面板也是"这个 bot 的"，切换后迟到的响应一律丢弃
    if (currentAgent.value?.name !== owner) return
    diag.taskState = r
  } finally {
    diag.busy = false
  }
}

export async function fetchMemory() {
  const a = currentAgent.value
  if (!a) return
  const owner = a.name
  diag.busy = true
  try {
    const r = await ack<MemoryInfo>('get-memory', owner)
    // ★ WEB-006：记忆是"这个 bot 的"，切换后迟到的响应一律丢弃（否则会显示上一个 bot 的记忆）
    if (currentAgent.value?.name !== owner) return
    diag.memory = r
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
