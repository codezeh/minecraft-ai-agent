<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue'
import { store, say, currentAgent } from '../stores/agents'

const input = ref('')
const listEl = ref<HTMLElement | null>(null)
const showOutput = ref(true)

function send() {
  const text = input.value.trim()
  if (!text) return
  say(text)
  input.value = ''
}

/**
 * ★ WEB-003（2026-11-06 深度检查）：中文/日文输入法组合期间的回车**不是发送**。
 *
 * 缺陷原貌：只判 `key === 'Enter'`。用中文输入法时，按回车是"确认候选词"，
 *   浏览器仍会派发 Enter（Chrome/Edge 里 `keyCode` 常是 229，且 `isComposing` 为 true），
 *   于是**消息在还没打完时就被发出去并清空输入框**，同时把 composition 的默认行为 preventDefault 掉。
 *
 * 修法：先看 "这次按键属于输入法组合吗" —— `isComposing` / `keyCode===229` /
 *   `key === 'Process'` 任一命中就**直接放行**（不 send、不 preventDefault），
 *   让 IME 自己处理；只有真正"组合已结束的 Enter"才发送。
 */
function isImeComposing(e: KeyboardEvent) {
  // 兼容：老浏览器没有 isComposing，用 keyCode 229 兜底（IME 处理中的保留码）
  return e.isComposing === true || e.keyCode === 229 || e.key === 'Process'
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  if (isImeComposing(e)) return   // ★ WEB-003：交给输入法，别抢
  e.preventDefault()
  send()
}

const kindClass: Record<string, string> = { me: 'me', her: 'her', system: 'sys' }

/** 用户是不是"本来就贴着底部"（贴底才自动跟随，否则会抢走正在读的历史）。 */
function isNearBottom(el: HTMLElement, slackPx = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slackPx
}

const pinnedToBottom = ref(true)
const unseenCount = ref(0)

function onScroll() {
  const el = listEl.value
  if (!el) return
  pinnedToBottom.value = isNearBottom(el)
  if (pinnedToBottom.value) unseenCount.value = 0
}

async function scrollToBottom() {
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
  unseenCount.value = 0
}

/**
 * ★ WEB-008（2026-11-06 深度检查）：不能用 `chat.length` 当"有新消息"的信号。
 *
 * 缺陷原貌：`watch(() => store.chat.length, scrollToBottom)`。
 *   而 store 里聊天缓冲**上限 500 条**（先 push 再截断）⇒ 到上限后 length 恒为 500，
 *   `watch` 回调**再也不会触发** ⇒ 长时间开着窗口就再也看不到新回复
 *   （报告实测：第 501 条到达时 length 仍 500、watch 回调 0 次）。
 *   另外它无条件滚到底，用户往上翻历史时会被抢回去。
 *
 * 修法：观察**最后一条的 seq**（单调递增，不受截断影响）；只在"原本贴底"时跟随，
 *   否则记未读数并在界面上给一个"回到最新"的按钮 —— 不打断正在读历史的人。
 */
watch(() => store.chat.length ? store.chat[store.chat.length - 1]?.seq : 0, async () => {
  if (pinnedToBottom.value) { await scrollToBottom(); return }
  unseenCount.value++
})
onMounted(scrollToBottom)

function time(t: number) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// bot-output 里混着她说话与各类日志，按关键词粗分一下，避免把日志当成人话
function isNoise(text: string) {
  return /^\[|ERROR|WARN|正在|扫描|pathfinder|Error/.test(text)
}
</script>

<template>
  <div class="chat">
    <div class="head">
      <span class="label">对话</span>
      <label class="toggle faint">
        <input v-model="showOutput" type="checkbox" />显示日志
      </label>
    </div>

    <div ref="listEl" class="list scroll" @scroll="onScroll">
      <div
        v-for="m in store.chat"
        :key="m.seq"
        class="line"
        :class="[kindClass[m.kind], { noise: m.kind === 'her' && !showOutput && isNoise(m.text) }]"
      >
        <span class="t faint num">{{ time(m.t) }}</span>
        <span class="who">{{ m.kind === 'me' ? '我' : m.kind === 'her' ? m.agent : '·' }}</span>
        <span class="text">{{ m.text }}</span>
      </div>
      <div v-if="!store.chat.length" class="faint empty">
        还没有对话。先说点什么，她在地图里会出现。
      </div>
    </div>

    <!-- ★ WEB-008：用户翻历史时新消息不抢滚动，改为提示 + 一键回到最新 -->
    <button v-if="unseenCount > 0" class="jump-latest" @click="scrollToBottom">
      ↓ {{ unseenCount }} 条新消息，回到最新
    </button>

    <div class="composer">
      <input
        v-model="input"
        type="text"
        :placeholder="currentAgent?.in_game ? '和她说话，或直接发 !命令…' : 'agent 离线，无法发送'"
        :disabled="!currentAgent?.in_game"
        spellcheck="false"
        @keydown="onKey"
      />
      <button class="primary" :disabled="!currentAgent?.in_game || !input.trim()" @click="send">发送</button>
    </div>
  </div>
</template>

<style scoped>
.chat { display: flex; flex-direction: column; min-height: 0; height: 100%; }

.head {
  flex: none; display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--border-soft);
}
.label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-dim); }
.toggle { font-size: 11px; display: flex; align-items: center; gap: 5px; cursor: pointer; }

.list { flex: 1; min-height: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; }

/* ★ WEB-008：新消息提示条（只有用户翻历史、又有新消息时才出现） */
.jump-latest {
  flex: none; margin: 0 12px 6px; padding: 5px 10px; font-size: 11px; cursor: pointer;
  color: var(--accent); background: rgba(90, 160, 255, .12);
  border: 1px solid rgba(90, 160, 255, .35); border-radius: 5px;
}
.jump-latest:hover { background: rgba(90, 160, 255, .2); }
.line { display: flex; gap: 7px; font-size: 12px; line-height: 1.5; }
.line .t { flex: none; font-size: 10px; padding-top: 2px; }
.line .who { flex: none; width: 46px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-dim); }
.line .text { flex: 1; word-break: break-word; white-space: pre-wrap; }

.line.me .who { color: var(--accent); }
.line.me .text { color: #cfe6ff; }
.line.her .who { color: #7ee787; }
.line.her .text { color: var(--fg); }
.line.sys .who, .line.sys .text { color: var(--fg-faint); font-size: 11px; }
.line.noise { display: none; }

.empty { font-size: 12px; padding: 8px 0; }

.composer {
  flex: none; display: flex; gap: 8px; padding: 9px 12px;
  border-top: 1px solid var(--border-soft); background: var(--bg-panel);
}
.composer input { flex: 1; }
</style>
