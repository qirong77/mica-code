/**
 * 终端控制的后台窗口。
 *
 * 一个会话一个窗口，默认隐藏创建：AI 先在后台把命令跑起来，需要人看的时候再 show
 * （用户点关闭也只是隐藏，PTY 与滚动内容都还在）。窗口里加载的是运行时托管的终端页面
 * ——页面和 AI 一样通过 HTTP + SSE 访问终端服务，所以不需要 preload、也不注册外壳业务
 * IPC。外壳在这里只做「开窗口」这一件只有主进程能做的事。
 *
 * 隐藏窗口按 `idleReapMs` 回收：收掉的是壳子（renderer + 它的合成缓存），PTY 会话与
 * 滚动内容在运行时那边不受影响，下次 `ensure` 重新开一个、页面自己接上。
 */

import { BrowserWindow } from 'electron'
import {
  TERMINAL_IDLE_REAP_MS,
  WINDOW_IDLE_SWEEP_MS,
  describeReap,
  resolveMs,
  selectIdleWindows,
  startIdleReaper
} from '../window-idle.js'

const DEFAULT_SIZE = { width: 1000, height: 680 }
const MIN_SIZE = { width: 420, height: 240 }

export function createTerminalWindows({
  getPageUrl,
  isQuitting = () => false,
  onVisibleChange = () => {},
  // 隐藏多久之后真正销毁窗口；0 关掉这条回收
  idleReapMs = resolveMs(process.env.MICA_TERMINAL_IDLE_REAP_MS, TERMINAL_IDLE_REAP_MS),
  idleSweepMs = WINDOW_IDLE_SWEEP_MS
} = {}) {
  const windows = new Map()

  function terminalUrl(sessionId) {
    return String(getPageUrl?.(sessionId) || '').trim()
  }

  function load(record, attempt = 0) {
    if (record.win.isDestroyed() || record.destroyRequested) return
    const url = terminalUrl(record.sessionId)
    if (!url) {
      // 运行时还没起来：等它就绪后再加载，别把一个空白窗口留在那
      if (attempt < 20) setTimeout(() => load(record, attempt + 1), 500)
      return
    }
    record.win.loadURL(url).catch((error) => {
      // 运行时可能正在重启；页面自己的 SSE 会自动重连，这里只留一条日志并重试
      if (record.win.isDestroyed()) return
      console.warn('[mica-terminal] 终端页面加载失败', error?.code || error)
      if (attempt < 20) setTimeout(() => load(record, attempt + 1), 1000)
    })
  }

  function create(session, { show = false, focus = false } = {}) {
    const win = new BrowserWindow({
      ...DEFAULT_SIZE,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: `终端 · ${session.label}`,
      backgroundColor: '#2b2b2b',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })

    // 多个终端窗口错开一点，别叠成一摞看不出有几个
    const offset = Math.min(windows.size, 6) * 26
    if (offset) {
      const bounds = win.getBounds()
      win.setBounds({ ...bounds, x: bounds.x + offset, y: bounds.y + offset })
    }

    const record = {
      sessionId: session.id,
      win,
      visible: false,
      // 从这一刻起没人看得见它；`show` 清空、`hide` 重新计时
      hiddenAt: Date.now(),
      destroyRequested: false
    }
    windows.set(session.id, record)

    win.on('close', (event) => {
      // 用户点关闭 = 隐藏；应用退出或显式 closeSession 才真的销毁
      if (isQuitting() || record.destroyRequested) return
      event.preventDefault()
      hide(session.id)
    })

    win.on('closed', () => {
      windows.delete(session.id)
      if (record.visible) {
        record.visible = false
        onVisibleChange(session.id, false)
      }
    })

    win.on('show', () => {
      record.visible = true
      record.hiddenAt = null
      onVisibleChange(session.id, true)
    })

    win.on('hide', () => {
      record.visible = false
      record.hiddenAt = Date.now()
      onVisibleChange(session.id, false)
    })

    load(record)
    if (show) showWindow(record, { focus })
    return record
  }

  function ensure(session, { show = false, focus = false } = {}) {
    const existing = windows.get(session.id)
    const record =
      existing && !existing.win.isDestroyed() ? existing : create(session, { show, focus })
    if (show) showWindow(record, { focus })
    return record
  }

  function showWindow(record, { focus = false } = {}) {
    if (!record || record.win.isDestroyed()) return
    record.win.show()
    if (focus) record.win.focus()
  }

  function show(sessionId, { focus = true } = {}) {
    const record = windows.get(sessionId)
    showWindow(record, { focus })
  }

  function hide(sessionId) {
    const record = windows.get(sessionId)
    if (!record || record.win.isDestroyed()) return
    record.win.hide()
  }

  function destroy(sessionId) {
    const record = windows.get(sessionId)
    if (!record) return
    windows.delete(sessionId)
    if (record.win.isDestroyed()) return
    record.destroyRequested = true
    record.win.destroy()
  }

  function destroyAll() {
    stopReaper()
    for (const [sessionId, record] of [...windows.entries()]) {
      windows.delete(sessionId)
      if (record.win.isDestroyed()) continue
      record.destroyRequested = true
      record.win.destroy()
    }
  }

  /** 收掉闲置太久的隐藏窗口。返回被收的会话 id，供日志与测试确认收了哪几个。 */
  function reapIdle(now = Date.now()) {
    if (isQuitting()) return []
    const entries = [...windows.entries()]
      .filter(([, record]) => !record.win.isDestroyed())
      .map(([id, record]) => ({
        id,
        // 窗口还没显示过也算隐藏：`hiddenAt` 在创建时就给了
        visible: record.visible,
        idleSince: record.hiddenAt
      }))
    const ids = selectIdleWindows(entries, now, { idleMs: idleReapMs })
    for (const id of ids) {
      console.log(describeReap('terminal', id, now - (windows.get(id)?.hiddenAt || now)))
      try {
        destroy(id)
      } catch (error) {
        console.error('[mica-terminal] 回收隐藏窗口失败:', error)
      }
    }
    return ids
  }

  const stopReaper = startIdleReaper(reapIdle, { sweepMs: idleSweepMs, label: 'terminal' })

  return { ensure, show, hide, destroy, destroyAll, reapIdle }
}
