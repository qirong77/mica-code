// 探针「停靠区」：输入框上方那串停靠区的**版式预览 + 量取**。
//
// 三件事必须与产品一致，否则这个页面只是示意图：
// 1. 块本身用**真组件**（`TurnLogDock` / `TodoDock` / `SubagentStatusDock` /
//    `BackgroundTasksDock` / `WaitTasksDock`），数据是这里写死的示例——不连运行中的
//    会话、不发起任何模型或工具请求，几组场景随时可看；
// 2. 样式全部来自 `app.css` 的真实类名，不在这里抄一份；
// 3. 只有「输入条那一行」是照抄的：产品里这段标记同时存在于 `ChatView.jsx`（可点，带
//    角色切换）与 `BtwDrawer.jsx`（只读），这里照抄只读那份的三个类名。
//
// 页面顶部打出结论：每行的高度是否落在同一条格子上、收起箭头是否落在同一条竖轨上。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArcoProvider } from '@mica-config-ui/web'
import {
  BackgroundTasksDock,
  SubagentStatusDock,
  TodoDock,
  TurnLogDock,
  WaitTasksDock,
  todoPanelForTurn
} from '../../src/renderer/src/ChatView.jsx'
import { groupActivityRounds } from '../../src/renderer/src/chat-turn-activity.js'
import { keepsBackgroundTaskRow } from '@packages/mica-common/backgroundTaskVisibility.ts'
import { keepsSubagentTaskRow } from '@packages/mica-common/subagentVisibility.ts'
import '../../src/renderer/assets/app.css'
import './probe.css'

// 假 host：停靠区的折叠状态写在共享界面状态里，探针没有运行时，给它一个空实现，
// 点箭头仍然能展开/收起（本地状态照常生效）。
window.mica = {
  ...(window.mica || {}),
  uiState: {
    get: async () => ({}),
    set: async () => ({ ok: true }),
    onChanged: () => () => {}
  }
}

const BASE = Date.parse('2026-11-21T05:40:00.000Z')
const at = (seconds) => BASE + seconds * 1000
// 「现在」定在示例时间轴上，耗时因此是固定值，每次打开都一样。
const NOW = at(96)

const todoMessage = (turnId, items, seconds = 5) => ({
  id: `${turnId}-todo`,
  kind: 'tool',
  turnId,
  tool: {
    tool: 'todo_write',
    status: 'completed',
    input: { todos: items.map(([content, status]) => ({ content, status })) },
    startedAt: at(seconds - 1),
    finishedAt: at(seconds)
  }
})

const thinking = (turnId, text, seconds) => ({
  id: `${turnId}-think-${seconds}`,
  kind: 'reasoning',
  turnId,
  text,
  updatedAt: at(seconds)
})

const tool = (turnId, id, name, input, status, from, to) => ({
  id: `${turnId}-${id}`,
  kind: 'tool',
  turnId,
  tool: {
    tool: name,
    input,
    status,
    startedAt: at(from),
    finishedAt: to == null ? null : at(to),
    updatedAt: at(to ?? from)
  }
})

// ① 运行中：一条正在跑的轮次（思考 + 读文件 + grep + 写入 + 正在跑的测试）。
const LIVE_TURN = 'turn-live'
const liveMessages = [
  thinking(LIVE_TURN, '先看示例仓库里的队列实现和测试，确认补取消支持要动哪几处。', 6),
  tool(LIVE_TURN, 'read', 'read_file', { file_path: 'src/task-queue.mjs', limit: 120 }, 'completed', 7, 9),
  tool(LIVE_TURN, 'grep', 'grep_search', { pattern: 'queue.add|test\\(', path: '.' }, 'completed', 9, 12),
  todoMessage(LIVE_TURN, [
    ['确认串行执行与失败恢复行为', 'completed'],
    ['为任务队列补充 AbortSignal 支持', 'in_progress'],
    ['验证取消行为与原有测试', 'pending']
  ]),
  tool(
    LIVE_TURN,
    'patch',
    'apply_patch',
    { patch: '*** Begin Patch\n*** Update File: src/task-queue.mjs\n@@\n-  add(task) {\n+  add(task, { signal } = {}) {' },
    'completed',
    30,
    34
  ),
  tool(LIVE_TURN, 'test', 'run_shell', { command: 'node --test --test-reporter=tap' }, 'running', 78, null)
]

// ② 中断前那一轮：更早的轮次在停靠区里收成一行。
const PAST_TURN = 'turn-past'
const pastMessages = [
  thinking(PAST_TURN, '先把串行队列与失败恢复的行为读一遍。', 2),
  tool(PAST_TURN, 'read', 'read_file', { file_path: 'test/task-queue.test.mjs', limit: 160 }, 'completed', 3, 6),
  tool(PAST_TURN, 'run', 'run_shell', { command: 'node --test' }, 'completed', 8, 14)
]

// ④ 正常完成：计划全部完成，日志按设计隐藏。
const DONE_TURN = 'turn-done'
const doneMessages = [
  thinking(DONE_TURN, '三条取消测试已写入，跑一遍全量测试再收尾。', 4),
  tool(DONE_TURN, 'test', 'run_shell', { command: 'node --test --test-reporter=tap' }, 'completed', 20, 26),
  todoMessage(
    DONE_TURN,
    [
      ['确认串行执行与失败恢复行为', 'completed'],
      ['为任务队列补充 AbortSignal 支持', 'completed'],
      ['验证取消行为与原有测试', 'completed']
    ],
    27
  )
]

// 子代理：一行父任务（带两条活动行）+ 一行嵌套子任务。
const SUBAGENT_TASKS = [
  {
    taskId: 'sub-1',
    status: 'running',
    subagentType: 'explore',
    description: '找出所有还在自己写左边距的停靠区行',
    startedAt: new Date(at(20)).toISOString(),
    finishedAt: null,
    activities: [
      { id: 'a1', toolName: 'grep_search', summary: 'read apps/desktop/src/renderer/assets/app.css · 12 处命中' },
      { id: 'a2', toolName: 'read_file', summary: 'read apps/desktop/src/renderer/src/ChatView.jsx · 2200-2260' }
    ]
  },
  {
    taskId: 'sub-2',
    parentTaskId: 'sub-1',
    status: 'running',
    subagentType: 'review',
    description: '核对这几行的左边距来自哪里',
    startedAt: new Date(at(46)).toISOString(),
    finishedAt: null,
    activities: []
  },
]

const BACKGROUND_TASKS = [
  {
    id: 'bg-3',
    shell: '/bin/zsh',
    status: 'running',
    command: 'npx vite --config .probe/dock-rows/vite.config.mjs',
    startedAt: new Date(at(52)).toISOString()
  },
  {
    id: 'bg-4',
    shell: '/bin/bash',
    status: 'running',
    command: 'tail -f /tmp/mica-demo.log',
    startedAt: new Date(at(64)).toISOString()
  },
  {
    // 结束的后台任务不进停靠区（`keepsBackgroundTaskRow`）：这里留着是为了说明这一点，
    // 它不会渲染出来。
    id: 'bg-1',
    shell: '/bin/zsh',
    status: 'completed',
    command: 'git status --short',
    startedAt: new Date(at(8)).toISOString(),
    exitCode: 0
  }
]

const WAIT_TASKS = [
  {
    id: 'wait-1',
    kind: 'port',
    reason: '等探针的 dev server 起来再截图',
    label: '127.0.0.1:5237 可连接',
    startedAt: new Date(at(70)).toISOString(),
    polls: 24
  }
]

function ComposerRow({ running = true }) {
  // 与 `BtwDrawer.jsx` 里那段只读行首标记同构：三个类名、同一个字形。
  return (
    <div className="chat-composer probe-composer">
      <span className="chat-prompt-mark" aria-hidden="true">
        <span className="chat-prompt-caret">›</span>
      </span>
      <div className="chat-composer-input">
        <textarea
          rows={1}
          readOnly
          aria-label="对话输入"
          placeholder={
            running ? '消息会在下一个工具调用迭代后发送' : 'Type something and press Enter...'
          }
        />
      </div>
      <div className="chat-composer-actions">
        <span className="probe-composer-icon">+</span>
        <span className={`probe-composer-icon${running ? ' is-stop' : ''}`}>
          {running ? '■' : '↑'}
        </span>
      </div>
    </div>
  )
}

/**
 * 一块场景 = 停靠区 + 输入条，顺序与 `ChatView` 的 `.chat-bottom-scroll` 一致。
 * 只收生产里真会出现的那几行：子代理与后台任务在 `ChatView` 里都先过一遍可见性
 * 过滤（跑完的不占行），这里用同一对判断函数，示例数据不会摆出产品摆不出的样子。
 */
function DockStack({ rounds, panel, running = true, interrupted = false }) {
  return (
    <div className="probe-stack">
      <TurnLogDock
        rounds={rounds}
        now={NOW}
        running={running}
        interrupted={interrupted}
        onOpenActivity={() => {}}
      />
      {/* 与 `ChatView` 一致：四块任务行放进同一张表（`.chat-task-grid`），列宽共享。 */}
      <div className="chat-task-grid">
        <TodoDock panel={panel} />
        {running || interrupted ? (
          <>
            <SubagentStatusDock
              tasks={SUBAGENT_TASKS.filter(keepsSubagentTaskRow)}
              now={NOW}
              onOpen={() => {}}
            />
            <BackgroundTasksDock
              tasks={BACKGROUND_TASKS.filter(keepsBackgroundTaskRow)}
              now={NOW}
              onOpen={() => {}}
              onKill={() => {}}
            />
            <WaitTasksDock tasks={WAIT_TASKS} now={NOW} onOpen={() => {}} />
          </>
        ) : null}
      </div>
      <ComposerRow running={running} />
    </div>
  )
}

function Scenario({ title, note, children }) {
  return (
    <section className="probe-scene">
      <header className="probe-scene-head">
        <span className="probe-scene-title">{title}</span>
        <span className="probe-scene-note">{note}</span>
      </header>
      <div className="probe-pane">{children}</div>
    </section>
  )
}

function Probe() {
  const [report, setReport] = useState(null)
  // 展开/收起是**全局**界面状态（产品里也是一份 `ui-state`）：一处点开，所有停靠区的
  // 标题行都跟着摊开，所以整页只有这一种状态，用页面顶部这颗按钮翻。
  const [logOpen, setLogOpen] = useState(false)
  const liveRounds = useMemo(() => groupActivityRounds(liveMessages), [])
  const livePanel = useMemo(
    () => todoPanelForTurn(liveMessages, LIVE_TURN, true, false, false, null),
    []
  )
  const interruptedRounds = useMemo(
    () => groupActivityRounds([...pastMessages, ...liveMessages]),
    []
  )
  const interruptedPanel = useMemo(
    () => todoPanelForTurn(liveMessages, LIVE_TURN, false, false, true, null),
    []
  )
  const doneRounds = useMemo(() => groupActivityRounds(doneMessages), [])
  const donePanel = useMemo(
    () => todoPanelForTurn(doneMessages, DONE_TURN, false, false, false, null),
    []
  )

  const toggleLog = useCallback(() => {
    const toggle = document.querySelector('.chat-turn-log-toggle')
    toggle?.click()
    setLogOpen((value) => !value)
  }, [])

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
          { uniform: result.uniform, heights: result.heights, rail: result.rail },
          null,
          2
        )
    }
    // 字体换上之后行高才稳定（等宽字体先后备，宽度会影响折行行数）
    const fonts = document.fonts?.ready ?? Promise.resolve()
    fonts.then(() => requestAnimationFrame(() => requestAnimationFrame(run)))
    // 改样式（HMR）、拖窗口宽度都会让盒子重新排：量取跟着重排重跑。
    const stage = document.querySelector('.probe-stage')
    const observer =
      stage && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => run()) : null
    if (observer && stage) observer.observe(stage)
    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [])

  const rail = report?.rail
  const railOk = Boolean(rail?.chevronsAligned && rail?.leadsAligned)
  return (
    <div className="probe-stage">
      <div className={`probe-verdict${report?.uniform ? ' is-ok' : ' is-bad'}`}>
        {report
          ? report.uniform
            ? `每行 ${report.unit}px · 每种行都落在同一条格子上`
            : `行高对不上（应为 ${report.unit}px 的整数倍）：${report.heights.join(' / ')}px`
          : '量取中…'}
      </div>
      <div className={`probe-verdict${railOk ? ' is-ok' : ' is-bad'}`}>
        {rail
          ? `收起箭头中心 x=${rail.railX} · 行首左缘 x=${rail.leadX} · ${
              railOk ? '箭头共线、行首齐平' : `对不上：${rail.leads
                .map((row) => `${row.name} ${row.x}`)
                .join(' / ')}`
            }`
          : '量取中…'}
      </div>
      <div className={`probe-verdict${rail?.columnsAligned ? ' is-ok' : ' is-bad'}`}>
        {rail
          ? rail.columnsAligned
            ? `状态 / 数值 / 标识 / 描述各成一列：${rail.columns.status} · ${rail.columns.runtime} · ${rail.columns.type} · ${rail.columns.description}`
            : `表头列没对齐：${Object.entries(rail.columns)
                .map(([name, values]) => `${name} ${values.join('、')}`)
                .join(' / ')}`
          : '量取中…'}
      </div>
      <button type="button" className="probe-toggle" onClick={toggleLog}>
        {logOpen ? '收起回合日志' : '展开回合日志'}
      </button>
      <div className="probe-scenes">
        <Scenario
          title="① 运行中 · 停靠区收起"
          note="模型思考中 + todo（含子项）+ 子代理（含嵌套与活动行）+ 两个后台任务 + 一个等待条件"
        >
          <DockStack rounds={liveRounds} panel={livePanel} running />
        </Scenario>
        <Scenario title="② 中断（可回看）" note="停在这一步：日志保留、上一轮收成一行、计划标成未完成">
          <DockStack
            rounds={interruptedRounds}
            panel={interruptedPanel}
            running={false}
            interrupted
          />
        </Scenario>
        <Scenario title="③ 正常完成" note="停靠区只剩计划：三条全完成收成一行，日志按设计隐藏">
          <DockStack rounds={doneRounds} panel={donePanel} running={false} />
        </Scenario>
      </div>
      <pre id="probe-out" className="probe-out" />
    </div>
  )
}

/**
 * 每种行都量一遍：高度、字号、行高；另外量轨道——收起箭头（回合日志 / todo / 输入条
 * 行首标记）的中心必须落在同一个 x 上，标签也必须从同一个 x 开始。
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
  return {
    unit: base,
    uniform: rows.every((row) => row.onGrid),
    heights,
    rows,
    rail: measureRail()
  }
}

function measureRail() {
  const round = (value) => Math.round(value * 100) / 100
  const scene = document.querySelector('.probe-pane')
  if (!scene) return null
  const left = scene.getBoundingClientRect().left
  const centerOf = (selector) => {
    const element = scene.querySelector(selector)
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return round(rect.left + rect.width / 2 - left)
  }
  const startOf = (selector) => {
    const element = scene.querySelector(selector)
    return element ? round(element.getBoundingClientRect().left - left) : null
  }
  // ① 收起箭头：有折叠图标的行，箭头中心必须在同一条竖线上。
  const chevrons = [
    { name: '回合日志标题', selector: '.chat-turn-log-head .chat-turn-log-toggle svg' },
    { name: 'todo', selector: '.chat-todo-toggle .chat-task-lead svg' },
    { name: '输入条行首标记', selector: '.probe-composer .chat-prompt-caret' }
  ].map((row) => ({ ...row, x: centerOf(row.selector) }))
  // ② 行首：每一行的第一个图形（箭头或种类图标）都贴在同一条左边缘上。
  const leads = [
    { name: '回合日志标题', selector: '.chat-turn-log-head .chat-turn-log-toggle' },
    { name: 'todo 箭头', selector: '.chat-todo-toggle .chat-task-lead' },
    { name: 'subagent 图标', selector: '.chat-subagent-dock > div > .chat-task-summary-row .chat-task-kind' },
    { name: '后台任务图标', selector: '.chat-background-dock .chat-task-kind' },
    { name: '等待条件图标', selector: '.chat-wait-dock .chat-task-kind' },
    { name: '输入条行首标记', selector: '.probe-composer .chat-prompt-caret' }
  ].map((row) => ({ ...row, x: startOf(row.selector) }))
  // ③ 表头各列：状态 / 数值 / 标识 / 描述在每一行都必须落在同一个 x 上。
  const columnOf = (selector) =>
    [...scene.querySelectorAll(selector)]
      .map((element) => round(element.getBoundingClientRect().left - left))
      .filter((value, index, all) => all.indexOf(value) === index)
  // 只比「顶层的行」：嵌套子代理与活动行本来就缩进，不在这几列上。
  const topRow = ':not(.chat-task-summary-row-nested)'
  const columns = {
    status: columnOf(`.chat-task-summary-row${topRow} .chat-task-status`),
    runtime: columnOf(`.chat-task-summary-row${topRow} .chat-task-runtime`),
    type: columnOf(`.chat-task-summary-row${topRow} .chat-task-type`),
    description: columnOf(`.chat-task-summary-row${topRow} .chat-task-description`)
  }
  const sameX = (rows) => {
    const values = rows.map((row) => row.x).filter((value) => value != null)
    return values.length > 0 && values.every((value) => Math.abs(value - values[0]) < 0.51)
  }
  return {
    railX: chevrons[0]?.x ?? null,
    leadX: leads[0]?.x ?? null,
    chevrons,
    leads,
    columns,
    chevronsAligned: sameX(chevrons),
    leadsAligned: sameX(leads),
    columnsAligned: Object.values(columns).every((values) => values.length <= 1)
  }
}

createRoot(document.getElementById('root')).render(
  <ArcoProvider>
    <Probe />
  </ArcoProvider>
)
