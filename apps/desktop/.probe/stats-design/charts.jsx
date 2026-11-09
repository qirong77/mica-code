import { useEffect, useRef } from 'react'
import { init, use } from 'echarts/core'
import { BarChart, LineChart, PieChart, TreemapChart as EChartsTreemap } from 'echarts/charts'
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import {
  describeValues,
  formatAmount,
  makeDonutOption,
  makeProjectOption,
  makeTreemapOption,
  makeTrendOption,
  projectRows,
  sanitizeRows,
  trendRows
} from './chart-model.js'

use([
  PieChart,
  LineChart,
  BarChart,
  EChartsTreemap,
  AriaComponent,
  GridComponent,
  TooltipComponent,
  SVGRenderer
])

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
  const token = (name, depth = 0) => {
    if (depth > 6) return style.color
    const value = style.getPropertyValue(name).trim()
    return value
      ? value.replace(/var\((--color-[\w-]+)\)/g, (_, nested) => token(nested, depth + 1))
      : style.color
  }
  const palette = PALETTE.map((name) => token(name))
  return {
    foreground: token('--color-fg-strong'),
    muted: token('--color-fg-muted'),
    line: token('--color-line'),
    surface: token('--color-panel'),
    empty: token('--color-overlay-strong'),
    trend: token('--color-accent'),
    fontFamily: style.fontFamily,
    palette,
    colorOf: (color, index) => {
      const name = /^(?:var\((--color-[\w-]+)\)|(--color-[\w-]+))$/.exec(String(color || '').trim())
      return name ? token(name[1] || name[2]) : palette[index % palette.length]
    }
  }
}

function ChartSurface({ kind, themeKey, description, makeOption, onChartClick, minHeight = 220 }) {
  const elementRef = useRef(null)
  const updateRef = useRef(null)
  const optionRef = useRef(makeOption)
  const clickRef = useRef(onChartClick)
  optionRef.current = makeOption
  clickRef.current = onChartClick

  useEffect(() => {
    const element = elementRef.current
    const chart = init(element, undefined, { renderer: 'svg' })
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    const update = () =>
      chart.setOption(optionRef.current(readTheme(element), motion.matches), { notMerge: true })
    const click = (event) => clickRef.current?.(event)
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => chart.resize())
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    updateRef.current = update
    chart.on('click', click)
    observer?.observe(element)
    window.addEventListener('resize', resize)
    motion.addEventListener('change', update)
    return () => {
      updateRef.current = null
      observer?.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      motion.removeEventListener('change', update)
      chart.off('click', click)
      chart.dispose()
    }
  }, [])

  useEffect(() => {
    updateRef.current?.()
  }, [makeOption, themeKey])

  return (
    <figure
      className={`probe-chart probe-chart-${kind}`}
      style={{ position: 'relative', margin: 0, width: '100%', minWidth: 0 }}
    >
      <div
        ref={elementRef}
        role="img"
        aria-label={description}
        style={{ width: '100%', height: '100%', minHeight }}
      />
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
  themeKey,
  empty = false
}) {
  const data = empty ? [] : sanitizeRows(rows)
  return (
    <ChartSurface
      kind="donut"
      themeKey={themeKey}
      minHeight={180}
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
        if (event.componentType === 'series' && event.data?.id != null) onSelect?.(event.data.id)
      }}
    />
  )
}

export function TrendChart({ rows, metric = 'tokens', formatValue, themeKey, onSelectDay }) {
  const key = metric === 'requests' ? 'requests' : 'tokens'
  const data = trendRows(rows)
  const total = data.reduce((sum, row) => sum + row[key], 0)
  const description = data.length
    ? `Daily ${key}, ${data[0].day} to ${data.at(-1).day}; ${formatAmount(total, formatValue)} total across ${data.length} days. Missing dates have zero usage.`
    : `No daily ${key} data.`
  return (
    <ChartSurface
      kind="trend"
      themeKey={themeKey}
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

export function ProjectChart({ rows, parts, formatValue, themeKey }) {
  const data = projectRows(rows, parts)
  return (
    <ChartSurface
      kind="projects"
      themeKey={themeKey}
      minHeight={Math.max(180, data.length * 42 + 36)}
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
    />
  )
}

export function TreemapChart({ rows, formatValue, themeKey, onSelect, valueLabel = 'Tokens' }) {
  const data = sanitizeRows(rows)
  return (
    <ChartSurface
      kind="treemap"
      themeKey={themeKey}
      description={describeValues(data, valueLabel, formatValue, true)}
      makeOption={(theme, reducedMotion) =>
        makeTreemapOption(coloredRows(data, theme), {
          formatValue,
          valueLabel,
          theme,
          reducedMotion
        })
      }
      onChartClick={(event) => {
        if (event.componentType === 'series' && event.data?.id != null) onSelect?.(event.data.id)
      }}
    />
  )
}
