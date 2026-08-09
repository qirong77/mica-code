export const DAY_MS = 86400000

/** 本地日历日键 'YYYY-MM-DD'（基于机器本地时区） */
export function localDayKey(ms) {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 'YYYY-MM-DD' 键的本地当日零点毫秒 */
export function dayStartMs(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** 本地日 day 往后 n 天（n 可为负） */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + n)
  return localDayKey(dt.getTime())
}

/** 本地日键的星期：0=周日 … 6=周六 */
export function weekdayOf(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** [startDay, endDay] 闭区间内的本地天数 */
export function daysBetween(startDay, endDay) {
  if (startDay > endDay) return 0
  return Math.round((dayStartMs(endDay) - dayStartMs(startDay)) / DAY_MS) + 1
}

/** 一周七天的星期标签，用于日历左侧（仅 1/3/5 行显示，GitHub 惯例） */
export const CAL_WEEKDAYS = [
  { row: 1, label: 'Mon' },
  { row: 3, label: 'Wed' },
  { row: 5, label: 'Fri' }
]

/**
 * 将 [startDay, endDay] 展开成 GitHub 风格日历网格：每列是一周（周日至周六，
 * 行 0 = 周日），从左到右旧到新。窗口首尾补齐到整周，补齐的格子 inRange=false。
 */
export function calendarGrid(startDay, endDay) {
  if (startDay > endDay) return []
  const gridStart = addDays(startDay, -weekdayOf(startDay))
  const gridEnd = addDays(endDay, 6 - weekdayOf(endDay))
  const weeks = []
  let day = gridStart
  for (let w = 0; w < 60 && day <= gridEnd; w++) {
    const col = []
    for (let r = 0; r < 7; r++) {
      col.push({ day, inRange: day >= startDay && day <= endDay })
      day = addDays(day, 1)
    }
    weeks.push(col)
  }
  return weeks
}

/**
 * 将窗口内正值切成 levels-1 个分位阈值（升序），使色阶适配实际分布。
 * level 0 保留给无活动天，所以只有正值参与分位。
 */
export function intensityThresholds(values, levels = 5) {
  const bands = Math.max(1, levels - 1)
  if (bands <= 1) return []
  const pos = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (pos.length === 0) return []
  const out = []
  for (let i = 1; i < bands; i++) {
    const idx = Math.min(pos.length - 1, Math.floor((i / bands) * pos.length))
    out.push(pos[idx])
  }
  return out.filter((v, i) => i === 0 || v !== out[i - 1])
}

/** 值对应的 0-based 强度：<=0 为 0（无活动），否则 1 + 达到的阈值数 */
export function intensityLevel(value, thresholds) {
  if (value <= 0) return 0
  let level = 1
  for (const t of thresholds) if (value >= t) level++
  return level
}

/** 每个月份在网格中首次出现的列索引，用于日历顶部月份标签 */
export function monthLabelCols(weeks) {
  const out = []
  const seen = new Set()
  weeks.forEach((col, ci) => {
    const cell = col.find((c) => c.inRange)
    if (!cell) return
    const month = cell.day.slice(0, 7)
    if (seen.has(month)) return
    seen.add(month)
    out.push({ col: ci, firstDay: cell.day })
  })
  return out
}

/** 柱状图 Y 轴“漂亮”上限：向上取整到 1/2/5 × 10^n */
export function niceAxisMax(dataMax) {
  if (!Number.isFinite(dataMax) || dataMax <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(dataMax)))
  const norm = dataMax / pow
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * pow
}

/** 0 到 axisMax 之间最多 count+1 个等距刻度（取整后去重） */
export function axisTicks(axisMax, count = 4) {
  if (!Number.isFinite(axisMax) || axisMax <= 0) return [0]
  const step = axisMax / count
  const all = Array.from({ length: count + 1 }, (_, i) => Math.round(i * step))
  return all.filter((v, i) => i === 0 || v !== all[i - 1])
}

/** 升序去重日键（'YYYY-MM-DD'）中最长连续天数 */
export function longestStreak(days) {
  let best = 0
  let run = 0
  let prev = null
  for (const day of days) {
    run = prev !== null && addDays(prev, 1) === day ? run + 1 : 1
    if (run > best) best = run
    prev = day
  }
  return best
}

/** 截止今天（今天无活动则锚定昨天）的连续活跃天数 */
export function currentStreak(days, today) {
  const set = new Set(days)
  let anchor = today
  if (!set.has(anchor)) anchor = addDays(anchor, -1)
  if (!set.has(anchor)) return 0
  let n = 0
  let day = anchor
  while (set.has(day)) {
    n++
    day = addDays(day, -1)
  }
  return n
}
