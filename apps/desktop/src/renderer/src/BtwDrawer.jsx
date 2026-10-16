import { useEffect, useRef, useState } from 'react'
import {
  IconAlertCircle,
  IconLoader2,
  IconMessageChatbot,
  IconSend,
  IconX
} from '@tabler/icons-react'
import { useLatest } from './hooks'

/**
 * 输入条动作区的「By The Way」（btw）—— CLI `/btw` 的桌面等价物，**右侧抽屉**。
 *
 * 为什么是抽屉而不是浮层：它是一条会被反复追问、答案还常常要长读的**对话**（markdown、
 * 代码块、可点路径），400px 高的小浮层里只能靠滚动看，且一碰别处就关掉。抽屉占满对话
 * 区的高度、自己有一条输入条，读与问都留在里面。
 *
 * 为什么不是一条「消息」：btw 的语义是「不进入本会话上下文」——回答既不写进会话文件，
 * 也不参与主请求。放进对话流会让人分不清哪些内容进了 provider history，所以它留在
 * 抽屉里，主对话一条都不多。抽屉本身也**不覆盖**对话区：`.chat-view.chat-btw-open` 用
 * 内边距让出右侧这一条，主对话与主输入条照常可用（主流程正在跑时问一句正是它的用途）。
 *
 * 抽屉就是一条**线程**：连续追问复用同一个子代理（等同 CLI 的 `/btw -continue`），
 * 「新话题」重置线程、下一次提问重新取一份主流程对话记录当背景。整个线程活在
 * app-server 进程里，所以这里只是个投影（快照来自 `mica/btw/updated`）：
 *
 * - 主流程正在跑也能问（输入条不禁用），回答到了再渲染，不需要等 turn 结束；
 * - 关掉抽屉、切走、换一个窗口打开同一会话，线程都还在（同一份 host 状态）；
 * - 回答到达时若抽屉关着，ChatView 会补一条提示（否则看起来没反应）。
 */
export function BtwDrawer({
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

  // 打开抽屉就把光标放进输入框：这个抽屉存在的意义就是「问一句」，而点开的动作落在
  // 触发按钮上（`focusComposerFromShell` 不抢按钮的焦点），不主动聚焦就没处可打字。
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

  // 输入框跟着内容长高（到上限才自己滚）：抽屉比浮层宽，没必要让人在一行里横着读。
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`
  }, [draft])

  // Esc 关闭。抽屉刻意**不**照搬浮层的「点外面就关」：边看主对话边滚动是常态，误关一次
  // 就把半句话和正在读的答案一起收走了；文档级监听保证焦点在别的输入框里也生效。
  const closeRef = useLatest(onClose)
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeRef.current?.()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [closeRef])

  const submit = () => {
    const text = String(draft || '').trim()
    if (!text || running || sending) return
    onAsk?.(text)
  }

  return (
    // data-no-chat-focus：点抽屉里的空白处不该把焦点抢到主输入条（那会打断选中答案文本）。
    <aside className="chat-btw no-drag" data-no-chat-focus aria-label="By The Way">
      <header className="chat-btw-head">
        {/* 图标与输入条上那个触发按钮同一个：抽屉和它的入口要一眼对得上 */}
        <span className="chat-btw-mark" aria-hidden="true">
          <IconMessageChatbot size={13} />
        </span>
        <span className="chat-btw-title">By The Way</span>
        {/* 「新话题」是这条线程上的动作（不是「新建」），所以放在标题行而不是输入条里——
            紧挨着输入框的 + 会被读成「添加附件」之类，而它其实是「换一条线程重新开始」。 */}
        {entries.length > 0 ? (
          <button
            type="button"
            className="chat-btw-reset"
            title="换一条新线程（下次提问重新取当前对话记录作背景）"
            disabled={running}
            onClick={() => onNewThread?.()}
          >
            新话题
          </button>
        ) : null}
        <span className="chat-btw-sub">{running ? '正在回答…' : '不进入本会话上下文'}</span>
        <button
          type="button"
          className="chat-btw-close"
          aria-label="关闭"
          title="关闭（Esc）"
          onClick={() => onClose?.()}
        >
          <IconX size={13} />
        </button>
      </header>
      {/* 整个抽屉里唯一滚动的地方，所以「滚到底」打在这个元素上 */}
      <div className="chat-btw-body" ref={bodyRef}>
        {entries.length === 0 ? (
          <p className="chat-btw-empty">
            用一个隔离子代理回答问题：可以用只读工具查代码、搜索、联网，回答不写回主流程，
            也不占用本会话的上下文。主流程正在跑时也可以问。
          </p>
        ) : (
          <div className="chat-btw-thread">
            {entries.map((entry) => (
              <div key={entry.id} className="chat-btw-entry">
                {/* 问答复用对话区的行语法（▌ 是你、● 是模型）：同一个产品里同一件事
                    只该有一套样子，也省掉一列自造的「问/答」标签。 */}
                <div className="chat-message chat-message-user">
                  <div className="chat-message-marker" aria-hidden="true">
                    ▌
                  </div>
                  <div className="chat-message-body">
                    <p className="chat-btw-question">{entry.question}</p>
                  </div>
                </div>
                <div
                  className={`chat-message chat-message-assistant ${entry.status === 'running' ? 'chat-message-active' : ''}`}
                >
                  <div className="chat-message-marker" aria-hidden="true">
                    ●
                  </div>
                  <div className="chat-message-body">
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
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chat-btw-foot">
        {/* 提示语要能在一行里放下：手机上输入框是 16px（见 app.css 的移动端块），
            「问点什么，Enter 发送 · Shift+Enter 换行」会折成两行，而 placeholder 不参与
            scrollHeight —— 上面那个自动长高量不到它，第二行会被裁掉。 */}
        <textarea
          ref={inputRef}
          className="chat-btw-input"
          rows={1}
          value={draft}
          aria-label="By The Way 问题"
          title="Enter 发送 · Shift+Enter 换行（回答不进入本会话上下文）"
          placeholder={running ? '正在回答上一个问题…' : '问点什么，Enter 发送'}
          onChange={(event) => onDraftChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className="chat-btw-send"
          title="发送（不影响主流程）"
          aria-label="发送 By The Way 问题"
          disabled={!String(draft || '').trim() || running || sending}
          onClick={submit}
        >
          {sending ? <IconLoader2 size={13} className="animate-spin" /> : <IconSend size={13} />}
        </button>
      </div>
    </aside>
  )
}
