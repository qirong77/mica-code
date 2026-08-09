import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { createFileLinkProvider, openWebLink } from './terminal-links'
import { useLatest } from './hooks'

const terminalTheme = {
  background: '#0e0e0e',
  foreground: '#eaeaea',
  cursor: '#eaeaea',
  selectionBackground: 'rgba(234, 234, 234, 0.22)',
  black: '#1a1a1a',
  red: '#e75e78',
  green: '#55a583',
  yellow: '#c08532',
  blue: '#8a8a8a',
  magenta: '#9e94d5',
  cyan: '#6f9ba6',
  white: '#eaeaea',
  brightBlack: '#6a6a6a',
  brightRed: '#f2685c',
  brightGreen: '#46c57a',
  brightYellow: '#f2b33d',
  brightBlue: '#b0b0b0',
  brightMagenta: '#907bc9',
  brightCyan: '#2dd4bf',
  brightWhite: '#ffffff'
}

export const SIDEBAR_TRANSITION_MS = 150
const SIDEBAR_FIT_SETTLE_MS = SIDEBAR_TRANSITION_MS + 20

export const PANE_MICA = 'mica'
export const PANE_TERMINAL = 'terminal'

function ptyIdFor(sessionId, pane) {
  return `${sessionId}:${pane}`
}

function parsePtyId(ptyId) {
  const index = ptyId.lastIndexOf(':')
  if (index > 0) return { sessionId: ptyId.slice(0, index), pane: ptyId.slice(index + 1) }
  return { sessionId: ptyId, pane: PANE_MICA }
}

function interceptTerminalKey(event, id) {
  const key = event.key.toLowerCase()
  const mod = event.metaKey || event.ctrlKey
  const plain = !event.altKey && !event.shiftKey
  let data = null

  if (!mod && !event.altKey && event.shiftKey && key === 'enter') data = '\x1b[13;2u'
  else if (mod && plain && key === 'backspace') data = '\x15'
  else if (mod && plain && key === 'delete') data = '\x01\x0b'
  else if (mod && plain && key === 'arrowleft') data = '\x01'
  else if (mod && plain && key === 'arrowright') data = '\x05'
  else if (!mod && event.altKey && !event.shiftKey && key === 'backspace') data = '\x1b\x7f'
  else if (!mod && event.altKey && !event.shiftKey && key === 'delete') data = '\x1bd'
  else if (!mod && event.altKey && !event.shiftKey && key === 'arrowleft') data = '\x1bb'
  else if (!mod && event.altKey && !event.shiftKey && key === 'arrowright') data = '\x1bf'

  if (data === null) return
  event.preventDefault()
  event.stopImmediatePropagation()
  window.mica.terminal.write(id, data)
}

function TerminalPane({ ptyId, sessionId, active, onRegister, onRead }) {
  const hostRef = useRef(null)
  const onReadRef = useLatest(onRead)

  useEffect(() => {
    const host = hostRef.current
    const build = window.mica.windowsBuildNumber
    const windowsPty =
      window.mica.platform === 'win32' && Number.isInteger(build)
        ? { backend: build >= 18309 ? 'conpty' : 'winpty', buildNumber: build }
        : null
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"JetBrains Mono", "Cascadia Code", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
      theme: terminalTheme,
      allowProposedApi: true,
      ...(windowsPty ? { windowsPty } : {})
    })
    const fit = new FitAddon()
    const unicode = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(unicode)
    term.loadAddon(new WebLinksAddon((event, url) => openWebLink(event, url, window.mica.platform)))
    term.unicode.activeVersion = '11'
    term.open(host)
    term.registerLinkProvider(createFileLinkProvider(term, ptyId, window.mica.platform))

    const input = term.onData((data) => {
      window.mica.terminal.write(ptyId, data)
      onReadRef.current(sessionId, 'input')
    })
    const scroll = term.onScroll(() => onReadRef.current(sessionId, 'scroll'))
    const intercept = (event) => interceptTerminalKey(event, ptyId)
    const pointer = () => onReadRef.current(sessionId, 'pointer')
    host.addEventListener('keydown', intercept, true)
    host.addEventListener('keypress', intercept, true)
    host.addEventListener('pointerdown', pointer)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const key = event.key.toLowerCase()
      const mod = event.metaKey || event.ctrlKey
      if (mod && !event.altKey && !event.shiftKey && (key === 'k' || key === 'l')) {
        term.clear()
        window.mica.terminal
          .clear(ptyId)
          .catch((error) => console.error('clear terminal failed', error))
        return false
      }
      return true
    })

    const entry = { term, fit, el: host, ready: false, creating: null, lastPtySize: null }
    onRegister(ptyId, entry)
    return () => {
      onRegister(ptyId, null)
      input.dispose()
      scroll.dispose()
      host.removeEventListener('keydown', intercept, true)
      host.removeEventListener('keypress', intercept, true)
      host.removeEventListener('pointerdown', pointer)
      term.dispose()
    }
  }, [ptyId, sessionId, onReadRef, onRegister])

  return (
    <div
      ref={hostRef}
      className={`terminal-pane absolute inset-0 overflow-hidden bg-[#0e0e0e] ${active ? 'block' : 'hidden'}`}
      data-id={ptyId}
    />
  )
}

export const TerminalHost = forwardRef(function TerminalHost(
  {
    nodes,
    activeId,
    visible,
    docked = false,
    height,
    sidebarCollapsed,
    pane = PANE_MICA,
    resolveCwd,
    commandFor,
    onRead,
    onMicaExit
  },
  ref
) {
  const hostRef = useRef(null)
  const entries = useRef(new Map())
  const [mountedIds, setMountedIds] = useState(() => (activeId ? [activeId] : []))
  const [mountedPanes, setMountedPanes] = useState(() => {
    const map = new Map()
    if (activeId) map.set(activeId, new Set([PANE_MICA]))
    return map
  })
  const activeRef = useLatest(activeId)
  const visibleRef = useLatest(visible)
  const paneRef = useLatest(pane)
  const resolveCwdRef = useLatest(resolveCwd)
  const commandForRef = useLatest(commandFor)
  const onReadRef = useLatest(onRead)
  const onMicaExitRef = useLatest(onMicaExit)
  const frameRef = useRef(null)
  const focusRef = useRef(false)
  const sidebarCollapsedRef = useRef(sidebarCollapsed)
  const suppressObservedFitRef = useRef(false)

  const activePane = useCallback(
    () => (paneRef.current === PANE_TERMINAL ? PANE_TERMINAL : PANE_MICA),
    [paneRef]
  )

  const measurable = useCallback(
    (entry, id) => {
      const { sessionId, pane: entryPane } = parsePtyId(id)
      return (
        visibleRef.current &&
        activeRef.current === sessionId &&
        activePane() === entryPane &&
        hostRef.current?.clientWidth > 0 &&
        hostRef.current?.clientHeight > 0 &&
        entry.el.clientWidth > 0 &&
        entry.el.clientHeight > 0
      )
    },
    [activePane, activeRef, visibleRef]
  )

  const syncPtySize = useCallback((id, entry) => {
    if (!entry.ready || entry.term.cols < 2 || entry.term.rows < 1) return
    const size = `${entry.term.cols}x${entry.term.rows}`
    if (entry.lastPtySize === size) return
    entry.lastPtySize = size
    window.mica.terminal
      .resize(id, entry.term.cols, entry.term.rows)
      .then((resized) => {
        if (!resized && entry.lastPtySize === size) entry.lastPtySize = null
      })
      .catch((error) => {
        if (entry.lastPtySize === size) entry.lastPtySize = null
        console.error('resize terminal failed', error)
      })
  }, [])

  const fitActive = useCallback(
    (focus = false) => {
      const sessionId = activeRef.current
      if (!sessionId) return
      const ptyId = ptyIdFor(sessionId, activePane())
      const entry = entries.current.get(ptyId)
      if (!entry || !measurable(entry, ptyId)) return
      try {
        entry.fit.fit()
        syncPtySize(ptyId, entry)
        if (focus && activeRef.current === sessionId) {
          entry.term.focus()
          onReadRef.current(sessionId, 'activate')
        }
      } catch (error) {
        console.error('fit terminal failed', error)
      }
    },
    [activePane, activeRef, measurable, onReadRef, syncPtySize]
  )

  const scheduleFit = useCallback(
    ({ focus = false } = {}) => {
      focusRef.current ||= focus
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        const shouldFocus = focusRef.current
        focusRef.current = false
        fitActive(shouldFocus)
      })
    },
    [fitActive]
  )

  const activate = useCallback(
    async (sessionId, pane = activePane(), focus = true) => {
      const ptyId = ptyIdFor(sessionId, pane)
      const entry = entries.current.get(ptyId)
      if (!entry) return
      if (!entry.ready && !entry.creating) {
        let dimensions = null
        if (measurable(entry, ptyId)) {
          entry.fit.fit()
          dimensions = { cols: entry.term.cols, rows: entry.term.rows }
        }
        entry.creating = window.mica.terminal.create({
          id: ptyId,
          ...(pane === PANE_MICA ? { command: commandForRef.current(sessionId) || 'mica' } : {}),
          ...(resolveCwdRef.current(sessionId) ? { cwd: resolveCwdRef.current(sessionId) } : {}),
          ...(dimensions?.cols && dimensions?.rows ? dimensions : {})
        })
        try {
          const result = await entry.creating
          entry.ready = true
          entry.lastPtySize =
            !result?.reused && dimensions ? `${dimensions.cols}x${dimensions.rows}` : null
        } finally {
          entry.creating = null
        }
      }
      if (activeRef.current === sessionId && activePane() === pane) {
        scheduleFit({ focus })
      }
    },
    [activePane, activeRef, commandForRef, measurable, resolveCwdRef, scheduleFit]
  )

  const register = useCallback(
    (ptyId, entry) => {
      if (entry) {
        entries.current.set(ptyId, entry)
        const { sessionId, pane: entryPane } = parsePtyId(ptyId)
        if (activeRef.current === sessionId && activePane() === entryPane) {
          activate(sessionId, entryPane).catch((error) =>
            console.error('create terminal failed', error)
          )
        }
      } else entries.current.delete(ptyId)
    },
    [activate, activePane, activeRef]
  )

  useImperativeHandle(
    ref,
    () => ({
      activate(sessionId) {
        return activate(sessionId, activePane(), true)
      },
      async getCwd(sessionId = activeRef.current) {
        if (!sessionId) return null
        return (
          (await window.mica.terminal.getCwd(ptyIdFor(sessionId, activePane()))) ||
          resolveCwdRef.current(sessionId)
        )
      },
      async dispose(sessionId) {
        const ids = [ptyIdFor(sessionId, PANE_MICA), ptyIdFor(sessionId, PANE_TERMINAL), sessionId]
        for (const ptyId of ids) {
          const entry = entries.current.get(ptyId)
          if (entry) {
            entry.ready = false
            entry.lastPtySize = null
            entry.disposing = true
          }
          try {
            await window.mica.terminal.dispose(ptyId)
          } catch (error) {
            console.error('dispose terminal failed', error)
          }
        }
      },
      fit: scheduleFit
    }),
    [activate, activePane, activeRef, resolveCwdRef, scheduleFit]
  )

  useEffect(() => {
    if (activeId) {
      setMountedIds((ids) => (ids.includes(activeId) ? ids : [...ids, activeId]))
      setMountedPanes((prev) => {
        if (prev.has(activeId)) return prev
        const next = new Map(prev)
        next.set(activeId, new Set([PANE_MICA]))
        return next
      })
      activate(activeId, activePane()).catch((error) =>
        console.error('activate terminal failed', error)
      )
    }
  }, [activate, activeId, activePane])

  useEffect(() => {
    if (!activeId) return undefined
    const current = pane === PANE_TERMINAL ? PANE_TERMINAL : PANE_MICA
    setMountedPanes((prev) => {
      const panes = prev.get(activeId)
      if (panes && panes.has(current)) return prev
      const next = new Map(prev)
      next.set(activeId, panes ? new Set([...panes, current]) : new Set([current]))
      return next
    })
    activate(activeId, current).catch((error) => console.error('activate pane failed', error))
    return undefined
  }, [activate, activeId, pane])

  useEffect(() => {
    const valid = new Set(nodes.map((node) => node.id))
    setMountedIds((ids) => ids.filter((id) => valid.has(id)))
    setMountedPanes((prev) => {
      const next = new Map(prev)
      for (const id of next.keys()) {
        if (!valid.has(id)) next.delete(id)
      }
      return next
    })
  }, [nodes])

  useEffect(() => {
    scheduleFit({ focus: visible })
  }, [activeId, scheduleFit, visible])

  useLayoutEffect(() => {
    if (sidebarCollapsedRef.current === sidebarCollapsed) return
    sidebarCollapsedRef.current = sidebarCollapsed
    suppressObservedFitRef.current = true

    // The app shell animates its grid columns for 150ms. Fitting on every
    // ResizeObserver notification would resize the PTY repeatedly and make
    // full-screen terminal apps repaint for every intermediate column count.
    const timer = window.setTimeout(() => {
      suppressObservedFitRef.current = false
      scheduleFit()
    }, SIDEBAR_FIT_SETTLE_MS)

    return () => {
      clearTimeout(timer)
      suppressObservedFitRef.current = false
    }
  }, [scheduleFit, sidebarCollapsed])

  useEffect(() => {
    const offData = window.mica.terminal.onData(({ id, data }) =>
      entries.current.get(id)?.term.write(data)
    )
    const offExit = window.mica.terminal.onExit(({ id }) => {
      const entry = entries.current.get(id)
      if (!entry) return
      entry.ready = false
      entry.lastPtySize = null
      const { sessionId, pane } = parsePtyId(id)
      if (pane === PANE_MICA) {
        if (!entry.disposing) onMicaExitRef.current?.(sessionId)
      } else entry.term.writeln('\r\n[process exited]')
    })
    return () => {
      offData?.()
      offExit?.()
    }
  }, [onMicaExitRef])

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!suppressObservedFitRef.current) scheduleFit()
    })
    if (hostRef.current) observer.observe(hostRef.current)
    let query
    const onRatio = () => {
      bindRatio()
      scheduleFit()
    }
    const bindRatio = () => {
      query?.removeEventListener('change', onRatio)
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      query.addEventListener('change', onRatio, { once: true })
    }
    bindRatio()
    return () => {
      observer.disconnect()
      query?.removeEventListener('change', onRatio)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [scheduleFit])

  return (
    <section
      ref={hostRef}
      className={`relative min-h-0 overflow-hidden bg-[#0e0e0e] no-drag ${docked ? 'shrink-0' : 'flex-1'} ${visible ? '' : 'hidden'}`}
      style={docked ? { height } : undefined}
    >
      {mountedIds.map((sessionId) => {
        const isActiveSession = sessionId === activeId
        const panes = mountedPanes.get(sessionId) || new Set([PANE_MICA])
        return (
          <div
            key={sessionId}
            className={`absolute inset-0 min-h-0 bg-[#0e0e0e] ${isActiveSession ? 'block' : 'hidden'}`}
          >
            {panes.has(PANE_MICA) && (
              <TerminalPane
                ptyId={ptyIdFor(sessionId, PANE_MICA)}
                sessionId={sessionId}
                active={isActiveSession && pane === PANE_MICA}
                onRegister={register}
                onRead={(id, reason) => id === activeRef.current && onReadRef.current(id, reason)}
              />
            )}
            {panes.has(PANE_TERMINAL) && (
              <TerminalPane
                ptyId={ptyIdFor(sessionId, PANE_TERMINAL)}
                sessionId={sessionId}
                active={isActiveSession && pane === PANE_TERMINAL}
                onRegister={register}
                onRead={(id, reason) => id === activeRef.current && onReadRef.current(id, reason)}
              />
            )}
          </div>
        )
      })}
    </section>
  )
})
