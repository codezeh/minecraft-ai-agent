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

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

const kindClass: Record<string, string> = { me: 'me', her: 'her', system: 'sys' }

async function scrollToBottom() {
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

// 只在新消息到达时滚到底，用户往回翻历史时不打扰
watch(() => store.chat.length, scrollToBottom)
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

    <div ref="listEl" class="list scroll">
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
