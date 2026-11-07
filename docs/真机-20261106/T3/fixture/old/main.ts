// T3 / WEB-003 夹具（对照组）—— **不是产品代码**。
//
// 组件本体取自 `git show 22c41e8:web/src/components/ChatStream.vue`（修复提交 57499b7 之前），
// 只把 1 行 import 的相对路径改成本夹具能解析的位置，其它一字未动。
// 选它当对照的依据：面板**实际部署的** web/dist（13:05 构建）里那段被压成
//   function i(a){a.key==="Enter"&&!a.shiftKey&&(a.preventDefault(),r())}
// 与本文件的 onKey 完全同构 ⇒ 它在真浏览器里的表现就代表"修复前"的表现。
//
// 差异（同 current 夹具）：宿主页面是夹具；store.agents 预置 1 条 stub；服务端没有该 agent。
import { createApp, defineComponent, h } from 'vue'
import ChatStreamOld from './ChatStreamOld.vue'
import { store, initStore } from '../../../../../web/src/stores/agents'
import { socket } from '../../../../../web/src/api/socket'

const STUB = { name: 't3-stub', in_game: true, socket_connected: true, viewer_port: 0 }
const ensureStub = () => {
  if (!store.agents.some((a: any) => a.name === 't3-stub')) (store.agents as any[]).push(STUB as any)
}

ensureStub()
initStore()
socket.on('agents-status', () => { setTimeout(ensureStub, 0) })
const keepStub = setInterval(ensureStub, 200)
setTimeout(() => clearInterval(keepStub), 15000)

const Root = defineComponent({
  name: 'T3FixtureOld',
  render: () =>
    h('div', { style: 'height:100vh;display:flex;flex-direction:column;font:14px system-ui' }, [
      h('div', { style: 'flex:none;padding:6px 10px;background:#1f1f1f;color:#ddd;font-size:12px' },
        'T3 fixture · 修复前 ChatStream（git 22c41e8）—— 对照组'),
      h('div', { style: 'flex:1;min-height:0;display:flex' }, [h(ChatStreamOld)]),
    ]),
})

createApp(Root).mount('#app')

;(window as any).__t3store = store
