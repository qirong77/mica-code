import { Suspense } from 'react'
import { lazyView } from '../lazy-view'

let chartsPromise

// Share the import between the visible-entry preload and all three chart slots.
export function preloadUsageCharts() {
  return (chartsPromise ??= import('./usage-charts').catch((error) => {
    // Let lazyView's local retry request the module again after a failed preload.
    chartsPromise = undefined
    throw error
  }))
}

const LazyDonutChart = lazyView(preloadUsageCharts, 'DonutChart')
const LazyTrendChart = lazyView(preloadUsageCharts, 'TrendChart')
const LazyProjectChart = lazyView(preloadUsageCharts, 'ProjectChart')

function ChartSlot({ kind, height, label, children }) {
  // Keep the same footprint during loading and on the local error UI.
  return (
    <div style={{ minHeight: height }}>
      <Suspense
        fallback={
          <div className={`stats-chart stats-chart-${kind}`}>
            <span className="sr-only" role="status">
              {label}
            </span>
          </div>
        }
      >
        {children}
      </Suspense>
    </div>
  )
}

export function DonutChart(props) {
  return (
    <ChartSlot kind="donut" height={216} label="正在加载 Token 构成图…">
      <LazyDonutChart {...props} />
    </ChartSlot>
  )
}

export function TrendChart(props) {
  return (
    <ChartSlot
      kind="trend"
      height={260}
      label={`Daily ${props.metric === 'requests' ? 'requests' : 'tokens'} chart loading…`}
    >
      <LazyTrendChart {...props} />
    </ChartSlot>
  )
}

export function ProjectChart({ rows, ...props }) {
  const height = Math.max(112, rows.length * 34 + 24)
  return (
    <ChartSlot kind="projects" height={height} label="正在加载项目用量图…">
      <LazyProjectChart rows={rows} {...props} />
    </ChartSlot>
  )
}
