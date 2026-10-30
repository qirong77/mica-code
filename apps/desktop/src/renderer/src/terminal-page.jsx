import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal-page.css'
import { terminalControlPath } from '@packages/mica-web-shared/index.js'
import { ErrorBoundary } from './ErrorBoundary'
import {
  THEME_CACHE_KEY,
  currentThemeName,
  initThemeFromCache,
  subscribeTheme,
  syncThemeFromCache
} from './theme'

/**
 * 终端控制窗口的页面。
 *
 * 这里不是模拟器：终端就是主进程里那条真实 PTY，页面只是它的一个显示器。它和 AI 读写
 * 同一条会话——页面上手敲的命令 AI 看得见，AI 输入的命令页面也会实时显示。
 *
 * 通信全部走同源 HTTP + SSE（运行时把 `/remote/terminal/*` 代理到主进程的终端服务，
 * 地址约定见 `mica-web-shared/app-paths.ts`），所以窗口不需要 preload，也不需要外壳业务 IPC。
 */

/* 与主应用的 TerminalHost.jsx 同一套值；xterm 读不到 CSS 变量，只能手工同步。
   暗色沿用 Darcula，亮色取 app.css 的亮色 token（见 LIGHT_TERMINAL_THEME 的注释）。 */
const TERMINAL_THEME = {
  background: '#2b2b2b',
  foreground: '#a9b7c6',
  cursor: '#a9b7c6',
  selectionBackground: 'rgba(33, 66, 131, 0.6)',
  black: '#3c3f41',
  red: '#ff6b68',
  green: '#a8c023',
  yellow: '#d6bf55',
  blue: '#5394ec',
  magenta: '#ae8abe',
  cyan: '#299999',
  white: '#bababa',
  brightBlack: '#606366',
  brightRed: '#ff8785',
  brightGreen: '#a8c023',
  brightYellow: '#ffff00',
  brightBlue: '#7eaef1',
  brightMagenta: '#ff99ff',
  brightCyan: '#6cdada',
  brightWhite: '#ffffff'
}

/* 亮色终端：内容面 --color-canvas #ffffff、正文 --color-fg #2c2c2e、光标
   --color-fg-max #0f1115、选中 --color-accent 的 22%；ANSI 用亮色状态 token，
   bright 档在浅底上改用 soft 档保持对比度，white/brightWhite 退到前景灰阶。 */
const LIGHT_TERMINAL_THEME = {
  background: '#ffffff',
  foreground: '#2c2c2e',
  cursor: '#0f1115',
  selectionBackground: 'rgba(65, 118, 230, 0.22)',
  black: '#0f1115',
  red: '#ec1313',
  green: '#2b8a3e',
  yellow: '#b45309',
  blue: '#4176e6',
  magenta: '#6741d9',
  cyan: '#0f766e',
  white: '#81858c',
  brightBlack: '#61666b',
  brightRed: '#f25a5a',
  brightGreen: '#2f9e44',
  brightYellow: '#dd8629',
  brightBlue: '#3b82f6',
  brightMagenta: '#6741d9',
  brightCyan: '#0f766e',
  brightWhite: '#979da6'
}

function terminalThemeFor(theme) {
  return theme === 'light' ? LIGHT_TERMINAL_THEME : TERMINAL_THEME
}

const FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Code", "SF Mono", ui-monospace, Menlo, Consolas, monospace'
const RECONNECT_DELAY_MS = 1500
const RESIZE_DEBOUNCE_MS = 160

/** 会话端点地址：页面里所有请求都从这里拼，不各自写死前缀 */
function sessionPath(sessionId, suffix = '') {
  return terminalControlPath(`/sessions/${encodeURIComponent(sessionId)}${suffix}`)
}

function sessionIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get('session') || ''
  } catch {
    return ''
  }
}

async function api(path, init) {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {})
    }
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `HTTP ${response.status}`)
    // 404 表示会话已被关闭/回收：页面要停下来提示，不能一直重连
    error.status = response.status
    throw error
  }
  return payload
}

function send(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body) })
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/** 纯文本屏幕重建：缓冲被截断时至少让页面显示当前内容，而不是从半截转义流开始 */
function screenTextToAnsi(text) {
  return `\x1b[2J\x1b[H${String(text || '').replace(/\r?\n/g, '\r\n')}`
}

function TerminalPage() {
  const hostRef = useRef(null)
  const sessionIdRef = useRef(sessionIdFromUrl())
  const infoRef = useRef(null)
  const lastSeqRef = useRef(0)
  const [info, setInfo] = useState(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  function applyInfo(next) {
    if (!next) return
    infoRef.current = next
    setInfo(next)
    document.title = next.label ? `${next.label} · 终端` : '终端'
  }

  /**
   * 跟随 AI 改的尺寸，但不能超出窗口容量：超出部分会被 `overflow:hidden` 裁掉，
   * 用户既看不到也滚不过去。装不下时就近取容量，并把实际尺寸回报给 PTY。
   */
  function adoptSize(term, fit, next, sessionId) {
    if (!next?.cols || !next?.rows) return
    if (next.cols === term.cols && next.rows === term.rows) return
    let { cols, rows } = next
    try {
      const capacity = fit.proposeDimensions()
      if (capacity?.cols && capacity?.rows) {
        cols = Math.min(cols, capacity.cols)
        rows = Math.min(rows, capacity.rows)
      }
    } catch {
      // 容器还没布局好：先按 PTY 的尺寸来，下一次 fit 会校正
    }
    if (cols === term.cols && rows === term.rows) return
    term.resize(cols, rows)
    if (cols !== next.cols || rows !== next.rows) {
      send(sessionPath(sessionId, '/resize'), { cols, rows }).catch(() => {})
    }
  }

  useEffect(() => {
    const sessionId = sessionIdRef.current
    const host = hostRef.current
    if (!sessionId || !host) {
      setLoading(false)
      setError(sessionId ? '终端页面未就绪' : '缺少 session 参数')
      return undefined
    }

    let disposed = false
    const controller = new AbortController()
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: FONT_FAMILY,
      theme: terminalThemeFor(currentThemeName()),
      allowProposedApi: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // 主题切换只换 xterm 的 options.theme：PTY、屏幕缓冲与滚动位置都不重建。
    const unsubscribeTheme = subscribeTheme((theme) => {
      term.options.theme = terminalThemeFor(theme)
    })
    // 窗口通常是先隐藏创建、后显示：没有焦点时键盘输入会落到 body，看起来像终端卡死
    term.focus()

    let rebuilding = false
    const pendingFrames = []
    // 隐藏窗口里逐帧解析 ANSI 是纯浪费（后台窗口没人看）：只记标记，显示时整屏重建
    let hiddenDirty = false
    let hiddenRebuildTimer = null
    // 会话已经不存在（被关闭或回收）：停止重连，只提示
    let sessionGone = false

    // 输入串行发送：fetch 并发会打乱顺序，promise 链保证「敲一个字发一个字」的顺序
    let inputChain = Promise.resolve()
    const writeInput = (data) => {
      if (!data) return
      inputChain = inputChain
        .then(() =>
          api(sessionPath(sessionId, '/input'), {
            method: 'POST',
            body: JSON.stringify({ data })
          })
        )
        .then(() => setError(''))
        .catch((err) => setError(err.message))
    }
    const inputSubscription = term.onData((data) => writeInput(data))

    let resizeTimer = null
    function syncSizeFromWindow() {
      if (disposed || document.visibilityState !== 'visible') return
      try {
        fit.fit()
      } catch {
        return
      }
      const { cols, rows } = term
      const current = infoRef.current
      if (current && current.cols === cols && current.rows === rows) return
      send(sessionPath(sessionId, '/resize'), { cols, rows }).catch((err) => setError(err.message))
    }
    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(syncSizeFromWindow, RESIZE_DEBOUNCE_MS)
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      // 隐藏窗口不能保留焦点：窗口重新显示后补一次，否则键盘输入没地方落
      term.focus()
      scheduleFit()
      if (!hiddenDirty) return
      hiddenDirty = false
      // 先让新尺寸同步回 PTY 再重建，否则重排后的文字会错行
      if (hiddenRebuildTimer) clearTimeout(hiddenRebuildTimer)
      hiddenRebuildTimer = setTimeout(() => {
        rebuildScreen().catch((err) => setError(err.message))
      }, RESIZE_DEBOUNCE_MS + 40)
    }
    const onWindowFocus = () => term.focus()
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(host)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onWindowFocus)

    async function stream() {
      while (!disposed) {
        if (sessionGone) return
        try {
          const response = await fetch(
            `${terminalControlPath('/events')}?session=${encodeURIComponent(sessionId)}&since=${lastSeqRef.current}`,
            { headers: { accept: 'text/event-stream' }, signal: controller.signal }
          )
          if (!response.ok || !response.body) throw new Error(`events HTTP ${response.status}`)
          setConnected(true)
          setLoading(false)
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let boundary = buffer.indexOf('\n\n')
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const line = frame.split('\n').find((item) => item.startsWith('data:'))
              if (line) handleEvent(JSON.parse(line.slice(5).trim()))
              boundary = buffer.indexOf('\n\n')
            }
          }
        } catch (err) {
          if (disposed || controller.signal.aborted) return
          setConnected(false)
          if (err?.name !== 'AbortError') setError(err.message)
        }
        if (disposed) return
        setConnected(false)
        await sleep(RECONNECT_DELAY_MS, controller.signal)
      }
    }

    function handleEvent(frame) {
      if (disposed) return
      if (frame?.channel === 'terminal:output') {
        const payload = frame.payload || {}
        if (payload.session && payload.session !== sessionId) return
        setConnected(true)
        setError('')
        if (document.visibilityState !== 'visible') {
          hiddenDirty = true
          return
        }
        if (rebuilding) {
          // 重建期间先把帧排队：直接写会被 term.reset() 擦掉，或者与快照重复
          pendingFrames.push(payload)
          return
        }
        if (payload.truncated) {
          // 缓冲被截断：重新拉屏幕文本重建，避免半截 ANSI 流把界面写乱
          rebuildScreen().catch((err) => setError(err.message))
          return
        }
        writeFrame(payload)
        return
      }
      if (frame?.channel === 'terminal:changed') {
        const next = frame.payload?.session
        // 状态变化是广播的：别的终端变化时不能拿它的尺寸/标题改本页
        if (!next || next.id !== sessionId) return
        if (frame.payload?.reason === 'closed') {
          sessionGone = true
          setConnected(false)
          setLoading(false)
          setError('终端已关闭')
          return
        }
        applyInfo({ ...(infoRef.current || {}), ...next })
        // PTY 尺寸是唯一事实来源：AI 改了尺寸，页面跟着它（但不超过窗口容量）
        if (!rebuilding) adoptSize(term, fit, next, sessionId)
        if (next.running === false) setLoading(false)
        return
      }
      // 服务端在客户端读得慢时丢过输出帧：按当前屏幕重建一次
      if (frame?.channel === 'terminal:resync') {
        if (document.visibilityState !== 'visible') {
          hiddenDirty = true
          return
        }
        rebuildScreen().catch(() => {})
      }
    }

    // 按 seq 去重：快照和排队帧可能覆盖同一段输出
    function writeFrame(payload) {
      const seq = Number(payload?.seq) || 0
      if (seq && seq <= lastSeqRef.current) return
      if (payload?.data) term.write(payload.data)
      if (seq) lastSeqRef.current = seq
    }

    async function rebuildScreen() {
      if (rebuilding) return
      rebuilding = true
      try {
        const detail = await api(`${sessionPath(sessionId)}?maxLines=500`)
        if (disposed) return
        applyInfo(detail.session)
        term.reset()
        term.write(screenTextToAnsi(detail.session?.screen?.text || ''))
        // 快照对应的 seq：只补这之后到重建完成之间的增量
        lastSeqRef.current = Number(detail.session?.outputSeq) || 0
        const output = await api(`${sessionPath(sessionId, '/output')}?since=${lastSeqRef.current}`)
        if (disposed) return
        if (output.data) term.write(output.data)
        lastSeqRef.current = Number(output.seq) || lastSeqRef.current
      } finally {
        rebuilding = false
        const queued = pendingFrames.splice(0)
        for (const payload of queued) writeFrame(payload)
      }
    }

    async function boot() {
      try {
        const detail = await api(`${sessionPath(sessionId)}?maxLines=500`)
        if (disposed) return
        applyInfo(detail.session)
        term.resize(detail.session?.cols || term.cols, detail.session?.rows || term.rows)
        const output = await api(`${sessionPath(sessionId, '/output')}?since=0`)
        if (disposed) return
        if (output.truncated) {
          term.write(screenTextToAnsi(detail.session?.screen?.text || ''))
        } else if (output.data) {
          term.write(output.data)
        }
        lastSeqRef.current = Number(output.seq) || 0
        setLoading(false)
        setError('')
        if (document.visibilityState === 'visible') scheduleFit()
        void stream()
      } catch (err) {
        if (disposed) return
        setLoading(false)
        setError(err.message)
        if (err.status === 404) {
          // 会话已经不存在了：无限重连只会刷 404，直接停在这里
          sessionGone = true
          return
        }
        // 会话可能正在创建（窗口先于 pty 打开）：稍后重试既有输出与订阅
        await sleep(RECONNECT_DELAY_MS, controller.signal)
        if (!disposed && !sessionGone) void boot()
      }
    }

    void boot()

    return () => {
      disposed = true
      controller.abort()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onWindowFocus)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (hiddenRebuildTimer) clearTimeout(hiddenRebuildTimer)
      inputSubscription.dispose()
      unsubscribeTheme()
      term.dispose()
    }
  }, [])

  return (
    <div className="terminal-page">
      <header className="terminal-header">
        <span className={`terminal-dot ${connected ? 'is-online' : ''}`} />
        <span className="terminal-title">{info?.label || '终端'}</span>
        <span className="terminal-meta">{info?.cwd || ''}</span>
        <span className="terminal-spacer" />
        {info?.cols ? (
          <span className="terminal-size">
            {info.cols}×{info.rows}
          </span>
        ) : null}
        <span className={`terminal-state ${info?.running === false ? 'is-exited' : ''}`}>
          {info?.running === false
            ? `已退出${Number.isInteger(info?.exitCode) ? ` (${info.exitCode})` : ''}`
            : connected
              ? '已连接'
              : '连接中'}
        </span>
      </header>
      <main className="terminal-host" ref={hostRef} />
      {loading ? <div className="terminal-overlay">正在连接终端…</div> : null}
      {error ? (
        <div className="terminal-error" role="alert">
          {error}
        </div>
      ) : null}
      <footer className="terminal-footer">
        <span>
          {info?.id || '—'} · 真实 PTY · {info?.shell || ''}
        </span>
        <span>AI 可通过 MICA_TERMINAL_URL 操作这条终端</span>
      </footer>
    </div>
  )
}

// 终端控制窗口没有 window.mica，也没有 ui-state 通道：主题只能读 theme.js 的缓存。
// 首帧先按缓存上色，之后主窗口改主题会写缓存并在本窗口触发 storage 事件，这里跟着对齐。
initThemeFromCache()
window.addEventListener('storage', (event) => {
  if (event.key === THEME_CACHE_KEY) syncThemeFromCache()
})

// 这个窗口本身就是一块终端底色：渲染抛错时没有任何线索，所以同样套一层兜底。
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <TerminalPage />
  </ErrorBoundary>
)
