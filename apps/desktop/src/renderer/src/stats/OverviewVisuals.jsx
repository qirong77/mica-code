import { StackedShareBar } from './charts'
import { bucketByDay } from './scope'
import { USAGE_TOKEN_PARTS } from './usage-series'
import { addDays } from './geometry'

function short(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return String(Math.round(n))
}

function DailyTrend({ rows, field, label }) {
  const max = Math.max(0, ...rows.map((row) => row[field]))
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-fg-dim">{label} · 按日</div>
      <div className="mt-2 flex h-10 items-end gap-px" role="img" aria-label={`${label}每日变化`}>
        {rows.map((row) => (
          <span key={row.day} className="min-w-0 flex-1 rounded-t-sm bg-fg-faint" style={{ maxWidth: 12, height: `${max && row[field] > 0 ? Math.max(3, row[field] / max * 100) : 0}%` }} title={`${row.day}: ${row[field].toLocaleString()}`} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-fg-faint">
        <span>{rows[0]?.day || '暂无数据'}</span>
        {rows.length > 1 && <span>{rows[rows.length - 1].day}</span>}
      </div>
    </div>
  )
}

export function OverviewVisuals({ scoped, totals }) {
  const days = bucketByDay(scoped)
  const keys = [...days.keys()].sort()
  const rows = []
  if (keys.length) {
    for (let day = keys[0]; day <= keys[keys.length - 1]; day = addDays(day, 1)) {
      rows.push(days.get(day) || { day, requests: 0, tokens: 0 })
    }
  }
  const values = [totals.cachedInputTokens, totals.uncachedInputTokens, totals.outputTokens]
  const total = values.reduce((sum, n) => sum + Math.max(0, n), 0)
  const parts = USAGE_TOKEN_PARTS.map((part, i) => ({ ...part, value: values[i], title: `${part.label}: ${values[i].toLocaleString()}` }))
  return (
    <div className="grid grid-cols-1 gap-5 border-t border-line px-4 py-4 md:grid-cols-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-dim">Token 构成</h2>
          <span className="text-[11px] text-fg-faint">缓存命中率 {totals.inputTokens > 0 ? `${(totals.cacheRate * 100).toFixed(1)}%` : '—'}</span>
        </div>
        <div className="mt-3"><StackedShareBar segments={parts} ariaLabel="Token 构成：缓存输入、未缓存输入、输出" /></div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-fg-dim">
          {parts.map((part) => <span key={part.key} className="inline-flex items-center gap-1.5" title={part.title}>
            <span aria-hidden className="size-2 rounded-full" style={{ background: part.color }} />
            {part.label} <strong className="font-medium text-fg-muted tabular-nums">{short(part.value)}</strong>
            <span className="tabular-nums">{total ? `${(part.value / total * 100).toFixed(1)}%` : '—'}</span>
          </span>)}
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-4">
        <DailyTrend rows={rows} field="requests" label="模型请求" />
        <DailyTrend rows={rows} field="tokens" label="处理 Tokens" />
      </div>
    </div>
  )
}
