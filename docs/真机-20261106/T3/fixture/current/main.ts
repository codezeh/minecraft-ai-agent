// T3 / WEB-003 夹具 —— **不是产品代码**：只 import 产品源码，web/src 一个字节都不改。
//
// 为什么必须有夹具：
//   面板的聊天框在 ConsoleView 里被 `v-if="!store.agents.length"` 挡住；本次环境面板 0 agent
//   （T1 的 bot 是裸 mineflayer，不经 mindserver）⇒ 部署页面上 ChatStream **根本不挂载**，
//   IME 键序无从触发。生产构建里 store 也摸不到（Vue 3.5 prod 的 setupState/_instance 都不暴露），
//   所以只能用一个最小宿主页面把**真实组件**挂起来。
//
// 与真实运行的差异，逐条写清楚：
//   ① 宿主页面是本夹具（不是产品 ConsoleView/路由）；
//   ② store.agents 由本夹具预置 1 条 stub（真实运行时由 mindserver 的 agents-status 推送）。
//      注意：initStore() 收到 agents-status 会把 store.agents **整体替换**成服务端数组（本次是空数组），
//      所以 stub 必须在它之后补回（实测第一版就被覆盖过）；
//   ③ 服务端没有这个 agent ⇒ 消息能到 socket.io，但被 mindserver 丢弃（客户端看不到回声）。
//   被验代码本身 = web/src/components/ChatStream.vue 原文。
import { createApp, defineComponent, h } from 'vue'
import ChatStream from '../../../../../web/src/components/ChatStream.vue'
import { store, initStore } from '../../../../../web/src/stores/agents'
import { socket } from '../../../../../web/src/api/socket'

const STUB = { name: 't3-stub', in_game: true, socket_connected: true, viewer_port: 0 }
const ensureStub = () => {
  if (!store.agents.some((a: any) => a.name === 't3-stub')) (store.agents as any[]).push(STUB as any)
}

ensureStub()
initStore()
// 必须排在 initStore 的处理器之后（它会把 store.agents 换成服务端数组）+ 短时轮询兜底
socket.on('agents-status', () => { setTimeout(ensureStub, 0) })
const keepStub = setInterval(ensureStub, 200)
setTimeout(() => clearInterval(keepStub), 15000)

const Root = defineComponent({
  name: 'T3FixtureCurrent',
  render: () =>
    h('div', { style: 'height:100vh;display:flex;flex-direction:column;font:14px system-ui' }, [
      h('div', { style: 'flex:none;padding:6px 10px;background:#1f1f1f;color:#ddd;font-size:12px' },
        'T3 fixture · 真实 ChatStream.vue（web/src 未改动）'),
      h('div', { style: 'flex:1;min-height:0;display:flex' }, [h(ChatStream)]),
    ]),
})

createApp(Root).mount('#app')

// 只读观测出口（给 CDP 侧读 socket 连接状态用）
;(window as any).__t3store = store
