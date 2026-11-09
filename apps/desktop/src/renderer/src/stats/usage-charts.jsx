import { useEffect, useRef } from 'react'
import { init, use } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { subscribeTheme } from '../theme.js'
import {
  chartRowId,
  describeValues,
  formatAmount,
  makeDonutOption,
  makeProjectOption,
  makeTrendOption,
  projectRows,
  sanitizeRows,
  trendRows
} from './chart-model.js'

use([PieChart, LineChart, BarChart, AriaComponent, GridComponent, TooltipComponent, SVGRenderer])

const PALETTE = [
  '--color-fg-strong',
  '--color-teal',
  '--color-accent',
  '--color-purple',
  '--color-success',
  '--color-fg-muted'
]
const hiddenSummary = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0
}

function readTheme(element) {
  const style = getComputedStyle(element)
  const resolver = document.createElement('span')
  resolver.style.display = 'none'
  element.appendChild(resolver)
  const token = (name) => {
    // Let CSS resolve aliases and color syntax before handing values to ECharts.
    resolver.style.color = `var(${name}, var(--color-fg-strong))`
    return getComputedStyle(resolver).color
  }
  try {
    const palette = PALETTE.map(token)
    const theme = {
      foreground: token('--color-fg-strong'),
      muted: token('--color-fg-muted'),
      line: token('--color-line'),
      surface: token('--color-panel'),
      empty: token('--color-overlay-strong'),
      trend: token('--color-accent'),
      fontFamily: style.fontFamily,
      palette
    }
    const colors = new Map()
    return {
      ...theme,
      colorOf: (color, index) => {
        const match = /^(?:var\((--color-[\w-]+)\)|(--color-[\w-]+))$/.exec(
          String(color || '').trim()
        )
        if (!match) return palette[index % palette.length]
        const name = match[1] || match[2]
        if (!colors.has(name)) {
          element.appendChild(resolver)
          try {
            colors.set(name, token(name))
          } finally {
            resolver.remove()
          }
        }
        return colors.get(name)
      }
    }
  } finally {
    resolver.remove()
  }
}

function ChartSurface({ kind, description, makeOption, onChartClick, height = 260 }) {
  const elementRef = useRef(null)
  const updateRef = useRef(null)
  const optionRef = useRef(makeOption)
  const clickRef = useRef(onChartClick)
  optionRef.current = makeOption
  clickRef.current = onChartClick

  useEffect(() => {
    const element = elementRef.current
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let chart = null
    let frame = 0
    let dirty = true
    let disposed = false
    let width = 0
    let height = 0
    const click = (event) => clickRef.current?.(event)
    const render = () => {
      frame = 0
      if (disposed || document.visibilityState === 'hidden') return
      const nextWidth = element.clientWidth
      const nextHeight = element.clientHeight
      if (!nextWidth || !nextHeight) return
      if (!chart) {
        chart = init(element, undefined, { renderer: 'svg' })
        chart.on('click', click)
        dirty = true
      }
      if (width !== nextWidth || height !== nextHeight) {
        width = nextWidth
        height = nextHeight
        chart.resize({ width, height, animation: { duration: 0 } })
      }
      if (dirty) {
        chart.setOption(optionRef.current(readTheme(element), !!motion?.matches), {
          notMerge: true
        })
        dirty = false
      }
    }
    const resize = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(render)
    }
    const update = () => {
      dirty = true
      resize()
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    const unsubscribeTheme = subscribeTheme(update)
    updateRef.current = update
    observer?.observe(element)
    window.addEventListener('resize', resize)
    window.addEventListener('pageshow', resize)
    document.addEventListener('visibilitychange', resize)
    motion?.addEventListener('change', update)
    resize()
    return () => {
      disposed = true
      updateRef.current = null
      unsubscribeTheme()
      observer?.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pageshow', resize)
      document.removeEventListener('visibilitychange', resize)
      motion?.removeEventListener('change', update)
      chart?.off('click', click)
      chart?.dispose()
    }
  }, [])

  useEffect(() => {
    updateRef.current?.()
  }, [makeOption])

  return (
    <figure
      className={`stats-chart stats-chart-${kind}`}
      style={{ position: 'relative', margin: 0, width: '100%', minWidth: 0 }}
    >
      <div ref={elementRef} role="img" aria-label={description} style={{ width: '100%', height }} />
      <figcaption style={hiddenSummary}>{description}</figcaption>
    </figure>
  )
}

function coloredRows(rows, theme) {
  return rows.map((row, index) => ({ ...row, color: theme.colorOf(row.color, index) }))
}

export function DonutChart({
  rows,
  valueLabel = 'Tokens',
  formatValue,
  selectedKey,
  onSelect,
  empty = false
}) {
  const data = empty ? [] : sanitizeRows(rows)
  return (
    <ChartSurface
      kind="donut"
      height={216}
      description={describeValues(data, valueLabel, formatValue, true)}
      makeOption={(theme, reducedMotion) =>
        makeDonutOption(coloredRows(data, theme), {
          valueLabel,
          formatValue,
          selectedKey,
          empty,
          theme,
          reducedMotion
        })
      }
      onChartClick={(event) => {
        const id = chartRowId(event)
        if (id != null) onSelect?.(id)
      }}
    />
  )
}

export function TrendChart({ rows, metric = 'tokens', formatValue, onSelectDay }) {
  const key = metric === 'requests' ? 'requests' : 'tokens'
  const data = trendRows(rows)
  const total = data.reduce((sum, row) => sum + row[key], 0)
  const description = data.length
    ? `Daily ${key}, ${data[0].day} to ${data.at(-1).day}; ${formatAmount(total, formatValue)} total across ${data.length} days. Missing dates have zero usage.`
    : `No daily ${key} data.`
  return (
    <ChartSurface
      kind="trend"
      description={description}
      makeOption={(theme, reducedMotion) =>
        makeTrendOption(data, { metric: key, formatValue, theme, reducedMotion })
      }
      onChartClick={(event) => {
        const day = event.componentType === 'xAxis' ? event.value : event.data?.day
        if (day) onSelectDay?.(day)
      }}
    />
  )
}

export function ProjectChart({ rows, parts = [], formatValue, onSelect }) {
  const data = projectRows(rows, parts)
  return (
    <ChartSurface
      kind="projects"
      // 高度跟着条数走：项目少时固定高度会把三条数据摊在一大片空白里，
      // 条数多时又挤不下，所以给一个能让「条与条之间」看起来一致的每行步长。
      height={Math.max(112, data.length * 34 + 24)}
      description={describeValues(
        data.map((row) => ({ label: row.label, value: row.total })),
        'Tokens',
        formatValue
      )}
      makeOption={(theme, reducedMotion) =>
        makeProjectOption(
          data,
          parts.map((part, index) => ({ ...part, color: theme.colorOf(part.color, index) })),
          { formatValue, theme, reducedMotion }
        )
      }
      onChartClick={(event) => {
        const id = chartRowId(event)
        if (id != null) onSelect?.(id)
      }}
    />
  )
}
