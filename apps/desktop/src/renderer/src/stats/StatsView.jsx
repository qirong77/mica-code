import { Fragment, useEffect, useMemo, useState } from 'react'
import { Button, DataTable, Segmented, SelectMenu, Tag } from '@mica-config-ui/web'
import { BarSeries, CalendarHeatmap } from './charts'
import { SessionDetailModal } from './SessionDetailModal'
import { bucketByDay, bucketByDaySource, isDayRange, rangeStart, scopeSession } from './scope'
import {
  USAGE_KIND_COLORS as SOURCE_COLORS,
  USAGE_KIND_ORDER as SOURCE_ORDER
} from './usage-series'
import { USAGE_SOURCE_LABELS } from '@packages/mica-web-shared/usage-source.js'
import { usePluginsDetails } from '../plugins-details'
import {
  SOURCE_KIND_HINTS,
  SOURCE_KIND_LABELS,
  flattenSourceRows,
  normalizeSourceId,
  sourceRowKey
} from './source-groups'
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
// 两张明细表一页放多少行。同一个页面上两个表用不同行数不是问题——它们回答的问题不同，
// 来源表本来就短（十几条），会话表会长到几百条。
const SOURCE_PAGE_SIZE = 12
const SESSION_PAGE_SIZE = 10
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

const CARD_CLASS = 'rounded-[5px] border border-line bg-panel'
const OVERLINE_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-dim'

function basename(cwd) {
  if (!cwd) return '~'
  const parts = String(cwd).split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cwd
}

function tokensShort(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`
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
          <span className="mica-config-ui is-embed">
            {/* 年选择是同一份自绘下拉：原生 select 的弹层不受页面控制。 */}
            <SelectMenu
              size="compact"
              value={calendar.year === null ? 'trailing' : String(calendar.year)}
              options={[
                { value: 'trailing', label: 'Last 12 months' },
                ...calendar.years.map((y) => ({ value: String(y), label: String(y) }))
              ]}
              ariaLabel="Contributions year"
              onChange={(next) => calendar.onYear(next === 'trailing' ? null : Number(next))}
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

const DAILY_MODES = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'requests', label: '请求数' },
  { value: 'source', label: '按来源' }
]

/**
 * 每日柱状图（按日行的 `at` 聚合）。
 *
 * 三个视角共用一根时间轴：总量（tokens）看波动，请求数看「跑了多少轮」，按来源看
 * 「这段花费里有多少是委派和插件带来的」——只给一个总量时，后者永远要靠 By source 的表格去对。
 */
function DailyCard({ sessions, range }) {
  const [mode, setMode] = useState('tokens')
  const byDay = useMemo(() => bucketByDay(sessions), [sessions])
  const bySource = useMemo(() => bucketByDaySource(sessions), [sessions])
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
      out.push({
        day,
        requests: row?.requests || 0,
        tokens: row?.tokens || 0,
        sources: bySource.get(day) || null
      })
      day = addDays(day, 1)
    }
    return out
  }, [startDay, endDay, byDay, bySource, totalDays])

  const stride = Math.max(1, Math.ceil(days.length / 8))
  const lastPhase = (days.length - 1) % stride
  const xLabels = days
    .map((d, i) => ({
      index: i,
      label: d.day === today ? '今天' : dayShort(d.day)
    }))
    .filter(({ index }) => index % stride === lastPhase)

  if (days.length === 0) return null
  const usedKinds = SOURCE_ORDER.filter((kind) => days.some((d) => (d.sources?.[kind] || 0) > 0))

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className={OVERLINE_CLASS}>Per day</h2>
          <span className="text-[11px] text-fg-faint">
            {isDayRange(range)
              ? dayShort(range.day)
              : range === 'all'
                ? '最多展示 90 天'
                : range === 'today'
                  ? '今天'
                  : `近 ${range}`}
          </span>
        </div>
        <span className="mica-config-ui is-embed">
          <Segmented
            size="compact"
            value={mode}
            options={DAILY_MODES}
            ariaLabel="每日指标"
            onChange={setMode}
          />
        </span>
      </header>
      <BarSeries
        columns={days.map((d) =>
          mode === 'source'
            ? {
                key: d.day,
                segments: usedKinds.map((kind) => ({
                  key: kind,
                  value: d.sources?.[kind] || 0,
                  color: SOURCE_COLORS[kind]
                }))
              }
            : { key: d.day, value: mode === 'requests' ? d.requests : d.tokens }
        )}
        formatTick={mode === 'requests' ? (value) => String(value) : tokensShort}
        xLabels={xLabels}
        renderTooltip={(i) => {
          const d = days[i]
          return (
            <div className="flex flex-col gap-0.5">
              <div className="font-medium text-fg-strong">{d.day === today ? '今天' : d.day}</div>
              <div className="text-fg-muted">
                {d.requests} requests · {tokensShort(d.tokens)} tokens
              </div>
              {mode === 'source' && usedKinds.length > 1
                ? usedKinds.map((kind) => (
                    <div key={kind} className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                      <span
                        aria-hidden
                        className="size-1.5 rounded-[1px]"
                        style={{ background: SOURCE_COLORS[kind] }}
                      />
                      {USAGE_SOURCE_LABELS[kind]}
                      <span className="tabular-nums">{tokensShort(d.sources?.[kind] || 0)}</span>
                    </div>
                  ))
                : null}
            </div>
          )
        }}
      />
      {mode === 'source' && usedKinds.length > 1 ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-faint">
          {usedKinds.map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: SOURCE_COLORS[kind] }}
              />
              {USAGE_SOURCE_LABELS[kind]}
            </span>
          ))}
        </div>
      ) : null}
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
  // 条的宽度按份额而不是按最大值：这张卡回答的是「谁占了多少」，占 3% 就该是一条短条。
  const maxTokens = rows[0].tokens

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-3 flex items-center justify-between">
        <h2 className={OVERLINE_CLASS}>By model</h2>
        <span className="text-[11px] text-fg-faint">
          {rows.length} models · {tokensShort(totalTokens)} tokens
        </span>
      </header>
      <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        {rows.map((r) => {
          const share = totalTokens > 0 ? r.tokens / totalTokens : 0
          return (
            <div key={r.model} className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-full bg-fg" />
                <span className="truncate font-mono text-xs text-fg-strong" title={r.model}>
                  {r.model}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-faint tabular-nums">
                  {(share * 100).toFixed(1)}%
                </span>
              </div>
              <div
                className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-panel-hi"
                title={`${tokensShort(r.tokens)} / ${tokensShort(maxTokens)}（最大值）`}
              >
                <div
                  className="h-full rounded-full bg-fg"
                  style={{ width: `${maxTokens > 0 ? (r.tokens / maxTokens) * 100 : 0}%` }}
                />
              </div>
              <div className="mt-1 font-mono text-[11px] text-fg-faint tabular-nums">
                {r.sessions} sessions · {r.requests} requests · {tokensShort(r.tokens)} tokens
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * 按来源列出每一条用量。**不分组**：同一个功能可能同时出现两条（自动压缩的模型摘要
 * 既可以由插件经 `ctx.llm` 发，也可以由内核起摘要子代理），分组会把它拆到两张小表里，
 * 看起来像记了两笔。摊平后按 token 排，每行给出「类型 + 具体名称 + 谁派发 + 用途」。
 *
 * Type 列不参与排序、也不随容器变宽退场：它是「这笔请求哪来的」的答案，退掉之后剩下的
 * 名称与数字就又要靠副标题去猜。
 */
const SOURCE_COLUMNS = [
  { key: 'source', label: 'Source', width: '38%' },
  { key: 'kind', label: 'Type', width: '11%' },
  { key: 'requests', label: 'Requests', width: '11%', align: 'right', sortable: true },
  {
    key: 'input',
    label: 'Input',
    width: '13%',
    align: 'right',
    sortable: true,
    narrow: 'tertiary'
  },
  {
    key: 'output',
    label: 'Output',
    width: '12%',
    align: 'right',
    sortable: true,
    // 先退 Output（用量的大头都在 Input 里，输出量小到可以点进会话看），再窄才退 Input。
    // 请求数一直留着——「这个来源被调了多少次」是判断它值不值的第一眼。
    narrow: 'secondary'
  },
  { key: 'share', label: 'Share', width: '15%', align: 'right', sortable: true }
]

const SOURCE_SORT_VALUE = {
  requests: (row) => row.requests,
  input: (row) => row.inputTokens,
  output: (row) => row.outputTokens,
  share: (row) => row.totalTokens
}

function BySourceCard({ scoped }) {
  const plugins = usePluginsDetails()
  const pluginNames = useMemo(
    () => new Map(plugins.map((plugin) => [plugin.id, plugin.name])),
    [plugins]
  )
  const pluginDescriptions = useMemo(
    () => new Map(plugins.map((plugin) => [plugin.id, plugin.description])),
    [plugins]
  )
  const [sort, setSort] = useState({ key: 'share', desc: true })

  const rows = useMemo(() => {
    const map = new Map()
    for (const s of scoped) {
      for (const usage of s.sourceUsage || []) {
        // 同一个功能只占一行：内核 helper 的写法先归一到功能键（记忆整理等），否则它们看起来
        // 像两个功能各记了一笔。会话 id 仍按 Set 去重，合并不虚增会话数。
        const key = sourceRowKey(usage)
        const row = map.get(key) || {
          key,
          kind: usage.kind,
          id: normalizeSourceId(usage.kind, usage.id),
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
    return [...map.values()].map((row) => ({
      ...row,
      sessions: row.sessions.size,
      tasks: row.tasks.size,
      purposes: [...row.purposes]
    }))
  }, [scoped])

  const flattened = useMemo(
    () => flattenSourceRows(rows, { pluginNames, pluginDescriptions }),
    [rows, pluginNames, pluginDescriptions]
  )

  const sorted = useMemo(() => {
    const value = SOURCE_SORT_VALUE[sort.key] || SOURCE_SORT_VALUE.share
    const list = flattened.rows.slice()
    list.sort((a, b) => (sort.desc ? value(b) - value(a) : value(a) - value(b)))
    return list
  }, [flattened, sort])

  if (rows.length === 0) return null
  const maxShare = sorted.length > 0 ? sorted.reduce((m, r) => Math.max(m, r.share), 0) : 0

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className={OVERLINE_CLASS}>By source</h2>
        <span className="shrink-0 text-[11px] text-fg-faint tabular-nums">
          {flattened.rows.length} sources · {tokensShort(flattened.total)} tokens
        </span>
      </header>
      <div className="mica-config-ui is-embed">
        <DataTable
          ariaLabel="按来源用量"
          columns={SOURCE_COLUMNS}
          rows={sorted}
          rowKey={(row) => row.key}
          pageSize={SOURCE_PAGE_SIZE}
          sort={sort}
          onSortChange={(key) =>
            setSort((current) =>
              current.key === key ? { key, desc: !current.desc } : { key, desc: true }
            )
          }
          renderCells={(row) => [
            <div key="source" className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
                <span className="min-w-0 truncate text-xs text-fg-strong" title={row.title}>
                  {row.title}
                </span>
              </div>
              <span
                className="mt-0.5 block truncate pl-3.5 text-[11px] text-fg-faint"
                title={row.detail}
              >
                {row.detail}
              </span>
            </div>,
            <span key="kind" className="min-w-0" title={row.kindHint}>
              <Tag>{row.kindLabel}</Tag>
            </span>,
            <span key="requests" className="font-mono text-[11px] text-fg-muted tabular-nums">
              {row.requests.toLocaleString()}
            </span>,
            <span key="input" className="font-mono text-[11px] text-fg-muted tabular-nums">
              {tokensShort(row.inputTokens)}
            </span>,
            <span key="output" className="font-mono text-[11px] text-fg-muted tabular-nums">
              {tokensShort(row.outputTokens)}
            </span>,
            <div key="share" className="flex items-center justify-end gap-2">
              <div className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-panel-hi">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${maxShare > 0 ? (row.share / maxShare) * 100 : 0}%`,
                    background: row.color
                  }}
                />
              </div>
              <span className="w-10 shrink-0 text-right font-mono text-[11px] text-fg-faint tabular-nums">
                {(row.share * 100).toFixed(1)}%
              </span>
            </div>
          ]}
        />
      </div>
      <ul className="mt-3 flex flex-col gap-1 border-t border-line-soft pt-2.5 text-[11px] leading-relaxed text-fg-faint">
        {SOURCE_ORDER.map((kind) => (
          <li key={kind} className="flex gap-1.5">
            <span
              aria-hidden
              className="mt-[5px] size-1.5 shrink-0 rounded-full"
              style={{ background: SOURCE_COLORS[kind] }}
            />
            <span className="min-w-0">
              <span className="text-fg-muted">{SOURCE_KIND_LABELS[kind]}</span>
              {` — ${SOURCE_KIND_HINTS[kind]}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 按项目（cwd basename）聚合，分批展示。
 *
 * 每行一条按来源拆开的堆叠条：同一个项目里「自己跑」和「派出去跑」的比例差得很多，
 * 单色条只能比大小，看不出这一点。
 */
function ByProjectCard({ scoped, visibleRows, onShowMore }) {
  const rows = useMemo(() => {
    const map = new Map()
    for (const s of scoped) {
      const cwd = s.cwd || '~'
      const row = map.get(cwd) || {
        cwd,
        project: basename(cwd),
        sessions: 0,
        turns: 0,
        tokens: 0,
        sources: { main: 0, delegation: 0, plugin: 0, helper: 0 }
      }
      // 无会话的账本用量（一次性命令）只加 token，不算一条会话。
      if (!s.ledger) row.sessions++
      row.turns += s.turns
      row.tokens += s.totalTokens
      for (const usage of s.sourceUsage || []) {
        if (!(usage.kind in row.sources)) continue
        row.sources[usage.kind] += Number(usage.totalTokens) || 0
      }
      map.set(cwd, row)
    }
    // 来源合计（主对话 + 委派 + 插件 + 内核）多数时候就是总量；`totalTokens` 里还有不带
    // 来源归属的历史记录，差额补进主对话，免得堆叠条比总量短一截。这里按行算一次，
    // 放进上面的循环会每加一条会话就再补一次。
    return [...map.values()]
      .map((row) => {
        const classified = SOURCE_ORDER.reduce((sum, kind) => sum + row.sources[kind], 0)
        return {
          ...row,
          sources: { ...row.sources, main: row.sources.main + Math.max(0, row.tokens - classified) }
        }
      })
      .sort((a, b) => b.tokens - a.tokens || a.cwd.localeCompare(b.cwd))
  }, [scoped])

  if (rows.length === 0) return null
  const shown = rows.slice(0, visibleRows)
  const max = Math.max(...shown.map((r) => r.tokens), 0)
  const rest = rows.length - shown.length
  const usedKinds = SOURCE_ORDER.filter((kind) => rows.some((r) => r.sources[kind] > 0))

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-3 flex items-center justify-between">
        <h2 className={OVERLINE_CLASS}>By project</h2>
        <div className="flex items-center gap-x-3 gap-y-1 text-[11px] text-fg-faint">
          {usedKinds.map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: SOURCE_COLORS[kind] }}
              />
              {USAGE_SOURCE_LABELS[kind]}
            </span>
          ))}
          <span>{rows.length} projects</span>
        </div>
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
                  className="flex h-full overflow-hidden rounded-full"
                  style={{ width: `${max > 0 ? (row.tokens / max) * 100 : 0}%` }}
                >
                  {usedKinds.map((kind) =>
                    row.sources[kind] > 0 ? (
                      <span
                        key={kind}
                        className="h-full"
                        style={{
                          width: `${row.tokens > 0 ? (row.sources[kind] / row.tokens) * 100 : 0}%`,
                          background: SOURCE_COLORS[kind]
                        }}
                      />
                    ) : null
                  )}
                </div>
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

/**
 * 明细表的列。和其他表同一套：不横向滚动，卡片变窄时先让次要列退场（模型、缓存命中率、
 * 请求数），剩下的列按比例摊开——判断的是卡片自己的宽度，不看视口。
 */
const SESSION_COLUMNS = [
  { key: 'session', label: 'Session', width: '30%' },
  { key: 'model', label: 'Model', width: '15%', narrow: 'secondary' },
  {
    key: 'lastActivity',
    label: 'Last activity',
    // 窄卡片里模型列先退场，这一列只剩一窄溜：表头 nowrap 会压到 Requests 上，
    // 所以窄容器换一个短标签。
    narrowLabel: 'Activity',
    width: '13%',
    sortable: true
  },
  {
    key: 'requests',
    label: 'Requests',
    width: '9%',
    align: 'right',
    sortable: true,
    narrow: 'tertiary'
  },
  { key: 'tokens', label: 'Tokens', width: '12%', align: 'right', sortable: true },
  {
    key: 'cacheRate',
    label: 'Cache hit',
    width: '10%',
    align: 'right',
    sortable: true,
    narrow: 'tertiary'
  },
  { key: 'detail', label: '', width: '11%', align: 'right' }
]

const SESSION_SORT_VALUE = {
  lastActivity: (row) => row.updatedAtMs,
  requests: (row) => row.requests,
  tokens: (row) => row.totalTokens,
  cacheRate: (row) => (row.inputTokens > 0 ? row.cachedInputTokens / row.inputTokens : 0)
}

/** 按会话明细表（可排序、翻页），每行可打开详情弹窗 */
function BySessionCard({ scoped, onDetail }) {
  const [sort, setSort] = useState({ key: 'lastActivity', desc: true })

  const sorted = useMemo(() => {
    const value = SESSION_SORT_VALUE[sort.key] || SESSION_SORT_VALUE.lastActivity
    const list = scoped.slice()
    list.sort((a, b) => (sort.desc ? value(b) - value(a) : value(a) - value(b)))
    return list
  }, [scoped, sort])

  if (sorted.length === 0) return null
  const now = Date.now()
  // Token 列的数字后面压一条等比例底纹，宽度相对排在最前的那条会话：扫一眼就知道
  // 贵的是哪几条，不必逐个读数字比较。
  const maxTokens = Math.max(...sorted.map((s) => s.totalTokens), 0)

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className={OVERLINE_CLASS}>By session</h2>
        <span className="shrink-0 text-[11px] text-fg-faint">{sorted.length} sessions</span>
      </header>
      <div className="mica-config-ui is-embed">
        <DataTable
          ariaLabel="按会话用量"
          columns={SESSION_COLUMNS}
          rows={sorted}
          rowKey={(s) => s.id}
          pageSize={SESSION_PAGE_SIZE}
          sort={sort}
          onSortChange={(key) =>
            setSort((current) =>
              current.key === key ? { key, desc: !current.desc } : { key, desc: true }
            )
          }
          renderCells={(s) => [
            <div key="session" className="min-w-0">
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
            </div>,
            <span
              key="model"
              className="block truncate font-mono text-[11px] text-fg-muted"
              title={s.model}
            >
              {s.model || '—'}
            </span>,
            <span
              key="activity"
              className="whitespace-nowrap text-[11px] text-fg-muted tabular-nums"
            >
              {agoShort(s.updatedAtMs, now)}
            </span>,
            <span key="requests" className="font-mono text-[11px] text-fg-muted tabular-nums">
              {s.requests.toLocaleString()}
            </span>,
            <span
              key="tokens"
              className="relative inline-block min-w-[3.5rem] text-right font-mono text-[11px] text-fg-muted tabular-nums"
            >
              <span
                aria-hidden
                className="absolute inset-y-0 right-0 rounded-[2px] bg-overlay"
                style={{ width: `${maxTokens > 0 ? (s.totalTokens / maxTokens) * 100 : 0}%` }}
              />
              <span className="relative">{tokensShort(s.totalTokens)}</span>
            </span>,
            <span key="cacheRate" className="font-mono text-[11px] text-fg-muted tabular-nums">
              {s.inputTokens > 0
                ? `${((s.cachedInputTokens / s.inputTokens) * 100).toFixed(0)}%`
                : '—'}
            </span>,
            <span key="detail" className="inline-flex justify-end">
              <Button
                size="compact"
                variant="ghost"
                title="查看会话详情"
                onClick={() => onDetail(s.id)}
              >
                详情
              </Button>
            </span>
          ]}
        />
      </div>
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
    // 页签没显示时照样在跑（`visible` 为假）：这时只为「有数据变」刷新，索引补齐的
    // 进度推送不跟，少一次几千行的全量装配。
    const offChanged = window.mica.stats.onChanged?.((payload) => {
      if (!alive) return
      if (payload?.partial && !visible) return
      read()
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

  const setRangePreset = (value) => {
    setRange(value)
  }

  const onSelectDay = (day) => setRange({ day })

  const rangeText = isDayRange(range)
    ? dayShort(range.day)
    : range === 'all'
      ? 'All time'
      : range === 'today'
        ? 'Today'
        : `近 ${range}`

  return (
    <section
      className={`min-h-0 flex-1 flex-col overflow-hidden ${visible ? 'flex' : 'hidden'}`}
      aria-hidden={!visible}
    >
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 px-6 py-6">
          {/* 页面头：一句「现在看的是哪一段、涉及多少条会话」，右侧是区间选择。没有这一行时
              整页从一片 KPI 数字开始，看不出当前区间是什么。 */}
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[13px] font-semibold tracking-tight text-fg-strong">Usage</h1>
              <p className="mt-0.5 truncate text-[11px] text-fg-faint">
                {rangeText} · {activeScoped.length} sessions
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isDayRange(range) && (
                <button
                  type="button"
                  onClick={() => setRangePreset('30d')}
                  title="清除单日筛选"
                  className="flex items-center gap-1 rounded-[4px] border border-line bg-panel px-2 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg-strong"
                >
                  {dayShort(range.day)}
                  <span aria-hidden className="text-fg-faint">
                    ×
                  </span>
                </button>
              )}
              <div className="mica-config-ui is-embed">
                <Segmented
                  size="compact"
                  value={isDayRange(range) ? 'day' : range}
                  options={RANGE_OPTIONS.map(([value, label]) => ({ value, label }))}
                  ariaLabel="统计区间"
                  onChange={setRangePreset}
                />
              </div>
            </div>
          </header>
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
