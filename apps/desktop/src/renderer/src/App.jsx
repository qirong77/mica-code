import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Folder,
  GitBranch,
  GitCompare,
  FolderOpen,
  MessageSquare,
  NotebookPen,
  PanelLeft,
  Rocket,
  Settings,
  SquareTerminal
} from 'lucide-react'
import { BranchPicker } from './BranchPicker'
import { ChatView, shortPath } from './ChatView'
import { FilesView } from './FilesView'
import { GitView } from './GitView'
import { NotesView } from './NotesView'
import { QuickSearch } from './QuickSearch'
import { SessionTree } from './SessionTree'
import { SettingsView } from './SettingsView'
import { StatsView } from './stats/StatsView'
import { SIDEBAR_TRANSITION_MS, TerminalHost } from './TerminalHost'
import { useLatest } from './hooks'
import {
  createColdStartTerminal,
  normalizeNodes,
  removeNode,
  resolveDefaultCwd,
  uid
} from './workspace'

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
  return localStorage.getItem('mica.chatDefaultCwd') || ''
}

function CwdModal({ cwd, invalid, recent, onClose, onApply }) {
  const [value, setValue] = useState(cwd || '')
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
        className="w-[min(440px,calc(100vw-32px))] rounded-md border border-white/15 bg-[#181818]/98 p-3.5 shadow-2xl"
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
            void window.mica.workspace
              .selectDirectory({ title: '选择工作目录', defaultPath: cwd })
              .then((result) => {
                if (result && !result.canceled && result.path) onApply(result.path)
              })
          }}
        >
          <FolderOpen size={13} />
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
        className="w-[min(420px,calc(100vw-32px))] rounded-md border border-white/15 bg-[#181818]/98 p-3.5 shadow-2xl"
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
            className="h-7 min-w-16 rounded-sm border border-white/10 bg-white/[.06] px-3 text-xs text-white hover:bg-white/10"
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

const tabClass =
  'no-drag relative flex min-w-19 items-center gap-1.5 px-2.5 text-xs hover:bg-white/[.04] hover:text-white/90'
const DEFAULT_TERMINAL_PANEL_HEIGHT = 260
const MIN_TERMINAL_PANEL_HEIGHT = 120
const MIN_FILE_PANEL_HEIGHT = 140
const DEFAULT_SIDEBAR_WIDTH = 260
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 640

function savedSidebarWidth() {
  const value = Number(localStorage.getItem('mica.sidebarWidth'))
  return Number.isFinite(value) && value >= MIN_SIDEBAR_WIDTH && value <= MAX_SIDEBAR_WIDTH
    ? value
    : DEFAULT_SIDEBAR_WIDTH
}

function savedTerminalPanelHeight() {
  const value = Number(localStorage.getItem('mica.terminalPanelHeight'))
  return Number.isFinite(value) && value >= MIN_TERMINAL_PANEL_HEIGHT
    ? value
    : DEFAULT_TERMINAL_PANEL_HEIGHT
}

export default function App() {
  const terminalRef = useRef(null)
  const filesRef = useRef(null)
  const branchButtonRef = useRef(null)
  const contentRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [nodes, setNodes] = useState([])
  const nodesRef = useLatest(nodes)
  const [activeId, setActiveId] = useState(null)
  const activeRef = useLatest(activeId)
  const [selectedId, setSelectedId] = useState(null)
  const [view, setView] = useState('terminal')
  const [terminalPanelHeight, setTerminalPanelHeight] = useState(savedTerminalPanelHeight)
  const terminalPanelHeightPreferenceRef = useRef(terminalPanelHeight)
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(true)
  const [resizingTerminal, setResizingTerminal] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('mica.sidebarCollapsed') === 'true'
  )
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const sidebarWidthRef = useRef(sidebarWidth)
  const dragStartRef = useRef(null)
  const [prompt, setPrompt] = useState(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [cwdModalOpen, setCwdModalOpen] = useState(false)
  const [cwdValid, setCwdValid] = useState(true)
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

  const togglePin = useCallback(
    (sessionId) => {
      const next = !pins[sessionId]
      setPins((current) => {
        const updated = { ...current }
        if (next) updated[sessionId] = Date.now()
        else delete updated[sessionId]
        return updated
      })
      window.mica.stats
        .setPin(sessionId, next)
        .then(setPins)
        .catch((error) => console.error('set pin failed', error))
    },
    [pins]
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

  useEffect(() => {
    window.mica.workspace
      .get()
      .then((workspace) => {
        const loaded = normalizeNodes(workspace?.nodes)
        const target = createColdStartTerminal(loaded, workspace?.activeId)
        setNodes([target])
        setActiveId(target.id)
        setSelectedId(target.id)
        setReady(true)
      })
      .catch((loadError) => {
        console.error(loadError)
        setError(String(loadError))
        setReady(true)
      })
  }, [])

  useEffect(() => {
    if (!ready) return undefined
    const timer = window.setTimeout(() => {
      const workspaceNodes = nodes.map((node) => ({
        id: node.id,
        parent: node.parent,
        text: node.text,
        type: node.type,
        ...(node.cwd ? { cwd: node.cwd } : {}),
        ...(node.type === 'terminal' && node.sessionId ? { sessionId: node.sessionId } : {}),
        ...(node.type === 'terminal' && node.command ? { command: node.command } : {}),
        ...(node.type === 'terminal' && node.lastActiveAt
          ? { lastActiveAt: node.lastActiveAt }
          : {}),
        state: {
          opened: node.type === 'folder' && !!node.state.opened,
          selected: node.id === selectedId
        }
      }))
      window.mica.workspace
        .save({ version: 1, activeId, nodes: workspaceNodes })
        .catch((saveError) => console.error('save workspace failed', saveError))
    }, 200)
    return () => clearTimeout(timer)
  }, [activeId, nodes, ready, selectedId])

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
      refreshSessions()
    },
    [refreshSessions]
  )
  const canBindSessionId = useCallback(
    (nodeId) => {
      const node = nodesRef.current.find((item) => item.id === nodeId)
      return !!node?.sessionId
    },
    [nodesRef]
  )
  const notifications = useNotifications(activeId, setSessionId, canBindSessionId)

  useEffect(() => {
    refreshSessions()
    refreshPins()
    refreshSort()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) refreshSessions()
    }, 3000)
    return () => clearInterval(timer)
  }, [refreshPins, refreshSessions, refreshSort])

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
        refreshGit({ quiet: true })
      }
    }, 10000)
    return () => clearInterval(timer)
  }, [refreshGit])

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
      setSelectedId(id)
      setActiveId(id)
    },
    [nodesRef]
  )

  const createSession = useCallback(
    (cwd = null) => {
      setView('chat')
      createTerminal({ cwd: cwd || terminalCwd(activeRef.current) || recentChatCwd() || null })
    },
    [activeRef, createTerminal, terminalCwd]
  )

  const selectNode = useCallback(
    (node, activate = true) => {
      setSelectedId(node.id)
      if (activate && node.type === 'terminal') {
        if (view === 'stats' || view === 'settings') setView('chat')
        setActiveId(node.id)
        setNodes((items) =>
          items.map((item) => (item.id === node.id ? { ...item, lastActiveAt: Date.now() } : item))
        )
        if (view === 'terminal' || view === 'files') {
          terminalRef.current
            ?.activate(node.id)
            .catch((activateError) => console.error('activate terminal failed', activateError))
        }
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

  const closeSession = useCallback(
    (sessionId) => {
      const node = nodesRef.current.find(
        (item) => item.type === 'terminal' && item.sessionId === sessionId
      )
      if (node) closeTab(node)
    },
    [closeTab, nodesRef]
  )

  const terminalNodes = useMemo(() => nodes.filter((node) => node.type === 'terminal'), [nodes])
  const openBySession = useMemo(() => {
    const map = {}
    for (const node of terminalNodes) if (node.sessionId) map[node.sessionId] = node.id
    return map
  }, [terminalNodes])
  const draftTabs = useMemo(() => terminalNodes.filter((node) => !node.sessionId), [terminalNodes])
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
  const gitCount = repository?.files?.length ? repository : null
  const getSearchRoot = useCallback(
    () => terminalRef.current?.getCwd(activeRef.current),
    [activeRef]
  )
  const openSearchFile = useCallback(async (path, position) => {
    setView('files')
    await filesRef.current?.openFile(path, position)
  }, [])
  const openChatFile = useCallback(async (path, position) => {
    setView('files')
    await filesRef.current?.openFile(path, position)
  }, [])
  const openChatTerminal = useCallback(() => setView('terminal'), [])
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
      localStorage.setItem('mica.chatDefaultCwd', dir)
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
    () => view === 'files' && !!filesRef.current?.closeActive(),
    [view]
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
    setSidebarCollapsed((value) => {
      localStorage.setItem('mica.sidebarCollapsed', String(!value))
      return !value
    })
  }
  const clampTerminalPanelHeight = useCallback((height) => {
    const available = contentRef.current?.clientHeight || window.innerHeight
    return Math.round(
      Math.min(
        Math.max(MIN_TERMINAL_PANEL_HEIGHT, available - MIN_FILE_PANEL_HEIGHT),
        Math.max(MIN_TERMINAL_PANEL_HEIGHT, height)
      )
    )
  }, [])
  const resizeTerminalPanel = useCallback(
    (height) => {
      const next = clampTerminalPanelHeight(height)
      terminalPanelHeightPreferenceRef.current = next
      setTerminalPanelHeight(next)
      localStorage.setItem('mica.terminalPanelHeight', String(next))
    },
    [clampTerminalPanelHeight]
  )
  const startTerminalResize = useCallback(
    (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      setResizingTerminal(true)
      document.body.classList.add('is-resizing-terminal')

      const onMove = (moveEvent) => {
        const bottom = contentRef.current?.getBoundingClientRect().bottom
        if (bottom != null) resizeTerminalPanel(bottom - moveEvent.clientY)
      }
      const finish = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
        document.body.classList.remove('is-resizing-terminal')
        setResizingTerminal(false)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    },
    [resizeTerminalPanel]
  )
  const startSidebarResize = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, width: sidebarWidthRef.current }
    setResizingSidebar(true)
    document.body.classList.add('is-resizing-sidebar')

    const onMove = (moveEvent) => {
      const width = dragStartRef.current
        ? dragStartRef.current.width + moveEvent.clientX - dragStartRef.current.x
        : sidebarWidthRef.current
      setSidebarWidth(Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))))
    }
    const finish = () => {
      dragStartRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-sidebar')
      setResizingSidebar(false)
      localStorage.setItem('mica.sidebarWidth', String(sidebarWidthRef.current))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [])
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
  }, [sidebarWidth])
  useEffect(() => {
    if (view !== 'files') return undefined
    const fitPanel = () => {
      setTerminalPanelHeight(clampTerminalPanelHeight(terminalPanelHeightPreferenceRef.current))
    }
    fitPanel()
    window.addEventListener('resize', fitPanel)
    return () => window.removeEventListener('resize', fitPanel)
  }, [clampTerminalPanelHeight, view])
  useEffect(() => {
    const toggleTerminalPanel = (event) => {
      if (
        view !== 'files' ||
        resizingTerminal ||
        event.repeat ||
        !event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.code !== 'Backquote'
      )
        return
      event.preventDefault()
      event.stopPropagation()
      setTerminalPanelOpen((open) => !open)
    }
    window.addEventListener('keydown', toggleTerminalPanel, true)
    return () => window.removeEventListener('keydown', toggleTerminalPanel, true)
  }, [resizingTerminal, view])

  if (!ready)
    return (
      <div className="grid size-full place-items-center bg-[#0e0e0e] text-xs text-white/35">
        正在加载工作区…
      </div>
    )

  const isPageView = view === 'stats' || view === 'settings'

  return (
    <>
      <div
        className={`grid size-full transition-[grid-template-columns] ${sidebarCollapsed ? 'grid-cols-[0_1fr]' : ''}`}
        style={
          sidebarCollapsed
            ? { transitionDuration: `${SIDEBAR_TRANSITION_MS}ms` }
            : { gridTemplateColumns: `${sidebarWidth}px 1fr`, transition: 'none' }
        }
      >
        <aside
          className={`relative flex min-w-0 flex-col overflow-hidden border-r border-white/10 bg-[#1c1c1d] ${sidebarCollapsed ? 'invisible pointer-events-none border-r-0' : ''}`}
          style={{ width: sidebarCollapsed ? undefined : sidebarWidth }}
        >
          {!sidebarCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧栏宽度"
              title="拖动调整侧栏宽度"
              className={`absolute inset-y-0 right-[-2px] z-10 w-1 cursor-col-resize touch-none select-none hover:bg-white/20 ${resizingSidebar ? 'bg-white/30' : ''}`}
              onPointerDown={startSidebarResize}
            />
          )}
          <div className="h-8.5 shrink-0 drag-region" aria-hidden="true" />
          <nav className="no-drag shrink-0 px-2.5 pb-1.5 pt-1">
            <button
              type="button"
              title="New Session"
              className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] font-medium text-white/60 transition-colors hover:bg-white/[.05] hover:text-white"
              onClick={() => createSession()}
            >
              <Rocket size={14} className="shrink-0 opacity-80" />
              <span>New Session</span>
            </button>
            <button
              type="button"
              aria-pressed={view === 'stats'}
              title="查看使用统计"
              className={`flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] font-medium transition-colors ${
                view === 'stats'
                  ? 'bg-white/[.09] text-white'
                  : 'text-white/60 hover:bg-white/[.05] hover:text-white'
              }`}
              onClick={() => setView('stats')}
            >
              <BarChart3 size={14} className="shrink-0 opacity-80" />
              <span>Stats</span>
            </button>
            <button
              type="button"
              aria-pressed={view === 'settings'}
              title="打开 Mica 配置页面"
              className={`mt-px flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] font-medium transition-colors ${
                view === 'settings'
                  ? 'bg-white/[.09] text-white'
                  : 'text-white/60 hover:bg-white/[.05] hover:text-white'
              }`}
              onClick={() => setView('settings')}
            >
              <Settings size={14} className="shrink-0 opacity-80" />
              <span>Settings</span>
            </button>
          </nav>
          <SessionTree
            sessions={sessions}
            pins={pins}
            sortOrder={sortOrder}
            draftTabs={draftTabs}
            openBySession={openBySession}
            activeSessionId={activeSessionId}
            selectedId={selectedId}
            unread={notifications.states}
            homeDir={window.mica.homeDir}
            onOpenSession={openSession}
            onSelectDraft={(node) => selectNode(node)}
            onTogglePin={togglePin}
            onReorderSessions={reorderSessions}
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
            onCloseSession={closeSession}
            onCloseDraft={closeTerminal}
            onCreateSession={createSession}
          />
        </aside>
        <main className="relative flex min-w-0 min-h-0 flex-col overflow-hidden bg-[#0e0e0e]">
          {isPageView ? (
            <header
              className={`drag-region flex h-8.5 shrink-0 items-center gap-1.5 border-b border-white/10 px-3 text-xs font-medium text-white/60 transition-[padding] ${sidebarCollapsed ? 'pl-30' : ''}`}
            >
              {view === 'stats' ? (
                <BarChart3 size={13} className="shrink-0 opacity-80" />
              ) : (
                <Settings size={13} className="shrink-0 opacity-80" />
              )}
              <span>{view === 'stats' ? 'Stats' : 'Settings'}</span>
            </header>
          ) : (
            <nav
              role="tablist"
              aria-label="工作区视图"
              className={`drag-region mb-0.5 flex h-9 shrink-0 items-stretch border-b border-white/10 transition-[padding] ${sidebarCollapsed ? 'pl-30' : ''}`}
            >
              {[
                ['chat', 'Chat', MessageSquare],
                ['terminal', '终端', SquareTerminal],
                ['files', '文件夹', Folder],
                ['git-compare', 'Git', GitCompare],
                ['notes', 'Notes', NotebookPen]
              ].map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={view === id}
                  className={`${tabClass} ${view === id ? 'text-white' : 'text-white/40'}`}
                  onClick={() => setView(id)}
                >
                  <Icon size={14} />
                  <span>{label}</span>
                  {id === 'git-compare' && gitCount && (
                    <span className="ml-0.5 flex gap-1 font-mono text-[10px]">
                      <span className="text-[#55b982]">+{gitCount.additions}</span>
                      <span className="text-[#e06c75]">−{gitCount.deletions}</span>
                    </span>
                  )}
                  {view === id && (
                    <span className="absolute inset-x-2.5 bottom-[-1px] h-px bg-white/90" />
                  )}
                </button>
              ))}
            </nav>
          )}
          <div ref={contentRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <FilesView
              ref={filesRef}
              root={gitIsCurrent ? git.cwd : null}
              visible={view === 'files'}
              askText={askText}
              onCornerResizeStart={terminalPanelOpen ? startTerminalResize : null}
            />
            <GitView
              cwd={gitIsCurrent ? git.cwd : null}
              repository={repository}
              loading={gitIsCurrent ? git.loading : true}
              visible={view === 'git-compare'}
            />
            <NotesView visible={view === 'notes'} />
            <StatsView visible={view === 'stats'} />
            <SettingsView visible={view === 'settings'} />
            <ChatView
              node={terminalNodes.find((node) => node.id === activeId)}
              cwd={terminalCwd(activeId)}
              visible={view === 'chat'}
              onSessionBound={setSessionId}
              onOpenFile={openChatFile}
              onNewSession={createChatSession}
              onResumeSession={openSession}
              onOpenTerminal={openChatTerminal}
              onSessionRenamed={refreshSessions}
            />
            {view === 'files' && terminalPanelOpen && (
              <div
                className="terminal-panel-resizer z-20 h-2.5 shrink-0 no-drag"
                role="separator"
                aria-label="调整终端高度"
                aria-orientation="horizontal"
                aria-valuemin={MIN_TERMINAL_PANEL_HEIGHT}
                aria-valuemax={Math.max(
                  MIN_TERMINAL_PANEL_HEIGHT,
                  (contentRef.current?.clientHeight || window.innerHeight) - MIN_FILE_PANEL_HEIGHT
                )}
                aria-valuenow={terminalPanelHeight}
                data-resizing={resizingTerminal}
                tabIndex={0}
                onPointerDown={startTerminalResize}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                  event.preventDefault()
                  resizeTerminalPanel(terminalPanelHeight + (event.key === 'ArrowUp' ? 20 : -20))
                }}
              />
            )}
            <TerminalHost
              ref={terminalRef}
              nodes={terminalNodes}
              activeId={activeId}
              visible={view === 'terminal' || (view === 'files' && terminalPanelOpen)}
              pane="terminal"
              docked={view === 'files'}
              height={terminalPanelHeight}
              sidebarCollapsed={sidebarCollapsed}
              resolveCwd={terminalCwd}
              commandFor={commandFor}
              onRead={(id, reason) => notifications.markRead(id, reason)}
              onMicaExit={closeTerminal}
            />
          </div>
          {!activeId && view !== 'stats' && view !== 'settings' && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-9 grid place-items-center text-[13px] text-white/25">
              {error || '选择或新建一个会话'}
            </div>
          )}
          <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-white/10 bg-black/10 px-3 text-xs text-white/65 no-drag">
            {gitIsCurrent && git.status?.root ? (
              <button
                ref={branchButtonRef}
                type="button"
                title="切换或创建 Git 分支"
                aria-haspopup="dialog"
                aria-expanded={branchPickerOpen}
                className="-ml-1.5 flex h-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left hover:bg-white/[.08] hover:text-white"
                onClick={() => setBranchPickerOpen(true)}
              >
                <GitBranch size={13} className="shrink-0" />
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
                className={`ml-auto min-w-0 max-w-[45%] truncate rounded-sm px-1.5 py-0.5 text-right hover:bg-white/[.06] ${
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
      </div>
      <button
        type="button"
        title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        aria-expanded={!sidebarCollapsed}
        className="fixed left-21.5 top-2 z-50 grid h-5.5 w-5 place-items-center rounded-sm text-white/55 hover:bg-white/[.06] hover:text-white no-drag"
        onClick={setCollapsed}
      >
        <PanelLeft size={16} />
      </button>
      <QuickSearch
        getRoot={getSearchRoot}
        openFile={openSearchFile}
        closeActiveFile={closeSearchFile}
        disabled={branchPickerOpen || !!prompt}
      />
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
    </>
  )
}
