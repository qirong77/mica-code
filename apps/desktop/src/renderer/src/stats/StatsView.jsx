import { Fragment, useEffect, useMemo, useState } from 'react'
import { IconChevronDown } from '@tabler/icons-react'
import { BarSeries, CalendarHeatmap } from './charts'
import { SessionDetailModal } from './SessionDetailModal'
import { bucketByDay, isDayRange, rangeStart, scopeSession } from './scope'
import { USAGE_SOURCE_LABELS } from '@packages/mica-web-shared/usage-source.js'
import {
  addDays,
  calendarGrid,
  currentStreak,
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
// 载荷是「会话 × 本地日」的聚合结果（上千个会话约 1MB，见 host/stats-core），面板只看
// 总量，半分钟一次足够；首次构建索引期间运行时另行推送 stats:changed，不靠这个间隔。
const STATS_REFRESH_MS = 30_000
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
const CALENDAR_RAMP = [
  'var(--color-heat-empty)',
  'var(--color-fg-ghost)',
  'var(--color-fg-faint)',
  'var(--color-fg-muted)',
  'var(--color-fg-strong)'
]

// 每一次模型请求都归到四类来源之一（判定在 `mica-web-shared/usage-source`）：
// 主对话、委派子代理、插件、内核后台。顺序固定，颜色只用来区分种类。
const SOURCE_ORDER = ['main', 'delegation', 'plugin', 'helper']
const SOURCE_COLORS = {
  main: 'var(--color-fg-strong)',
  delegation: 'var(--color-info)',
  plugin: 'var(--color-accent)',
  helper: 'var(--color-fg-ghost)'
}

const CARD_CLASS = 'rounded-[5px] border border-line bg-panel'
const OVERLINE_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-dim'

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

function KpiTile({ label, value, title, className = '' }) {
  return (
    <div className={`flex min-w-0 flex-col px-4 py-3.5 ${className}`} title={title}>
      <div className={OVERLINE_CLASS}>{label}</div>
      <div className="mt-1.5 truncate font-mono text-base font-medium leading-tight tracking-tight text-fg-strong tabular-nums">
        {value}
      </div>
    </div>
  )
}

/** 主卡：8 格 KPI + 贡献日历活跃图 */
function OverviewCard({ snap, range, onSelectDay, calendar }) {
  const sessions = snap.sessions
  const scoped = useMemo(
    () => sessions.map((session) => scopeSession(session, range)).filter(Boolean),
    [sessions, range]
  )

  const allDays = useMemo(() => {
    const days = new Set()
    for (const s of sessions) for (const day of s.days || []) days.add(day.day)
    return [...days].sort()
  }, [sessions])

  const totals = useMemo(() => {
    let activeSessions = 0
    let requests = 0
    let inputTokens = 0
    let outputTokens = 0
    let cachedInputTokens = 0
    let uncachedInputTokens = 0
    let processedTokens = 0
    for (const s of scoped) {
      const sessionRequests = Number(s.requests) || 0
      // 账本里的无会话用量不是一条会话，别把活跃会话数算多。
      if (sessionRequests > 0 && !s.ledger) activeSessions++
      requests += sessionRequests
      inputTokens += Number(s.inputTokens) || 0
      outputTokens += Number(s.outputTokens) || 0
      cachedInputTokens += Number(s.cachedInputTokens) || 0
      uncachedInputTokens += Number(s.uncachedInputTokens) || 0
      processedTokens += Number(s.totalTokens) || 0
    }
    return {
      activeSessions,
      requests,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      uncachedInputTokens,
      processedTokens,
      cacheRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0
    }
  }, [scoped])

  const sourceSplit = useMemo(() => {
    const byKind = new Map()
    let all = 0
    for (const s of scoped) {
      for (const row of s.sourceUsage || []) {
        const acc = byKind.get(row.kind) || { kind: row.kind, tokens: 0, requests: 0 }
        acc.tokens += Number(row.totalTokens) || 0
        acc.requests += Number(row.requests) || 0
        byKind.set(row.kind, acc)
        all += Number(row.totalTokens) || 0
      }
    }
    return SOURCE_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({
      ...byKind.get(kind),
      share: all > 0 ? byKind.get(kind).tokens / all : 0
    }))
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
    `border-line ${(i + 1) % 4 === 0 ? '' : 'border-r'} ${i < 4 ? 'border-b' : ''}`

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
          title={`${totals.requests.toLocaleString()} requests (主对话 + 委派 + 插件 + 内核后台)`}
          value={totals.requests.toLocaleString()}
        />
        <KpiTile
          label="Processed tokens"
          className={cellBorder(2)}
          title={totals.processedTokens.toLocaleString()}
          value={tokensShort(totals.processedTokens)}
        />
        <KpiTile
          label="Cache hit rate"
          className={cellBorder(3)}
          title={`${totals.cachedInputTokens.toLocaleString()} / ${totals.inputTokens.toLocaleString()} input tokens`}
          value={`${(totals.cacheRate * 100).toFixed(1)}%`}
        />
        <KpiTile
          label="Cached input"
          className={cellBorder(4)}
          title={`${totals.cachedInputTokens.toLocaleString()} tokens`}
          value={tokensShort(totals.cachedInputTokens)}
        />
        <KpiTile
          label="Uncached input"
          className={cellBorder(5)}
          title={totals.uncachedInputTokens.toLocaleString()}
          value={tokensShort(totals.uncachedInputTokens)}
        />
        <KpiTile
          label="Output tokens"
          className={cellBorder(6)}
          title={totals.outputTokens.toLocaleString()}
          value={tokensShort(totals.outputTokens)}
        />
        <KpiTile
          label="Top model"
          className={cellBorder(7)}
          title={topModel?.model}
          value={topModel?.model || '—'}
        />
      </div>
      {sourceSplit.length > 1 && (
        <>
          <div aria-hidden className="h-px bg-panel-hi" />
          <div className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className={OVERLINE_CLASS}>Usage by source</h2>
              <span className="text-[11px] text-fg-faint">
                {totals.processedTokens.toLocaleString()} tokens
              </span>
            </div>
            <div className="mt-2 flex h-[6px] overflow-hidden rounded-full bg-panel-hi">
              {sourceSplit.map((row) => (
                <div
                  key={row.kind}
                  style={{ width: `${row.share * 100}%`, background: SOURCE_COLORS[row.kind] }}
                  title={`${USAGE_SOURCE_LABELS[row.kind]} · ${(row.share * 100).toFixed(1)}%`}
                />
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-faint">
              {sourceSplit.map((row) => (
                <span key={row.kind} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: SOURCE_COLORS[row.kind] }}
                  />
                  {USAGE_SOURCE_LABELS[row.kind]}
                  <strong className="font-medium text-fg-muted tabular-nums">
                    {(row.share * 100).toFixed(1)}%
                  </strong>
                  <span className="tabular-nums">{tokensShort(row.tokens)}</span>
                </span>
              ))}
            </div>
          </div>
        </>
      )}
      <div aria-hidden className="h-px bg-panel-hi" />
      <div className="p-4">
        <header className="mb-4 flex items-center justify-between gap-2">
          <h2 className={OVERLINE_CLASS}>Contributions</h2>
          <span className="relative inline-flex items-center">
            <select
              value={calendar.year ?? 'trailing'}
              onChange={(e) =>
                calendar.onYear(e.target.value === 'trailing' ? null : Number(e.target.value))
              }
              className="appearance-none rounded-[4px] border border-line bg-panel-hi py-1.5 pl-3 pr-7 text-xs text-fg-muted focus:outline-none"
              aria-label="Contributions year"
            >
              <option value="trailing">Last 12 months</option>
              {calendar.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <IconChevronDown
              size={12}
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 text-fg-muted"
            />
          </span>
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
                <div className="font-medium text-fg-strong">{day}</div>
                <div className="text-fg-muted">
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
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[11px] text-fg-faint">
          <span>
            Busiest day{' '}
            <strong className="font-medium text-fg-muted">
              {mostActive ? `${dayShort(mostActive.day)} · ${mostActive.sessions} sessions` : '—'}
            </strong>
          </span>
          <span>
            Longest streak{' '}
            <strong className="font-medium text-fg-muted">{streaks.longest} days</strong>
          </span>
          <span>
            Current streak{' '}
            <strong className="font-medium text-fg-muted">{streaks.current} days</strong>
          </span>
          {topModel && totals.processedTokens > 0 && (
            <span>
              Top model share{' '}
              <strong className="font-medium text-fg-muted">
                {((topModel.tokens / totals.processedTokens) * 100).toFixed(1)}%
              </strong>
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

/** 每日 token 柱状图（按每次请求的 occurredAtMs 聚合） */
function DailyCard({ sessions, range }) {
  const byDay = useMemo(() => bucketByDay(sessions), [sessions])
  const now = Date.now()
  const today = localDayKey(now)
  const since = rangeStart(range)
  const allDays = [...byDay.keys()].sort()
  const startDay = isDayRange(range)
    ? range.day
    : range === 'all'
      ? allDays.length > 90
        ? addDays(today, -89)
        : allDays[0] || today
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
        <span className="text-[11px] text-fg-faint">
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
              <div className="font-medium text-fg-strong">{d.day === today ? '今天' : d.day}</div>
              <div className="text-fg-muted">
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
              <span className="size-2 shrink-0 rounded-full bg-fg" />
              <span className="truncate font-mono text-xs text-fg-strong" title={r.model}>
                {r.model}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-faint tabular-nums">
                {totalTokens > 0 ? `${((r.tokens / totalTokens) * 100).toFixed(1)}%` : '—'}
              </span>
            </div>
            <div className="mt-0.5 pl-4 font-mono text-[11px] text-fg-faint tabular-nums">
              {r.sessions} sessions · {r.requests} requests · {tokensShort(r.tokens)} tokens
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * 按来源聚合。每一类用量都在这张表里：主对话、委派出去的子代理、插件自己的请求
 * （含插件起的后台任务）与内核自带的后台请求。分成两张卡（By subagent / By plugin）
 * 曾经贴切，但委派本身就是插件提供的，界线不再成立——用户要的是「一共花了多少、
 * 花在谁身上」。
 */
// 一行来源的副标题：会话数 + 委派任务数 + 用途。委派行的用途是每个任务的 prompt 摘要
// （十几个任务拼起来就是一大段），所以委派只报任务数，插件/内核才列用途。
function sourceRowDetail(row) {
  const parts = []
  if (row.sessions > 0) parts.push(`${row.sessions} sessions`)
  if (row.kind === 'delegation') {
    if (row.tasks > 0) parts.push(`${row.tasks} tasks`)
  } else if (row.purposes.length > 0) {
    const shown = row.purposes.slice(0, 2).join(' / ')
    parts.push(row.purposes.length > 2 ? `${shown} +${row.purposes.length - 2}` : shown)
  }
  return parts.join(' · ')
}

function BySourceCard({ scoped }) {
  const rows = useMemo(() => {
    const map = new Map()
    for (const s of scoped) {
      for (const usage of s.sourceUsage || []) {
        const key = `${usage.kind}:${usage.id}`
        const row = map.get(key) || {
          key,
          kind: usage.kind,
          id: usage.id,
          sessions: new Set(),
          tasks: new Set(),
          purposes: new Set(),
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0
        }
        // 账本里的无会话用量没有 id，不能算进「几个会话」。
        if (s.id) row.sessions.add(s.id)
        for (const task of usage.tasks) row.tasks.add(task)
        for (const purpose of usage.purposes) row.purposes.add(purpose)
        row.requests += usage.requests
        row.inputTokens += usage.inputTokens
        row.outputTokens += usage.outputTokens
        row.totalTokens += usage.totalTokens
        map.set(key, row)
      }
    }
    return [...map.values()]
      .map((row) => ({
        ...row,
        sessions: row.sessions.size,
        tasks: row.tasks.size,
        purposes: [...row.purposes]
      }))
      .sort(
        (a, b) =>
          b.totalTokens - a.totalTokens ||
          SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind) ||
          a.id.localeCompare(b.id)
      )
  }, [scoped])

  if (rows.length === 0) return null
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0)

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-2 flex items-center justify-between">
        <h2 className={OVERLINE_CLASS}>By source</h2>
        <span className="text-[11px] text-fg-faint">{rows.length} sources</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed text-[13px]">
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-[14%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
            <col className="w-[16%]" />
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-fg-faint">
              <th scope="col" className="whitespace-nowrap pb-1.5 text-left font-normal">
                Source
              </th>
              <th scope="col" className="whitespace-nowrap pb-1.5 text-right font-normal">
                Requests
              </th>
              <th scope="col" className="whitespace-nowrap pb-1.5 text-right font-normal">
                Input
              </th>
              <th scope="col" className="whitespace-nowrap pb-1.5 text-right font-normal">
                Output
              </th>
              <th scope="col" className="whitespace-nowrap pb-1.5 text-right font-normal">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-line">
                <td className="py-1 pr-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: SOURCE_COLORS[row.kind] }}
                    />
                    <span
                      className="min-w-0 truncate text-xs text-fg-strong"
                      title={row.kind === 'main' ? 'Main conversation' : row.id}
                    >
                      {row.kind === 'main' ? 'Main conversation' : row.id}
                    </span>
                    <span className="shrink-0 rounded-[3px] bg-panel-hi px-1.5 py-0.5 text-[10px] text-fg-dim">
                      {USAGE_SOURCE_LABELS[row.kind]}
                    </span>
                  </div>
                  <span className="mt-0.5 block truncate pl-3.5 text-[11px] text-fg-faint">
                    {sourceRowDetail(row)}
                  </span>
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-fg-muted tabular-nums">
                  {row.requests.toLocaleString()}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-fg-muted tabular-nums">
                  {tokensShort(row.inputTokens)}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-fg-muted tabular-nums">
                  {tokensShort(row.outputTokens)}
                </td>
                <td className="py-1 pr-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-[5px] w-16 overflow-hidden rounded-full bg-panel-hi">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0}%`,
                          background: SOURCE_COLORS[row.kind]
                        }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right font-mono text-[11px] text-fg-faint tabular-nums">
                      {totalTokens > 0
                        ? `${((row.totalTokens / totalTokens) * 100).toFixed(1)}%`
                        : '—'}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
      // 无会话的账本用量（一次性命令）只加 token，不算一条会话。
      if (!s.ledger) row.sessions++
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
        <span className="text-[11px] text-fg-faint">{rows.length} projects</span>
      </header>
      <div>
        {shown.map((row, index) => (
          <Fragment key={row.cwd}>
            <div className={`pt-1.5 ${index === 0 ? '' : 'mt-1 border-t border-line pt-2'}`}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-fg-strong" title={row.cwd}>
                  {row.project}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-fg-muted tabular-nums">
                  {row.sessions} sessions · {tokensShort(row.tokens)}
                </span>
              </div>
              <div className="mt-1 h-[5px] overflow-hidden rounded-full bg-panel-hi">
                <div
                  className="h-full rounded-full bg-fg"
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
          className="mt-2 text-[11px] text-fg-faint transition-colors hover:text-fg-muted"
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

/** 按会话明细表（可排序、分批），每行可打开详情弹窗 */
function BySessionCard({ scoped, onDetail }) {
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
        <span className="text-[11px] text-fg-faint">{sorted.length} sessions</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px] table-fixed text-[13px]">
          <colgroup>
            <col className="w-[31%]" />
            <col className="w-[15%]" />
            <col className="w-[13%]" />
            <col className="w-[9%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[8%]" />
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-fg-faint">
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
                      className={`inline-flex items-center gap-0.5 uppercase transition-colors hover:text-fg-strong ${
                        sortKey === key ? 'text-fg' : ''
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
              <th scope="col" className="whitespace-nowrap pb-1.5 text-right font-normal">
                详情
              </th>
            </tr>
          </thead>
          <tbody>
            {top.map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className="py-1 pr-3">
                  <span className="block truncate text-xs text-fg-strong" title={s.cwd}>
                    {s.title || basename(s.cwd)}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-fg-faint">
                    {basename(s.cwd)} · {s.id ? s.id.slice(0, 8) : ''}
                    {Number(s.delegationTasks) > 0 && (
                      <span className="text-warn-soft"> · {s.delegationTasks} delegated</span>
                    )}
                    {Number(s.pluginRequests) > 0 && (
                      <span className="text-fg-faint"> · {s.pluginRequests} plugin</span>
                    )}
                  </span>
                </td>
                <td className="py-1 pr-3">
                  <span
                    className="block truncate font-mono text-[11px] text-fg-muted"
                    title={s.model}
                  >
                    {s.model || '—'}
                  </span>
                </td>
                <td className="py-1 pr-3 text-[11px] text-fg-muted tabular-nums">
                  {agoShort(s.updatedAtMs, now)}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-fg-muted tabular-nums">
                  {s.requests.toLocaleString()}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-fg-muted tabular-nums">
                  {tokensShort(s.totalTokens)}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-[11px] text-fg-muted tabular-nums">
                  {s.inputTokens > 0
                    ? `${((s.cachedInputTokens / s.inputTokens) * 100).toFixed(0)}%`
                    : '—'}
                </td>
                <td className="py-1 pr-3 text-right">
                  <button
                    type="button"
                    onClick={() => onDetail(s.id)}
                    className="rounded-[4px] border border-line bg-panel-hi px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg-strong"
                  >
                    查看详情
                  </button>
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
          className="mt-2 text-[11px] text-fg-faint transition-colors hover:text-fg-muted"
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
  const [detailSessionId, setDetailSessionId] = useState(null)

  useEffect(() => {
    if (!visible) return undefined
    let alive = true
    const read = () => {
      window.mica.stats
        .read()
        .then((data) => {
          if (alive) setSnap(data)
        })
        .catch((error) => console.error('read stats failed', error))
    }
    const tick = () => {
      // 会话统计索引由运行时按文件签名增量维护；隐藏窗口里刷新纯属白烧 CPU。
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      read()
    }
    tick()
    const timer = window.setInterval(tick, STATS_REFRESH_MS)
    // 回到窗口时立刻补一次，免得刚打开就看到几十秒前的数字。
    const onFocus = () => tick()
    window.addEventListener('focus', onFocus)
    // 首次构建索引要遍历全部会话文件：运行时按进度推送，这里跟着刷新，页面因此是
    // 逐个填充而不是先空着等一次全量扫描。
    const offChanged = window.mica.stats.onChanged?.(() => {
      if (alive) read()
    })
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      offChanged?.()
    }
  }, [visible])

  const sessions = useMemo(() => snap?.sessions || [], [snap])

  const calendar = useMemo(() => {
    const today = localDayKey(Date.now())
    const years = new Set()
    for (const s of sessions) for (const day of s.days || []) years.add(day.day.slice(0, 4))
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
    return sessions.map((session) => scopeSession(session, range)).filter(Boolean)
  }, [sessions, range])
  const activeScoped = useMemo(
    () => scoped.filter((session) => (Number(session.requests) || 0) > 0),
    [scoped]
  )
  // 账本里的无会话用量没有 id，进不了按会话的明细表。
  const sessionScoped = useMemo(() => activeScoped.filter((session) => session.id), [activeScoped])

  const hasAny = sessions.some((session) => (Number(session.requests) || 0) > 0)
  const progress = snap?.progress
  const legacyUsageRecords = scoped.reduce(
    (total, session) => total + (Number(session.legacyUsageRecords) || 0),
    0
  )

  const setRangePreset = (value) => {
    setRange(value)
  }

  const onSelectDay = (day) => setRange({ day })

  return (
    <section
      className={`min-h-0 flex-1 flex-col overflow-hidden ${visible ? 'flex' : 'hidden'}`}
      aria-hidden={!visible}
    >
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 px-6 py-6">
          <div className="flex items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              {isDayRange(range) && (
                <button
                  type="button"
                  onClick={() => setRangePreset('30d')}
                  title="清除单日筛选"
                  className="flex items-center gap-1 rounded-[4px] border border-line bg-panel px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:text-fg-strong"
                >
                  {dayShort(range.day)}
                  <span aria-hidden className="text-fg-faint">
                    ×
                  </span>
                </button>
              )}
              <div className="flex items-center gap-0.5 rounded-[4px] border border-line bg-panel p-0.5 text-[11px]">
                {RANGE_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={range === value}
                    onClick={() => setRangePreset(value)}
                    className={`rounded-sm px-2 py-0.5 transition-colors ${
                      range === value
                        ? 'bg-active text-fg-strong'
                        : 'text-fg-faint hover:text-fg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {!hasAny ? (
            <div className="grid place-items-center rounded-[5px] border border-dashed border-line py-16 text-xs text-fg-faint">
              {progress?.building
                ? `正在统计会话用量 ${progress.done} / ${progress.total}…`
                : 'No usage yet. Complete an AI session to see statistics.'}
            </div>
          ) : (
            <>
              {progress?.building && (
                <div className="rounded-[5px] border border-line bg-panel px-3 py-2 text-[11px] text-fg-faint">
                  正在统计会话用量 {progress.done} / {progress.total}，先展示已统计的部分…
                </div>
              )}
              <OverviewCard
                snap={snap}
                range={range}
                onSelectDay={onSelectDay}
                calendar={calendar}
              />
              {legacyUsageRecords > 0 && (
                <div className="rounded-[5px] border border-warn/30 bg-warn/8 px-3 py-2 text-[11px] text-warn-soft">
                  {legacyUsageRecords.toLocaleString()} 条旧 usage
                  没有请求时间，已稳定归档到会话创建日（委派与插件的记录归档到任务开始时间）；
                  升级后产生的数据会按实际请求时间统计。
                </div>
              )}
              <DailyCard sessions={sessions} range={range} />
              <ByModelCard scoped={activeScoped} />
              <BySourceCard scoped={activeScoped} />
              <ByProjectCard
                scoped={activeScoped}
                visibleRows={visibleRows}
                onShowMore={() => setVisibleRows((v) => v + PROJECT_BATCH)}
              />
              <BySessionCard scoped={sessionScoped} onDetail={setDetailSessionId} />
            </>
          )}
        </div>
      </div>
      {detailSessionId && (
        <SessionDetailModal sessionId={detailSessionId} onClose={() => setDetailSessionId(null)} />
      )}
    </section>
  )
}
