import { useEffect, useState } from 'react'
import Statistic from '@arco-design/web-react/es/Statistic'
import { Button, Empty, Segmented } from '@mica-config-ui/web'
import { StatsPanel } from './StatsPanel'
import { DonutChart, TrendChart } from './usage-charts'
import { USAGE_TOKEN_PARTS } from './usage-series'

const TOKEN_FIELDS = {
  cached: 'cachedInputTokens',
  uncached: 'uncachedInputTokens',
  output: 'outputTokens'
}
const METRIC_OPTIONS = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'requests', label: '请求' }
]

function count(value) {
  return value.toLocaleString('en-US')
}

function tokens(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return count(value)
}

function percentage(value, total) {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '—'
}

function cacheRateLabel(totals) {
  return totals.inputTokens > 0 && Number.isFinite(totals.cacheRate)
    ? `${(totals.cacheRate * 100).toFixed(1)}%`
    : '—'
}

function MetricStrip({ totals }) {
  const hasCacheRate = totals.inputTokens > 0 && Number.isFinite(totals.cacheRate)
  const items = [
    { key: 'totalTokens', label: '处理 Tokens', value: totals.totalTokens, note: '输入与输出合计' },
    { key: 'requests', label: '模型请求', value: totals.requests, note: '包含主对话与后台' },
    {
      key: 'activeSessions',
      label: '活跃会话',
      value: totals.activeSessions,
      note: '有模型用量的会话'
    },
    {
      key: 'cacheRate',
      label: '缓存命中率',
      value: hasCacheRate ? totals.cacheRate * 100 : '—',
      precision: hasCacheRate ? 1 : undefined,
      suffix: hasCacheRate ? '%' : undefined,
      note: '缓存输入 / 全部输入'
    }
  ]
  return (
    <StatsPanel className="stats-metrics-panel">
      <div className="stats-metrics">
        {items.map((item) => (
          <div
            className="stats-metric"
            key={item.key}
            data-metric={item.key}
            data-value={totals[item.key] ?? ''}
            title={
              item.key === 'cacheRate'
                ? `${count(totals.cachedInputTokens)} / ${count(totals.inputTokens)} 输入 Tokens`
                : `${item.label} ${count(item.value)}`
            }
          >
            <Statistic
              title={item.label}
              value={item.value}
              precision={item.precision}
              suffix={item.suffix}
              countUp={false}
              groupSeparator
            />
            <span className="stats-meta">{item.note}</span>
          </div>
        ))}
      </div>
    </StatsPanel>
  )
}

function TokenRing({ totals, rows, selectedKey, onSelect }) {
  const empty = totals.totalTokens <= 0
  const selected = rows.find((row) => row.id === selectedKey)
  return (
    <StatsPanel title="Token 构成" extra="全部 Tokens 为分母">
      {empty ? (
        <div className="stats-chart-empty">
          <Empty description="所选区间没有 Token 用量" />
        </div>
      ) : (
        <div className="stats-ring-layout">
          <div className="stats-ring">
            <DonutChart
              rows={rows}
              valueLabel="Tokens"
              formatValue={tokens}
              selectedKey={selectedKey}
              onSelect={onSelect}
              empty={empty}
            />
            <div className="stats-ring-center" aria-hidden="true">
              <span>{selected?.label || '全部用量'}</span>
              <strong>{tokens(selected?.value ?? totals.totalTokens)}</strong>
              <span>{selected ? percentage(selected.value, totals.totalTokens) : 'Tokens'}</span>
            </div>
          </div>
          <div className="stats-chart-legend" aria-label="Token 构成数值">
            {rows.map((row) => (
              <Button
                key={row.id}
                variant="ghost"
                size="compact"
                fullWidth
                pressed={selectedKey === row.id}
                className={`stats-legend-action${selectedKey === row.id ? ' is-selected' : ''}`}
                title={`${row.label} · ${count(row.value)} Tokens · 占全部 ${percentage(row.value, totals.totalTokens)}`}
                onClick={() => onSelect(row.id)}
              >
                <span className="stats-legend-content">
                  <span className="stats-legend-name">
                    <i aria-hidden="true" style={{ background: row.color }} />
                    <span>{row.label}</span>
                  </span>
                  <strong>{tokens(row.value)}</strong>
                  <span>{percentage(row.value, totals.totalTokens)}</span>
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}
      <p className="stats-note">
        缓存占总量 {percentage(totals.cachedInputTokens, totals.totalTokens)}；缓存命中率{' '}
        {cacheRateLabel(totals)} 仅以输入为分母。
      </p>
    </StatsPanel>
  )
}

function Trend({ days, hasUsage, metric, onMetricChange, selectedDay, onSelectDay }) {
  const selected = days.find((row) => row.day === selectedDay)
  const singleDay = days.length === 1
  const exactDay = selected || (singleDay && hasUsage ? days[0] : null)
  return (
    <StatsPanel
      title="用量趋势"
      extra={
        <Segmented
          ariaLabel="趋势与模型排行指标"
          size="compact"
          value={metric}
          options={METRIC_OPTIONS}
          onChange={onMetricChange}
        />
      }
      className="stats-trend-panel"
    >
      <div className="stats-chart-subtitle">
        <span>每日{metric === 'requests' ? '请求量' : '处理量'}</span>
        {days.length > 0 && (
          <span>
            {days[0].day}
            {!singleDay && ` — ${days.at(-1).day}`}
          </span>
        )}
      </div>
      {hasUsage && days.length ? (
        <TrendChart
          rows={days}
          metric={metric}
          formatValue={metric === 'requests' ? count : tokens}
          onSelectDay={onSelectDay}
        />
      ) : (
        <div className="stats-chart-empty">
          <Empty description="所选区间没有每日用量" />
        </div>
      )}
      <div className="stats-chart-caption" aria-live="polite">
        {exactDay ? (
          <>
            <span>
              {exactDay.day} · {count(exactDay.requests)} 请求 · {count(exactDay.tokens)} Tokens
            </span>
            {selected && (
              <Button variant="ghost" size="compact" onClick={() => onSelectDay(null)}>
                清除选日
              </Button>
            )}
          </>
        ) : (
          <span>
            {hasUsage && days.length
              ? '点选日期查看精确用量；选日仅查看，不改变区间总量。'
              : '暂无数据'}
          </span>
        )}
      </div>
      {singleDay && <p className="stats-note">单日汇总，不推测小时变化</p>}
    </StatsPanel>
  )
}

function ModelRanking({ rows, metric, total, onSelect }) {
  const visible = rows.slice(0, 6)
  const largest = visible[0]?.[metric] || 1
  const format = metric === 'requests' ? count : tokens
  const unit = metric === 'requests' ? '请求' : 'Tokens'
  return (
    <StatsPanel title="模型分布" extra={`按${unit}`}>
      <div className="stats-ranking">
        {visible.length ? (
          visible.map((row, index) => (
            <Button
              key={row.id}
              variant="ghost"
              size="compact"
              fullWidth
              className="stats-rank-action"
              title={`${row.label} · ${count(row[metric])} ${unit} · ${count(row.sessions)} 个会话`}
              onClick={() => onSelect(row.id)}
            >
              <span className="stats-rank-wrap">
                <span className="stats-rank-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="stats-rank-content">
                  <span className="stats-rank-line">
                    <strong title={row.label}>{row.label}</strong>
                    <strong>{format(row[metric])}</strong>
                  </span>
                  <span className="stats-rank-track" aria-hidden="true">
                    <span
                      className="motion-bar"
                      style={{ width: `${(row[metric] / largest) * 100}%` }}
                    />
                  </span>
                  <span className="stats-rank-line stats-meta">
                    <span>{count(row.sessions)} 个会话</span>
                    <span>{percentage(row[metric], total)}</span>
                  </span>
                </span>
              </span>
            </Button>
          ))
        ) : (
          <Empty description="所选区间没有模型用量" />
        )}
      </div>
      {rows.length > 0 && (
        <>
          <p className="stats-note">
            条长以用量最高的模型为基准，占比以全部用量为分母。点击查看精确模型明细。
          </p>
          <div className="stats-panel-footer">
            <span className="stats-meta">
              展示 {visible.length} / {count(rows.length)} 个模型
            </span>
            <Button variant="ghost" size="compact" onClick={() => onSelect(null)}>
              查看全部模型
            </Button>
          </div>
        </>
      )}
    </StatsPanel>
  )
}

/**
 * `afterMetrics` 插在 KPI 条与趋势区之间：活跃日历是「什么时候在干活」的总览，和
 * 四项 KPI 是同一层的问题（都是区间总量），排在趋势/构成之前比压到页面下半部分合适。
 * 它由 StatsView 传进来，因为这个组件不认识日历的数据来源。
 */
export function OverviewVisuals({ overview, metric, onMetricChange, onSelectModel, afterMetrics }) {
  const [selectedDay, setSelectedDay] = useState(null)
  const [selectedToken, setSelectedToken] = useState(null)
  const { totals, days, models } = overview
  const hasUsage = totals.requests > 0 || totals.totalTokens > 0
  const tokenRows = USAGE_TOKEN_PARTS.map((part) => ({
    id: part.key,
    label: part.label,
    color: part.color,
    value: totals[TOKEN_FIELDS[part.key]]
  }))
  const validDay = hasUsage && days.some((row) => row.day === selectedDay) ? selectedDay : null
  const validToken =
    totals.totalTokens > 0 && tokenRows.some((row) => row.id === selectedToken && row.value > 0)
      ? selectedToken
      : null

  useEffect(() => {
    if (selectedDay !== validDay) setSelectedDay(null)
    if (selectedToken !== validToken) setSelectedToken(null)
  }, [selectedDay, validDay, selectedToken, validToken])

  const sortedModels = hasUsage
    ? [...models].sort((a, b) => b[metric] - a[metric] || a.label.localeCompare(b.label))
    : []
  return (
    <div className="stats-overview">
      <MetricStrip totals={totals} />
      {afterMetrics}
      <div className="stats-main-grid">
        <Trend
          days={days}
          hasUsage={hasUsage}
          metric={metric}
          onMetricChange={onMetricChange}
          selectedDay={validDay}
          onSelectDay={(day) => setSelectedDay(selectedDay === day ? null : day)}
        />
        <TokenRing
          totals={totals}
          rows={tokenRows}
          selectedKey={validToken}
          onSelect={(key) => setSelectedToken(selectedToken === key ? null : key)}
        />
      </div>
      {/* 项目贡献图已经下沉成独立的「项目明细」模块（图表 + 表），banner 这一层只留
          模型排行——同一份项目堆叠图在这页出现两次只会让人以为看漏了什么。 */}
      <ModelRanking
        rows={sortedModels}
        metric={metric}
        total={metric === 'requests' ? totals.requests : totals.totalTokens}
        onSelect={onSelectModel}
      />
    </div>
  )
}
