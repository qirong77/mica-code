import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Folder,
  FolderPlus,
  GitBranch,
  GitCompare,
  NotebookPen,
  PanelLeft,
  Plus,
  SquareTerminal
} from 'lucide-react'
import { BranchPicker } from './BranchPicker'
import { FilesView } from './FilesView'
import { GitView } from './GitView'
import { NotesView } from './NotesView'
import { QuickSearch } from './QuickSearch'
import { SessionTree } from './SessionTree'
import { SIDEBAR_TRANSITION_MS, TerminalHost } from './TerminalHost'
import { useLatest } from './hooks'
import {
  childMap,
  flattenNodes,
  moveNode,
  normalizeNodes,
  removeNode,
  resolveDefaultCwd,
  terminalIdsUnder,
  uid
} from './workspace'

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

function useNotifications(activeId, onSessionId) {
  const [states, setStates] = useState({})
  const statesRef = useLatest(states)
  const activeRef = useLatest(activeId)
  const sessionRef = useLatest(onSessionId)
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
        if (item?.terminalId && (item.unread || item.running))
          next[item.terminalId] = {
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
          .markRead(id)
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
        setTerminalState(payload.terminalId, { unread: false })
      } else if (payload?.state?.terminalId) {
        const state = payload.state
        setTerminalState(state.terminalId, state)
        if (state.sessionId) sessionRef.current(state.terminalId, state.sessionId)
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
  }, [activeRef, markRead, playCompleted, sessionRef, setTerminalState, sync])

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
  const [editingId, setEditingId] = useState(null)
  const [view, setView] = useState('terminal')
  const [terminalPanelHeight, setTerminalPanelHeight] = useState(savedTerminalPanelHeight)
  const terminalPanelHeightPreferenceRef = useRef(terminalPanelHeight)
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(true)
  const [resizingTerminal, setResizingTerminal] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('mica.sidebarCollapsed') === 'true'
  )
  const [prompt, setPrompt] = useState(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
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

  useEffect(() => {
    window.mica.workspace
      .get()
      .then((workspace) => {
        const loaded = normalizeNodes(workspace?.nodes)
        const target =
          loaded.find((node) => node.id === workspace?.activeId && node.type === 'terminal') ||
          loaded.find((node) => node.type === 'terminal')
        setNodes(loaded)
        setActiveId(target?.id || null)
        setSelectedId(target?.id || null)
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
        ...(node.type === 'folder' && node.cwd ? { cwd: node.cwd } : {}),
        ...(node.type === 'terminal' && node.sessionId ? { sessionId: node.sessionId } : {}),
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
      return node ? resolveDefaultCwd(nodesRef.current, node.parent) : null
    },
    [nodesRef]
  )

  const setSessionId = useCallback((id, sessionId) => {
    const value = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!value) return
    setNodes((items) =>
      items.map((node) =>
        node.id === id && node.type === 'terminal' && node.sessionId !== value
          ? { ...node, sessionId: value }
          : node
      )
    )
  }, [])
  const clearSessionId = useCallback((id) => {
    setNodes((items) =>
      items.map((node) =>
        node.id === id && node.type === 'terminal' && node.sessionId
          ? { ...node, sessionId: null }
          : node
      )
    )
  }, [])
  const notifications = useNotifications(activeId, setSessionId)

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
        let [summary, status] = await Promise.all([
          window.mica.git.summary(cwd),
          window.mica.git.status(cwd)
        ])
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

  const createFolder = useCallback((parent = '#') => {
    const id = uid('folder')
    setNodes((items) => {
      const opened = items.map((node) =>
        node.id === parent ? { ...node, state: { ...node.state, opened: true } } : node
      )
      return flattenNodes([
        ...opened,
        {
          id,
          parent,
          text: '新建文件夹',
          type: 'folder',
          cwd: null,
          state: { opened: true, selected: false }
        }
      ])
    })
    setSelectedId(id)
    setEditingId(id)
  }, [])

  const createTerminal = useCallback(
    (parent) => {
      const current = nodesRef.current
      const selected = current.find((node) => node.id === parent)
      let target = selected?.type === 'folder' ? selected.id : selected?.parent || parent
      if (
        !target ||
        target === '#' ||
        !current.some((node) => node.id === target && node.type === 'folder')
      ) {
        target =
          (childMap(current).get('#') || []).find((node) => node.type === 'folder')?.id ||
          current.find((node) => node.type === 'folder')?.id ||
          '#'
      }
      const id = uid('term')
      const count = current.filter((node) => node.type === 'terminal').length + 1
      setNodes((items) => {
        const opened = items.map((node) =>
          node.id === target ? { ...node, state: { ...node.state, opened: true } } : node
        )
        return flattenNodes([
          ...opened,
          {
            id,
            parent: target,
            text: `Terminal ${count}`,
            type: 'terminal',
            sessionId: null,
            state: { opened: false, selected: false }
          }
        ])
      })
      setSelectedId(id)
      setActiveId(id)
      setEditingId(id)
    },
    [nodesRef]
  )

  const selectNode = useCallback((node, activate = true) => {
    setSelectedId(node.id)
    if (activate && node.type === 'terminal') {
      setActiveId(node.id)
      terminalRef.current
        ?.activate(node.id)
        .catch((activateError) => console.error('activate terminal failed', activateError))
    }
  }, [])

  const disposeAndRemove = useCallback(
    async (node) => {
      const current = nodesRef.current
      const ids = node.type === 'folder' ? terminalIdsUnder(current, node.id) : [node.id]
      const next = removeNode(current, node.id)
      setNodes((items) => removeNode(items, node.id))
      if (ids.includes(activeRef.current)) {
        const terminal = next.find((item) => item.type === 'terminal')
        setActiveId(terminal?.id || null)
        setSelectedId(terminal?.id || null)
      } else if (selectedId === node.id) {
        setSelectedId(activeRef.current)
      }
      const disposed = await Promise.allSettled(ids.map((id) => terminalRef.current?.dispose(id)))
      for (const result of disposed) {
        if (result.status === 'rejected') console.error('dispose terminal failed', result.reason)
      }
    },
    [activeRef, nodesRef, selectedId]
  )

  const handleAction = useCallback(
    async (action, node) => {
      if (action === 'rename') setEditingId(node.id)
      else if (action === 'createFolder') createFolder(node.id)
      else if (action === 'createTerminal') createTerminal(node.id)
      else if (action === 'setDefaultPath') {
        const value = await askText(
          '设置默认路径',
          node.cwd || '',
          '该文件夹下新建的终端将使用此路径作为工作目录。留空可清除。'
        )
        if (value !== null)
          setNodes((items) =>
            items.map((item) => (item.id === node.id ? { ...item, cwd: value || null } : item))
          )
      } else if (action === 'remove') await disposeAndRemove(node)
    },
    [askText, createFolder, createTerminal, disposeAndRemove]
  )

  const terminalNodes = useMemo(() => nodes.filter((node) => node.type === 'terminal'), [nodes])
  const gitIsCurrent = git.terminalId === activeId
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

  return (
    <>
      <div
        className={`grid size-full transition-[grid-template-columns] ${sidebarCollapsed ? 'grid-cols-[0_1fr]' : 'grid-cols-[260px_1fr]'}`}
        style={{ transitionDuration: `${SIDEBAR_TRANSITION_MS}ms` }}
      >
        <aside
          className={`flex min-w-0 flex-col overflow-hidden border-r border-white/10 bg-[#1c1c1d] ${sidebarCollapsed ? 'invisible pointer-events-none border-r-0' : ''}`}
        >
          <div className="h-8.5 shrink-0 drag-region" aria-hidden="true" />
          <header className="flex items-center justify-between gap-2.5 px-2.5 pb-2.5 pt-1 no-drag">
            <div className="flex min-w-0 items-center gap-2 pl-1">
              <span className="grid size-6 shrink-0 place-items-center rounded-[5px] bg-[#1677ff] text-sm font-bold text-white">
                M
              </span>
              <span className="text-[13px] font-semibold text-white/95"></span>
            </div>
            <div className="flex gap-0.5">
              <button
                type="button"
                title="新建文件夹"
                aria-label="新建文件夹"
                className="grid size-7 place-items-center rounded-sm text-white/35 hover:bg-white/[.06] hover:text-white"
                onClick={() => {
                  const selected = nodes.find((node) => node.id === selectedId)
                  createFolder(
                    selected?.type === 'folder'
                      ? selected.id
                      : selected?.parent !== '#'
                        ? selected?.parent
                        : '#'
                  )
                }}
              >
                <FolderPlus size={15} />
              </button>
              <button
                type="button"
                title="新建终端"
                aria-label="新建终端"
                className="grid size-7 place-items-center rounded-sm text-white/35 hover:bg-white/[.06] hover:text-white"
                onClick={() => createTerminal(selectedId)}
              >
                <Plus size={15} />
              </button>
            </div>
          </header>
          <SessionTree
            nodes={nodes}
            selectedId={selectedId}
            editingId={editingId}
            unread={notifications.states}
            onSelect={selectNode}
            onToggle={(id) =>
              setNodes((items) =>
                items.map((node) =>
                  node.id === id
                    ? { ...node, state: { ...node.state, opened: !node.state.opened } }
                    : node
                )
              )
            }
            onRename={(id, value) => {
              const text = value.trim()
              if (text)
                setNodes((items) =>
                  items.map((node) => (node.id === id ? { ...node, text } : node))
                )
              setEditingId(null)
            }}
            onCancelEdit={() => setEditingId(null)}
            onStartEdit={setEditingId}
            onMove={(id, target, position) =>
              setNodes((items) => moveNode(items, id, target, position))
            }
            onAction={(action, node) => handleAction(action, node).catch(console.error)}
          />
        </aside>
        <main className="relative flex min-w-0 min-h-0 flex-col overflow-hidden bg-[#0e0e0e]">
          <nav
            role="tablist"
            aria-label="工作区视图"
            className={`drag-region mb-0.5 flex h-9 shrink-0 items-stretch border-b border-white/10 transition-[padding] ${sidebarCollapsed ? 'pl-30' : ''}`}
          >
            {[
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
              docked={view === 'files'}
              height={terminalPanelHeight}
              sidebarCollapsed={sidebarCollapsed}
              resolveCwd={terminalCwd}
              onRead={(id, reason) => notifications.markRead(id, reason)}
              onExitCommand={clearSessionId}
            />
          </div>
          {!activeId && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-9 grid place-items-center text-[13px] text-white/25">
              {error || '选择或新建一个终端会话'}
            </div>
          )}
          <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-white/10 bg-black/10 px-3 text-xs text-white/65 no-drag">
            {gitIsCurrent && git.status?.root ? (
              <>
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
                <span className="min-w-0 truncate text-right text-white/35">{git.status.root}</span>
              </>
            ) : null}
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
    </>
  )
}
