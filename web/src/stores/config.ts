import { reactive } from 'vue'

/**
 * 设置中心（R5 t28）—— 面板侧数据层。
 *
 * 与 vault store 同一套取舍：**HTTP(fetch)**，同源 `/api/config`，错误分三类
 * （网络断 / token 门 401 / 后端业务码）。区别是这里的写操作**会改磁盘上的配置文件**，
 * 所以多一层「脏值 diff」：只提交真正改过的键，避免"点一次保存就把整个文件重写一遍"。
 *
 * ⚠️ 这里**没有**任何密钥字段：密钥在「凭据」页（/api/vault），保管库也从不回显明文。
 *   把"模型与密钥"做成跳转按钮而不是输入框，是刻意的。
 */

export type ConfigGroup = 'network' | 'identity' | 'backup' | 'runtime'

export interface GroupMeta {
  title: string
  source: string
  /** 'immediate' | 'restart-server' | 'restart-agent' | 'new-agent' */
  apply: string
  applyText: string
  detail: string
  applyCommand?: string
}

export interface IdentityPolicy {
  effective: 'persistent' | 'session' | 'deny'
  uuidTrusted: boolean
  sessionMinutes: number
  reason: string
  desiredOnlineMode: boolean
  actualOnlineMode: boolean | null
  onlineModeSource: string
  propsPath: string | null
}

export interface NetworkConfig {
  bind: 'localhost' | 'all' | 'custom'
  nic: string
  whiteList: boolean
  enforceWhiteList: boolean
  onlineMode: boolean
  players: string[]
}

export interface IdentityConfig {
  enabled: boolean
  offline_owner_mode: 'session' | 'deny'
  offline_session_minutes: number
  code_ttl_ms: number
  binding_ttl_ms: number
}

export interface BackupConfig {
  enabled: boolean
  onServerStop: boolean
  excludeSecrets: boolean
  dailyAt: string
  keep: number
}

export interface RuntimeConfig {
  allow_insecure_coding: boolean
  allow_vision: boolean
  code_timeout_mins: number
  max_messages: number
  num_examples: number
  spawn_timeout: number
  log_all_prompts: boolean
  speak: boolean
  chat_ingame: boolean
  narrate_behavior: boolean
  chat_bot_messages: boolean
}

export interface AgentModelInfo {
  name: string
  model: string | null
  profile: string | null
  api: string | null
}

export interface ProfileInfo {
  file: string
  name: string | null
  api: string | null
  model: string | null
  ok?: boolean
  error?: string
}

export interface ConfigResponse {
  network: NetworkConfig
  identity: IdentityConfig
  backup: BackupConfig
  runtime: RuntimeConfig
  meta: {
    groups: Record<ConfigGroup, GroupMeta>
    policy: IdentityPolicy
    pendingApply: { network: boolean }
    backupLogTail: { exists: boolean; lines: string[]; error?: string }
    agents: AgentModelInfo[]
    profiles: ProfileInfo[]
  }
}

export interface ConfigError extends Error {
  code: string
  status: number
}

const BASE = '/api/config'

export const config = reactive({
  data: null as ConfigResponse | null,
  loading: false,
  saving: false,
  error: '',
  notice: '',
})

function makeError(code: string, message: string, status: number): ConfigError {
  const e = new Error(message) as ConfigError
  e.name = 'ConfigError'
  e.code = code
  e.status = status
  return e
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw makeError('NETWORK', '连不上 mindserver（服务没起？页面不是从 /console 打开的？）', 0)
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }
  const body = (data ?? {}) as { error?: string; message?: string }
  if (!res.ok) {
    if (!body.error && res.status === 401) {
      throw makeError('UNAUTHORIZED', '面板鉴权失败：握手 token 过期或缺失，请用带 ?token= 的地址重新打开', 401)
    }
    throw makeError(body.error || `HTTP_${res.status}`, body.message || `请求失败（HTTP ${res.status}）`, res.status)
  }
  return data as T
}

export async function loadConfig(): Promise<void> {
  config.loading = true
  config.error = ''
  try {
    config.data = await call<ConfigResponse>('')
  } catch (e) {
    config.error = (e as ConfigError).message
  } finally {
    config.loading = false
  }
}

/**
 * 保存某一组的**改动键**（patch 只含有变化的键）。
 *
 * 后端返回的新值会覆盖本地，避免"界面显示 90、磁盘上其实是 60"这种漂移。
 */
export async function saveGroup(
  group: ConfigGroup,
  patch: Record<string, unknown>,
  opts: { confirm?: boolean } = {},
): Promise<void> {
  config.saving = true
  config.error = ''
  config.notice = ''
  // #59 + fix-control 的接口增量：把 false→true 的高危开关必须带 confirm:true，
  // 否则服务端 409 CONFIG_CONFIRM_REQUIRED 且不写盘。confirm 只代表"本次提交已确认"。
  const body = opts.confirm ? { ...patch, confirm: true } : patch
  try {
    const r = await call<{ ok: boolean; applied: Record<string, unknown>; backup: string | null }>(
      `/${group}`,
      { method: 'PUT', body: JSON.stringify(body) },
    )
    const appliedKeys = Object.keys(r.applied || {}).join(', ')
    const bak = r.backup ? `（已备份 ${r.backup.split(/[\\/]/).pop()}）` : ''
    config.notice = `已保存 ${group}：${appliedKeys}${bak}`
    await loadConfig()
  } catch (e) {
    const err = e as ConfigError
    if (err.code === 'CONFIG_CONFIRM_REQUIRED') {
      config.error = '开启高危项需要二次确认：在确认框里选「我明白风险，开启」后会自动重试保存。'
    } else if (err.code === 'CONFIG_CONFLICT') {
      config.error = '保存被拒绝：配置已被别人（另一个标签页/进程）改过。请先点「刷新」重读，再重新修改并保存。'
    } else if (err.status === 400) {
      config.error = '值不合法（服务端拒绝写入）：' + err.message
    } else {
      config.error = err.message
    }
    throw e
  } finally {
    config.saving = false
  }
}

export function clearConfigMessages(): void {
  config.error = ''
  config.notice = ''
}

/** 取一组配置的生效方式（供视图渲染小标签；取不到就给空对象）。 */
export function groupMeta(group: ConfigGroup): GroupMeta | null {
  return config.data?.meta?.groups?.[group] ?? null
}

/* ── 单位换算（后端存 ms，界面按分钟/天展示）────────────────── */
export const MS_PER_MINUTE = 60_000
export const MS_PER_DAY = 86_400_000

export function msToMinutes(ms: number): number {
  return Math.round(ms / MS_PER_MINUTE)
}
export function minutesToMs(min: number): number {
  return Math.round(min) * MS_PER_MINUTE
}
export function msToDays(ms: number): number {
  return Math.round(ms / MS_PER_DAY)
}
export function daysToMs(days: number): number {
  return Math.round(days) * MS_PER_DAY
}
