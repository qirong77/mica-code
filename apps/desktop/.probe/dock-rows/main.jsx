// 探针「停靠区行高」：一句话——输入区上方那串停靠区（回合日志 + todo / subagent /
// 后台任务的续行）是终端式的一行一行，每一行必须一样高。
//
// 三件事必须与产品一致，否则这个页面只是示意图：
// 1. 样式用 `app.css` 的真实类名，不在这里抄一份；
// 2. 思考行与工具行直接用正式组件（`ReasoningRow` / `ToolActivityRow`），
//    行首那几个 Arco 按钮也用正式 `ArcoAction`（`.arco-btn` 的基础样式会参与行高）；
// 3. todo / subagent / 后台那几块的行是 `ChatView.jsx` 里的手写结构，这里照抄类名与
//    层级（只省掉 `Collapse`：展开态的内容在 DOM 上和它一样是 `.chat-task-children`）。
//
// 页面右上角打出每种行的实测高度；`#probe-out` 里是同一份数据的 JSON。
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { ArcoAction, ArcoProvider } from '@mica-config-ui/web'
import { ReasoningRow, ToolActivityRow } from '../../src/renderer/src/chat-tool-views.jsx'
import '../../src/renderer/assets/app.css'
import './probe.css'

const NOW = Date.now()

const THINKING_ONE_LINE = '先读一遍 CodexGo 的 skill，确认它到底要不要联网。'
const THINKING_MULTI = [
  '先读一遍 CodexGo 的 skill，确认它到底要不要联网；然后看本机有没有现成的命令行可以直接跑。',
  '',
  '如果本地没有，再考虑让用户自己装——不要自己往系统里塞东西。'
].join('\n')

const TOOLS = [
  {
    tool: 'read_file',
    status: 'completed',
    input: { file_path: '/Users/qironglin/Desktop/mica-code/plugins/schedule/SKILL.md' },
    startedAt: NOW - 1400,
    finishedAt: NOW - 300
  },
  {
    tool: 'grep_search',
    status: 'completed',
    input: { pattern: 'todo_write', path: 'apps/desktop/src' },
    startedAt: NOW - 900,
    finishedAt: NOW - 120
  },
  {
    tool: 'run_shell',
    status: 'running',
    input: { command: 'bun run test apps/desktop/.probe' },
    startedAt: NOW - 6000
  }
]

const TODO_ITEMS = [
  { status: 'completed', label: '读 CodexGo 的 skill' },
  { status: 'completed', label: '确认本机有没有对应命令行' },
  { status: 'in_progress', label: '把停靠区的行高对齐到同一个数' },
  { status: 'pending', label: '跑一遍针对性测试' }
]

function TurnLogHead() {
  return (
    <header className="chat-turn-log-head" title="拖动调整日志高度，双击复位">
      <ArcoAction
        iconOnly
        type="button"
        className="chat-turn-log-toggle"
        aria-expanded="true"
        aria-label="收起回合日志"
      >
        <IconChevronDown size={12} />
      </ArcoAction>
      <span className="chat-turn-log-head-label">本轮</span>
    </header>
  )
}

function TodoDockFixture() {
  return (
    <section className="chat-task-dock chat-todo-dock" aria-label="当前运行计划">
      <ArcoAction
        type="button"
        className="chat-task-summary-row chat-todo-toggle mica-arco-row"
        aria-expanded="true"
      >
        <span className="chat-task-kind">
          <IconChevronRight
            size={12}
            className="transition-transform rotate-90"
            aria-hidden="true"
          />
          <span>📝(todo)</span>
        </span>
        <span className="chat-task-status chat-task-status-pending">pending</span>
        <span className="chat-task-runtime">2/4</span>
        <span className="chat-task-description">2 remaining</span>
      </ArcoAction>
      <div className="chat-task-children">
        {TODO_ITEMS.map((item) => (
          <div key={item.label} className={`chat-task-child chat-todo-${item.status}`}>
            <span className="chat-task-child-prefix"> ⎿ </span>
            <span className="chat-task-child-marker" aria-hidden="true">
              {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span className="chat-task-description">{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SubagentDockFixture() {
  return (
    <section className="chat-task-dock chat-subagent-dock" aria-label="Subagent 任务">
      <button
        type="button"
        className="chat-task-summary-row chat-task-openable"
        title="查看 subagent 详情"
      >
        <span className="chat-task-kind">🤖(subagent)</span>
        <span className="chat-task-status chat-task-status-running">running</span>
        <span className="chat-task-runtime">1m 12s</span>
        <span className="chat-task-type">Explore</span>
        <span className="chat-task-description">找出所有还在自己写行高的停靠区</span>
      </button>
      <div className="chat-task-child">
        <span className="chat-task-child-prefix"> ⎿ </span>
        <span className="chat-task-description">read apps/desktop/src/renderer/assets/app.css</span>
      </div>
    </section>
  )
}

function BackgroundDockFixture() {
  return (
    <section className="chat-task-dock chat-background-dock" aria-label="运行中的后台任务">
      <div className="chat-task-row">
        <button type="button" className="chat-task-summary-row chat-task-openable" title="查看输出">
          <span className="chat-task-kind">$ (zsh)</span>
          <span className="chat-task-status chat-task-status-running">running</span>
          <span className="chat-task-runtime">46s</span>
          <span className="chat-task-type">bg-3</span>
          <span className="chat-task-description">
            npx vite --config .probe/dock-rows/vite.config.mjs
          </span>
        </button>
        <ArcoAction
          iconOnly
          type="button"
          className="chat-task-action"
          title="终止后台任务"
          aria-label="终止后台任务 bg-3"
        >
          ✕
        </ArcoAction>
      </div>
    </section>
  )
}

/**
 * 每种行都量一遍：高度、字号、行高。行首/行尾不参与判断，只看盒子。
 *
 * 思考块是折行的段落，不是单行：它只需要是行高的整数倍（每一行都落在同一条格子上），
 * 其余每种行都必须正好等于 `--chat-log-row-height`。
 */
function measure() {
  const base = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--chat-log-row-height')
  )
  const pick = (selector) =>
    [...document.querySelectorAll(selector)].map((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const height = Math.round(rect.height * 100) / 100
      const wraps = selector === '.chat-turn-log-thinking'
      const onGrid = wraps
        ? height >= base - 0.01 && Math.abs(height % base) < 0.02
        : Math.abs(height - base) < 0.02
      return {
        selector,
        height,
        wraps,
        onGrid,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        padding: `${style.paddingTop}/${style.paddingBottom}`,
        margin: `${style.marginTop}/${style.marginBottom}`
      }
    })
  const rows = [
    ...pick('.chat-turn-log-head'),
    ...pick('.chat-turn-log-thinking'),
    ...pick('.chat-turn-log-row'),
    ...pick('.chat-task-summary-row'),
    ...pick('.chat-task-child')
  ]
  const heights = [...new Set(rows.map((row) => row.height))]
  return { unit: base, uniform: rows.every((row) => row.onGrid), heights, rows }
}

function Probe() {
  const [report, setReport] = useState(null)

  useEffect(() => {
    let cancelled = false
    const run = () => {
      if (cancelled) return
      const result = measure()
      setReport(result)
      window.__probe = { ready: true, measure, result }
      const out = document.getElementById('probe-out')
      if (out)
        out.textContent = JSON.stringify(
          { uniform: result.uniform, heights: result.heights },
          null,
          2
        )
    }
    // 字体换上之后行高才稳定（等宽字体先后备，宽度会影响折行行数）
    const fonts = document.fonts?.ready ?? Promise.resolve()
    fonts.then(() => requestAnimationFrame(() => requestAnimationFrame(run)))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="probe-stage">
      <div className={`probe-verdict${report?.uniform ? ' is-ok' : ' is-bad'}`}>
        {report
          ? report.uniform
            ? `每行 ${report.unit}px · 每种行都落在同一条格子上`
            : `行高对不上（应为 ${report.unit}px 的整数倍）：${report.heights.join(' / ')}px`
          : '量取中…'}
      </div>
      <div className="probe-dock">
        <section className="chat-turn-log" aria-label="当前回合的思考与工具日志">
          <TurnLogHead />
          <div className="chat-turn-log-scroll">
            <div className="chat-turn-log-round is-current">
              <div className="chat-turn-log-round-body">
                <ReasoningRow text={THINKING_ONE_LINE} />
                {TOOLS.map((tool, index) => (
                  <ToolActivityRow key={index} tool={tool} now={NOW} />
                ))}
                <ReasoningRow text={THINKING_MULTI} />
              </div>
            </div>
          </div>
        </section>
        <TodoDockFixture />
        <SubagentDockFixture />
        <BackgroundDockFixture />
        {/* 另外两个消费者（subagent 详情弹窗的时间线、By The Way 抽屉）拿到的是同一套行，
            放在这里是为了顺手核对它们没有把行高改回去。 */}
        <div className="probe-elsewhere">
          <div className="chat-activity-log">
            <ReasoningRow text={THINKING_ONE_LINE} />
            <ToolActivityRow tool={TOOLS[0]} now={NOW} />
          </div>
          <div className="chat-btw-activity">
            <ReasoningRow text={THINKING_ONE_LINE} />
            <ToolActivityRow tool={TOOLS[1]} now={NOW} />
          </div>
        </div>
      </div>
      <pre id="probe-out" className="probe-out" />
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <ArcoProvider>
    <Probe />
  </ArcoProvider>
)
