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
 * ★ WEB-001（2026-11-06 深度检查）：**断线时不许把事件塞进 sendBuffer**。
 *
 * 缺陷原貌：这里无条件 `socket.emit(...)`。`autoConnect: false` 且断线期间
 * socket.io 会把 emit 的事件**缓存**在 `socket.sendBuffer` 里；15 秒后界面报"超时失败"，
 * 但那个事件还在缓冲区 —— 一旦重连，`emitBuffered` 会把 **server-stop / restart-agent /
 * 游戏指令** 真发出去。用户看到"失败了"，几秒后服务却停了（或指令迟到执行、重复执行）。
 *
 * 现在的口径：
 *   1. 没连接 ⇒ 立即以 `OFFLINE` 拒绝，**不发**（因此也不可能进缓冲区）；
 *   2. 已发出但超时 ⇒ 以 `UNKNOWN_RESULT` 拒绝，文案明确"结果未知"，
 *      界面不许把它当"确定失败"去自动重试。
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

export type ControlResult = { ok: true } | { ok: false; code: RequestErrorCode; message: string }

/**
 * 发一个**有副作用**的事件（启停/重启/销毁 agent、给游戏发指令、关服…）。
 *
 * 与 `request()` 的区别：这类事件服务端不一定回 ack，所以这里只保证一件事 ——
 * **没连接时绝不发**，免得它躺在缓冲区里等重连后突然执行（WEB-001）。
 *
 * ★ #57：服务端对这类事件仍**不回 ack**，所以 `ok:true` 只代表"已从浏览器发出"，
 *   不代表"服务端执行了"。调用方必须显式呈现 pending/unknown 态并监听失败帧。
 *
 * @returns ok:false 时 `code:'OFFLINE'`，调用方应把"没执行"告诉用户，而不是静默吞掉。
 */
export function emitControl(event: string, ...args: any[]): ControlResult {
  if (!socket.connected) {
    return { ok: false, code: 'OFFLINE', message: '未连接到 mindserver，这条操作没有发出去：' + event }
  }
  socket.emit(event, ...args)
  return { ok: true }
}
