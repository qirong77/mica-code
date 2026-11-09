import { useEffect, useMemo, useState } from 'react'
import { Button, DataTable, Empty, Segmented, SelectMenu, Tag } from '@mica-config-ui/web'
import Alert from '@arco-design/web-react/es/Alert'
import { IconX } from '@tabler/icons-react'
import { CalendarHeatmap } from './charts'
import { SpeedBars } from './SpeedBars'
import { OverviewVisuals } from './OverviewVisuals'
import { StatsPanel } from './StatsPanel'
import { buildOverview } from './overview'
import { SessionDetailModal } from './SessionDetailModal'
import { bucketByDay, isDayRange, modelSpeed, scopeSession } from './scope'
import {
  USAGE_KIND_COLORS as SOURCE_COLORS,
  USAGE_KIND_ORDER as SOURCE_ORDER
} from './usage-series'
import { usePluginsDetails } from '../plugins-details'
import { createReadQueue } from '../read-queue'
import {
  SOURCE_KIND_HINTS,
  SOURCE_KIND_LABELS,
  flattenSourceRows,
  sourceRowKey
} from './source-groups'
import {
  addDays,
  calendarGrid,
  currentStreak,
  intensityLevel,
  intensityThresholds,
  localDayKey,
  longestStreak,
  monthLabelCols
} from './geometry'

const RANGE_OPTIONS = [
  ['today', '今天'],
  ['7d', '近 7 天'],
  ['30d', '近 30 天'],
  ['90d', '近 90 天'],
  ['all', '全部']
]
// 按会话的明细表一页放多少行。它会长到几百条；来源表是两层树（插件 → 子项），
// 分页会把父行和它的子项劈到两页上，所以那张表不分页。
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

const OVERLINE_CLASS = 'text-[13px] font-medium text-fg-strong'
const REPORT_OPTIONS = [
  { value: 'sessions', label: '会话明细' },
  { value: 'sources', label: '来源明细' },
  { value: 'models', label: '模型明细' },
  { value: 'projects', label: '项目明细' },
  { value: 'speed', label: '模型速度' },
  { value: 'activity', label: '活跃日历' }
]

function basename(cwd) {
  if (!cwd) return '~'
  const parts = String(cwd).split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cwd
}

function tokensShort(n) {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return String(Math.round(n))
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

function ActivityReport({ sessions, range, onSelectDay, calendar }) {
  const busiest = useMemo(
    () =>
      [
        ...bucketByDay(
          sessions.map((session) => scopeSession(session, range)).filter(Boolean)
        ).values()
      ].sort((a, b) => b.sessions - a.sessions || b.tokens - a.tokens)[0],
    [sessions, range]
  )
  const allDays = useMemo(
    () => [...new Set(sessions.flatMap((s) => (s.days || []).map((d) => d.day)))].sort(),
    [sessions]
  )
  const streaks = useMemo(
    () => ({
      longest: longestStreak(allDays),
      current: currentStreak(allDays, localDayKey(Date.now()))
    }),
    [allDays]
  )
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
    <div>
      <div className="p-4">
        <header className="mb-4 flex items-center justify-between gap-2">
          <h2 className={OVERLINE_CLASS}>活跃日历</h2>
          <SelectMenu
            size="compact"
            value={calendar.year === null ? 'trailing' : String(calendar.year)}
            options={[
              { value: 'trailing', label: '近 12 个月' },
              ...calendar.years.map((y) => ({ value: String(y), label: String(y) }))
            ]}
            ariaLabel="Contributions year"
            onChange={(next) => calendar.onYear(next === 'trailing' ? null : Number(next))}
          />
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
            当前区间最忙日{' '}
            <strong className="font-medium text-fg-muted">
              {busiest ? `${busiest.day} · ${busiest.sessions} 个会话` : '—'}
            </strong>
          </span>
          <span>
            累计活跃{' '}
            <strong className="font-medium text-fg-muted">{allDays.length} 个活跃日</strong>
          </span>
          <span>
            最长连续 <strong className="font-medium text-fg-muted">{streaks.longest} 天</strong>
          </span>
          <span>
            当前连续 <strong className="font-medium text-fg-muted">{streaks.current} 天</strong>
          </span>
        </div>
      </div>
    </div>
  )
}

function ModelPerformanceCard({ scoped }) {
  const [metric, setMetric] = useState('responseWait')
  const rows = useMemo(() => modelSpeed(scoped, metric), [scoped, metric])
  const formatValue = (value) =>
    metric === 'responseWait' ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} tokens/s`
  const unitText = metric === 'responseWait' ? '秒 · 越低越快' : 'tokens/s · 估算 · 越高越快'
  return (
    <div>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={OVERLINE_CLASS}>模型速度</h2>
        <Segmented
          size="compact"
          value={metric}
          options={[
            { value: 'responseWait', label: '响应等待' },
            { value: 'generation', label: '生成速率' }
          ]}
          ariaLabel="模型速度指标"
          onChange={setMetric}
        />
      </header>
      <p className="mt-1 text-[11px] text-fg-dim">
        {metric === 'responseWait'
          ? '请求开始到首次内容的平均等待，包含重试。'
          : '扣除推理与首个 token 后，按正文首末增量间隔估算；仅采纳至少 32 个正文 tokens、持续 0.5 秒的无工具请求。'}{' '}
        {metric === 'responseWait'
          ? '仅统计有计时的成功请求，按区间平均值逐行对比。'
          : '缺少推理用量明细或旧口径记录不参与，按有效 tokens 总量 ÷ 总时长比较；仍受网络分块与格式 tokens 影响。'}
      </p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-fg-faint">当前区间没有可用的请求计时数据。</p>
      ) : (
        <SpeedBars rows={rows} metric={metric} formatValue={formatValue} unit={unitText} />
      )}
    </div>
  )
}

/**
 * 按来源列出每一条用量：父行是插件（同一个功能的两条记录——例如模型摘要既可以由插件经
 * `ctx.llm` 发，也可以由内核起摘要子代理——都挂在同一个父级下面），子行是具体请求，
 * 按 token 排。每行给出「类型 + 具体名称 + 谁派发 + 用途」。
 *
 * Type 列不参与排序、也不随容器变宽退场：它是「这笔请求哪来的」的答案，退掉之后剩下的
 * 名称与数字就又要靠副标题去猜。
 */
const SOURCE_COLUMNS = [
  { key: 'source', label: '来源', width: '38%' },
  { key: 'kind', label: '类型', width: '11%' },
  { key: 'requests', label: '请求', width: '11%', align: 'right', sortable: true },
  {
    key: 'input',
    label: '输入',
    width: '13%',
    align: 'right',
    sortable: true,
    narrow: 'tertiary'
  },
  {
    key: 'output',
    label: '输出',
    width: '12%',
    align: 'right',
    sortable: true,
    // 先退 Output（用量的大头都在 Input 里，输出量小到可以点进会话看），再窄才退 Input。
    // 请求数一直留着——「这个来源被调了多少次」是判断它值不值的第一眼。
    narrow: 'secondary'
  },
  { key: 'share', label: '占比', width: '15%', align: 'right', sortable: true }
]

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
        // 同一个功能只占一行（同 kind + 同 id）。会话 id 按 Set 去重，合并不虚增会话数。
        const key = sourceRowKey(usage)
        const row = map.get(key) || {
          key,
          kind: usage.kind,
          // 名字原样用记账里的 id：插件名由清单提供，类型名 / 功能名不在这里翻译。
          id: usage.id,
          // 父级：这笔请求是哪个插件发起的。子代理与插件后台请求都带着它。
          pluginId: usage.pluginId || null,
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

  // 排序与分组都在数据层：分组是结构（父行 = 插件），指标只决定组内顺序。
  const flattened = useMemo(
    () => flattenSourceRows(rows, { pluginNames, pluginDescriptions, sort }),
    [rows, pluginNames, pluginDescriptions, sort]
  )

  if (rows.length === 0) return <Empty description="当前区间没有来源用量" />
  const maxShare =
    flattened.rows.length > 0 ? flattened.rows.reduce((m, r) => Math.max(m, r.share), 0) : 0

  return (
    <div>
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className={OVERLINE_CLASS}>来源用量</h2>
        <span className="shrink-0 text-[11px] text-fg-faint tabular-nums">
          {flattened.groups} 个来源 · {tokensShort(flattened.total)} tokens
        </span>
      </header>
      <div className="mica-config-ui is-embed">
        <DataTable
          ariaLabel="按来源用量"
          columns={SOURCE_COLUMNS}
          rows={flattened.rows}
          rowKey={(row) => row.key}
          pageSize={0}
          sort={sort}
          onSortChange={(key) =>
            setSort((current) =>
              current.key === key ? { key, desc: !current.desc } : { key, desc: true }
            )
          }
          renderCells={(row) => [
            <div
              key="source"
              className={`min-w-0 ${row.depth > 0 ? 'ml-2 border-l border-line-soft pl-2.5' : ''}`}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
                <span
                  className={`min-w-0 truncate text-xs ${
                    row.isGroup ? 'font-medium text-fg-strong' : 'text-fg-muted'
                  }`}
                  title={row.title}
                >
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
    </div>
  )
}

const BREAKDOWN_COLUMNS = [
  { key: 'name', label: '名称', width: '40%' },
  {
    key: 'sessions',
    label: '会话',
    width: '15%',
    align: 'right',
    sortable: true,
    narrow: 'secondary'
  },
  { key: 'requests', label: '请求', width: '15%', align: 'right', sortable: true },
  { key: 'tokens', label: 'Tokens', width: '15%', align: 'right', sortable: true },
  { key: 'share', label: '占比', width: '15%', align: 'right' }
]

function BreakdownReport({ rows, type, total, selected, onSelect }) {
  const [sort, setSort] = useState({ key: 'tokens', desc: true })
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          (sort.desc ? b[sort.key] - a[sort.key] : a[sort.key] - b[sort.key]) ||
          a.id.localeCompare(b.id)
      ),
    [rows, sort]
  )
  return (
    <div className="mica-config-ui is-embed">
      <DataTable
        ariaLabel={type === 'models' ? '按模型用量' : '按项目用量'}
        columns={BREAKDOWN_COLUMNS}
        rows={sorted}
        rowKey={(row) => row.id}
        pageSize={10}
        sort={sort}
        onSortChange={(key) =>
          setSort((current) => ({ key, desc: current.key === key ? !current.desc : true }))
        }
        renderCells={(row) => [
          <Button
            key="name"
            variant="ghost"
            size="compact"
            pressed={selected === row.id}
            title={row.cwd || row.label}
            onClick={() => onSelect(row.id)}
          >
            <span className="block truncate">{row.label}</span>
          </Button>,
          <span key="sessions">{row.sessions.toLocaleString()}</span>,
          <span key="requests">{row.requests.toLocaleString()}</span>,
          <span key="tokens" title={row.tokens.toLocaleString()}>
            {tokensShort(row.tokens)}
          </span>,
          <span key="share">{total > 0 ? `${((row.tokens / total) * 100).toFixed(1)}%` : '—'}</span>
        ]}
      />
    </div>
  )
}

/**
 * 明细表的列。和其他表同一套：不横向滚动，卡片变窄时先让次要列退场（模型、缓存命中率、
 * 请求数），剩下的列按比例摊开——判断的是卡片自己的宽度，不看视口。
 */
const SESSION_COLUMNS = [
  { key: 'session', label: '会话', width: '30%' },
  { key: 'model', label: '模型', width: '15%', narrow: 'secondary' },
  {
    key: 'lastActivity',
    label: '最近活跃',
    // 窄卡片里模型列先退场，这一列只剩一窄溜：表头 nowrap 会压到 Requests 上，
    // 所以窄容器换一个短标签。
    narrowLabel: '活跃',
    width: '13%',
    sortable: true
  },
  {
    key: 'requests',
    label: '请求',
    width: '9%',
    align: 'right',
    sortable: true,
    narrow: 'tertiary'
  },
  { key: 'tokens', label: 'Tokens', width: '12%', align: 'right', sortable: true },
  {
    key: 'cacheRate',
    label: '缓存命中',
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
    <div>
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className={OVERLINE_CLASS}>会话用量</h2>
        <span className="shrink-0 text-[11px] text-fg-faint">{sorted.length} 个会话</span>
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
    </div>
  )
}

export function StatsView({ visible }) {
  // 默认看今天：统计页打开时关心的是「刚才这一轮花了多少」，近 30 天的总量是决策时才切过去看的。
  const [range, setRange] = useState('today')
  const [snap, setSnap] = useState(null)
  const [metric, setMetric] = useState('tokens')
  const [report, setReport] = useState('sessions')
  const [selectedModel, setSelectedModel] = useState(null)
  const [selectedProject, setSelectedProject] = useState(null)
  const [calendarYear, setCalendarYear] = useState(null)
  const [detailSessionId, setDetailSessionId] = useState(null)

  useEffect(() => {
    if (!visible) return undefined
    const reads = createReadQueue(
      async (isCurrent) => {
        const data = await window.mica.stats.read()
        if (isCurrent()) setSnap(data)
      },
      {
        // 会话统计索引由运行时按文件签名增量维护；隐藏窗口里刷新纯属白烧 CPU。
        canRead: () => document.visibilityState === 'visible' && document.hasFocus(),
        onError: (error) => console.error('read stats failed', error)
      }
    )
    const tick = () => {
      void reads.refresh()
    }
    tick()
    const timer = window.setInterval(tick, STATS_REFRESH_MS)
    // 回到窗口时立刻补一次，免得刚打开就看到几十秒前的数字。
    const onFocus = () => {
      void reads.refresh({ trailing: true })
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    // 首次构建索引要遍历全部会话文件：运行时按进度推送，这里跟着刷新，页面因此是
    // 逐个填充而不是先空着等一次全量扫描。
    // 页签没显示时整段都不挂（上面的 early return）：可见时索引补齐的进度推送直接跟着刷，
    // 页面因此是逐个填充而不是先空着等一次全量扫描。
    const offChanged = window.mica.stats.onChanged?.(() => {
      // 扫描进度可能比读取更快：在途时只补一次最新结果，避免整份统计叠着传输/解析。
      void reads.refresh({ trailing: true })
    })
    return () => {
      reads.dispose()
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
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

  const overview = useMemo(() => buildOverview(activeScoped, range), [activeScoped, range])
  const modelFilter = overview.models.some((row) => row.id === selectedModel) ? selectedModel : null
  const projectFilter = overview.projects.some((row) => row.id === selectedProject)
    ? selectedProject
    : null
  const filteredSessions = useMemo(
    () =>
      sessionScoped.filter(
        (session) =>
          (projectFilter === null || (session.cwd || '') === projectFilter) &&
          (modelFilter === null ||
            session.modelUsage.some((usage) => usage.model === modelFilter && usage.requests > 0))
      ),
    [sessionScoped, modelFilter, projectFilter]
  )
  const progress = snap?.progress
  const showReport = (next) => {
    setReport(next)
    document.getElementById('stats-details')?.scrollIntoView({ block: 'start' })
  }
  const selectModel = (id) => {
    setSelectedModel(id)
    setSelectedProject(null)
    showReport('models')
  }
  const selectProject = (id) => {
    setSelectedProject(id)
    setSelectedModel(null)
    showReport(id === null ? 'projects' : 'sessions')
  }
  const rangeText = isDayRange(range)
    ? range.day
    : RANGE_OPTIONS.find(([value]) => value === range)?.[1]
  const periodText = overview.days.length
    ? `${overview.days[0].day} — ${overview.days.at(-1).day}`
    : rangeText

  return (
    <section
      className={`stats-view min-h-0 flex-1 flex-col overflow-hidden ${visible ? 'flex' : 'hidden'}`}
      aria-hidden={!visible}
    >
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="stats-page">
          <header className="stats-header">
            <div>
              <h1>用量全景</h1>
              <p className="stats-meta">
                {periodText} · {overview.totals.activeSessions} 个活跃会话
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isDayRange(range) && (
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() => setRange('today')}
                  title="清除单日筛选"
                  icon={<IconX size={12} />}
                >
                  {dayShort(range.day)}
                </Button>
              )}
              <Segmented
                size="compact"
                value={isDayRange(range) ? 'day' : range}
                options={RANGE_OPTIONS.map(([value, label]) => ({ value, label }))}
                ariaLabel="统计区间"
                onChange={setRange}
              />
            </div>
          </header>
          {progress?.building && (
            <Alert
              type="info"
              content={`正在统计会话用量 ${progress.done} / ${progress.total}，先展示已统计的部分…`}
            />
          )}
          <OverviewVisuals
            overview={overview}
            metric={metric}
            onMetricChange={setMetric}
            onSelectModel={selectModel}
            onSelectProject={selectProject}
          />
          <StatsPanel
            title="精确明细"
            extra={
              report === 'activity'
                ? '日历按年份独立展示，不受顶部区间影响'
                : '与上方图表使用同一统计区间'
            }
            className="stats-details"
          >
            <div id="stats-details" className="stats-detail-tabs">
              <Segmented
                size="compact"
                value={report}
                options={REPORT_OPTIONS}
                ariaLabel="用量明细"
                onChange={setReport}
              />
            </div>
            {(modelFilter !== null || projectFilter !== null) && (
              <div className="stats-detail-toolbar">
                <>
                  <span className="stats-meta">
                    会话筛选：
                    {modelFilter ??
                      overview.projects.find((row) => row.id === projectFilter)?.label}
                    ，上方指标仍为全区间
                  </span>
                  <Button
                    size="compact"
                    variant="ghost"
                    onClick={() => {
                      setSelectedModel(null)
                      setSelectedProject(null)
                    }}
                  >
                    清除筛选
                  </Button>
                </>
              </div>
            )}
            {report === 'sessions' &&
              (filteredSessions.length ? (
                <BySessionCard
                  key={`${JSON.stringify(range)}:${modelFilter}:${projectFilter}`}
                  scoped={filteredSessions}
                  onDetail={setDetailSessionId}
                />
              ) : (
                <Empty description="当前筛选下没有会话用量" />
              ))}
            {report === 'sources' &&
              (activeScoped.length ? (
                <BySourceCard scoped={activeScoped} />
              ) : (
                <Empty description="当前区间没有来源用量" />
              ))}
            {report === 'models' && (
              <BreakdownReport
                rows={overview.models}
                type="models"
                total={overview.totals.totalTokens}
                selected={modelFilter}
                onSelect={(id) => {
                  setSelectedModel(id)
                  setSelectedProject(null)
                  showReport('sessions')
                }}
              />
            )}
            {report === 'projects' && (
              <BreakdownReport
                rows={overview.projects}
                type="projects"
                total={overview.totals.totalTokens}
                selected={projectFilter}
                onSelect={selectProject}
              />
            )}
            {report === 'speed' && <ModelPerformanceCard scoped={activeScoped} />}
            {report === 'activity' && (
              <ActivityReport
                sessions={sessions}
                range={range}
                onSelectDay={(day) => setRange({ day })}
                calendar={calendar}
              />
            )}
          </StatsPanel>
        </div>
      </div>
      {detailSessionId && (
        <SessionDetailModal sessionId={detailSessionId} onClose={() => setDetailSessionId(null)} />
      )}
    </section>
  )
}
