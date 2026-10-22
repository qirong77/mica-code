import { IconCopy } from '@tabler/icons-react'
import { toolIcon } from '@packages/mica-web-shared'
import { copyText } from './transport'
import { ModalMeta, ModalSection, ModalShell } from './chat-modal'
import { CodeView } from './CodeView'
import { guessLanguage } from './code-highlight'
import {
  formatLogElapsed,
  toolDisplayName,
  toolDurationMs,
  toolOutput,
  toolSummary
} from './chat-tool-display'

/**
 * 回合日志里那行的详情：主对话与 By The Way 抽屉共用（两个界面都有工具行）。
 *
 * 行上只留一行摘要，完整入参 / 输出都在这里看。
 */

function toolStatusLabel(status) {
  switch (status) {
    case 'pending':
      return '等待中'
    case 'running':
      return '运行中'
    case 'error':
      return '失败'
    case 'completed':
      return '完成'
    default:
      return status || '未知'
  }
}

function statusClass(status) {
  if (status === 'error') return 'is-error'
  if (status === 'pending' || status === 'running') return 'is-running'
  return 'is-done'
}

/**
 * 输出块的着色语言：`run_shell` 的 stdout 是 `[stdout]` + `key: value` 的结构化日志，
 * 其余工具优先认 JSON / diff（MCP、patch 类工具很常见），认不出就原样输出。
 */
function outputLanguage(tool, text) {
  if (tool?.tool === 'run_shell') return 'log'
  return guessLanguage(text)
}

export function ToolDetailDialog({ tool, onClose }) {
  if (!tool) return null
  const output = toolOutput(tool)
  const outputText = output ? output.lines.join('\n') : ''
  const input = tool.input && typeof tool.input === 'object' ? tool.input : {}
  const inputText = Object.keys(input).length ? JSON.stringify(input, null, 2) : ''
  const summary = toolSummary(tool)
  const duration = formatLogElapsed(toolDurationMs(tool))

  return (
    <ModalShell
      title={toolDisplayName(tool)}
      icon={toolIcon(tool.tool)}
      subtitle={summary || null}
      className="chat-modal-tool"
      onClose={onClose}
      meta={
        <ModalMeta
          items={[
            <span className={`chat-modal-status ${statusClass(tool.status)}`} key="status">
              {toolStatusLabel(tool.status)}
            </span>,
            duration ? `耗时 ${duration}` : null,
            tool.tool
          ]}
        />
      }
    >
      <ModalSection
        title="参数"
        extra={
          inputText ? (
            <button type="button" onClick={() => void copyText(inputText)} title="复制参数 JSON">
              <IconCopy size={12} /> 复制
            </button>
          ) : null
        }
      >
        {inputText ? (
          <CodeView
            className="chat-modal-pre chat-modal-pre-params"
            text={inputText}
            language="json"
            wrap
          />
        ) : (
          <div className="chat-modal-note">（无参数）</div>
        )}
      </ModalSection>
      <ModalSection
        title="输出"
        extra={
          output ? (
            <button
              type="button"
              onClick={() => void copyText(outputText)}
              title="复制输出"
            >
              <IconCopy size={12} /> 复制
            </button>
          ) : null
        }
      >
        {output ? (
          <CodeView
            className="chat-modal-pre"
            text={outputText}
            language={outputLanguage(tool, outputText)}
            wrap
          />
        ) : (
          <div className="chat-modal-note">
            {tool.status === 'running' || tool.status === 'pending' ? '还在运行…' : '（没有输出）'}
          </div>
        )}
        {output?.capped ? (
          <div className="chat-modal-note is-warn">
            输出过长，这里只保留前 {output.lines.length} 行
          </div>
        ) : null}
      </ModalSection>
    </ModalShell>
  )
}
