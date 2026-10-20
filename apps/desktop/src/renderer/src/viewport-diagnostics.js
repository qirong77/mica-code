// 仅 ?viewport-debug=1 且本机诊断服务可用时启用。不插入浮层、不改变焦点或样式，
// 避免为了显示诊断 UI 触发重绘，恰好掩盖「再点一下才恢复」的故障。
const VERSION = 'keyboard-3'
const ENDPOINT = '/__viewport-debug'
const SAMPLE_INTERVAL = 100
const CAPTURE_DURATION = 3000
const MAX_SAMPLES = 240
const BATCH_SIZE = 8

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

// 不读取 value、textContent、outerHTML、会话标识或 URL 查询参数。
function elementLabel(element) {
  if (!element?.tagName) return null
  return [element.tagName.toLowerCase(), ...Array.from(element.classList || []).slice(0, 6)]
    .join('.')
    .slice(0, 180)
}

function elementGeometry(win, element) {
  if (!element?.getBoundingClientRect) return null
  const rect = element.getBoundingClientRect()
  const css = win.getComputedStyle(element)
  return {
    element: elementLabel(element),
    rect: Object.fromEntries(
      ['top', 'bottom', 'left', 'right', 'height', 'width'].map((key) => [key, round(rect[key])])
    ),
    scrollTop: round(element.scrollTop),
    scrollLeft: round(element.scrollLeft),
    scrollHeight: round(element.scrollHeight),
    clientHeight: round(element.clientHeight),
    css: Object.fromEntries(
      [
        'height',
        'minHeight',
        'maxHeight',
        'position',
        'top',
        'overflowX',
        'overflowY',
        'transform',
        'contain',
        'display',
        'fontSize'
      ].map((key) => [key, css[key]])
    )
  }
}

export function viewportDiagnosticSnapshot(win, doc, reason, target) {
  const viewport = win.visualViewport
  const active = doc.activeElement
  const chat =
    active?.closest?.('.chat-view') ||
    Array.from(doc.querySelectorAll('.chat-view')).find((element) => element.clientHeight > 0)
  const ancestors = []
  for (let element = active; element && ancestors.length < 12; element = element.parentElement) {
    ancestors.push(elementGeometry(win, element))
  }
  const rootStyle = win.getComputedStyle(doc.documentElement)
  return {
    reason,
    time: round(win.performance.now()),
    viewport: viewport
      ? Object.fromEntries(
          ['height', 'width', 'scale', 'offsetTop', 'offsetLeft', 'pageTop', 'pageLeft'].map(
            (key) => [key, round(viewport[key])]
          )
        )
      : null,
    window: Object.fromEntries(
      ['innerHeight', 'innerWidth', 'scrollX', 'scrollY'].map((key) => [key, round(win[key])])
    ),
    applied: {
      height: rootStyle.getPropertyValue('--vvh'),
      top: rootStyle.getPropertyValue('--vvh-top')
    },
    elements: {
      html: elementGeometry(win, doc.documentElement),
      body: elementGeometry(win, doc.body),
      root: elementGeometry(win, doc.getElementById('root')),
      header: elementGeometry(win, doc.querySelector('main .safe-top')),
      footer: elementGeometry(win, doc.querySelector('main .safe-bottom')),
      chat: elementGeometry(win, chat),
      transcript: elementGeometry(win, chat?.querySelector('.chat-scroll')),
      composer: elementGeometry(win, chat?.querySelector('.chat-composer-dock')),
      target: elementGeometry(win, target)
    },
    activeAncestors: ancestors
  }
}

export async function startViewportDiagnostics(win, doc) {
  if (new URLSearchParams(win.location.search).get('viewport-debug') !== '1') return undefined
  // 正式运行时没有采集端点，不能误把 SPA 的 HTML 回退当作可用的诊断服务。
  try {
    const response = await win.fetch(ENDPOINT, { cache: 'no-store' })
    if (!response.ok || (await response.json()).version !== VERSION) return undefined
  } catch {
    return undefined
  }

  const environment = {
    userAgent: win.navigator.userAgent,
    standalone: win.matchMedia('(display-mode: standalone)').matches || !!win.navigator.standalone,
    screen: { width: win.screen.width, height: win.screen.height, dpr: win.devicePixelRatio },
    // 文件名包含构建 hash，可确认手机实际加载的版本；不记录页面 URL 或会话参数。
    build: Array.from(doc.querySelectorAll('script[src]')).map((script) =>
      new URL(script.src).pathname.split('/').pop()
    )
  }
  const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const samples = []
  const pending = []
  const listeners = []
  let sequence = 0
  let timer = null
  let until = 0
  let stopped = false
  let sending = false
  let lastEventTime = -Infinity
  const packet = (batch) => ({ version: VERSION, pageId, environment, samples: batch })
  const capture = (reason, target) => {
    const sample = { sequence: ++sequence, ...viewportDiagnosticSnapshot(win, doc, reason, target) }
    samples.push(sample)
    pending.push(sample)
    if (samples.length > MAX_SAMPLES) samples.shift()
    if (pending.length > MAX_SAMPLES) pending.shift()
  }
  const flush = async () => {
    if (sending || !pending.length || stopped) return
    sending = true
    const batch = pending.splice(0, BATCH_SIZE)
    try {
      const response = await win.fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(packet(batch))
      })
      if (!response.ok) throw new Error(`diagnostics HTTP ${response.status}`)
    } catch {
      // 断网时只保留有界的最近记录；重连后按原顺序补传，不把 UI 变成错误页。
      pending.unshift(...batch)
      if (pending.length > MAX_SAMPLES) pending.splice(0, pending.length - MAX_SAMPLES)
    } finally {
      sending = false
    }
  }
  const tick = () => {
    timer = null
    capture('settle')
    if (win.performance.now() < until) timer = win.setTimeout(tick, SAMPLE_INTERVAL)
  }
  const listen = (target, type, callback) => {
    if (!target) return
    target.addEventListener(type, callback, { capture: true, passive: true })
    listeners.push(() => target.removeEventListener(type, callback, true))
  }
  const onEvent = (event) => {
    const now = win.performance.now()
    // scroll/resize 动画期间限频；聚焦/触摸仍在默认聚焦动作之前留下现场。
    if (!['scroll', 'resize'].includes(event.type) || now - lastEventTime >= SAMPLE_INTERVAL) {
      const source = event.currentTarget === win.visualViewport ? 'visualViewport.' : ''
      capture(`${source}${event.type}`, event.target)
      lastEventTime = now
    }
    until = now + CAPTURE_DURATION
    if (timer === null) timer = win.setTimeout(tick, SAMPLE_INTERVAL)
  }
  // 用 window 捕获阶段先于 viewport-sync 的 document 聚焦/触摸监听器取样，
  // 否则「用于恢复画面的那次点击」可能先完成修正，留下的只有恢复后的数据。
  for (const type of ['focusin', 'focusout', 'pointerdown', 'pointerup']) {
    listen(win, type, onEvent)
  }
  for (const type of ['resize', 'scroll', 'orientationchange', 'pageshow'])
    listen(win, type, onEvent)
  for (const type of ['resize', 'scroll']) listen(win.visualViewport, type, onEvent)
  listen(win, 'pagehide', () => {
    capture('pagehide')
    // 普通 fetch 持续传走历史，这里只补最后一帧，避免超过 sendBeacon 的 64KiB 上限。
    win.navigator.sendBeacon?.(
      ENDPOINT,
      new Blob([JSON.stringify(packet(samples.slice(-1)))], { type: 'application/json' })
    )
  })
  const uploadTimer = win.setInterval(flush, 500)
  const diagnostics = {
    version: VERSION,
    report: () => packet([...samples]),
    stop: () => {
      stopped = true
      listeners.forEach((remove) => remove())
      win.clearTimeout(timer)
      win.clearInterval(uploadTimer)
      if (win.__micaViewportDiagnostics === diagnostics) delete win.__micaViewportDiagnostics
    }
  }
  win.__micaViewportDiagnostics = diagnostics
  onEvent({ type: 'start' })
  return diagnostics.stop
}
