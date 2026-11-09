import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Card from '@arco-design/web-react/es/Card'
import Statistic from '@arco-design/web-react/es/Statistic'
import { ArcoProvider, Button, DataTable, Empty, Segmented, SelectMenu } from '@mica-config-ui/web'
import { THEMES, normalizeThemePreference } from '@packages/mica-web-shared/theme.ts'
import {
  applyThemePreference,
  currentThemeName,
  subscribeTheme
} from '../../src/renderer/src/theme.js'
import { ErrorBoundary } from '../../src/renderer/src/ErrorBoundary.jsx'
import { StackedShareBar } from '../../src/renderer/src/stats/charts.jsx'
import { SpeedBars } from '../../src/renderer/src/stats/SpeedBars.jsx'
import {
  USAGE_KIND_COLORS,
  USAGE_KIND_ORDER,
  USAGE_TOKEN_PARTS
} from '../../src/renderer/src/stats/usage-series.js'
import { DonutChart, ProjectChart, TrendChart, TreemapChart } from './charts.jsx'
import { ACTIVITY, MODELS, PERIOD, PROJECTS, SESSIONS, SOURCES, SPEED, TOTALS } from './fixture.js'
import '../../src/renderer/assets/app.css'
import './probe.css'

const DESIGNS = {
  a: {
    label: '用量全景',
    description: '先看总量与变化，再看 Token 构成和用量集中在哪里。推荐作为默认首页。'
  },
  b: {
    label: '来源分析',
    description: '以请求发起者为中心，区分主对话与后台用量，点选环形图联动来源详情。'
  },
  c: {
    label: '项目地图',
    description: '以项目为中心，用矩形面积表达用量集中度，点选项目查看会话与请求。'
  }
}
const DESIGN_OPTIONS = Object.entries(DESIGNS).map(([value, design]) => ({
  value,
  label: `${value.toUpperCase()} · ${design.label}`
}))
const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  ...THEMES.map(({ id, label }) => ({ value: id, label }))
]
const REPORT_OPTIONS = [
  { value: 'sessions', label: '会话明细' },
  { value: 'sources', label: '来源明细' },
  { value: 'models', label: '模型明细' },
  { value: 'projects', label: '项目明细' },
  { value: 'speed', label: '模型速度' }
]
const PERIOD_DAYS = ACTIVITY.filter((row) => row.day >= PERIOD.start && row.day <= PERIOD.end)
const MODEL_COLORS = ['var(--color-accent)', 'var(--color-fg-faint)', 'var(--color-success)']
const PROJECT_COLORS = [
  'var(--color-teal)',
  'var(--color-success)',
  'var(--color-purple)',
  'var(--color-fg-faint)'
]
const TOKEN_ROWS = USAGE_TOKEN_PARTS.map((part) => ({
  ...part,
  id: part.key,
  value: TOTALS[part.key]
}))
const SOURCE_PARTS = USAGE_KIND_ORDER.map((key) => ({
  key,
  label: SOURCES.find((row) => row.kind === key)?.label || key,
  color: USAGE_KIND_COLORS[key]
}))

function tokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return Math.round(value).toLocaleString()
}
function count(value) {
  return Math.round(value).toLocaleString()
}
function percentage(value, total) {
  return `${total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'}%`
}
function format(metric) {
  return metric === 'requests' ? count : tokens
}
function unit(metric) {
  return metric === 'requests' ? '请求' : 'Tokens'
}

function Panel({ title, extra, children, className = '' }) {
  return (
    <Card
      className={`probe-card ${className}`}
      size="small"
      title={title}
      extra={typeof extra === 'string' ? <span className="probe-meta">{extra}</span> : extra}
    >
      {children}
    </Card>
  )
}

function MetricStrip({ empty }) {
  const items = [
    {
      label: '处理 Tokens',
      value: empty ? 0 : 48.6,
      precision: 1,
      suffix: 'M',
      note: '输入与输出合计',
      key: 'tokens'
    },
    {
      label: '模型请求',
      value: empty ? 0 : TOTALS.requests,
      note: '包含主对话与后台',
      key: 'requests'
    },
    {
      label: '活跃会话',
      value: empty ? 0 : TOTALS.sessions,
      note: '有模型用量的会话',
      key: 'sessions'
    },
    {
      label: '缓存命中率',
      value: empty ? '—' : TOTALS.cacheRate,
      precision: empty ? undefined : 1,
      suffix: empty ? undefined : '%',
      note: '缓存输入 / 全部输入',
      key: 'cacheRate'
    }
  ]
  return (
    <Card className="probe-metrics-card" size="small">
      <div className="probe-metrics">
        {items.map((item) => (
          <div
            className="probe-metric"
            key={item.key}
            data-metric={item.key}
            data-value={empty ? 0 : TOTALS[item.key]}
          >
            <Statistic
              title={item.label}
              value={item.value}
              precision={item.precision}
              suffix={item.suffix}
              countUp={false}
              groupSeparator
            />
            <span className="probe-meta">{item.note}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function ChartLegend({ rows, metric = 'tokens', selectedKey, onSelect }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  return (
    <div className="probe-chart-legend" aria-label="图表数值">
      {rows.map((row) => {
        const content = (
          <span className="probe-legend-content">
            <span className="probe-legend-name">
              <i style={{ background: row.color }} />
              {row.label}
            </span>
            <strong>{format(metric)(row.value)}</strong>
            <span>{percentage(row.value, total)}</span>
          </span>
        )
        return onSelect ? (
          <Button
            key={row.id}
            variant="ghost"
            size="compact"
            fullWidth
            pressed={selectedKey === row.id}
            className={`probe-legend-action${selectedKey === row.id ? ' is-selected' : ''}`}
            onClick={() => onSelect(selectedKey === row.id ? null : row.id)}
            title={`${row.label} · ${count(row.value)} ${unit(metric)} · ${percentage(row.value, total)}`}
          >
            {content}
          </Button>
        ) : (
          <div className="probe-legend-static" key={row.id}>
            {content}
          </div>
        )
      })}
    </div>
  )
}

function Ring({
  rows,
  metric = 'tokens',
  selectedKey,
  onSelect,
  themeKey,
  empty,
  centerLabel = '总量'
}) {
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  const selected = rows.find((row) => row.id === selectedKey)
  return (
    <div className="probe-ring-layout">
      <div className="probe-ring">
        <DonutChart
          rows={rows}
          valueLabel={unit(metric)}
          formatValue={format(metric)}
          selectedKey={selectedKey}
          onSelect={onSelect}
          themeKey={themeKey}
          empty={empty}
        />
        <div className="probe-ring-center" aria-hidden="true">
          <span>{selected?.label || centerLabel}</span>
          <strong>{format(metric)(selected?.value ?? total)}</strong>
          <span>{selected ? percentage(selected.value, total) : unit(metric)}</span>
        </div>
      </div>
      {empty ? (
        <p className="probe-empty-note">所选区间没有模型用量</p>
      ) : (
        <ChartLegend rows={rows} metric={metric} selectedKey={selectedKey} onSelect={onSelect} />
      )}
    </div>
  )
}

function Trend({ metric, onMetricChange, themeKey, empty, selectedDay, onSelectDay }) {
  const selected = PERIOD_DAYS.find((row) => row.day === selectedDay)
  return (
    <Panel
      title="用量趋势"
      extra={
        <Segmented
          ariaLabel="趋势指标"
          value={metric}
          options={[
            { value: 'tokens', label: 'Tokens' },
            { value: 'requests', label: '请求' }
          ]}
          onChange={onMetricChange}
        />
      }
      className="probe-trend-card"
    >
      <div className="probe-chart-subtitle">
        <span>每日{metric === 'requests' ? '请求量' : '处理量'}</span>
        <span>
          {PERIOD.start.slice(5).replace('-', '/')} — {PERIOD.end.slice(5).replace('-', '/')}
        </span>
      </div>
      <TrendChart
        rows={empty ? [] : PERIOD_DAYS}
        metric={metric}
        formatValue={format(metric)}
        themeKey={themeKey}
        onSelectDay={onSelectDay}
      />
      <div className="probe-chart-caption" aria-live="polite">
        {selected && !empty ? (
          <>
            <span>
              {selected.day} · {count(selected.requests)} 请求 · {tokens(selected.tokens)} Tokens
            </span>
            <Button variant="ghost" size="compact" onClick={() => onSelectDay(null)}>
              清除选日
            </Button>
          </>
        ) : (
          <span>{empty ? '暂无数据' : '点选日期查看精确用量；选日仅查看，不改变区间总量。'}</span>
        )}
      </div>
    </Panel>
  )
}

function TokenBreakdown({ empty }) {
  return (
    <div className="probe-token-breakdown">
      <StackedShareBar
        segments={TOKEN_ROWS.map((row) => ({ ...row, key: row.id, value: empty ? 0 : row.value }))}
        height={10}
        ariaLabel="缓存输入、未缓存输入与输出的 Token 构成"
      />
      <div className="probe-token-values">
        {TOKEN_ROWS.map((row) => (
          <div key={row.id}>
            <span>
              <i style={{ background: row.color }} />
              {row.label}
            </span>
            <strong>{tokens(empty ? 0 : row.value)}</strong>
            <span className="probe-meta">{percentage(empty ? 0 : row.value, TOTALS.tokens)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Ranking({ rows, metric, selectedKey, onSelect, total }) {
  const largest = Math.max(1, ...rows.map((row) => row.value))
  return (
    <div className="probe-ranking">
      {rows.length ? (
        rows.map((row, index) => (
          <Button
            key={row.id}
            variant="ghost"
            size="compact"
            fullWidth
            pressed={selectedKey === row.id}
            className="probe-rank-action"
            onClick={() => onSelect(selectedKey === row.id ? null : row.id)}
          >
            <span className="probe-rank-wrap">
              <span className="probe-rank-number">{String(index + 1).padStart(2, '0')}</span>
              <span className="probe-rank-content">
                <span className="probe-rank-line">
                  <strong>{row.label}</strong>
                  <strong>{format(metric)(row.value)}</strong>
                </span>
                <span className="probe-rank-track">
                  <span
                    style={{ width: `${(row.value / largest) * 100}%`, background: row.color }}
                  />
                </span>
                <span className="probe-rank-line probe-meta">
                  <span>{row.provider || `${row.sessions} 个会话`}</span>
                  <span>{percentage(row.value, total)}</span>
                </span>
              </span>
            </span>
          </Button>
        ))
      ) : (
        <Empty description="暂无用量" />
      )}
    </div>
  )
}

function Overview({
  metric,
  onMetricChange,
  selectedToken,
  onTokenChange,
  selectedModel,
  onModelChange,
  themeKey,
  empty,
  selectedDay,
  onSelectDay
}) {
  const models = empty
    ? []
    : MODELS.map((row, index) => ({ ...row, value: row[metric], color: MODEL_COLORS[index] }))
  return (
    <div className="probe-stack">
      <div className="probe-main-grid">
        <Trend
          metric={metric}
          onMetricChange={onMetricChange}
          themeKey={themeKey}
          empty={empty}
          selectedDay={selectedDay}
          onSelectDay={onSelectDay}
        />
        <Panel title="Token 构成" extra="全部 Tokens 为分母">
          <Ring
            rows={empty ? [] : TOKEN_ROWS}
            selectedKey={selectedToken}
            onSelect={onTokenChange}
            themeKey={themeKey}
            empty={empty}
          />
          <p className="probe-note">
            缓存占总量 {empty ? '—' : percentage(TOTALS.cached, TOTALS.tokens)}；缓存命中率{' '}
            {empty ? '—' : '91.4%'} 仅以输入为分母。
          </p>
        </Panel>
      </div>
      <div className="probe-two-columns">
        <Panel title="模型分布" extra={`按${unit(metric)}`}>
          <Ranking
            rows={models}
            metric={metric}
            selectedKey={selectedModel}
            onSelect={onModelChange}
            total={empty ? 0 : TOTALS[metric]}
          />
          <p className="probe-note">
            {selectedModel
              ? `已选 ${selectedModel} · 数值仍保留全区间口径`
              : '条长以用量最高的模型为基准，占比以全部用量为分母。'}
          </p>
        </Panel>
        <Panel title="项目贡献" extra="按来源堆叠 · Tokens">
          {empty ? (
            <Empty description="暂无项目用量" />
          ) : (
            <ProjectChart
              rows={PROJECTS.map((row) => ({ ...row, values: row.parts }))}
              parts={SOURCE_PARTS}
              formatValue={tokens}
              themeKey={themeKey}
            />
          )}
          <div className="probe-inline-legend">
            {SOURCE_PARTS.map((part) => (
              <span key={part.key}>
                <i style={{ background: part.color }} />
                {part.label}
              </span>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}

function SourceAnalysis({
  metric,
  onMetricChange,
  selectedSource,
  onSourceChange,
  themeKey,
  empty,
  selectedDay,
  onSelectDay
}) {
  const rows = empty
    ? []
    : SOURCES.map((row) => ({ ...row, value: row[metric], color: USAGE_KIND_COLORS[row.kind] }))
  const selected = !empty && SOURCES.find((row) => row.id === selectedSource)
  const background = SOURCES.filter((row) => row.kind !== 'main').reduce(
    (sum, row) => sum + row[metric],
    0
  )
  return (
    <div className="probe-stack">
      <Panel
        title="用量由谁发起"
        extra={
          <Segmented
            ariaLabel="来源占比指标"
            value={metric}
            options={[
              { value: 'tokens', label: 'Tokens' },
              { value: 'requests', label: '请求' }
            ]}
            onChange={onMetricChange}
          />
        }
      >
        <div className="probe-source-hero">
          <div className="probe-source-ring">
            <Ring
              rows={rows}
              metric={metric}
              selectedKey={selectedSource}
              onSelect={onSourceChange}
              themeKey={themeKey}
              empty={empty}
              centerLabel="全部来源"
            />
          </div>
          <div className="probe-source-reading">
            <p className="probe-eyebrow">{selected ? '所选来源' : '后台用量'}</p>
            <h2>
              {empty
                ? '暂无数据'
                : selected
                  ? selected.label
                  : percentage(background, TOTALS[metric])}
            </h2>
            <p>
              {empty
                ? '产生模型请求后，这里会展示来源分布。'
                : selected
                  ? `${count(selected.requests)} 次请求，处理 ${tokens(selected.tokens)} Tokens，占全部${unit(metric)}的 ${percentage(selected[metric], TOTALS[metric])}。`
                  : `委派、插件与内核后台共 ${format(metric)(background)} ${unit(metric)}，与主对话分别呈现，不把后台请求藏进总量里。`}
            </p>
            <dl className="probe-facts">
              <div>
                <dt>主对话</dt>
                <dd>{empty ? '0' : percentage(SOURCES[0][metric], TOTALS[metric])}</dd>
              </div>
              <div>
                <dt>后台来源</dt>
                <dd>{empty ? '0' : '3'} 类</dd>
              </div>
              <div>
                <dt>计量方式</dt>
                <dd>{unit(metric)}</dd>
              </div>
            </dl>
            <p className="probe-note">
              点击扇区或图例查看来源；下方“来源明细”同步高亮。这里只展示消耗，不推算费用。
            </p>
            {selected && (
              <Button variant="ghost" size="compact" onClick={() => onSourceChange(null)}>
                查看全部来源
              </Button>
            )}
          </div>
        </div>
      </Panel>
      <div className="probe-main-grid">
        <Trend
          metric={metric}
          onMetricChange={onMetricChange}
          themeKey={themeKey}
          empty={empty}
          selectedDay={selectedDay}
          onSelectDay={onSelectDay}
        />
        <Panel title="输入与输出" extra="Tokens">
          <TokenBreakdown empty={empty} />
          <div className="probe-reading-stat">
            <Statistic
              title="缓存命中率"
              value={empty ? '—' : 91.4}
              suffix={empty ? undefined : '%'}
              precision={empty ? undefined : 1}
              countUp={false}
            />
            <p className="probe-note">以输入为分母，不与来源占比混用。</p>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function ProjectMap({
  metric,
  onMetricChange,
  selectedProject,
  onProjectChange,
  themeKey,
  empty,
  selectedDay,
  onSelectDay
}) {
  const projects = empty
    ? []
    : PROJECTS.map((row, index) => ({ ...row, value: row[metric], color: PROJECT_COLORS[index] }))
  const selected = !empty && PROJECTS.find((row) => row.id === selectedProject)
  return (
    <div className="probe-stack">
      <Panel
        title="项目用量地图"
        extra={
          <Segmented
            ariaLabel="项目面积指标"
            value={metric}
            options={[
              { value: 'tokens', label: 'Tokens' },
              { value: 'requests', label: '请求' }
            ]}
            onChange={onMetricChange}
          />
        }
      >
        <div className="probe-map-layout">
          <div>
            {empty ? (
              <div className="probe-chart-empty">
                <Empty description="所选区间没有项目用量" />
              </div>
            ) : (
              <TreemapChart
                rows={projects}
                formatValue={format(metric)}
                valueLabel={unit(metric)}
                themeKey={themeKey}
                onSelect={(id) => onProjectChange(selectedProject === id ? null : id)}
              />
            )}
            <p className="probe-note">
              矩形面积表示{unit(metric)}占比，颜色只区分项目。点击项目可筛选下方会话。
            </p>
          </div>
          <div className="probe-map-detail">
            <p className="probe-eyebrow">{selected ? '所选项目' : '用量最多的项目'}</p>
            <h2>{empty ? '暂无项目' : selected?.label || PROJECTS[0].label}</h2>
            <Ranking
              rows={projects}
              metric={metric}
              selectedKey={selectedProject}
              onSelect={onProjectChange}
              total={empty ? 0 : TOTALS[metric]}
            />
            {selected && (
              <Button variant="ghost" size="compact" onClick={() => onProjectChange(null)}>
                清除项目筛选
              </Button>
            )}
          </div>
        </div>
      </Panel>
      <div className="probe-main-grid">
        <Trend
          metric={metric}
          onMetricChange={onMetricChange}
          themeKey={themeKey}
          empty={empty}
          selectedDay={selectedDay}
          onSelectDay={onSelectDay}
        />
        <Panel title="Token 构成" extra="全区间 · 不随选中项目变化">
          <Ring rows={empty ? [] : TOKEN_ROWS} themeKey={themeKey} empty={empty} />
          <p className="probe-note">项目图用于找重点，精确数值和会话保留在下方明细。</p>
        </Panel>
      </div>
    </div>
  )
}

function UsageTable({
  kind,
  empty,
  sorts,
  onSortChange,
  selectedSource,
  selectedModel,
  selectedProject
}) {
  const columns = {
    sessions: [
      { key: 'label', label: '会话', width: '32%', sortable: true },
      { key: 'project', label: '项目', width: '17%', narrow: 'tertiary', sortable: true },
      { key: 'model', label: '主要模型', width: '21%', narrow: 'secondary' },
      { key: 'requests', label: '请求', width: '12%', align: 'right', sortable: true },
      { key: 'tokens', label: 'Tokens', width: '18%', align: 'right', sortable: true }
    ],
    sources: [
      { key: 'label', label: '来源', width: '34%', sortable: true },
      { key: 'type', label: '类型', width: '16%', narrow: 'tertiary' },
      { key: 'requests', label: '请求', width: '16%', align: 'right', sortable: true },
      { key: 'tokens', label: 'Tokens', width: '18%', align: 'right', sortable: true },
      { key: 'share', label: 'Token 占比', width: '16%', align: 'right', narrow: 'secondary' }
    ],
    models: [
      { key: 'label', label: '模型', width: '34%', sortable: true },
      { key: 'provider', label: '供应商', width: '16%', narrow: 'tertiary' },
      { key: 'requests', label: '请求', width: '16%', align: 'right', sortable: true },
      { key: 'tokens', label: 'Tokens', width: '18%', align: 'right', sortable: true },
      { key: 'share', label: 'Token 占比', width: '16%', align: 'right', narrow: 'secondary' }
    ],
    projects: [
      { key: 'label', label: '项目', width: '34%', sortable: true },
      { key: 'sessions', label: '会话', width: '16%', narrow: 'tertiary', sortable: true },
      { key: 'requests', label: '请求', width: '16%', align: 'right', sortable: true },
      { key: 'tokens', label: 'Tokens', width: '18%', align: 'right', sortable: true },
      { key: 'share', label: 'Token 占比', width: '16%', align: 'right', narrow: 'secondary' }
    ]
  }[kind]
  const sourceRows = { sessions: SESSIONS, sources: SOURCES, models: MODELS, projects: PROJECTS }[
    kind
  ]
  const rows = useMemo(() => {
    const filtered = empty
      ? []
      : sourceRows.filter(
          (row) => kind !== 'sessions' || !selectedProject || row.project === selectedProject
        )
    const sort = sorts[kind]
    return [...filtered].sort((a, b) => {
      const comparison =
        typeof a[sort.key] === 'number'
          ? a[sort.key] - b[sort.key]
          : String(a[sort.key]).localeCompare(String(b[sort.key]), 'zh-CN')
      return sort.desc ? -comparison : comparison
    })
  }, [sourceRows, empty, kind, sorts, selectedProject])
  const selectedId =
    kind === 'sources' ? selectedSource : kind === 'models' ? selectedModel : selectedProject
  const name = (row) => (
    <span
      className={`probe-cell-title${row.id === selectedId ? ' is-selected' : ''}`}
      title={row.label}
    >
      {row.id === selectedId ? '● ' : ''}
      {row.label}
    </span>
  )
  return (
    <div className="mica-config-ui is-embed probe-table-host" data-table={kind}>
      <DataTable
        key={kind}
        ariaLabel={`${REPORT_OPTIONS.find((option) => option.value === kind)?.label} · 示例数据`}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={sorts[kind]}
        onSortChange={(key) => onSortChange(kind, key)}
        pageSize={kind === 'sessions' ? 6 : 0}
        renderCells={(row) =>
          kind === 'sessions'
            ? [
                name(row),
                <span className="probe-cell-title" title={row.project}>
                  {row.project}
                </span>,
                <span className="probe-cell-title" title={row.model}>
                  {row.model}
                </span>,
                count(row.requests),
                tokens(row.tokens)
              ]
            : [
                name(row),
                row.type || row.provider || row.sessions,
                count(row.requests),
                <strong className="probe-table-number">{tokens(row.tokens)}</strong>,
                percentage(row.tokens, TOTALS.tokens)
              ]
        }
      />
    </div>
  )
}

function DetailReport({ report, onReportChange, speedMetric, onSpeedMetricChange, ...tableProps }) {
  return (
    <Panel
      title="精确明细"
      extra={
        tableProps.selectedProject && report === 'sessions'
          ? `项目：${tableProps.selectedProject}`
          : '与图表共用同一组示例数据'
      }
      className="probe-detail-card"
    >
      <div className="probe-detail-tabs">
        <Segmented
          ariaLabel="用量明细视图"
          value={report}
          options={REPORT_OPTIONS}
          onChange={onReportChange}
        />
      </div>
      <div className="probe-detail-view" data-report-view={report}>
        {report === 'speed' ? (
          <div className="probe-speed">
            <div className="probe-report-controls">
              <Segmented
                ariaLabel="模型速度指标"
                value={speedMetric}
                options={[
                  { value: 'responseWait', label: '响应等待' },
                  { value: 'generation', label: '生成速率' }
                ]}
                onChange={onSpeedMetricChange}
              />
              <span className="probe-meta">
                {speedMetric === 'responseWait' ? '越低越快' : '越高越快'}
              </span>
            </div>
            {tableProps.empty ? (
              <Empty description="暂无有效速度样本" />
            ) : (
              <SpeedBars
                rows={SPEED[speedMetric]}
                metric={speedMetric}
                formatValue={(value) =>
                  `${value.toFixed(speedMetric === 'responseWait' ? 2 : 1)} ${speedMetric === 'responseWait' ? 's' : 'tok/s'}`
                }
                unit={
                  speedMetric === 'responseWait' ? '平均响应等待 · 秒' : '生成速率 · Tokens / 秒'
                }
              />
            )}
            <p className="probe-note">客户端估算，仅比较有效样本；供应商与模型分别保留。</p>
          </div>
        ) : (
          <UsageTable {...tableProps} kind={report} />
        )}
      </div>
    </Panel>
  )
}

function App() {
  const initial = useMemo(() => {
    const query = new URLSearchParams(window.location.search)
    return {
      variant: Object.hasOwn(DESIGNS, query.get('variant')) ? query.get('variant') : 'a',
      theme: normalizeThemePreference(query.get('theme')),
      empty: query.get('data') === 'empty'
    }
  }, [])
  const [variant, setVariant] = useState(initial.variant)
  const [theme, setTheme] = useState(initial.theme)
  const [themeKey, setThemeKey] = useState(currentThemeName)
  const [empty, setEmpty] = useState(initial.empty)
  const [metric, setMetric] = useState('tokens')
  const [selectedDay, setSelectedDay] = useState(null)
  const [selectedToken, setSelectedToken] = useState(null)
  const [selectedSource, setSelectedSource] = useState(null)
  const [selectedModel, setSelectedModel] = useState(null)
  const [selectedProject, setSelectedProject] = useState(null)
  const [report, setReport] = useState('sessions')
  const [speedMetric, setSpeedMetric] = useState('responseWait')
  const [sorts, setSorts] = useState(
    Object.fromEntries(
      ['sessions', 'sources', 'models', 'projects'].map((key) => [
        key,
        { key: 'tokens', desc: true }
      ])
    )
  )
  useEffect(() => subscribeTheme(setThemeKey), [])
  useEffect(() => {
    setThemeKey(applyThemePreference(theme, { cache: false }))
  }, [theme])
  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', variant)
    url.searchParams.set('theme', theme)
    if (empty) url.searchParams.set('data', 'empty')
    else url.searchParams.delete('data')
    try {
      window.history.replaceState(null, '', url)
    } catch {
      /* file hosts may reject history changes. */
    }
    document.title = `Stats · ${variant.toUpperCase()} ${DESIGNS[variant].label} · 图表新版`
  }, [variant, theme, empty])
  const onSortChange = (kind, key) =>
    setSorts((previous) => ({
      ...previous,
      [kind]: { key, desc: previous[kind].key === key ? !previous[kind].desc : true }
    }))
  const selectSource = (id) => {
    setSelectedSource(id)
    if (id) setReport('sources')
  }
  const selectModel = (id) => {
    setSelectedModel(id)
    if (id) setReport('models')
  }
  const selectProject = (id) => {
    setSelectedProject(id)
    if (id) setReport('sessions')
  }
  const changeVariant = (next) => {
    setVariant(next)
    setSelectedProject(null)
    setSelectedSource(null)
    setSelectedModel(null)
    setReport(next === 'b' ? 'sources' : 'sessions')
  }
  const shared = {
    metric,
    onMetricChange: setMetric,
    themeKey,
    empty,
    selectedDay,
    onSelectDay: setSelectedDay
  }
  return (
    <div className="probe-comparison">
      <header className="probe-toolbar" data-comparison-toolbar>
        <div className="probe-toolbar-controls">
          <strong>Stats · 图表新版</strong>
          <Segmented
            ariaLabel="Stats 设计方案"
            value={variant}
            options={DESIGN_OPTIONS}
            onChange={changeVariant}
          />
          <div className="probe-theme-control">
            <span className="probe-meta">主题</span>
            <SelectMenu
              value={theme}
              options={THEME_OPTIONS}
              ariaLabel="预览主题"
              onChange={setTheme}
              menuMinWidth={210}
            />
          </div>
          <Button
            variant="ghost"
            size="compact"
            pressed={empty}
            onClick={() => {
              setEmpty((value) => !value)
              setSelectedProject(null)
              setSelectedSource(null)
              setSelectedModel(null)
              setSelectedToken(null)
              setSelectedDay(null)
            }}
          >
            {empty ? '查看示例数据' : '查看无数据状态'}
          </Button>
        </div>
        <p className="probe-design-description">{DESIGNS[variant].description}</p>
      </header>
      <div className="probe-app-shell" data-design={variant}>
        <div className="probe-app-titlebar">
          <strong>Mica</strong>
          <span className="probe-titlebar-divider">/</span>
          <span>Stats</span>
          <span className="probe-sample-label">交互方案 · 非真实数据</span>
        </div>
        <main className="probe-page">
          <header className="probe-page-header">
            <div>
              <h1>用量统计</h1>
              <p>用了多少、用在哪里、最近如何变化。</p>
            </div>
            <div className="probe-period">
              <span>近 30 天</span>
              <span className="probe-meta">{PERIOD.label} · 固定样例</span>
            </div>
          </header>
          <MetricStrip empty={empty} />
          <div data-dashboard={variant}>
            {variant === 'a' && (
              <Overview
                {...shared}
                selectedToken={selectedToken}
                onTokenChange={setSelectedToken}
                selectedModel={selectedModel}
                onModelChange={selectModel}
              />
            )}
            {variant === 'b' && (
              <SourceAnalysis
                {...shared}
                selectedSource={selectedSource}
                onSourceChange={selectSource}
              />
            )}
            {variant === 'c' && (
              <ProjectMap
                {...shared}
                selectedProject={selectedProject}
                onProjectChange={selectProject}
              />
            )}
          </div>
          <DetailReport
            report={report}
            onReportChange={setReport}
            empty={empty}
            sorts={sorts}
            onSortChange={onSortChange}
            selectedSource={selectedSource}
            selectedModel={selectedModel}
            selectedProject={selectedProject}
            speedMetric={speedMetric}
            onSpeedMetricChange={setSpeedMetric}
          />
          <footer className="probe-page-footer">
            交互仅作用于本页示例 · 不读写真实会话 · 不推算费用或虚构增长率 · 方案 A 已接入正式 Stats
          </footer>
        </main>
      </div>
    </div>
  )
}

applyThemePreference(
  normalizeThemePreference(new URLSearchParams(window.location.search).get('theme')),
  { cache: false }
)
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <ArcoProvider>
      <App />
    </ArcoProvider>
  </ErrorBoundary>
)
