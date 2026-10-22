import { IconLoader2 } from '@tabler/icons-react'
import { toolIcon } from '@packages/mica-web-shared'
import { formatLogElapsed, toolCallText, toolDurationMs } from './chat-tool-display'

/**
 * 「一个 mica 运行实例正在做什么」的那几行——思考、工具调用。
 *
 * 单独成文件是因为它有两个消费者：主对话的回合日志（`TurnLogDock`）与 By The Way 抽屉
 * （btw 也是一个运行实例，跑工具的样子就该和主对话一模一样）。抽屉不能 import
 * `ChatView.jsx`（那是循环依赖），所以这些展示件必须抽出来，而不是各写一份。
 *
 * 两条硬约束：
 * - 每个条目**只占一行**。终端那边（`mica-ui/agentTurnLogItems.tsx`）同理，超长就裁成
 *   省略号，不再往下铺工具输出——多行日志把对话区挤没了。
 * - 想看详情就点这一行：完整入参/输出在 `chat-tool-detail.jsx` 的弹窗里，`onOpen`
 *   由调用方决定弹哪个（主对话与 btw 各持一份状态，避免互相干扰）。
 *
 * 只用 `.chat-turn-log-*` 那套类，容器（`.chat-turn-log` / `.chat-btw-activity`）由调用方给。
 */

/** 行文案：多行命令/思考先收成一行，超长部分交给 CSS 的 text-overflow。 */
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
 * 思考过程：一行暗色斜体摘要，点开看全文。
 *
 * 思考是流式的，`text` 每来一段就换一次内容；行上不做任何请求，只是把新文本塞进去。
 */
export function ReasoningRow({ text, onOpen }) {
  const line = singleLine(text)
  if (!line) return null
  return (
    <div className="chat-turn-log-thinking">
      <button
        type="button"
        className="chat-turn-log-row"
        title={`${line}\n\n点击查看完整思考`}
        onClick={() => onOpen?.()}
      >
        <span className="chat-turn-log-icon chat-turn-log-icon-reasoning" aria-hidden="true">
          💭
        </span>
        <span className="chat-turn-log-display chat-turn-log-thinking-text">{line}</span>
      </button>
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
  const duration = formatLogElapsed(toolDurationMs(tool, now))
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
