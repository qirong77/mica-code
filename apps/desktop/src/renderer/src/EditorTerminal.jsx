import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { IconPlus, IconTerminal2, IconX } from '@tabler/icons-react'
import { PANE_MICA, PANE_TERMINAL, TerminalHost, ptyIdFor } from './TerminalHost'
import { useUiStateValue } from './ui-state'
import {
  EDITOR_TERMINAL_KEY,
  activeTabAfterClose,
  clampEditorTerminalHeight,
  closeTabConfirmText,
  closeWindowConfirmText,
  createEditorTerminalTab,
  editorTerminalHeightLimit,
  isTerminalToggleShortcut,
  readEditorTerminalState,
  setEditorTerminalOpen,
  toggleEditorTerminalOpen,
  writeEditorTerminalState
} from './editor-terminal'

/**
 * 编辑器底部的终端面板（VS Code 那种）：Ctrl+` 呼出，拖顶边调高度，右键文件树「在终端中
 * 打开」直接落到那个目录。
 *
 * 终端本体不重新实现一套：复用对话底部终端的 `TerminalHost`（xterm、PTY 重建、回放、
 * 失败重试、文件链接、软键盘都在那里），一个标签页就是它的一个「节点」，PTY id 是
 * `<标签 id>:terminal`。于是两条路径的行为不会各长各的。
 *
 * 开关与高度存在界面状态里（见 `editor-terminal.js`），标签与 PTY 只属于当前页面：两个
 * 窗口各开各的 shell，关掉窗口（或页面被卸载）这些 shell 就该跟着结束。
 */

let namespaceSeq = 0

function nextNamespace() {
  namespaceSeq += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `editor-${random}-${namespaceSeq}`
}

function noop() {}

export const EditorTerminal = forwardRef(function EditorTerminal({ cwd, hidden = false }, ref) {
  const stored = useUiStateValue(EDITOR_TERMINAL_KEY, null)
  const open = stored?.open === true
  // 窗口变矮时面板跟着收：存的是像素高度，不重新夹一次就会把编辑器挤到没有。
  const [viewport, setViewport] = useState(() => window.innerHeight)
  const storedHeight = clampEditorTerminalHeight(stored?.height, viewport)

  const [tabs, setTabs] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [resizing, setResizing] = useState(false)
  const [dragHeight, setDragHeight] = useState(null)
  const terminalRef = useRef(null)
  const tabsRef = useRef(tabs)
  const cwdRef = useRef(cwd)
  const seqRef = useRef(0)
  const namespaceRef = useRef(null)
  if (!namespaceRef.current) namespaceRef.current = nextNamespace()

  useEffect(() => {
    const onResize = () => setViewport(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 面板收起时 `hidden` 仍然为真：PTY 不重建、滚动缓冲也留着，只是不显示、快捷键也交回去。
  const shown = open && !hidden
  cwdRef.current = cwd

  const commitTabs = useCallback((next) => {
    tabsRef.current = next
    setTabs(next)
  }, [])

  const addTab = useCallback(
    (dir) => {
      const tab = createEditorTerminalTab({
        id: `${namespaceRef.current}-${(seqRef.current += 1)}`,
        cwd: dir || cwdRef.current || null,
        tabs: tabsRef.current
      })
      commitTabs([...tabsRef.current, tab])
      setActiveId(tab.id)
      return tab
    },
    [commitTabs]
  )

  /** 在某个目录开一个终端：右键「在终端中打开」与顶栏按钮都走这里。 */
  const openAt = useCallback(
    (dir) => {
      addTab(dir)
      if (!readEditorTerminalState().open) setEditorTerminalOpen(true)
    },
    [addTab]
  )

  const toggle = useCallback(() => {
    toggleEditorTerminalOpen()
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      openAt,
      toggle,
      isOpen: () => readEditorTerminalState().open
    }),
    [openAt, toggle]
  )

  // 面板还没被任何标签用过就又打开：补一个默认目录的标签，不让它空着像坏了。
  useEffect(() => {
    if (open && !hidden && tabs.length === 0) addTab(cwdRef.current)
  }, [addTab, hidden, open, tabs.length])

  useEffect(() => {
    if (hidden) return undefined
    const onKeyDown = (event) => {
      if (!isTerminalToggleShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [hidden, toggle])

  /** 这个终端此刻在前台跑什么；拿不到（PTY 已退出、宿主不支持）就当没在跑。 */
  const runningEntries = useCallback(async (list) => {
    const checks = await Promise.all(
      (list || []).map(async (tab) => {
        try {
          const info = await window.mica.terminal.foreground(ptyIdFor(tab.id, PANE_TERMINAL))
          return info?.running
            ? { id: tab.id, title: tab.title, command: info.command || '' }
            : null
        } catch {
          return null
        }
      })
    )
    return checks.filter(Boolean)
  }, [])

  const disposeTabs = useCallback(async (list) => {
    for (const tab of list || []) {
      for (const ptyId of [ptyIdFor(tab.id, PANE_TERMINAL), ptyIdFor(tab.id, PANE_MICA)]) {
        try {
          await window.mica.terminal.dispose(ptyId)
        } catch (error) {
          console.error('dispose editor terminal failed', error)
        }
      }
    }
  }, [])

  const closeTab = useCallback(
    async (tabId) => {
      const list = tabsRef.current
      const tab = list.find((item) => item.id === tabId)
      if (!tab) return
      const running = await runningEntries([tab])
      if (running.length && !window.confirm(closeTabConfirmText(running[0]))) return
      await disposeTabs([tab])
      const rest = tabsRef.current.filter((item) => item.id !== tabId)
      commitTabs(rest)
      if (activeId === tabId) {
        const next = activeTabAfterClose(list, tabId)
        setActiveId(next)
        if (!next) setEditorTerminalOpen(false)
      }
    },
    [activeId, commitTabs, disposeTabs, runningEntries]
  )

  // 关这个窗口之前，外壳会问一句（见 main/index.js）：有程序在跑就二次确认，确认后先把
  // shell 收掉——PTY 活在运行时里，页面没了它不会自己结束。
  useEffect(() => {
    const handler = async () => {
      const list = tabsRef.current
      if (!list.length) return true
      const running = await runningEntries(list)
      if (running.length && !window.confirm(closeWindowConfirmText(running))) return false
      commitTabs([])
      setActiveId(null)
      await disposeTabs(list)
      return true
    }
    window.__micaConfirmClose = handler
    return () => {
      if (window.__micaConfirmClose === handler) delete window.__micaConfirmClose
    }
  }, [commitTabs, disposeTabs, runningEntries])

  // 刷新 / 页面被换掉时 PTY 不该留在运行时里当孤儿（关窗口那条路已经收过了，这里幂等）。
  useEffect(() => {
    const onPageHide = () => {
      const list = tabsRef.current
      if (!list.length) return
      commitTabs([])
      setActiveId(null)
      void disposeTabs(list)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      onPageHide()
    }
  }, [commitTabs, disposeTabs])

  const startResize = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = clampEditorTerminalHeight(readEditorTerminalState().height)
    let next = startHeight
    const onMove = (moveEvent) => {
      next = clampEditorTerminalHeight(
        startHeight + (startY - moveEvent.clientY),
        editorTerminalHeightLimit()
      )
      setDragHeight(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('is-resizing-terminal')
      setResizing(false)
      setDragHeight(null)
      writeEditorTerminalState({ height: next })
    }
    setResizing(true)
    document.body.classList.add('is-resizing-terminal')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  const resolveCwd = useCallback(
    (tabId) => tabsRef.current.find((tab) => tab.id === tabId)?.cwd || cwdRef.current || null,
    []
  )

  // TerminalHost 只认节点 id 列表；标签就是它的节点。
  const nodes = useMemo(() => tabs.map((tab) => ({ id: tab.id })), [tabs])

  return (
    <section
      aria-label="编辑器终端"
      className={`relative flex shrink-0 flex-col overflow-hidden bg-panel ${shown ? '' : 'hidden'}`}
      style={{ height: dragHeight ?? storedHeight }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整编辑器终端高度"
        title="拖动调整终端高度"
        data-resizing={resizing}
        className="terminal-panel-resizer shrink-0"
        onPointerDown={startResize}
      />
      <div className="no-drag flex h-8 shrink-0 items-center gap-0.5 border-b border-line pl-1 pr-3">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const active = tab.id === activeId
            return (
              <div
                key={tab.id}
                className={`group flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
                  active
                    ? 'bg-active text-fg-max'
                    : 'text-fg-soft hover:bg-overlay hover:text-fg-max'
                }`}
              >
                <button
                  type="button"
                  title={tab.cwd || tab.title}
                  className="flex min-w-0 items-center gap-1.5"
                  onClick={() => setActiveId(tab.id)}
                >
                  <IconTerminal2 size={12} className="shrink-0 opacity-75" />
                  <span className="max-w-36 truncate">{tab.title}</span>
                </button>
                <button
                  type="button"
                  title="关闭终端"
                  aria-label={`关闭 ${tab.title}`}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded text-fg-muted opacity-0 transition-opacity hover:bg-overlay-strong hover:text-fg-max group-hover:opacity-100"
                  onClick={() => void closeTab(tab.id)}
                >
                  <IconX size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          title="新建终端"
          aria-label="新建终端"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-soft transition-colors hover:bg-overlay hover:text-fg-max"
          onClick={() => addTab(cwdRef.current)}
        >
          <IconPlus size={14} />
        </button>
        <button
          type="button"
          title="收起终端 (Ctrl+`)"
          aria-label="收起终端"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-soft transition-colors hover:bg-overlay hover:text-fg-max"
          onClick={() => setEditorTerminalOpen(false)}
        >
          <IconX size={13} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <TerminalHost
          ref={terminalRef}
          nodes={nodes}
          activeId={activeId}
          visible={shown}
          pane={PANE_TERMINAL}
          docked={false}
          sidebarCollapsed={false}
          resolveCwd={resolveCwd}
          onRead={noop}
        />
      </div>
    </section>
  )
})
