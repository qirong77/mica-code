import { IconCopy, IconLayoutColumns } from '@tabler/icons-react'
import { toolIcon } from '@packages/mica-web-shared'
import { copyText } from './transport'
import { ModalMeta, ModalSection, ModalShell } from './chat-modal'
import { CodeView, displayText } from './CodeView'
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
 * 行上只留一行摘要，完整入参 / 输出都在这里看。弹窗只负责「一眼看清」：几千行的
 * 输出再往下翻并不好用，需要读全文就点「在编辑器中打开」——那边是应用里唯一的
 * monaco 实例（按只读虚拟文档打开），有折叠、查找与代码导航。
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

/** monaco 的语言 id 与这里不同名（`shell`→`shell`、`js`→`javascript`、`text`→`plaintext`） */
function editorLanguage(language) {
  if (language === 'js') return 'javascript'
  if (language === 'text' || language === 'log') return 'plaintext'
  return language
}

/**
 * 段落右上角的两个动作：复制（复制显示中的文本）与在编辑器中打开。
 * 打开后关掉弹窗——编辑器会顶掉主区，弹窗再压在它前面就没意义了。
 */
function SectionActions({ text, language, onOpenInEditor, onClose, documentId, title, copyTitle }) {
  return (
    <>
      {onOpenInEditor && text ? (
        <button
          type="button"
          title="在编辑器中打开"
          aria-label="在编辑器中打开"
          onClick={() => {
            onOpenInEditor({
              id: documentId,
              title,
              content: text,
              language: editorLanguage(language)
            })
            onClose()
          }}
        >
          <IconLayoutColumns size={12} /> 编辑器
        </button>
      ) : null}
      {text ? (
        <button type="button" onClick={() => void copyText(text)} title={copyTitle}>
          <IconCopy size={12} /> 复制
        </button>
      ) : null}
    </>
  )
}

export function ToolDetailDialog({ tool, onOpenInEditor, onClose }) {
  if (!tool) return null
  const output = toolOutput(tool)
  const outputRaw = output ? output.lines.join('\n') : ''
  const outputLang = output ? outputLanguage(tool, outputRaw) : 'text'
  const outputText = outputRaw ? displayText(outputRaw, outputLang) : ''
  const input = tool.input && typeof tool.input === 'object' ? tool.input : {}
  const inputRaw = Object.keys(input).length ? JSON.stringify(input, null, 2) : ''
  const inputText = inputRaw ? displayText(inputRaw, 'json') : ''
  const summary = toolSummary(tool)
  const duration = formatLogElapsed(toolDurationMs(tool))
  // 同一次工具调用的两次点击要落回同一个编辑器页签，所以用 callID 作记忆点。
  const documentBase = tool.callID || tool.id || `${tool.tool}-${tool.startedAt || ''}`

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
            <SectionActions
              text={inputText}
              language="json"
              title={`${toolDisplayName(tool)} 参数`}
              documentId={`${documentBase}:input`}
              copyTitle="复制参数 JSON"
              onOpenInEditor={onOpenInEditor}
              onClose={onClose}
            />
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
            <SectionActions
              text={outputText}
              language={outputLang}
              title={`${toolDisplayName(tool)} 输出`}
              documentId={`${documentBase}:output`}
              copyTitle="复制输出"
              onOpenInEditor={onOpenInEditor}
              onClose={onClose}
            />
          ) : null
        }
      >
        {output ? (
          <CodeView className="chat-modal-pre" text={outputText} language={outputLang} wrap />
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
