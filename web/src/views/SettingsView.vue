<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  config, loadConfig, saveGroup, clearConfigMessages, groupMeta,
  msToMinutes, minutesToMs, msToDays, daysToMs,
  type ConfigGroup, type ConfigResponse, type NetworkConfig, type IdentityConfig,
  type BackupConfig, type RuntimeConfig,
} from '../stores/config'

/**
 * 设置中心（R5 t28）。
 *
 * 这个页面的核心不是控件，而是**"改完到底什么时候生效"**：
 * 四个组分别落在「立即 / 需重启服务器 / 需重启 agent / 对新 bot 生效」上，
 * 所以每个组标题旁与每个控件旁都挂一个生效方式小标签 —— 用户不该靠记忆或文档去猜。
 *
 * 三类行样式：
 *   · 普通项（开关/滑块/数字）
 *   · **高危项**（`danger`：红框 + ⚠ + 二次确认）：allow_insecure_coding、onlineMode
 *   · 只读项（当前生效策略、备份日志尾部、每个 bot 的 model/profile）
 *
 * 明文边界：本页**没有任何密钥输入**。密钥在「凭据」页（/api/vault），跳转过去即可。
 */

const form = reactive({
  network: {
    bind: 'localhost' as NetworkConfig['bind'],
    nic: '',
    whiteList: true,
    enforceWhiteList: true,
    onlineMode: false,
    players: [] as string[],
  },
  identity: {
    enabled: true,
    offline_owner_mode: 'session' as IdentityConfig['offline_owner_mode'],
    offline_session_minutes: 60,
    code_ttl_ms: 300_000,
    binding_ttl_ms: 2_592_000_000,
  },
  backup: {
    enabled: true,
    onServerStop: true,
    excludeSecrets: true,
    dailyAt: '04:30',
    keep: 7,
  },
  runtime: {
    allow_insecure_coding: false,
    allow_vision: false,
    code_timeout_mins: 20,
    max_messages: 30,
    num_examples: 2,
    spawn_timeout: 60,
    log_all_prompts: false,
    speak: false,
    chat_ingame: true,
    narrate_behavior: false,
    chat_bot_messages: true,
  },
})

/** 服务端最后一次返回的快照 —— 用来算"哪些键真的改了"。 */
const saved = ref<ConfigResponse | null>(null)
/** 新增玩家名（列表编辑的输入框）。 */
const newPlayer = ref('')
/** allow_insecure_coding 的二次确认弹窗。 */
const confirmInsecure = ref(false)

function syncFromServer(): void {
  const d = config.data
  if (!d) return
  saved.value = d
  Object.assign(form.network, d.network)
  Object.assign(form.identity, d.identity)
  Object.assign(form.backup, d.backup)
  Object.assign(form.runtime, d.runtime)
}

async function reload(): Promise<void> {
  clearConfigMessages()
  await loadConfig()
  syncFromServer()
}

async function save(group: ConfigGroup): Promise<void> {
  // 高危项在保存前再确认一次（不是只靠控件上的红字）
  if (group === 'runtime' && form.runtime.allow_insecure_coding) {
    const wasOff = saved.value ? saved.value.runtime.allow_insecure_coding === false : true
    if (wasOff && !confirmInsecure.value) {
      confirmInsecure.value = true
      return
    }
  }
  const patch = diffOf(group)
  if (!Object.keys(patch).length) return
  try {
    await saveGroup(group, patch)
    syncFromServer()
    confirmInsecure.value = false
  } catch {
    /* 错误已在 store 中填充，页面用 config.error 展示 */
  }
}

/** 只提交真正改过的键（避免"点一次保存重写整个文件"）。 */
function diffOf(group: ConfigGroup): Record<string, unknown> {
  const base = saved.value
  if (!base) return {}
  const cur = form[group] as unknown as Record<string, unknown>
  const old = base[group] as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(cur)) {
    if (JSON.stringify(cur[k]) !== JSON.stringify(old[k])) out[k] = cur[k]
  }
  return out
}

const hasChanges = (group: ConfigGroup): boolean => Object.keys(diffOf(group)).length > 0

function applyTag(group: ConfigGroup): string {
  return groupMeta(group)?.applyText ?? ''
}

function applyClass(group: ConfigGroup): string {
  const apply = groupMeta(group)?.apply
  if (apply === 'immediate') return 'ok'
  if (apply === 'restart-server') return 'warn'
  return 'info'
}

/* ── 单位换算的绑定（后端存 ms，界面按分钟/天）────────────────── */
const codeTtlMinutes = computed({
  get: () => msToMinutes(form.identity.code_ttl_ms),
  set: (v: number | string) => { form.identity.code_ttl_ms = minutesToMs(Math.max(1, Number(v) || 1)) },
})
const bindingTtlDays = computed({
  get: () => msToDays(form.identity.binding_ttl_ms),
  set: (v: number | string) => { form.identity.binding_ttl_ms = daysToMs(Math.max(1, Number(v) || 1)) },
})

/* ── 玩家列表编辑 ──────────────────────────────────────────────── */
function addPlayer(): void {
  const name = newPlayer.value.trim()
  if (!name) return
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    config.error = `"${name}" 不是合法玩家名（1~16 位字母/数字/下划线）`
    return
  }
  if (form.network.players.includes(name)) {
    config.error = `列表里已经有 ${name} 了`
    return
  }
  form.network.players.push(name)
  newPlayer.value = ''
  clearConfigMessages()
}

function removePlayer(name: string): void {
  form.network.players = form.network.players.filter((p) => p !== name)
}

/* ── 高危项 ────────────────────────────────────────────────────── */
function toggleInsecure(): void {
  if (form.runtime.allow_insecure_coding) {
    // 关掉不需要确认（往安全方向走）
    form.runtime.allow_insecure_coding = false
    return
  }
  confirmInsecure.value = true
}

function acceptInsecure(): void {
  form.runtime.allow_insecure_coding = true
  confirmInsecure.value = false
}

function rejectInsecure(): void {
  form.runtime.allow_insecure_coding = false
  confirmInsecure.value = false
}

/** `all` + 离线模式 = 同网络任何人都能冒名（白名单只校验名字）。 */
const impersonationRisk = computed(
  () => form.network.bind === 'all' && form.network.onlineMode === false,
)

const policy = computed(() => config.data?.meta.policy ?? null)
const pendingNetwork = computed(() => config.data?.meta.pendingApply.network === true)
const backupLog = computed(() => config.data?.meta.backupLogTail ?? { exists: false, lines: [] })

onMounted(() => {
  void reload()
})
</script>

<template>
  <div class="settings scroll">
    <div class="head">
      <h2>设置中心</h2>
      <span class="faint small">
        四个配置源统一到一页；**生效方式各不相同**，每组标题旁有标签，别改完以为立刻就生效了。
      </span>
      <div class="spacer" />
      <button :disabled="config.loading || config.saving" @click="reload">
        {{ config.loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <div v-if="config.error" class="msg bad">{{ config.error }}</div>
    <div v-if="config.notice" class="msg ok">{{ config.notice }}</div>

    <div v-if="pendingNetwork" class="msg warn">
      ⚠ network.json 已改，但 server.properties 还没同步 —— 需要跑
      <code>{{ groupMeta('network')?.applyCommand }}</code> 再重启服务器才生效。
    </div>

    <!-- ═════════ 组 1：服务器网络与准入 ═════════ -->
    <section class="panel">
      <div class="panel-title">
        服务器网络与准入
        <span class="tag" :class="applyClass('network')">{{ applyTag('network') }}</span>
        <span class="faint small">{{ groupMeta('network')?.source }}</span>
      </div>
      <div class="body">
        <p class="hint">{{ groupMeta('network')?.detail }}</p>

        <div class="row">
          <span class="label">绑定地址</span>
          <label v-for="opt in [{v:'localhost',t:'只本机'},{v:'all',t:'局域网/手机可连'},{v:'custom',t:'自定义网卡'}]" :key="opt.v" class="radio">
            <input type="radio" :value="opt.v" v-model="form.network.bind" />
            <span>{{ opt.t }}</span>
          </label>
          <span class="tag" :class="applyClass('network')">{{ applyTag('network') }}</span>
        </div>

        <div v-if="form.network.bind === 'custom'" class="row">
          <span class="label">网卡地址</span>
          <input class="grow" v-model="form.network.nic" placeholder="例如 192.168.1.23" spellcheck="false" />
        </div>

        <div v-if="impersonationRisk" class="danger-box">
          ⚠ <strong>危险组合</strong>：绑定所有网卡 + 离线模式（onlineMode=false）⇒
          同一网络里任何人都能把游戏名改成主人的名字进服。白名单<strong>只校验名字</strong>，
          <strong>挡不住冒名</strong>。
        </div>

        <div class="row">
          <span class="label">白名单</span>
          <button class="sw" :class="{ on: form.network.whiteList }" role="switch"
                  :aria-checked="form.network.whiteList" @click="form.network.whiteList = !form.network.whiteList">
            <i /></button>
          <span class="faint small">只允许列表里的名字进服（挡不住冒名）</span>
          <span class="tag" :class="applyClass('network')">{{ applyTag('network') }}</span>
        </div>

        <div class="row">
          <span class="label">强制执行白名单</span>
          <button class="sw" :class="{ on: form.network.enforceWhiteList }" role="switch"
                  :aria-checked="form.network.enforceWhiteList" @click="form.network.enforceWhiteList = !form.network.enforceWhiteList">
            <i /></button>
          <span class="faint small">踢掉不在白名单里的已登录玩家</span>
          <span class="tag" :class="applyClass('network')">{{ applyTag('network') }}</span>
        </div>

        <div class="row danger">
          <span class="label">⚠ 正版验证（onlineMode）</span>
          <button class="sw" :class="{ on: form.network.onlineMode, danger: true }" role="switch"
                  :aria-checked="form.network.onlineMode" @click="form.network.onlineMode = !form.network.onlineMode">
            <i /></button>
          <span class="faint small">
            开 = <strong>必须正版账号</strong>，盗版客户端会被拒；关 = 离线模式（可冒名）。
            切完要 apply + 重启服务器。
          </span>
        </div>

        <div class="row players">
          <span class="label">玩家列表</span>
          <div class="chips">
            <span v-for="p in form.network.players" :key="p" class="chip">
              {{ p }}
              <button class="x" :title="`移除 ${p}`" @click="removePlayer(p)">×</button>
            </span>
            <span v-if="!form.network.players.length" class="faint small">（空：白名单开了也没人能进）</span>
          </div>
        </div>
        <div class="row">
          <span class="label" />
          <input class="grow" v-model="newPlayer" placeholder="输入玩家名后回车添加" spellcheck="false"
                 @keyup.enter="addPlayer" />
          <button @click="addPlayer">添加</button>
        </div>

        <div class="row ro">
          <span class="label">当前生效策略</span>
          <span class="mono">
            effective=<strong>{{ policy?.effective ?? '?' }}</strong>
            · sessionMinutes={{ policy?.sessionMinutes ?? '?' }}
            · 服务端实际 online-mode={{ policy?.actualOnlineMode === null ? '未知' : policy?.actualOnlineMode }}
          </span>
        </div>
        <p class="hint">{{ policy?.reason }}</p>

        <div class="foot">
          <button class="primary" :disabled="config.saving || !hasChanges('network')" @click="save('network')">
            保存网络设置
          </button>
          <span v-if="hasChanges('network')" class="faint small">有未保存改动</span>
          <span v-else class="faint small">没有改动</span>
        </div>
      </div>
    </section>

    <!-- ═════════ 组 2：身份与权限 ═════════ -->
    <section class="panel">
      <div class="panel-title">
        身份与权限
        <span class="tag" :class="applyClass('identity')">{{ applyTag('identity') }}</span>
        <span class="faint small">{{ groupMeta('identity')?.source }}</span>
      </div>
      <div class="body">
        <p class="hint">{{ groupMeta('identity')?.detail }}</p>

        <div class="row">
          <span class="label">身份绑定</span>
          <button class="sw" :class="{ on: form.identity.enabled }" role="switch"
                  :aria-checked="form.identity.enabled" @click="form.identity.enabled = !form.identity.enabled">
            <i /></button>
          <span class="faint small">关掉 = 退回"按 profile 里的名字"授权（不安全）</span>
          <span class="tag" :class="applyClass('identity')">{{ applyTag('identity') }}</span>
        </div>

        <div class="row">
          <span class="label">离线服授 owner</span>
          <label class="radio">
            <input type="radio" value="session" v-model="form.identity.offline_owner_mode" />
            <span>session（claim 后限时授 owner）</span>
          </label>
          <label class="radio">
            <input type="radio" value="deny" v-model="form.identity.offline_owner_mode" />
            <span>deny（离线一律只聊天，永不给主人权限）</span>
          </label>
          <span class="tag" :class="applyClass('identity')">{{ applyTag('identity') }}</span>
        </div>

        <div class="row">
          <span class="label">会话窗口</span>
          <input type="range" min="15" max="720" step="15"
                 v-model.number="form.identity.offline_session_minutes" />
          <span class="num mono">当前 = {{ form.identity.offline_session_minutes }} 分钟</span>
          <span class="tag" :class="applyClass('identity')">{{ applyTag('identity') }}</span>
        </div>
        <p class="hint">claim 后 {{ form.identity.offline_session_minutes }} 分钟内是主人，过后自动降级为访客。</p>

        <div class="row">
          <span class="label">绑定码有效期</span>
          <input type="number" min="1" max="60" v-model.number="codeTtlMinutes" class="num-input" />
          <span class="faint small">分钟（默认 5）</span>
          <span class="tag" :class="applyClass('identity')">{{ applyTag('identity') }}</span>
        </div>

        <div class="row">
          <span class="label">绑定有效期</span>
          <input type="number" min="1" max="365" v-model.number="bindingTtlDays" class="num-input" />
          <span class="faint small">天（默认 30）</span>
          <span class="tag" :class="applyClass('identity')">{{ applyTag('identity') }}</span>
        </div>

        <div class="foot">
          <button class="primary" :disabled="config.saving || !hasChanges('identity')" @click="save('identity')">
            保存身份设置
          </button>
          <span v-if="hasChanges('identity')" class="faint small">有未保存改动</span>
          <span v-else class="faint small">没有改动</span>
        </div>
      </div>
    </section>

    <!-- ═════════ 组 3：备份 ═════════ -->
    <section class="panel">
      <div class="panel-title">
        备份
        <span class="tag" :class="applyClass('backup')">{{ applyTag('backup') }}</span>
        <span class="faint small">{{ groupMeta('backup')?.source }}</span>
      </div>
      <div class="body">
        <p class="hint">{{ groupMeta('backup')?.detail }}</p>

        <div class="row">
          <span class="label">启用自动备份</span>
          <button class="sw" :class="{ on: form.backup.enabled }" role="switch"
                  :aria-checked="form.backup.enabled" @click="form.backup.enabled = !form.backup.enabled">
            <i /></button>
          <span class="tag" :class="applyClass('backup')">{{ applyTag('backup') }}</span>
        </div>

        <div class="row">
          <span class="label">停服后自动备份</span>
          <button class="sw" :class="{ on: form.backup.onServerStop }" role="switch"
                  :aria-checked="form.backup.onServerStop" @click="form.backup.onServerStop = !form.backup.onServerStop">
            <i /></button>
          <span class="faint small">主路径（最安全：等服务端完全停下再备）</span>
          <span class="tag" :class="applyClass('backup')">{{ applyTag('backup') }}</span>
        </div>

        <div class="row">
          <span class="label">排除密钥文件</span>
          <button class="sw" :class="{ on: form.backup.excludeSecrets }" role="switch"
                  :aria-checked="form.backup.excludeSecrets" @click="form.backup.excludeSecrets = !form.backup.excludeSecrets">
            <i /></button>
          <span class="faint small">备份里不含 keys.json / .secrets.db 之类的凭据</span>
          <span class="tag" :class="applyClass('backup')">{{ applyTag('backup') }}</span>
        </div>

        <div class="row">
          <span class="label">每日备份时间</span>
          <input type="time" v-model="form.backup.dailyAt" />
          <span class="faint small">计划任务兜底（服务端在跑会跳过并记日志）</span>
          <span class="tag" :class="applyClass('backup')">{{ applyTag('backup') }}</span>
        </div>

        <div class="row">
          <span class="label">保留份数</span>
          <input type="range" min="1" max="30" step="1" v-model.number="form.backup.keep" />
          <span class="num mono">{{ form.backup.keep }} 份</span>
          <span class="tag" :class="applyClass('backup')">{{ applyTag('backup') }}</span>
        </div>
        <p class="hint">超出 {{ form.backup.keep }} 份的旧备份会被删除（按时间排序，先删最旧）。</p>

        <div class="log">
          <div class="log-title faint small">
            只读 · logs/backup-auto.log 最后 5 行
            <span v-if="!backupLog.exists" class="warn-text">（文件还不存在 = 一次都没跑过）</span>
          </div>
          <pre v-if="backupLog.lines.length">{{ backupLog.lines.join('\n') }}</pre>
          <div v-else class="faint small">（暂无日志）</div>
        </div>

        <div class="foot">
          <button class="primary" :disabled="config.saving || !hasChanges('backup')" @click="save('backup')">
            保存备份设置
          </button>
          <span v-if="hasChanges('backup')" class="faint small">有未保存改动</span>
          <span v-else class="faint small">没有改动</span>
        </div>
      </div>
    </section>

    <!-- ═════════ 组 4：运行时与安全 ═════════ -->
    <section class="panel">
      <div class="panel-title">
        运行时与安全
        <span class="tag" :class="applyClass('runtime')">{{ applyTag('runtime') }}</span>
        <span class="faint small">{{ groupMeta('runtime')?.source }}</span>
      </div>
      <div class="body">
        <p class="hint">{{ groupMeta('runtime')?.detail }}</p>

        <div class="row danger">
          <span class="label">⚠ 允许模型写并执行代码</span>
          <button class="sw danger" :class="{ on: form.runtime.allow_insecure_coding }" role="switch"
                  :aria-checked="form.runtime.allow_insecure_coding" @click="toggleInsecure">
            <i /></button>
          <span class="small danger-text">
            = 允许模型在你电脑上写并执行代码（<strong>本机 root</strong>），<strong>默认关闭</strong>。
          </span>
          <span class="tag" :class="applyClass('runtime')">{{ applyTag('runtime') }}</span>
        </div>

        <div class="row">
          <span class="label">允许视觉</span>
          <button class="sw" :class="{ on: form.runtime.allow_vision }" role="switch"
                  :aria-checked="form.runtime.allow_vision" @click="form.runtime.allow_vision = !form.runtime.allow_vision">
            <i /></button>
          <span class="faint small">需要本机原生 canvas 依赖</span>
          <span class="tag" :class="applyClass('runtime')">{{ applyTag('runtime') }}</span>
        </div>

        <div class="row">
          <span class="label">代码超时</span>
          <input type="range" min="1" max="120" step="1" v-model.number="form.runtime.code_timeout_mins" />
          <span class="num mono">{{ form.runtime.code_timeout_mins }} 分钟</span>
          <span class="tag" :class="applyClass('runtime')">{{ applyTag('runtime') }}</span>
        </div>

        <div class="row">
          <span class="label">上下文消息数</span>
          <input type="range" min="10" max="100" step="1" v-model.number="form.runtime.max_messages" />
          <span class="num mono">{{ form.runtime.max_messages }}</span>
          <span class="tag" :class="applyClass('runtime')">{{ applyTag('runtime') }}</span>
        </div>

        <div class="row">
          <span class="label">示例数量</span>
          <input type="range" min="0" max="10" step="1" v-model.number="form.runtime.num_examples" />
          <span class="num mono">{{ form.runtime.num_examples }}</span>
          <span class="tag" :class="applyClass('runtime')">{{ applyTag('runtime') }}</span>
        </div>

        <div class="row">
          <span class="label">启动超时</span>
          <input type="number" min="5" max="300" v-model.number="form.runtime.spawn_timeout" class="num-input" />
          <span class="faint small">秒（等 bot 进入服务器的上限）</span>
          <span class="tag" :class="applyClass('runtime')">{{ applyTag('runtime') }}</span>
        </div>

        <div class="row">
          <span class="label">记录全部 prompt</span>
          <button class="sw" :class="{ on: form.runtime.log_all_prompts }" role="switch"
                  :aria-checked="form.runtime.log_all_prompts" @click="form.runtime.log_all_prompts = !form.runtime.log_all_prompts">
            <i /></button>
          <span class="faint small">会把完整上下文写进日志（含聊天内容）</span>
          <span class="tag" :class="applyClass('runtime')">{{ applyTag('runtime') }}</span>
        </div>

        <div class="grid2">
          <div class="row">
            <span class="label">语音播报</span>
            <button class="sw" :class="{ on: form.runtime.speak }" role="switch"
                    :aria-checked="form.runtime.speak" @click="form.runtime.speak = !form.runtime.speak"><i /></button>
          </div>
          <div class="row">
            <span class="label">游戏内聊天</span>
            <button class="sw" :class="{ on: form.runtime.chat_ingame }" role="switch"
                    :aria-checked="form.runtime.chat_ingame" @click="form.runtime.chat_ingame = !form.runtime.chat_ingame"><i /></button>
          </div>
          <div class="row">
            <span class="label">旁白行为</span>
            <button class="sw" :class="{ on: form.runtime.narrate_behavior }" role="switch"
                    :aria-checked="form.runtime.narrate_behavior" @click="form.runtime.narrate_behavior = !form.runtime.narrate_behavior"><i /></button>
          </div>
          <div class="row">
            <span class="label">bot 间聊天</span>
            <button class="sw" :class="{ on: form.runtime.chat_bot_messages }" role="switch"
                    :aria-checked="form.runtime.chat_bot_messages" @click="form.runtime.chat_bot_messages = !form.runtime.chat_bot_messages"><i /></button>
          </div>
        </div>

        <div class="foot">
          <button class="primary" :disabled="config.saving || !hasChanges('runtime')" @click="save('runtime')">
            保存运行时设置
          </button>
          <span v-if="hasChanges('runtime')" class="faint small">有未保存改动</span>
          <span v-else class="faint small">没有改动</span>
        </div>
      </div>
    </section>

    <!-- ═════════ 组 5：模型与密钥（只读 + 跳转）═════════ -->
    <section class="panel">
      <div class="panel-title">
        模型与密钥
        <span class="faint small">只读</span>
      </div>
      <div class="body">
        <p class="hint">
          <strong>密钥不在这里填</strong>：API Key 统一在「凭据」页管理（AES-256-GCM 加密，写入后不可查看）。
        </p>
        <div class="row">
          <RouterLink to="/vault"><button class="primary">前往「凭据」页管理密钥</button></RouterLink>
        </div>

        <div class="table">
          <div class="thead row">
            <span class="c1">agent</span><span class="c2">profile</span><span class="c3">model</span><span class="c4">api</span>
          </div>
          <div v-for="a in config.data?.meta.agents ?? []" :key="a.name" class="trow row">
            <span class="c1 mono">{{ a.name }}</span>
            <span class="c2 mono">{{ a.profile ?? '-' }}</span>
            <span class="c3 mono">{{ a.model ?? '-' }}</span>
            <span class="c4 mono">{{ a.api ?? '-' }}</span>
          </div>
          <div v-if="!(config.data?.meta.agents ?? []).length" class="faint small pad">
            当前没有在线 agent（启动一个后这里会显示它实际在用的 profile 与 model）。
          </div>
        </div>

        <div class="table">
          <div class="thead row">
            <span class="c1">配置里的 profile</span><span class="c2">name</span><span class="c3">model</span><span class="c4">api</span>
          </div>
          <div v-for="p in config.data?.meta.profiles ?? []" :key="p.file" class="trow row">
            <span class="c1 mono">{{ p.file }}</span>
            <span class="c2 mono">{{ p.ok ? (p.name ?? '-') : '读取失败' }}</span>
            <span class="c3 mono">{{ p.model ?? '-' }}</span>
            <span class="c4 mono">{{ p.api ?? '-' }}</span>
          </div>
          <div v-if="!(config.data?.meta.profiles ?? []).length" class="faint small pad">
            配置里没有声明 profiles（settings.js 的 profiles 为空）。
          </div>
        </div>
      </div>
    </section>

    <!-- allow_insecure_coding 的二次确认 -->
    <div v-if="confirmInsecure" class="modal-mask">
      <div class="modal">
        <h3>⚠ 确认开启「允许模型写并执行代码」？</h3>
        <p>
          开启后，模型可以在<strong>你这台电脑上写文件并执行代码</strong> ——
          这等于把<strong>本机 root</strong> 交出去（不是受限沙箱：SES Compartment 挡不住宿主 realm，
          历史审计已实测）。
        </p>
        <p class="faint small">
          这条会写进 <code>mindcraft/settings.js</code>（先备份），并对<strong>新启动的 bot</strong>生效。
        </p>
        <div class="row">
          <button class="danger" @click="acceptInsecure">我明白风险，开启</button>
          <button @click="rejectInsecure">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings { padding: var(--gap); height: 100%; overflow: auto; display: flex; flex-direction: column; gap: var(--gap); }

.head { display: flex; align-items: baseline; gap: 10px; }
.head h2 { font-size: 15px; }
.spacer { flex: 1; }

.msg { font-size: 12px; padding: 7px 10px; border-radius: 6px; }
.msg.bad { color: var(--bad); background: #261212; border: 1px solid #4a2a2a; }
.msg.ok { color: var(--ok); background: #12261a; border: 1px solid #2a4a2f; }
.msg.warn { color: var(--warn); background: #26200f; border: 1px solid #4a3f1f; }
.msg code { background: var(--bg-hover); padding: 0 4px; border-radius: 3px; }

.body { padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; }
.hint { margin: 0; font-size: 12px; color: var(--fg-dim); line-height: 1.6; }

.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.label { flex: 0 0 132px; font-size: 12px; color: var(--fg-dim); }
.grow { flex: 1; min-width: 160px; }
.num-input { width: 76px; }
.num { font-variant-numeric: tabular-nums; font-size: 12px; }
.small { font-size: 11px; }
.mono { font-family: var(--mono); font-size: 12px; }
.faint { color: var(--fg-faint); }
.pad { padding: 6px; }

.tag {
  font-size: 10px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--bg-hover); color: var(--fg-dim); white-space: nowrap;
}
.tag.ok { color: var(--ok); border-color: #2a4a2f; background: #12261a; }
.tag.warn { color: var(--warn); border-color: #4a3f1f; background: #26200f; }
.tag.info { color: var(--accent); border-color: #1f3a5f; background: #10202f; }

.radio { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--fg); }
.radio input { accent-color: var(--accent); }

/* 开关：用 button 而不是 checkbox —— 天然可聚焦、可被读屏识别 */
.sw {
  width: 34px; height: 18px; padding: 0; border-radius: 10px; position: relative;
  background: var(--bg); border: 1px solid var(--border); cursor: pointer;
}
.sw i {
  position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--fg-faint); transition: left .12s, background .12s;
}
.sw.on { background: #1f6feb; border-color: #1f6feb; }
.sw.on i { left: 17px; background: #fff; }
.sw.danger.on { background: var(--bad); border-color: var(--bad); }

.danger { border-left: 2px solid var(--bad); padding-left: 8px; }
.danger-text { color: #ffb4ae; }
.danger-box {
  font-size: 12px; line-height: 1.6; color: #ffb4ae;
  background: #2d1416; border: 1px solid #5a2226; border-radius: 6px; padding: 7px 10px;
}

input[type="range"] { width: 180px; accent-color: var(--accent); }
input[type="time"], input[type="number"] { font: inherit; font-size: 12px; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11px;
  padding: 1px 4px 1px 8px; border-radius: 10px;
  background: var(--bg-hover); border: 1px solid var(--border);
}
.chip .x { padding: 0 3px; border: none; background: transparent; color: var(--fg-dim); cursor: pointer; }
.chip .x:hover { color: var(--bad); }

.log { border: 1px solid var(--border-soft); border-radius: 6px; background: var(--bg); }
.log-title { padding: 4px 8px; border-bottom: 1px solid var(--border-soft); }
.log pre {
  margin: 0; padding: 6px 8px; font-size: 11px; line-height: 1.55; color: var(--fg-dim);
  white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow: auto;
}
.warn-text { color: var(--warn); }

.foot { display: flex; align-items: center; gap: 8px; padding-top: 6px; border-top: 1px solid var(--border-soft); }

.ro { border-top: 1px dashed var(--border-soft); padding-top: 6px; }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; }

.table { border: 1px solid var(--border-soft); border-radius: 6px; overflow: hidden; }
.thead { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-faint);
         padding: 4px 8px; border-bottom: 1px solid var(--border-soft); background: var(--bg); }
.trow { padding: 4px 8px; border-bottom: 1px solid var(--border-soft); }
.trow:last-child { border-bottom: none; }
.c1 { flex: 0 0 210px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.c2 { flex: 0 0 150px; }
.c3 { flex: 0 0 160px; }
.c4 { flex: 1; }

.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.6);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.modal {
  max-width: 520px; padding: 16px; border-radius: var(--radius);
  background: var(--bg-panel); border: 1px solid #5a2226; display: flex; flex-direction: column; gap: 10px;
}
.modal h3 { font-size: 14px; color: #ffb4ae; }
.modal p { margin: 0; font-size: 12px; line-height: 1.7; }
.modal code { background: var(--bg-hover); padding: 0 4px; border-radius: 3px; }
</style>
