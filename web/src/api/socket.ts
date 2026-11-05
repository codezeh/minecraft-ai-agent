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

/** 带超时的 ack 调用，避免界面无限转圈 */
export function request<T = any>(event: string, ...args: any[]): Promise<T> {
  const timeoutMs = 15000
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error('请求超时：' + event)) }
    }, timeoutMs)
    ;(socket as any).emit(event, ...args, (res: T) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(res)
    })
  })
}
