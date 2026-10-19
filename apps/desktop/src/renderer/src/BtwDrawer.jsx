import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconAlertCircle,
  IconLoader2,
  IconMessageChatbot,
  IconPhoto,
  IconSend,
  IconX
} from '@tabler/icons-react'
import { ComposerImageStrip } from './composer-images'
import { pasteIntoComposer } from './composer-paste'
import { formatLogElapsed } from './chat-tool-display'
import { ReasoningRow, ToolActivityRow } from './chat-tool-views'
import { btwEntryElapsedMs, btwPhaseText, btwRunningEntry } from './btw-thread'
import { useLatest } from './hooks'
import TerminalComposer from './TerminalComposer'

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
 * app-server 进程里，所以这里只是个投影（快照来自 `mica/btw/updated`）。
 *
 * btw 是**一个 mica 运行实例**，所以这里按主对话那套实时渲染：思考、工具调用（同一批
 * `chat-tool-views.jsx` 的组件，与回合日志长得一模一样）、逐字流出的正文。快照是
 * 「整条线程」的高频替换，所以组件只管把最新一份画出来；阶段判定全在 `btw-thread.js`。
 *
 * 与主对话的两点差异是刻意的：思考与工具行**只属于正在跑的那一条**（host 在新问题开始
 * 时会清掉上一条的，见 `apps/cli/src/runtime/btwThread.ts`）；回答不落盘，所以关掉抽屉、
 * 切走、换一个窗口打开同一会话时看到的是 host 里那份线程。回答到达时若抽屉关着，
 * ChatView 会补一条提示（否则看起来没反应）。
 */
export function BtwDrawer({
  thread,
  draft = '',
  sending = false,
  onDraftChange,
  onAsk,
  onNewThread,
  renderAnswer,
  renderQuestion,
  onPreviewImage,
  onNotice,
  onClose
}) {
  const bodyRef = useRef(null)
  const inputRef = useRef(null)
  const imageInputRef = useRef(null)
  const draftRef = useLatest(draft)
  const entries = Array.isArray(thread?.entries) ? thread.entries : []
  const runningEntry = btwRunningEntry(entries)
  const running = Boolean(runningEntry)
  const [threadId, setThreadId] = useState(thread?.id || '')
  const [now, setNow] = useState(() => Date.now())
  // 读者是否还贴着底部。上翻看已经读过的答案时不该被流式的正文拽回来（与对话区同一手感）。
  const stickToBottomRef = useRef(true)

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

  // 只在回答期间走表：阶段文案与耗时每秒都要动，但不该让抽屉常驻一个定时器。
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [running])

  // 流式正文每来一个合并窗口就追加一截，贴着底部时才跟着滚。
  useEffect(() => {
    const body = bodyRef.current
    if (body && stickToBottomRef.current) body.scrollTop = body.scrollHeight
  }, [entries, now])

  /**
   * 把一段文本插到光标处（粘贴图片、上传图片共用）。以 textarea 当前的值为准——选照片
   * 与读剪贴板都是异步的，回调执行时闭包里的 draft 可能已经过期。
   *
   * 与主输入条的 `insertComposerText` 同一套语义：插完把光标落在插入内容之后、焦点交还
   * 输入框，用户接着就能打字。
   */
  const insertText = useCallback(
    (text) => {
      if (!text) return
      const element = inputRef.current
      const current = element?.value ?? draftRef.current ?? ''
      const start = element?.selectionStart ?? current.length
      const end = element?.selectionEnd ?? current.length
      const next = current.slice(0, start) + text + current.slice(end)
      onDraftChange?.(next)
      requestAnimationFrame(() => {
        const node = inputRef.current
        if (!node) return
        node.setSelectionRange(start + text.length, start + text.length)
        node.focus()
      })
    },
    [draftRef, onDraftChange]
  )

  // 粘贴与主输入条**同一份实现**：图片转 `[Image](路径)`，文件（文件夹 / Excel…）转成
  // 绝对路径。抽屉是另一条对话，粘贴的行为不该长出第二种。
  const handlePaste = useCallback(
    (event) => {
      void pasteIntoComposer(event, { insertText, notify: onNotice })
    },
    [insertText, onNotice]
  )

  // 相册/拍照：手机上粘贴不可用，只能靠文件选择器（与主输入条同一个 accept）
  const attachImages = useCallback(
    async (files) => {
      const list = Array.from(files || [])
      if (!list.length) return
      const refs = []
      for (const file of list) {
        try {
          const result = await window.mica.chat.savePastedImage({ file })
          if (result?.ok && result.ref) refs.push(result.ref)
          else onNotice?.(result?.error || `上传 ${file.name || '图片'} 失败`, 'error')
        } catch (error) {
          // 失败就不插引用（草稿里不该出现一个打不开的路径），但要说明为什么没反应
          onNotice?.(`上传 ${file.name || '图片'} 失败：${error?.message || error}`, 'error')
        }
      }
      if (refs.length) insertText(refs.map((ref) => `[Image](${ref})`).join(' '))
    },
    [insertText, onNotice]
  )

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

  // 标题行右侧：回答中就报阶段与耗时（「正在调用 grep_search… 12.4s」），否则说明这条
  // 线程的边界（回答不进本会话上下文）。
  const statusText = runningEntry
    ? `${btwPhaseText(runningEntry)} ${formatLogElapsed(btwEntryElapsedMs(runningEntry, now))}`
    : '不进入本会话上下文'

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
        <span className="chat-btw-sub" title={statusText}>
          {runningEntry ? <span className="chat-btw-live" aria-hidden="true" /> : null}
          {statusText}
        </span>
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
      <div
        className="chat-btw-body"
        ref={bodyRef}
        onScroll={(event) => {
          const element = event.currentTarget
          stickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
      >
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
                    {/* 与对话区「你说的话」同一套渲染：图片引用降级成可点链接、路径可点 */}
                    <p className="chat-btw-question">
                      {renderQuestion ? renderQuestion(entry.question) : entry.question}
                    </p>
                  </div>
                </div>
                <div
                  className={`chat-message chat-message-assistant ${entry.status === 'running' ? 'chat-message-active' : ''}`}
                >
                  <div className="chat-message-marker" aria-hidden="true">
                    ●
                  </div>
                  <div className="chat-message-body">
                    {/* 思考与工具行：与主对话的回合日志同一套组件与样式（btw 也是个运行实例） */}
                    {entry.thinking || entry.tools?.length ? (
                      <div className="chat-btw-activity">
                        <ReasoningRow text={entry.thinking} />
                        {(entry.tools || []).map((tool) => (
                          <ToolActivityRow key={tool.id} tool={tool} now={now} />
                        ))}
                      </div>
                    ) : null}
                    {/* 还没吐出任何正文时的等待行；已经有思考/工具在动就不重复说明了 */}
                    {entry.status === 'running' &&
                    !entry.answer &&
                    !entry.thinking &&
                    !entry.tools?.length ? (
                      <p className="chat-btw-thinking">
                        <IconLoader2 size={11} className="animate-spin" /> {btwPhaseText(entry)}
                      </p>
                    ) : null}
                    {entry.status === 'error' ? (
                      <p className="chat-btw-error">
                        <IconAlertCircle size={11} /> {entry.error || 'btw 出错'}
                      </p>
                    ) : null}
                    {entry.answer ? (
                      // `is-streaming` 让光标挂在**最后一段文字**的末尾（见 app.css）：直接写成
                      // 标记的兄弟节点会被 markdown 的块级元素顶到下一行、看着像多了一个空段。
                      <div
                        className={`chat-btw-answer${entry.status === 'running' ? ' is-streaming' : ''}`}
                      >
                        {renderAnswer ? renderAnswer(entry.answer) : entry.answer}
                        <span className="chat-btw-caret" aria-hidden="true" />
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chat-btw-foot">
        {/* 输入条与主对话**同一套实现**：`TerminalComposer` 负责自绘光标、选区高亮与
            中英文组合，动作区是 `.chat-composer-actions`。抽屉是另一条对话，输入框不该
            长出第二种样子（裸 textarea 既没有终端光标，也不显示选区）。 */}
        <ComposerImageStrip text={draft} onPreview={onPreviewImage} />
        <div className="chat-composer chat-btw-composer">
          {/* 行首标记：与主输入条同一个位置和字号（只是这里不可点，没有角色可切） */}
          <span className="chat-prompt-mark" aria-hidden="true">
            <span className="chat-prompt-caret">›</span>
          </span>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.target.files || [])
              // 先取走 FileList 再清空，否则同一个文件不会二次触发 change
              event.target.value = ''
              void attachImages(files)
            }}
          />
          <TerminalComposer
            value={draft}
            textareaRef={inputRef}
            placeholder={running ? '正在回答上一个问题…' : '问点什么，Enter 发送'}
            onChange={(value) => onDraftChange?.(value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <div className="chat-composer-actions">
            <button
              type="button"
              title="上传图片"
              aria-label="上传图片"
              onClick={() => imageInputRef.current?.click()}
            >
              <IconPhoto size={13} />
            </button>
            <button
              type="button"
              className="chat-btw-send"
              title="发送（不影响主流程）"
              aria-label="发送 By The Way 问题"
              disabled={!String(draft || '').trim() || running || sending}
              onClick={submit}
            >
              {sending ? (
                <IconLoader2 size={13} className="animate-spin" />
              ) : (
                <IconSend size={13} />
              )}
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
