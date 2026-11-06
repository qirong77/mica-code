import { useEffect, useMemo, useRef } from 'react'
import { init, use } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'

use([LineChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer])

/** Fill calendar gaps with null so ECharts never connects across missing days. */
function calendarDays(series) {
  const days = series.flatMap((item) => item.points.map((point) => point.day)).sort()
  if (!days.length) return []
  const result = []
  const end = Date.parse(`${days[days.length - 1]}T00:00:00Z`)
  for (let time = Date.parse(`${days[0]}T00:00:00Z`); time <= end; time += 86400000) {
    result.push(new Date(time).toISOString().slice(0, 10))
  }
  return result
}

export function shouldUseLogScale(series) {
  const values = series
    .flatMap((item) => item.points.map((point) => point.value))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (values.length < 2) return false
  return Math.max(...values) / Math.min(...values) >= 20
}

export function SpeedTrend({
  series,
  formatValue,
  formatTick = formatValue,
  unit,
  intraday = false,
  logScale = false
}) {
  const elementRef = useRef(null)
  const chartRef = useRef(null)
  const activeIndex = useRef(-1)
  const clean = useMemo(
    () =>
      series.map((item) => ({
        ...item,
        points: item.points.filter(
          (point) =>
            Number.isFinite(point.value) &&
            (intraday
              ? Number.isFinite(point.at)
              : Number.isFinite(Date.parse(`${point.day}T00:00:00Z`)))
        )
      })),
    [series, intraday]
  )
  const days = useMemo(
    () =>
      intraday
        ? [...new Set(clean.flatMap((item) => item.points.map((point) => point.at)))].sort(
            (a, b) => a - b
          )
        : calendarDays(clean),
    [clean, intraday]
  )
  const sampledDays = new Set(
    clean.flatMap((item) => item.points.map((point) => (intraday ? point.at : point.day)))
  )
  const canPlot = sampledDays.size > 0

  useEffect(() => {
    const element = elementRef.current
    if (!element || !canPlot) return undefined
    const chart = init(element, null, { renderer: 'svg' })
    chartRef.current = chart
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(element)
    return () => {
      resize.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [canPlot])

  useEffect(() => {
    const chart = chartRef.current
    const element = elementRef.current
    if (!chart || !element) return undefined
    const render = () => {
      const style = getComputedStyle(element)
      const color = (variable) => style.getPropertyValue(variable).trim()
      const resolveColor = (value) => (value.startsWith('var(') ? color(value.slice(4, -1)) : value)
      const font = style.fontFamily
      const palette = clean.map((item) => resolveColor(item.color))
      const byDay = clean.map(
        (item) => new Map(item.points.map((point) => [intraday ? point.at : point.day, point]))
      )
      const timeLabel = (at) =>
        new Date(Number(at)).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })
      const tooltip = (params) => {
        const entries = Array.isArray(params) ? params : [params]
        const day = intraday ? Number(entries[0]?.axisValue) : String(entries[0]?.axisValue ?? '')
        if (!day) return ''
        const root = document.createElement('div')
        root.style.cssText = 'max-width:min(300px,70vw);font-size:11px;line-height:1.5'
        const title = document.createElement('div')
        title.textContent = intraday
          ? `${new Date(day).toLocaleDateString('zh-CN')} ${timeLabel(day)}`
          : day
        title.style.cssText = 'margin-bottom:8px;opacity:.7'
        root.append(title)
        clean.forEach((item, index) => {
          const point = byDay[index].get(day)
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px'
          const marker = document.createElement('span')
          marker.style.cssText = `width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${palette[index]}`
          const label = document.createElement('span')
          label.textContent = item.label
          label.style.cssText =
            'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          label.title = item.label
          const value = document.createElement('span')
          value.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0'
          value.append(document.createTextNode(point ? formatValue(point.value) : '—'))
          const samples = document.createElement('div')
          samples.textContent = point ? `${point.samples} 个样本` : '无样本'
          samples.style.cssText = 'font-size:10px;opacity:.65'
          value.append(samples)
          row.append(marker, label, value)
          root.append(row)
        })
        return root
      }
      chart.setOption(
        {
          animation: false,
          textStyle: { fontFamily: font },
          aria: {
            enabled: true,
            label: {
              description: `多模型${intraday ? '当日' : '每日'}速度对比。${unit}。使用左右方向键查看时间，上方图例可显示或隐藏模型。`
            }
          },
          grid: { left: 44, right: 16, top: 12, bottom: 28 },
          tooltip: {
            trigger: 'axis',
            confine: true,
            enterable: true,
            backgroundColor: color('--color-panel'),
            borderColor: color('--color-line'),
            borderWidth: 1,
            padding: [10, 12],
            textStyle: { color: color('--color-fg-strong'), fontFamily: font },
            extraCssText:
              'max-height:220px;overflow:auto;border-radius:6px;box-shadow:0 8px 24px rgb(0 0 0 / 12%)',
            axisPointer: {
              type: 'line',
              lineStyle: { color: color('--color-fg-ghost'), type: 'dashed' }
            },
            formatter: tooltip
          },
          xAxis: {
            type: intraday ? 'time' : 'category',
            data: intraday ? undefined : days,
            boundaryGap: intraday ? ['4%', '4%'] : true,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              color: color('--color-fg-dim'),
              fontSize: 11,
              hideOverlap: true,
              formatter: (day) =>
                intraday ? timeLabel(day) : `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`
            }
          },
          yAxis: {
            type: logScale ? 'log' : 'value',
            ...(logScale ? {} : { min: 0 }),
            splitNumber: logScale ? 4 : 3,
            axisLabel: { color: color('--color-fg-dim'), fontSize: 11, formatter: formatTick },
            splitLine: { lineStyle: { color: color('--color-line') } }
          },
          series: clean.map((item, index) => ({
            id: item.id,
            name: item.label,
            type: 'line',
            data: intraday
              ? item.points.map((point) => [point.at, point.value])
              : days.map((day) => byDay[index].get(day)?.value ?? null),
            connectNulls: false,
            smooth: false,
            symbol: 'circle',
            symbolSize: days.length === 1 ? 9 : 7,
            showSymbol: intraday || days.length <= 31,
            itemStyle: {
              color: palette[index],
              borderColor: color('--color-panel'),
              borderWidth: 1.5
            },
            lineStyle: { color: palette[index], width: 2, type: item.dash ? 'dashed' : 'solid' },
            emphasis: { focus: 'series', scale: 1.6 }
          }))
        },
        { notMerge: true }
      )
      activeIndex.current = -1
    }
    render()
    const theme = new MutationObserver(render)
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-appearance', 'style', 'class']
    })
    return () => theme.disconnect()
  }, [clean, days, formatValue, formatTick, unit, canPlot, intraday])

  const showDay = (index) => {
    const chart = chartRef.current
    if (!chart) return
    activeIndex.current = index
    chart.dispatchAction({
      type: 'showTip',
      x: chart.convertToPixel({ xAxisIndex: 0 }, intraday ? days[index] : index),
      y: 80
    })
  }
  if (!sampledDays.size)
    return <p className="py-10 text-center text-xs text-fg-dim">选择上方图例里的模型以显示趋势。</p>
  return (
    <div className="mt-1 min-w-0">
      <div
        ref={elementRef}
        data-chart="model-speed"
        tabIndex={0}
        className="h-60 w-full min-w-0 rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-fg-soft"
        onFocus={() => showDay(days.length - 1)}
        onBlur={() => chartRef.current?.dispatchAction({ type: 'hideTip' })}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
          event.preventDefault()
          if (event.key === 'Escape') {
            chartRef.current?.dispatchAction({ type: 'hideTip' })
            return
          }
          showDay(
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? days.length - 1
                : Math.max(
                    0,
                    Math.min(
                      days.length - 1,
                      activeIndex.current + (event.key === 'ArrowLeft' ? -1 : 1)
                    )
                  )
          )
        }}
      />
    </div>
  )
}
