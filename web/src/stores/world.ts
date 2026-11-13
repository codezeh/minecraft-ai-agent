/**
 * t3：存档只读视图的数据层 —— 队伍 / 库存 / 事件 / 联邦。**只有读，没有写。**
 *
 * 契约来源全部是服务端**已有**实现（不猜字段）：
 *   · 队伍   → `team:list`、`team:chest-list`（board_server.js）
 *   · 库存   → `inventory:snapshot`、`inventory:ledger`（board_server.js）
 *   · 联邦   → `federation-status`（mindserver.js，t1 接线，凭证已脱敏）
 *   · 事件   → `events:since` —— ★ **服务端还没有这个事件**（见 docs/audit-r6/fixes4/wiring-web.md §5）。
 *              面板按约定形状实现，接上即点亮；在那之前如实显示"未接线"，不伪造时间线。
 *
 * 状态语义（空态必须诚实，别把"没接"说成"没有数据"）：
 *   `ok`        拿到回执（数据可能为空 —— 空 = 真的没有）
 *   `error`     服务端明确拒绝（带 code/reason，例如 NO_BOARD / NO_PERMISSION）
 *   `not-wired` 发出去但**没回执** ⇒ 这个事件在服务端大概率没接（不是"没有数据"）
 */
import { reactive, computed } from 'vue'
import { requestRead } from '../api/socket'
import type {
  TeamRow, TeamChestRow, StockItemRow, StockContainerRow, ReservationRow, LedgerRow,
  FederationStatusResult, VisitGrantRow, KnownPeerRow, AllowedPeerRow, GlobalEventRow,
} from '../api/types'

export type Phase = 'idle' | 'loading' | 'ok' | 'error' | 'not-wired'

export interface ReadOut<T> {
  phase: Phase
  message: string
  /** 服务端给的原始 reason（`ok:false` 时），视图据此区分"没接"与"参数被拒"。 */
  reason: string
  data: T | null
}

/** 只读请求超时：比控制面（15s/8s）短 —— 没有回执就是没有回执，让人早点知道。 */
const READ_TIMEOUT_MS = 6000

/** 服务端的拒绝码 → 人话（翻不动就把 reason 原样带出来，不许把原因吃掉）。 */
const FAIL_MAP: Record<string, string> = {
  NO_BOARD: '服务端没有解析出存档维度（world_id 为空）：这些表按存档存，没存档就没有可看的数据',
  NO_TARGET: '目标不存在（存档里没有这条记录）',
  NO_PERMISSION: '服务端拒绝：身份/归属校验没过',
  INTERNAL: '服务端内部错误',
  TOO_MUCH: '请求量过大（服务端限流或参数超限）',
}

function describeFail(r: any): string {
  const code = String(r?.code ?? '').trim()
  const reason = String(r?.reason ?? r?.message ?? '').trim()
  const head = FAIL_MAP[code] || (code ? `服务端拒绝（${code}）` : '服务端拒绝了这次读取')
  if (reason && reason !== code) return `${head}：${reason}`
  if (!code && !reason) return '服务端拒绝了这次读取（没给原因）'
  return head
}

/** 一次只读请求 → 三态之一。**不抛**（视图只关心"该显示什么"）。 */
async function readOnce<T>(event: string, payload: any = {}, timeoutMs = READ_TIMEOUT_MS): Promise<ReadOut<T>> {
  try {
    const r: any = await requestRead<any>(event, payload, timeoutMs)
    if (r && r.ok === false) {
      return { phase: 'error', message: describeFail(r), reason: String(r.reason ?? ''), data: null }
    }
    if (!r || r.ok !== true) {
      return { phase: 'error', message: '回执无法识别（既不是 ok:true 也不是 ok:false）', reason: '', data: null }
    }
    return { phase: 'ok', message: '', reason: '', data: r as T }
  } catch (e: any) {
    const code = String(e?.code ?? '')
    if (code === 'OFFLINE') {
      return { phase: 'error', message: '未连接到 mindserver：这条读取没有发出去', reason: 'OFFLINE', data: null }
    }
    if (code === 'UNKNOWN_RESULT') {
      return {
        phase: 'not-wired',
        message: `服务端没有回应 ${event}（大概率没接这个只读入口；不是"没有数据"）`,
        reason: 'NO_ACK',
        data: null,
      }
    }
    return { phase: 'error', message: String(e?.message ?? e), reason: '', data: null }
  }
}

// ── 队伍 ──────────────────────────────────────────────────────────────────

export const teamView = reactive({
  phase: 'idle' as Phase,
  message: '',
  worldId: '',
  teams: [] as TeamRow[],
  /** 当前 bot（面板顶部选中的 agent）所在的队伍；null = 不在任何队/还没读。 */
  botTeam: null as TeamRow | null,
  botName: '',
  /** 共享仓坐标：**只有本队**能看（服务端按成员判定），所以它是单独一态。 */
  chestPhase: 'idle' as Phase,
  chestMessage: '',
  chests: [] as TeamChestRow[],
})

export async function loadTeams(botName = ''): Promise<void> {
  teamView.phase = 'loading'
  teamView.message = ''
  teamView.botName = botName
  teamView.botTeam = null
  teamView.chests = []
  teamView.chestPhase = 'idle'
  teamView.chestMessage = ''
  const out = await readOnce<{ teams?: TeamRow[]; worldId?: string }>('team:list', {})
  teamView.phase = out.phase
  teamView.message = out.message
  if (out.phase !== 'ok') { teamView.teams = []; return }
  teamView.teams = Array.isArray(out.data?.teams) ? out.data!.teams! : []
  teamView.worldId = String(out.data?.worldId ?? '')
  const name = String(botName ?? '').trim()
  teamView.botTeam = name
    ? teamView.teams.find((t) => (t.members || []).some((m) => m.avatar_id === name)) || null
    : null
  // 坐标只对本队可见：不在队里就**不请求**（省一次必然被拒的往返），并如实说明。
  if (!teamView.botTeam) {
    teamView.chestPhase = 'ok'
    teamView.chestMessage = name ? `「${name}」不在任何队伍里：看不到共享仓坐标` : '面板还没选中 bot：看不到共享仓坐标'
    return
  }
  await loadTeamChests(teamView.botTeam.id, name)
}

/** 共享仓坐标（服务端：只有队员能看；面板必须报 `bot`，服务端只认裁决后的身份）。 */
export async function loadTeamChests(teamId: string, botName: string): Promise<void> {
  teamView.chestPhase = 'loading'
  teamView.chestMessage = ''
  const out = await readOnce<{ chests?: TeamChestRow[] }>('team:chest-list', { bot: botName, teamId })
  teamView.chestPhase = out.phase
  teamView.chestMessage = out.message
  teamView.chests = out.phase === 'ok' && Array.isArray(out.data?.chests) ? out.data!.chests! : []
}

// ── 库存（按存档，**不按队**）──────────────────────────────────────────────

export const stockView = reactive({
  phase: 'idle' as Phase,
  message: '',
  worldId: '',
  items: [] as StockItemRow[],
  containers: [] as StockContainerRow[],
  reservations: [] as ReservationRow[],
  /**
   * 快照时**顺手作废的过期券 id 列表**（`inventorySnapshot` 的 `expired`，底层是 `voidExpired()` 的返回值）。
   * ★ 是**数组**不是数字（真机实测：`{"ok":true,...,"reservations":[…],"expired":["uuid"]}`）——
   *   早先按"数量"写，`Number([])||0` 会把它静默压成 0，等于向用户谎报"没有券被作废"。
   */
  expired: [] as string[],
  /** 账本单独一态：快照成功而账本没接时，不能把整页说成坏的。 */
  ledgerPhase: 'idle' as Phase,
  ledgerMessage: '',
  ledger: [] as LedgerRow[],
  ledgerLimit: 100,
})

export async function loadStock(): Promise<void> {
  stockView.phase = 'loading'
  stockView.message = ''
  const out = await readOnce<{
    items?: StockItemRow[]; containers?: StockContainerRow[]; reservations?: ReservationRow[]
    expired?: string[]; worldId?: string
  }>('inventory:snapshot', {})
  stockView.phase = out.phase
  stockView.message = out.message
  if (out.phase !== 'ok') {
    stockView.items = []
    stockView.containers = []
    stockView.reservations = []
    stockView.expired = []
    stockView.worldId = ''
    return
  }
  stockView.items = Array.isArray(out.data?.items) ? out.data!.items! : []
  stockView.containers = Array.isArray(out.data?.containers) ? out.data!.containers! : []
  stockView.reservations = Array.isArray(out.data?.reservations) ? out.data!.reservations! : []
  stockView.expired = Array.isArray(out.data?.expired) ? out.data!.expired! : []
  stockView.worldId = String(out.data?.worldId ?? '')
}

export async function loadLedger(limit = stockView.ledgerLimit): Promise<void> {
  stockView.ledgerPhase = 'loading'
  stockView.ledgerMessage = ''
  const out = await readOnce<{ entries?: LedgerRow[] }>('inventory:ledger', { limit })
  stockView.ledgerPhase = out.phase
  stockView.ledgerMessage = out.message
  stockView.ledger = out.phase === 'ok' && Array.isArray(out.data?.entries) ? out.data!.entries! : []
}

/** 预占中（status='held'）：服务端快照已经只回 held 行，这里再筛一次是防回执形状变化。 */
export const heldReservations = computed(() => stockView.reservations.filter((r) => r.status === 'held'))

/** 待对账：`dirty=1` 的容器 —— "上次取用结果不确定，缓存不能当账"。 */
export const dirtyContainers = computed(() => stockView.containers.filter((c) => c.dirty))

/** 对账差异 = 账本里 `reason='reconcile'` 的行（服务端对账只把**真实差额**写账）。 */
export const reconcileRows = computed(() => stockView.ledger.filter((r) => r.reason === 'reconcile'))

/** 可用量为负 = 预占超过缓存里的已知量（对账会报警的那一类）。 */
export const negativeItems = computed(() => stockView.items.filter((i) => i.available < 0))

// ── 事件（`_global` events 只读时间线）─────────────────────────────────────

/**
 * ★ 面板约定的只读入口（t7 由 wire-control 在 `mindserver.js` 接线）：
 *   `events:since {since:number|{at,id}, kind?, limit?}` → `{ok:true, events:[…], count}`
 *   对应 `global_store.sinceEvents()`（`at` 升序、同 `at` 按 `id` 升序，宁重不漏）。
 *   `since` 是**毫秒**（`at >= since`，含边界 ⇒ 会重复，面板按 id 去重）或 `{at,id}` 元组（严格 `>`）。
 *   服务端把 `limit` 夹到 500 上限 ⇒ 面板不假设一次取完，一页满就继续用游标往下拉。
 */
export const EVENTS_SINCE_EVENT = 'events:since'
/** `events:stats` → `{ok:true, kinds:[{kind,count,firstAt,lastAt}]}`（`statsByKind`）；没接就退回静态白名单。 */
export const EVENTS_STATS_EVENT = 'events:stats'

/**
 * 服务端对 `events:since` 的参数拒绝原因（t7 的字面量，见 wiring-web.md §5.1）。
 * 出现这几个 ⇒ 服务端**已经接了**这个事件，只是这次请求不合法 —— 与"压根没接"必须分开说。
 */
const EVENTS_PARAM_REASONS = new Set(['since-invalid', 'kind-invalid', 'limit-invalid', 'internal'])

/** kind 白名单的**只读副本**（来源 `global_store.js:EVENT_KINDS`）。服务端会拒绝白名单外的 kind。 */
export const EVENT_KINDS_READONLY: readonly string[] = [
  'identity.claim', 'identity.invite', 'identity.revoke', 'identity.recover', 'identity.relink',
  'avatar.retire',
  'team.create', 'team.join', 'team.leave', 'team.disband',
  'inventory.reserve', 'inventory.settle', 'inventory.reconcile', 'inventory.rollback',
  'world.migrate', 'world.reset',
  'federation.visit', 'federation.depart', 'federation.card',
  'federation.grant', 'federation.relations', 'federation.peer',
  'block.break', 'block.place', 'block-change',
  'chat.say', 'chat.receive',
  'player.join', 'player.quit',
]

/** 时间窗：面板只读"最近 N"，不给"全库从头扫"的入口（重库/几万行会把浏览器拖死）。 */
export const EVENT_WINDOWS: { label: string; ms: number }[] = [
  { label: '最近 15 分钟', ms: 15 * 60_000 },
  { label: '最近 1 小时', ms: 60 * 60_000 },
  { label: '最近 24 小时', ms: 24 * 60 * 60_000 },
  { label: '最近 7 天', ms: 7 * 24 * 60 * 60_000 },
  { label: '全部（从最早开始）', ms: 0 },
]

export const eventsView = reactive({
  phase: 'idle' as Phase,
  message: '',
  kind: '',
  windowMs: 24 * 60 * 60_000,
  limit: 200,
  events: [] as GlobalEventRow[],
  /** 已读到的最末一条（`{at,id}` 元组游标；服务端按它严格向后翻）。 */
  cursor: null as { at: number; id: string } | null,
  /** 还有没有更多：回执行数 == limit 就认为可能还有（服务端不给 total，这里如实标"可能"）。 */
  mayHaveMore: false,
  loadingMore: false,
  moreMessage: '',
})

function sinceOfWindow(windowMs: number): number {
  const w = Number(windowMs) || 0
  return w > 0 ? Date.now() - w : 0
}

/**
 * 事件视图必须能说清**两种完全不同**的"空"（captain 2026-11-13 明确要求）：
 *   · 服务端没接这个事件 ⇒ "功能没做"；· 接了但没有记录 ⇒ "还没发生过事"。
 * 第三句是补的实话：服务端接了、但这次参数被拒（`since-invalid` 等）—— 那不是"没数据"。
 */
function eventsMessage(out: ReadOut<unknown>): string {
  if (out.phase === 'not-wired') {
    return '服务端未接 events:since，事件视图暂不可用（面板这边已就绪，服务端接上即出数）'
  }
  if (out.phase === 'error') {
    if (out.reason && !EVENTS_PARAM_REASONS.has(out.reason) && out.reason !== 'NO_ACK') return out.message
    return `服务端已接 events:since，但这次读取被拒：${out.message}`
  }
  return ''
}

export async function loadEvents(reset = true): Promise<void> {
  if (reset) {
    eventsView.phase = 'loading'
    eventsView.message = ''
    eventsView.events = []
    eventsView.cursor = null
    eventsView.mayHaveMore = false
    eventsView.moreMessage = ''
  }
  const since: any = reset ? sinceOfWindow(eventsView.windowMs) : (eventsView.cursor ?? sinceOfWindow(eventsView.windowMs))
  const payload: any = { since, limit: eventsView.limit }
  if (eventsView.kind) payload.kind = eventsView.kind
  const out = await readOnce<{ events?: GlobalEventRow[]; count?: number }>(EVENTS_SINCE_EVENT, payload)
  if (reset) {
    eventsView.phase = out.phase
    eventsView.message = eventsMessage(out)
  } else if (out.phase !== 'ok') {
    eventsView.moreMessage = eventsMessage(out) || out.message
    return
  }
  if (out.phase !== 'ok') return
  const rows = Array.isArray(out.data?.events) ? out.data!.events! : []
  eventsView.events = reset ? rows : mergeEvents(eventsView.events, rows)
  const last = eventsView.events[eventsView.events.length - 1]
  eventsView.cursor = last ? { at: Number(last.at), id: String(last.id) } : eventsView.cursor
  // 窗口用 `at >= since`（宁重不漏）：回执满一页就只能说"可能还有"，不能断言"就这些"
  eventsView.mayHaveMore = rows.length >= eventsView.limit
  eventsView.moreMessage = ''
}

function mergeEvents(a: GlobalEventRow[], b: GlobalEventRow[]): GlobalEventRow[] {
  const seen = new Set(a.map((e) => String(e.id)))
  const out = a.slice()
  for (const e of b) if (!seen.has(String(e.id))) { seen.add(String(e.id)); out.push(e) }
  out.sort((x, y) => (Number(x.at) - Number(y.at)) || (String(x.id) < String(y.id) ? -1 : 1))
  return out
}

/** 下一批（时间上更晚的）：`since` 用元组游标，同毫秒也不漏。 */
export async function loadMoreEvents(): Promise<void> {
  if (eventsView.loadingMore || !eventsView.cursor) return
  eventsView.loadingMore = true
  try { await loadEvents(false) } finally { eventsView.loadingMore = false }
}

/**
 * kind 统计（`events:stats` → `statsByKind`）。**只用来填过滤下拉**：
 * 没接/取不到就退回静态白名单，并在界面上说清"这份清单是静态副本"。
 */
export const eventsStats = reactive({
  phase: 'idle' as Phase,
  message: '',
  kinds: [] as { kind: string; count: number; firstAt: number; lastAt: number }[],
})

export async function loadEventStats(): Promise<void> {
  eventsStats.phase = 'loading'
  eventsStats.message = ''
  const out = await readOnce<{ kinds?: { kind: string; count: number; firstAt: number; lastAt: number }[] }>(
    EVENTS_STATS_EVENT, {},
  )
  eventsStats.phase = out.phase
  eventsStats.message = out.message
  eventsStats.kinds = out.phase === 'ok' && Array.isArray(out.data?.kinds) ? out.data!.kinds! : []
}

/** 过滤下拉的 kind 清单：服务端统计优先，否则静态白名单副本。 */
export const kindOptions = computed<string[]>(() =>
  eventsStats.kinds.length ? eventsStats.kinds.map((k) => k.kind) : EVENT_KINDS_READONLY.slice(),
)

/** 这份 kind 清单是哪来的（界面上必须写，别让人以为是实时统计）。 */
export const kindSourceNote = computed(() =>
  eventsStats.kinds.length
    ? `来自服务端 events:stats（${eventsStats.kinds.length} 种）`
    : '静态副本（global_store.EVENT_KINDS）：events:stats 未接或没取到',
)

/**
 * 事件 → 可显示文本：**先剔掉 token/hash 这类字段**再序列化。
 * 服务端本来就只写"标识"，这里是第二道闸（防将来有人往 payload 里塞凭据后直接铺到屏幕上）。
 */
const SECRET_KEY_RE = /(token|secret|passwd|password|hash|sha256|pubkey|private|signature|sig)$/i

export function redactPayload(payload: any): any {
  if (payload == null) return payload
  if (Array.isArray(payload)) return payload.map(redactPayload)
  if (typeof payload !== 'object') return payload
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(payload)) {
    out[k] = SECRET_KEY_RE.test(k) ? '（已隐藏）' : redactPayload(v)
  }
  return out
}

export function payloadText(payload: any): string {
  try {
    const s = JSON.stringify(redactPayload(payload))
    if (!s) return ''
    return s.length > 300 ? s.slice(0, 300) + '…（已截断）' : s
  } catch {
    return '（payload 无法序列化）'
  }
}

// ── 联邦 ──────────────────────────────────────────────────────────────────

export const federationView = reactive({
  phase: 'idle' as Phase,
  message: '',
  grants: [] as VisitGrantRow[],
  knownPeers: [] as KnownPeerRow[],
  allowedPeers: [] as AllowedPeerRow[],
  /** null = 服务端没回这个字段（旧版本）；false = 接线未完成（**现在不会有人被判访客**）。 */
  visitorWired: null as boolean | null,
})

export async function loadFederation(): Promise<void> {
  federationView.phase = 'loading'
  federationView.message = ''
  const out = await readOnce<FederationStatusResult>('federation-status', {})
  federationView.phase = out.phase
  federationView.message = out.message
  if (out.phase !== 'ok') {
    federationView.grants = []
    federationView.knownPeers = []
    federationView.allowedPeers = []
    federationView.visitorWired = null
    return
  }
  const d = out.data!
  federationView.grants = Array.isArray(d.grants) ? d.grants : []
  federationView.knownPeers = Array.isArray(d.knownPeers) ? d.knownPeers : []
  federationView.allowedPeers = Array.isArray(d.allowedPeers) ? d.allowedPeers : []
  federationView.visitorWired = typeof d.visitorWired === 'boolean' ? d.visitorWired : null
}

/** 凭证状态（客户端算，只用于显示）：已作废 > 已用尽 > 已过期 > 待用。 */
export function grantState(g: VisitGrantRow, now = Date.now()): { label: string; tone: string } {
  if (g.revokedAt) return { label: '已作废', tone: 'bad' }
  const max = Number(g.maxUses ?? 1)
  const used = Number(g.usedCount ?? 0)
  if (Number.isFinite(max) && used >= max) return { label: '已用尽', tone: 'plain' }
  const exp = Number(g.expiresAt ?? 0)
  if (Number.isFinite(exp) && exp > 0 && exp <= now) return { label: '已过期', tone: 'plain' }
  return { label: '待用', tone: 'ok' }
}

// ── 时钟：预占到期的倒计时要自己走，不能等人按刷新 ────────────────────────

export const clock = reactive({ now: Date.now() })
let clockTimer: ReturnType<typeof setInterval> | null = null

export function ensureClock(): void {
  if (clockTimer) return
  clockTimer = setInterval(() => { clock.now = Date.now() }, 1000)
}
