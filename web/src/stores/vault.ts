import { reactive } from 'vue'

/**
 * 凭据保管库（R5 t15）—— 面板侧的数据层。
 *
 * 为什么单独一个 store 而不是塞进 agents.ts：这里的传输是 **HTTP（fetch）**，
 * 而 agents/diag 全是 socket.io 事件；两者失败模式完全不同（HTTP 有状态码，
 * socket 有 ack 超时 + 断线缓冲），混一起会让"哪些失败能重试"再次说不清。
 *
 * ⚠️ 安全边界（**改之前先读**）：
 *   · 这个 store **永远拿不到明文**。`PUT` 把值送上去之后，服务端只回 `hint`；
 *     列表、状态、任何响应里都没有 value。所以这里不该出现"回填/回显"逻辑 ——
 *     不是没做，是**不允许做**（要改只能整体替换）。
 *   · 值只在表单的局部状态里短暂存在，保存成功后立即清空（连内存里的副本都不留）。
 *
 * 传输口径：同源 `/api/vault/*`（prod 由 mindserver 在 `/console` 下同源托管，
 * 走 HttpOnly cookie 过握手 token 门）。dev server 需要在 vite.config.ts 里给
 * `/api` 加一条 proxy（本单不在改动范围，见 docs/vault-保管库.md 的「开发模式」）。
 */

export interface VaultItem {
  name: string
  hint: string
  updatedAt: number
  updatedBy: string | null
}

export interface VaultStatus {
  initialized: boolean
  locked: boolean
  count: number
  kdf: string
  /**
   * ★ T31 / W-1：这次解锁是谁触发的。
   *   'manual' = 面板/API 输了口令；'env' = 被 MC_VAULT_PASSPHRASE 自动解锁；null = 锁定。
   *   'env' 时「上锁」按钮必须置灰 —— 因为下一次读 secret 又会自动解锁，点了也没用。
   */
  unlockSource: 'manual' | 'env' | null
}

export interface VaultError extends Error {
  /** 服务端错误码（VAULT_BAD_PASSPHRASE / VAULT_LOCKED / UNAUTHORIZED …） */
  code: string
  status: number
}

const BASE = '/api/vault'

export const vault = reactive({
  status: null as VaultStatus | null,
  items: [] as VaultItem[],
  /** 首次加载（区分"还没加载"与"已加载但为空"） */
  loaded: false,
  busy: false,
  error: '',
  notice: '',
})

function makeError(code: string, message: string, status: number): VaultError {
  const e = new Error(message) as VaultError
  e.name = 'VaultError'
  e.code = code
  e.status = status
  return e
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      // 同源 cookie（握手 token 换成 HttpOnly cookie 那条路）必须带上
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    // 网络层失败：和"服务端拒绝"要分开说，否则用户会以为口令错了
    throw makeError('NETWORK', '连不上 mindserver（服务没起？页面不是从 /console 打开的？）', 0)
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }
  const body = (data ?? {}) as { error?: string; message?: string }

  if (!res.ok) {
    // 401 有两种：token 门（纯文本，没有 error 字段）与口令错（JSON 带 error）
    if (!body.error && res.status === 401) {
      throw makeError('UNAUTHORIZED', '面板鉴权失败：握手 token 过期或缺失，请用带 ?token= 的地址重新打开', 401)
    }
    throw makeError(body.error || `HTTP_${res.status}`, body.message || `请求失败（HTTP ${res.status}）`, res.status)
  }
  return data as T
}

/** 拉状态 + （解锁时）条目列表。 */
export async function refreshVault(): Promise<void> {
  vault.error = ''
  try {
    vault.status = await call<VaultStatus>('/status')
    if (vault.status.initialized && !vault.status.locked) {
      vault.items = await call<VaultItem[]>('/items')
    } else {
      vault.items = []
    }
    vault.loaded = true
  } catch (e) {
    vault.error = (e as VaultError).message
    vault.loaded = true
  }
}

/** 首次初始化（建 salt + verifier）。成功后即为解锁态。 */
export async function initVault(passphrase: string): Promise<void> {
  vault.busy = true
  vault.error = ''
  vault.notice = ''
  try {
    await call('/init', { method: 'POST', body: JSON.stringify({ passphrase }) })
    vault.notice = '保管库已创建并解锁。请把口令记在**离线**的地方：丢了就再也解不开（只能重新录入所有密钥）。'
    await refreshVault()
  } catch (e) {
    vault.error = (e as VaultError).message
    throw e
  } finally {
    vault.busy = false
  }
}

export async function unlockVault(passphrase: string): Promise<void> {
  vault.busy = true
  vault.error = ''
  vault.notice = ''
  try {
    const r = await call<{ ok: boolean; injected?: number }>('/unlock', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    })
    vault.notice = `已解锁${r.injected ? `，${r.injected} 项已注入环境供新起的 agent 使用` : ''}。`
    await refreshVault()
  } catch (e) {
    vault.error = (e as VaultError).message
    throw e
  } finally {
    vault.busy = false
  }
}

export async function lockVault(): Promise<void> {
  vault.busy = true
  vault.error = ''
  try {
    await call('/lock', { method: 'POST' })
    vault.notice = '已上锁：内存里的密钥已清掉，注入的环境变量也撤回了。'
    await refreshVault()
  } catch (e) {
    vault.error = (e as VaultError).message
  } finally {
    vault.busy = false
  }
}

/**
 * 新增 / 替换（同名即替换）。
 *
 * 返回值只有 hint —— 调用方**没有**办法把明文再拿回来，页面也就不该有"显示原值"的入口。
 */
export async function putVaultItem(name: string, value: string): Promise<VaultItem> {
  vault.busy = true
  vault.error = ''
  vault.notice = ''
  try {
    const item = await call<VaultItem>(`/items/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
    vault.notice = `已保存 ${item.name}：${item.hint}（值不可再查看，只能替换）`
    await refreshVault()
    return item
  } catch (e) {
    vault.error = (e as VaultError).message
    throw e
  } finally {
    vault.busy = false
  }
}

export async function deleteVaultItem(name: string): Promise<void> {
  vault.busy = true
  vault.error = ''
  vault.notice = ''
  try {
    await call(`/items/${encodeURIComponent(name)}`, { method: 'DELETE' })
    vault.notice = `已删除 ${name}`
    await refreshVault()
  } catch (e) {
    vault.error = (e as VaultError).message
    throw e
  } finally {
    vault.busy = false
  }
}

export function clearVaultMessages(): void {
  vault.error = ''
  vault.notice = ''
}

/** 名字规则与服务端保持**同一份**（前端只是提前拦，真正校验在服务端）。 */
export const VAULT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/
export const VAULT_MAX_VALUE_BYTES = 4096
export const VAULT_MIN_PASSPHRASE = 8
