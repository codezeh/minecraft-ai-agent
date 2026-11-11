/**
 * 把服务端/传输层的原因码翻成能照做的人话（W14）。
 *
 * 依据：IdentityPanel 早就证明这套翻译是必要的，但只覆盖了 identity 一组；
 * 地形/诊断/任务状态仍在直出 `agent_not_in_game` / `get-task-state timeout` 这类内部串。
 */
const MAP: Record<string, string> = {
  OFFLINE: '未连接到 mindserver（这条请求根本没发出去）',
  agent_not_in_game: 'agent 不在游戏里 —— 先启动它，等它进服再试',
  unknown_agent: 'mindserver 里没有这个 agent（可能已被删除）',
  panel_only: '这条操作只允许从面板发起',
  rate_limited: '太频繁了，等一分钟再试',
  need_uuid_or_name: '需要指定是哪个玩家',
  CONFIG_CONFIRM_REQUIRED: '这是危险开关（本机 root），需要再确认一次（再点一次创建）',
  '空响应': '服务端没有返回内容',
  '超时': '等服务端回执超时（服务端可能没注册这个 relay，或该 agent 卡住了）',
}

export function humanize(reason?: string | null): string {
  const r = String(reason ?? '').trim()
  if (!r) return '失败（服务端没有给出原因）'
  const hit = MAP[r]
  if (hit) return hit
  if (/timeout/i.test(r)) return '等待超时：' + r + '（服务端可能未订阅/agent 卡住）'
  if (/agent_not_in_game/.test(r)) return MAP.agent_not_in_game
  return r
}

/**
 * 控制面回执的 `code` → 人话（emitControl 的失败分支专用）。
 *
 * 为什么和上面的 MAP 分开：那边翻的是服务端 `reason`（snake_case），
 * 这边翻的是**协议码**（大写下划线），两套词表混在一起早晚翻错。
 */
const CONTROL_MAP: Record<string, string> = {
  RATE_LIMITED: '太频繁，请稍后',
  NOT_IN_GAME: '这只 bot 不在游戏里',
  PANEL_ONLY: '只有面板能操作',
  ALREADY_RUNNING: '已经在跑了',
  UNKNOWN_RESULT: '结果未知，请刷新确认',
  OFFLINE: '未连接到 mindserver，这条操作没有发出去',
  UNKNOWN_AGENT: '没有这只 bot（可能已被删除）',
  NOT_RUNNING: '这只 bot 没有在运行',
  BAD_REQUEST: '请求内容不合法（服务端拒收）',
}

/** 已知码翻人话；未知码退回服务端给的 message，再退回码本身。 */
export function humanizeControl(code?: string | null, fallback?: string | null): string {
  const c = String(code ?? '').trim()
  if (c && CONTROL_MAP[c]) return CONTROL_MAP[c]
  const f = String(fallback ?? '').trim()
  if (f) return f
  return c || '操作失败（服务端没有给出原因）'
}
