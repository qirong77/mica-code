import { useEffect, useRef, useState } from 'react'
import { CAL_WEEKDAYS, axisTicks, niceAxisMax } from './geometry'

/** 活跃图在窄窗口下保持可读性的最小单元格尺寸 */
const CAL_MIN_CELL = 10
const CAL_MIN_GAP = 2
const CAL_MAX_GAP = 5
const CAL_GUTTER_W = 26
const CAL_GAP_X = 8
const CAL_MONTH_ROW_H = 18

/**
 * GitHub 风格贡献日历活跃图：每天一格，按周分列，颜色强度按数值分位。
 * 悬停显示 tooltip，点击某天回调 onSelectDay。网格超宽时横向滚动，打开时定位到最新。
 */
export function CalendarHeatmap({
  weeks,
  levelOf,
  colors,
  selectedDay,
  onSelectDay,
  renderTooltip,
  ariaLabelOf,
  monthLabels
}) {
  const scrollRef = useRef(null)
  const viewportRef = useRef(null)
  const [hovered, setHovered] = useState(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const columnCount = Math.max(weeks.length, 1)
  const fittedStep = viewportWidth / columnCount
  const gap = Math.min(CAL_MAX_GAP, Math.max(CAL_MIN_GAP, fittedStep * 0.2))
  const fittedCell = (viewportWidth - gap * (columnCount - 1)) / columnCount
  const cellSize = Math.max(CAL_MIN_CELL, fittedCell)
  const step = cellSize + gap
  const width = columnCount * cellSize + (columnCount - 1) * gap
  const height = 7 * cellSize + 6 * gap

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined
    const update = () => setViewportWidth(el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const firstDay = weeks[0]?.[0]?.day
  const lastDay = weeks[weeks.length - 1]?.[6]?.day
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [firstDay, lastDay])

  const showAt = (day, ci, ri) =>
    setHovered({
      day,
      x: CAL_GUTTER_W + CAL_GAP_X + ci * step + cellSize / 2 - (scrollRef.current?.scrollLeft ?? 0),
      y: ri * step
    })
  const hideIf = (day) => setHovered((h) => (h?.day === day ? null : h))

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div
          className="relative shrink-0"
          style={{ width: CAL_GUTTER_W, height, marginTop: CAL_MONTH_ROW_H }}
        >
          {CAL_WEEKDAYS.map(({ row, label }) => (
            <span
              key={label}
              className="absolute right-0 text-[11px] text-[#8a8a8a]"
              style={{ top: row * step + cellSize / 2 - 7 }}
            >
              {label}
            </span>
          ))}
        </div>
        <div ref={viewportRef} className="min-w-0 flex-1">
          <div ref={scrollRef} className="overflow-x-auto">
            <div className="relative mb-1 h-3.5" style={{ width }}>
              {monthLabels.map((m) => (
                <span
                  key={`${m.col}-${m.label}`}
                  className="absolute text-[11px] text-[#8a8a8a]"
                  style={{ left: m.col * step }}
                >
                  {m.label}
                </span>
              ))}
            </div>
            <svg width={width} height={height} className="block">
              {weeks.map((col, ci) =>
                col.map((dayCell, ri) =>
                  dayCell.inRange ? (
                    <rect
                      key={dayCell.day}
                      x={ci * step}
                      y={ri * step}
                      width={cellSize}
                      height={cellSize}
                      rx={Math.min(2, cellSize * 0.15)}
                      fill={colors[levelOf(dayCell.day)] ?? colors[0]}
                      stroke={dayCell.day === selectedDay ? 'rgba(255,255,255,.75)' : 'none'}
                      strokeWidth={dayCell.day === selectedDay ? 1.5 : 0}
                      tabIndex={0}
                      role="button"
                      aria-label={ariaLabelOf(dayCell.day)}
                      className="cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/60"
                      onMouseEnter={() => showAt(dayCell.day, ci, ri)}
                      onMouseLeave={() => hideIf(dayCell.day)}
                      onFocus={() => showAt(dayCell.day, ci, ri)}
                      onBlur={() => hideIf(dayCell.day)}
                      onClick={() => onSelectDay(dayCell.day)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSelectDay(dayCell.day)
                        }
                      }}
                    />
                  ) : null
                )
              )}
            </svg>
          </div>
        </div>
      </div>
      {hovered && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-white/15 bg-[#1e1e1e] px-2 py-1.5 text-xs shadow-xl"
          style={{ left: hovered.x, top: CAL_MONTH_ROW_H + hovered.y - 4 }}
        >
          {renderTooltip(hovered.day)}
        </div>
      )}
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[#8a8a8a]">
        <span>Less</span>
        {colors.map((c, i) => (
          <span
            key={i}
            className="inline-block h-2.5 w-2.5 rounded-[2px]"
            style={{ background: c }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  )
}

const PLOT_VH = 100

/**
 * 每日柱状图：每天一根柱，Y 轴取“漂亮”上限 + 等距刻度，悬停显示 tooltip。
 * 柱高按窗口内最大值的绝对比例，空天显示为 0。
 */
export function BarSeries({ columns, formatTick, xLabels, renderTooltip }) {
  const [hovered, setHovered] = useState(null)
  const n = columns.length
  const dataMax = Math.max(0, ...columns.map((c) => Math.max(0, c.value)))
  const axisMax = niceAxisMax(dataMax)
  const ticks = axisTicks(axisMax)

  return (
    <div className="flex gap-2 pt-2">
      <div className="relative h-40 w-11 shrink-0">
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute right-0 translate-y-[calc(-50%_+_5px)] text-[11px] leading-none tabular-nums text-[#8a8a8a]"
            style={{ bottom: `${(t / axisMax) * 100}%` }}
          >
            {formatTick(t)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-40">
          {ticks.map((t) => (
            <span
              key={t}
              className="pointer-events-none absolute inset-x-0 border-t border-[#1e1e1e]"
              style={{ bottom: `${(t / axisMax) * 100}%` }}
            />
          ))}
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${Math.max(n, 1)} ${PLOT_VH}`}
            preserveAspectRatio="none"
            onMouseLeave={() => setHovered(null)}
          >
            {columns.map((col, i) => (
              <rect
                key={`hit-${col.key}`}
                x={i}
                width={1}
                y={0}
                height={PLOT_VH}
                fill="transparent"
                onMouseEnter={() => setHovered(i)}
              />
            ))}
            {columns.map((col, i) => {
              const h = col.value > 0 ? (col.value / axisMax) * PLOT_VH : 0
              return h > 0 ? (
                <rect
                  key={col.key}
                  x={i + 0.1}
                  width={0.8}
                  y={PLOT_VH - h}
                  height={h}
                  fill="#c8c8c8"
                  className="pointer-events-none"
                />
              ) : null
            })}
          </svg>
          {hovered != null && (
            <div
              className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/15 bg-[#1e1e1e] px-2 py-1.5 text-xs shadow-xl"
              style={{ left: `${((hovered + 0.5) / Math.max(n, 1)) * 100}%` }}
            >
              {renderTooltip(hovered)}
            </div>
          )}
        </div>
        <div className="relative mt-1 h-3">
          {xLabels.map(({ index, label }) => (
            <span
              key={index}
              className="absolute -translate-x-1/2 whitespace-nowrap text-[11px] tabular-nums text-[#8a8a8a]"
              style={{ left: `${((index + 0.5) / Math.max(n, 1)) * 100}%` }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
