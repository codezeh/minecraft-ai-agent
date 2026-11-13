/**
 * 只读视图的时间显示（t3）。毫秒时间戳 → 人能扫一眼的绝对时间 + 相对时间。
 *
 * 为什么不用 `toLocaleString()` 一把梭：面板在「预占到期」「事件发生在多久前」这两处要的是
 * **相对时间**（还剩 12s / 3 分钟前），绝对时间只是兜底；两者混在一起会让人反复心算。
 */

/** 绝对时间：`MM-DD HH:MM:SS`（跨年才带年，省宽度）。 */
export function fmtTime(ms?: number | null): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '-'
  const d = new Date(n)
  const p = (v: number) => String(v).padStart(2, '0')
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const day = `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return sameYear ? `${day} ${clock}` : `${d.getFullYear()}-${day} ${clock}`
}

/** 相对时间：过去（3 分钟前）或未来（还剩 12s）都用它，`0`/非法值回 `-`。 */
export function fmtAgo(ms?: number | null, now = Date.now()): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '-'
  const diff = n - now
  const future = diff > 0
  const abs = Math.abs(diff)
  const sec = Math.round(abs / 1000)
  let text: string
  if (sec < 60) text = `${sec}s`
  else if (sec < 3600) text = `${Math.round(sec / 60)} 分钟`
  else if (sec < 86400) text = `${Math.round(sec / 3600)} 小时`
  else text = `${Math.round(sec / 86400)} 天`
  return future ? `还剩 ${text}` : `${text}前`
}

/** 时长（毫秒）→ `2h30m` 这种紧凑写法，给"时间窗"下拉用。 */
export function fmtWindow(ms: number): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '全部'
  const h = n / 3600_000
  if (h < 1) return `${Math.round(n / 60_000)} 分钟`
  if (h < 24) return `${Math.round(h)} 小时`
  return `${Math.round(h / 24)} 天`
}
