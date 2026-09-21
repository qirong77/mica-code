import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  IconArrowUp,
  IconChartBar,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconMenu2,
  IconMessage,
  IconPlus,
  IconRocket,
  IconServer,
  IconSettings,
  IconTerminal2,
  IconX
} from '@tabler/icons-react'
import { BranchPicker } from './BranchPicker'
import { ChatView, shortPath } from './ChatView'
import { ServerCard, ServerCardPopover } from './ServerCard'
import { SessionTree } from './SessionTree'
import TerminalKeyBar from './TerminalKeyBar'
import { currentServerUrl, openServerTarget, serverLabel } from './servers'

// 启动必需的三块留在入口：侧栏（会话列表）、对话视图、分支选择。
// 其余视图各自带着自己的重依赖（FilesView→monaco、TerminalHost→xterm），
// 按需加载才能让首屏不必先解析它们 —— 见下方 lazyViews 的说明。
const { FilesView, QuickSearch, SettingsView, StatsView, TerminalHost } = {
  FilesView: lazy(() => import('./FilesView').then((m) => ({ default: m.FilesView }))),
  QuickSearch: lazy(() => import('./QuickSearch').then((m) => ({ default: m.QuickSearch }))),
  SettingsView: lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView }))),
  StatsView: lazy(() => import('./stats/StatsView').then((m) => ({ default: m.StatsView }))),
  TerminalHost: lazy(() => import('./TerminalHost').then((m) => ({ default: m.TerminalHost })))
}
import { useIsMobile, useLatest, useVisualViewportHeight } from './hooks'
import { resolveGroupCwd } from './session-projects'
import {
  RIGHT_PANEL_SWEEP_MS,
  activeRightTermId,
  reclaimableRightTermIds,
  staleRightTermIds
} from './right-terms'
import {
  createColdStartTerminal,
  normalizeNodes,
  removeNode,
  resolveDefaultCwd,
  uid
} from './workspace'
import { draftMarkers, runningTerminalSessions } from './session-state'
import {
  claimUiStateEcho,
  setUiState,
  setUiStateEntries,
  subscribeUiState,
  uiStateKeys,
  useUiStateValue
} from './ui-state'

/** notify 事件里的 terminalId 是 `<节点id>:<pane>`，转回树节点 id */
function nodeIdFor(ptyId) {
  if (typeof ptyId !== 'string') return ptyId
  const index = ptyId.lastIndexOf(':')
  return index > 0 ? ptyId.slice(0, index) : ptyId
}

function ptyIdForNode(nodeId) {
  return `${nodeId}:mica`
}

function recentChatCwd() {
  const value = uiStateKeys().chatDefaultCwd
  return typeof value === 'string' ? value : ''
}

function CwdModal({ cwd, invalid, recent, onClose, onApply }) {
  const [value, setValue] = useState(cwd || '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const dirs = recent.length > 0 ? recent : [cwd].filter(Boolean)
  const submit = () => {
    const next = value.trim()
    if (next) onApply(next)
  }
  return (
    <div
      className="fixed inset-0 z-[11000] grid place-items-center bg-black/45 no-drag"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        className="w-[min(440px,calc(100vw-32px))] rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl"
      >
        <h2 className="mb-2.5 text-sm font-semibold text-white/95">工作目录</h2>
        {invalid && (
          <div className="mb-2.5 rounded-sm border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs leading-relaxed text-red-300">
            当前目录不存在或已被移动，请选择正确的项目目录后再压缩。
          </div>
        )}
        <button
          type="button"
          className="mb-2.5 flex h-8 w-full items-center justify-center gap-2 rounded-sm border border-dashed border-white/15 bg-white/[.02] text-xs text-white/60 hover:border-white/35 hover:text-white"
          onClick={() => {
            // 浏览器里没有原生目录选择器，改用应用内浏览（浏览的是服务端目录）
            if (window.mica?.isWeb) {
              setPickerOpen(true)
              return
            }
            void window.mica.workspace
              .selectDirectory({ title: '选择工作目录', defaultPath: cwd })
              .then((result) => {
                if (result && !result.canceled && result.path) onApply(result.path)
              })
          }}
        >
          <IconFolderOpen size={13} />
          选择文件夹…
        </button>
        {dirs.length > 0 && (
          <div className="mb-2.5 max-h-52 overflow-y-auto">
            <div className="mb-1 text-[10px] text-white/35">最近目录</div>
            {dirs.map((dir) => (
              <button
                key={dir}
                type="button"
                title={dir}
                className={`flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs ${
                  dir === cwd
                    ? 'text-white/85'
                    : 'text-white/45 hover:bg-white/[.05] hover:text-white/80'
                }`}
                onClick={() => onApply(dir)}
              >
                <span className="w-3 text-center text-[10px] text-green-400/80">
                  {dir === cwd ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1 truncate">{shortPath(dir, 70)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={value}
            spellCheck={false}
            placeholder="输入完整路径，如 /Users/name/project"
            className="h-8 min-w-0 flex-1 rounded-sm border border-white/15 bg-white/[.04] px-2.5 text-xs text-white focus:border-white/30"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button
            type="button"
            disabled={!value.trim()}
            className="h-8 rounded-sm bg-white/10 px-3.5 text-xs text-white/85 hover:bg-white/15 disabled:text-white/25"
            onClick={submit}
          >
            应用
          </button>
        </div>
      </section>
      {pickerOpen && (
        <DirectoryPicker
          initialPath={value.trim() || cwd}
          onClose={() => setPickerOpen(false)}
          onPick={(dir) => {
            setPickerOpen(false)
            onApply(dir)
          }}
        />
      )}
    </div>
  )
}

/** 浏览器端的工作目录选择器：在服务端目录树里逐级浏览，替代 Electron 的原生选择器 */
function DirectoryPicker({ initialPath, onClose, onPick }) {
  const [current, setCurrent] = useState('')
  const [parent, setParent] = useState(null)
  const [entries, setEntries] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (target) => {
    setLoading(true)
    setError('')
    try {
      const result = await window.mica.files.list(target || window.mica.homeDir)
      setCurrent(result?.path || target)
      setParent(result?.parentPath || null)
      setEntries((result?.entries || []).filter((entry) => entry.type === 'directory'))
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(initialPath)
  }, [initialPath, load])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[12000] grid place-items-center bg-black/55 no-drag"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        className="flex h-[min(520px,80vh)] w-[min(520px,calc(100vw-24px))] flex-col overflow-hidden rounded-md border border-line bg-panel/98 shadow-2xl"
      >
        <h2 className="shrink-0 border-b border-line px-3.5 py-2.5 text-sm font-semibold text-white/95">
          选择文件夹
        </h2>
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-line px-3.5 py-2">
          <button
            type="button"
            title="上级目录"
            aria-label="上级目录"
            disabled={!parent}
            className="grid size-6 shrink-0 place-items-center rounded-md text-white/60 hover:bg-white/[.08] hover:text-white disabled:opacity-30"
            onClick={() => void load(parent)}
          >
            <IconArrowUp size={14} />
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-white/55" title={current}>
            {current || '…'}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {error ? (
            <p className="px-2 py-1.5 text-xs leading-5 text-red-300">{error}</p>
          ) : loading ? (
            <p className="px-2 py-1.5 text-xs text-white/40">读取中…</p>
          ) : entries.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-white/35">没有子目录</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                className="flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-white/70 hover:bg-white/[.06] hover:text-white"
                onClick={() => void load(entry.path)}
              >
                <IconFolder size={14} className="shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3.5 py-2.5">
          <button
            type="button"
            disabled={!current}
            className="h-9 flex-1 rounded-sm bg-white/10 px-3.5 text-xs text-white/85 hover:bg-white/15 disabled:text-white/25"
            onClick={() => current && onPick(current)}
          >
            选择此文件夹
          </button>
          <button
            type="button"
            className="h-9 rounded-sm border border-white/15 px-3.5 text-xs text-white/70 hover:bg-white/[.06] hover:text-white"
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </section>
    </div>
  )
}

function TextPrompt({ prompt, onClose }) {
  const [value, setValue] = useState(prompt.initial)
  const inputRef = useRef(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const submit = () => onClose(value.trim())
  return (
    <div
      className="fixed inset-0 z-[11000] grid place-items-center bg-black/45 backdrop-blur-[4px] no-drag"
      onClick={(event) => event.target === event.currentTarget && onClose(null)}
    >
      <section
        role="dialog"
        aria-modal="true"
        className="w-[min(420px,calc(100vw-32px))] rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl"
      >
        <h2 className="mb-1.5 text-sm font-semibold text-white/95">{prompt.title}</h2>
        {prompt.hint && <p className="mb-3 text-xs leading-5 text-white/45">{prompt.hint}</p>}
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          className="mb-3 h-8 w-full rounded-sm border border-white/15 bg-white/[.04] px-2.5 text-[13px] text-white focus:border-white/30"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'w') {
              event.preventDefault()
              onClose(null)
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose(null)
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="h-7 min-w-16 rounded-sm px-3 text-xs text-white/65 hover:bg-white/[.06] hover:text-white"
            onClick={() => onClose(null)}
          >
            取消
          </button>
          <button
            type="button"
            className="h-7 min-w-16 rounded-sm border border-line bg-white/[.06] px-3 text-xs text-white hover:bg-white/10"
            onClick={submit}
          >
            确定
          </button>
        </div>
      </section>
    </div>
  )
}

function useNotifications(activeId, onSessionId, canBindSessionId) {
  const [states, setStates] = useState({})
  const statesRef = useLatest(states)
  const activeRef = useLatest(activeId)
  const sessionRef = useLatest(onSessionId)
  const canBindRef = useLatest(canBindSessionId)
  const windowState = useRef({ focused: true, visible: true })
  const readTimer = useRef(null)
  const audio = useRef(null)

  const setTerminalState = useCallback(
    (id, state) => {
      if (!id) return
      setStates((current) => {
        const next = { ...current }
        if (!state || (!state.unread && !state.running)) delete next[id]
        else
          next[id] = {
            unread: !!state.unread,
            running: !!state.running,
            // 会话树据此区分「终端前台进程在跑」与「Mica turn 在跑」
            processRunning: !!state.processRunning,
            lastType: state.lastType ?? null,
            lastEventAt: state.lastEventAt ?? Date.now()
          }
        statesRef.current = next
        return next
      })
    },
    [statesRef]
  )

  const sync = useCallback(
    (list) => {
      const next = {}
      for (const item of list || []) {
        const id = item?.terminalId ? nodeIdFor(item.terminalId) : null
        if (id && (item.unread || item.running))
          next[id] = {
            unread: !!item.unread,
            running: !!item.running,
            processRunning: !!item.processRunning,
            lastType: item.lastType ?? null,
            lastEventAt: item.lastEventAt ?? null
          }
      }
      statesRef.current = next
      setStates(next)
    },
    [statesRef]
  )

  const readable = () =>
    windowState.current.visible &&
    windowState.current.focused &&
    document.visibilityState === 'visible'
  const markRead = useCallback(
    (id = activeRef.current, reason = 'view') => {
      if (!id || id !== activeRef.current || !readable() || !statesRef.current[id]?.unread) return
      const eventAt = statesRef.current[id].lastEventAt
      clearTimeout(readTimer.current)
      readTimer.current = window.setTimeout(() => {
        if (id !== activeRef.current || !readable() || !statesRef.current[id]?.unread) return
        window.mica.notify
          .markRead(ptyIdForNode(id))
          .then((state) => {
            if (!state) return
            setStates((current) => {
              if (current[id]?.lastEventAt !== eventAt) return current
              const next = { ...current }
              if (!state.unread && !state.running) delete next[id]
              else
                next[id] = {
                  unread: !!state.unread,
                  running: !!state.running,
                  lastType: state.lastType ?? null,
                  lastEventAt: state.lastEventAt ?? eventAt
                }
              statesRef.current = next
              return next
            })
          })
          .catch((error) => console.error('mark read failed', reason, error))
      }, 120)
    },
    [activeRef, statesRef]
  )

  const audioContext = () => {
    if (audio.current) return audio.current
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (AudioContext) audio.current = new AudioContext()
    return audio.current
  }
  const playCompleted = useCallback(async () => {
    const context = audioContext()
    if (!context) return
    if (context.state === 'suspended') await context.resume()
    if (context.state !== 'running') return
    const start = context.currentTime + 0.015
    for (const tone of [
      { frequency: 659.25, offset: 0, duration: 0.11, volume: 0.055 },
      { frequency: 880, offset: 0.1, duration: 0.16, volume: 0.06 }
    ]) {
      const from = start + tone.offset
      const to = from + tone.duration
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(tone.frequency, from)
      gain.gain.setValueAtTime(0.0001, from)
      gain.gain.exponentialRampToValueAtTime(tone.volume, from + 0.018)
      gain.gain.exponentialRampToValueAtTime(0.0001, to)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(from)
      oscillator.stop(to + 0.01)
    }
  }, [])

  useEffect(() => {
    const offNotify = window.mica.notify.onChanged((payload) => {
      if (payload?.type === 'cleared' && payload.terminalId) {
        setTerminalState(nodeIdFor(payload.terminalId), { unread: false })
      } else if (payload?.state?.terminalId) {
        const state = payload.state
        const nodeId = nodeIdFor(state.terminalId)
        setTerminalState(nodeId, state)
        if (state.sessionId) {
          // session.active 是 mica 启动时自动恢复会话，不主动给未关联的节点绑定，
          // 避免没点过的会话也显示为已打开；turn.* 事件代表用户真实对话，正常跟随。
          if (state.lastType !== 'session.active' || canBindRef.current?.(nodeId))
            sessionRef.current(nodeId, state.sessionId)
        }
        if (payload.type === 'event' && state.lastType === 'turn.completed') {
          playCompleted().catch((error) => console.warn('play notification sound failed', error))
        }
      } else if (Array.isArray(payload?.states)) {
        sync(payload.states)
        markRead(activeRef.current, 'notify-sync')
      }
    })
    const offWindow = window.mica.app.onWindowState((state) => {
      windowState.current = { focused: !!state?.focused, visible: !!state?.visible }
      markRead(activeRef.current, 'window-state')
    })
    window.mica.notify
      .list()
      .then(sync)
      .catch((error) => console.error('load notify states failed', error))
    window.mica.app
      .getWindowState()
      .then((state) => {
        if (state) windowState.current = state
      })
      .catch(() => {})

    const visibility = () => markRead(activeRef.current, 'visibility')
    const focus = () => {
      windowState.current = { ...windowState.current, focused: true }
      markRead(activeRef.current, 'window-focus')
    }
    const unlock = () => {
      const context = audioContext()
      if (context?.state === 'suspended') context.resume().catch(() => {})
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', focus)
    window.addEventListener('pointerdown', unlock, { once: true, capture: true })
    window.addEventListener('keydown', unlock, { once: true, capture: true })
    return () => {
      offNotify?.()
      offWindow?.()
      clearTimeout(readTimer.current)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('focus', focus)
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
  }, [activeRef, canBindRef, markRead, playCompleted, sessionRef, setTerminalState, sync])

  const activeState = states[activeId]
  useEffect(() => {
    if (activeState?.unread) markRead(activeId, 'activate')
  }, [activeId, activeState?.lastEventAt, activeState?.unread, markRead])
  return { states, markRead }
}

const DEFAULT_SIDEBAR_WIDTH = 260
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 640
const DEFAULT_RIGHT_PANEL_WIDTH = 400
const MIN_RIGHT_PANEL_WIDTH = 280
// 侧栏切换按钮：展开时贴侧栏右端（折叠线旁），收起的侧栏宽度为 0，按钮回到左上角固定位
// —— 86px 是 macOS 上让开交通灯后的位置，右侧面板标题栏的 pl-30 按它预留
const SIDEBAR_TOGGLE_COLLAPSED_LEFT = 86
const SIDEBAR_TOGGLE_GUTTER = 30
// 侧栏/右面板宽度写在根节点的 CSS 变量上：网格列宽、两侧栏宽度与侧栏切换按钮的定位都引用
// 它们，于是拖动分隔条时只要改写变量就够了，不必让 React 重渲染整个 App（见下面的拖拽处理）。
const SIDEBAR_WIDTH_VAR = '--mica-sidebar-width'
const RIGHT_PANEL_WIDTH_VAR = '--mica-right-panel-width'

function setLayoutVar(name, value) {
  document.documentElement.style.setProperty(name, value)
}

// 非对话视图（从左侧导航进入时）在右侧显示的标题栏信息
const PAGE_HEADER = {
  stats: { label: 'Stats', Icon: IconChartBar },
  settings: { label: 'Settings', Icon: IconSettings }
}

/**
 * 界面状态（面板布局、上次的工作目录）只有一份，放在运行时里：第二个窗口读到的是同一份，
 * 重启后也还在。这些读函数只在首次渲染取一次初值，之后的同步见下面的 layout 镜像 effect。
 */
function storedLayout() {
  const value = uiStateKeys().layout
  return value && typeof value === 'object' ? value : {}
}

function savedSidebarWidth() {
  const value = Number(storedLayout().sidebarWidth)
  return Number.isFinite(value) && value >= MIN_SIDEBAR_WIDTH && value <= MAX_SIDEBAR_WIDTH
    ? value
    : DEFAULT_SIDEBAR_WIDTH
}

function savedRightPanelWidth() {
  const value = Number(storedLayout().rightPanelWidth)
  return Number.isFinite(value) && value >= MIN_RIGHT_PANEL_WIDTH
    ? value
    : DEFAULT_RIGHT_PANEL_WIDTH
}

/**
 * 从取回的工作区里解析出界面要用的三个值。存下来的 activeId/selectedId 可能已经不在
 * nodes 里（另一个窗口关掉了那个页签），这两个位置全部回落到第一个页签。
 * 没有页签时返回 null，由调用方决定「开一个干净草稿」还是「什么都不做」。
 */
function resolveWorkspace(stored) {
  const nodes = stored ? normalizeNodes(stored.nodes) : []
  if (nodes.length === 0) return null
  const activeId = nodes.some((node) => node.id === stored.activeId) ? stored.activeId : nodes[0].id
  const selectedId = nodes.some((node) => node.id === stored.selectedId)
    ? stored.selectedId
    : activeId
  return { nodes, activeId, selectedId }
}

/** 首次运行（或工作区被清空）：开一个干净的草稿页签，沿用上次的工作目录。 */
function coldStartWorkspace(stored) {
  const target = createColdStartTerminal([], stored?.activeId)
  return { nodes: [target], activeId: target.id, selectedId: target.id }
}

/** 工作区写回运行时时的投影：只留界面需要的字段（PTY 进程本身不落盘）。 */
function workspaceSnapshot(nodes, activeId, selectedId) {
  return {
    version: 2,
    activeId: activeId || null,
    selectedId: selectedId || null,
    nodes: (nodes || []).map((node) => ({
      id: node.id,
      parent: node.parent,
      text: node.text,
      type: node.type,
      ...(node.cwd ? { cwd: node.cwd } : {}),
      ...(node.type === 'terminal' && node.sessionId ? { sessionId: node.sessionId } : {}),
      ...(node.type === 'terminal' && node.command ? { command: node.command } : {}),
      ...(node.type === 'terminal' && node.lastActiveAt ? { lastActiveAt: node.lastActiveAt } : {}),
      state: {
        opened: node.type === 'folder' && !!node.state.opened,
        selected: node.id === selectedId
      }
    }))
  }
}

// 右侧面板没有固定的最大宽度：拖到哪算哪，只按「窗口宽度 - 可见侧栏」封顶。三个网格列
// 都是硬宽度时，侧栏 + 面板一旦超过窗口宽，网格就整体溢出、面板右半截跑到屏幕外。
function rightPanelWidthLimit(viewport, sidebarWidth, sidebarCollapsed) {
  if (!Number.isFinite(viewport) || viewport <= 0) return Infinity
  const reserved = sidebarCollapsed ? 0 : sidebarWidth
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.round(viewport - reserved))
}

export default function App() {
  const terminalRef = useRef(null)
  const filesRef = useRef(null)
  const branchButtonRef = useRef(null)
  const contentRef = useRef(null)
  // 界面状态在渲染前已经从运行时取回（main.jsx 的 ensureUiState），所以第一帧就是上一次
  // 退出时的样子：直接用取回的工作区播种，不再有「先画空界面再加载」的过程。
  const [bootstrap] = useState(
    () => resolveWorkspace(uiStateKeys().workspace) || coldStartWorkspace(uiStateKeys().workspace)
  )
  const [nodes, setNodes] = useState(bootstrap.nodes)
  const nodesRef = useLatest(nodes)
  // 右侧面板终端区域的独立 shell 终端 Tab，按会话（左侧对话节点 id）分组归属：
  // 切换会话时整组跟着切走，PTY 的 cwd 也跟随所属会话的路径。
  const [rightTermsByChat, setRightTermsByChat] = useState({})
  const rightTermsByChatRef = useLatest(rightTermsByChat)
  const [rightActiveTermByChat, setRightActiveTermByChat] = useState({})
  // 右侧终端的最近活动时间只喂给定时回收，不参与渲染：每次敲键都 setState 会
  // 白白重渲染整个面板，所以放 ref 里。
  const rightTermActivityRef = useRef(new Map())
  const [activeId, setActiveId] = useState(bootstrap.activeId)
  const activeRef = useLatest(activeId)
  // 面板里可见的是活跃会话那一组；TerminalHost 拿到的是全量列表，别的会话的
  // PTY 只是被隐藏，切回来时不会重开 shell。
  const rightTerms = useMemo(() => rightTermsByChat[activeId] || [], [activeId, rightTermsByChat])
  const allRightTerms = useMemo(() => Object.values(rightTermsByChat).flat(), [rightTermsByChat])
  const allRightTermsRef = useLatest(allRightTerms)
  const rightActiveTerm = activeRightTermId(rightTerms, rightActiveTermByChat[activeId])
  const [selectedId, setSelectedId] = useState(bootstrap.selectedId)
  const selectedIdRef = useLatest(selectedId)
  // 中间主区视图：chat | stats | settings（files/terminal 移入右侧 Panel）
  const [view, setView] = useState(() =>
    storedLayout().view === 'stats' || storedLayout().view === 'settings'
      ? storedLayout().view
      : 'chat'
  )
  // 右侧 Panel：是否展开、当前 Tab（files | terminal）
  const [rightPanelOpen, setRightPanelOpen] = useState(
    () => storedLayout().rightPanelOpen !== false
  )
  const [rightPanelTab, setRightPanelTab] = useState(() =>
    storedLayout().rightPanelTab === 'terminal' ? 'terminal' : 'files'
  )
  // 右侧 Panel 宽度（可拖拽）
  const [rightPanelWidth, setRightPanelWidth] = useState(savedRightPanelWidth)
  // 右侧 Panel 最大化（占满窗口）
  const [rightPanelMaximized, setRightPanelMaximized] = useState(
    () => storedLayout().rightPanelMaximized === true
  )
  const [resizingRightPanel, setResizingRightPanel] = useState(false)
  const rightPanelWidthRef = useRef(rightPanelWidth)
  // 移动端：三栏退化为单栏，侧栏与右面板改为覆盖式抽屉
  const isMobile = useIsMobile()
  const isMobileRef = useLatest(isMobile)
  // 软键盘弹起时让根容器跟着可见区缩，否则底部输入条/终端键栏会被键盘盖住
  useVisualViewportHeight()
  const [mobileDrawer, setMobileDrawer] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => storedLayout().sidebarCollapsed === true
  )
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const sidebarWidthRef = useRef(sidebarWidth)
  const sidebarCollapsedRef = useRef(sidebarCollapsed)
  // 宽度状态变化时同步到根节点的变量（拖动分隔条期间由拖拽处理直接改写同一对变量）
  useLayoutEffect(() => {
    setLayoutVar(SIDEBAR_WIDTH_VAR, `${sidebarCollapsed ? 0 : sidebarWidth}px`)
  }, [sidebarCollapsed, sidebarWidth])
  useLayoutEffect(() => {
    setLayoutVar(RIGHT_PANEL_WIDTH_VAR, `${rightPanelOpen ? rightPanelWidth : 0}px`)
  }, [rightPanelOpen, rightPanelWidth])
  const [prompt, setPrompt] = useState(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [cwdModalOpen, setCwdModalOpen] = useState(false)
  const [cwdValid, setCwdValid] = useState(true)
  // 「切换 Mica 服务器」：切换 = 打开另一台运行时的地址（见 ServerCard）。
  // 桌面上鼠标移到 Server 行就浮出卡片（强阻断的弹窗在这里没有必要），手机上点一下
  // 在抽屉里原地展开。
  const [serverMenuOpen, setServerMenuOpen] = useState(false)
  const serverRowRef = useRef(null)
  const serverCloseTimer = useRef(null)
  const currentServer = currentServerUrl(window.location)
  // 移动端右侧面板以抽屉呈现：任何把面板「展开」的入口（标签点击、打开文件、
  // 打开终端）都会同步打开抽屉，不必逐个改调用点
  const previousRightPanelOpen = useRef(rightPanelOpen)
  useEffect(() => {
    const wasOpen = previousRightPanelOpen.current
    previousRightPanelOpen.current = rightPanelOpen
    if (isMobile && rightPanelOpen && !wasOpen) setMobileDrawer('right')
  }, [isMobile, rightPanelOpen])
  useEffect(() => {
    if (!isMobile) setMobileDrawer(null)
  }, [isMobile])
  const closeMobileDrawer = useCallback(() => setMobileDrawer(null), [])
  const rightPanelVisible = isMobile ? mobileDrawer === 'right' : rightPanelOpen

  // Server 卡片：桌面上悬停即开、移开（含移进卡片再移出）延迟关闭；触屏没有悬停，
  // 点一下切换。
  const coarsePointer = useMemo(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    []
  )
  const openServerMenu = useCallback(() => {
    clearTimeout(serverCloseTimer.current)
    setServerMenuOpen(true)
  }, [])
  const scheduleServerMenuClose = useCallback(() => {
    clearTimeout(serverCloseTimer.current)
    serverCloseTimer.current = setTimeout(() => setServerMenuOpen(false), 160)
  }, [])
  const toggleServerMenu = useCallback(() => {
    // 桌面端点行不关卡片（悬停已经把它打开了，点一下就关会很难用）
    if (!coarsePointer) {
      openServerMenu()
      return
    }
    setServerMenuOpen((open) => !open)
  }, [coarsePointer, openServerMenu])
  const hoverServerRow = !isMobile && !coarsePointer

  useEffect(() => {
    if (!serverMenuOpen) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setServerMenuOpen(false)
    }
    const onPointerDown = (event) => {
      if (event.target.closest?.('[data-server-card]')) return
      if (serverRowRef.current?.contains(event.target)) return
      setServerMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [serverMenuOpen])

  useEffect(() => {
    if (isMobile && !mobileDrawer) setServerMenuOpen(false)
  }, [isMobile, mobileDrawer])

  // 切到另一台运行时 = 打开它的地址：外壳里由主进程弹一个新窗口，浏览器里开新标签页
  const switchServer = useCallback((url) => openServerTarget(url), [])

  const promptResolver = useRef(null)
  const [git, setGit] = useState({
    terminalId: null,
    cwd: null,
    repository: null,
    status: null,
    loading: false
  })
  const gitRef = useLatest(git)
  const gitRequest = useRef(0)
  const [sessions, setSessions] = useState([])
  const [pins, setPins] = useState({})
  const [sortOrder, setSortOrder] = useState({ pinned: [], sessions: [], recent: [] })
  const [projects, setProjects] = useState({ version: 1, groups: [], assignments: {} })
  const projectsRef = useLatest(projects)
  const sessionsRef = useLatest(sessions)
  // 新建但还没绑定真实会话的草稿归属：草稿是界面状态里的临时节点，归属等它拿到
  // sessionId 才落盘（见 moveSession），在那之前只记在渲染层。
  const [draftGroups, setDraftGroups] = useState({})
  const draftGroupsRef = useLatest(draftGroups)
  // 输入框里有未发送文本的 chat 节点。草稿本身在运行时的界面状态里（第二个窗口能看见
  // 同一份），这里只是从草稿表推出来的侧栏标记：切走之后输入框就看不见了，侧栏这一行
  // 必须替它显示「还有话没发」，否则用户完全感知不到自己留了半句话。
  const [draftNodes, setDraftNodes] = useState(() => new Set())
  const draftNodesRef = useRef(draftNodes)
  useEffect(() => {
    const sync = () => {
      const next = draftMarkers(uiStateKeys().drafts, draftNodesRef.current)
      if (next === draftNodesRef.current) return
      draftNodesRef.current = next
      setDraftNodes(next)
    }
    sync()
    return subscribeUiState(sync)
  }, [])

  const applySessions = useCallback((list) => {
    const meta = {}
    for (const row of list || []) {
      if (!row?.id) continue
      meta[row.id] = {
        title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : '',
        cwd: typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim() : null,
        updatedAtMs: Number(row.updatedAtMs) || 0,
        turnState: row.turnState || 'completed'
      }
    }
    setSessions((prev) => (prev === list ? prev : list || []))
    setNodes((items) => {
      let changed = false
      const next = items.map((node) => {
        if (node.type !== 'terminal' || !node.sessionId) return node
        const title = meta[node.sessionId]?.title
        if (title && node.text !== title) {
          changed = true
          return { ...node, text: title }
        }
        return node
      })
      return changed ? next : items
    })
  }, [])

  const refreshSessions = useCallback(() => {
    window.mica.stats
      .listSessions()
      .then((result) => applySessions(result?.sessions))
      .catch((error) => console.error('load sessions failed', error))
  }, [applySessions])

  const refreshPins = useCallback(() => {
    window.mica.stats
      .listPins()
      .then((result) => setPins(result || {}))
      .catch((error) => console.error('load pins failed', error))
  }, [])

  const refreshProjects = useCallback(() => {
    window.mica.stats
      .listProjects()
      .then((result) =>
        setProjects({
          version: result?.version || 1,
          groups: Array.isArray(result?.groups) ? result.groups : [],
          assignments: result?.assignments || {}
        })
      )
      .catch((error) => console.error('load projects failed', error))
  }, [])

  const applyMoveResult = useCallback((result) => {
    if (result?.pins) setPins(result.pins)
    if (result?.projects) {
      setProjects({
        version: result.projects.version || 1,
        groups: Array.isArray(result.projects.groups) ? result.projects.groups : [],
        assignments: result.projects.assignments || {}
      })
    }
  }, [])

  /**
   * 侧栏唯一一次「换位置」：Pinned / 某个项目分组 / Recent 三选一。
   * 落在哪个分区完全由这次调用决定，所以同一个会话不会同时出现在两处。
   */
  const moveSession = useCallback(
    (sessionId, target = {}) => {
      const section =
        target.section === 'pinned' ? 'pinned' : target.section === 'project' ? 'project' : 'recent'
      const groupId = section === 'project' ? target.groupId || null : null
      if (section === 'project' && !groupId) return
      window.mica.stats
        .moveSession(sessionId, section, groupId)
        .then(applyMoveResult)
        .catch((error) => console.error('move session failed', error))
    },
    [applyMoveResult]
  )

  const togglePin = useCallback(
    (sessionId) => {
      moveSession(sessionId, { section: pins[sessionId] ? 'recent' : 'pinned' })
    },
    [moveSession, pins]
  )

  const refreshSort = useCallback(() => {
    window.mica.stats
      .listSort()
      .then(setSortOrder)
      .catch((error) => console.error('load sort failed', error))
  }, [])

  const reorderSessions = useCallback((section, ids) => {
    setSortOrder((current) => ({ ...current, [section]: ids }))
    window.mica.stats
      .setSort(section, ids)
      .then(setSortOrder)
      .catch((error) => console.error('set sort failed', error))
  }, [])

  // 工作区（左侧页签与文件夹树）和面板布局都是运行时的界面状态：本地照旧直接改，
  // 下面把它写回运行时（攒一下再发由 ui-state 负责）并广播给其它窗口；别的窗口改了同一份
  // 时再应用回来。
  const remoteWorkspace = useUiStateValue('workspace', null)
  const remoteLayout = useUiStateValue('layout', null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUiState(
        'workspace',
        workspaceSnapshot(nodesRef.current, activeRef.current, selectedIdRef.current)
      )
    }, 200)
    return () => clearTimeout(timer)
  }, [activeId, activeRef, nodes, nodesRef, selectedId, selectedIdRef])

  useEffect(() => {
    // 自己写出去的回声（可能已经落后于本页最新操作）不能应用，否则会把刚做的改动拽回去。
    if (claimUiStateEcho('workspace', remoteWorkspace)) return
    const next = resolveWorkspace(remoteWorkspace)
    // 工作区被清空（没有任何页签）时保持现状：另一个窗口开了新页签马上会再推一次。
    if (!next) return
    setNodes(next.nodes)
    setActiveId(next.activeId)
    setSelectedId(next.selectedId)
  }, [remoteWorkspace])

  useEffect(() => {
    setUiState('layout', {
      sidebarWidth,
      sidebarCollapsed,
      rightPanelWidth,
      rightPanelOpen,
      rightPanelTab,
      rightPanelMaximized,
      view
    })
  }, [
    rightPanelMaximized,
    rightPanelOpen,
    rightPanelTab,
    rightPanelWidth,
    sidebarCollapsed,
    sidebarWidth,
    view
  ])

  useEffect(() => {
    if (!remoteLayout) return
    if (claimUiStateEcho('layout', remoteLayout)) return
    if (Number.isFinite(remoteLayout.sidebarWidth)) setSidebarWidth(remoteLayout.sidebarWidth)
    if (typeof remoteLayout.sidebarCollapsed === 'boolean')
      setSidebarCollapsed(remoteLayout.sidebarCollapsed)
    if (Number.isFinite(remoteLayout.rightPanelWidth))
      setRightPanelWidth(remoteLayout.rightPanelWidth)
    if (typeof remoteLayout.rightPanelOpen === 'boolean')
      setRightPanelOpen(remoteLayout.rightPanelOpen)
    if (remoteLayout.rightPanelTab === 'files' || remoteLayout.rightPanelTab === 'terminal')
      setRightPanelTab(remoteLayout.rightPanelTab)
    if (typeof remoteLayout.rightPanelMaximized === 'boolean')
      setRightPanelMaximized(remoteLayout.rightPanelMaximized)
    if (
      remoteLayout.view === 'chat' ||
      remoteLayout.view === 'stats' ||
      remoteLayout.view === 'settings'
    )
      setView(remoteLayout.view)
  }, [remoteLayout])

  const terminalCwd = useCallback(
    (id) => {
      const node = nodesRef.current.find((item) => item.id === id)
      if (!node) return null
      if (node.type === 'terminal' && node.cwd) return node.cwd
      return resolveDefaultCwd(nodesRef.current, node.parent)
    },
    [nodesRef]
  )
  const recentSessionDirs = useMemo(() => {
    const map = new Map()
    for (const session of sessions) {
      if (session?.cwd) {
        const usedAt = Number(session.updatedAtMs) || 0
        map.set(session.cwd, Math.max(map.get(session.cwd) || 0, usedAt))
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([dir]) => dir)
      .slice(0, 10)
  }, [sessions])

  const setSessionId = useCallback(
    (id, sessionId) => {
      const value = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (!value) return
      setNodes((items) =>
        items.map((node) =>
          node.id === id && node.type === 'terminal' && node.sessionId !== value
            ? { ...node, sessionId: value }
            : node
        )
      )
      // 在某个项目分组里新建的会话，拿到 sessionId 的这一刻才真正归属该分组
      const groupId = draftGroupsRef.current?.[id]
      if (groupId) {
        setDraftGroups((prev) => {
          if (!prev[id]) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        window.mica.stats
          .moveSession(value, 'project', groupId)
          .then(applyMoveResult)
          .catch((error) => console.error('assign session to project failed', error))
      }
      refreshSessions()
    },
    [applyMoveResult, draftGroupsRef, refreshSessions]
  )
  const canBindSessionId = useCallback(
    (nodeId) => {
      const node = nodesRef.current.find((item) => item.id === nodeId)
      return !!node?.sessionId
    },
    [nodesRef]
  )
  const notifications = useNotifications(activeId, setSessionId, canBindSessionId)
  // 终端是否空闲只用于「重开之前先看一眼」，走 ref 读取：进 deps 会让前台进程一
  // 结束就立刻重开终端，把用户刚跑完的那条命令的输出吞掉。
  const notificationStatesRef = useLatest(notifications.states)

  useEffect(() => {
    refreshSessions()
    refreshPins()
    refreshSort()
    refreshProjects()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) refreshSessions()
    }, 3000)
    return () => clearInterval(timer)
  }, [refreshPins, refreshProjects, refreshSessions, refreshSort])

  const refreshGit = useCallback(
    async ({ quiet = false, cwd: requestedCwd = null } = {}) => {
      const id = activeRef.current
      const request = ++gitRequest.current
      if (!id) {
        setGit({ terminalId: null, cwd: null, repository: null, status: null, loading: false })
        return
      }
      if (!quiet) setGit((current) => ({ ...current, loading: true }))
      let cwd = requestedCwd || (await terminalRef.current?.getCwd(id))
      if (request !== gitRequest.current || id !== activeRef.current) return
      if (!cwd) {
        setGit({ terminalId: null, cwd: null, repository: null, status: null, loading: false })
        return
      }
      setGit((current) =>
        current.terminalId === id && current.cwd === cwd
          ? current
          : { terminalId: id, cwd, repository: null, status: null, loading: true }
      )
      try {
        const summaryPromise = window.mica.git.summary(cwd)
        let status = await window.mica.git.status(cwd)
        if (request === gitRequest.current && id === activeRef.current && status?.status) {
          setGit((current) =>
            current.terminalId === id && current.cwd === cwd
              ? { ...current, status: status.status }
              : current
          )
        }
        let summary = await summaryPromise
        const fallbackRoot = gitRef.current.status?.root
        const cwdMissing = /\bENOENT\b|no such file or directory|cannot chdir/i.test(
          `${summary?.error || ''}\n${status?.error || ''}`
        )
        if (
          !requestedCwd &&
          !summary?.repository &&
          !status?.status &&
          fallbackRoot &&
          cwd !== fallbackRoot &&
          cwdMissing
        ) {
          cwd = fallbackRoot
          const fallback = await Promise.all([
            window.mica.git.summary(cwd),
            window.mica.git.status(cwd)
          ])
          summary = fallback[0]
          status = fallback[1]
        }
        if (request === gitRequest.current && id === activeRef.current) {
          setGit({
            terminalId: id,
            cwd,
            repository: summary?.repository || null,
            status: status?.status || null,
            loading: false
          })
        }
      } catch (gitError) {
        if (request === gitRequest.current) {
          console.error('refresh git failed', gitError)
          setGit({ terminalId: id, cwd, repository: null, status: null, loading: false })
        }
      }
    },
    [activeRef, gitRef]
  )

  useEffect(() => setBranchPickerOpen(false), [activeId])
  useEffect(() => {
    refreshGit({ cwd: terminalCwd(activeId) })
  }, [activeId, refreshGit, terminalCwd])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        // 用节点自身的 cwd 刷新，而不是 PTY 里 shell 的 cwd：底部路径与分支
        // 必须始终描述同一个目录，否则 shell cd 之后两边会各说各话。
        refreshGit({ quiet: true, cwd: terminalCwd(activeRef.current) })
      }
    }, 10000)
    return () => clearInterval(timer)
  }, [activeRef, refreshGit, terminalCwd])

  const askText = useCallback(
    (title, initial = '', hint = '') =>
      new Promise((resolve) => {
        promptResolver.current = resolve
        setPrompt({ title, initial, hint })
      }),
    []
  )
  const closePrompt = (value) => {
    setPrompt(null)
    promptResolver.current?.(value)
    promptResolver.current = null
  }
  const branchChanged = useCallback(
    async (status) => {
      setGit((current) => ({
        ...current,
        status: status || current.status,
        repository: null,
        loading: true
      }))
      await filesRef.current?.reloadAfterGitChange(status?.root || gitRef.current.status?.root)
    },
    [gitRef]
  )

  const createTerminal = useCallback(
    (options = {}) => {
      const current = nodesRef.current
      const target = '#'
      const id = uid('term')
      const count = current.filter((node) => node.type === 'terminal').length + 1
      const resumeSessionId =
        typeof options.resumeSessionId === 'string' ? options.resumeSessionId.trim() : ''
      const text =
        typeof options.text === 'string' && options.text.trim()
          ? options.text.trim()
          : `新对话 ${count}`
      const cwd = typeof options.cwd === 'string' && options.cwd.trim() ? options.cwd.trim() : null
      const groupId =
        typeof options.groupId === 'string' && options.groupId ? options.groupId : null
      setNodes((items) => {
        return [
          ...items,
          {
            id,
            parent: target,
            text,
            type: 'terminal',
            sessionId: resumeSessionId || null,
            command: null,
            cwd,
            lastActiveAt: Date.now(),
            state: { opened: false, selected: false }
          }
        ]
      })
      if (groupId) {
        // 恢复已有会话时归属可以立刻落盘；新草稿要等它拿到 sessionId 再绑定
        if (resumeSessionId)
          window.mica.stats
            .moveSession(resumeSessionId, 'project', groupId)
            .then(applyMoveResult)
            .catch((error) => console.error('assign session to project failed', error))
        else setDraftGroups((prev) => ({ ...prev, [id]: groupId }))
      }
      setSelectedId(id)
      setActiveId(id)
    },
    [applyMoveResult, nodesRef]
  )

  const createRightTerm = useCallback(() => {
    const chatId = activeRef.current
    if (!chatId) return
    const id = uid('rt')
    rightTermActivityRef.current.set(id, Date.now())
    const cwd = terminalCwd(chatId) || recentChatCwd() || null
    // 终端是在当前会话的上下文里开的，记下归属会话，左侧会话树才能标出
    // 「这个会话有终端在跑」（右侧终端本身不在 nodes 里，只能靠这份映射关联）。
    const sessionId = nodesRef.current.find((node) => node.id === chatId)?.sessionId || null
    setRightTermsByChat((prev) => {
      const list = prev[chatId] || []
      return {
        ...prev,
        [chatId]: [
          ...list,
          { id, text: `终端 ${list.length + 1}`, cwd, type: 'terminal', sessionId, command: null }
        ]
      }
    })
    setRightActiveTermByChat((prev) => ({ ...prev, [chatId]: id }))
    setRightPanelTab('terminal')
  }, [activeRef, nodesRef, terminalCwd])

  const closeRightTerm = useCallback(
    (id) => {
      const current = rightTermsByChatRef.current
      const owner = Object.keys(current).find((chatId) =>
        current[chatId].some((term) => term.id === id)
      )
      if (!owner) return
      const remaining = current[owner].filter((term) => term.id !== id)
      rightTermActivityRef.current.delete(id)
      setRightTermsByChat((prev) => ({ ...prev, [owner]: remaining }))
      setRightActiveTermByChat((prev) =>
        prev[owner] === id ? { ...prev, [owner]: remaining[0]?.id ?? null } : prev
      )
      terminalRef.current
        ?.dispose(id)
        .catch((error) => console.error('dispose right term failed', error))
    },
    [rightTermsByChatRef]
  )
  const rightTermCwd = useCallback(
    (id) => allRightTermsRef.current.find((item) => item.id === id)?.cwd || null,
    [allRightTermsRef]
  )
  // 会话路径变化后把该会话下「空闲」的终端重新加载到新目录：dispose 掉旧 PTY
  // 再按新 cwd 重开，TerminalHost 的 activate 会读更新后的 resolveCwd。
  const respawnRightTerm = useCallback(async (chatId, termId, cwd) => {
    setRightTermsByChat((prev) => {
      const list = prev[chatId]
      if (!list) return prev
      let changed = false
      const next = list.map((term) => {
        if (term.id !== termId || term.cwd === cwd) return term
        changed = true
        return { ...term, cwd }
      })
      return changed ? { ...prev, [chatId]: next } : prev
    })
    await terminalRef.current?.dispose(termId)
    await terminalRef.current?.activate(termId)
  }, [])
  // 移动端键栏：走 xterm 自己的输入通道（term.input → onData），与键盘敲出来的
  // 字符同一条路，不要绕过去直写 PTY。
  const sendTerminalKey = useCallback((data) => {
    terminalRef.current?.input(data)
  }, [])
  // 面板终端的活动时间（敲键、翻页、点选）只喂给定时回收，不进 state。
  const touchRightTerm = useCallback((id) => {
    rightTermActivityRef.current.set(id, Date.now())
  }, [])
  const openRightTerminalTab = useCallback(() => {
    // 切到终端 Tab 时至少要有一个终端，否则用户还得先手动新建第一个。
    if (rightTerms.length === 0) {
      createRightTerm()
      return
    }
    setRightPanelTab('terminal')
  }, [createRightTerm, rightTerms.length])

  // 右侧面板是会话的附属视图：切到还没有终端的会话时补一个，路径即该会话的 cwd，
  // 否则切过去只能看到一片空白。只在这一区域真正可见时才补，免得用户点过的每个
  // 会话都被拉起一个 PTY。
  useEffect(() => {
    if (!activeId || !rightPanelVisible || rightPanelTab !== 'terminal') return
    if ((rightTermsByChatRef.current[activeId] || []).length > 0) return
    createRightTerm()
  }, [activeId, createRightTerm, rightPanelTab, rightPanelVisible, rightTermsByChatRef])

  // 会话路径（底部状态栏切换 cwd、恢复会话）变化后，该会话下空闲的终端重新加载
  // 到新目录；有前台进程在跑的保持不动。
  const activeChatCwd = terminalCwd(activeId)
  useEffect(() => {
    if (!activeId || !activeChatCwd) return
    const terms = rightTermsByChatRef.current[activeId] || []
    const stale = staleRightTermIds(terms, activeChatCwd, notificationStatesRef.current)
    for (const id of stale) respawnRightTerm(activeId, id, activeChatCwd)
  }, [activeChatCwd, activeId, notificationStatesRef, respawnRightTerm, rightTermsByChatRef])

  // 会话关闭后它名下的终端一起回收：右侧终端不在工作区 nodes 里，只能按归属会话
  // 判断，否则那些 PTY 会一直挂到进程退出。
  useEffect(() => {
    const alive = new Set(nodes.map((node) => node.id))
    const orphaned = Object.keys(rightTermsByChatRef.current).filter((chatId) => !alive.has(chatId))
    if (orphaned.length === 0) return
    const termIds = orphaned.flatMap((chatId) =>
      rightTermsByChatRef.current[chatId].map((term) => term.id)
    )
    setRightTermsByChat((prev) => {
      const next = { ...prev }
      for (const chatId of orphaned) delete next[chatId]
      return next
    })
    for (const id of termIds) {
      terminalRef.current
        ?.dispose(id)
        .catch((error) => console.error('dispose right term failed', error))
    }
  }, [nodes, rightTermsByChatRef])

  // 右侧终端是每个会话一组真 PTY，应用开着不放会越积越多，所以定时回收：8h 没被
  // 碰过的会话、以及 8h 没有任何活动的终端都释放，下次切过去再按需重开。当前正在
  // 看的会话整组跳过——回收要悄悄做，不能当面把用户看着的终端关掉。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      const states = notificationStatesRef.current
      const activityAt = Object.fromEntries(rightTermActivityRef.current)
      const reclaim = []
      for (const [chatId, terms] of Object.entries(rightTermsByChatRef.current)) {
        if (chatId === activeRef.current) continue
        const node = nodesRef.current.find((item) => item.id === chatId)
        const session = node?.sessionId
          ? sessionsRef.current.find((row) => row.id === node.sessionId)
          : null
        const ids = reclaimableRightTermIds({
          terms,
          lastUsedAt: Math.max(Number(node?.lastActiveAt) || 0, Number(session?.updatedAtMs) || 0),
          activityAt,
          states,
          now
        })
        if (ids.length > 0) reclaim.push([chatId, new Set(ids)])
      }
      if (reclaim.length === 0) return
      for (const [, ids] of reclaim) {
        for (const id of ids) {
          rightTermActivityRef.current.delete(id)
          terminalRef.current
            ?.dispose(id)
            .catch((error) => console.error('reclaim right term failed', error))
        }
      }
      setRightTermsByChat((prev) => {
        const next = { ...prev }
        for (const [chatId, ids] of reclaim) {
          const remaining = (prev[chatId] || []).filter((term) => !ids.has(term.id))
          if (remaining.length > 0) next[chatId] = remaining
          else delete next[chatId]
        }
        return next
      })
    }, RIGHT_PANEL_SWEEP_MS)
    return () => window.clearInterval(timer)
  }, [activeRef, nodesRef, notificationStatesRef, rightTermsByChatRef, sessionsRef])

  const createSession = useCallback(
    (cwd = null) => {
      setView('chat')
      createTerminal({ cwd: cwd || terminalCwd(activeRef.current) || recentChatCwd() || null })
    },
    [activeRef, createTerminal, terminalCwd]
  )

  // 分组里新建会话：默认工作目录取该分组（含子分组）里最近一条会话的 cwd，
  // 分组还是空的就沿用当前默认目录。
  const createSessionInGroup = useCallback(
    (groupId) => {
      if (!groupId) return
      setView('chat')
      const cwd =
        resolveGroupCwd(projectsRef.current, sessionsRef.current, groupId) ||
        terminalCwd(activeRef.current) ||
        recentChatCwd() ||
        null
      createTerminal({ cwd, groupId })
    },
    [activeRef, createTerminal, projectsRef, sessionsRef, terminalCwd]
  )

  const moveDraft = useCallback((nodeId, target = {}) => {
    const groupId = target.section === 'project' ? target.groupId || null : null
    setDraftGroups((prev) => {
      const next = { ...prev }
      if (groupId) next[nodeId] = groupId
      else delete next[nodeId]
      return next
    })
  }, [])

  const createGroup = useCallback(
    async (parentId) => {
      const name = await askText(parentId ? '新建子分组' : '新建分组', '')
      if (!name || !name.trim()) return
      window.mica.stats
        .createProjectGroup(name.trim(), parentId || null)
        .then(setProjects)
        .catch((error) => console.error('create project group failed', error))
    },
    [askText]
  )

  const renameGroup = useCallback((groupId, name) => {
    window.mica.stats
      .renameProjectGroup(groupId, name)
      .then(setProjects)
      .catch((error) => console.error('rename project group failed', error))
  }, [])

  /** 拖拽嵌套：分组换父级，parentId 为 null 即移回根。 */
  const moveGroup = useCallback((groupId, parentId = null) => {
    window.mica.stats
      .moveProjectGroup(groupId, parentId)
      .then(setProjects)
      .catch((error) => console.error('move project group failed', error))
  }, [])

  const deleteGroup = useCallback(
    (groupId) => {
      const group = projectsRef.current?.groups?.find((item) => item.id === groupId)
      if (
        !window.confirm(`确定删除分组「${group?.name || ''}」及其子分组吗？组内会话会回到 Recent。`)
      )
        return
      window.mica.stats
        .deleteProjectGroup(groupId)
        .then(setProjects)
        .catch((error) => console.error('delete project group failed', error))
    },
    [projectsRef]
  )

  const selectNode = useCallback(
    (node, activate = true) => {
      setSelectedId(node.id)
      // 选中终端节点时始终激活右侧 Panel 的终端，确保 PTY 会话跟随
      if (activate && node.type === 'terminal') {
        terminalRef.current
          ?.activate(node.id)
          .catch((activateError) => console.error('activate terminal failed', activateError))
      }
      if (activate && node.type === 'terminal') {
        if (view !== 'chat') setView('chat')
        setActiveId(node.id)
        setNodes((items) =>
          items.map((item) => (item.id === node.id ? { ...item, lastActiveAt: Date.now() } : item))
        )
      }
    },
    [view]
  )

  const openSession = useCallback(
    (session) => {
      if (!session?.id) return
      setView('chat')
      const existing = nodesRef.current.find(
        (node) => node.type === 'terminal' && node.sessionId === session.id
      )
      if (existing) {
        selectNode(existing)
        return
      }
      createTerminal({
        resumeSessionId: session.id,
        text: session.title || session.id,
        cwd: session.cwd || null
      })
    },
    [createTerminal, nodesRef, selectNode]
  )

  const closeTab = useCallback(
    (node) => {
      const current = nodesRef.current
      const next = removeNode(current, node.id)
      setNodes((items) => removeNode(items, node.id))
      setDraftGroups((prev) => {
        if (!prev[node.id]) return prev
        const updated = { ...prev }
        delete updated[node.id]
        return updated
      })
      // 页签没了，它那份没发出去的草稿也一起丢掉（否则会一直挂在界面状态里）。
      setUiStateEntries('drafts', { [node.id]: null })
      if (node.id === activeRef.current) {
        const terminal = next.find((item) => item.type === 'terminal')
        setActiveId(terminal?.id || null)
        setSelectedId(terminal?.id || null)
      }
      terminalRef.current
        ?.dispose(node.id)
        .catch((error) => console.error('dispose terminal failed', error))
      window.mica.chat
        .dispose(node.id)
        .catch((error) => console.error('dispose chat failed', error))
      setView('chat')
    },
    [activeRef, nodesRef]
  )

  const closeTerminal = useCallback(
    (nodeId) => {
      const node = nodesRef.current.find((item) => item.id === nodeId && item.type === 'terminal')
      if (node) closeTab(node)
    },
    [closeTab, nodesRef]
  )

  /**
   * 删除一个会话：二次确认后连同磁盘上的会话记录一起删掉（置顶 / 项目归属 / 手动排序
   * 由 host 在同一次调用里清理），再把它的标签页关掉。会话正在跑时 host 会拒绝。
   */
  const deleteSession = useCallback(
    async (sessionId) => {
      const title = sessionsRef.current.find((item) => item.id === sessionId)?.title
      if (
        !window.confirm(`确定删除对话「${title || sessionId}」？会话记录会从磁盘删除，无法恢复。`)
      )
        return
      let result
      try {
        result = await window.mica.stats.deleteSession(sessionId)
      } catch (error) {
        window.alert(`删除对话失败：${error?.message || error}`)
        return
      }
      if (result?.pins) setPins(result.pins)
      if (result?.projects)
        setProjects({
          version: result.projects.version || 1,
          groups: Array.isArray(result.projects.groups) ? result.projects.groups : [],
          assignments: result.projects.assignments || {}
        })
      if (result?.sort) setSortOrder(result.sort)
      const node = nodesRef.current.find(
        (item) => item.type === 'terminal' && item.sessionId === sessionId
      )
      if (node) closeTab(node)
      refreshSessions()
    },
    [closeTab, nodesRef, refreshSessions, sessionsRef]
  )

  /** 草稿（还没绑定真实会话）只活在进程内，删除就是丢掉这个标签页。 */
  const deleteDraft = useCallback(
    (nodeId) => {
      if (!window.confirm('确定删除这个新对话？')) return
      closeTerminal(nodeId)
    },
    [closeTerminal]
  )

  const terminalNodes = useMemo(() => nodes.filter((node) => node.type === 'terminal'), [nodes])
  const openBySession = useMemo(() => {
    const map = {}
    for (const node of terminalNodes) if (node.sessionId) map[node.sessionId] = node.id
    return map
  }, [terminalNodes])
  const draftTabs = useMemo(() => terminalNodes.filter((node) => !node.sessionId), [terminalNodes])
  // 右侧终端不在 nodes 里，靠它们创建时记下的归属会话，把「这个终端有前台进程在跑」
  // 映射回左侧会话行（notify 状态按 PTY id 保存，折成终端节点 id 后即可对齐）。
  const sessionsWithRunningTerminal = useMemo(
    () => runningTerminalSessions(allRightTerms, notifications.states),
    [allRightTerms, notifications.states]
  )
  const activeSessionId = useMemo(() => {
    const node = nodes.find((item) => item.id === activeId)
    return node?.sessionId || null
  }, [activeId, nodes])
  const commandFor = useCallback(
    (id) => nodesRef.current.find((node) => node.id === id)?.command || 'mica',
    [nodesRef]
  )
  const gitIsCurrent = git.terminalId === activeId
  const activeCwd = terminalCwd(activeId) || (gitIsCurrent ? git.cwd : null)
  useEffect(() => {
    let cancelled = false
    if (!activeCwd) {
      setCwdValid(true)
      return
    }
    window.mica.chat
      .checkCwd(activeCwd)
      .then((result) => {
        if (!cancelled) setCwdValid(result?.exists !== false)
      })
      .catch(() => {
        if (!cancelled) setCwdValid(true)
      })
    return () => {
      cancelled = true
    }
  }, [activeCwd])
  const repository = gitIsCurrent ? git.repository : null
  const getSearchRoot = useCallback(
    () => terminalRef.current?.getCwd(activeRef.current),
    [activeRef]
  )
  const openSearchFile = useCallback(
    async (path, position) => {
      setView('chat')
      setRightPanelOpen(true)
      setRightPanelTab('files')
      if (isMobileRef.current) setMobileDrawer('right')
      await filesRef.current?.openFile(path, position)
    },
    [isMobileRef]
  )
  const openChatFile = useCallback(
    async (path, position) => {
      setView('chat')
      setRightPanelOpen(true)
      setRightPanelTab('files')
      if (isMobileRef.current) setMobileDrawer('right')
      await filesRef.current?.openFile(path, position)
    },
    [isMobileRef]
  )
  // 网页端的终端文件链接由 transport 派发到应用内编辑器（Electron 走本机 VS Code）
  useEffect(() => {
    const handler = (event) => {
      const detail = event.detail || {}
      if (detail.path) void openChatFile(detail.path, detail)
    }
    window.addEventListener('mica:open-file', handler)
    return () => window.removeEventListener('mica:open-file', handler)
  }, [openChatFile])
  const openChatTerminal = useCallback(() => {
    setRightPanelOpen(true)
    openRightTerminalTab()
    const id = activeRef.current
    if (id) terminalRef.current?.activate(id).catch(() => {})
  }, [activeRef, openRightTerminalTab])
  const createChatSession = useCallback(
    (cwd = null) => {
      setView('chat')
      createTerminal({ cwd: cwd || recentChatCwd() || null })
    },
    [createTerminal]
  )
  const changeChatCwd = useCallback(
    (cwd) => {
      const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null
      const id = activeRef.current
      if (!dir || !id) return
      setUiState('chatDefaultCwd', dir)
      const node = nodesRef.current.find((item) => item.id === id)
      setNodes((items) =>
        items.map((node) =>
          node.id === id && node.type === 'terminal' && node.cwd !== dir
            ? { ...node, cwd: dir, sessionId: node.sessionId }
            : node
        )
      )
      setCwdValid(true)
      // 把新 cwd 持久化到会话文件，压缩/续聊等后续流程才能读到正确目录
      if (node?.sessionId) {
        window.mica.chat.updateCwd(node.sessionId, dir).catch(() => {})
      }
      refreshGit({ cwd: dir })
    },
    [activeRef, refreshGit]
  )
  const closeSearchFile = useCallback(
    () => rightPanelOpen && rightPanelTab === 'files' && !!filesRef.current?.closeActive(),
    [rightPanelOpen, rightPanelTab]
  )
  const canChangeBranch = useCallback(
    () =>
      filesRef.current?.hasDirty()
        ? '存在尚未保存、正在保存或正在打开的文件，请处理完成后再执行 Git 分支操作。'
        : '',
    []
  )
  const closeBranchPicker = useCallback(() => {
    setBranchPickerOpen(false)
    requestAnimationFrame(() => branchButtonRef.current?.focus())
  }, [])
  const setCollapsed = () => {
    setSidebarCollapsed((value) => !value)
  }
  // 拖分隔条不能每个 pointermove 都 setState：那会把整个 App（长对话的 markdown、打开的文件
  // monaco、会话树）重渲染一遍，一次 move 就要几十毫秒，拖动直接卡住。拖动期间只改写根节点上
  // 的宽度变量（网格列宽与两侧栏宽度都读它），松手才提交回状态（持久化/别的窗口读到的是最终值）。
  const startSidebarResize = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidthRef.current
    let width = startWidth
    let panelWidth = rightPanelWidthRef.current
    setResizingSidebar(true)
    document.body.classList.add('is-resizing-sidebar')

    const onMove = (moveEvent) => {
      width = Math.round(
        Math.min(
          MAX_SIDEBAR_WIDTH,
          Math.max(MIN_SIDEBAR_WIDTH, startWidth + moveEvent.clientX - startX)
        )
      )
      setLayoutVar(SIDEBAR_WIDTH_VAR, `${width}px`)
      // 侧栏变宽会把右面板挤出窗口：跟着压回上限（与松手后 clamp effect 同一口径）
      const limit = rightPanelWidthLimit(window.innerWidth, width, sidebarCollapsedRef.current)
      if (panelWidth > limit) {
        panelWidth = Math.max(MIN_RIGHT_PANEL_WIDTH, limit)
        setLayoutVar(RIGHT_PANEL_WIDTH_VAR, `${panelWidth}px`)
      }
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-sidebar')
      setResizingSidebar(false)
      setSidebarWidth(width)
      setRightPanelWidth(panelWidth)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [])
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
  }, [sidebarWidth])
  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed
  }, [sidebarCollapsed])
  // 右侧 Panel 宽度拖拽（同上：拖动期间只改变量，松手才提交）
  const startRightPanelResize = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = rightPanelWidthRef.current
    let width = startWidth
    setResizingRightPanel(true)
    document.body.classList.add('is-resizing-right-panel')

    const onMove = (moveEvent) => {
      const limit = rightPanelWidthLimit(
        window.innerWidth,
        sidebarWidthRef.current,
        sidebarCollapsedRef.current
      )
      width = Math.round(
        Math.min(limit, Math.max(MIN_RIGHT_PANEL_WIDTH, startWidth - (moveEvent.clientX - startX)))
      )
      setLayoutVar(RIGHT_PANEL_WIDTH_VAR, `${width}px`)
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-right-panel')
      setResizingRightPanel(false)
      setRightPanelWidth(width)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [])
  useEffect(() => {
    rightPanelWidthRef.current = rightPanelWidth
  }, [rightPanelWidth])
  // 窗口变小或侧栏重新展开后，已保存的面板宽度可能超过可用空间：粘住上限，别让网格溢出。
  useEffect(() => {
    // 移动端面板是覆盖式抽屉、宽度由 CSS 决定，别按窄屏把桌面用的宽度压小。
    const clamp = () => {
      if (isMobile) return
      setRightPanelWidth((value) => {
        const limit = rightPanelWidthLimit(
          window.innerWidth,
          sidebarWidthRef.current,
          sidebarCollapsedRef.current
        )
        return value > limit ? Math.max(MIN_RIGHT_PANEL_WIDTH, limit) : value
      })
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [isMobile, sidebarCollapsed, sidebarWidth])
  const toggleRightPanel = useCallback(() => {
    if (isMobile) {
      setRightPanelOpen(true)
      setMobileDrawer((value) => (value === 'right' ? null : 'right'))
      return
    }
    setRightPanelOpen((open) => !open)
  }, [isMobile])
  // Cmd/Ctrl+Shift+I 显示/隐藏右侧 Panel
  useEffect(() => {
    const onKey = (event) => {
      if (event.repeat || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey)
        return
      if (event.code !== 'KeyI') return
      event.preventDefault()
      event.stopPropagation()
      toggleRightPanel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggleRightPanel])
  // Cmd/Ctrl+` 切换右侧 Panel 的文件/终端 Tab
  useEffect(() => {
    const onKey = (event) => {
      if (event.repeat || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (event.code !== 'Backquote') return
      event.preventDefault()
      event.stopPropagation()
      setRightPanelOpen(true)
      if (rightPanelTab === 'terminal') setRightPanelTab('files')
      else openRightTerminalTab()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [openRightTerminalTab, rightPanelTab])

  return (
    <>
      <div
        className={
          isMobile
            ? 'relative flex size-full flex-col overflow-hidden'
            : 'grid size-full transition-[grid-template-columns]'
        }
        style={
          isMobile
            ? undefined
            : {
                gridTemplateColumns: rightPanelMaximized
                  ? '0px 0px 1fr'
                  : `var(${SIDEBAR_WIDTH_VAR}) 1fr var(${RIGHT_PANEL_WIDTH_VAR})`,
                transition: rightPanelOpen ? 'none' : 'none'
              }
        }
      >
        {isMobile && mobileDrawer && (
          <div
            className="fixed inset-0 z-[9050] bg-black/55"
            aria-hidden="true"
            onClick={closeMobileDrawer}
          />
        )}
        <aside
          className={
            isMobile
              ? `safe-top safe-bottom absolute inset-y-0 left-0 z-[9100] flex w-[86vw] max-w-[330px] min-w-0 flex-col overflow-hidden border-r border-line bg-panel shadow-2xl transition-transform duration-200 ${
                  mobileDrawer === 'sessions' ? 'translate-x-0' : '-translate-x-full'
                }`
              : `safe-top safe-bottom relative flex min-w-0 flex-col overflow-hidden border-r border-line bg-panel ${sidebarCollapsed || rightPanelMaximized ? 'invisible pointer-events-none border-r-0' : ''}`
          }
          style={
            isMobile
              ? undefined
              : { width: sidebarCollapsed ? undefined : `var(${SIDEBAR_WIDTH_VAR})` }
          }
        >
          {!isMobile && !sidebarCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧栏宽度"
              title="拖动调整侧栏宽度"
              className={`absolute inset-y-0 right-[-2px] z-10 w-1 cursor-col-resize touch-none select-none hover:bg-white/20 ${resizingSidebar ? 'bg-white/30' : ''}`}
              onPointerDown={startSidebarResize}
            />
          )}
          {isMobile ? (
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-line pl-3.5 pr-2">
              <span className="text-xs font-semibold text-white/70">会话</span>
              <button
                type="button"
                title="关闭"
                aria-label="关闭会话列表"
                className="grid size-7 place-items-center rounded-md text-white/55 hover:bg-white/[.08] hover:text-white"
                onClick={closeMobileDrawer}
              >
                <IconX size={15} />
              </button>
            </div>
          ) : (
            <div className="h-10 shrink-0 drag-region" aria-hidden="true" />
          )}
          <nav className="no-drag shrink-0 px-2 pb-2 pt-1">
            <button
              type="button"
              title="New Session"
              className="flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-white/60 transition-colors hover:bg-white/[.05] hover:text-white"
              onClick={() => {
                closeMobileDrawer()
                createSession()
              }}
            >
              <IconRocket size={14} className="shrink-0 opacity-60" />
              <span>New Session</span>
            </button>
            <button
              type="button"
              aria-pressed={view === 'stats'}
              title="查看使用统计"
              className={`flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors ${
                view === 'stats'
                  ? 'bg-white/[.10] text-white'
                  : 'text-white/60 hover:bg-white/[.05] hover:text-white'
              }`}
              onClick={() => {
                closeMobileDrawer()
                setView('stats')
              }}
            >
              <IconChartBar size={14} className="shrink-0 opacity-75" />
              <span>Stats</span>
            </button>
            <button
              type="button"
              aria-pressed={view === 'settings'}
              title="打开 Mica 配置页面"
              className={`flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors ${
                view === 'settings'
                  ? 'bg-white/[.10] text-white'
                  : 'text-white/60 hover:bg-white/[.05] hover:text-white'
              }`}
              onClick={() => {
                closeMobileDrawer()
                setView('settings')
              }}
            >
              <IconSettings size={14} className="shrink-0 opacity-75" />
              <span>Settings</span>
            </button>
            <div
              ref={serverRowRef}
              className="relative"
              onMouseEnter={hoverServerRow ? openServerMenu : undefined}
              onMouseLeave={hoverServerRow ? scheduleServerMenuClose : undefined}
            >
              <button
                type="button"
                aria-expanded={serverMenuOpen}
                title="切换 Mica 服务器（连接另一台机器上的 Mica）"
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors hover:bg-white/[.05] hover:text-white ${
                  serverMenuOpen ? 'bg-white/[.05] text-white' : 'text-white/60'
                }`}
                onClick={toggleServerMenu}
              >
                <IconServer size={14} className="shrink-0 opacity-60" />
                <span className="shrink-0">Server</span>
                <span className="ml-auto min-w-0 truncate text-[11px] text-white/35">
                  {serverLabel(currentServer)}
                </span>
              </button>
            </div>
          </nav>
          {serverMenuOpen && isMobile && (
            <div className="no-drag shrink-0 px-2 pb-2">
              <ServerCard
                current={currentServer}
                onSwitch={switchServer}
                onDismiss={() => setServerMenuOpen(false)}
              />
            </div>
          )}
          <SessionTree
            sessions={sessions}
            pins={pins}
            sortOrder={sortOrder}
            projects={projects}
            draftGroups={draftGroups}
            draftTabs={draftTabs}
            openBySession={openBySession}
            activeSessionId={activeSessionId}
            selectedId={selectedId}
            unread={notifications.states}
            terminalSessions={sessionsWithRunningTerminal}
            draftNodes={draftNodes}
            onOpenSession={(sessionId) => {
              closeMobileDrawer()
              openSession(sessionId)
            }}
            onSelectDraft={(node) => {
              closeMobileDrawer()
              selectNode(node)
            }}
            onTogglePin={togglePin}
            onMoveSession={moveSession}
            onMoveDraft={moveDraft}
            onReorderSessions={reorderSessions}
            onCreateGroup={createGroup}
            onRenameGroup={renameGroup}
            onMoveGroup={moveGroup}
            onDeleteGroup={deleteGroup}
            onCreateSessionInGroup={createSessionInGroup}
            onRenameSession={(sessionId, title) => {
              const text = (title || '').trim()
              if (text) {
                window.mica.stats
                  .renameSession(sessionId, title)
                  .then(() => refreshSessions())
                  .catch((error) => console.error('rename session failed', error))
              }
            }}
            onRenameDraft={(nodeId, text) =>
              setNodes((items) =>
                items.map((node) => (node.id === nodeId ? { ...node, text } : node))
              )
            }
            onDeleteSession={deleteSession}
            onDeleteDraft={deleteDraft}
          />
        </aside>
        <main
          className={`relative flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-canvas ${!isMobile && rightPanelMaximized ? 'invisible' : ''}`}
        >
          <header
            className={`safe-top drag-region flex h-10 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-3 text-xs font-medium text-white/60 transition-[padding] ${!isMobile && sidebarCollapsed ? 'pl-30' : ''}`}
          >
            {isMobile && (
              <button
                type="button"
                title="会话列表"
                aria-label="会话列表"
                aria-expanded={mobileDrawer === 'sessions'}
                className="no-drag -ml-1 grid size-7 shrink-0 place-items-center rounded-md text-white/55 hover:bg-white/[.06] hover:text-white"
                onClick={() =>
                  setMobileDrawer((value) => (value === 'sessions' ? null : 'sessions'))
                }
              >
                <IconMenu2 size={16} />
              </button>
            )}
            {view === 'chat' ? (
              <span className="min-w-0 truncate text-white/75">
                {terminalNodes.find((node) => node.id === activeId)?.text || '对话'}
              </span>
            ) : PAGE_HEADER[view] ? (
              <>
                {(() => {
                  const { label, Icon } = PAGE_HEADER[view]
                  return (
                    <>
                      <Icon size={13} className="shrink-0 opacity-80" />
                      <span>{label}</span>
                    </>
                  )
                })()}
                <button
                  type="button"
                  title="返回对话"
                  aria-label="返回对话"
                  className="no-drag ml-auto flex h-6 items-center gap-1 rounded-md px-2 text-white/50 transition-colors hover:bg-white/[.06] hover:text-white"
                  onClick={() => setView('chat')}
                >
                  <IconMessage size={13} />
                  <span>返回对话</span>
                </button>
              </>
            ) : null}
            <button
              type="button"
              title={rightPanelVisible ? '收起右侧面板 (⇧⌘I)' : '展开右侧面板 (⇧⌘I)'}
              aria-label={rightPanelVisible ? '收起右侧面板' : '展开右侧面板'}
              className="no-drag ml-auto grid size-7 place-items-center rounded-md text-white/55 transition-colors hover:bg-white/[.06] hover:text-white"
              onClick={toggleRightPanel}
            >
              {rightPanelVisible ? (
                <IconLayoutSidebarRightCollapse size={15} />
              ) : (
                <IconLayoutSidebarRightExpand size={15} />
              )}
            </button>
          </header>
          <div ref={contentRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <Suspense fallback={null}>
              <StatsView visible={view === 'stats'} />
            </Suspense>
            <Suspense fallback={null}>
              <SettingsView visible={view === 'settings'} />
            </Suspense>
            <ChatView
              node={terminalNodes.find((node) => node.id === activeId)}
              cwd={terminalCwd(activeId)}
              visible={view === 'chat'}
              onSessionBound={setSessionId}
              onOpenFile={openChatFile}
              onNewSession={createChatSession}
              onResumeSession={openSession}
              onOpenTerminal={openChatTerminal}
              onOpenSettings={() => setView('settings')}
              onSessionRenamed={refreshSessions}
            />
          </div>
          {!activeId && view === 'chat' && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-10 grid place-items-center text-[13px] text-white/25">
              选择或新建一个会话
            </div>
          )}
          <footer className="safe-bottom flex h-7 shrink-0 items-center justify-between gap-4 border-t border-white/10 bg-black/10 px-3 text-xs text-white/65 no-drag">
            {gitIsCurrent && git.status?.root ? (
              <button
                ref={branchButtonRef}
                type="button"
                title="切换或创建 Git 分支"
                aria-haspopup="dialog"
                aria-expanded={branchPickerOpen}
                // 有路径时给分支名封顶并把宽度让给路径；没有路径就用满可用宽度。
                className={`-ml-1.5 flex h-full items-center gap-1.5 rounded-sm px-1.5 text-left hover:bg-white/[.08] hover:text-white ${
                  activeCwd ? 'max-w-[45%] shrink-0' : 'min-w-0'
                }`}
                onClick={() => setBranchPickerOpen(true)}
              >
                <IconGitBranch size={13} className="shrink-0" />
                <span className="truncate">{git.status.branch || 'detached'}</span>
              </button>
            ) : null}
            {activeCwd && (
              <button
                type="button"
                title={
                  cwdValid
                    ? activeCwd
                    : `${activeCwd}\n当前目录不存在或已被移动，点击切换正确的项目目录`
                }
                className={`ml-auto min-w-0 truncate rounded-sm px-1.5 py-0.5 text-right hover:bg-white/[.06] ${
                  cwdValid
                    ? 'text-white/35 hover:text-white/75'
                    : 'text-red-400 hover:bg-red-500/[.1] hover:text-red-300'
                }`}
                onClick={() => setCwdModalOpen(true)}
              >
                {activeCwd}
              </button>
            )}
          </footer>
        </main>
        <aside
          className={
            isMobile
              ? `safe-top safe-bottom absolute inset-y-0 right-0 z-[9100] flex w-full min-w-0 flex-col overflow-hidden border-l border-line bg-panel shadow-2xl transition-transform duration-200 ${
                  mobileDrawer === 'right' ? 'translate-x-0' : 'translate-x-full'
                }`
              : `safe-top safe-bottom relative flex min-w-0 flex-col overflow-hidden border-l border-line bg-panel ${rightPanelOpen ? '' : 'invisible pointer-events-none'}`
          }
          style={
            isMobile
              ? undefined
              : { width: rightPanelMaximized ? undefined : `var(${RIGHT_PANEL_WIDTH_VAR})` }
          }
          aria-label="右侧面板"
        >
          {!isMobile && rightPanelOpen && !rightPanelMaximized && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整右侧面板宽度"
              title="拖动调整右侧面板宽度"
              className={`absolute inset-y-0 left-[-2px] z-10 w-1 cursor-col-resize touch-none select-none hover:bg-white/20 ${resizingRightPanel ? 'bg-white/30' : ''}`}
              onPointerDown={startRightPanelResize}
            />
          )}
          <div
            className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2"
            style={{ paddingLeft: !isMobile && rightPanelMaximized ? 74 : undefined }}
          >
            <button
              type="button"
              title={rightPanelMaximized ? '恢复主区' : '最大化右侧面板'}
              aria-label={rightPanelMaximized ? '恢复主区' : '最大化右侧面板'}
              aria-pressed={rightPanelMaximized}
              className={`h-6 w-6 shrink-0 place-items-center rounded-md text-white/55 transition-colors hover:bg-white/[.06] hover:text-white ${isMobile ? 'hidden' : 'grid'}`}
              onClick={() => setRightPanelMaximized((value) => !value)}
            >
              {rightPanelMaximized ? (
                <IconLayoutSidebarRightCollapse size={14} />
              ) : (
                <IconLayoutSidebarRightExpand size={14} />
              )}
            </button>
            <button
              type="button"
              aria-pressed={rightPanelTab === 'files'}
              title="文件"
              className={`flex h-6 flex-1 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
                rightPanelTab === 'files'
                  ? 'bg-white/[.10] text-white'
                  : 'text-white/55 hover:bg-white/[.05] hover:text-white'
              }`}
              onClick={() => setRightPanelTab('files')}
            >
              <IconFolderOpen size={13} className="shrink-0 opacity-75" />
              <span>文件</span>
            </button>
            <button
              type="button"
              aria-pressed={rightPanelTab === 'terminal'}
              title="终端"
              className={`flex h-6 flex-1 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
                rightPanelTab === 'terminal'
                  ? 'bg-white/[.10] text-white'
                  : 'text-white/55 hover:bg-white/[.05] hover:text-white'
              }`}
              onClick={openRightTerminalTab}
            >
              <IconTerminal2 size={13} className="shrink-0 opacity-75" />
              <span>终端</span>
            </button>
            {isMobile && (
              <button
                type="button"
                title="关闭"
                aria-label="关闭右侧面板"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/55 transition-colors hover:bg-white/[.06] hover:text-white"
                onClick={closeMobileDrawer}
              >
                <IconX size={14} />
              </button>
            )}
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {rightPanelTab === 'terminal' && (
              <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-1 no-drag">
                <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
                  {rightTerms.map((node) => {
                    const active = node.id === rightActiveTerm
                    return (
                      <div
                        key={node.id}
                        className={`group flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
                          active
                            ? 'bg-white/[.10] text-white'
                            : 'text-white/55 hover:bg-white/[.05] hover:text-white'
                        }`}
                      >
                        <button
                          type="button"
                          title={node.text}
                          className="flex min-w-0 items-center gap-1.5"
                          onClick={() =>
                            setRightActiveTermByChat((prev) => ({ ...prev, [activeId]: node.id }))
                          }
                        >
                          <IconTerminal2 size={12} className="shrink-0 opacity-75" />
                          <span className="max-w-36 truncate">{node.text}</span>
                        </button>
                        <button
                          type="button"
                          title="关闭终端"
                          className={`grid h-4 w-4 shrink-0 place-items-center rounded text-white/40 transition-opacity hover:bg-white/[.08] hover:text-white ${
                            isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                          }`}
                          onClick={() => closeRightTerm(node.id)}
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
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/55 transition-colors hover:bg-white/[.06] hover:text-white"
                  onClick={createRightTerm}
                >
                  <IconPlus size={14} />
                </button>
              </div>
            )}
            <Suspense fallback={null}>
              <FilesView
                ref={filesRef}
                root={gitIsCurrent ? git.cwd : null}
                visible={rightPanelTab === 'files'}
                askText={askText}
                gitCwd={gitIsCurrent ? git.cwd : null}
                gitRepository={repository}
                gitLoading={gitIsCurrent ? git.loading : true}
                gitBranch={gitIsCurrent ? git.status?.branch || null : null}
                onCornerResizeStart={null}
              />
            </Suspense>
            <Suspense fallback={null}>
              <TerminalHost
                ref={terminalRef}
                nodes={allRightTerms}
                activeId={rightActiveTerm}
                visible={rightPanelTab === 'terminal'}
                pane="terminal"
                docked={false}
                sidebarCollapsed={sidebarCollapsed}
                resolveCwd={rightTermCwd}
                commandFor={commandFor}
                onRead={(id, reason) => {
                  touchRightTerm(id)
                  notifications.markRead(id, reason)
                }}
                onMicaExit={closeRightTerm}
              />
            </Suspense>
            {isMobile && rightPanelTab === 'terminal' && rightActiveTerm && (
              <TerminalKeyBar onSend={sendTerminalKey} />
            )}
          </div>
        </aside>
      </div>
      {!rightPanelMaximized && !isMobile && (
        <button
          type="button"
          title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!sidebarCollapsed}
          className="fixed top-2 z-50 grid h-5.5 w-5 place-items-center rounded-sm text-white/55 hover:bg-white/[.06] hover:text-white no-drag"
          style={{
            left: sidebarCollapsed
              ? SIDEBAR_TOGGLE_COLLAPSED_LEFT
              : `calc(var(${SIDEBAR_WIDTH_VAR}) - ${SIDEBAR_TOGGLE_GUTTER}px)`
          }}
          onClick={setCollapsed}
        >
          <IconLayoutSidebarLeftCollapse size={16} />
        </button>
      )}
      {!rightPanelMaximized && (
        <Suspense fallback={null}>
          <QuickSearch
            getRoot={getSearchRoot}
            openFile={openSearchFile}
            closeActiveFile={closeSearchFile}
            disabled={branchPickerOpen || !!prompt}
          />
        </Suspense>
      )}
      {branchPickerOpen && git.cwd && (
        <BranchPicker
          cwd={git.cwd}
          askText={askText}
          canOperate={canChangeBranch}
          onChanged={branchChanged}
          onClose={closeBranchPicker}
        />
      )}
      {prompt && <TextPrompt prompt={prompt} onClose={closePrompt} />}
      {cwdModalOpen && (
        <CwdModal
          cwd={terminalCwd(activeId) || git.cwd || ''}
          invalid={!cwdValid}
          recent={recentSessionDirs}
          onClose={() => setCwdModalOpen(false)}
          onApply={(dir) => {
            setCwdModalOpen(false)
            changeChatCwd(dir)
          }}
        />
      )}
      {serverMenuOpen && !isMobile && (
        <ServerCardPopover
          anchorRef={serverRowRef}
          onPointerEnter={openServerMenu}
          onPointerLeave={scheduleServerMenuClose}
          current={currentServer}
          onSwitch={switchServer}
          onDismiss={() => setServerMenuOpen(false)}
        />
      )}
    </>
  )
}
