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

function TerminalPane({ id, active, onRegister, onRead, onCommand }) {
  const hostRef = useRef(null)
  const onReadRef = useLatest(onRead)
  const onCommandRef = useLatest(onCommand)

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
    term.registerLinkProvider(createFileLinkProvider(term, id, window.mica.platform))

    const input = term.onData((data) => {
      window.mica.terminal.write(id, data)
      onReadRef.current(id, 'input')
      if (/[\r\n]/.test(data)) onCommandRef.current?.(id)
    })
    const scroll = term.onScroll(() => onReadRef.current(id, 'scroll'))
    const intercept = (event) => interceptTerminalKey(event, id)
    const pointer = () => onReadRef.current(id, 'pointer')
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
          .clear(id)
          .catch((error) => console.error('clear terminal failed', error))
        return false
      }
      return true
    })

    const entry = { term, fit, el: host, ready: false, creating: null, lastPtySize: null }
    onRegister(id, entry)
    return () => {
      onRegister(id, null)
      input.dispose()
      scroll.dispose()
      host.removeEventListener('keydown', intercept, true)
      host.removeEventListener('keypress', intercept, true)
      host.removeEventListener('pointerdown', pointer)
      term.dispose()
    }
  }, [id, onCommandRef, onReadRef, onRegister])

  return (
    <div
      ref={hostRef}
      className={`terminal-pane absolute inset-0 overflow-hidden bg-[#0e0e0e] ${active ? 'block' : 'hidden'}`}
      data-id={id}
    />
  )
}

export const TerminalHost = forwardRef(function TerminalHost(
  { nodes, activeId, visible, sidebarCollapsed, resolveCwd, onRead, onCommand },
  ref
) {
  const hostRef = useRef(null)
  const entries = useRef(new Map())
  const [mountedIds, setMountedIds] = useState(() => (activeId ? [activeId] : []))
  const activeRef = useLatest(activeId)
  const visibleRef = useLatest(visible)
  const nodesRef = useLatest(nodes)
  const resolveCwdRef = useLatest(resolveCwd)
  const onReadRef = useLatest(onRead)
  const frameRef = useRef(null)
  const focusRef = useRef(false)
  const sidebarCollapsedRef = useRef(sidebarCollapsed)
  const suppressObservedFitRef = useRef(false)

  const measurable = useCallback(
    (entry, id) =>
      visibleRef.current &&
      activeRef.current === id &&
      hostRef.current?.clientWidth > 0 &&
      hostRef.current?.clientHeight > 0 &&
      entry.el.clientWidth > 0 &&
      entry.el.clientHeight > 0,
    [activeRef, visibleRef]
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
      const id = activeRef.current
      const entry = entries.current.get(id)
      if (!id || !entry || !measurable(entry, id)) return
      try {
        entry.fit.fit()
        syncPtySize(id, entry)
        if (focus && activeRef.current === id) {
          entry.term.focus()
          onReadRef.current(id, 'activate')
        }
      } catch (error) {
        console.error('fit terminal failed', error)
      }
    },
    [activeRef, measurable, onReadRef, syncPtySize]
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
    async (id, focus = true) => {
      const entry = entries.current.get(id)
      if (!entry) return
      if (!entry.ready && !entry.creating) {
        let dimensions = null
        if (measurable(entry, id)) {
          entry.fit.fit()
          dimensions = { cols: entry.term.cols, rows: entry.term.rows }
        }
        const node = nodesRef.current.find((item) => item.id === id)
        entry.creating = window.mica.terminal.create({
          id,
          ...(resolveCwdRef.current(id) ? { cwd: resolveCwdRef.current(id) } : {}),
          ...(node?.sessionId ? { resumeSessionId: node.sessionId } : {}),
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
      if (activeRef.current === id) scheduleFit({ focus })
    },
    [activeRef, measurable, nodesRef, resolveCwdRef, scheduleFit]
  )

  const register = useCallback(
    (id, entry) => {
      if (entry) {
        entries.current.set(id, entry)
        if (activeRef.current === id)
          activate(id).catch((error) => console.error('create terminal failed', error))
      } else {
        entries.current.delete(id)
      }
    },
    [activate, activeRef]
  )

  useImperativeHandle(
    ref,
    () => ({
      activate(id) {
        return activate(id, true)
      },
      async getCwd(id = activeRef.current) {
        if (!id) return null
        return (await window.mica.terminal.getCwd(id)) || resolveCwdRef.current(id)
      },
      async dispose(id) {
        const entry = entries.current.get(id)
        if (entry) {
          entry.ready = false
          entry.lastPtySize = null
        }
        return window.mica.terminal.dispose(id)
      },
      fit: scheduleFit
    }),
    [activate, activeRef, resolveCwdRef, scheduleFit]
  )

  useEffect(() => {
    if (activeId) {
      setMountedIds((ids) => (ids.includes(activeId) ? ids : [...ids, activeId]))
      activate(activeId).catch((error) => console.error('activate terminal failed', error))
    }
  }, [activate, activeId])

  useEffect(() => {
    const valid = new Set(nodes.map((node) => node.id))
    setMountedIds((ids) => ids.filter((id) => valid.has(id)))
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
      entry.term.writeln('\r\n[process exited]')
    })
    return () => {
      offData?.()
      offExit?.()
    }
  }, [])

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
      className={`relative min-h-0 flex-1 overflow-hidden bg-[#0e0e0e] no-drag ${visible ? '' : 'hidden'}`}
    >
      {mountedIds.map((id) => (
        <TerminalPane
          key={id}
          id={id}
          active={id === activeId}
          onRegister={register}
          onRead={(id, reason) => id === activeRef.current && onReadRef.current(id, reason)}
          onCommand={onCommand}
        />
      ))}
    </section>
  )
})
