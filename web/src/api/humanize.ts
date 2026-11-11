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
