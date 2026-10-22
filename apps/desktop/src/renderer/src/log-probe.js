// 渲染层错误采集：把 console.error/warn 与未捕获异常推到 host 日志（scope=renderer）。
//
// 白屏、渲染抛错、接口失败的现场最容易丢，因为用户往往只看到界面不对。
// 这里把浏览器侧的错误和 host 的通道耗时放在同一套日志里，排查时按时间对齐即可。
//
// 限流策略：同样的消息 10 秒内只记一次（React 报错常成片刷屏），
// 每轮最多推 50 条，避免日志本身影响性能。
const INVOKE = '/api/invoke'
const FLUSH_MS = 5000
const DEDUPE_MS = 10000
const MAX_BATCH = 50
const MAX_PENDING = 200

function safeString(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function stackOf(value) {
  const stack = value?.stack || value?.reason?.stack
  return typeof stack === 'string' ? stack.split('\n').slice(0, 6).join('\n') : undefined
}

export function startLogProbe(win) {
  if (!win || win.__micaLog) return win?.__micaLog || null

  const pending = []
  const seen = new Map()
  let timer = null
  let stopped = false
  const original = { error: win.console?.error, warn: win.console?.warn }

  const enqueue = (level, event, fields) => {
    const key = `${level}:${event}:${fields.message || ''}`
    const now = Date.now()
    const last = seen.get(key) || 0
    if (now - last < DEDUPE_MS) return
    seen.set(key, now)
    // 清掉过期的去重键，别让 Map 无限长
    if (seen.size > 200) {
      for (const [item, at] of seen) if (now - at > DEDUPE_MS) seen.delete(item)
    }
    pending.push({ level, event: event.slice(0, 120), ...fields })
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
  }

  const flush = async () => {
    if (pending.length === 0 || stopped) return
    const entries = pending.splice(0, MAX_BATCH)
    try {
      const response = await win.fetch(INVOKE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'log:report', payload: { scope: 'renderer', entries } })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
      // 推不上去就留在队列里下轮再试，但不要无限堆积
      pending.unshift(...entries)
      if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
    }
  }

  // 包一层 console：既保留原输出，也留一份到日志
  for (const level of ['error', 'warn']) {
    const fn = original[level]
    if (typeof fn !== 'function') continue
    win.console[level] = (...args) => {
      enqueue(level, args.map(safeString).join(' ').slice(0, 300), { source: 'console' })
      fn.apply(win.console, args)
    }
  }

  const onError = (event) => {
    const message = safeString(event?.message || event?.reason?.message || event?.reason || 'error')
    enqueue('error', message.slice(0, 200), {
      source: 'window.error',
      stack: stackOf(event?.error || event?.reason),
      componentStack: event?.componentStack
    })
    void flush()
  }
  const onRejection = (event) => {
    const message = safeString(event?.reason?.message || event?.reason || 'unhandledRejection')
    enqueue('error', message.slice(0, 200), {
      source: 'unhandledrejection',
      stack: stackOf(event?.reason)
    })
    void flush()
  }

  if (typeof win.addEventListener === 'function') {
    win.addEventListener('error', onError)
    win.addEventListener('unhandledrejection', onRejection)
  }
  timer = win.setInterval(flush, FLUSH_MS)

  const api = {
    version: 'log-1',
    report: () => pending.slice(),
    flush,
    stop: () => {
      stopped = true
      if (timer) win.clearInterval(timer)
      if (typeof win.removeEventListener === 'function') {
        win.removeEventListener('error', onError)
        win.removeEventListener('unhandledrejection', onRejection)
      }
      for (const level of ['error', 'warn']) {
        if (original[level]) win.console[level] = original[level]
      }
      if (win.__micaLog === api) delete win.__micaLog
    }
  }
  win.__micaLog = api
  return api
}
