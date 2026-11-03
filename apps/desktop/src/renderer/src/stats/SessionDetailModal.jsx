import { useEffect, useMemo, useState } from 'react'
import { Segmented, SelectMenu, SessionDetailView } from '@mica-config-ui/web'
import { usageSourceOf } from '@packages/mica-web-shared/usage-source.js'
import { BarSeries, StackedShareBar } from './charts'
import {
  USAGE_KIND_COLORS,
  USAGE_KIND_LABELS,
  USAGE_TOKEN_PARTS,
  buildUsageSeries,
  projectRequest
} from './usage-series'
import { ModalShell } from '../chat-modal'

const OVERLINE_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-dim'
const CARD_CLASS = 'rounded-[5px] border border-line bg-panel px-4 py-3'

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 图表横轴用的短时间：一次会话通常在同一天内，带日期是为了跨天时也认得出。 */
function stampShort(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtTokens(value) {
  const n = Number(value) || 0
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

function pct(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

function StatCard({ label, primary, secondary, title }) {
  return (
    <div className="rounded-[4px] border border-line bg-panel-hi px-2.5 py-2" title={title}>
      <div className="text-[10px] uppercase tracking-wide text-fg-faint">{label}</div>
      <div className="mt-0.5 font-mono text-xs text-fg-strong tabular-nums">{primary}</div>
      <div className="mt-0.5 font-mono text-[10px] text-fg-dim tabular-nums">{secondary}</div>
    </div>
  )
}

const PART_COLORS = Object.fromEntries(USAGE_TOKEN_PARTS.map((part) => [part.key, part.color]))
const CHART_MODES = [
  { value: 'total', label: '总量' },
  { value: 'input', label: '输入' },
  { value: 'output', label: '输出' }
]

/** 一次请求在三种指标下的堆叠段：总量看构成，输入只看上下文，输出只看生成。 */
function barSegments(request, mode) {
  if (mode === 'output') {
    return [{ key: 'output', value: request.output, color: PART_COLORS.output }]
  }
  const segments = [
    { key: 'cached', value: request.cached, color: PART_COLORS.cached },
    { key: 'uncached', value: request.input - request.cached, color: PART_COLORS.uncached }
  ]
  return mode === 'input'
    ? segments
    : [...segments, { key: 'output', value: request.output, color: PART_COLORS.output }]
}

/**
 * 逐次请求的柱状图：每次模型请求一根柱，按时间从左到右。
 *
 * 这张图回答的是表格回答不了的问题——「钱花在哪几次请求上」「上下文是怎么涨起来的」。
 * 输入逐条上涨是回放上一轮的输出（reasoning 的思考同样计入下一次 input），趋势一眼可见，
 * 不必只靠一句脚注解释。
 */
function RequestChartCard({ series }) {
  const [mode, setMode] = useState('total')
  const requests = series.requests
  if (requests.length === 0) return null

  const stride = Math.max(1, Math.ceil(requests.length / 6))
  const lastPhase = (requests.length - 1) % stride
  const xLabels = requests
    .map((request, index) => ({ index, label: stampShort(request.at) }))
    .filter(({ index }) => index % stride === lastPhase)

  const legendKeys =
    mode === 'output'
      ? ['output']
      : mode === 'input'
        ? ['cached', 'uncached']
        : ['cached', 'uncached', 'output']
  const legendValues = {
    cached: series.totals.cached,
    uncached: series.composition.uncached,
    output: series.totals.output
  }

  return (
    <section className={CARD_CLASS}>
      <header className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className={OVERLINE_CLASS}>逐次请求</h3>
        <span className="mica-config-ui is-embed">
          <Segmented
            size="compact"
            value={mode}
            options={CHART_MODES}
            ariaLabel="图表指标"
            onChange={setMode}
          />
        </span>
      </header>
      <BarSeries
        columns={requests.map((request) => ({
          key: request.key || `req-${request.index}`,
          segments: barSegments(request, mode)
        }))}
        formatTick={fmtTokens}
        xLabels={xLabels}
        renderTooltip={(index) => {
          const request = requests[index]
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5 font-medium text-fg-strong">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: USAGE_KIND_COLORS[request.kind] }}
                />
                <span>
                  {request.sourceLabel} · 第 {index + 1} 次
                </span>
              </div>
              <div className="font-mono text-[11px] text-fg-muted">
                {fmtTime(request.at)} · {request.model || '—'}
              </div>
              <div className="font-mono text-[11px] text-fg-muted">
                输入 {request.input.toLocaleString()}（缓存 {request.cached.toLocaleString()}）·
                输出 {request.output.toLocaleString()}
              </div>
              <div className="font-mono text-[11px] text-fg-faint">
                本次 {fmtTokens(request.total)} · 累计 {fmtTokens(request.cumulative)}
              </div>
            </div>
          )
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {legendKeys.map((key) => {
          const part = USAGE_TOKEN_PARTS.find((item) => item.key === key)
          return (
            <span key={key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 rounded-[2px]"
                style={{ background: part.color }}
              />
              <span className="text-fg-dim">{part.label}</span>
              <span className="font-mono text-fg-muted tabular-nums">
                {fmtTokens(legendValues[key])}
              </span>
            </span>
          )
        })}
        <span className="ml-auto text-fg-ghost">悬停看单次请求 · 共 {requests.length} 次</span>
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-fg-ghost">
        输入逐条上涨多为上一轮的输出被回放：思考型模型（reasoning）的思考内容同样计入下一次
        input，所以「输出」和「输入增长」会一起变大。
      </p>
    </section>
  )
}

/** 四类来源的占比：一条堆叠条 + 每类的请求数、输入输出与份额。 */
function SourceShareCard({ series }) {
  if (series.byKind.length < 2) return null
  const total = series.totals.total
  return (
    <section className={CARD_CLASS}>
      <header className="mb-2 flex items-center justify-between">
        <h3 className={OVERLINE_CLASS}>用量来源</h3>
        <span className="font-mono text-[11px] text-fg-faint tabular-nums">
          {fmtTokens(total)} tokens
        </span>
      </header>
      <StackedShareBar
        ariaLabel="用量来源占比"
        segments={series.byKind.map((row) => ({
          key: row.kind,
          value: row.total,
          color: row.color,
          title: `${row.label} ${fmtTokens(row.total)}`
        }))}
      />
      <div className="mt-2 flex flex-col gap-1">
        {series.byKind.map((row) => (
          <div key={row.kind} className="flex items-center gap-2 text-[11px]">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: row.color }}
            />
            <span className="w-24 shrink-0 truncate text-fg-strong">{row.label}</span>
            <span className="font-mono text-fg-dim tabular-nums">{row.requests} req</span>
            <span className="ml-auto font-mono text-fg-muted tabular-nums">
              {fmtTokens(row.input)} in · {fmtTokens(row.output)} out
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-fg-faint tabular-nums">
              {total > 0 ? `${((row.total / total) * 100).toFixed(1)}%` : '—'}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function UsageTable({
  rows,
  title,
  showSource = false,
  pageSizeOptions = [5, 10, 20, 50, 100],
  defaultPageSize = 10
}) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  if (!rows || rows.length === 0) return null
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, totalPages - 1)
  const shown = rows.slice(current * pageSize, (current + 1) * pageSize)
  const total = rows.reduce(
    (acc, u) => {
      acc.input += u.input || 0
      acc.cached += u.cached || 0
      acc.output += u.output || 0
      acc.total += u.total || 0
      return acc
    },
    { input: 0, cached: 0, output: 0, total: 0 }
  )
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
        <span className="text-fg-faint">{title}</span>
        <span className="tabular-nums">
          {rows.length} req · {fmtTokens(total.input)} in · {fmtTokens(total.output)} out
        </span>
        <span className="tabular-nums text-fg-dim">
          缓存率 {total.input > 0 ? `${((total.cached / total.input) * 100).toFixed(1)}%` : '—'}
        </span>
      </div>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed text-[11px]">
          <colgroup>
            <col className="w-[17%]" />
            {showSource && <col className="w-[9%]" />}
            <col className="w-[22%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-fg-faint">
              <th scope="col" className="whitespace-nowrap pb-1 text-left font-normal">
                时间
              </th>
              {showSource && (
                <th scope="col" className="whitespace-nowrap pb-1 text-left font-normal">
                  来源
                </th>
              )}
              <th scope="col" className="whitespace-nowrap pb-1 text-left font-normal">
                模型
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                输入
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                缓存
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                未缓存
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                输出
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                缓存率
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u, i) => (
              <tr key={u.key || `${title}-${i}`} className="border-t border-line">
                <td className="py-1 pr-2 whitespace-nowrap font-mono text-[10px] text-fg-dim tabular-nums">
                  {fmtTime(u.at)}
                </td>
                {showSource && (
                  <td className="truncate py-1 pr-2 text-[10px] text-fg-dim">
                    {u.sourceLabel || '—'}
                  </td>
                )}
                <td
                  className="truncate py-1 pr-2 font-mono text-[10px] text-fg-muted"
                  title={u.model}
                >
                  {u.model || '—'}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-muted tabular-nums">
                  {(u.input || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-dim tabular-nums">
                  {(u.cached || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-muted tabular-nums">
                  {((u.input || 0) - (u.cached || 0)).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-muted tabular-nums">
                  {(u.output || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-dim tabular-nums">
                  {u.input > 0 ? pct(u.cached / u.input, 0) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1 text-[10px] text-fg-faint">
          每页
          <span className="mica-config-ui is-embed">
            <SelectMenu
              size="compact"
              value={String(pageSize)}
              options={pageSizeOptions.map((size) => ({
                value: String(size),
                label: String(size)
              }))}
              ariaLabel="每页条数"
              onChange={(next) => {
                setPageSize(Number(next))
                setPage(0)
              }}
            />
          </span>
          条
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={current === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-[4px] border border-line bg-panel-hi px-2 py-0.5 text-[10px] text-fg-muted transition-colors enabled:hover:text-fg-strong disabled:opacity-40"
            >
              上一页
            </button>
            <span className="font-mono text-[10px] text-fg-faint tabular-nums">
              {current + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={current >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="rounded-[4px] border border-line bg-panel-hi px-2 py-0.5 text-[10px] text-fg-muted transition-colors enabled:hover:text-fg-strong disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function UsageRecordCard({ record, source }) {
  const requests = useMemo(
    () => (record.requests || []).map((usage) => projectRequest(usage, source.kind, source.id)),
    [record, source]
  )
  const summary = record.summary || {}
  const title =
    source.kind === 'plugin' ? source.pluginId || record.subagentType : record.subagentType
  return (
    <div className="rounded-[4px] border border-line bg-panel-hi px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="rounded-[3px] bg-warn/12 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
          {title || 'request'}
        </span>
        <span className="rounded-[3px] bg-panel px-1.5 py-0.5 text-[10px] text-fg-dim">
          {USAGE_KIND_LABELS[source.kind]}
        </span>
        <span
          className={`rounded-[3px] px-1.5 py-0.5 text-[10px] font-medium uppercase ${
            record.status === 'completed'
              ? 'bg-success/12 text-success-soft'
              : record.status === 'failed'
                ? 'bg-danger/12 text-danger-soft'
                : 'bg-panel-hi text-fg'
          }`}
        >
          {record.status || '—'}
        </span>
        {record.description && (
          <span className="truncate text-[11px] text-fg" title={record.description}>
            {record.description}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-fg-faint tabular-nums">
          {requests.length} req · {fmtTokens(summary.totalTokens || 0)} tokens
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-fg-faint">
        {record.taskId && <span title={record.taskId}>task {record.taskId}</span>}
        {record.initiatedByCallId && (
          <span title={record.initiatedByCallId}>call {record.initiatedByCallId}</span>
        )}
        {record.parentTaskId && (
          <span title={record.parentTaskId}>parent {record.parentTaskId}</span>
        )}
        {record.model && <span>{record.model}</span>}
        <span>
          {fmtTime(record.startedAt)}
          {record.finishedAt ? ` → ${fmtTime(record.finishedAt)}` : ''}
        </span>
      </div>
      {requests.length > 0 && (
        <details className="group mt-1">
          <summary className="cursor-pointer select-none text-[10px] text-fg-faint hover:text-fg-muted">
            <span className="group-open:hidden">展开逐条请求</span>
            <span className="hidden group-open:inline">收起逐条请求</span>
          </summary>
          <UsageTable rows={requests} title={`${title || '请求'} 请求`} />
        </details>
      )}
    </div>
  )
}

const SOURCE_SECTION_TITLES = {
  delegation: 'Delegated subagents',
  plugin: '插件请求',
  helper: '内核后台请求'
}
const SOURCE_SECTION_HINTS = {
  delegation: '主对话经工具派出去的子代理：自己的上下文，但花的是同一条会话的钱。',
  plugin: '插件自己的模型请求与它起的后台任务（自动起标题、写提交说明、整理记忆…）。',
  helper: '内核自带的助手请求（压缩摘要、桌面旁问）：不进主上下文，但同样计入本会话。'
}

/**
 * 会话详情：与上下文弹窗、配置页的 Sessions 页共用 `SessionDetailView`（系统提示词 /
 * 对话记录 / Context 分析 / 原始文件），这里只多一个统计页专属的「用量」页签。
 *
 * 用量页签讲三件事，顺序就是从「总量」到「明细」：多少 token、花在谁身上、哪几次请求
 * 最贵。前两件靠数字和占比条，第三件靠逐次请求的柱状图——三个表格并排放着谁也不想读。
 */
export function SessionDetailModal({ sessionId, onClose }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)
    window.mica.stats
      .sessionDetail(sessionId)
      .then((data) => {
        if (alive) setDetail(data)
      })
      .catch((err) => {
        if (alive) setError(String(err?.message || err))
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  const usageHistory = useMemo(() => detail?.usageHistory || [], [detail])
  const records = useMemo(() => detail?.subagentUsageHistory || [], [detail])
  // 同一份数组里装着所有「不进主上下文」的请求：委派子代理、插件自己的模型请求、
  // 内核后台助手。归到哪一类由 `usageSourceOf` 统一判定，和统计页的总表同源。
  const groups = useMemo(() => {
    const byKind = new Map()
    for (const record of records) {
      const source = usageSourceOf(record)
      const list = byKind.get(source.kind) || []
      list.push({ record, source })
      byKind.set(source.kind, list)
    }
    return ['delegation', 'plugin', 'helper']
      .filter((kind) => byKind.has(kind))
      .map((kind) => ({
        kind,
        items: byKind
          .get(kind)
          .sort(
            (a, b) =>
              (b.record.summary?.totalTokens || 0) - (a.record.summary?.totalTokens || 0) ||
              String(a.source.id).localeCompare(String(b.source.id))
          )
      }))
  }, [records])

  const series = useMemo(() => buildUsageSeries(usageHistory, records), [usageHistory, records])
  const mainRequests = useMemo(
    () => series.byKind.find((row) => row.kind === 'main')?.requests || 0,
    [series]
  )

  // 最后一次请求的输入 / 会话上下文窗口：打开详情最常问的一句是「这会话还塞得下吗」。
  const occupancy = useMemo(() => {
    const windowSize = Number(detail?.contextWindowSize) || 0
    const used = Number(detail?.lastUsage?.inputTokens) || 0
    if (!windowSize || !used) return null
    return { used, windowSize, ratio: Math.min(1, used / windowSize) }
  }, [detail])

  const usageTab = useMemo(
    () => ({
      id: 'usage',
      label: '用量',
      content: (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard
              label="请求"
              primary={`${series.totals.requests} req`}
              secondary={`主对话 ${mainRequests} · 其它 ${series.totals.requests - mainRequests}`}
            />
            <StatCard
              label="输入"
              primary={fmtTokens(series.totals.input)}
              secondary={`缓存 ${fmtTokens(series.totals.cached)}`}
            />
            <StatCard
              label="输出"
              primary={fmtTokens(series.totals.output)}
              secondary={`每次 ${fmtTokens(series.totals.requests > 0 ? series.totals.output / series.totals.requests : 0)}`}
            />
            <StatCard
              label="合计"
              primary={fmtTokens(series.totals.total)}
              secondary={`${series.totals.input.toLocaleString()} in · ${series.totals.output.toLocaleString()} out`}
            />
            <StatCard
              label="缓存率"
              primary={pct(series.totals.cacheRate)}
              secondary={`${series.totals.cached.toLocaleString()} cached`}
            />
            <StatCard
              label="上下文占用"
              title="最后一次请求的输入量 / 这个会话的上下文窗口"
              primary={occupancy ? pct(occupancy.ratio, 0) : '—'}
              secondary={
                occupancy
                  ? `${fmtTokens(occupancy.used)} / ${fmtTokens(occupancy.windowSize)}`
                  : '没有记录'
              }
            />
          </div>
          <SourceShareCard series={series} />
          <RequestChartCard series={series} />
          <UsageTable
            rows={series.requests}
            title="逐条请求（主对话 + 委派 + 插件 + 内核后台，按时间排序）"
            showSource
          />

          {groups.map((group) => (
            <section key={group.kind}>
              <h3 className={OVERLINE_CLASS}>{SOURCE_SECTION_TITLES[group.kind]}</h3>
              <p className="mt-1 text-[10px] text-fg-ghost">{SOURCE_SECTION_HINTS[group.kind]}</p>
              <div className="mt-2 flex flex-col gap-2">
                {group.items.map(({ record, source }) => (
                  <UsageRecordCard
                    key={`${source.kind}-${source.id}-${record.taskId || record.startedAt}`}
                    record={record}
                    source={source}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )
    }),
    [groups, mainRequests, occupancy, series]
  )

  return (
    <ModalShell bare onClose={onClose} className="chat-modal-session-detail">
      {error ? (
        <div className="rounded-[4px] border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger-soft">
          {error}
        </div>
      ) : (
        <div className="mica-config-ui is-embed session-detail-embed">
          <SessionDetailView
            sessionId={sessionId}
            defaultTab="conversation"
            extraTabs={[usageTab]}
          />
        </div>
      )}
    </ModalShell>
  )
}
