import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconAlertCircle,
  IconBolt,
  IconCopy,
  IconLoader2,
  IconMessageChatbot,
  IconMessagePlus,
  IconPhoto,
  IconPlus,
  IconQuote,
  IconRefresh,
  IconSend,
  IconSquare,
  IconTrash,
  IconX
} from '@tabler/icons-react'
import { ComposerImageStrip } from './composer-images'
import { pasteIntoComposer } from './composer-paste'
import { formatLogElapsed } from './chat-tool-display'
import { isModalOpen } from './chat-modal'
import { ReasoningRow, ToolActivityRow } from './chat-tool-views'
import { ToolDetailDialog } from './chat-tool-detail'
import {
  btwContextMenuItems,
  btwContextLabel,
  btwContextTitle,
  btwEntryElapsedMs,
  btwEntryRetryable,
  btwHistoryStep,
  btwPhaseText,
  btwRunningEntry
} from './btw-thread'
import { FloatingMenu, MenuItem, MenuSeparator } from './FloatingMenu'
import { longPressHandlers, useLatest } from './hooks'
import { copyText } from './transport'
import TerminalComposer from './TerminalComposer'

/** 抽屉宽度的上下限：太窄塞不下一行代码，太宽会把主对话挤成一条缝。 */
export const BTW_MIN_WIDTH = 320
export const BTW_MAX_WIDTH = 900

/** 菜单项 id → 图标。判定（哪些项、什么时候禁用）全在 `btwContextMenuItems`。 */
const BTW_MENU_ICONS = {
  copy: IconCopy,
  quote: IconQuote,
  'new-thread': IconMessagePlus,
  compact: IconBolt,
  'close-thread': IconTrash
}

function BtwContextMenu({
  menu,
  entry,
  running,
  compacting,
  hasEntries,
  canQuote,
  canClose,
  onAction,
  onClose
}) {
  const items = btwContextMenuItems({
    entry,
    running,
    compacting,
    hasEntries,
    hasSelection: Boolean(menu.selection),
    canQuote,
    canClose
  }).filter((item, index, all) => !item.separator || (index > 0 && index < all.length - 1))
  return (
    <FloatingMenu x={menu.x} y={menu.y} minWidth={220} onClose={onClose}>
      {items.map((item, index) =>
        item.separator ? (
          <MenuSeparator key={`separator-${index}`} />
        ) : (
          <MenuItem
            key={item.id}
            icon={BTW_MENU_ICONS[item.id] || IconMessageChatbot}
            label={item.label}
            title={item.title}
            danger={item.danger}
            disabled={item.disabled}
            onClick={() => onAction(item.id)}
          />
        )
      )}
    </FloatingMenu>
  )
}

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
  tabs = [],
  width = null,
  onResizeWidth,
  draft = '',
  sending = false,
  compacting = false,
  onDraftChange,
  onAsk,
  onStop,
  onRecall,
  onNewThread,
  onSelectThread,
  onCloseThread,
  onCompact,
  onQuoteToMain,
  renderAnswer,
  renderQuestion,
  onPreviewImage,
  onOpenDocument,
  onNotice,
  onClose
}) {
  const bodyRef = useRef(null)
  const inputRef = useRef(null)
  const imageInputRef = useRef(null)
  const asideRef = useRef(null)
  const draftRef = useLatest(draft)
  const entries = Array.isArray(thread?.entries) ? thread.entries : []
  /** tab 标题：这条线程第一个问题（没有就「新线程」），与侧栏会话行的取法一致。 */
  const tabTitle = (item) => {
    const first = Array.isArray(item?.entries) ? item.entries[0]?.question : ''
    const text = String(first || '')
      .replace(/\s+/g, ' ')
      .trim()
    return text ? (text.length > 14 ? `${text.slice(0, 14)}…` : text) : '新线程'
  }
  const runningEntry = btwRunningEntry(entries)
  const running = Boolean(runningEntry)
  const [threadId, setThreadId] = useState(thread?.id || '')
  const [now, setNow] = useState(() => Date.now())
  // 输入历史：Alt+↑ 往回翻这条线程问过的问题（与主输入条同一个键位），
  // `stash` 是进入历史前那半句话——翻回底部要能拿回来。
  const historyRef = useRef({ index: -1, stash: '' })
  const questionHistory = entries.map((entry) => entry.question).filter(Boolean)
  // 点开的工具详情：只存「哪一条 entry 的哪个工具」，host 每 80ms 换一份快照，
  // 存对象会停在点开那一刻。
  const [activityDetail, setActivityDetail] = useState(null)
  const activityOwner = activityDetail
    ? entries.find((item) => item.id === activityDetail.entryId) || null
    : null
  const activityTool = activityDetail?.toolId
    ? activityOwner?.tools?.find((tool) => tool.id === activityDetail.toolId) || null
    : null

  /**
   * 拖动左边缘改宽度。
   *
   * 拖动期间只改 CSS 变量（不 setState）：每移动一像素都重渲染整条线程会让正文和
   * 输入框一起卡住，而宽度只是布局。松手才提交一次（写进共享界面状态，所有窗口一致）。
   */
  const startResize = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = asideRef.current?.offsetWidth || 400
    let next = startWidth
    const aside = asideRef.current
    // 宽度变量写在**两者**上：抽屉自己读它取宽，父级 `.chat-view` 读它让出右侧内边距
    // （CSS 变量会继承，拖完之后只由父级上一份即可，但拖动期间要立即生效就都得写）。
    const host = aside?.parentElement
    const applyWidth = (value) => {
      const css = `${value}px`
      aside?.style.setProperty('--chat-btw-width', css)
      host?.style.setProperty('--chat-btw-width', css)
    }
    const onMove = (moveEvent) => {
      // 向右拖是变窄（抽屉贴在右侧，左边是它的边）
      // 上限还受视口约束：拖到 900px 后把窗口缩窄，抽屉会盖住整块对话区。
      const limit = Math.min(BTW_MAX_WIDTH, Math.round((window.innerWidth || 1200) * 0.85))
      next = Math.round(
        Math.min(limit, Math.max(BTW_MIN_WIDTH, startWidth + (startX - moveEvent.clientX)))
      )
      applyWidth(next)
      document.body.classList.add('is-resizing-btw')
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-btw')
      if (next !== startWidth) onResizeWidth?.(next)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  // 读者是否还贴着底部。上翻看已经读过的答案时不该被流式的正文拽回来（与对话区同一手感）。
  const stickToBottomRef = useRef(true)

  /**
   * 右键菜单。
   *
   * 抽屉**不**沿用主对话那份会话菜单（压缩会话/Commit/Fork/分享/Clear）：btw 是一次
   * 独立运行，在它的正文上点「Clear」会把主会话清掉。这里只做这条线程自己的事，
   * 而且都是「拿起这段字」的动作——旁问一句、把结论带回主流程正是它的用途。
   *
   * 选区在**打开菜单那一刻**取：点菜单项时焦点已经离开正文，`getSelection()` 会是空的。
   */
  const [menu, setMenu] = useState(null)
  const openMenu = (event, entry) => {
    // 必须停在这里：`.chat-view` 上挂着主对话的会话菜单（preventDefault + 弹窗），
    // 冒泡上去就会在抽屉里弹出「Clear 会话」。
    event.preventDefault()
    event.stopPropagation()
    const selection = String(window.getSelection?.()?.toString?.() || '').trim()
    setMenu({ x: event.clientX, y: event.clientY, entryId: entry?.id || '', selection })
  }
  const closeMenu = useCallback(() => setMenu(null), [])
  const runMenuAction = (id) => {
    const entry = entries.find((item) => item.id === menu?.entryId) || null
    const text = String(entry?.answer || entry?.question || '').trim()
    setMenu(null)
    if (id === 'copy') {
      void copyText(menu?.selection || text).then((ok) => {
        if (!ok) onNotice?.('复制失败：浏览器拒绝了剪贴板写入', 'error')
      })
      return
    }
    if (id === 'quote') {
      onQuoteToMain?.(text)
      return
    }
    if (id === 'new-thread') onNewThread?.()
    if (id === 'compact') onCompact?.()
    if (id === 'close-thread') onCloseThread?.(thread?.id)
  }

  // 打开抽屉就把光标放进输入框：这个抽屉存在的意义就是「问一句」，而点开的动作落在
  // 触发按钮上（`focusComposerFromShell` 不抢按钮的焦点），不主动聚焦就没处可打字。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 新话题（或 host 换了一条线程）后把光标放回输入框：这里正是要继续打字的地方。
  useEffect(() => {
    if (!thread?.id || thread.id === threadId) return
    setThreadId(thread.id)
    historyRef.current = { index: -1, stash: '' }
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
      if (event.key !== 'Escape') return
      // 抽屉里打开的详情弹窗先接管 Esc（它自己监听在栈顶），这里让位
      if (isModalOpen()) return
      closeRef.current?.()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [closeRef])

  const submit = () => {
    const text = String(draft || '').trim()
    if (!text || sending) return
    historyRef.current = { index: -1, stash: '' }
    // 回答期间提交 = 排队（单槽位，答完自动接上），与主对话的 after_iteration 同一心智：
    // 用户不必盯着等它说完再问下一句。
    onAsk?.(text, { queue: running })
  }

  /**
   * Alt+↑ / Alt+↓ 翻这条线程问过的问题。
   *
   * 只在本线程的历史里翻（不跨 tab）：每个 tab 是一个独立话题，把别的 tab 的问题
   * 翻出来再发一遍只会让人分不清自己在哪条线程上。
   */
  const moveHistory = (direction) => {
    const step = btwHistoryStep({
      index: historyRef.current.index,
      count: questionHistory.length,
      direction
    })
    if (!step) return
    const state = historyRef.current
    // 第一步进入历史时记住当前草稿（不论是翻到哪一条）；翻回 -1 时还给它。
    if (state.index === -1) state.stash = draftRef.current || ''
    state.index = step.index
    const next =
      step.index === -1
        ? state.stash
        : questionHistory[questionHistory.length - 1 - step.index] || ''
    onDraftChange?.(next)
    requestAnimationFrame(() => {
      const node = inputRef.current
      if (!node) return
      node.setSelectionRange(next.length, next.length)
      node.focus()
    })
  }

  // 标题行右侧：回答中就报阶段与耗时（「正在调用 grep_search… 12.4s」），否则说明这条
  // 线程的边界（回答不进本会话上下文）。
  const statusText = runningEntry
    ? `${btwPhaseText(runningEntry)} ${formatLogElapsed(btwEntryElapsedMs(runningEntry, now))}`
    : '不进入本会话上下文'
  const contextLabel = btwContextLabel(thread?.context)
  const contextTitle = btwContextTitle(thread?.context)

  return (
    // data-no-chat-focus：点抽屉里的空白处不该把焦点抢到主输入条（那会打断选中答案文本）。
    <aside
      className="chat-btw no-drag"
      data-no-chat-focus
      aria-label="By The Way"
      ref={asideRef}
      style={width ? { '--chat-btw-width': `${width}px` } : undefined}
      // 空白处右键也要在这里收住（否则冒到 `.chat-view` 上弹的是会话菜单）。
      onContextMenu={(event) => openMenu(event, null)}
      {...longPressHandlers((event) => openMenu(event, null))}
    >
      {/* 左边缘的宽度手柄：与终端面板 / 输入框那两个手柄同一套（绝对定位，不占布局）。 */}
      <button
        type="button"
        className="chat-btw-resizer"
        aria-label="拖动调整 By The Way 宽度"
        title="拖动调整宽度"
        onPointerDown={startResize}
      />
      <header className="chat-btw-head">
        {/* 图标与输入条上那个触发按钮同一个：抽屉和它的入口要一眼对得上 */}
        <span className="chat-btw-mark" aria-hidden="true">
          <IconMessageChatbot size={13} />
        </span>
        <span className="chat-btw-title">By The Way</span>
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
          <IconX size={14} />
        </button>
      </header>
      {/* tab 条：一个 tab 就是 host 里的一条独立线程（自己的子代理与上下文）。
          可以并排问几件不相干的事，这也是「新话题」在桌面端的样子。 */}
      <div className="chat-btw-tabs" role="tablist" aria-label="By The Way 线程">
        {(Array.isArray(tabs) ? tabs : []).map((tab) => {
          const tabRunning = btwRunningEntry(tab.entries)
          return (
            <div
              key={tab.id}
              className={`chat-btw-tab${tab.id === thread?.id ? ' is-active' : ''}`}
              role="tab"
              aria-selected={tab.id === thread?.id}
            >
              <button
                type="button"
                className="chat-btw-tab-label"
                title={tabTitle(tab)}
                onClick={() => onSelectThread?.(tab.id)}
              >
                {tabRunning ? <span className="chat-btw-live" aria-hidden="true" /> : null}
                {tabTitle(tab)}
              </button>
              <button
                type="button"
                className="chat-btw-tab-close"
                aria-label="关闭这个线程"
                title={tabRunning ? '正在回答中，答完才能关' : '关闭这个线程'}
                disabled={Boolean(tabRunning)}
                onClick={() => onCloseThread?.(tab.id)}
              >
                <IconX size={10} />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="chat-btw-tab-add"
          aria-label="新建线程"
          title="新建一条线程（另一个话题，上下文互不影响）"
          onClick={() => onNewThread?.()}
        >
          <IconPlus size={11} />
        </button>
      </div>
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
                  <div
                    className="chat-message-body"
                    onContextMenu={(event) => openMenu(event, entry)}
                    {...longPressHandlers((event) => openMenu(event, entry))}
                  >
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
                  <div
                    className="chat-message-body"
                    onContextMenu={(event) => openMenu(event, entry)}
                    {...longPressHandlers((event) => openMenu(event, entry))}
                  >
                    {/* 思考与工具行：与主对话的回合日志同一套组件与样式（btw 也是个运行实例） */}
                    {entry.thinking || entry.tools?.length ? (
                      <div className="chat-btw-activity">
                        <ReasoningRow text={entry.thinking} />
                        {(entry.tools || []).map((tool) => (
                          <ToolActivityRow
                            key={tool.id}
                            tool={tool}
                            now={now}
                            onOpen={() => setActivityDetail({ entryId: entry.id, toolId: tool.id })}
                          />
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
                    {/* 失败或被停止：原问题就在手边，重问一次比重新打一遍顺手 */}
                    {btwEntryRetryable(entry) && onAsk ? (
                      <button
                        type="button"
                        className="chat-btw-retry"
                        title="用同一个问题再问一次"
                        onClick={() => onAsk(entry.question, { queue: running })}
                      >
                        <IconRefresh size={11} />
                        重试
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* 这条线程自己的模型与上下文占用（+ 本地快速压缩）：btw 是一次独立运行，
          主状态栏那份与它无关。放在输入条上方——和主对话「状态行贴着输入条」同一位置。 */}
      <div className="chat-btw-status">
        <span className="chat-btw-context" title={contextTitle}>
          {contextLabel || '上下文计入这条线程，不占用主对话'}
        </span>
        {onCompact ? (
          <button
            type="button"
            className="chat-btw-compact"
            title="快速压缩这条线程的上下文（本地，不调用模型、不丢轮次）"
            disabled={running || compacting || entries.length === 0}
            onClick={() => onCompact()}
          >
            {compacting ? <IconLoader2 size={10} className="animate-spin" /> : null}
            快速压缩
          </button>
        ) : null}
      </div>
      <div className="chat-btw-foot">
        {/* 输入条与主对话**同一套实现**：`TerminalComposer` 负责自绘光标、选区高亮与
            中英文组合，动作区是 `.chat-composer-actions`。抽屉是另一条对话，输入框不该
            长出第二种样子（裸 textarea 既没有终端光标，也不显示选区）。 */}
        <ComposerImageStrip text={draft} onPreview={onPreviewImage} />
        {/* 排队中的那一问：单槽位（与主对话的 message-queue 同款），答完自动接上；
            这里的 ✕ 就是撤回，撤回后问题回到输入框，不丢字。 */}
        {thread?.pendingQuestion ? (
          <div className="chat-btw-queued" title="这一条会在当前回答结束后自动发出">
            <span className="chat-btw-queued-mark" aria-hidden="true">
              ⏳
            </span>
            <span className="chat-btw-queued-text">{thread.pendingQuestion}</span>
            <button
              type="button"
              className="chat-btw-queued-recall"
              title="撤回这条排队的问题"
              aria-label="撤回排队的问题"
              onClick={() => onRecall?.()}
            >
              <IconX size={11} />
            </button>
          </div>
        ) : null}
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
            placeholder={
              running ? '正在回答，Enter 排队下一个问题 · 可点右侧停止' : '问点什么，Enter 发送'
            }
            onChange={(value) => onDraftChange?.(value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                event.preventDefault()
                moveHistory(event.key === 'ArrowUp' ? 1 : -1)
                return
              }
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
              className={`chat-btw-send${running ? ' is-stop' : ''}`}
              title={running ? '停止回答' : '发送（不影响主流程）'}
              aria-label={running ? '停止 By The Way 回答' : '发送 By The Way 问题'}
              onClick={running ? () => onStop?.() : submit}
              disabled={running ? false : !String(draft || '').trim() || sending}
            >
              {running ? (
                <IconSquare size={12} />
              ) : sending ? (
                <IconLoader2 size={13} className="animate-spin" />
              ) : (
                <IconSend size={13} />
              )}
            </button>
          </div>
        </div>
      </div>
      {/* 菜单挂到 body 上：抽屉自己是 `overflow: hidden` + 入场动画（transform），
          留在里面既可能被裁掉、也可能跟着 transform 偏移。坐标是视口的，所以 portal 最稳。 */}
      {menu
        ? createPortal(
            <BtwContextMenu
              menu={menu}
              entry={entries.find((item) => item.id === menu.entryId) || null}
              running={running}
              compacting={compacting}
              hasEntries={entries.length > 0}
              canQuote={Boolean(onQuoteToMain)}
              canClose={Boolean(onCloseThread) && Boolean(thread?.id)}
              onAction={runMenuAction}
              onClose={closeMenu}
            />,
            document.body
          )
        : null}
      {activityTool ? (
        <ToolDetailDialog
          tool={activityTool}
          onOpenInEditor={onOpenDocument}
          onClose={() => setActivityDetail(null)}
        />
      ) : null}
    </aside>
  )
}
