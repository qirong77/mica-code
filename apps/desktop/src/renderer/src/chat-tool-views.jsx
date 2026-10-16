import { useState } from 'react'
import { IconLoader2 } from '@tabler/icons-react'
import { toolIcon } from '@packages/mica-web-shared'
import { PathText } from './PathToken'
import { collapsedOutput, formatLogElapsed, toolCallText, toolOutput } from './chat-tool-display'

/**
 * 「一个 mica 运行实例正在做什么」的那几行——思考、工具调用、工具输出。
 *
 * 单独成文件是因为它有两个消费者：主对话的回合日志（`TurnLogDock`）与 By The Way 抽屉
 * （btw 也是一个运行实例，跑工具的样子就该和主对话一模一样）。抽屉不能 import
 * `ChatView.jsx`（那是循环依赖），所以这些展示件必须抽出来，而不是各写一份。
 *
 * 只用 `.chat-turn-log-*` 那套类，容器（`.chat-turn-log` / `.chat-btw-activity`）由调用方给。
 */

/**
 * 折叠状态下展示的输出行数取自 CLI 的 MICA_RUN_SHELL_LOG_MAX_LINES，但网页不再像
 * 终端那样「只有跑得够久才显示输出」——终端省的是屏幕高度，网页上折叠起来的尾行
 * 几乎不占地方，而「刚才那条命令到底输出什么」恰恰是最常被回看的信息。
 */
export function collapsedOutputLines() {
  const config = typeof window !== 'undefined' ? window.mica?.runShellLogConfig : undefined
  return config?.maxLines ?? 10
}

export function ToolOutputBlock({ output, maxLines }) {
  const [expanded, setExpanded] = useState(false)
  if (!output) return null
  const collapsed = collapsedOutput(output, maxLines)
  const expandedNow = expanded && collapsed.hidden > 0
  const lines = expandedNow ? output.lines : collapsed.lines
  const hidden = expandedNow ? 0 : collapsed.hidden
  return (
    <div className="chat-turn-log-output-block">
      {hidden > 0 && (
        <button
          type="button"
          className="chat-turn-log-more"
          onClick={() => setExpanded(true)}
          title="展开这条工具调用的完整输出"
        >
          … 上方还有 {hidden} 行（共 {output.lines.length} 行），点击展开
        </button>
      )}
      {lines.map((line, index) => (
        <div className="chat-turn-log-output" key={`${index}:${line}`}>
          <span> │ </span>
          <PathText text={line} />
        </div>
      ))}
      {expandedNow && (
        <button type="button" className="chat-turn-log-more" onClick={() => setExpanded(false)}>
          收起输出
        </button>
      )}
      {output.capped && (
        <div className="chat-turn-log-output chat-turn-log-output-capped">
          输出过长，此处只展示前 {output.lines.length} 行
        </div>
      )}
    </div>
  )
}

/** 思考过程的一整段（`.chat-turn-log-thinking` 自己负责边框与折行）。 */
export function ReasoningRow({ text }) {
  if (!text) return null
  return <div className="chat-turn-log-thinking">{text}</div>
}

/**
 * 一行工具调用：状态色 + 图标 + 文案 + 耗时，下面是可展开的输出。
 *
 * `now` 只给还在跑的那一行算耗时（已完成的行用 `finishedAt`，与 ChatView 的 memo 判定一致）。
 */
export function ToolActivityRow({ tool, now = Date.now() }) {
  if (!tool) return null
  const running = ['pending', 'running'].includes(tool.status)
  const failed = tool.status === 'error'
  const statusClass = running
    ? 'chat-turn-log-running'
    : failed
      ? 'chat-turn-log-error'
      : 'chat-turn-log-complete'
  const durationMs = Math.max(
    0,
    (running ? now : tool.finishedAt || tool.updatedAt || now) -
      (tool.startedAt || tool.updatedAt || now)
  )
  const duration = formatLogElapsed(durationMs)

  return (
    <div className={`chat-turn-log-tool ${statusClass}`}>
      <div className="chat-turn-log-tool-row">
        {running && (
          <span className="chat-turn-log-spinner" aria-hidden="true">
            <IconLoader2 size={10} className="animate-spin" />
          </span>
        )}
        <span className="chat-turn-log-icon">{toolIcon(tool.tool)}</span>
        <span className="chat-turn-log-display">
          <PathText text={toolCallText(tool)} />
        </span>
        {duration && (
          <span className="chat-turn-log-duration">{running ? duration : `(${duration})`}</span>
        )}
      </div>
      <ToolOutputBlock output={toolOutput(tool)} maxLines={collapsedOutputLines()} />
    </div>
  )
}
