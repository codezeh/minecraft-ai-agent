<script setup lang="ts">
import { ref, computed } from 'vue'
import { say, currentState } from '../stores/agents'

// 快捷指令条：后端已有 60+ 个 !命令，这里只放最常用的几个。
//
// ★ 参数语法：**必须用双引号**。命令解析器的正则只认
//   数字 / true / false / "双引号字符串"（src/agent/commands/index.js:commandRegex），
//   单引号会被整段丢弃 → 报 "missing param 'type'"，实测踩过。
const player = ref('')

const nearbyPlayer = computed(() => {
  const list = currentState.value?.nearby?.humanPlayers || []
  return list[0] || ''
})

const targetPlayer = computed(() => player.value.trim() || nearbyPlayer.value)

function fire(cmd: string) {
  say(cmd)
}

const quick = computed(() => [
  { label: '停下', cmd: '!stop', hint: '立刻中止所有动作' },
  { label: '就地待命', cmd: '!stay(-1)', hint: '原地不动直到解除' },
  {
    label: '过来',
    cmd: `!goToPlayer("${targetPlayer.value}")`,
    hint: '走到指定玩家身边（需要玩家名）',
    disabled: !targetPlayer.value,
  },
  {
    label: '跟着我',
    cmd: `!followPlayer("${targetPlayer.value}", 3)`,
    hint: '持续跟随（陪伴核心）',
    disabled: !targetPlayer.value,
  },
  { label: '砍木头 ×4', cmd: '!collectBlocks("木头", 4)', hint: '采集最近的木头（类别=所有原木）' },
  { label: '砍橡木 ×8', cmd: '!collectBlocks("oak_log", 8)', hint: 'S2 验收目标' },
  { label: '看地图', cmd: '!map', hint: '让她报一次地形（输出走对话流）' },
  { label: '现场侦察', cmd: '!survey', hint: '扫球看周围长什么样' },
])
</script>

<template>
  <div class="quick">
    <div class="head">
      <span class="label">快捷指令</span>
      <div class="who">
        <span class="faint">玩家</span>
        <input v-model="player" type="text" :placeholder="nearbyPlayer || '玩家名'" spellcheck="false" />
      </div>
    </div>
    <div class="btns">
      <button
        v-for="q in quick"
        :key="q.label"
        :title="q.hint"
        :disabled="q.disabled"
        @click="fire(q.cmd)"
      >{{ q.label }}</button>
    </div>
    <div class="tip faint">点一下等于发送对应命令；参数用双引号（解析器只认这种）。</div>
  </div>
</template>

<style scoped>
.quick { border-top: 1px solid var(--border-soft); padding: 8px 10px 10px; flex: none; background: var(--bg-panel); }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
.label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-dim); }
.who { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.who input { width: 110px; padding: 2px 6px; }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
.tip { font-size: 10px; margin-top: 6px; }
</style>
