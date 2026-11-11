import { reactive, computed } from 'vue'
import { socket, request } from '../api/socket'

/**
 * #68：任务板最小入口（后端 board:* 早就有，前端一直零入口）。
 * 只做三件事：列单、取消、重试。不做建单/编辑/共享数据 —— 那些留给完整产品。
 *
 * 契约（board_server.js）：`board:list {scope:'all',openOnly,limit}` → `{ok,jobs}`；
 * `board:set-state {id,state}` → `{ok,job}`；面板连接（role=panel）允许改任意单。
 */
export interface Job {
  id: string
  kind?: string
  title?: string | null
  skill?: string
  args?: any
  priority?: number
  assignee?: string | null
  state: string
  attempts?: number
  lease?: { owner: string | null; until: number | null }
  progress?: any
  result?: any
  interrupted?: any
  createdAt?: number
  updatedAt?: number
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])
/** 允许"重试"（回到 ready）的源状态 —— 与 board_store 的 TRANSITIONS 对齐。 */
const RETRYABLE = new Set(['blocked', 'paused', 'claimed', 'running'])

export const board = reactive({
  jobs: [] as Job[],
  loading: false,
  busy: {} as Record<string, boolean>,
  error: '',
  notice: '',
  /** 只看未终结的单（默认，避免历史把窗口挤满）。 */
  openOnly: true,
  filterText: '',
  /** 只有任务板页面打开时才跟着 board:changed 自动刷新 */
  watching: false,
})

export const openJobs = computed(() => board.jobs.filter(j => !TERMINAL.has(j.state)))

export const visibleJobs = computed(() => {
  const q = board.filterText.trim().toLowerCase()
  const list = board.jobs.slice().sort(byPriorityThenAge)
  if (!q) return list
  return list.filter(j => `${j.id} ${j.skill ?? ''} ${j.title ?? ''} ${j.state}`.toLowerCase().includes(q))
})

function byPriorityThenAge(a: Job, b: Job) {
  const p = (b.priority ?? 0) - (a.priority ?? 0)
  if (p) return p
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
}

export function canRetry(j: Job): boolean {
  return RETRYABLE.has(j.state)
}

export function canCancel(j: Job): boolean {
  return !TERMINAL.has(j.state)
}

export async function refreshBoard(): Promise<void> {
  board.loading = true
  board.error = ''
  try {
    const r = await request<{ ok: boolean; jobs?: Job[]; reason?: string }>('board:list', {
      scope: 'all',
      openOnly: board.openOnly,
      limit: 200,
    })
    if (!r?.ok) { board.error = r?.reason || '读取任务板失败'; return }
    board.jobs = Array.isArray(r.jobs) ? r.jobs : []
  } catch (e: any) {
    board.error = '读取任务板失败：' + (e?.message || String(e))
  } finally {
    board.loading = false
  }
}

/** 取消（终态）；服务端是权威判定，失败就把原因显示出来。 */
export async function cancelJob(j: Job): Promise<boolean> {
  return setState(jobKey(j), 'cancelled', '已取消')
}

/** 重试：把 blocked/paused/被抢占的单放回 ready，让调度器重新领。 */
export async function retryJob(j: Job): Promise<boolean> {
  return setState(jobKey(j), 'ready', '已放回待领（ready）')
}

function jobKey(j: Job): string { return String(j.id) }

async function setState(id: string, state: string, okText: string): Promise<boolean> {
  if (board.busy[id]) return false
  board.busy[id] = true
  board.error = ''
  board.notice = ''
  try {
    const r = await request<{ ok: boolean; job?: Job; reason?: string; code?: string }>(
      'board:set-state', { id, state },
    )
    if (!r?.ok) { board.error = describe(r); return false }
    board.notice = `${id} ${okText}`
    await refreshBoard()
    return true
  } catch (e: any) {
    board.error = '操作失败：' + (e?.message || String(e))
    return false
  } finally {
    board.busy[id] = false
  }
}

function describe(r: { reason?: string; code?: string }): string {
  const tail = r?.reason ? `：${r.reason}` : ''
  if (r?.code === 'LEASE_LOST') return '这张单正被别的 bot 持有（租约未过期）' + tail
  if (r?.code === 'NO_PERMISSION') return '没有权限改这张单' + tail
  return '操作被拒绝' + tail
}

let inited = false
export function initBoard() {
  if (inited) return
  inited = true
  // 板变化时自动刷新（只刷新"正在看板"的页面由 view 自己控制，这里只登记监听）
  socket.on('board:changed', () => {
    if (!board.watching || board.loading) return
    void refreshBoard()
  })
}
