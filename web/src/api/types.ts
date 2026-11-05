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

export const TYPE_META: Record<number, { name: string; color: string }> = {
  0: { name: '实心', color: '#5c8a4a' },
  1: { name: '水面', color: '#2f6dd0' },
  2: { name: '岩浆', color: '#e0483a' },
  3: { name: '建筑', color: '#c98b3e' },
  4: { name: '树叶', color: '#3fa34d' },
  5: { name: '可攀爬', color: '#d8b23c' },
  6: { name: '水下地面', color: '#2a8f8f' },
}
