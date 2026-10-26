import { useLayoutEffect, useRef, useState } from 'react'
import { IconChevronDown, IconLoader2 } from '@tabler/icons-react'
import { toolIcon } from '@packages/mica-web-shared'
import { formatLogElapsed, toolCallText, toolDurationMs } from './chat-tool-display'
import { measureChatCollapse } from './chat-collapse'
import { THINKING_BODY_LINES, thinkingElapsedMs } from './chat-thinking'

/**
 * 「一个 mica 运行实例正在做什么」的那几行——思考、工具调用。
 *
 * 单独成文件是因为它有两个消费者：主对话的回合日志（`TurnLogDock`）与 By The Way 抽屉
 * （btw 也是一个运行实例，跑工具的样子就该和主对话一模一样）。抽屉不能 import
 * `ChatView.jsx`（那是循环依赖），所以这些展示件必须抽出来，而不是各写一份。
 *
 * 两条硬约束：
 * - **工具行只占一行**：超长就裁成省略号，不再往下铺工具输出——多行日志把对话区挤没了。
 *   终端那边（`mica-ui/agentTurnLogItems.tsx`）同一套规则。
 * - 思考照旧整段折行（它不是日志行，是这一轮想了什么）；工具行想看详情就点开，
 *   完整入参/输出在 `chat-tool-detail.jsx` 的弹窗里，`onOpen` 由调用方决定弹哪个
 *   （主对话与 btw 各持一份状态，避免互相干扰）。
 *
 * 只用 `.chat-turn-log-*` 那套类，容器（`.chat-turn-log` / `.chat-btw-activity`）由调用方给。
 */

/** 工具行文案：多行命令先收成一行，超长部分交给 CSS 的 text-overflow。 */
function singleLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function toolStatusClass(tool) {
  if (tool?.status === 'error') return 'chat-turn-log-error'
  if (['pending', 'running'].includes(tool?.status)) return 'chat-turn-log-running'
  return 'chat-turn-log-complete'
}

/**
 * 一段思考：身份行（`思考` / `思考中` + 耗时）+ 正文。
 *
 * 以前它只是一块淡色底的文字：没有身份、看不出是模型的思考还是回答的一部分，而且
 * 多个 reasoning 片段各占一块，读起来像几段互不相干的引用。现在相邻片段在数据层
 * 就合并成一段（`chat-thinking.js` 的 mergeThinkingRuns），这里只负责把它渲染成
 * 一条有标题的条目。
 *
 * 正文默认折到 `THINKING_BODY_LINES` 行：思考是过程，长起来会把真正在跑的工具行挤
 * 出日志区。还在想的时候显示**末尾**几行（读者关心的是此刻在想什么），结束后显示
 * 开头几行；点标题行展开全文。
 */
export function ThinkingRow({ text, startedAt, updatedAt, done = true, now = Date.now() }) {
  const bodyRef = useRef(null)
  const [{ overflowing, lineHeight }, setMetrics] = useState({ overflowing: false, lineHeight: 0 })
  const [expanded, setExpanded] = useState(false)
  const running = !done

  useLayoutEffect(() => {
    const element = bodyRef.current
    if (!element) return undefined
    const measure = () => {
      const style = window.getComputedStyle(element)
      const height =
        Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.45
      const next = measureChatCollapse({
        scrollHeight: element.scrollHeight,
        lineHeight: height,
        lines: THINKING_BODY_LINES
      })
      setMetrics((previous) =>
        previous.overflowing === next.collapsible && previous.lineHeight === height
          ? previous
          : { overflowing: next.collapsible, lineHeight: height }
      )
    }
    measure()
    // 宽度变化会改变折行数：同一段思考在窄窗口里可能从 3 行变成 8 行。
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])

  if (!String(text ?? '').trim()) return null
  const elapsed = thinkingElapsedMs({ startedAt, updatedAt, done }, now)
  // 还在想的时候不折叠：日志区本来就贴底滚动，读者要看到的是此刻在想什么。
  const foldable = overflowing && !running
  const clamped = foldable && !expanded

  return (
    <div className={`chat-turn-log-thinking${clamped ? ' is-clamped' : ''}`}>
      <button
        type="button"
        className="chat-turn-log-thinking-head"
        aria-expanded={foldable ? expanded : undefined}
        title={foldable ? (expanded ? '收起思考' : '展开思考') : undefined}
        onClick={() => foldable && setExpanded((value) => !value)}
      >
        {running ? (
          <span className="chat-turn-log-spinner" aria-hidden="true">
            <IconLoader2 size={10} className="animate-spin" />
          </span>
        ) : null}
        <span className="chat-turn-log-thinking-label">{running ? '思考中' : '思考'}</span>
        {elapsed > 0 ? (
          <span className="chat-turn-log-thinking-duration">{formatLogElapsed(elapsed)}</span>
        ) : null}
        {foldable ? (
          <IconChevronDown
            size={10}
            className={`chat-turn-log-thinking-caret${expanded ? ' is-open' : ''}`}
          />
        ) : null}
      </button>
      {/* 夹在中间的一层只管裁高度：内层正文保持完整高度，才能量出真实行数。
          高度按量出来的 line-height 乘行数算死，不用 em 近似——差 1px 就会把
          第四行裁掉一半。 */}
      <div
        className={`chat-turn-log-thinking-clamp${clamped ? ' is-clamped' : ''}`}
        style={clamped ? { maxHeight: Math.round(lineHeight * THINKING_BODY_LINES) } : undefined}
      >
        <div ref={bodyRef} className="chat-turn-log-thinking-body">
          {text}
        </div>
      </div>
    </div>
  )
}

/**
 * 一行工具调用：状态色 + 图标 + 文案 + 耗时。点开看参数与输出。
 *
 * `now` 只给还在跑的那一行算耗时（已完成的行用 `finishedAt`，与 ChatView 的 memo 判定一致）。
 */
export function ToolActivityRow({ tool, now = Date.now(), onOpen }) {
  if (!tool) return null
  const running = ['pending', 'running'].includes(tool.status)
  // 没有起止时间的调用（如 subagent 时间线里配不上调用的孤立结果）不显示耗时，
  // 免得每一行都挂一个没有意义的 `0ms`。
  const elapsed = toolDurationMs(tool, now)
  const duration = elapsed > 0 ? formatLogElapsed(elapsed) : ''
  const text = singleLine(toolCallText(tool))

  return (
    <div className={`chat-turn-log-tool ${toolStatusClass(tool)}`}>
      <button
        type="button"
        className="chat-turn-log-row"
        title={`${text}\n\n点击查看调用详情`}
        onClick={() => onOpen?.()}
      >
        {running ? (
          <span className="chat-turn-log-spinner" aria-hidden="true">
            <IconLoader2 size={10} className="animate-spin" />
          </span>
        ) : null}
        <span className="chat-turn-log-icon" aria-hidden="true">
          {toolIcon(tool.tool)}
        </span>
        <span className="chat-turn-log-display">{text}</span>
        {duration ? (
          <span className="chat-turn-log-duration">{running ? duration : `(${duration})`}</span>
        ) : null}
      </button>
    </div>
  )
}
