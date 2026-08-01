import { Fragment, useEffect, useMemo, useState } from 'react'
import { BarSeries, CalendarHeatmap } from './charts'
import {
  DAY_MS,
  addDays,
  calendarGrid,
  currentStreak,
  dayStartMs,
  daysBetween,
  intensityLevel,
  intensityThresholds,
  localDayKey,
  longestStreak,
  monthLabelCols
} from './geometry'

const RANGE_OPTIONS = [
  ['today', 'Today'],
  ['7d', '7d'],
  ['30d', '30d'],
  ['90d', '90d'],
  ['all', 'All']
]
const PROJECT_BATCH = 7
const SESSION_BATCH = 11
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]
const CALENDAR_RAMP = ['#1e1e1e', '#525252', '#707070', '#9a9a9a', '#eaeaea']

const CARD_CLASS = 'rounded-[5px] border border-[#2a2a2a] bg-[#141414]'
const OVERLINE_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a8a]'

function isDayRange(range) {
  return typeof range === 'object'
}

/** 范围起点（毫秒）：preset 为区间起点，day 为当天零点，all 为 0 */
function rangeStart(range) {
  if (isDayRange(range)) return dayStartMs(range.day)
  if (range === 'all') return 0
  const now = Date.now()
  if (range === 'today') return dayStartMs(localDayKey(now))
  return now - Number.parseInt(range, 10) * DAY_MS
}

/** 范围总天数：today=1、Nd=N、all=最早活动日到今天、day=1 */
function rangeWindowDays(range, minDay) {
  if (isDayRange(range)) return 1
  if (range === 'all') {
    if (!minDay) return 0
    return Math.max(1, daysBetween(minDay, localDayKey(Date.now())))
  }
  if (range === 'today') return 1
  return Number.parseInt(range, 10)
}

function sessionInRange(session, range) {
  if (isDayRange(range)) return localDayKey(session.updatedAtMs) === range.day
  if (range === 'all') return true
  return session.updatedAtMs >= rangeStart(range)
}

function basename(cwd) {
  if (!cwd) return '~'
  const parts = String(cwd).split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cwd
}

function tokensShort(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function agoShort(ms, now) {
  const diff = now - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function dayShort(day) {
  const d = day.split('-')
  return `${Number(d[1])}/${Number(d[2])}`
}

/** 有模型请求的会话按 updatedAt 聚合到天。旧 session 没有 usage 时间戳，只能按最后活动日归档。 */
function bucketByDay(sessions) {
  const map = new Map()
  for (const s of sessions) {
    const requests = Number(s.requests) || 0
    if (requests <= 0) continue
    const day = localDayKey(s.updatedAtMs)
    const row = map.get(day) || { day, sessions: 0, requests: 0, turns: 0, tokens: 0 }
    row.sessions++
    row.requests += requests
    row.turns += s.turns
    row.tokens += s.totalTokens
    map.set(day, row)
  }
  return map
}

function KpiTile({ label, value, title, className = '' }) {
  return (
    <div className={`flex min-w-0 flex-col px-4 py-3.5 ${className}`} title={title}>
      <div className={OVERLINE_CLASS}>{label}</div>
      <div className="mt-1.5 truncate font-mono text-base font-medium leading-tight tracking-tight text-[#eaeaea] tabular-nums">
        {value}
      </div>
    </div>
  )
}

/** 主卡：8 格 KPI + 贡献日历活跃图 */
function OverviewCard({ snap, range, onSelectDay, calendar }) {
  const sessions = snap.sessions
  const scoped = useMemo(
    () => sessions.filter((session) => sessionInRange(session, range)),
    [sessions, range]
  )

  const allDays = useMemo(() => {
    const days = new Set()
    for (const s of sessions) {
      if ((Number(s.requests) || 0) > 0) days.add(localDayKey(s.updatedAtMs))
    }
    return [...days].sort()
  }, [sessions])

  const totals = useMemo(() => {
    let activeSessions = 0
    let requests = 0
    let inputTokens = 0
    let outputTokens = 0
    let cachedInputTokens = 0
    let processedTokens = 0
    for (const s of scoped) {
      const sessionRequests = Number(s.requests) || 0
      if (sessionRequests > 0) activeSessions++
      requests += sessionRequests
      inputTokens += Number(s.inputTokens) || 0
      outputTokens += Number(s.outputTokens) || 0
      cachedInputTokens += Number(s.cachedInputTokens) || 0
      processedTokens += Number(s.totalTokens) || 0
    }
    return {
      activeSessions,
      requests,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      processedTokens,
      cacheRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0
    }
  }, [scoped])

  const topModel = useMemo(() => {
    const byModel = new Map()
    for (const s of scoped) {
      for (const usage of s.modelUsage || []) {
        const row = byModel.get(usage.model) || { model: usage.model, tokens: 0, requests: 0 }
        row.tokens += usage.totalTokens
        row.requests += usage.requests
        byModel.set(usage.model, row)
      }
    }
    let best = null
    for (const row of byModel.values()) {
      if (!best || row.tokens > best.tokens) best = row
    }
    return best
  }, [scoped])

  const scopedDays = useMemo(() => {
    const days = new Set()
    for (const s of scoped) {
      if ((Number(s.requests) || 0) > 0) days.add(localDayKey(s.updatedAtMs))
    }
    return days
  }, [scoped])

  const windowDays = rangeWindowDays(range, allDays[0])
  const activeDays = scopedDays.size

  const mostActive = useMemo(() => {
    const byDay = bucketByDay(scoped)
    let best = null
    for (const row of byDay.values()) {
      if (!best || row.sessions > best.sessions) best = row
    }
    return best || null
  }, [scoped])

  const streaks = useMemo(() => {
    const today = localDayKey(Date.now())
    return {
      longest: longestStreak(allDays),
      current: currentStreak(allDays, today)
    }
  }, [allDays])

  const cellBorder = (i) =>
    `border-[#1e1e1e] ${(i + 1) % 4 === 0 ? '' : 'border-r'} ${i < 4 ? 'border-b' : ''}`

  const byDayMap = useMemo(() => bucketByDay(sessions), [sessions])
  const calendarWeeks = calendar.calendarWeeks
  const thresholds = useMemo(
    () =>
      intensityThresholds(
        calendarWeeks
          .flat()
          .filter((c) => c.inRange)
          .map((c) => byDayMap.get(c.day)?.tokens || 0),
        CALENDAR_RAMP.length
      ),
    [calendarWeeks, byDayMap]
  )
  const levelOf = (day) => intensityLevel(byDayMap.get(day)?.tokens || 0, thresholds)
  const monthLabels = useMemo(
    () =>
      monthLabelCols(calendarWeeks).map((m) => ({
        col: m.col,
        label: MONTH_SHORT[Number(m.firstDay.slice(5, 7)) - 1]
      })),
    [calendarWeeks]
  )

  const describeDay = (day) => {
    const row = byDayMap.get(day)
    return `${day}: ${row ? `${row.sessions} sessions, ${row.tokens.toLocaleString()} tokens` : 'No activity'}`
  }

  return (
    <section className={CARD_CLASS}>
      <div className="grid grid-cols-4">
        <KpiTile
          label="Active sessions"
          className={cellBorder(0)}
          title={`${totals.activeSessions} sessions with model usage · ${scoped.length} total sessions`}
          value={totals.activeSessions.toLocaleString()}
        />
        <KpiTile
          label="Model requests"
          className={cellBorder(1)}
          value={totals.requests.toLocaleString()}
        />
        <KpiTile
          label="Processed tokens"
          className={cellBorder(2)}
          title={totals.processedTokens.toLocaleString()}
          value={tokensShort(totals.processedTokens)}
        />
        <KpiTile
          label="Cache hit"
          className={cellBorder(3)}
          title={`${totals.cachedInputTokens.toLocaleString()} cached input tokens`}
          value={totals.inputTokens > 0 ? `${(totals.cacheRate * 100).toFixed(1)}%` : '—'}
        />
        <KpiTile
          label="Input tokens"
          className={cellBorder(4)}
          title={totals.inputTokens.toLocaleString()}
          value={tokensShort(totals.inputTokens)}
        />
        <KpiTile
          label="Output tokens"
          className={cellBorder(5)}
          title={totals.outputTokens.toLocaleString()}
          value={tokensShort(totals.outputTokens)}
        />
        <KpiTile
          label="Active days"
          className={cellBorder(6)}
          title={`${activeDays} active days in a ${windowDays}-day window`}
          value={`${activeDays}/${windowDays}`}
        />
        <KpiTile
          label="Top model"
          className={cellBorder(7)}
          title={topModel?.model}
          value={topModel?.model || '—'}
        />
      </div>
      <div aria-hidden className="h-px bg-[#1e1e1e]" />
      <div className="p-4">
        <header className="mb-4 flex items-center justify-between gap-2">
          <h2 className={OVERLINE_CLASS}>Contributions</h2>
          <select
            value={calendar.year ?? 'trailing'}
            onChange={(e) =>
              calendar.onYear(e.target.value === 'trailing' ? null : Number(e.target.value))
            }
            className="rounded-[4px] border border-[#2a2a2a] bg-[#181818] px-3 py-1.5 text-xs text-[#9a9a9a]"
            aria-label="Contributions year"
          >
            <option value="trailing">Last 12 months</option>
            {calendar.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </header>
        <CalendarHeatmap
          weeks={calendarWeeks}
          levelOf={levelOf}
          colors={CALENDAR_RAMP}
          selectedDay={isDayRange(range) ? range.day : null}
          onSelectDay={onSelectDay}
          renderTooltip={(day) => {
            const row = byDayMap.get(day)
            return (
              <div className="flex flex-col gap-0.5">
                <div className="font-medium text-white/90">{day}</div>
                <div className="text-white/50">
                  {row
                    ? `${row.sessions} sessions · ${row.requests} requests · ${tokensShort(row.tokens)} tokens`
                    : 'No activity'}
                </div>
              </div>
            )
          }}
          ariaLabelOf={describeDay}
          monthLabels={monthLabels}
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#1e1e1e] pt-3 text-[11px] text-[#707070]">
          <span>
            Busiest day{' '}
            <strong className="font-medium text-[#9a9a9a]">
              {mostActive ? `${dayShort(mostActive.day)} · ${mostActive.sessions} sessions` : '—'}
            </strong>
          </span>
          <span>
            Longest streak{' '}
            <strong className="font-medium text-[#9a9a9a]">{streaks.longest} days</strong>
          </span>
          <span>
            Current streak{' '}
            <strong className="font-medium text-[#9a9a9a]">{streaks.current} days</strong>
          </span>
          {topModel && totals.processedTokens > 0 && (
            <span>
              Top model share{' '}
              <strong className="font-medium text-[#9a9a9a]">
                {((topModel.tokens / totals.processedTokens) * 100).toFixed(1)}%
              </strong>
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

/** 每日 token 柱状图（按 updatedAt 聚合） */
function DailyCard({ sessions, range }) {
  const byDay = useMemo(() => bucketByDay(sessions), [sessions])
  const now = Date.now()
  const today = localDayKey(now)
  const since = rangeStart(range)
  const allDays = [...byDay.keys()].sort()
  const startDay = isDayRange(range)
    ? range.day
    : range === 'all'
      ? allDays[0] || today
      : localDayKey(since)
  const endDay = isDayRange(range) ? range.day : today
  const totalDays = Math.max(1, daysBetween(startDay, endDay))

  const days = useMemo(() => {
    const out = []
    let day = startDay
    for (let i = 0; i < Math.min(totalDays, 90) && day <= endDay; i++) {
      const row = byDay.get(day)
      out.push({ day, requests: row?.requests || 0, tokens: row?.tokens || 0 })
      day = addDays(day, 1)
    }
    return out
  }, [startDay, endDay, byDay, totalDays])

  const stride = Math.max(1, Math.ceil(days.length / 8))
  const lastPhase = (days.length - 1) % stride
  const xLabels = days
    .map((d, i) => ({
      index: i,
      label: d.day === today ? '今天' : dayShort(d.day)
    }))
    .filter(({ index }) => index % stride === lastPhase)

  if (days.length === 0) return null

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-4 flex items-center justify-between">
        <h2 className={OVERLINE_CLASS}>Tokens per day</h2>
        <span className="text-[11px] text-[#707070]">
          {isDayRange(range)
            ? dayShort(range.day)
            : range === 'all'
              ? '最多展示 90 天'
              : range === 'today'
                ? '今天'
                : `近 ${range}`}
        </span>
      </header>
      <BarSeries
        columns={days.map((d) => ({ key: d.day, value: d.tokens }))}
        formatTick={tokensShort}
        xLabels={xLabels}
        renderTooltip={(i) => {
          const d = days[i]
          return (
            <div className="flex flex-col gap-0.5">
              <div className="font-medium text-white/90">{d.day === today ? '今天' : d.day}</div>
              <div className="text-white/50">
                {d.requests} requests · {tokensShort(d.tokens)} tokens
              </div>
            </div>
          )
        }}
      />
    </section>
  )
}

/** 按模型聚合 */
function ByModelCard({ scoped }) {
  const rows = useMemo(() => {
    const map = new Map()
    for (const s of scoped) {
      for (const usage of s.modelUsage || []) {
        const row = map.get(usage.model) || {
          model: usage.model,
          sessions: new Set(),
          requests: 0,
          tokens: 0
        }
        row.sessions.add(s.id)
        row.requests += usage.requests
        row.tokens += usage.totalTokens
        map.set(usage.model, row)
      }
    }
    return [...map.values()]
      .map((row) => ({ ...row, sessions: row.sessions.size }))
      .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
  }, [scoped])

  if (rows.length === 0) return null
  const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0)

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-3 flex items-center justify-between">
        <h2 className={OVERLINE_CLASS}>By model</h2>
      </header>
      <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.model} className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full bg-[#c8c8c8]" />
              <span className="truncate font-mono text-xs text-[#eaeaea]" title={r.model}>
                {r.model}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-[#707070] tabular-nums">
                {totalTokens > 0 ? `${((r.tokens / totalTokens) * 100).toFixed(1)}%` : '—'}
              </span>
            </div>
            <div className="mt-0.5 pl-4 font-mono text-[11px] text-[#707070] tabular-nums">
              {r.sessions} sessions · {r.requests} requests · {tokensShort(r.tokens)} tokens
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** 按项目（cwd basename）聚合，分批展示 */
function ByProjectCard({ scoped, visibleRows, onShowMore }) {
  const rows = useMemo(() => {
    const map = new Map()
    for (const s of scoped) {
      const cwd = s.cwd || '~'
      const row = map.get(cwd) || { cwd, project: basename(cwd), sessions: 0, turns: 0, tokens: 0 }
      row.sessions++
      row.turns += s.turns
      row.tokens += s.totalTokens
      map.set(cwd, row)
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens || a.cwd.localeCompare(b.cwd))
  }, [scoped])

  if (rows.length === 0) return null
  const shown = rows.slice(0, visibleRows)
  const max = Math.max(...shown.map((r) => r.tokens), 0)
  const rest = rows.length - shown.length

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-3 flex items-center justify-between">
        <h2 className={OVERLINE_CLASS}>By project</h2>
        <span className="text-[11px] text-[#707070]">{rows.length} projects</span>
      </header>
      <div>
        {shown.map((row, index) => (
          <Fragment key={row.cwd}>
            <div className={`pt-1.5 ${index === 0 ? '' : 'mt-1 border-t border-[#1e1e1e] pt-2'}`}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-[#eaeaea]" title={row.cwd}>
                  {row.project}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-[#9a9a9a] tabular-nums">
                  {row.sessions} sessions · {tokensShort(row.tokens)}
                </span>
              </div>
              <div className="mt-1 h-[5px] overflow-hidden rounded-full bg-[#1e1e1e]">
                <div
                  className="h-full rounded-full bg-[#c8c8c8]"
                  style={{ width: `${max > 0 ? (row.tokens / max) * 100 : 0}%` }}
                />
              </div>
            </div>
          </Fragment>
        ))}
      </div>
      {rest > 0 && (
        <button
          type="button"
          onClick={onShowMore}
          className="mt-2 text-[11px] text-[#707070] transition-colors hover:text-[#9a9a9a]"
        >
          Show {Math.min(PROJECT_BATCH, rest)} more
        </button>
      )}
    </section>
  )
}

const SORT_KEYS = [
  ['lastActivity', 'Last activity'],
  ['requests', 'Requests'],
  ['tokens', 'Tokens'],
  ['cacheRate', 'Cache hit']
]

const SESSION_COLUMNS = [
  ['session', 'Session', false],
  ['model', 'Model', false],
  ...SORT_KEYS.map(([key, label]) => [key, label, true])
]

/** 按会话明细表（可排序、分批） */
function BySessionCard({ scoped }) {
  const [sortKey, setSortKey] = useState('lastActivity')
  const [desc, setDesc] = useState(true)
  const [visible, setVisible] = useState(SESSION_BATCH)

  useEffect(() => {
    setVisible(SESSION_BATCH)
  }, [sortKey, desc])

  const sorted = useMemo(() => {
    const list = scoped.slice()
    list.sort((a, b) => {
      let diff = 0
      if (sortKey === 'lastActivity') diff = a.updatedAtMs - b.updatedAtMs
      else if (sortKey === 'requests') diff = a.requests - b.requests
      else if (sortKey === 'tokens') diff = a.totalTokens - b.totalTokens
      else {
        const aRate = a.inputTokens > 0 ? a.cachedInputTokens / a.inputTokens : 0
        const bRate = b.inputTokens > 0 ? b.cachedInputTokens / b.inputTokens : 0
        diff = aRate - bRate
      }
      return desc ? -diff : diff
    })
    return list
  }, [scoped, sortKey, desc])

  if (sorted.length === 0) return null
  const top = sorted.slice(0, visible)
  const rest = sorted.length - top.length
  const now = Date.now()

  const toggle = (key) => {
    if (key === sortKey) setDesc((d) => !d)
    else {
      setSortKey(key)
      setDesc(true)
    }
  }

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-2 flex items-center justify-between">
        <h2 className={OVERLINE_CLASS}>By session</h2>
        <span className="text-[11px] text-[#707070]">{sorted.length} sessions</span>
      </header>
      <div className="overflow-x-auto thin-scrollbar">
        <table className="w-full min-w-[860px] table-fixed text-[13px]">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[16%]" />
            <col className="w-[14%]" />
            <col className="w-[10%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[#707070]">
              {SESSION_COLUMNS.map(([key, label, sortable]) => (
                <th
                  key={key}
                  scope="col"
                  className={`whitespace-nowrap pb-1.5 font-normal ${
                    key === 'requests' || key === 'tokens' || key === 'cacheRate'
                      ? 'text-right'
                      : 'text-left'
                  }`}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggle(key)}
                      className={`inline-flex items-center gap-0.5 uppercase transition-colors hover:text-[#eaeaea] ${
                        sortKey === key ? 'text-[#c8c8c8]' : ''
                      }`}
                    >
                      {label}
                      {sortKey === key && <span className="text-[8px]">{desc ? '▼' : '▲'}</span>}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {top.map((s) => (
              <tr key={s.id} className="border-t border-[#1e1e1e]">
                <td className="py-1 pr-3">
                  <span className="block truncate text-xs text-[#eaeaea]" title={s.cwd}>
                    {s.title || basename(s.cwd)}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-[#707070]">
                    {basename(s.cwd)} · {s.id ? s.id.slice(0, 8) : ''}
                  </span>
                </td>
                <td className="py-1 pr-3">
                  <span
                    className="block truncate font-mono text-[11px] text-[#9a9a9a]"
                    title={s.model}
                  >
                    {s.model || '—'}
                  </span>
                </td>
                <td className="py-1 pr-3 text-[11px] text-[#9a9a9a] tabular-nums">
                  {agoShort(s.updatedAtMs, now)}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-[#9a9a9a] tabular-nums">
                  {s.requests.toLocaleString()}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-[#9a9a9a] tabular-nums">
                  {tokensShort(s.totalTokens)}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-[#9a9a9a] tabular-nums">
                  {s.inputTokens > 0
                    ? `${((s.cachedInputTokens / s.inputTokens) * 100).toFixed(0)}%`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + SESSION_BATCH)}
          className="mt-2 text-[11px] text-[#707070] transition-colors hover:text-[#9a9a9a]"
        >
          Show {Math.min(SESSION_BATCH, rest)} more
        </button>
      )}
    </section>
  )
}

export function StatsView({ visible }) {
  const [range, setRange] = useState('30d')
  const [snap, setSnap] = useState(null)
  const [visibleRows, setVisibleRows] = useState(PROJECT_BATCH)
  const [calendarYear, setCalendarYear] = useState(null)

  useEffect(() => {
    if (!visible) return undefined
    let alive = true
    const tick = () => {
      window.mica.stats
        .read()
        .then((data) => {
          if (alive) setSnap(data)
        })
        .catch((error) => console.error('read stats failed', error))
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [visible])

  const sessions = useMemo(() => snap?.sessions || [], [snap])

  const calendar = useMemo(() => {
    const today = localDayKey(Date.now())
    const years = new Set()
    for (const s of sessions) years.add(localDayKey(s.updatedAtMs).slice(0, 4))
    const yearList = [...years].sort().reverse()
    const startDay = calendarYear != null ? `${calendarYear}-01-01` : addDays(today, -364)
    const endDay =
      calendarYear != null && calendarYear < Number(today.slice(0, 4))
        ? `${calendarYear}-12-31`
        : today
    return {
      calendarWeeks: calendarGrid(startDay, endDay),
      years: yearList,
      year: calendarYear,
      onYear: setCalendarYear
    }
  }, [sessions, calendarYear])

  const scoped = useMemo(() => {
    return sessions.filter((session) => sessionInRange(session, range))
  }, [sessions, range])
  const activeScoped = useMemo(
    () => scoped.filter((session) => (Number(session.requests) || 0) > 0),
    [scoped]
  )

  const hasAny = sessions.some((session) => (Number(session.requests) || 0) > 0)

  const setRangePreset = (value) => {
    setRange(value)
  }

  const onSelectDay = (day) => setRange({ day })

  return (
    <section
      className={`min-h-0 flex-1 flex-col overflow-hidden ${visible ? 'flex' : 'hidden'}`}
      aria-hidden={!visible}
    >
      <div className="h-full min-h-0 overflow-y-auto thin-scrollbar">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 px-6 py-6">
          <div className="flex items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              {isDayRange(range) && (
                <button
                  type="button"
                  onClick={() => setRangePreset('30d')}
                  title="清除单日筛选"
                  className="flex items-center gap-1 rounded-[4px] border border-[#2a2a2a] bg-[#181818] px-2 py-0.5 text-[11px] text-[#9a9a9a] transition-colors hover:text-[#eaeaea]"
                >
                  {dayShort(range.day)}
                  <span aria-hidden className="text-[#707070]">
                    ×
                  </span>
                </button>
              )}
              <div className="flex items-center gap-0.5 rounded-[4px] border border-[#2a2a2a] bg-[#181818] p-0.5 text-[11px]">
                {RANGE_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={range === value}
                    onClick={() => setRangePreset(value)}
                    className={`rounded-sm px-2 py-0.5 transition-colors ${
                      range === value
                        ? 'bg-[#3a3a3a] text-[#eaeaea]'
                        : 'text-[#707070] hover:text-[#9a9a9a]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {!hasAny ? (
            <div className="grid place-items-center rounded-[5px] border border-dashed border-[#2a2a2a] py-16 text-xs text-[#707070]">
              No usage yet. Complete an AI session to see statistics.
            </div>
          ) : (
            <>
              <OverviewCard
                snap={snap}
                range={range}
                onSelectDay={onSelectDay}
                calendar={calendar}
              />
              <DailyCard sessions={sessions} range={range} />
              <ByModelCard scoped={activeScoped} />
              <ByProjectCard
                scoped={activeScoped}
                visibleRows={visibleRows}
                onShowMore={() => setVisibleRows((v) => v + PROJECT_BATCH)}
              />
              <BySessionCard scoped={activeScoped} />
            </>
          )}
        </div>
      </div>
    </section>
  )
}
