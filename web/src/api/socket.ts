import { io, type Socket } from 'socket.io-client'

// 整页只允许一条连接：mindserver 按 socket 计数，重复 listen-to-agents 会重复起计时器。
// dev 走 vite proxy，prod 与页面同源，两种模式都不需要写死端口。
export const socket: Socket = io({
  path: '/socket.io',
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
})

export function connect() {
  if (!socket.connected) socket.connect()
}

export function disconnect() {
  if (socket.connected) socket.disconnect()
}

/** 现在能不能真的把事件发出去（没有连接时 socket.io 会把事件**存起来**，见下）。 */
export function isOnline(): boolean {
  return socket.connected === true
}

// ★ #66：token 失效时停止重连风暴，给用户明确出口（详见 docs/audit-r6/fixes2/web.md）。
export function pauseReconnect() {
  try { socket.io.opts.reconnection = false } catch { /* 老版本没有该字段 */ }
  try {
    if (socket.connected) socket.disconnect()
    else socket.io.engine?.close()
  } catch { /* 已断开 */ }
}

/** 恢复自动重连（用户点了"重试连接"，或带新 token 重新打开页面）。 */
export function resumeReconnect() {
  try { socket.io.opts.reconnection = true } catch { /* ignore */ }
  connect()
}

/** 界面上"重试连接"按钮的入口。 */
export function reconnectNow() {
  resumeReconnect()
}

/**
 * 请求失败的分类。界面据此决定"能不能重试"，不要一律说"失败了"。
 *
 * - `OFFLINE`        没连上，**事件根本没发出去** ⇒ 可以放心重试；
 * - `UNKNOWN_RESULT` 事件已经发出去了，只是没等到回执 ⇒ **结果未知**，
 *                    不能当成失败自动重试（可能已经执行了）。
 */
export type RequestErrorCode = 'OFFLINE' | 'UNKNOWN_RESULT'

export class RequestError extends Error {
  code: RequestErrorCode
  event: string
  constructor(code: RequestErrorCode, event: string, message: string) {
    super(message)
    this.name = 'RequestError'
    this.code = code
    this.event = event
  }
}

/**
 * 带超时的 ack 调用。
 *
 * ★ WEB-001：断线时不许把事件塞进 sendBuffer（重连会把旧命令真发出去）。
 * 所以：没连接立即以 `OFFLINE` 拒绝且**不 emit**；已发出但超时则以 `UNKNOWN_RESULT` 拒绝。
 */
export function request<T = any>(event: string, ...args: any[]): Promise<T> {
  const timeoutMs = 15000
  if (!socket.connected) {
    return Promise.reject(new RequestError('OFFLINE', event, '未连接到 mindserver，请求未发送：' + event))
  }
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new RequestError('UNKNOWN_RESULT', event, '请求已发出但没有回执，结果未知：' + event))
    }, timeoutMs)
    ;(socket as any).emit(event, ...args, (res: T) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(res)
    })
  })
}

/**
 * 只读请求（**无副作用**，t3 存档只读视图专用）。和 `request` 同一套 ack 形状，但超时可调：
 * 只读面板宁可早点说"服务端没有这个入口"，也不该让人盯着 12 秒转圈（超过 15s 会以为是网络卡）。
 * 断线仍然立即 `OFFLINE` 且**不 emit**（WEB-001 同口径）；发出后没回执 ⇒ `UNKNOWN_RESULT`。
 */
export function requestRead<T = any>(event: string, payload: any = {}, timeoutMs = 6000): Promise<T> {
  if (!socket.connected) {
    return Promise.reject(new RequestError('OFFLINE', event, '未连接到 mindserver，请求未发送：' + event))
  }
  const wait = Math.max(1000, Number(timeoutMs) || 6000)
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new RequestError('UNKNOWN_RESULT', event, '只读请求没有回执，结果未知：' + event))
    }, wait)
    ;(socket as any).emit(event, payload, (res: T) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(res)
    })
  })
}

/**
 * 控制面的失败码：服务端统一回这五个（RATE_LIMITED / PANEL_ONLY / UNKNOWN_AGENT /
 * NOT_RUNNING / NOT_IN_GAME），另外 start-agent 用 ALREADY_RUNNING；传输层是 OFFLINE /
 * UNKNOWN_RESULT；BAD_REQUEST 是服务端对畸形载荷的补充码。
 */
export type ControlErrorCode =
  | RequestErrorCode
  | 'RATE_LIMITED'
  | 'PANEL_ONLY'
  | 'UNKNOWN_AGENT'
  | 'NOT_RUNNING'
  | 'NOT_IN_GAME'
  | 'ALREADY_RUNNING'
  | 'BAD_REQUEST'

export type ControlResult =
  | { ok: true; [key: string]: any }
  | { ok: false; code: ControlErrorCode; message: string; retryAfterMs?: number }

/** 服务端 ack 只有 `{ok:true}`（可带字段）和 `{ok:false, code, message}` 两种形状。 */
const CONTROL_ACK_TIMEOUT_MS = 8000

function normalizeControlResult(res: any): ControlResult {
  if (res === true) return { ok: true }
  if (res && typeof res === 'object' && typeof res.ok === 'boolean') {
    if (res.ok) return { ...res, ok: true }
    return {
      ok: false,
      code: (res.code as ControlErrorCode) || 'UNKNOWN_RESULT',
      message: typeof res.message === 'string' && res.message ? res.message : '服务端拒绝了这条操作',
      retryAfterMs: typeof res.retryAfterMs === 'number' ? res.retryAfterMs : undefined,
    }
  }
  return { ok: false, code: 'UNKNOWN_RESULT', message: '已发出但回执无法识别，结果未知' }
}

/**
 * 发一个**有副作用**的事件（启停/重启/销毁 agent、给游戏发指令…），等 ack 才 resolve。
 *
 * 断线立即 `OFFLINE`（不发，见 WEB-001）；发出去 8 秒没回执只能报 `UNKNOWN_RESULT` ——
 * 调用方必须把结果如实显示给用户，且不许把"结果未知"当成确定失败去自动重试。
 */
export function emitControl(event: string, ...args: any[]): Promise<ControlResult> {
  if (!socket.connected) {
    return Promise.resolve({
      ok: false,
      code: 'OFFLINE',
      message: '未连接到 mindserver，这条操作没有发出去：' + event,
    })
  }
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (r: ControlResult) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    timer = setTimeout(() => {
      finish({ ok: false, code: 'UNKNOWN_RESULT', message: '已发出但没收到回执，结果未知' })
    }, CONTROL_ACK_TIMEOUT_MS)
    try {
      ;(socket as any).emit(event, ...args, (res: any) => finish(normalizeControlResult(res)))
    } catch (e: any) {
      finish({ ok: false, code: 'OFFLINE', message: '发送失败：' + (e?.message || String(e)) })
    }
  })
}
