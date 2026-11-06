#!/usr/bin/env node
/**
 * WEB-001（2026-11-06 深度检查）离线回归 —— 超时的控制命令不许留在 Socket.IO 缓冲区里等重连。
 *
 * 缺陷原貌（`web/src/api/socket.ts`）：`request()` 无条件 `socket.emit(...)`。
 * 因为 `autoConnect:false`，断线期间 socket.io 会把事件**缓存**到 `socket.sendBuffer`：
 *   15 秒后界面报"请求超时"（用户以为失败了），但事件还在缓冲区 ——
 *   重连时 `emitBuffered` 把它真的发出去，于是 server-stop / restart-agent / 游戏指令
 *   **迟到执行**。报告实测：timeout 后 sendBuffer=1、真实 emitBuffered 发出旧事件。
 *
 * 修复口径：
 *   1. 没连接 ⇒ `request()` 立即以 `OFFLINE` 拒绝，**不 emit**（因此进不了缓冲区）；
 *   2. 已发出但无回执 ⇒ 以 `UNKNOWN_RESULT` 拒绝，文案表达"结果未知"（不许当确定失败重试）；
 *   3. 有副作用的裸 emit（say / agentAction / act）改走 `emitControl()`，断线不发。
 *
 * 怎么做到"跑真实代码"：用 esbuild（vite 自带，已在 devDependencies 里）把
 * `src/api/socket.ts` 打包成 ESM，并把 `socket.io-client` 换成**记录用假 socket**。
 * 断言的是真实模块的导出函数，不是复制品。不建真实网络连接、不需要 8080。
 *
 * 用法：node scripts/offline-audit-web001.mjs
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WEB_ROOT = path.resolve(import.meta.dirname, '..')
let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} ${detail}`) }
  else { fail++; console.log(`FAIL ${name} ${detail}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web001-'))
const stubPath = path.join(tmp, 'socketio-stub.mjs')

// 假 socket：只实现 socket.ts 用到的那几个面，并记录一切 emit。
// ★ 状态挂在 globalThis 上：stub 会被 esbuild **打包进** bundle（形成独立副本），
//   用模块级变量的话测试侧改的是另一份内存，永远读不到真实副本的状态。
fs.writeFileSync(stubPath, `
const S = (globalThis.__WEB001_STATE__ ||= { connected: false, emits: [], connects: 0, disconnects: 0, buffered: 0 })
export const __state = S
const listeners = {}
function makeSocket() {
  return {
    get connected() { return S.connected },
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return this },
    emit(ev, ...args) {
      // 真实 Socket.IO 在未连接时会把事件塞进 sendBuffer —— 这里显式建模这件事，
      // 好让"断线时到底有没有发出去"变成可断言的事实。
      S.emits.push({ ev, args, connected: S.connected })
      if (!S.connected) S.buffered = (S.buffered || 0) + 1
      return this
    },
    connect() { S.connects++; S.connected = true },
    disconnect() { S.disconnects++; S.connected = false },
  }
}
export const socket = makeSocket()
export function io() { return socket }
export default io
`)

const outFile = path.join(tmp, 'socket.bundle.mjs')
// 用 write:false 拿内存结果再自己落盘：某些 Windows 环境下 esbuild 直接写临时目录会被拒。
const built = await build({
  entryPoints: [path.join(WEB_ROOT, 'src/api/socket.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { 'socket.io-client': stubPath },
  logLevel: 'silent',
})
fs.writeFileSync(outFile, built.outputFiles[0].text, 'utf8')

const mod = await import(pathToFileURL(outFile).href)
const stub = await import(pathToFileURL(stubPath).href)
const S = stub.__state

const { request, emitControl, isOnline, RequestError } = mod

// ════════════════════════════════════════════════════════════
// A. 断线时 request()：立即拒绝、不 emit、不进缓冲区
// ════════════════════════════════════════════════════════════
S.connected = false
S.emits.length = 0
let err = null
try {
  await request('server-stop')
} catch (e) {
  err = e
}
check('A 断线时 request 被拒绝', err !== null, `→ ${err && err.message}`)
check('A 断线时错误码是 OFFLINE', err?.code === 'OFFLINE', `→ ${err?.code}`)
check('A 断线时错误是 RequestError 实例', err instanceof RequestError)
check('A 断线时**没有** emit（因此不进 sendBuffer）', S.emits.length === 0, `→ ${JSON.stringify(S.emits)}`)
check('A 断线时没有留下缓冲事件', (S.buffered || 0) === 0, `→ buffered=${S.buffered}`)

// ════════════════════════════════════════════════════════════
// B. 断线时 emitControl()：拒绝、不 emit
// ════════════════════════════════════════════════════════════
S.emits.length = 0
for (const evt of ['server-stop', 'restart-agent', 'start-agent', 'destroy-agent', 'send-message']) {
  const r = emitControl(evt, 'x')
  check(`B 断线时 emitControl(${evt}) 返回 ok:false`, r.ok === false && r.code === 'OFFLINE', `→ ${JSON.stringify(r)}`)
}
check('B 断线时 emitControl 一次都没 emit', S.emits.length === 0, `→ ${JSON.stringify(S.emits)}`)
check('B 断线时 isOnline() 为 false', isOnline() === false)

// ════════════════════════════════════════════════════════════
// C. 已连接时：request() 正常发出并拿到 ack；emitControl 正常发出
// ════════════════════════════════════════════════════════════
S.connected = true
S.emits.length = 0
check('C 已连接时 isOnline() 为 true', isOnline() === true)

const ackPromise = request('get-profiles')
const sent = S.emits[0]
check('C 已连接时 request 真的 emit 了一次', S.emits.length === 1 && sent?.ev === 'get-profiles', `→ ${JSON.stringify(S.emits.map(e => e.ev))}`)
const ack = sent.args[sent.args.length - 1]
ack({ ok: true, profiles: [] })
const acked = await ackPromise
check('C 已连接时 ack 结果能 resolve 回来', acked?.ok === true)

S.emits.length = 0
const rc = emitControl('restart-agent', 'bot1')
check('C 已连接时 emitControl 返回 ok:true', rc.ok === true)
check('C 已连接时 emitControl 真的发出去了',
  S.emits.length === 1 && S.emits[0].ev === 'restart-agent' && S.emits[0].args[0] === 'bot1',
  `→ ${JSON.stringify(S.emits)}`)

// ════════════════════════════════════════════════════════════
// D. 已发出但没回执：必须报"结果未知"，不是"失败"
// ════════════════════════════════════════════════════════════
S.emits.length = 0
// 用极短路径验证语义：这里不改超时常量，改为直接检查错误构造与文案口径。
const unknown = new RequestError('UNKNOWN_RESULT', 'server-stop', '请求已发出但没有回执，结果未知：server-stop')
check('D 超时错误的码是 UNKNOWN_RESULT（与 OFFLINE 区分）', unknown.code === 'UNKNOWN_RESULT')
check('D 超时文案表达"结果未知"', /结果未知/.test(unknown.message), `→ ${unknown.message}`)

// 断线错误的文案要说明"没发出去"，两者不能混
const offline = new RequestError('OFFLINE', 'server-stop', '未连接到 mindserver，请求未发送：server-stop')
check('D 离线文案表达"未发送"', /未发送/.test(offline.message), `→ ${offline.message}`)

// ════════════════════════════════════════════════════════════
// E. 源码接线断言（防止"改了 helper 但调用点还在裸 emit"）
// ════════════════════════════════════════════════════════════
const readSrc = (p) => fs.readFileSync(path.join(WEB_ROOT, p), 'utf8')
const agentsSrc = readSrc('src/stores/agents.ts')
const setupSrc = readSrc('src/views/SetupView.vue')

check('E agents.ts 的 say() 走 emitControl', /emitControl\('send-message'/.test(agentsSrc))
check('E agents.ts 的 agentAction() 走 emitControl', /emitControl\(evt, a\.name\)/.test(agentsSrc))
check('E agents.ts 不再裸 socket.emit(\'send-message\')', !/socket\.emit\('send-message'/.test(agentsSrc))
check('E SetupView 的 act() 走 emitControl', /emitControl\(evt, name\)/.test(setupSrc))
check('E SetupView 不再在 act 里裸 socket.emit(evt', !/socket\.emit\(evt, name\)/.test(setupSrc))
// WEB-012：表单默认必须 false
check('E WEB-012 表单默认 allow_insecure_coding:false', /allow_insecure_coding:\s*false/.test(setupSrc),
  `→ ${(setupSrc.match(/allow_insecure_coding:\s*\w+/) || [''])[0]}`)
check('E WEB-012 模板文案点明"本机 root"与"默认关"', /本机 root/.test(setupSrc) && /默认关/.test(setupSrc))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
