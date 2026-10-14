import { useEffect, useRef, useState } from 'react'
import {
  IconAlertCircle,
  IconLoader2,
  IconMessageChatbot,
  IconPlus,
  IconSend
} from '@tabler/icons-react'
import { Popover } from './Popover'

/**
 * 输入条动作区的「旁路提问」（btw）面板 —— CLI `/btw` 的桌面等价物。
 *
 * 为什么是一个**面板**而不是一条消息：btw 的语义是「不进入本会话上下文」——回答既
 * 不写进会话文件，也不参与主请求。放进对话流会让人分不清哪些内容进了上下文，所以它
 * 留在浮层里，主对话一条都不多。
 *
 * 面板就是一条**线程**：连续追问复用同一个子代理（等同 CLI 的 `/btw -continue`），
 * 「新话题」重置线程、下一次提问重新取一份主流程对话记录当背景。整个线程活在
 * app-server 进程里，所以面板只是个投影（快照来自 `mica/btw/updated`）：
 *
 * - 主流程正在跑也能问（输入条不禁用），回答到了再渲染，不需要等 turn 结束；
 * - 关掉面板、切走、换一个窗口打开同一会话，线程都还在（同一份 host 状态）；
 * - 回答到达时若面板关着，ChatView 会补一条提示（否则看起来没反应）。
 */
export function BtwPopover({
  thread,
  draft = '',
  sending = false,
  onDraftChange,
  onAsk,
  onNewThread,
  renderAnswer,
  onClose
}) {
  const bodyRef = useRef(null)
  const inputRef = useRef(null)
  const entries = Array.isArray(thread?.entries) ? thread.entries : []
  const running = entries.some((entry) => entry.status === 'running')
  const [threadId, setThreadId] = useState(thread?.id || '')

  // 打开面板就把光标放进输入框：这个面板存在的意义就是「问一句」，而点开的动作
  // 落在触发按钮上（`focusComposerFromShell` 不抢按钮的焦点），不主动聚焦的话
  // 直接打字会打不进任何地方。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 新话题（或 host 换了一条线程）后把光标放回输入框：这里正是要继续打字的地方。
  useEffect(() => {
    if (!thread?.id || thread.id === threadId) return
    setThreadId(thread.id)
    inputRef.current?.focus()
  }, [thread?.id, threadId])

  // 回答逐条追加，最新的那条要落在视野里（与对话区同一套「贴着底部」的手感）。
  const lastEntry = entries[entries.length - 1]
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    body.scrollTop = body.scrollHeight
  }, [entries.length, lastEntry?.status, lastEntry?.answer])

  const submit = () => {
    const text = String(draft || '').trim()
    if (!text || running || sending) return
    onAsk?.(text)
  }

  return (
    // 图标与输入条上那个触发按钮同一个：面板和它的入口要一眼对得上。
    <Popover
      name="btw"
      title="旁路提问"
      icon={<IconMessageChatbot size={13} />}
      meta={running ? '正在回答…' : '不进入本会话上下文'}
      onClose={onClose}
      className="chat-btw"
      bodyRef={bodyRef}
      actions={
        <>
          <button
            type="button"
            className="chat-popover-icon"
            title="新话题（重新取当前对话记录作背景）"
            aria-label="新话题"
            disabled={entries.length === 0 && !running}
            onClick={() => onNewThread?.()}
          >
            <IconPlus size={14} />
          </button>
          <textarea
            ref={inputRef}
            className="chat-btw-input"
            rows={1}
            value={draft}
            aria-label="旁路问题"
            placeholder={
              running ? '正在回答上一个问题…' : '问点什么，Enter 发送 · Shift+Enter 换行'
            }
            onChange={(event) => onDraftChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              // Esc 交给外壳（关闭面板），其余按键照常。
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button
            type="button"
            className="chat-popover-icon chat-btw-send"
            title="发送（不影响主流程）"
            aria-label="发送旁路问题"
            disabled={!String(draft || '').trim() || running || sending}
            onClick={submit}
          >
            {sending ? <IconLoader2 size={13} className="animate-spin" /> : <IconSend size={13} />}
          </button>
        </>
      }
    >
      <div className="chat-btw-thread" ref={bodyRef}>
        {entries.length === 0 ? (
          <p className="chat-btw-empty">
            用一个隔离子代理回答问题：可以用只读工具查代码、搜索、联网，回答不写回主流程，
            也不占用本会话的上下文。主流程正在跑时也可以问。
          </p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="chat-btw-entry">
              <div className="chat-btw-question">
                <span className="chat-btw-question-mark" aria-hidden="true">
                  ❯
                </span>
                <span className="chat-btw-question-text">{entry.question}</span>
              </div>
              {entry.status === 'running' ? (
                <p className="chat-btw-thinking">
                  <IconLoader2 size={11} className="animate-spin" /> 正在思考…
                </p>
              ) : entry.status === 'error' ? (
                <p className="chat-btw-error">
                  <IconAlertCircle size={11} /> {entry.error || 'btw 出错'}
                </p>
              ) : (
                <div className="chat-btw-answer">
                  {renderAnswer ? renderAnswer(entry.answer || '') : entry.answer}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Popover>
  )
}
