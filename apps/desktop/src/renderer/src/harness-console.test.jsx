import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
import { readFileSync } from 'node:fs'
import HarnessConsolePage, {
  EmptyRows,
  Overview,
  FindingDetail,
  Coverage,
  Plugins
} from '../../../../../plugins/harness-review/desktop.jsx'

const emptySnapshot = {
  totals: {
    mainRuns: 0,
    delegatedRuns: 0,
    helperRuns: 0,
    running: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    aborted: 0,
    paused: 0,
    requests: 0,
    tools: 0,
    toolErrors: 0
  },
  progress: {
    recentRecurring: 0,
    recentSingle: 0,
    historicalPending: 0,
    timeUnknown: 0,
    acceptedPending: 0,
    validatedWatching: 0,
    dismissed: 0,
    needsReview: 0
  },
  counts: { runs: 0, findings: 0, toolHealth: 0, pluginFailures: 0, plugins: 0, warnings: 0 },
  findings: [],
  runs: [],
  toolHealth: [],
  plugins: [],
  warnings: [],
  coverage: {},
  toolHealthCoverage: {},
  derivationCoverage: {},
  assembly: {},
  logEvidence: null
}

describe('Harness console page', () => {
  it('has a real Arco page frame and an explicit empty state in SSR', () => {
    const html = renderToStaticMarkup(<HarnessConsolePage api={{}} />)
    expect(html).toContain('Harness 运行控制台')
    expect(html).toContain('harness-console-skeleton')
    expect(html).toContain('自动刷新（聚焦时）')
    expect(html).toContain('arco-switch')
  })

  it('renders overview KPI cards with Arco Statistic and no native select controls', () => {
    const html = renderToStaticMarkup(
      <Overview
        snapshot={{
          ...emptySnapshot,
          totals: { ...emptySnapshot.totals, mainRuns: 3, requests: 8, toolErrors: 1 },
          counts: { ...emptySnapshot.counts, toolHealth: 1 },
          toolHealth: [{ name: 'run_shell', calls: 4, errors: 1, errorRate: 0.25, categories: [] }]
        }}
      />
    )
    expect(html).toContain('arco-card')
    expect(html).toContain('arco-statistic')
    expect(html).toContain('主运行')
    expect(html).not.toContain('<select')
  })

  it('uses the shared Arco empty state for zero samples', () => {
    const html = renderToStaticMarkup(<EmptyRows />)
    expect(html).toContain('arco-empty')
    expect(html).toContain('未观察到样本')
  })

  it('renders a finding detail with the real Arco Descriptions data API', () => {
    const html = renderToStaticMarkup(
      <FindingDetail
        finding={{
          id: 'candidate',
          title: '候选示例',
          status: 'accepted',
          module: 'tool',
          suggestion: '检查记录',
          evaluation: '独立样本验证',
          evidenceCount: 1,
          evidence: [{ runId: 'run-1', seq: 2, available: true }]
        }}
        onClose={() => {}}
      />
    )
    expect(html).toContain('arco-descriptions')
    expect(html).toContain('候选示例')
    expect(html).toContain('独立样本验证')
  })

  it('does not claim unfinished records are live or label interrupted records as confirmed errors', () => {
    const html = renderToStaticMarkup(<Overview snapshot={emptySnapshot} />)
    expect(html).toContain('未收尾')
    expect(html).toContain('中断未知')
    expect(html).toContain('已接受待验证')
    expect(html).not.toContain('运行中')
    expect(html).not.toContain('显示 8 / 总数 0')
  })

  it('keeps missing log coverage unknown and renders sanitized health messages', () => {
    const coverage = renderToStaticMarkup(<Coverage snapshot={emptySnapshot} />)
    expect(coverage).toContain('日志行数截断：未知')
    const html = renderToStaticMarkup(
      <Plugins
        snapshot={{
          ...emptySnapshot,
          plugins: [
            {
              id: 'sample',
              name: 'Sample',
              enabled: false,
              loading: 'loaded',
              health: { level: 'warn', message: '连接等待恢复', at: '2026-11-01T00:00:00Z' }
            }
          ]
        }}
      />
    )
    expect(html).toContain('连接等待恢复')
    expect(html).toContain('已停用')
  })

  it('loads every new Arco component stylesheet before layout rules', () => {
    const css = readFileSync(
      new URL('../../../../../plugins/harness-review/console.css', import.meta.url),
      'utf8'
    )
    for (const name of ['Card', 'Statistic', 'Tabs', 'Descriptions', 'Skeleton']) {
      expect(css.indexOf(`/es/${name}/style/index.css`)).toBeGreaterThanOrEqual(0)
      expect(css.indexOf(`/es/${name}/style/index.css`)).toBeLessThan(
        css.indexOf('.harness-console-shell')
      )
    }
    expect(css).not.toMatch(/border-left|inset\s+[^;]*0 0/)
  })
})
