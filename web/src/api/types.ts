// 与后端 socket 契约对应的类型。手抄，不把后端 TS 化。
// 来源：src/agent/library/full_state.js、mindserver.js、terrain3d.js

export interface AgentInfo {
  name: string
  in_game: boolean
  viewerPort?: number
  socket_connected: boolean
}

export interface Vec3 { x: number; y: number; z: number }

export interface FullState {
  name: string
  gameplay: {
    position: Vec3
    dimension: string
    gamemode: string
    health: number
    hunger: number
    biome: string
    weather: string
    timeOfDay: number
    timeLabel: string
  }
  action: { current: string; kind: string; isIdle: boolean }
  surroundings: { below: string; legs: string; head: string; firstBlockAboveHead?: string }
  inventory: {
    counts: Record<string, number>
    stacksUsed: number
    totalSlots: number
    equipment: {
      helmet: string | null
      chestplate: string | null
      leggings: string | null
      boots: string | null
      mainHand: string | null
    }
  }
  nearby: { humanPlayers: string[]; botPlayers: string[]; entityTypes: string[] }
  modes?: { summary: string }
  facing?: { name: string; text: string } | null
  lastFailure?: any
}

// request-terrain → terrain3d.boxSurfaces 的打包结果。
// pos 是 base64 的 Int16Array（每面 3 个：x,y,z 相对 origin），types 是 base64 的 Uint8Array。
export interface TerrainResult {
  ok: boolean
  reason?: string
  bbox?: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }
  origin?: [number, number, number]
  dtype?: 'int16' | 'int32'
  count?: number
  pos?: string
  types?: string
  fails?: { x: number; y: number; z: number; hits: number }[]
  lod?: number
  mode?: 'around' | 'full'
  ms?: number
}

// 方块类型码（terrain3d.js:27 的 T）
export const T = {
  SOLID: 0,
  WATER: 1,
  LAVA: 2,
  BUILT: 3,
  LEAVES: 4,
  CLIMBABLE: 5,
  SUBMERGED: 6,
} as const

// ══════════════════════════════════════════════════════════════════════════
// t3：存档只读视图的契约（**手抄自服务端实现**，不是猜的）
//
// 来源：`board_server.js` 的 team:list / team:chest-list / inventory:snapshot /
// inventory:ledger，`board_store.js` 的 teamRowToObj，`board_inventory.js` 的
// reservationRowToObj / ledgerRowToObj，`mindserver.js` 的 federation-status。
// ★ 这些事件**只有字段投影，没有 token/hash**（服务端已白名单拷贝，见 wiring-control.md §8）。
// ══════════════════════════════════════════════════════════════════════════

/** 队伍成员（board_store.listTeams 的 members[]；avatar_id 是 bot 名）。 */
export interface TeamMemberRow {
  avatar_id: string
  role: string
  joined_at: number
}

/** 一支队伍（board_store.teamRowToObj + members + chests 计数）。 */
export interface TeamRow {
  id: string
  world_id: string
  name: string
  created_by: string
  created_at: number
  members: TeamMemberRow[]
  /** 共享仓**登记数量**（坐标要另走 team:chest-list）。 */
  chests: number
}

/** 共享仓坐标（team:chest-list 的 chests[]）。 */
export interface TeamChestRow {
  x: number
  y: number
  z: number
  added_by: string | null
  added_at: number
}

/** 库存快照的物品行（known - reserved = available，服务端算好的）。 */
export interface StockItemRow {
  item: string
  known: number
  reserved: number
  available: number
}

/** 容器缓存行（dirty=true 表示"取用结果不确定，别拿它当账"）。 */
export interface StockContainerRow {
  x: number
  y: number
  z: number
  items: Record<string, number>
  updated_at: number
  dirty: boolean
}

/** 预占券（status: held / consumed / released / void）。 */
export interface ReservationRow {
  id: string
  world_id: string
  item: string
  qty: number
  holder: string
  created_at: number
  expires_at: number
  status: string
  consumed_qty: number | null
  closed_at: number | null
}

/** 账本行（reason: take / release / reconcile；reconcile 的 delta 就是**对账差异**）。 */
export interface LedgerRow {
  id: string
  world_id: string
  item: string
  delta: number
  holder: string | null
  reason: string
  at: number
}

/** 联邦访问凭证（federation-status.grants[] —— 白名单 10 字段，**没有 token/token_sha256**）。 */
export interface VisitGrantRow {
  grantId: string
  hostId?: string
  guestId?: string
  issuedAt?: number
  expiresAt?: number
  maxUses?: number
  usedCount?: number
  usedAt?: number | null
  revokedAt?: number | null
  note?: string | null
}

/** 已知对端（**没有公钥**，只有 id/地址/首末见面/名片序号）。 */
export interface KnownPeerRow {
  peerId: string
  lastAddr: string | null
  firstSeen: number
  lastSeen: number
  cardSeq: number
}

/** 白名单对端（只 peerId/addedAt/note）。 */
export interface AllowedPeerRow {
  peerId: string
  addedAt: number
  note: string | null
}

export interface FederationStatusResult {
  ok: boolean
  reason?: string
  grants?: VisitGrantRow[]
  knownPeers?: KnownPeerRow[]
  allowedPeers?: AllowedPeerRow[]
  /** **诚实的现状**：凭证接线完成前恒 false ⇒ 没有人会被判成访客。 */
  visitorWired?: boolean
}

/**
 * `_global` events 的只读行（global_store.rowToEvent 的形状）。
 *
 * ★ 目前**没有任何 socket 事件**返回它（服务端未接，见 docs/audit-r6/fixes4/wiring-web.md §5）；
 * 面板按约定形状实现，服务端接上 `events:since` 即点亮。
 */
export interface GlobalEventRow {
  id: string
  worldId: string | null
  avatarId: string | null
  kind: string
  payload: any
  at: number
}

export const TYPE_META: Record<number, { name: string; color: string }> = {
  0: { name: '实心', color: '#5c8a4a' },
  1: { name: '水面', color: '#2f6dd0' },
  2: { name: '岩浆', color: '#e0483a' },
  3: { name: '建筑', color: '#c98b3e' },
  4: { name: '树叶', color: '#3fa34d' },
  5: { name: '可攀爬', color: '#d8b23c' },
  6: { name: '水下地面', color: '#2a8f8f' },
}
